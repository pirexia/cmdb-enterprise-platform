import { Router } from 'express';
import type { PrismaClient } from '@prisma/client';
import type { Request, Response } from 'express';
import { getAvailableReports } from './registry.js';
import { requireReportAccess } from './middleware.js';
import { ReportQuerySchema, ExportQuerySchema, EXPORT_ROW_LIMIT } from './schemas.js';
import { logReportView, logReportExport } from './audit.js';
import { toCSV, toXLSX } from './export.js';
import type { UserRole, ReportFilters, ReportResult } from './types.js';
import { pluginRuntime, routeRegistry } from '../plugins/engine.js';

type AuthRequest = Request & { user?: { email?: string; role?: UserRole } };

export function createReportsRouter(prisma: PrismaClient): Router {
  const router = Router();

  // GET /api/reports — list all reports with availability flag for current role
  router.get('/', (req: AuthRequest, res: Response): void => {
    const role = req.user?.role ?? 'VIEWER';
    const reports = getAvailableReports(role);
    res.json({ reports });
  });

  // GET /api/reports/:id/filters — filter + column definitions.
  // Merges any dynamic options (P3) resolved from the DB into the static defs.
  router.get('/:id/filters', requireReportAccess, async (req: AuthRequest, res: Response): Promise<void> => {
    const def = req.report!;
    let filters = def.filters;
    if (def.loadFilterOptions) {
      try {
        const dynamic = await def.loadFilterOptions(prisma);
        filters = def.filters.map((f) =>
          dynamic[f.key] ? { ...f, options: dynamic[f.key] } : f,
        );
      } catch (err) {
        console.error(`[reports] loadFilterOptions failed for "${def.id}":`, err);
      }
    }
    res.json({ filters, columns: def.columns });
  });

  // GET /api/reports/:id/data — paginated data
  router.get('/:id/data', requireReportAccess, async (req: AuthRequest, res: Response): Promise<void> => {
    const def = req.report!;
    const parsed = ReportQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query parameters', issues: parsed.error.issues });
      return;
    }

    const filters = parsed.data as ReportFilters;

    try {
      let result: ReportResult;

      if (def.source === 'plugin' && def.pluginId && def.routePath) {
        const routeDef = routeRegistry.match(def.pluginId, 'GET', def.routePath);
        if (!routeDef) {
          res.status(503).json({ error: 'Plugin report route not registered' });
          return;
        }
        const raw = await pluginRuntime.runRoute(routeDef, { query: filters });
        result = (raw ?? { data: [], total: 0 }) as ReportResult;
      } else {
        result = await def.query!(prisma, filters);
      }

      // Fire-and-forget audit log (non-blocking)
      void logReportView(prisma, req.user?.email ?? 'unknown', def.id, {
        from: filters.from, to: filters.to, search: filters.search,
      });

      res.json({ ...result, page: filters.page, limit: filters.limit });
    } catch (err) {
      console.error(`[reports] Error running report "${def.id}":`, err);
      res.status(500).json({ error: 'Failed to generate report' });
    }
  });

  // GET /api/reports/:id/export?format=csv|xlsx
  router.get('/:id/export', requireReportAccess, async (req: AuthRequest, res: Response): Promise<void> => {
    const def = req.report!;
    const parsed = ExportQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query parameters', issues: parsed.error.issues });
      return;
    }

    const { format, ...rest } = parsed.data;

    if (!def.exportFormats.includes(format as 'csv' | 'xlsx')) {
      res.status(400).json({ error: `Export format "${format}" not supported for this report` });
      return;
    }

    const filters: ReportFilters = { ...rest, page: 1, limit: EXPORT_ROW_LIMIT };

    try {
      let result: ReportResult;

      if (def.source === 'plugin' && def.pluginId && def.routePath) {
        const routeDef = routeRegistry.match(def.pluginId, 'GET', def.routePath);
        if (!routeDef) {
          res.status(503).json({ error: 'Plugin report route not registered' });
          return;
        }
        const raw = await pluginRuntime.runRoute(routeDef, { query: filters });
        result = (raw ?? { data: [], total: 0 }) as ReportResult;
      } else {
        result = await def.query!(prisma, filters);
      }

      void logReportExport(prisma, req.user?.email ?? 'unknown', def.id, format, {
        from: filters.from, to: filters.to, search: filters.search, total: result.total,
      });

      const filename = `${def.id}-${new Date().toISOString().slice(0, 10)}`;

      if (format === 'csv') {
        const csv = toCSV(def.columns, result.data);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
        res.send('﻿' + csv); // BOM for Excel UTF-8
        return;
      }

      if (format === 'xlsx') {
        const buf = await toXLSX(def.columns, result.data);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
        res.send(buf);
        return;
      }
    } catch (err) {
      console.error(`[reports] Export error for "${def.id}":`, err);
      res.status(500).json({ error: 'Failed to export report' });
    }
  });

  return router;
}
