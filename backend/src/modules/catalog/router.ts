import { Router, Request, Response } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import {
  DateTypeCreateSchema, DateTypeUpdateSchema, DATE_TYPE_CATEGORIES,
  EntityDateCreateSchema, EntityDateUpdateSchema,
  OsCreateSchema, OsUpdateSchema,
  BswCreateSchema, BswUpdateSchema, CIBswAssociateSchema,
  BASE_SOFTWARE_ALLOWED_CI_TYPES,
} from './schemas.js';
import { catalogAudit } from './audit.js';
import { dtQueries, ciDateQueries, osDateQueries, bswDateQueries, dmDateQueries, osQueries, bswQueries } from './queries.js';

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
  const dt    = dtQueries(prisma);
  const os    = osQueries(prisma);
  const bsw   = bswQueries(prisma);

  // ─── Date Types ────────────────────────────────────────────────────────────

  // GET /api/catalog/date-types[?category=HARDWARE|SOFTWARE|OS|GENERAL]
  router.get('/date-types', async (req: Request, res: Response) => {
    const raw = req.query['category'] as string | undefined;
    const category = raw && (DATE_TYPE_CATEGORIES as readonly string[]).includes(raw)
      ? (raw as (typeof DATE_TYPE_CATEGORIES)[number])
      : undefined;
    try {
      res.json(await dt.list(category));
    } catch (err) {
      console.error('[catalog] list DateType error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/catalog/date-types/:id
  router.get('/date-types/:id', requireUuidParam('id'), async (req: Request, res: Response) => {
    try {
      const record = await dt.findById(req.params.id as string);
      if (!record) { res.status(404).json({ error: 'Not found' }); return; }
      res.json(record);
    } catch (err) {
      console.error('[catalog] get DateType error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/catalog/date-types
  router.post('/date-types', requireAdmin, async (req: Request, res: Response) => {
    const parsed = DateTypeCreateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.errors }); return; }

    const { code, name, description, category, sortOrder, isSystem } = parsed.data;
    try {
      const existing = await dt.findByCode(code);
      if (existing) { res.status(409).json({ error: 'Code already exists' }); return; }

      const record = await prisma.$transaction(async (tx) => {
        const created = await dtQueries(tx).create({
          code,
          name,
          description : description ?? null,
          category,
          sortOrder   : sortOrder ?? 0,
          isSystem    : isSystem ?? false,
        });
        await catalogAudit(tx, 'CREATE_DATE_TYPE', 'DateType', created.id, (req as any).user!.email);
        return created;
      });
      res.status(201).json(record);
    } catch (err: any) {
      if (err?.code === 'P2002') { res.status(409).json({ error: 'Code already exists' }); return; }
      console.error('[catalog] create DateType error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PATCH /api/catalog/date-types/:id
  router.patch('/date-types/:id', requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const parsed = DateTypeUpdateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.errors }); return; }

    try {
      const existing = await dt.findById(req.params.id as string);
      if (!existing) { res.status(404).json({ error: 'Not found' }); return; }

      const { code, name, description, category, sortOrder } = parsed.data;
      const record = await prisma.$transaction(async (tx) => {
        const updated = await dtQueries(tx).update(req.params.id as string, {
          ...(code        !== undefined ? { code }        : {}),
          ...(name        !== undefined ? { name }        : {}),
          ...(description !== undefined ? { description } : {}),
          ...(category    !== undefined ? { category }    : {}),
          ...(sortOrder   !== undefined ? { sortOrder }   : {}),
        });
        await catalogAudit(tx, 'UPDATE_DATE_TYPE', 'DateType', updated.id, (req as any).user!.email);
        return updated;
      });
      res.json(record);
    } catch (err: any) {
      if (err?.code === 'P2002') { res.status(409).json({ error: 'Code already exists' }); return; }
      console.error('[catalog] update DateType error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /api/catalog/date-types/:id
  router.delete('/date-types/:id', requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    try {
      const existing = await dt.findById(req.params.id as string);
      if (!existing) { res.status(404).json({ error: 'Not found' }); return; }
      if (existing.isSystem) {
        res.status(409).json({ error: 'System date types cannot be deleted' });
        return;
      }

      const usage = await dt.countUsage(req.params.id as string);
      if (usage > 0) {
        res.status(409).json({ error: `Cannot delete: in use by ${usage} record(s)` });
        return;
      }

      await prisma.$transaction(async (tx) => {
        await dtQueries(tx).delete(req.params.id as string);
        await catalogAudit(tx, 'DELETE_DATE_TYPE', 'DateType', req.params.id as string, (req as any).user!.email);
      });
      res.status(204).send();
    } catch (err) {
      console.error('[catalog] delete DateType error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ─── Entity Lifecycle Dates ────────────────────────────────────────────────
  // Reusable helper to build 4 CRUD routes for one entity type.
  // entityParam   : URL param name (ciId, osId, bswId, dmId)
  // parentCheck   : async fn that returns true if the parent entity exists
  // qf            : factory for the entity-date query object, bound to whichever
  //                 Prisma.TransactionClient is passed in (base prisma for reads,
  //                 `tx` for writes so the mutation + audit insert are atomic)

  type EntityDateQueries = {
    list    : (eid: string) => Promise<unknown[]>;
    findById: (id: string)  => Promise<unknown | null>;
    create  : (eid: string, d: { dateTypeId: string; dateValue: string; notes?: string | null }) => Promise<unknown>;
    update  : (id: string,  d: { dateValue?: string; notes?: string | null }) => Promise<unknown>;
    delete  : (id: string)  => Promise<unknown>;
  };

  function entityDateRoutes<T extends EntityDateQueries>(
    prefix: string,
    entityParam: string,
    parentExists: (eid: string) => Promise<boolean>,
    qf: (client: Prisma.TransactionClient) => T,
  ) {
    const uuidParam = requireUuidParam(entityParam);
    const q = qf(prisma);

    // GET /api/catalog/<prefix>/:entityId/dates
    router.get(`/${prefix}/:${entityParam}/dates`, uuidParam, async (req: Request, res: Response) => {
      try {
        const eid = req.params[entityParam] as string;
        if (!(await parentExists(eid))) { res.status(404).json({ error: 'Not found' }); return; }
        res.json(await q.list(eid));
      } catch (err) { console.error(`[catalog] list ${prefix} dates error:`, err); res.status(500).json({ error: 'Internal server error' }); }
    });

    // POST /api/catalog/<prefix>/:entityId/dates
    router.post(`/${prefix}/:${entityParam}/dates`, requireAdmin, uuidParam, async (req: Request, res: Response) => {
      const parsed = EntityDateCreateSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: parsed.error.errors }); return; }
      try {
        const eid = req.params[entityParam] as string;
        if (!(await parentExists(eid))) { res.status(404).json({ error: 'Not found' }); return; }
        const record = await prisma.$transaction(async (tx) => {
          const created = await qf(tx).create(eid, parsed.data);
          await catalogAudit(tx, `CREATE_${prefix.toUpperCase().replace(/-/g, '_')}_DATE`, prefix, eid, (req as any).user!.email);
          return created;
        });
        res.status(201).json(record);
      } catch (err: any) {
        if (err?.code === 'P2002') { res.status(409).json({ error: 'Date type already set for this entity' }); return; }
        if (err?.code === 'P2003') { res.status(422).json({ error: 'Invalid date type' }); return; }
        console.error(`[catalog] create ${prefix} date error:`, err);
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    // PATCH /api/catalog/<prefix>/:entityId/dates/:dateId
    router.patch(`/${prefix}/:${entityParam}/dates/:dateId`, requireAdmin, uuidParam, requireUuidParam('dateId'), async (req: Request, res: Response) => {
      const parsed = EntityDateUpdateSchema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: parsed.error.errors }); return; }
      try {
        const existing = await q.findById(req.params['dateId'] as string);
        if (!existing) { res.status(404).json({ error: 'Not found' }); return; }
        const record = await prisma.$transaction(async (tx) => {
          const updated = await qf(tx).update(req.params['dateId'] as string, parsed.data);
          await catalogAudit(tx, `UPDATE_${prefix.toUpperCase().replace(/-/g, '_')}_DATE`, prefix, req.params[entityParam] as string, (req as any).user!.email);
          return updated;
        });
        res.json(record);
      } catch (err) { console.error(`[catalog] update ${prefix} date error:`, err); res.status(500).json({ error: 'Internal server error' }); }
    });

    // DELETE /api/catalog/<prefix>/:entityId/dates/:dateId
    router.delete(`/${prefix}/:${entityParam}/dates/:dateId`, requireAdmin, uuidParam, requireUuidParam('dateId'), async (req: Request, res: Response) => {
      try {
        const existing = await q.findById(req.params['dateId'] as string);
        if (!existing) { res.status(404).json({ error: 'Not found' }); return; }
        await prisma.$transaction(async (tx) => {
          await qf(tx).delete(req.params['dateId'] as string);
          await catalogAudit(tx, `DELETE_${prefix.toUpperCase().replace(/-/g, '_')}_DATE`, prefix, req.params[entityParam] as string, (req as any).user!.email);
        });
        res.status(204).send();
      } catch (err) { console.error(`[catalog] delete ${prefix} date error:`, err); res.status(500).json({ error: 'Internal server error' }); }
    });
  }

  entityDateRoutes('cis',               'ciId',  (id) => prisma.cI.findUnique({ where: { id } }).then(Boolean),              ciDateQueries);
  entityDateRoutes('operating-systems', 'osId',  (id) => prisma.operatingSystem.findUnique({ where: { id } }).then(Boolean), osDateQueries);
  entityDateRoutes('base-software',     'bswId', (id) => prisma.baseSoftware.findUnique({ where: { id } }).then(Boolean),    bswDateQueries);
  entityDateRoutes('device-models',     'dmId',  (id) => prisma.deviceModel.findUnique({ where: { id } }).then(Boolean),     dmDateQueries);

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

      const record = await prisma.$transaction(async (tx) => {
        const created = await osQueries(tx).create({
          code           : finalCode,
          name,
          version        : version ?? null,
          manufacturerId : manufacturerId ?? null,
          isSystem       : isSystem ?? false,
        });
        await catalogAudit(tx, 'CREATE_OS', 'OperatingSystem', created.id, (req as any).user!.email);
        return created;
      });
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
      const record = await prisma.$transaction(async (tx) => {
        const updated = await osQueries(tx).update(req.params.id as string, {
          ...(code           !== undefined ? { code: code.toUpperCase() }  : {}),
          ...(name           !== undefined ? { name }                       : {}),
          ...(version        !== undefined ? { version }                    : {}),
          ...(manufacturerId !== undefined ? { manufacturerId }             : {}),
          ...(isSystem       !== undefined ? { isSystem }                   : {}),
        });
        await catalogAudit(tx, 'UPDATE_OS', 'OperatingSystem', updated.id, (req as any).user!.email);
        return updated;
      });
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

      await prisma.$transaction(async (tx) => {
        await osQueries(tx).delete(req.params.id as string);
        await catalogAudit(tx, 'DELETE_OS', 'OperatingSystem', req.params.id as string, (req as any).user!.email);
      });
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

      const record = await prisma.$transaction(async (tx) => {
        const created = await bswQueries(tx).create({
          code           : finalCode,
          name,
          version        : version ?? null,
          manufacturerId : manufacturerId ?? null,
          isSystem       : isSystem ?? false,
        });
        await catalogAudit(tx, 'CREATE_BASE_SOFTWARE', 'BaseSoftware', created.id, (req as any).user!.email);
        return created;
      });
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
      const record = await prisma.$transaction(async (tx) => {
        const updated = await bswQueries(tx).update(req.params.id as string, {
          ...(code           !== undefined ? { code: code.toUpperCase() } : {}),
          ...(name           !== undefined ? { name }                      : {}),
          ...(version        !== undefined ? { version }                   : {}),
          ...(manufacturerId !== undefined ? { manufacturerId }            : {}),
          ...(isSystem       !== undefined ? { isSystem }                  : {}),
        });
        await catalogAudit(tx, 'UPDATE_BASE_SOFTWARE', 'BaseSoftware', updated.id, (req as any).user!.email);
        return updated;
      });
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

      await prisma.$transaction(async (tx) => {
        await bswQueries(tx).delete(req.params.id as string);
        await catalogAudit(tx, 'DELETE_BASE_SOFTWARE', 'BaseSoftware', req.params.id as string, (req as any).user!.email);
      });
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

      await prisma.$transaction(async (tx) => {
        await bswQueries(tx).associate(req.params.ciId as string, parsed.data.baseSoftwareId);
        await catalogAudit(tx, 'ASSOCIATE_BASE_SOFTWARE', 'CI', req.params.ciId as string, (req as any).user!.email);
      });
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
      await prisma.$transaction(async (tx) => {
        await bswQueries(tx).dissociate(req.params.ciId as string, req.params.bswId as string);
        await catalogAudit(tx, 'DISSOCIATE_BASE_SOFTWARE', 'CI', req.params.ciId as string, (req as any).user!.email);
      });
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

  // GET /api/catalog/cis/:ciId/lifecycle-dates
  router.get('/cis/:ciId/lifecycle-dates', requireUuidParam('ciId'), async (req: Request, res: Response) => {
    try {
      const ciId = req.params.ciId as string;
      const ci = await (prisma as any).cI.findUnique({
        where: { id: ciId },
        include: {
          lifecycleDates: { include: { dateType: true } },
          operatingSystem: { include: { lifecycleDates: { include: { dateType: true } } } },
          ciModel: { include: { lifecycleDates: { include: { dateType: true } } } },
          baseSoftwares: {
            include: { baseSoftware: { include: { lifecycleDates: { include: { dateType: true } } } } },
          },
        },
      });
      if (!ci) { res.status(404).json({ error: 'CI not found' }); return; }

      type DateEntry = {
        source: string; entityName?: string;
        dateType: { code: string; name: string; category: string; sortOrder: number };
        dateValue: string; notes: string | null;
      };
      const pushEntry = (entries: DateEntry[], source: string, entityName: string | undefined, d: any) =>
        entries.push({
          source, entityName,
          dateType: { code: d.dateType.code, name: d.dateType.name, category: d.dateType.category, sortOrder: d.dateType.sortOrder },
          dateValue: (d.dateValue as Date).toISOString().slice(0, 10),
          notes: d.notes ?? null,
        });

      const entries: DateEntry[] = [];
      for (const d of ci.lifecycleDates) pushEntry(entries, 'CI', undefined, d);
      if (ci.operatingSystem) {
        const label = ci.operatingSystem.version
          ? `${ci.operatingSystem.name} ${ci.operatingSystem.version}`
          : ci.operatingSystem.name;
        for (const d of ci.operatingSystem.lifecycleDates) pushEntry(entries, 'OperatingSystem', label, d);
      }
      if (ci.ciModel) {
        for (const d of ci.ciModel.lifecycleDates) pushEntry(entries, 'DeviceModel', ci.ciModel.name, d);
      }
      for (const link of ci.baseSoftwares) {
        const label = link.baseSoftware.version
          ? `${link.baseSoftware.name} ${link.baseSoftware.version}`
          : link.baseSoftware.name;
        for (const d of link.baseSoftware.lifecycleDates) pushEntry(entries, 'BaseSoftware', label, d);
      }
      entries.sort((a, b) => a.dateType.sortOrder - b.dateType.sortOrder || a.dateValue.localeCompare(b.dateValue));
      res.json(entries);
    } catch (err) {
      console.error('[catalog] lifecycle-dates error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
