import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireUuidParam } from '../../shared/middleware/requireUuidParam.js';
import { TimelineItemsQuerySchema } from './schemas.js';
import { getTimelineItems, getTimelineFilters, getLegacyDates } from './queries.js';

export function createTimelineRouter(prisma: PrismaClient): Router {
  const router = Router();

  // GET /api/timeline/items
  // Read-only; all authenticated roles allowed (VIEWER+).
  // Query params: types, ciTypeId, status, dateTypes, search, limit, offset
  router.get('/items', async (req: Request, res: Response) => {
    try {
      const parsed = TimelineItemsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid query parameters', details: parsed.error.flatten() });
        return;
      }
      const result = await getTimelineItems(prisma, parsed.data);
      res.json(result);
    } catch (err) {
      console.error('[Timeline] /items error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/timeline/filters
  // Returns metadata to populate filter dropdowns.
  router.get('/filters', async (_req: Request, res: Response) => {
    try {
      const filters = await getTimelineFilters(prisma);
      res.json(filters);
    } catch (err) {
      console.error('[Timeline] /filters error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/timeline/legacy/:ciId
  // Returns inherited lifecycle dates from OS, DeviceModel, and BaseSoftware
  // associated with the given CI.
  router.get('/legacy/:ciId', requireUuidParam('ciId'), async (req: Request, res: Response) => {
    try {
      const result = await getLegacyDates(prisma, req.params['ciId'] as string);
      res.json(result);
    } catch (err) {
      console.error('[Timeline] /legacy error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
