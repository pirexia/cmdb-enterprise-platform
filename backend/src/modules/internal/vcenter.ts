// Internal M2M endpoint for the n8n-scheduled vCenter sync workflow.
// Mounted under /api/internal/vcenter, gated by authenticateService (see router.ts).

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { loadVCenterConfig, isConfigured } from '../integrations/vcenterConfig.js';
import { runVCenterSync, buildVCenterConnector, SyncLockedError } from '../integrations/vcenterService.js';

export function createInternalVCenterRouter(
  prisma: PrismaClient,
  queueForIndexing: (entityType: string, entityId: string) => void | Promise<void>,
): Router {
  const router = Router();

  /**
   * POST /api/internal/vcenter/sync
   * Triggered by the n8n scheduled workflow. Same semantics as the ADMIN-facing
   * POST /api/integrations/vcenter/sync — kept as a thin duplicate here rather than
   * proxying through the public router, since this path is authenticated via
   * X-CMDB-Service-Token (M2M), not a user JWT.
   */
  router.post('/sync', async (req: Request, res: Response): Promise<void> => {
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
    } catch (e) {
      if (e instanceof SyncLockedError) {
        res.status(409).json({ error: 'SYNC_IN_PROGRESS' });
        return;
      }
      console.error('[internal/vcenter/sync]', e);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
