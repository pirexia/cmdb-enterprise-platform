import { Router, Request, Response } from 'express';
import { PrismaClient }              from '@prisma/client';
import bcrypt                        from 'bcrypt';
import crypto                        from 'crypto';
import { z }                         from 'zod';

const BCRYPT_ROUNDS   = parseInt(process.env.BCRYPT_ROUNDS ?? '12', 10);
const LDAP_SYNC_DOMAIN = process.env.LDAP_SYNC_DOMAIN ?? '';

// Zod schemas for the sync payload
const LdapCreateSchema = z.object({
  email:        z.string().email(),
  username:     z.string().min(1).max(100),
  displayName:  z.string().max(255).optional(),
  ssoExternalId: z.string().min(1).max(255),
  role:         z.enum(['ADMIN', 'AUDITOR', 'VIEWER', 'WORKER']).default('VIEWER'),
});

const LdapSyncSchema = z.object({
  creates:     z.array(LdapCreateSchema).max(500),
  reactivates: z.array(z.string().email()).max(500),
  deactivates: z.array(z.string().email()).max(500),
});

type LdapCreate = z.infer<typeof LdapCreateSchema>;

/**
 * Endpoints internos para sincronización LDAP/AD vía n8n (T6).
 *
 * El nodo LDAP nativo de n8n consulta el directorio; estos endpoints
 * exponen el estado actual de usuarios en CMDB y aplican el diff calculado por n8n.
 *
 * Reglas de seguridad (invariantes no negociables):
 *   1. Usuarios con sso_external_id IS NULL → creados manualmente → NUNCA se modifican.
 *   2. Passwords de usuarios LDAP creados → hash bcrypt de bytes aleatorios (no usable para login local).
 *   3. Usuarios desactivados → active=false (nunca DELETE).
 *   4. Todos los cambios generan audit_log (ISO 27001 A.8.15).
 *
 * GET  /api/internal/users/ldap-sync-candidates — estado actual para que n8n calcule el diff
 * POST /api/internal/users/ldap-sync             — aplica creates/reactivates/deactivates
 */
