import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import {
  PlanCreateSchema, PlanUpdateSchema, PlanCiUpdateSchema,
  PlanDocumentAddSchema, PlanContractAddSchema, PlanLicenseAddSchema,
} from './schemas.js';
import { decommissionAudit } from './audit.js';
import {
  requireUuidParam, requireAuditRole, requireAdminRole, makePlanLoader,
} from './middleware.js';
import {
  listPlans, getPlan, createPlan, updatePlan, deletePlan,
  generateInventory, listPlanCis, updatePlanCi,
  listPlanDocuments, addPlanDocument, removePlanDocument,
  listPlanContracts, addPlanContract, removePlanContract,
  listPlanLicenses, addPlanLicense, removePlanLicense,
  getGanttData, searchSystemCis,
} from './queries.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

type RagOps = {
  queueEntity: (type: string, id: string) => Promise<void>;
  purgeEntity: (type: string, id: string) => Promise<void>;
};

export function createDecommissionRouter(prisma: PrismaClient, rag?: RagOps): Router {
  const router = Router();
  /** Fire-and-forget RAG re-index for a plan (non-blocking). */
  const queuePlan = (id: string) => { if (rag) void rag.queueEntity('decommission', id); };

  // ── GET /api/decommission/plans ───────────────────────────────────────────
  router.get('/plans', async (_req: Request, res: Response) => {
    try {
      const plans = await listPlans(prisma);
      res.json({ plans });
    } catch (err) {
      console.error('[decommission] list error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/decommission/systems ─────────────────────────────────────────
  // Searchable list of CIs of type SISTEMA for the plan-creation combobox.
  // ADMIN only (plan creation is ADMIN-only). Read-only → no audit log.
  router.get('/systems', requireAdminRole, async (req: Request, res: Response) => {
    try {
      const rawSearch = typeof req.query.search === 'string' ? req.query.search : '';
      const search    = rawSearch.trim().slice(0, 100);           // bound input length
      const rawLimit  = parseInt(String(req.query.limit ?? '50'), 10);
      const limit     = Math.min(Math.max(Number.isNaN(rawLimit) ? 50 : rawLimit, 1), 50);
      const systems   = await searchSystemCis(prisma, search, limit);
      res.json({ systems });
    } catch (err) {
      console.error('[decommission] systems search error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── POST /api/decommission/plans ──────────────────────────────────────────
  router.post('/plans', requireAdminRole, async (req: Request, res: Response) => {
    const parse = PlanCreateSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: 'Validation error', details: parse.error.flatten() });
      return;
    }
    try {
      // Verify the CI is of type SISTEMA
      const ciRows = await prisma.$queryRaw<{id: string; type_code: string | null}[]>`
        SELECT ci.id, cit.code AS type_code
        FROM "configuration_items" ci
        LEFT JOIN "ci_types" cit ON cit.id = ci.ci_type_id
        WHERE ci.id = ${parse.data.systemCiId}::uuid
        LIMIT 1
      `;
      if (ciRows.length === 0) {
        res.status(404).json({ error: 'CI not found' });
        return;
      }
      if (ciRows[0].type_code !== 'SISTEMA') {
        res.status(400).json({ error: 'CI must be of type SISTEMA' });
        return;
      }

      const userEmail = (req as any).user?.email ?? 'unknown';
      const plan = await createPlan(prisma, parse.data.name, parse.data.systemCiId, userEmail);
      await decommissionAudit(prisma, 'CREATE', 'DECOMMISSION_PLAN', plan.id, userEmail);
      queuePlan(plan.id);
      res.status(201).json({ plan });
    } catch (err) {
      console.error('[decommission] create error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/decommission/plans/:id ──────────────────────────────────────
  router.get('/plans/:id', requireUuidParam('id'), async (req: Request, res: Response) => {
    try {
      const plan = await getPlan(prisma, req.params.id as string);
      if (!plan) { res.status(404).json({ error: 'Plan not found' }); return; }
      res.json({ plan });
    } catch (err) {
      console.error('[decommission] get error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── PATCH /api/decommission/plans/:id ────────────────────────────────────
  router.patch('/plans/:id', requireAdminRole, requireUuidParam('id'), makePlanLoader(prisma), async (req: Request, res: Response) => {
    const parse = PlanUpdateSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: 'Validation error', details: parse.error.flatten() });
      return;
    }
    try {
      const plan = await updatePlan(prisma, req.params.id as string, parse.data.name, parse.data.status);
      const userEmail = (req as any).user?.email ?? 'unknown';
      await decommissionAudit(prisma, 'UPDATE', 'DECOMMISSION_PLAN', req.params.id as string, userEmail);
      queuePlan(req.params.id as string);
      res.json({ plan });
    } catch (err) {
      console.error('[decommission] update error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── DELETE /api/decommission/plans/:id ───────────────────────────────────
  router.delete('/plans/:id', requireAdminRole, requireUuidParam('id'), makePlanLoader(prisma), async (req: Request, res: Response) => {
    try {
      const userEmail = (req as any).user?.email ?? 'unknown';
      await decommissionAudit(prisma, 'DELETE', 'DECOMMISSION_PLAN', req.params.id as string, userEmail);
      if (rag) await rag.purgeEntity('decommission', req.params.id as string);
      await deletePlan(prisma, req.params.id as string);
      res.status(204).send();
    } catch (err) {
      console.error('[decommission] delete error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── POST /api/decommission/plans/:id/generate ────────────────────────────
  router.post('/plans/:id/generate', requireAdminRole, requireUuidParam('id'), makePlanLoader(prisma), async (req: Request, res: Response) => {
    try {
      const plan = await getPlan(prisma, req.params.id as string);
      if (!plan) { res.status(404).json({ error: 'Plan not found' }); return; }

      // Require decommission date on the system CI
      const dateRows = await prisma.$queryRaw<{date_value: Date}[]>`
        SELECT cd.date_value
        FROM "ci_dates" cd
        JOIN "date_types" dt ON dt.id = cd.date_type_id
        WHERE cd.ci_id = ${plan.system_ci_id}::uuid
          AND dt.code = 'decommission-date'
        LIMIT 1
      `;
      if (dateRows.length === 0) {
        res.status(400).json({ error: 'El CI Sistema debe tener una Fecha de Baja Programada configurada' });
        return;
      }

      const systemDate = dateRows[0].date_value;
      await generateInventory(prisma, req.params.id as string, plan.system_ci_id, systemDate);

      const cis = await listPlanCis(prisma, req.params.id as string);
      const userEmail = (req as any).user?.email ?? 'unknown';
      await decommissionAudit(prisma, 'GENERATE', 'DECOMMISSION_PLAN', req.params.id as string, userEmail);
      queuePlan(req.params.id as string);

      // Warn if any child has scheduled_date > system date
      const warnings = cis.filter(c =>
        c.scheduled_date && c.depth > 0 &&
        new Date(c.scheduled_date) > new Date(systemDate)
      ).map(c => c.ci_name);

      res.json({ cis, warnings });
    } catch (err) {
      console.error('[decommission] generate error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/decommission/plans/:id/cis ──────────────────────────────────
  router.get('/plans/:id/cis', requireUuidParam('id'), makePlanLoader(prisma), async (req: Request, res: Response) => {
    try {
      const plan = await getPlan(prisma, req.params.id as string);
      if (!plan) { res.status(404).json({ error: 'Plan not found' }); return; }

      const cis = await listPlanCis(prisma, req.params.id as string);

      // Attach date coherence warnings
      const systemCi = cis.find(c => c.depth === 0);
      const systemDate = systemCi?.scheduled_date ? new Date(systemCi.scheduled_date) : null;
      const result = cis.map(c => ({
        ...c,
        dateWarning: systemDate && c.scheduled_date && c.depth > 0
          ? new Date(c.scheduled_date) > systemDate
          : false,
      }));
      res.json({ cis: result });
    } catch (err) {
      console.error('[decommission] list cis error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── PATCH /api/decommission/plans/:id/cis/:ciId ──────────────────────────
  router.patch('/plans/:id/cis/:ciId', requireAdminRole, requireUuidParam('id'), requireUuidParam('ciId'), async (req: Request, res: Response) => {
    const parse = PlanCiUpdateSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: 'Validation error', details: parse.error.flatten() });
      return;
    }
    try {
      await updatePlanCi(prisma, req.params.id as string, req.params.ciId as string,
        parse.data.scheduledDate, parse.data.notes);
      const userEmail = (req as any).user?.email ?? 'unknown';
      await decommissionAudit(prisma, 'UPDATE_CI_DATE', 'DECOMMISSION_PLAN', req.params.id as string, userEmail);
      res.json({ ok: true });
    } catch (err) {
      console.error('[decommission] update ci error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/decommission/plans/:id/gantt ────────────────────────────────
  router.get('/plans/:id/gantt', requireUuidParam('id'), makePlanLoader(prisma), async (req: Request, res: Response) => {
    try {
      const tasks = await getGanttData(prisma, req.params.id as string);
      res.json({ tasks });
    } catch (err) {
      console.error('[decommission] gantt error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Documents ─────────────────────────────────────────────────────────────
  router.get('/plans/:id/documents', requireUuidParam('id'), makePlanLoader(prisma), async (req: Request, res: Response) => {
    try {
      res.json({ documents: await listPlanDocuments(prisma, req.params.id as string) });
    } catch (err) {
      console.error('[decommission] list docs error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/plans/:id/documents', requireAdminRole, requireUuidParam('id'), makePlanLoader(prisma), async (req: Request, res: Response) => {
    const parse = PlanDocumentAddSchema.safeParse(req.body);
    if (!parse.success) { res.status(400).json({ error: 'Validation error' }); return; }
    try {
      await addPlanDocument(prisma, req.params.id as string, parse.data.documentId);
      const userEmail = (req as any).user?.email ?? 'unknown';
      await decommissionAudit(prisma, 'ADD_DOCUMENT', 'DECOMMISSION_PLAN', req.params.id as string, userEmail);
      queuePlan(req.params.id as string);
      res.status(201).json({ ok: true });
    } catch (err) {
      console.error('[decommission] add doc error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/plans/:id/documents/:docId', requireAdminRole, requireUuidParam('id'), requireUuidParam('docId'), makePlanLoader(prisma), async (req: Request, res: Response) => {
    try {
      await removePlanDocument(prisma, req.params.id as string, req.params.docId as string);
      const userEmail = (req as any).user?.email ?? 'unknown';
      await decommissionAudit(prisma, 'REMOVE_DOCUMENT', 'DECOMMISSION_PLAN', req.params.id as string, userEmail);
      queuePlan(req.params.id as string);
      res.status(204).send();
    } catch (err) {
      console.error('[decommission] remove doc error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Contracts ─────────────────────────────────────────────────────────────
  router.get('/plans/:id/contracts', requireUuidParam('id'), makePlanLoader(prisma), async (req: Request, res: Response) => {
    try {
      res.json({ contracts: await listPlanContracts(prisma, req.params.id as string) });
    } catch (err) {
      console.error('[decommission] list contracts error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/plans/:id/contracts', requireAdminRole, requireUuidParam('id'), makePlanLoader(prisma), async (req: Request, res: Response) => {
    const parse = PlanContractAddSchema.safeParse(req.body);
    if (!parse.success) { res.status(400).json({ error: 'Validation error' }); return; }
    try {
      await addPlanContract(prisma, req.params.id as string, parse.data.contractId);
      const userEmail = (req as any).user?.email ?? 'unknown';
      await decommissionAudit(prisma, 'ADD_CONTRACT', 'DECOMMISSION_PLAN', req.params.id as string, userEmail);
      queuePlan(req.params.id as string);
      res.status(201).json({ ok: true });
    } catch (err) {
      console.error('[decommission] add contract error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/plans/:id/contracts/:contractId', requireAdminRole, requireUuidParam('id'), requireUuidParam('contractId'), makePlanLoader(prisma), async (req: Request, res: Response) => {
    try {
      await removePlanContract(prisma, req.params.id as string, req.params.contractId as string);
      const userEmail = (req as any).user?.email ?? 'unknown';
      await decommissionAudit(prisma, 'REMOVE_CONTRACT', 'DECOMMISSION_PLAN', req.params.id as string, userEmail);
      queuePlan(req.params.id as string);
      res.status(204).send();
    } catch (err) {
      console.error('[decommission] remove contract error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Licenses ──────────────────────────────────────────────────────────────
  router.get('/plans/:id/licenses', requireUuidParam('id'), makePlanLoader(prisma), async (req: Request, res: Response) => {
    try {
      res.json({ licenses: await listPlanLicenses(prisma, req.params.id as string) });
    } catch (err) {
      console.error('[decommission] list licenses error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/plans/:id/licenses', requireAdminRole, requireUuidParam('id'), makePlanLoader(prisma), async (req: Request, res: Response) => {
    const parse = PlanLicenseAddSchema.safeParse(req.body);
    if (!parse.success) { res.status(400).json({ error: 'Validation error' }); return; }
    try {
      await addPlanLicense(prisma, req.params.id as string, parse.data.licenseId);
      const userEmail = (req as any).user?.email ?? 'unknown';
      await decommissionAudit(prisma, 'ADD_LICENSE', 'DECOMMISSION_PLAN', req.params.id as string, userEmail);
      queuePlan(req.params.id as string);
      res.status(201).json({ ok: true });
    } catch (err) {
      console.error('[decommission] add license error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/plans/:id/licenses/:licenseId', requireAdminRole, requireUuidParam('id'), requireUuidParam('licenseId'), makePlanLoader(prisma), async (req: Request, res: Response) => {
    try {
      await removePlanLicense(prisma, req.params.id as string, req.params.licenseId as string);
      const userEmail = (req as any).user?.email ?? 'unknown';
      await decommissionAudit(prisma, 'REMOVE_LICENSE', 'DECOMMISSION_PLAN', req.params.id as string, userEmail);
      queuePlan(req.params.id as string);
      res.status(204).send();
    } catch (err) {
      console.error('[decommission] remove license error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
