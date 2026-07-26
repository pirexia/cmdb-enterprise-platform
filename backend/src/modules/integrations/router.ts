import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createAuthenticateToken } from '../../shared/middleware/authenticate.js';
import { requireAdmin }            from '../../shared/middleware/requireAdmin.js';
import { requireAudit }            from '../../shared/middleware/requireAudit.js';
import { vulnUuid }                from '../../services/entitySerializer.js';
import { smtpConfigured }          from '../alerts/smtp-transport.js';
import { Vulnerability, VulnSeverity, VulnStatus } from './types.js';
import { loadVCenterConfig, isConfigured, toPublicConfig } from './vcenterConfig.js';
import { VCenterClient } from './connectors/vcenter/VCenterClient.js';
import { runVCenterSync, buildVCenterConnector, SyncLockedError } from './vcenterService.js';
import { runLdapGroupSync, isSyncInProgress, LdapSyncInProgressError } from './ldapSyncService.js';
import { isGroupGateEnabled, LdapDirectoryError } from '../../services/ldapDirectory.js';

export function createIntegrationsRouter(
  prisma: PrismaClient,
  queueForIndexing: (entityType: string, entityId: string) => void | Promise<void>,
): Router {
  const router = Router();
  const authenticateToken = createAuthenticateToken(prisma);

  /**
   * GET /api/integrations/status
   * Reports live backend integration state so the frontend badges reflect the
   * actual server configuration (not a build-time NEXT_PUBLIC_* bake).
   * Any authenticated user may read these non-sensitive boolean flags.
   */
  router.get('/status', authenticateToken, (_req: Request, res: Response) => {
    res.json({
      ldap: process.env.USE_LDAP === 'true',
      smtp: smtpConfigured(),
    });
  });

  /**
   * POST /api/integrations/greenbone
   * Ingests a Greenbone OpenVAS JSON report. ADMIN only.
   */
  router.post('/greenbone', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
    console.log('[POST /api/integrations/greenbone] Processing report…');
    try {
      type GBVuln   = { cve: string; severity: string; name: string; cvss_score?: number; description: string };
      type GBResult = { host: { hostname: string; ip?: string }; vulnerabilities: GBVuln[] };
      const { results = [] } = req.body as { results: GBResult[] };

      const processed: { ci: string; matched: boolean; vulnCount: number }[] = [];

      for (const result of results) {
        const hostname = result.host?.hostname ?? '';
        if (!hostname) continue;

        // Escape LIKE wildcards to prevent wildcard injection (%, _, \)
        const escaped = hostname.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
        type CIRow = { id: string; name: string };
        const rows = await prisma.$queryRaw<CIRow[]>`
          SELECT id, name FROM "configuration_items"
          WHERE LOWER(name) LIKE LOWER(${'%' + escaped + '%'}) ESCAPE '\\'
          ORDER BY LENGTH(name) ASC
          LIMIT 1
        `;

        if (rows.length === 0) {
          processed.push({ ci: hostname, matched: false, vulnCount: 0 });
          continue;
        }

        const ci = rows[0];

        // Read existing vulnerabilities to MERGE — preserves analyst-set lifecycle
        // status (RESUELTO, EN_CURSO, etc.) and retains vulns from other sources
        type ExistingVulnRow = { vulnerabilities: unknown };
        const existingRows = await prisma.$queryRaw<ExistingVulnRow[]>`
          SELECT vulnerabilities FROM "configuration_items" WHERE id = ${ci.id}::uuid LIMIT 1
        `;
        const existingVulns = (existingRows[0]?.vulnerabilities ?? []) as Vulnerability[];
        const existingByCve = new Map(existingVulns.map((v) => [v.cve, v]));

        const importedAt = new Date().toISOString();
        const incoming = (result.vulnerabilities ?? []).map((v) => ({
          cve:         v.cve,
          severity:    v.severity?.toUpperCase() as VulnSeverity,
          description: v.description ?? v.name ?? '',
          source:      'greenbone' as const,
          cvss_score:  v.cvss_score ?? null,
          status:      'NUEVO' as VulnStatus,
          importedAt,
        }));

        const incomingByCve = new Map(incoming.map((v) => [v.cve, v]));
        const merged: Vulnerability[] = [
          // Existing: refresh fields if re-reported; preserve status set by analyst
          ...existingVulns.map((existing) => {
            const fresh = incomingByCve.get(existing.cve);
            if (!fresh) return existing;
            return { ...fresh, status: existing.status };
          }),
          // New vulns not previously known
          ...incoming.filter((v) => !existingByCve.has(v.cve)),
        ];

        await prisma.$executeRaw`
          UPDATE "configuration_items"
          SET "vulnerabilities" = ${JSON.stringify(merged)}::jsonb
          WHERE "id" = ${ci.id}::uuid
        `;

        const newCount = incoming.filter((v) => !existingByCve.has(v.cve)).length;
        processed.push({ ci: ci.name, matched: true, vulnCount: merged.length });
        console.log(`  ✓ ${ci.name} → ${merged.length} total (${newCount} new, ${incoming.length - newCount} updated)`);

        for (const v of merged) {
          void queueForIndexing('vulnerability', vulnUuid(ci.id, v.cve));
        }
        void queueForIndexing('ci', ci.id);
      }

      const totalMatched = processed.filter((p) => p.matched).length;
      await prisma.$executeRaw`
        INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, details, created_at)
        VALUES(gen_random_uuid(), 'INTEGRATION_GREENBONE', 'SYSTEM', '00000000-0000-0000-0000-000000000000'::uuid, ${req.user!.email},
               ${JSON.stringify({ totalMatched, totalUnmatched: processed.length - totalMatched })}::jsonb, now())`;
      res.json({
        message: 'Greenbone report processed',
        processed,
        totalMatched,
        totalUnmatched: processed.filter((p) => !p.matched).length,
      });
    } catch (error) {
      console.error('[POST /api/integrations/greenbone] Error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /api/integrations/crowdstrike
   * Ingests a CrowdStrike Falcon agent status export. ADMIN only.
   */
  router.post('/crowdstrike', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
    console.log('[POST /api/integrations/crowdstrike] Processing report…');
    try {
      type CSDevice = {
        hostname: string; agent_id: string; agent_version: string;
        status: string; prevention_policy: string; last_seen: string;
        detections: unknown[];
      };
      const { devices = [] } = req.body as { devices: CSDevice[] };

      const processed: { ci: string; matched: boolean; status: string }[] = [];

      for (const device of devices) {
        const hostname = device.hostname ?? '';
        if (!hostname) continue;

        // Escape LIKE wildcards to prevent wildcard injection (%, _, \)
        const escaped = hostname.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
        type CIRow = { id: string; name: string };
        const rows = await prisma.$queryRaw<CIRow[]>`
          SELECT id, name FROM "configuration_items"
          WHERE LOWER(name) LIKE LOWER(${'%' + escaped + '%'}) ESCAPE '\\'
          ORDER BY LENGTH(name) ASC
          LIMIT 1
        `;

        if (rows.length === 0) {
          processed.push({ ci: hostname, matched: false, status: 'unmatched' });
          continue;
        }

        const ci = rows[0];

        const agentData = {
          agentId:          device.agent_id,
          agentVersion:     device.agent_version,
          status:           device.status,
          preventionPolicy: device.prevention_policy,
          lastSeen:         device.last_seen,
          detections:       device.detections ?? [],
          source:           'crowdstrike',
          updatedAt:        new Date().toISOString(),
        };

        await prisma.$executeRaw`
          UPDATE "configuration_items"
          SET "agent_status" = ${JSON.stringify(agentData)}::jsonb
          WHERE "id" = ${ci.id}::uuid
        `;

        processed.push({ ci: ci.name, matched: true, status: device.status });
        console.log(`  ✓ ${ci.name} → agent ${device.status}, ${device.detections?.length ?? 0} detection(s)`);
      }

      const totalMatched = processed.filter((p) => p.matched).length;
      await prisma.$executeRaw`
        INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, details, created_at)
        VALUES(gen_random_uuid(), 'INTEGRATION_CROWDSTRIKE', 'SYSTEM', '00000000-0000-0000-0000-000000000000'::uuid, ${req.user!.email},
               ${JSON.stringify({ totalMatched, totalUnmatched: processed.length - totalMatched })}::jsonb, now())`;
      res.json({
        message: 'CrowdStrike report processed',
        processed,
        totalMatched,
        totalUnmatched: processed.filter((p) => !p.matched).length,
      });
    } catch (error) {
      console.error('[POST /api/integrations/crowdstrike] Error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/integrations/vcenter/status
   * Reports vCenter connector config (secret-free) + last sync info. ADMIN/AUDITOR.
   */
  router.get('/vcenter/status', authenticateToken, requireAudit, async (_req: Request, res: Response) => {
    try {
      const cfg = loadVCenterConfig();
      const pub = toPublicConfig(cfg);

      const lastRows = await prisma.$queryRaw<{ details: unknown; created_at: Date }[]>`
        SELECT details, created_at FROM "audit_logs"
        WHERE action = 'SYNC_VCENTER' ORDER BY created_at DESC LIMIT 1`;

      res.json({
        ...pub,
        lastSyncAt: lastRows[0]?.created_at ?? null,
        lastSyncResult: lastRows[0]?.details ?? null,
      });
    } catch (error) {
      console.error('[GET /api/integrations/vcenter/status] Error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /api/integrations/vcenter/test
   * Verifies vCenter connectivity/credentials without running a full sync. ADMIN only.
   */
  router.post('/vcenter/test', authenticateToken, requireAdmin, async (_req: Request, res: Response) => {
    const cfg = loadVCenterConfig();
    if (!isConfigured(cfg)) {
      res.status(400).json({ error: 'VCENTER_NOT_CONFIGURED' });
      return;
    }

    const client = new VCenterClient({
      url: cfg.url,
      username: cfg.username,
      password: cfg.password,
      rejectUnauthorized: cfg.sslVerify,
      caCertPath: cfg.caCertPath,
    });

    try {
      await client.session();
      await client.logout();
      res.json({ ok: true, message: 'Connected successfully' });
    } catch (error) {
      console.error('[POST /api/integrations/vcenter/test] Error:', error);
      res.json({ ok: false, message: 'Connection failed' });
    }
  });

  /**
   * POST /api/integrations/vcenter/sync
   * Runs a manual vCenter sync (discover VMs → create/update/retire CIs). ADMIN only.
   */
  router.post('/vcenter/sync', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
    const cfg = loadVCenterConfig();
    if (!isConfigured(cfg)) {
      res.status(409).json({ error: 'VCENTER_NOT_CONFIGURED' });
      return;
    }
    if (!cfg.syncEnabled) {
      res.status(409).json({ error: 'VCENTER_SYNC_DISABLED' });
      return;
    }

    try {
      const result = await runVCenterSync({
        prisma,
        connector: buildVCenterConnector(cfg),
        defaults: {
          ciTypeCode: cfg.ciTypeCode,
          environment: cfg.defaultEnvironment,
          criticality: cfg.defaultCriticality,
        },
        queueForIndexing,
        userEmail: req.user!.email,
      });
      res.status(200).json(result);
    } catch (error) {
      if (error instanceof SyncLockedError) {
        res.status(409).json({ error: 'SYNC_IN_PROGRESS' });
        return;
      }
      console.error('[POST /api/integrations/vcenter/sync] Error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/integrations/vcenter/sync-log
   * Last 20 vCenter sync runs (from audit_logs). ADMIN/AUDITOR.
   */
  router.get('/vcenter/sync-log', authenticateToken, requireAudit, async (_req: Request, res: Response) => {
    try {
      const rows = await prisma.$queryRaw<{ details: unknown; created_at: Date }[]>`
        SELECT details, created_at FROM "audit_logs"
        WHERE action = 'SYNC_VCENTER' ORDER BY created_at DESC LIMIT 20`;

      res.json(rows.map((r) => ({ date: r.created_at, ...(r.details as object) })));
    } catch (error) {
      console.error('[GET /api/integrations/vcenter/sync-log] Error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ─── LDAP/AD — grupo de acceso y sincronización de usuarios (v3.5.10) ───────
  // En paralelo exacto a las rutas /vcenter/*: mismo patrón de estado, acción y
  // registro, para que una integración nueva no invente su propia forma.

  /**
   * GET /api/integrations/ldap/status
   * Estado de configuración de la puerta de grupo. Sin secretos: el nombre del
   * grupo no lo es (aparece en cualquier consola de AD) y sin él el
   * administrador no puede diagnosticar por qué no entra nadie.
   */
  router.get('/ldap/status', authenticateToken, requireAudit, (_req: Request, res: Response) => {
    res.json({
      enabled:        isGroupGateEnabled(),
      group:          (process.env.LDAP_REQUIRED_GROUP ?? '').trim(),
      nested:         process.env.LDAP_GROUP_NESTED !== 'false',
      useLdap:        process.env.USE_LDAP === 'true',
      defaultRole:    (process.env.LDAP_SYNC_DEFAULT_ROLE ?? 'VIEWER').toUpperCase(),
      syncInProgress: isSyncInProgress(),
    });
  });

  /**
   * POST /api/integrations/ldap/sync
   * Sincronización bajo demanda desde la UI. Ejecuta exactamente la misma
   * función que el workflow diario de n8n.
   */
  router.post('/ldap/sync', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
    try {
      const actor = (req as Request & { user?: { email?: string } }).user?.email ?? 'system@cmdb.local';
      const result = await runLdapGroupSync(prisma, actor);
      // 207 si alguna fila falló pero el resto se aplicó: el llamante debe poder
      // distinguir "todo bien" de "parcial".
      res.status(result.errors.length > 0 ? 207 : 200).json(result);
    } catch (error) {
      if (error instanceof LdapDirectoryError && error.code === 'NOT_CONFIGURED') {
        res.status(400).json({ error: 'LDAP_GROUP_NOT_CONFIGURED' });
        return;
      }
      if (error instanceof LdapSyncInProgressError) {
        res.status(409).json({ error: 'SYNC_IN_PROGRESS' });
        return;
      }
      // 502 accionable en lugar de 500 genérico (patrón adoptado en v3.5.5):
      // el fallo es de un sistema externo, no de esta aplicación.
      console.error('[POST /api/integrations/ldap/sync] Error:', error);
      res.status(502).json({ error: 'LDAP_DIRECTORY_UNAVAILABLE' });
    }
  });

  /**
   * GET /api/integrations/ldap/sync-log
   * Historial leído de audit_logs — sin tabla propia (D4 del patrón vCenter).
   */
  router.get('/ldap/sync-log', authenticateToken, requireAudit, async (_req: Request, res: Response) => {
    try {
      const rows = await prisma.$queryRaw`
        SELECT action,
               entity_id::text AS "entityId",
               user_email      AS "userEmail",
               created_at      AS "createdAt"
        FROM "audit_logs"
        WHERE action LIKE 'LDAP_SYNC_%' OR action = 'LDAP_GROUP_DENIED'
        ORDER BY created_at DESC
        LIMIT 100
      `;
      res.json(rows);
    } catch (error) {
      console.error('[GET /api/integrations/ldap/sync-log] Error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