export function createInternalUsersRouter(prisma: PrismaClient): Router {
  const router = Router();

  // ── GET /api/internal/users/ldap-sync-candidates ─────────────────────────────
  // Devuelve a n8n la lista de usuarios LDAP existentes en la DB y los emails
  // de usuarios manuales (para que el diff nunca los toque).
  router.get('/ldap-sync-candidates', async (_req: Request, res: Response): Promise<void> => {
    try {
      const [ldapUsers, manualUsers] = await Promise.all([
        prisma.$queryRaw<{ id: string; email: string; ssoExternalId: string | null; active: boolean }[]>`
          SELECT id::text AS id, email, sso_external_id AS "ssoExternalId", active
          FROM "users"
          WHERE sso_provider = 'ldap'`,
        prisma.$queryRaw<{ email: string }[]>`
          SELECT email FROM "users" WHERE sso_external_id IS NULL`,
      ]);

      res.json({
        existing:    ldapUsers,
        manualUsers: manualUsers.map((u) => u.email),
      });
    } catch (e) {
      console.error('[internal/users/ldap-sync-candidates]', e);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── POST /api/internal/users/ldap-sync ───────────────────────────────────────
  // Aplica el diff calculado por el nodo Code de n8n:
  //   creates[]     → INSERT nuevos usuarios LDAP (password = bcrypt(random))
  //   reactivates[] → UPDATE active=true para usuarios LDAP previamente desactivados
  //   deactivates[] → UPDATE active=false para usuarios LDAP que ya no están en el directorio
  router.post('/ldap-sync', async (req: Request, res: Response): Promise<void> => {
    const parse = LdapSyncSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: 'Payload inválido', details: parse.error.flatten() });
      return;
    }

    const { creates, reactivates, deactivates } = parse.data;

    // Sanity: reject if LDAP_SYNC_DOMAIN is set and any email doesn't match
    if (LDAP_SYNC_DOMAIN) {
      const badEmail = creates.find((u) => !u.email.endsWith(`@${LDAP_SYNC_DOMAIN}`));
      if (badEmail) {
        res.status(400).json({
          error: `Email ${badEmail.email} no pertenece al dominio LDAP_SYNC_DOMAIN (${LDAP_SYNC_DOMAIN})`,
        });
        return;
      }
    }

    const errors: string[] = [];
    let created = 0, reactivated = 0, deactivated = 0;

    // ── Creates ──────────────────────────────────────────────────────────────────
    for (const u of creates) {
      try {
        // Random hash — computacionalmente inviable de revertir → login local imposible
        const randomPassword = crypto.randomBytes(32).toString('hex');
        const hash = await bcrypt.hash(randomPassword, BCRYPT_ROUNDS);

        await prisma.$executeRaw`
          INSERT INTO "users"(
            id, username, email, password, role,
            sso_provider, sso_external_id, active,
            mfa_enabled, created_at, updated_at
          ) VALUES (
            gen_random_uuid(),
            ${u.username}::varchar,
            ${u.email}::varchar,
            ${hash}::varchar,
            ${u.role ?? 'VIEWER'}::"UserRole",
            'ldap',
            ${u.ssoExternalId}::varchar,
            true,
            false,
            now(), now()
          )
          ON CONFLICT (email) DO NOTHING`;

        await prisma.$executeRaw`
          INSERT INTO "audit_logs"(id, action, entity, user_email, details, created_at)
          VALUES(gen_random_uuid(), 'LDAP_SYNC_CREATE', 'User',
                 'n8n@cmdb.local',
                 ${JSON.stringify({ email: u.email, username: u.username, role: u.role ?? 'VIEWER' })}::jsonb,
                 now())`;
        created++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[internal/users/ldap-sync] CREATE ${u.email}:`, msg);
        errors.push(`create:${u.email}: ${msg}`);
      }
    }

    // ── Reactivates ──────────────────────────────────────────────────────────────
    for (const email of reactivates) {
      try {
        // Only reactivate LDAP users; skip manual users (sso_external_id IS NULL)
        await prisma.$executeRaw`
          UPDATE "users"
          SET active = true, updated_at = now()
          WHERE email = ${email} AND sso_provider = 'ldap' AND sso_external_id IS NOT NULL`;

        await prisma.$executeRaw`
          INSERT INTO "audit_logs"(id, action, entity, user_email, details, created_at)
          VALUES(gen_random_uuid(), 'LDAP_SYNC_REACTIVATE', 'User',
                 'n8n@cmdb.local',
                 ${JSON.stringify({ email })}::jsonb,
                 now())`;
        reactivated++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[internal/users/ldap-sync] REACTIVATE ${email}:`, msg);
        errors.push(`reactivate:${email}: ${msg}`);
      }
    }

    // ── Deactivates ──────────────────────────────────────────────────────────────
    for (const email of deactivates) {
      try {
        // Only deactivate LDAP users; manual users (sso_external_id IS NULL) are untouchable
        await prisma.$executeRaw`
          UPDATE "users"
          SET active = false, updated_at = now()
          WHERE email = ${email} AND sso_provider = 'ldap' AND sso_external_id IS NOT NULL`;

        await prisma.$executeRaw`
          INSERT INTO "audit_logs"(id, action, entity, user_email, details, created_at)
          VALUES(gen_random_uuid(), 'LDAP_SYNC_DEACTIVATE', 'User',
                 'n8n@cmdb.local',
                 ${JSON.stringify({ email })}::jsonb,
                 now())`;
        deactivated++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[internal/users/ldap-sync] DEACTIVATE ${email}:`, msg);
        errors.push(`deactivate:${email}: ${msg}`);
      }
    }

    console.log(`[internal/users/ldap-sync] created=${created} reactivated=${reactivated} deactivated=${deactivated} errors=${errors.length}`);

    if (errors.length > 0) {
      res.status(207).json({ created, reactivated, deactivated, errors });
      return;
    }
    res.json({ created, reactivated, deactivated, errors: [] });
  });

  return router;
}
