import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { OsCreateSchema, OsUpdateSchema } from './schemas.js';
import { catalogAudit } from './audit.js';
import { osQueries } from './queries.js';

function requireUuidParam(paramName: string) {
  return (req: Request, res: Response, next: () => void): void => {
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRe.test((req.params[paramName] as string) ?? '')) {
      res.status(400).json({ error: `Invalid ${paramName}: must be a UUID` });
      return;
    }
    next();
  };
}

function requireAdmin(req: Request, res: Response, next: () => void): void {
  if ((req as any).user?.role !== 'ADMIN') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
}

export function createCatalogRouter(prisma: PrismaClient): Router {
  const router = Router();
  const os = osQueries(prisma);

  // ─── Operating Systems ─────────────────────────────────────────────────────

  // GET /api/catalog/operating-systems
  router.get('/operating-systems', async (_req: Request, res: Response) => {
    try {
      res.json(await os.list());
    } catch (err) {
      console.error('[catalog] list OS error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/catalog/operating-systems/:id
  router.get('/operating-systems/:id', requireUuidParam('id'), async (req: Request, res: Response) => {
    try {
      const record = await os.findById(req.params.id as string);
      if (!record) { res.status(404).json({ error: 'Not found' }); return; }
      res.json(record);
    } catch (err) {
      console.error('[catalog] get OS error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/catalog/operating-systems
  router.post('/operating-systems', requireAdmin, async (req: Request, res: Response) => {
    const parsed = OsCreateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.errors }); return; }

    const { code, name, version, manufacturerId, isSystem } = parsed.data;
    try {
      // Auto-generate code if not provided
      let finalCode: string;
      if (code?.trim()) {
        finalCode = code.trim().toUpperCase();
      } else {
        const base = name.trim().toUpperCase().replace(/[^A-Z0-9]/g, '_');
        const existing = await prisma.operatingSystem.findMany({
          where : { code: { startsWith: base } },
          select: { code: true },
        });
        const used = new Set(existing.map(r => r.code));
        finalCode = base;
        let suffix = 1;
        while (used.has(finalCode)) { finalCode = `${base}_${suffix++}`; }
      }

      const record = await os.create({
        code           : finalCode,
        name,
        version        : version ?? null,
        manufacturerId : manufacturerId ?? null,
        isSystem       : isSystem ?? false,
      });
      await catalogAudit(prisma, 'CREATE_OS', 'OperatingSystem', record.id, (req as any).user!.email);
      res.status(201).json(record);
    } catch (err: any) {
      if (err?.code === 'P2002') {
        res.status(409).json({ error: 'Code already exists' });
        return;
      }
      console.error('[catalog] create OS error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PATCH /api/catalog/operating-systems/:id
  router.patch('/operating-systems/:id', requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const parsed = OsUpdateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.errors }); return; }

    try {
      const existing = await os.findById(req.params.id as string);
      if (!existing) { res.status(404).json({ error: 'Not found' }); return; }

      const { code, name, version, manufacturerId, isSystem } = parsed.data;
      const record = await os.update(req.params.id as string, {
        ...(code           !== undefined ? { code: code.toUpperCase() }  : {}),
        ...(name           !== undefined ? { name }                       : {}),
        ...(version        !== undefined ? { version }                    : {}),
        ...(manufacturerId !== undefined ? { manufacturerId }             : {}),
        ...(isSystem       !== undefined ? { isSystem }                   : {}),
      });
      await catalogAudit(prisma, 'UPDATE_OS', 'OperatingSystem', record.id, (req as any).user!.email);
      res.json(record);
    } catch (err: any) {
      if (err?.code === 'P2002') {
        res.status(409).json({ error: 'Code already exists' });
        return;
      }
      console.error('[catalog] update OS error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /api/catalog/operating-systems/:id
  router.delete('/operating-systems/:id', requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    try {
      const existing = await os.findById(req.params.id as string);
      if (!existing) { res.status(404).json({ error: 'Not found' }); return; }

      const usage = await os.countUsage(req.params.id as string);
      if (usage > 0) {
        res.status(409).json({ error: `Cannot delete: in use by ${usage} record(s)` });
        return;
      }

      await os.delete(req.params.id as string);
      await catalogAudit(prisma, 'DELETE_OS', 'OperatingSystem', req.params.id as string, (req as any).user!.email);
      res.status(204).send();
    } catch (err) {
      console.error('[catalog] delete OS error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
