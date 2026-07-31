import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createAuthenticateToken } from '../../shared/middleware/authenticate.js';
import { requireAdmin }            from '../../shared/middleware/requireAdmin.js';
import { requireAudit }            from '../../shared/middleware/requireAudit.js';
import { requireSecurityWrite }    from '../../shared/middleware/requireSecurity.js';
import { smtpConfigured }          from '../alerts/smtp-transport.js';
import { uploadReport }            from '../vuln-import/service.js';
import { UploadRequestSchema }     from '../vuln-import/schemas.js';
import { UnsupportedGreenboneFormatError } from '../vuln-import/parser.js';
import { UnsupportedCrowdStrikeFormatError } from '../vuln-import/crowdstrikeParser.js';
import { ZodError }                from 'zod';
import { loadVCenterConfig, isConfigured, toPublicConfig } from './vcenterConfig.js';
import { VCenterClient } from './connectors/vcenter/VCenterClient.js';
import { runVCenterSync, buildVCenterConnector, SyncLockedError } from './vcenterService.js';
import { runLdapGroupSync, isSyncInProgress, LdapSyncInProgressError } from './ldapSyncService.js';
import { isGroupGateEnabled, LdapDirectoryError } from '../../services/ldapDirectory.js';
import { loadRedHatLightspeedConfig, toPublicConfig as toPublicLightspeedConfig } from './connectors/redhatLightspeed/config.js';
import {
  runRedHatLightspeedImport, RedHatLightspeedNotConfiguredError, RedHatLightspeedSyncInProgressError,
} from './connectors/redhatLightspeed/service.js';

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
   *
   * LEGACY compatibility shim (spec §D9, v3.6.0 B6). This used to be a
   * standalone direct-merge importer that read `req.body.results` — a field
   * that does not exist in a real Greenbone export, so it silently matched
   * nothing and returned 200 with `totalMatched: 0` every time. It is kept
   * (not deleted, per D9 — some external automation may already call it)
   * but now delegates entirely to the new staging module
   * (`modules/vuln-import/service.ts`): parsing, CI matching, severity
   * classification and batch persistence are the SAME code path as
   * `POST /api/vuln-import/upload`. No CI is mutated directly here — a
   * PENDING batch is created and must still be reviewed/accepted via the
   * `/api/vuln-import` endpoints, same as any other upload (A04 — staging +
   * explicit human acceptance is the design mitigation, not bypassed here).
   *
   * Request body: accepts the same envelope as `/api/vuln-import/upload`
   * (`{filename?, report}`). For backward compatibility with callers that
   * still POST the raw Greenbone report object directly at the top level
   * (the pre-v3.6.0 shape for this specific route), the whole body is
   * wrapped as `{filename: <synthesized>, report: req.body}` whenever it
   * doesn't already look like the upload envelope (i.e. has no `report`
   * key). A body still shaped like the old invented `{results: [...]}`
   * mock is neither the envelope nor a real Greenbone report, so it fails
   * parsing and is rejected with 400 — it must NOT silently succeed as it
   * did before this fix.
   */
  router.post('/greenbone', authenticateToken, requireSecurityWrite, async (req: Request, res: Response) => {
    console.log('[POST /api/integrations/greenbone] Delegating to vuln-import staging…');
    try {
      const rawBody = (req.body ?? {}) as Record<string, unknown>;
      const looksLikeUploadEnvelope = typeof rawBody === 'object' && rawBody !== null && 'report' in rawBody;
      const envelope = looksLikeUploadEnvelope
        ? rawBody
        : { filename: `legacy-integration-upload-${new Date().toISOString()}.json`, report: rawBody };

      const body = UploadRequestSchema.parse(envelope);
      const result = await uploadReport(prisma, body, req.user!.email);

      res.json({
        message: 'Greenbone report processed via staging',
        batchId: result.batchId,
        summary: result.summary,
      });
    } catch (err) {
      if (err instanceof UnsupportedGreenboneFormatError) {
        res.status(400).json({
          error: `${err.message} This endpoint now expects the real Greenbone export format ` +
            '(top-level "allHostSubreportEntries"), not the legacy "results" mock shape. ' +
            'No staging batch was created.',
        });
        return;
      }
      if (err instanceof ZodError) {
        res.status(400).json({
          error: 'Invalid Greenbone report — this endpoint now expects the real Greenbone export ' +
            'format. No staging batch was created.',
          details: err.issues,
        });
        return;
      }
      console.error('[POST /api/integrations/greenbone] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * POST /api/integrations/crowdstrike
   *
   * Format-aware (v3.6.1, spec D1): this route historically only ever
   * ingested a CrowdStrike Falcon agent/EDR status export (`{devices: [...]}`
   * — a completely invented mock shape unrelated to Spotlight, feeding the
   * `agent_status` column that 4 inventory filters, a badge, CSV export and
   * a security report all depend on today). That agent/EDR path below is
   * UNCHANGED. This now also accepts a real CrowdStrike Spotlight
   * vulnerability export (a flat top-level JSON array, optionally wrapped
   * in the same `{filename?, report}` envelope `/api/vuln-import/upload`
   * accepts) and routes it to the SAME staging pipeline as
   * `/api/integrations/greenbone` above — parsing, CI matching,
   * classification and PENDING batch persistence, never a direct CI write
   * (A04 — staging + explicit human acceptance). The branch is a routing
   * decision only; both paths sit behind the same `requireSecurityWrite`.
   */
  router.post('/crowdstrike', authenticateToken, requireSecurityWrite, async (req: Request, res: Response) => {
    const rawBody = (req.body ?? {}) as Record<string, unknown> | unknown[];

    // The old/invented mock format is the only shape that has ever used a
    // top-level "devices" key — mirrors how Greenbone's legacy shim detects
    // its own old shape (a distinguishing key), never a generic "does it
    // parse" heuristic.
    const isAgentStatusShape = !Array.isArray(rawBody) && rawBody !== null
      && typeof rawBody === 'object' && 'devices' in (rawBody as Record<string, unknown>);

    if (!isAgentStatusShape) {
      const asRecord = Array.isArray(rawBody) ? null : (rawBody as Record<string, unknown>);
      const hasEnvelope = asRecord !== null && 'report' in asRecord;
      const spotlightCandidate = hasEnvelope ? (asRecord as Record<string, unknown>).report : rawBody;

      if (Array.isArray(spotlightCandidate)) {
        console.log('[POST /api/integrations/crowdstrike] Spotlight export detected — delegating to vuln-import staging…');
        try {
          const envelope = hasEnvelope
            ? (asRecord as Record<string, unknown>)
            : { filename: `legacy-crowdstrike-upload-${new Date().toISOString()}.json`, report: rawBody };

          const body = UploadRequestSchema.parse(envelope);
          const result = await uploadReport(prisma, body, req.user!.email, 'crowdstrike');

          res.json({
            message: 'CrowdStrike Spotlight report processed via staging',
            batchId: result.batchId,
            summary: result.summary,
          });
        } catch (err) {
          if (err instanceof UnsupportedCrowdStrikeFormatError) {
            res.status(400).json({ error: err.message });
            return;
          }
          if (err instanceof ZodError) {
            res.status(400).json({
              error: 'Invalid CrowdStrike Spotlight report — expected a flat array of vulnerability records.',
              details: err.issues,
            });
            return;
          }
          console.error('[POST /api/integrations/crowdstrike] Error:', err);
          res.status(500).json({ error: 'Internal server error' });
        }
        return;
      }

      // Neither the agent/EDR shape nor a recognizable Spotlight export
      // (e.g. the legacy Greenbone `{results: [...]}` mock posted to the
      // wrong endpoint) — reject explicitly rather than silently matching
      // nothing, same principle as Greenbone's legacy-format rejection.
      res.status(400).json({
        error: 'Unsupported request body for POST /api/integrations/crowdstrike. Expected either ' +
          '(1) a CrowdStrike Falcon agent/EDR status export ({"devices": [...]}), or ' +
          '(2) a real CrowdStrike Spotlight vulnerability export (a top-level flat JSON array of ' +
          'vulnerability records, optionally wrapped in {filename?, report}).',
      });
      return;
    }

    console.log('[POST /api/integrations/crowdstrike] Processing agent/EDR status report…');
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

  // ─── Red Hat Lightspeed — live-pull vulnerability connector (v3.7.0) ────────

  /** GET /api/integrations/redhat-lightspeed/status — connector configured? */
  router.get('/redhat-lightspeed/status', authenticateToken, requireAudit, (_req: Request, res: Response) => {
    res.json(toPublicLightspeedConfig(loadRedHatLightspeedConfig()));
  });

  /** POST /api/integrations/redhat-lightspeed/import — live pull into the
   *  vuln-import staging pipeline. See connectors/redhatLightspeed/service.ts. */
  router.post('/redhat-lightspeed/import', authenticateToken, requireSecurityWrite, async (req: Request, res: Response) => {
    try {
      const result = await runRedHatLightspeedImport(prisma, req.user!.email);
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof RedHatLightspeedNotConfiguredError) { res.status(503).json({ error: 'NOT_CONFIGURED' }); return; }
      if (err instanceof RedHatLightspeedSyncInProgressError) { res.status(409).json({ error: 'IMPORT_IN_PROGRESS' }); return; }
      console.error('[POST /api/integrations/redhat-lightspeed/import] Error:', err);
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
      // El sAMAccountName de la cuenta afectada vive en users.sso_external_id;
      // audit_logs solo guarda su id. LEFT JOIN (no INNER) a propósito: el
      // registro de auditoría es inmutable y debe seguir apareciendo aunque la
      // fila del usuario se haya borrado después (erasure GDPR) — en ese caso
      // la columna queda a null y la UI muestra un guion.
      // `entity_id` es varchar(36), de ahí el cast de users.id a text.
      const rows = await prisma.$queryRaw`
        SELECT a.action,
               a.entity_id::text  AS "entityId",
               a.user_email       AS "userEmail",
               a.created_at       AS "createdAt",
               u.sso_external_id  AS "samAccountName"
        FROM "audit_logs" a
        LEFT JOIN "users" u
          ON u.id::text = a.entity_id AND u.sso_provider = 'ldap'
        WHERE a.action LIKE 'LDAP_SYNC_%' OR a.action = 'LDAP_GROUP_DENIED'
        ORDER BY a.created_at DESC
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
