/**
 * Sincronización de los usuarios del grupo de acceso de AD con la BD (v3.5.10).
 *
 * Una sola implementación alimenta las dos entradas — el botón de la UI y el
 * workflow diario de n8n — precisamente para que la regla de acceso no pueda
 * divergir entre ambas (D8).
 *
 * Invariantes no negociables:
 *   1. Los usuarios manuales (sso_external_id IS NULL) son INTOCABLES. Se
 *      excluyen por cláusula de BD en cada sentencia, no por filtrado posterior.
 *   2. Nunca se hace DELETE. Quien sale del grupo se desactiva, para que la
 *      auditoría conserve el histórico.
 *   3. El rol NUNCA se reescribe: AD posee la identidad, el operador la
 *      gobernanza (D9, mismo principio que el conector vCenter).
 *   4. Cada mutación va con su AuditLog en la MISMA transacción (#172, A.8.15).
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import {
  listGroupMembers,
  isGroupGateEnabled,
  LdapDirectoryError,
  ACCOUNT_DISABLE_BIT,
  type AdGroupMember,
} from '../../services/ldapDirectory.js';

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS ?? '12', 10);
const ALLOWED_ROLES = ['ADMIN', 'AUDITOR', 'VIEWER', 'MANAGER'] as const;

/** Rol de alta, validado contra la allowlist: un .env con un valor inventado cae a VIEWER. */
function defaultRole(): string {
  const r = (process.env.LDAP_SYNC_DEFAULT_ROLE ?? 'VIEWER').toUpperCase();
  return (ALLOWED_ROLES as readonly string[]).includes(r) ? r : 'VIEWER';
}

export interface ExistingUserRow {
  id: string;
  ssoExternalId: string;
  email: string;
  username: string;
  displayName: string | null;
  active: boolean;
  role: string;
}

export interface LdapSyncDiff {
  creates: { ssoExternalId: string; email: string; username: string; displayName: string | null }[];
  updates: { id: string; email: string; username: string; displayName: string | null }[];
  reactivates: string[];
  deactivates: string[];
}

export interface LdapSyncResult {
  created: number;
  updated: number;
  reactivated: number;
  deactivated: number;
  errors: string[];
}

function isDisabledInAd(member: AdGroupMember): boolean {
  return typeof member.userAccountControl === 'number'
    && (member.userAccountControl & ACCOUNT_DISABLE_BIT) !== 0;
}

function synthEmail(key: string): string {
  return `${key}@${process.env.LDAP_UPN_SUFFIX || 'ldap.local'}`;
}

/**
 * Diff puro: sin BD, sin directorio, sin efectos. Es la única pieza con lógica
 * de decisión real, y por eso es la que se prueba a fondo.
 */
export function computeLdapSyncDiff(members: AdGroupMember[], existing: ExistingUserRow[]): LdapSyncDiff {
  const byKey = new Map(existing.map((u) => [u.ssoExternalId.toLowerCase(), u]));
  const seen = new Set<string>();

  const diff: LdapSyncDiff = { creates: [], updates: [], reactivates: [], deactivates: [] };

  for (const member of members) {
    const key = member.sAMAccountName.toLowerCase();
    seen.add(key);

    const row = byKey.get(key);
    const email = member.mail ?? synthEmail(key);
    const displayName = member.displayName ?? null;

    if (!row) {
      // Una cuenta ya deshabilitada en AD no se da de alta: nacería inactiva.
      if (!isDisabledInAd(member)) {
        diff.creates.push({ ssoExternalId: key, email, username: member.sAMAccountName, displayName });
      }
      continue;
    }

    if (isDisabledInAd(member)) {
      if (row.active) diff.deactivates.push(row.id);
      continue;
    }

    if (row.email !== email || row.username !== member.sAMAccountName || row.displayName !== displayName) {
      diff.updates.push({ id: row.id, email, username: member.sAMAccountName, displayName });
    }
    if (!row.active) diff.reactivates.push(row.id);
  }

  // Quien está en la BD como LDAP activo pero ya no aparece en el grupo.
  for (const u of existing) {
    if (!seen.has(u.ssoExternalId.toLowerCase()) && u.active) diff.deactivates.push(u.id);
  }

  return diff;
}

// Lock en proceso: impide que una pulsación del botón se solape con la pasada
// nocturna de n8n. Mismo patrón que runVCenterSync.
let syncInProgress = false;
export function isSyncInProgress(): boolean { return syncInProgress; }

/** Error con código, para que el router pueda mapearlo a 409 sin adivinar. */
export class LdapSyncInProgressError extends Error {
  readonly code = 'SYNC_IN_PROGRESS';
  constructor() { super('Ya hay una sincronización LDAP en curso'); }
}

