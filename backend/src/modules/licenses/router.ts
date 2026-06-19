import { Router, Request, Response } from 'express';
import { PrismaClient, Prisma }       from '@prisma/client';
import { z }                           from 'zod';
import { createAuthenticateToken }    from '../../shared/middleware/authenticate.js';
import { requireAdmin }               from '../../shared/middleware/requireAdmin.js';
import { requireUuidParam }           from '../../shared/middleware/requireUuidParam.js';
import { docVisibilitySqlCol }        from '../../shared/utils/docVisibility.js';
import { getLicenseRoot }             from '../../services/entitySerializer.js';
import { emitHook }                   from '../plugins/index.js';
import { LicenseSchema, LicenseUserSchema } from './schemas.js';

export function createLicensesRouter(
  prisma: PrismaClient,
  queueForIndexing: (entityType: string, entityId: string) => void | Promise<void>,
  purgeFromRag: (entityType: string, entityId: string) => Promise<void>,
): Router {
  const router = Router();
  const authenticateToken = createAuthenticateToken(prisma);

  const LICENSES_MAX_PAGE_SIZE = 250;

  // GET /api/licenses — list all licenses (summary with vendor, type, metric, counts)
  router.get('/', authenticateToken, async (req: Request, res: Response) => {
    const rawLimit = parseInt(String(req.query.limit ?? '200'), 10);
    const limit    = Math.min(isNaN(rawLimit) || rawLimit < 1 ? 200 : rawLimit, LICENSES_MAX_PAGE_SIZE);
    const rawPage  = parseInt(String(req.query.page  ?? '1'),   10);
    const page     = isNaN(rawPage) || rawPage < 1 ? 1 : rawPage;
    const offset   = (page - 1) * limit;
    try {
      type LicenseRow = {
        id: string; name: string; licenseNumber: string; startDate: Date; endDate: Date | null;
        status: string | null; currency: string | null; cost: string | null;
        vendorName: string | null; licenseTypeName: string | null; licenseMetricName: string | null;
        ciCount: bigint; addendumCount: bigint;
      };
      const [countRows, rows] = await Promise.all([
        prisma.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*) AS c FROM "licenses" WHERE parent_license_id IS NULL`,
        prisma.$queryRaw<LicenseRow[]>`
          SELECT
            l.id::text AS id, l.name,
            l.license_number AS "licenseNumber",
            l.start_date AS "startDate", l.end_date AS "endDate",
            l.status, l.currency, l.cost::text AS cost,
            v.name AS "vendorName",
            lt.name AS "licenseTypeName",
            lm.name AS "licenseMetricName",
            (SELECT COUNT(*) FROM "_LicenseToCI" lci WHERE lci."A" = l.id) AS "ciCount",
            (SELECT COUNT(*) FROM "licenses" al WHERE al.parent_license_id = l.id) AS "addendumCount"
          FROM "licenses" l
          LEFT JOIN "vendors" v ON v.id = l.vendor_id
          LEFT JOIN "license_types" lt ON lt.id = l.license_type_id
          LEFT JOIN "license_metrics" lm ON lm.id = l.license_metric_id
          ORDER BY l.created_at DESC
          LIMIT ${limit} OFFSET ${offset}`,
      ]);
      res.json({
        total: Number(countRows[0]?.c ?? 0), page, limit,
        data: rows.map((r) => ({ ...r, ciCount: Number(r.ciCount), addendumCount: Number(r.addendumCount), cost: r.cost ? parseFloat(r.cost) : null })),
      });
    } catch (e) { res.status(500).json({ error: 'Failed to fetch licenses' }); }
  });

  // GET /api/licenses/:id — license detail with all relations
  router.get('/:id', authenticateToken, requireUuidParam('id'), async (req: Request, res: Response) => {
    const id = req.params.id as string;
    try {
      const license = await prisma.license.findUnique({
        where: { id },
        include: {
          vendor:        true,
          licenseType:   true,
          licenseMetric: true,
          cis:           { select: { id: true, name: true, apiSlug: true, environment: true, criticality: true } },
          licenseUsers:  { orderBy: { createdAt: 'asc' } },
          addendums:     { select: { id: true, name: true, licenseNumber: true, status: true, startDate: true, endDate: true } },
          parentLicense: { select: { id: true, name: true, licenseNumber: true } },
        },
      });
      if (!license) { res.status(404).json({ error: 'License not found' }); return; }
      const docs = await prisma.$queryRaw<{
        id: string; title: string; documentTypeName: string; documentTypeCode: string;
        originalName: string; versionNumber: number; uploadedBy: string;
        createdAt: Date; latestVersionId: string; mimeType: string;
      }[]>`
        SELECT d.id::text AS id, d.title, dt.name AS "documentTypeName", dt.code AS "documentTypeCode",
               COALESCE(v.original_name, d.original_name) AS "originalName",
               COALESCE(v.version_number, d.version_number) AS "versionNumber",
               COALESCE(v.uploaded_by, d.uploaded_by) AS "uploadedBy",
               d.created_at AS "createdAt",
               COALESCE(v.id::text, d.id::text) AS "latestVersionId",
               COALESCE(v.mime_type, d.mime_type) AS "mimeType"
        FROM "document_licenses" dl
        JOIN "documents" d ON dl.document_id = d.id
        JOIN "document_types" dt ON d.document_type_id = dt.id
        LEFT JOIN "documents" v ON v.root_id = d.id AND v.is_latest = true
        WHERE dl.license_id = ${id}::uuid AND d.root_id IS NULL
        ORDER BY d.created_at DESC`;
      res.json({ ...license, documents: docs });
    } catch (e) { res.status(500).json({ error: 'Failed to fetch license' }); }
  });

  // POST /api/licenses — create a license
  router.post('/', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
    const parsed = LicenseSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid license data', details: parsed.error.flatten() }); return; }
    const d = parsed.data;
    try {
      const preHook = await emitHook('preCreateLicense', { body: req.body, user: req.user }, 'pre');
      if (preHook?.cancel) { res.status(409).json({ error: preHook.reason ?? 'Blocked by plugin' }); return; }

      const license = await prisma.license.create({
        data: {
          name:            d.name,
          licenseNumber:   d.licenseNumber,
          vendorId:        d.vendorId ?? null,
          startDate:       new Date(d.startDate),
          endDate:         d.endDate ? new Date(d.endDate) : null,
          licenseTypeId:   d.licenseTypeId ?? null,
          licenseMetricId: d.licenseMetricId ?? null,
          metricValue:     d.metricValue ?? null,
          metricUnit:      d.metricUnit ?? null,
          cost:            d.cost ?? null,
          currency:        d.currency,
          status:          d.status ?? 'ACTIVO',
          notes:           d.notes ?? null,
          parentLicenseId: d.parentLicenseId ?? null,
        },
      });
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CREATE','License',${license.id}::uuid,${req.user!.email},now())`;

      const licenseRootId = await getLicenseRoot(license.id);
      void queueForIndexing('license', licenseRootId);

      try { await emitHook('postCreateLicense', { id: license.id, body: req.body, user: req.user }); } catch (e) { console.error('[plugin-hook] postCreateLicense', e); }

      res.status(201).json(license);
    } catch (e) { res.status(500).json({ error: 'Failed to create license' }); }
  });

  // PATCH /api/licenses/:id — update any field
  router.patch('/:id', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const parsed = LicenseSchema.partial().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid license data' }); return; }
    const d = parsed.data;
    try {
      const license = await prisma.license.update({
        where: { id },
        data: {
          ...(d.name             !== undefined && { name:            d.name }),
          ...(d.licenseNumber    !== undefined && { licenseNumber:   d.licenseNumber }),
          ...(d.vendorId         !== undefined && { vendorId:        d.vendorId }),
          ...(d.startDate        !== undefined && { startDate:       new Date(d.startDate) }),
          ...(d.endDate          !== undefined && { endDate:         d.endDate ? new Date(d.endDate) : null }),
          ...(d.licenseTypeId    !== undefined && { licenseTypeId:   d.licenseTypeId }),
          ...(d.licenseMetricId  !== undefined && { licenseMetricId: d.licenseMetricId }),
          ...(d.metricValue      !== undefined && { metricValue:     d.metricValue }),
          ...(d.metricUnit       !== undefined && { metricUnit:      d.metricUnit }),
          ...(d.cost             !== undefined && { cost:            d.cost }),
          ...(d.currency         !== undefined && { currency:        d.currency }),
          ...(d.status           !== undefined && { status:          d.status }),
          ...(d.notes            !== undefined && { notes:           d.notes }),
          ...(d.parentLicenseId  !== undefined && { parentLicenseId: d.parentLicenseId }),
        },
      });
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'UPDATE','License',${license.id}::uuid,${req.user!.email},now())`;

      const licenseRootId = await getLicenseRoot(license.id);
      void queueForIndexing('license', licenseRootId);

      res.json(license);
    } catch (e) { res.status(500).json({ error: 'Failed to update license' }); }
  });

  // DELETE /api/licenses/:id — delete (cascade handles relations)
  router.delete('/:id', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const id = req.params.id as string;
    try {
      // Walk to root BEFORE delete to decide purge vs re-queue
      const licenseRootId = await getLicenseRoot(id);
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'DELETE','License',${id}::uuid,${req.user!.email},now())`;
      await prisma.license.delete({ where: { id } });

      if (licenseRootId === id) {
        await purgeFromRag('license', licenseRootId);
      } else {
        void queueForIndexing('license', licenseRootId);
      }

      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Failed to delete license' }); }
  });

  // GET /api/licenses/:id/cis — list CIs for a license
  router.get('/:id/cis', authenticateToken, requireUuidParam('id'), async (req: Request, res: Response) => {
    const licenseId = req.params.id as string;
    try {
      const rows = await prisma.$queryRaw<{
        id: string; name: string; apiSlug: string; environment: string; criticality: string;
      }[]>`
        SELECT ci.id::text AS id, ci.name, ci.api_slug AS "apiSlug",
               ci.environment::text AS environment, ci.criticality::text AS criticality
        FROM "configuration_items" ci
        JOIN "_LicenseToCI" lci ON lci."A" = ci.id
        WHERE lci."B" = ${licenseId}::uuid`;
      res.json(rows);
    } catch (e) { res.status(500).json({ error: 'Failed to fetch CIs for license' }); }
  });

  // POST /api/licenses/:id/cis — bulk associate CIs
  router.post('/:id/cis', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const schema = z.object({ ciIds: z.array(z.string().uuid()).min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'ciIds must be a non-empty array of UUIDs' }); return; }
    const { ciIds } = parsed.data;
    const licenseId = req.params.id as string;
    try {
      await prisma.license.update({
        where: { id: licenseId },
        data: { cis: { connect: ciIds.map((cid) => ({ id: cid })) } },
      });
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'LINK_CI','License',${licenseId}::uuid,${req.user!.email},now())`;

      const licenseRootId = await getLicenseRoot(licenseId);
      void queueForIndexing('license', licenseRootId);
      for (const cid of ciIds) { void queueForIndexing('ci', cid); }

      res.json({ associated: ciIds.length });
    } catch (e) { res.status(500).json({ error: 'Failed to associate CIs to license' }); }
  });

  // DELETE /api/licenses/:id/cis/:ciId — disassociate one CI
  router.delete('/:id/cis/:ciId', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const licenseId = req.params.id as string;
    const ciId = req.params.ciId as string;
    try {
      await prisma.license.update({
        where: { id: licenseId },
        data: { cis: { disconnect: [{ id: ciId }] } },
      });
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'UNLINK_CI','License',${licenseId}::uuid,${req.user!.email},now())`;

      const licenseRootId = await getLicenseRoot(licenseId);
      void queueForIndexing('license', licenseRootId);
      void queueForIndexing('ci', ciId);

      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Failed to disassociate CI from license' }); }
  });

  // GET /api/licenses/:id/documents — list docs with latestVersionId + mimeType
  router.get('/:id/documents', authenticateToken, requireUuidParam('id'), async (req: Request, res: Response) => {
    const licenseId = req.params.id as string;
    const visCol = Prisma.raw(`"${docVisibilitySqlCol(req.user!.role)}"`);
    try {
      const rows = await prisma.$queryRaw<{
        id: string; title: string; documentTypeName: string; documentTypeCode: string;
        originalName: string; versionNumber: number; uploadedBy: string;
        createdAt: Date; latestVersionId: string; mimeType: string;
      }[]>`
        SELECT d.id::text AS id, d.title, dt.name AS "documentTypeName", dt.code AS "documentTypeCode",
               COALESCE(v.original_name, d.original_name) AS "originalName",
               COALESCE(v.version_number, d.version_number) AS "versionNumber",
               COALESCE(v.uploaded_by, d.uploaded_by) AS "uploadedBy",
               d.created_at AS "createdAt",
               COALESCE(v.id::text, d.id::text) AS "latestVersionId",
               COALESCE(v.mime_type, d.mime_type) AS "mimeType"
        FROM "document_licenses" dl
        JOIN "documents" d ON dl.document_id = d.id
        JOIN "document_types" dt ON d.document_type_id = dt.id
        LEFT JOIN "documents" v ON v.root_id = d.id AND v.is_latest = true
        WHERE dl.license_id = ${licenseId}::uuid AND d.root_id IS NULL AND d.${visCol} = true
        ORDER BY d.created_at DESC`;
      res.json(rows);
    } catch (e) { res.status(500).json({ error: 'Failed to fetch documents for license' }); }
  });

  // POST /api/licenses/:id/documents — bulk associate documents
  router.post('/:id/documents', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const schema = z.object({ documentIds: z.array(z.string().uuid()).min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'documentIds must be a non-empty array of UUIDs' }); return; }
    const { documentIds } = parsed.data;
    const licenseId = req.params.id as string;
    try {
      let associated = 0;
      for (const documentId of documentIds) {
        await prisma.$executeRaw`
          INSERT INTO "document_licenses"(id, document_id, license_id)
          VALUES(gen_random_uuid(), ${documentId}::uuid, ${licenseId}::uuid)
          ON CONFLICT DO NOTHING`;
        associated++;
      }
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'LINK_DOCUMENT','License',${licenseId}::uuid,${req.user!.email},now())`;

      const licenseRootId = await getLicenseRoot(licenseId);
      void queueForIndexing('license', licenseRootId);

      res.json({ associated });
    } catch (e) { res.status(500).json({ error: 'Failed to associate documents to license' }); }
  });

  // DELETE /api/licenses/:id/documents/:docId — remove from document_licenses
  router.delete('/:id/documents/:docId', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const licenseId = req.params.id as string;
    const docId = req.params.docId as string;
    try {
      await prisma.$executeRaw`
        DELETE FROM "document_licenses" WHERE document_id = ${docId}::uuid AND license_id = ${licenseId}::uuid`;
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'UNLINK_DOCUMENT','License',${licenseId}::uuid,${req.user!.email},now())`;

      const licenseRootId = await getLicenseRoot(licenseId);
      void queueForIndexing('license', licenseRootId);

      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Failed to remove document association from license' }); }
  });

  // GET /api/licenses/:id/users — list LicenseUsers
  router.get('/:id/users', authenticateToken, requireUuidParam('id'), async (req: Request, res: Response) => {
    const licenseId = req.params.id as string;
    try {
      const users = await prisma.licenseUser.findMany({
        where: { licenseId },
        orderBy: { createdAt: 'asc' },
      });
      res.json(users);
    } catch (e) { res.status(500).json({ error: 'Failed to fetch license users' }); }
  });

  // POST /api/licenses/:id/users — create a LicenseUser
  router.post('/:id/users', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const parsed = LicenseUserSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid user data', details: parsed.error.flatten() }); return; }
    const { name, dni, email } = parsed.data;
    const licenseId = req.params.id as string;
    try {
      const user = await prisma.licenseUser.create({
        data: { licenseId, name, dni: dni ?? null, email: email || null },
      });
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CREATE','LicenseUser',${user.id}::uuid,${req.user!.email},now())`;

      const licenseRootId = await getLicenseRoot(licenseId);
      void queueForIndexing('license', licenseRootId);

      res.status(201).json(user);
    } catch (e) { res.status(500).json({ error: 'Failed to create license user' }); }
  });

  // DELETE /api/licenses/:id/users/:userId — delete a LicenseUser
  router.delete('/:id/users/:userId', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const userId    = req.params.userId as string;
    const licenseId = req.params.id as string;
    try {
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'DELETE','LicenseUser',${userId}::uuid,${req.user!.email},now())`;
      await prisma.licenseUser.delete({ where: { id: userId } });

      const licenseRootId = await getLicenseRoot(licenseId);
      void queueForIndexing('license', licenseRootId);

      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Failed to delete license user' }); }
  });

  return router;
}
