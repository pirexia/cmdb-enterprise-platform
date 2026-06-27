/**
 * n8n-provisioning · endpoint de resync bajo demanda (ADMIN).
 *
 * POST /api/admin/n8n/resync  — requiere rol ADMIN
 *   → provisionAll(client, cfg, prisma) → { report: ProvisionReport }
 *   → inserta AuditLog (N8N_RESYNC / N8nProvisioning) — ISO 27001 A.8.15
 */
import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import { loadN8nProvisioningConfig } from './config.js';
import { makeN8nApiClient } from './apiClient.js';
import { provisionAll } from './provisioner.js';

export function createN8nProvisioningRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.post('/resync', async (req: any, res: any) => {
    // Auth y RBAC gestionados por authenticateToken + requireAdmin en el mount (index.ts)
    const cfg = loadN8nProvisioningConfig();
    if (!cfg.apiKey) {
      return res.status(503).json({ error: 'N8N_API_KEY no configurada; aprovisionamiento no disponible' });
    }

    const client = makeN8nApiClient(cfg);
    const report = await provisionAll(client, cfg, prisma);

    // AuditLog — inserción obligatoria (ISO 27001 A.8.15)
    const details = JSON.stringify({
      credentials: report.credentials.map((c) => `${c.name}:${c.action}`),
      workflows:   report.workflows.map((w) => `${w.name}:${w.action}`),
      errors:      report.errors,
    });
    await prisma.$executeRaw`
      INSERT INTO audit_logs (id, action, entity, entity_id, user_email, details, created_at)
      VALUES (gen_random_uuid(), 'N8N_RESYNC', 'N8nProvisioning', 'n8n',
              ${req.user.email}, ${details}::jsonb, now())
    `;

    return res.json({ report });
  });

  return router;
}
