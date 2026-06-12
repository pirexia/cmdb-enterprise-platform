import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import {
  OsCreateSchema, OsUpdateSchema,
  BswCreateSchema, BswUpdateSchema, CIBswAssociateSchema,
  BASE_SOFTWARE_ALLOWED_CI_TYPES,
} from './schemas.js';
import { catalogAudit } from './audit.js';
import { osQueries, bswQueries } from './queries.js';

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
  const os  = osQueries(prisma);
  const bsw = bswQueries(prisma);

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

  // ─── Base Software ─────────────────────────────────────────────────────────

  // GET /api/catalog/base-software
  router.get('/base-software', async (_req: Request, res: Response) => {
    try {
      res.json(await bsw.list());
    } catch (err) {
      console.error('[catalog] list BSW error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/catalog/base-software/:id
  router.get('/base-software/:id', requireUuidParam('id'), async (req: Request, res: Response) => {
    try {
      const record = await bsw.findById(req.params.id as string);
      if (!record) { res.status(404).json({ error: 'Not found' }); return; }
      res.json(record);
    } catch (err) {
      console.error('[catalog] get BSW error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/catalog/base-software
  router.post('/base-software', requireAdmin, async (req: Request, res: Response) => {
    const parsed = BswCreateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.errors }); return; }

    const { code, name, version, manufacturerId, isSystem } = parsed.data;
    try {
      let finalCode: string;
      if (code?.trim()) {
        finalCode = code.trim().toUpperCase();
      } else {
        const base = name.trim().toUpperCase().replace(/[^A-Z0-9]/g, '_');
        const existing = await prisma.baseSoftware.findMany({
          where : { code: { startsWith: base } },
          select: { code: true },
        });
        const used = new Set(existing.map(r => r.code));
        finalCode = base;
        let suffix = 1;
        while (used.has(finalCode)) { finalCode = `${base}_${suffix++}`; }
      }

      const record = await bsw.create({
        code           : finalCode,
        name,
        version        : version ?? null,
        manufacturerId : manufacturerId ?? null,
        isSystem       : isSystem ?? false,
      });
      await catalogAudit(prisma, 'CREATE_BASE_SOFTWARE', 'BaseSoftware', record.id, (req as any).user!.email);
      res.status(201).json(record);
    } catch (err: any) {
      if (err?.code === 'P2002') {
        res.status(409).json({ error: 'Code already exists' });
        return;
      }
      console.error('[catalog] create BSW error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PATCH /api/catalog/base-software/:id
  router.patch('/base-software/:id', requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const parsed = BswUpdateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.errors }); return; }

    try {
      const existing = await bsw.findById(req.params.id as string);
      if (!existing) { res.status(404).json({ error: 'Not found' }); return; }

      const { code, name, version, manufacturerId, isSystem } = parsed.data;
      const record = await bsw.update(req.params.id as string, {
        ...(code           !== undefined ? { code: code.toUpperCase() } : {}),
        ...(name           !== undefined ? { name }                      : {}),
        ...(version        !== undefined ? { version }                   : {}),
        ...(manufacturerId !== undefined ? { manufacturerId }            : {}),
        ...(isSystem       !== undefined ? { isSystem }                  : {}),
      });
      await catalogAudit(prisma, 'UPDATE_BASE_SOFTWARE', 'BaseSoftware', record.id, (req as any).user!.email);
      res.json(record);
    } catch (err: any) {
      if (err?.code === 'P2002') {
        res.status(409).json({ error: 'Code already exists' });
        return;
      }
      console.error('[catalog] update BSW error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /api/catalog/base-software/:id
  router.delete('/base-software/:id', requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    try {
      const existing = await bsw.findById(req.params.id as string);
      if (!existing) { res.status(404).json({ error: 'Not found' }); return; }

      const usage = await bsw.countUsage(req.params.id as string);
      if (usage > 0) {
        res.status(409).json({ error: `Cannot delete: in use by ${usage} record(s)` });
        return;
      }

      await bsw.delete(req.params.id as string);
      await catalogAudit(prisma, 'DELETE_BASE_SOFTWARE', 'BaseSoftware', req.params.id as string, (req as any).user!.email);
      res.status(204).send();
    } catch (err) {
      console.error('[catalog] delete BSW error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ─── CI ↔ Base Software association ────────────────────────────────────────

  // GET /api/catalog/cis/:ciId/base-software
  router.get('/cis/:ciId/base-software', requireUuidParam('ciId'), async (req: Request, res: Response) => {
    try {
      const typeCode = await bsw.getCiTypeCode(req.params.ciId as string);
      if (typeCode === null) { res.status(404).json({ error: 'CI not found' }); return; }
      const rows = await bsw.listForCI(req.params.ciId as string);
      res.json(rows.map(r => r.baseSoftware));
    } catch (err) {
      console.error('[catalog] list CI BSW error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/catalog/cis/:ciId/base-software
  router.post('/cis/:ciId/base-software', requireAdmin, requireUuidParam('ciId'), async (req: Request, res: Response) => {
    const parsed = CIBswAssociateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.errors }); return; }

    try {
      const typeCode = await bsw.getCiTypeCode(req.params.ciId as string);
      if (typeCode === null) { res.status(404).json({ error: 'CI not found' }); return; }

      // D3: only physical/virtual servers may carry base software
      if (!BASE_SOFTWARE_ALLOWED_CI_TYPES.includes(typeCode as any)) {
        res.status(422).json({ error: 'Base software can only be associated to physical or virtual server CIs' });
        return;
      }

      const target = await bsw.findById(parsed.data.baseSoftwareId);
      if (!target) { res.status(404).json({ error: 'Base software not found' }); return; }

      await bsw.associate(req.params.ciId as string, parsed.data.baseSoftwareId);
      await catalogAudit(prisma, 'ASSOCIATE_BASE_SOFTWARE', 'CI', req.params.ciId as string, (req as any).user!.email);
      res.status(201).json({ ok: true });
    } catch (err: any) {
      if (err?.code === 'P2002') {
        res.status(409).json({ error: 'Already associated' });
        return;
      }
      console.error('[catalog] associate BSW error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /api/catalog/cis/:ciId/base-software/:bswId
  router.delete('/cis/:ciId/base-software/:bswId', requireAdmin, requireUuidParam('ciId'), requireUuidParam('bswId'), async (req: Request, res: Response) => {
    try {
      await bsw.dissociate(req.params.ciId as string, req.params.bswId as string);
      await catalogAudit(prisma, 'DISSOCIATE_BASE_SOFTWARE', 'CI', req.params.ciId as string, (req as any).user!.email);
      res.status(204).send();
    } catch (err: any) {
      if (err?.code === 'P2025') {
        res.status(404).json({ error: 'Association not found' });
        return;
      }
      console.error('[catalog] dissociate BSW error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