export async function runLdapGroupSync(prisma: PrismaClient, actorEmail: string): Promise<LdapSyncResult> {
  if (!isGroupGateEnabled()) {
    throw new LdapDirectoryError('NOT_CONFIGURED', 'LDAP_REQUIRED_GROUP no está configurado');
  }
  if (syncInProgress) throw new LdapSyncInProgressError();

  syncInProgress = true;
  const errors: string[] = [];
  let created = 0, updated = 0, reactivated = 0, deactivated = 0;

  try {
    const members = await listGroupMembers();

    // Solo filas LDAP: los usuarios manuales quedan fuera ya en la consulta.
    const existing = await prisma.$queryRaw<ExistingUserRow[]>`
      SELECT id::text AS id, sso_external_id AS "ssoExternalId", email, username,
             display_name AS "displayName", COALESCE(active, true) AS active, role::text AS role
      FROM "users"
      WHERE sso_provider = 'ldap' AND sso_external_id IS NOT NULL
    `;

    const diff = computeLdapSyncDiff(members, existing);
    const role = defaultRole();

    for (const c of diff.creates) {
      try {
        // Hash de 32 bytes aleatorios: nadie conoce esa contraseña, así que el
        // login local queda cerrado por construcción, no por una comprobación.
        const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), BCRYPT_ROUNDS);
        await prisma.$transaction(async (tx) => {
          const ins = await tx.$queryRaw<{ id: string }[]>`
            INSERT INTO "users"(id, username, email, password, role, sso_provider, sso_external_id,
                                display_name, active, mfa_enabled, created_at, updated_at)
            VALUES (gen_random_uuid(), ${c.username}::varchar, ${c.email}::varchar, ${hash}::varchar,
                    ${role}::"UserRole", 'ldap', ${c.ssoExternalId}::varchar,
                    ${c.displayName}, true, false, now(), now())
            ON CONFLICT (sso_external_id) DO NOTHING
            RETURNING id::text AS id
          `;
          if (ins.length === 0) return; // carrera con otra pasada: nada que auditar
          await tx.$executeRaw`
            INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, details, created_at)
            VALUES(gen_random_uuid(), 'LDAP_SYNC_CREATE', 'User', ${ins[0].id}::uuid, ${actorEmail},
                   ${JSON.stringify({ role })}::jsonb, now())
          `;
        });
        created++;
      } catch (e) { errors.push(`create:${c.ssoExternalId}: ${msg(e)}`); logErr(e, 'CREATE', c.ssoExternalId); }
    }

    for (const u of diff.updates) {
      try {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`
            UPDATE "users"
            SET email = ${u.email}, username = ${u.username},
                display_name = ${u.displayName}, updated_at = now()
            WHERE id = ${u.id}::uuid AND sso_provider = 'ldap' AND sso_external_id IS NOT NULL
          `;
          await tx.$executeRaw`
            INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
            VALUES(gen_random_uuid(), 'LDAP_SYNC_UPDATE', 'User', ${u.id}::uuid, ${actorEmail}, now())
          `;
        });
        updated++;
      } catch (e) { errors.push(`update:${u.id}: ${msg(e)}`); logErr(e, 'UPDATE', u.id); }
    }

    for (const id of diff.reactivates) {
      try {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`
            UPDATE "users" SET active = true, updated_at = now()
            WHERE id = ${id}::uuid AND sso_provider = 'ldap' AND sso_external_id IS NOT NULL
          `;
          await tx.$executeRaw`
            INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
            VALUES(gen_random_uuid(), 'LDAP_SYNC_REACTIVATE', 'User', ${id}::uuid, ${actorEmail}, now())
          `;
        });
        reactivated++;
      } catch (e) { errors.push(`reactivate:${id}: ${msg(e)}`); logErr(e, 'REACTIVATE', id); }
    }

    for (const id of diff.deactivates) {
      try {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`
            UPDATE "users" SET active = false, updated_at = now()
            WHERE id = ${id}::uuid AND sso_provider = 'ldap' AND sso_external_id IS NOT NULL
          `;
          await tx.$executeRaw`
            INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
            VALUES(gen_random_uuid(), 'LDAP_SYNC_DEACTIVATE', 'User', ${id}::uuid, ${actorEmail}, now())
          `;
        });
        deactivated++;
      } catch (e) { errors.push(`deactivate:${id}: ${msg(e)}`); logErr(e, 'DEACTIVATE', id); }
    }

    console.log(`[ldap-sync] created=${created} updated=${updated} reactivated=${reactivated} deactivated=${deactivated} errors=${errors.length}`);
    return { created, updated, reactivated, deactivated, errors };
  } finally {
    syncInProgress = false;
  }
}

function msg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

/** Solo el identificador técnico, nunca email ni nombre (GDPR — minimización). */
function logErr(e: unknown, op: string, id: string): void {
  console.error(`[ldap-sync] ${op} ${id}:`, msg(e));
}
