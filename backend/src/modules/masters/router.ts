import { Router, Request, Response } from 'express';
import { PrismaClient }               from '@prisma/client';
import { createAuthenticateToken }    from '../../shared/middleware/authenticate.js';
import { requireAdmin }               from '../../shared/middleware/requireAdmin.js';
import { requireUuidParam }           from '../../shared/middleware/requireUuidParam.js';
import { lookupEolWithFallbacks, fetchProductCycles } from '../../services/eolService.js';
import { LicenseMasterSchema, isoDateOrNull }         from './schemas.js';

type MasterRow = { id: string; name: string; [k: string]: unknown };

const POPULAR_MANUFACTURERS = [
  'Dell','HP','HPE','Cisco','IBM','Lenovo','Apple','Microsoft','Intel','AMD',
  'Nvidia','NetApp','EMC','Oracle','Sun Microsystems','Juniper Networks',
  'Aruba Networks','Fortinet','Palo Alto Networks','VMware',
  'Red Hat','Canonical','Google','Amazon Web Services','Huawei',
  'Samsung','Sophos','Check Point','F5 Networks','Broadcom',
];

export function createMastersRouter(prisma: PrismaClient): Router {
  const router = Router();
  const authenticateToken = createAuthenticateToken(prisma);

  // ── Sync Catalog ──────────────────────────────────────────────────────────────

  router.post('/sync-catalog', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
    const { action, query } = req.body as { action?: string; query?: string };

    if (action === 'sync-manufacturers') {
      let created = 0; let skipped = 0; let errors = 0;
      const errorLog: string[] = [];
      for (const name of POPULAR_MANUFACTURERS) {
        try {
          const r = await prisma.$executeRaw`
            INSERT INTO "manufacturers"(id, name, created_at, updated_at)
            VALUES(gen_random_uuid(), ${name}, now(), now())
            ON CONFLICT (name) DO NOTHING
          `;
          if (Number(r) > 0) { created++; } else { skipped++; }
        } catch (e) {
          errors++;
          errorLog.push(`${name}: ${String(e).slice(0, 80)}`);
          console.error(`[sync-manufacturers] Error inserting "${name}":`, e);
        }
      }
      console.info(`[sync-manufacturers] created=${created}, skipped=${skipped}, errors=${errors}`);
      res.json({ message: `${created} insertados, ${skipped} ya existían, ${errors} errores`, created, skipped, errors });
      return;
    }

    if (action === 'search') {
      if (!query?.trim()) { res.status(400).json({ error: 'query is required' }); return; }
      const slug   = query.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 60);
      const cycles = await fetchProductCycles(slug).catch(() => null);
      if (!cycles) {
        res.json({ product: slug, cycles: [], found: false, message: `"${query}" no encontrado en endoflife.date` });
        return;
      }
      res.json({ product: slug, cycles, found: true });
      return;
    }

    res.status(400).json({ error: 'action must be "sync-manufacturers" or "search"' });
  });

  // ── Manufacturers ─────────────────────────────────────────────────────────────

  router.get('/manufacturers/debug', authenticateToken, requireAdmin, async (_req, res) => {
    try {
      const rows  = await prisma.$queryRaw<{ id: string; name: string }[]>`SELECT id::text, name FROM "manufacturers" ORDER BY name ASC`;
      const count = await prisma.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*) AS c FROM "manufacturers"`;
      res.json({ count: Number(count[0]?.c ?? 0), rows });
    } catch (e) { res.status(500).json({ error: 'Internal server error' }); }
  });

  router.delete('/manufacturers/all', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
    try {
      const n = await prisma.$transaction(async (tx) => {
        const affected = await tx.$executeRaw`DELETE FROM "manufacturers"`;
        await tx.$executeRaw`
          INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, details, created_at)
          VALUES(gen_random_uuid(), 'DELETE_ALL_MASTER', 'Manufacturer', '00000000-0000-0000-0000-000000000000'::uuid, ${req.user!.email},
                 ${JSON.stringify({ deleted: Number(affected) })}::jsonb, now())`;
        return affected;
      });
      res.json({ deleted: Number(n), message: `${Number(n)} fabricante(s) eliminados` });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  router.get('/manufacturers', authenticateToken, async (_req, res) => {
    try {
      const rows = await prisma.$queryRaw<MasterRow[]>`SELECT id::text AS id, name FROM "manufacturers" ORDER BY name ASC`;
      console.info(`[GET /api/masters/manufacturers] rows=${rows.length}`);
      res.json(rows);
    } catch (e) { console.error('[GET /api/masters/manufacturers]', e); res.status(500).json({ error: 'Internal server error' }); }
  });

  router.post('/manufacturers', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
    const { name } = req.body as { name?: string };
    if (!name?.trim()) { res.status(400).json({ error: 'name required' }); return; }
    try {
      const rows = await prisma.$queryRaw<MasterRow[]>`
        INSERT INTO "manufacturers"(id,name,created_at,updated_at)
        VALUES(gen_random_uuid(),${name.trim()},now(),now()) RETURNING id::text AS id, name`;
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CREATE_MASTER','Manufacturer',${rows[0].id}::uuid,${req.user!.email},now())`;
      res.status(201).json(rows[0]);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  router.patch('/manufacturers/:id', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const { name } = req.body as { name?: string };
    if (!name?.trim()) { res.status(400).json({ error: 'name required' }); return; }
    try {
      const rows = await prisma.$queryRaw<MasterRow[]>`
        UPDATE "manufacturers" SET name=${name.trim()}, updated_at=now()
        WHERE id=${req.params.id}::uuid RETURNING id::text AS id, name`;
      if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'UPDATE_MASTER','Manufacturer',${rows[0].id}::uuid,${req.user!.email},now())`;
      res.json(rows[0]);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  router.delete('/manufacturers/:id', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    try {
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'DELETE_MASTER','Manufacturer',${req.params.id}::uuid,${req.user!.email},now())`;
      await prisma.$executeRaw`DELETE FROM "manufacturers" WHERE id=${req.params.id}::uuid`;
      res.json({ ok: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  // ── Support Areas ─────────────────────────────────────────────────────────────

  router.get('/support-areas', authenticateToken, async (_req, res) => {
    try {
      const rows = await prisma.$queryRaw<MasterRow[]>`SELECT id::text AS id, name FROM "support_areas" ORDER BY name ASC`;
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  router.post('/support-areas', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
    const { name } = req.body as { name?: string };
    if (!name?.trim()) { res.status(400).json({ error: 'name required' }); return; }
    try {
      const rows = await prisma.$queryRaw<MasterRow[]>`
        INSERT INTO "support_areas"(id,name,created_at,updated_at)
        VALUES(gen_random_uuid(),${name.trim()},now(),now()) RETURNING id::text AS id, name`;
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CREATE_MASTER','SupportArea',${rows[0].id}::uuid,${req.user!.email},now())`;
      res.status(201).json(rows[0]);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  router.patch('/support-areas/:id', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const { name } = req.body as { name?: string };
    if (!name?.trim()) { res.status(400).json({ error: 'name required' }); return; }
    try {
      const rows = await prisma.$queryRaw<MasterRow[]>`
        UPDATE "support_areas" SET name=${name.trim()}, updated_at=now()
        WHERE id=${req.params.id}::uuid RETURNING id::text AS id, name`;
      if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'UPDATE_MASTER','SupportArea',${rows[0].id}::uuid,${req.user!.email},now())`;
      res.json(rows[0]);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  router.delete('/support-areas/:id', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    try {
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'DELETE_MASTER','SupportArea',${req.params.id}::uuid,${req.user!.email},now())`;
      await prisma.$executeRaw`DELETE FROM "support_areas" WHERE id=${req.params.id}::uuid`;
      res.json({ ok: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  // ── Branches ──────────────────────────────────────────────────────────────────

  router.get('/branches', authenticateToken, async (_req, res) => {
    try {
      const rows = await prisma.$queryRaw<(MasterRow & { branch_code: string; physical_address: string | null; support_area_id: string; support_area_name: string })[]>`
        SELECT b.id::text AS id, b.name, b.branch_code, b.physical_address, b.support_area_id::text AS support_area_id, sa.name AS support_area_name
        FROM "branches" b LEFT JOIN "support_areas" sa ON b.support_area_id = sa.id ORDER BY b.name ASC`;
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  router.post('/branches', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
    const { name, branchCode, physicalAddress, supportAreaId } = req.body as { name?: string; branchCode?: string; physicalAddress?: string; supportAreaId?: string };
    if (!name?.trim() || !branchCode?.trim() || !supportAreaId) { res.status(400).json({ error: 'name, branchCode, supportAreaId required' }); return; }
    try {
      const rows = await prisma.$queryRaw<MasterRow[]>`
        INSERT INTO "branches"(id,name,branch_code,physical_address,support_area_id,created_at,updated_at)
        VALUES(gen_random_uuid(),${name.trim()},${branchCode.trim()},${physicalAddress || null},${supportAreaId}::uuid,now(),now())
        RETURNING id::text AS id, name`;
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CREATE_MASTER','Branch',${rows[0].id}::uuid,${req.user!.email},now())`;
      res.status(201).json(rows[0]);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  router.patch('/branches/:id', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const { name, branchCode, physicalAddress, supportAreaId } = req.body as { name?: string; branchCode?: string; physicalAddress?: string; supportAreaId?: string };
    if (!name?.trim() || !branchCode?.trim() || !supportAreaId) { res.status(400).json({ error: 'name, branchCode, supportAreaId required' }); return; }
    try {
      const rows = await prisma.$queryRaw<MasterRow[]>`
        UPDATE "branches" SET name=${name.trim()}, branch_code=${branchCode.trim()}, physical_address=${physicalAddress || null}, support_area_id=${supportAreaId}::uuid, updated_at=now()
        WHERE id=${req.params.id}::uuid RETURNING id::text AS id, name`;
      if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'UPDATE_MASTER','Branch',${rows[0].id}::uuid,${req.user!.email},now())`;
      res.json(rows[0]);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  router.delete('/branches/:id', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    try {
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'DELETE_MASTER','Branch',${req.params.id}::uuid,${req.user!.email},now())`;
      await prisma.$executeRaw`DELETE FROM "branches" WHERE id=${req.params.id}::uuid`;
      res.json({ ok: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  // ── Device Models ─────────────────────────────────────────────────────────────

  router.get('/device-models', authenticateToken, async (_req, res) => {
    try {
      const rows = await prisma.$queryRaw<(MasterRow & { manufacturer_id: string; manufacturer_name: string; eol_date: Date | null; eos_date: Date | null })[]>`
        SELECT dm.id::text AS id, dm.name, dm.manufacturer_id::text AS manufacturer_id, m.name AS manufacturer_name,
               dm.eol_date, dm.eos_date
        FROM "device_models" dm LEFT JOIN "manufacturers" m ON dm.manufacturer_id = m.id ORDER BY m.name, dm.name`;
      res.json(rows.map(r => ({
        ...r,
        eolDate: r.eol_date ? r.eol_date.toISOString().slice(0, 10) : null,
        eosDate: r.eos_date ? r.eos_date.toISOString().slice(0, 10) : null,
      })));
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  router.post('/device-models', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
    const { name, manufacturerId, eolDate, eosDate } = req.body as { name?: string; manufacturerId?: string; eolDate?: unknown; eosDate?: unknown };
    if (!name?.trim() || !manufacturerId) { res.status(400).json({ error: 'name, manufacturerId required' }); return; }
    const eol = isoDateOrNull(eolDate);
    const eos = isoDateOrNull(eosDate);
    try {
      const rows = await prisma.$queryRaw<MasterRow[]>`
        INSERT INTO "device_models"(id,name,manufacturer_id,eol_date,eos_date,created_at,updated_at)
        VALUES(gen_random_uuid(),${name.trim()},${manufacturerId}::uuid,${eol},${eos},now(),now())
        RETURNING id::text AS id, name`;
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CREATE_MASTER','DeviceModel',${rows[0].id}::uuid,${req.user!.email},now())`;
      res.status(201).json(rows[0]);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  router.patch('/device-models/:id', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const { name, manufacturerId } = req.body as { name?: string; manufacturerId?: string };
    if (!name?.trim() || !manufacturerId) { res.status(400).json({ error: 'name, manufacturerId required' }); return; }
    try {
      const rows = await prisma.$queryRaw<MasterRow[]>`
        UPDATE "device_models" SET name=${name.trim()}, manufacturer_id=${manufacturerId}::uuid, updated_at=now()
        WHERE id=${req.params.id}::uuid RETURNING id::text AS id, name`;
      if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'UPDATE_MASTER','DeviceModel',${rows[0].id}::uuid,${req.user!.email},now())`;
      res.json(rows[0]);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  router.delete('/device-models/:id', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    try {
      const usage = await prisma.$queryRaw<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM "configuration_items" WHERE ci_model_id=${req.params.id}::uuid`;
      const inUse = Number(usage[0]?.count ?? 0);
      if (inUse > 0) { res.status(409).json({ error: `Cannot delete: in use by ${inUse} CI(s)` }); return; }
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'DELETE_MASTER','DeviceModel',${req.params.id}::uuid,${req.user!.email},now())`;
      await prisma.$executeRaw`DELETE FROM "device_models" WHERE id=${req.params.id}::uuid`;
      res.json({ ok: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  router.post('/device-models/:id/sync-eol', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const id = req.params.id as string;
    try {
      type ModelRow = { id: string; name: string; manufacturer_name: string };
      const rows = await prisma.$queryRaw<ModelRow[]>`
        SELECT dm.id, dm.name, m.name AS manufacturer_name
        FROM "device_models" dm LEFT JOIN "manufacturers" m ON dm.manufacturer_id = m.id
        WHERE dm.id = ${id}::uuid LIMIT 1
      `;
      if (rows.length === 0) { res.status(404).json({ error: 'Model not found' }); return; }

      const model   = rows[0];
      const eolInfo = await lookupEolWithFallbacks(
        [model.name, `${model.manufacturer_name} ${model.name}`, model.manufacturer_name].filter(Boolean)
      ).catch(() => null);

      if (!eolInfo?.eolDate && !eolInfo?.supportDate) {
        res.json({ message: `No EOL data found for "${model.name}" on endoflife.date`, updated: 0 });
        return;
      }

      if (eolInfo.eolDate || eolInfo.supportDate) {
        await prisma.$executeRaw`
          UPDATE "device_models"
          SET eol_date = COALESCE(${eolInfo.eolDate ?? null}::timestamp, eol_date),
              eos_date = COALESCE(${eolInfo.supportDate ?? null}::timestamp, eos_date),
              updated_at = now()
          WHERE id = ${id}::uuid
        `;
        await prisma.$executeRaw`
          INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at)
          VALUES(gen_random_uuid(),'UPDATE_MASTER','DeviceModel',${id}::uuid,${req.user!.email},now())
        `;
      }

      let updated = 0;
      if (eolInfo.eolDate) {
        const r = await prisma.$executeRaw`
          UPDATE "configuration_items" SET eol_date = ${eolInfo.eolDate}, updated_at = now()
          WHERE ci_model_id = ${id}::uuid AND eol_date IS NULL
        `;
        updated = Number(r);
      }
      if (eolInfo.supportDate) {
        await prisma.$executeRaw`
          UPDATE "configuration_items" SET eos_date = ${eolInfo.supportDate}, updated_at = now()
          WHERE ci_model_id = ${id}::uuid AND eos_date IS NULL
        `;
      }

      res.json({
        message:     `EOL sync complete for model "${model.name}"`,
        eolDate:     eolInfo.eolDate,
        supportDate: eolInfo.supportDate,
        updated,
      });
    } catch (error) {
      console.error('[POST /api/masters/device-models/:id/sync-eol] Error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Cost Centers ──────────────────────────────────────────────────────────────

  router.get('/cost-centers', authenticateToken, async (_req, res) => {
    try {
      const rows = await prisma.$queryRaw<{ id: string; code: string; name: string }[]>`
        SELECT id::text AS id, code, name FROM "cost_centers" ORDER BY code ASC`;
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  router.post('/cost-centers', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
    const { code, name } = req.body as { code?: string; name?: string };
    if (!code?.trim() || !name?.trim()) { res.status(400).json({ error: 'code and name required' }); return; }
    try {
      const rows = await prisma.$queryRaw<{ id: string; code: string; name: string }[]>`
        INSERT INTO "cost_centers"(id,code,name,created_at,updated_at)
        VALUES(gen_random_uuid(),${code.trim()},${name.trim()},now(),now())
        RETURNING id::text AS id, code, name`;
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CREATE_MASTER','CostCenter',${rows[0].id}::uuid,${req.user!.email},now())`;
      res.status(201).json(rows[0]);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('unique') || msg.includes('duplicate')) { res.status(409).json({ error: 'El código ya existe' }); return; }
      console.error(e);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.patch('/cost-centers/:id', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const { code, name } = req.body as { code?: string; name?: string };
    if (!code?.trim() || !name?.trim()) { res.status(400).json({ error: 'code and name required' }); return; }
    try {
      const rows = await prisma.$queryRaw<{ id: string; code: string; name: string }[]>`
        UPDATE "cost_centers" SET code=${code.trim()}, name=${name.trim()}, updated_at=now()
        WHERE id=${req.params.id}::uuid RETURNING id::text AS id, code, name`;
      if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'UPDATE_MASTER','CostCenter',${rows[0].id}::uuid,${req.user!.email},now())`;
      res.json(rows[0]);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('unique') || msg.includes('duplicate')) { res.status(409).json({ error: 'El código ya existe' }); return; }
      console.error(e);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/cost-centers/:id', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    try {
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'DELETE_MASTER','CostCenter',${req.params.id}::uuid,${req.user!.email},now())`;
      await prisma.$executeRaw`DELETE FROM "cost_centers" WHERE id=${req.params.id}::uuid`;
      res.json({ ok: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  // ── CI Type Categories (read-only, fixed) ─────────────────────────────────────

  router.get('/ci-type-categories', authenticateToken, async (_req, res) => {
    try {
      const cats = await prisma.cITypeCategory.findMany({
        orderBy: { sortOrder: 'asc' },
        include: {
          ciTypes: {
            orderBy: { sortOrder: 'asc' },
            select: { id: true, code: true, name: true, sortOrder: true, isSystem: true },
          },
        },
      });
      res.json(cats);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  // ── CI Types CRUD ─────────────────────────────────────────────────────────────

  router.get('/ci-types', authenticateToken, async (_req, res) => {
    try {
      const types = await prisma.cIType.findMany({
        orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }],
        select: { id: true, code: true, name: true, categoryCode: true, sortOrder: true, isSystem: true },
      });
      res.json(types);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  router.post('/ci-types', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
    const { code, name, categoryCode, sortOrder } = req.body as { code?: string; name?: string; categoryCode?: string; sortOrder?: number };
    if (!name?.trim() || !categoryCode?.trim()) {
      res.status(400).json({ error: 'name and categoryCode are required' }); return;
    }
    try {
      let finalCode: string;
      if (code?.trim()) {
        finalCode = code.trim().toUpperCase();
      } else {
        const baseCode = name.trim().toUpperCase().replace(/[^A-Z0-9]/g, '_');
        const existing = await prisma.cIType.findMany({
          where: { code: { startsWith: baseCode } },
          select: { code: true },
        });
        const existingCodes = new Set(existing.map(r => r.code));
        finalCode = baseCode;
        let suffix = 1;
        while (existingCodes.has(finalCode)) { finalCode = `${baseCode}_${suffix++}`; }
      }
      const row = await prisma.cIType.create({
        data: { code: finalCode, name: name.trim(), categoryCode: categoryCode.trim(), sortOrder: sortOrder ?? 50, isSystem: false },
        select: { id: true, code: true, name: true, categoryCode: true, sortOrder: true, isSystem: true },
      });
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CREATE_MASTER','CIType',${row.id}::uuid,${req.user!.email},now())`;
      res.status(201).json(row);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('unique') || msg.includes('Unique')) { res.status(409).json({ error: 'El código ya existe' }); return; }
      console.error(e);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.patch('/ci-types/:id', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const { name, categoryCode, sortOrder } = req.body as { name?: string; categoryCode?: string; sortOrder?: number };
    if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return; }
    const id = String(req.params.id);
    try {
      const row = await prisma.cIType.update({
        where: { id },
        data: { name: name.trim(), ...(categoryCode && { categoryCode }), ...(sortOrder !== undefined && { sortOrder }) },
        select: { id: true, code: true, name: true, categoryCode: true, sortOrder: true, isSystem: true },
      });
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'UPDATE_MASTER','CIType',${row.id}::uuid,${req.user!.email},now())`;
      res.json(row);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  router.delete('/ci-types/:id', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const id = String(req.params.id);
    try {
      const row = await prisma.cIType.findUnique({ where: { id }, select: { code: true } });
      if (!row) { res.status(404).json({ error: 'Tipo no encontrado' }); return; }
      const ciCount = await prisma.cI.count({ where: { ciTypeId: id } });
      if (ciCount > 0) {
        res.status(409).json({ error: `No se puede eliminar: ${ciCount} CI${ciCount > 1 ? 's' : ''} tienen este tipo asignado` });
        return;
      }
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'DELETE_MASTER','CIType',${id}::uuid,${req.user!.email},now())`;
      await prisma.cIType.delete({ where: { id } });
      res.json({ ok: true });
    } catch (e: unknown) {
      console.error(e);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Document Types ────────────────────────────────────────────────────────────

  router.get('/document-types', authenticateToken, async (_req, res) => {
    try {
      const rows = await prisma.$queryRaw<{ id: string; code: string; name: string; isSystem: boolean }[]>`
        SELECT id::text AS id, code, name, is_system AS "isSystem" FROM "document_types" ORDER BY name ASC`;
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  router.post('/document-types', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
    const { code, name } = req.body as { code?: string; name?: string };
    if (!code?.trim() || !name?.trim()) { res.status(400).json({ error: 'code and name required' }); return; }
    try {
      const rows = await prisma.$queryRaw<{ id: string; code: string; name: string }[]>`
        INSERT INTO "document_types"(id,code,name,is_system,created_at,updated_at)
        VALUES(gen_random_uuid(),${code.trim().toUpperCase()},${name.trim()},false,now(),now())
        RETURNING id::text AS id, code, name`;
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CREATE_MASTER','DocumentType',${rows[0].id}::uuid,${req.user!.email},now())`;
      res.status(201).json(rows[0]);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  router.patch('/document-types/:id', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const { name } = req.body as { name?: string };
    if (!name?.trim()) { res.status(400).json({ error: 'name required' }); return; }
    try {
      const rows = await prisma.$queryRaw<{ id: string; code: string; name: string }[]>`
        UPDATE "document_types" SET name=${name.trim()}, updated_at=now()
        WHERE id=${req.params.id}::uuid AND is_system=false
        RETURNING id::text AS id, code, name`;
      if (!rows.length) { res.status(404).json({ error: 'Not found or system type' }); return; }
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'UPDATE_MASTER','DocumentType',${rows[0].id}::uuid,${req.user!.email},now())`;
      res.json(rows[0]);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  router.delete('/document-types/:id', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    try {
      const result = await prisma.$executeRaw`
        DELETE FROM "document_types" WHERE id=${req.params.id}::uuid AND is_system=false`;
      if (Number(result) === 0) { res.status(404).json({ error: 'Not found or system type' }); return; }
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'DELETE_MASTER','DocumentType',${req.params.id}::uuid,${req.user!.email},now())`;
      res.json({ ok: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  // ── License Metric Categories ─────────────────────────────────────────────────

  router.get('/license-metric-categories', authenticateToken, async (_req, res) => {
    try {
      const rows = await prisma.$queryRaw<{
        code: string; name: string; sortOrder: number;
        metricId: string | null; metricCode: string | null; metricName: string | null;
        metricDescription: string | null; metricIsSystem: boolean | null;
      }[]>`
        SELECT lmc.code, lmc.name, lmc.sort_order AS "sortOrder",
               lm.id::text AS "metricId", lm.code AS "metricCode", lm.name AS "metricName",
               lm.description AS "metricDescription", lm.is_system AS "metricIsSystem"
        FROM "license_metric_categories" lmc
        LEFT JOIN "license_metrics" lm ON lm.category_code = lmc.code
        ORDER BY lmc.sort_order ASC, lm.name ASC`;
      const map = new Map<string, { code: string; name: string; sortOrder: number; metrics: object[] }>();
      for (const r of rows) {
        if (!map.has(r.code)) map.set(r.code, { code: r.code, name: r.name, sortOrder: r.sortOrder, metrics: [] });
        if (r.metricId) {
          map.get(r.code)!.metrics.push({
            id: r.metricId, code: r.metricCode, name: r.metricName,
            description: r.metricDescription, isSystem: r.metricIsSystem,
          });
        }
      }
      res.json([...map.values()]);
    } catch (e) { res.status(500).json({ error: 'Failed to fetch license metric categories' }); }
  });

  // ── License Metrics ───────────────────────────────────────────────────────────

  router.get('/license-metrics', authenticateToken, async (_req, res) => {
    try {
      const rows = await prisma.$queryRaw<{
        id: string; code: string; name: string; categoryCode: string;
        description: string | null; isSystem: boolean;
      }[]>`
        SELECT id::text AS id, code, name, category_code AS "categoryCode",
               description, is_system AS "isSystem"
        FROM "license_metrics" ORDER BY name ASC`;
      res.json(rows);
    } catch (e) { res.status(500).json({ error: 'Failed to fetch license metrics' }); }
  });

  router.post('/license-metrics', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
    const parsed = LicenseMasterSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'code, name and categoryCode are required' }); return; }
    const { code, name, categoryCode, description } = parsed.data;
    try {
      const rows = await prisma.$queryRaw<{ id: string; code: string; name: string }[]>`
        INSERT INTO "license_metrics"(id, code, name, category_code, description, is_system, created_at, updated_at)
        VALUES(gen_random_uuid(), ${code.trim().toUpperCase()}, ${name.trim()}, ${categoryCode.trim()}, ${description ?? null}, false, now(), now())
        RETURNING id::text AS id, code, name`;
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CREATE_MASTER','LicenseMetric',${rows[0].id}::uuid,${req.user!.email},now())`;
      res.status(201).json(rows[0]);
    } catch (e) { res.status(500).json({ error: 'Failed to create license metric' }); }
  });

  router.patch('/license-metrics/:id', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const { name, description } = req.body as { name?: string; description?: string };
    if (!name?.trim()) { res.status(400).json({ error: 'name required' }); return; }
    const id = req.params.id as string;
    try {
      const rows = await prisma.$queryRaw<{ id: string; code: string; name: string; isSystem: boolean }[]>`
        UPDATE "license_metrics"
        SET name = ${name.trim()}, description = ${description ?? null}, updated_at = now()
        WHERE id = ${id}::uuid
        RETURNING id::text AS id, code, name, is_system AS "isSystem"`;
      if (!rows.length) { res.status(404).json({ error: 'License metric not found' }); return; }
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'UPDATE_MASTER','LicenseMetric',${rows[0].id}::uuid,${req.user!.email},now())`;
      res.json(rows[0]);
    } catch (e) { res.status(500).json({ error: 'Failed to update license metric' }); }
  });

  router.delete('/license-metrics/:id', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const id = req.params.id as string;
    try {
      const used = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count FROM "licenses" WHERE license_metric_id = ${id}::uuid`;
      if (Number(used[0]?.count ?? 0) > 0) {
        res.status(409).json({ error: 'No se puede eliminar: existen licencias que utilizan esta métrica' });
        return;
      }
      const result = await prisma.$executeRaw`DELETE FROM "license_metrics" WHERE id = ${id}::uuid`;
      if (Number(result) === 0) { res.status(404).json({ error: 'License metric not found' }); return; }
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'DELETE_MASTER','LicenseMetric',${id}::uuid,${req.user!.email},now())`;
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Failed to delete license metric' }); }
  });

  // ── License Type Categories ───────────────────────────────────────────────────

  router.get('/license-type-categories', authenticateToken, async (_req, res) => {
    try {
      const rows = await prisma.$queryRaw<{
        code: string; name: string; sortOrder: number;
        typeId: string | null; typeCode: string | null; typeName: string | null;
        typeDescription: string | null; typeIsSystem: boolean | null;
      }[]>`
        SELECT ltc.code, ltc.name, ltc.sort_order AS "sortOrder",
               lt.id::text AS "typeId", lt.code AS "typeCode", lt.name AS "typeName",
               lt.description AS "typeDescription", lt.is_system AS "typeIsSystem"
        FROM "license_type_categories" ltc
        LEFT JOIN "license_types" lt ON lt.category_code = ltc.code
        ORDER BY ltc.sort_order ASC, lt.name ASC`;
      const map = new Map<string, { code: string; name: string; sortOrder: number; types: object[] }>();
      for (const r of rows) {
        if (!map.has(r.code)) map.set(r.code, { code: r.code, name: r.name, sortOrder: r.sortOrder, types: [] });
        if (r.typeId) {
          map.get(r.code)!.types.push({
            id: r.typeId, code: r.typeCode, name: r.typeName,
            description: r.typeDescription, isSystem: r.typeIsSystem,
          });
        }
      }
      res.json([...map.values()]);
    } catch (e) { res.status(500).json({ error: 'Failed to fetch license type categories' }); }
  });

  // ── License Types ─────────────────────────────────────────────────────────────

  router.get('/license-types', authenticateToken, async (_req, res) => {
    try {
      const rows = await prisma.$queryRaw<{
        id: string; code: string; name: string; categoryCode: string;
        description: string | null; isSystem: boolean;
      }[]>`
        SELECT id::text AS id, code, name, category_code AS "categoryCode",
               description, is_system AS "isSystem"
        FROM "license_types" ORDER BY name ASC`;
      res.json(rows);
    } catch (e) { res.status(500).json({ error: 'Failed to fetch license types' }); }
  });

  router.post('/license-types', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
    const parsed = LicenseMasterSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'code, name and categoryCode are required' }); return; }
    const { code, name, categoryCode, description } = parsed.data;
    try {
      const rows = await prisma.$queryRaw<{ id: string; code: string; name: string }[]>`
        INSERT INTO "license_types"(id, code, name, category_code, description, is_system, created_at, updated_at)
        VALUES(gen_random_uuid(), ${code.trim().toUpperCase()}, ${name.trim()}, ${categoryCode.trim()}, ${description ?? null}, false, now(), now())
        RETURNING id::text AS id, code, name`;
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CREATE_MASTER','LicenseType',${rows[0].id}::uuid,${req.user!.email},now())`;
      res.status(201).json(rows[0]);
    } catch (e) { res.status(500).json({ error: 'Failed to create license type' }); }
  });

  router.patch('/license-types/:id', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const { name, description } = req.body as { name?: string; description?: string };
    if (!name?.trim()) { res.status(400).json({ error: 'name required' }); return; }
    const id = req.params.id as string;
    try {
      const rows = await prisma.$queryRaw<{ id: string; code: string; name: string; isSystem: boolean }[]>`
        UPDATE "license_types"
        SET name = ${name.trim()}, description = ${description ?? null}, updated_at = now()
        WHERE id = ${id}::uuid
        RETURNING id::text AS id, code, name, is_system AS "isSystem"`;
      if (!rows.length) { res.status(404).json({ error: 'License type not found' }); return; }
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'UPDATE_MASTER','LicenseType',${rows[0].id}::uuid,${req.user!.email},now())`;
      res.json(rows[0]);
    } catch (e) { res.status(500).json({ error: 'Failed to update license type' }); }
  });

  router.delete('/license-types/:id', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const id = req.params.id as string;
    try {
      const used = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)::bigint AS count FROM "licenses" WHERE license_type_id = ${id}::uuid`;
      if (Number(used[0]?.count ?? 0) > 0) {
        res.status(409).json({ error: 'No se puede eliminar: existen licencias que utilizan este tipo' });
        return;
      }
      const result = await prisma.$executeRaw`DELETE FROM "license_types" WHERE id = ${id}::uuid`;
      if (Number(result) === 0) { res.status(404).json({ error: 'License type not found' }); return; }
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'DELETE_MASTER','LicenseType',${id}::uuid,${req.user!.email},now())`;
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Failed to delete license type' }); }
  });

  return router;
}
