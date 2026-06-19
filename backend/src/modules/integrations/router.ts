import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createAuthenticateToken } from '../../shared/middleware/authenticate.js';
import { requireAdmin }            from '../../shared/middleware/requireAdmin.js';
import { vulnUuid }                from '../../services/entitySerializer.js';
import { Vulnerability, VulnSeverity, VulnStatus } from './types.js';

export function createIntegrationsRouter(
  prisma: PrismaClient,
  queueForIndexing: (entityType: string, entityId: string) => void | Promise<void>,
): Router {
  const router = Router();
  const authenticateToken = createAuthenticateToken(prisma);

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

  return router;
}
