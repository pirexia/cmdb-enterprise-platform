import { Router } from 'express';
import { PrismaClient } from '@prisma/client';

// Stub router — full implementation in T3 (feature/plugin-engine-api)
// This file is a placeholder so that initializePluginEngine can be imported
// without TypeScript errors while T2 is in progress.

export function createPluginRouter(_prisma: PrismaClient): Router {
  const router = Router();

  // Placeholder — all routes return 501 until T3 is merged
  router.all('*', (_req, res) => {
    res.status(501).json({ error: 'Plugin Engine API not yet implemented — coming in T3' });
  });

  return router;
}
