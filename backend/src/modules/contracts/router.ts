import { Router, Request, Response } from 'express';
import { PrismaClient, Prisma }       from '@prisma/client';
import { z }                           from 'zod';
import { createAuthenticateToken }    from '../../shared/middleware/authenticate.js';
import { requireAdmin }               from '../../shared/middleware/requireAdmin.js';
import { requireUuidParam }           from '../../shared/middleware/requireUuidParam.js';
import { docVisibilitySqlCol }        from '../../shared/utils/docVisibility.js';
import { getContractRoot }            from '../../services/entitySerializer.js';
import { emitHook }                   from '../plugins/index.js';
import { ContractCreateSchema, ContractUpdateSchema, CONTRACT_INCLUDE } from './schemas.js';

export function createContractsRouter(
  prisma: PrismaClient,
  queueForIndexing: (entityType: string, entityId: string) => void | Promise<void>,
): Router {
  const router = Router();
  const authenticateToken = createAuthenticateToken(prisma);

  // GET /api/contracts — list all contracts with vendor, CIs, addendums
  router.get('/', authenticateToken, async (_req: Request, res: Response) => {
    try {
      const contracts = await prisma.contract.findMany({
        include: CONTRACT_INCLUDE,
        orderBy: { startDate: 'desc' },
      });
      res.json({ total: contracts.length, data: contracts });
    } catch (error) {
      console.error('[GET /api/contracts] Error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/contracts — create a contract (ADMIN only)
  router.post('/', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
    const contractParsed = ContractCreateSchema.safeParse(req.body);
    if (!contractParsed.success) {
      res.status(400).json({ error: contractParsed.error.issues[0]?.message ?? 'Datos de contrato inválidos' });
      return;
    }
    try {
      const { contractNumber, startDate, endDate, vendorId, parentContractId, ciIds } = contractParsed.data;

      const preHook = await emitHook('preCreateContract', { body: req.body, user: req.user }, 'pre');
      if (preHook?.cancel) { res.status(409).json({ error: preHook.reason ?? 'Blocked by plugin' }); return; }

      const contract = await prisma.contract.create({
        data: {
          contractNumber,
          startDate:        new Date(startDate),
          endDate:          endDate ? new Date(endDate) : null,
          vendorId,
          parentContractId: parentContractId || null,
          ...(ciIds && ciIds.length > 0 && { cis: { connect: ciIds.map((id) => ({ id })) } }),
        },
        include: CONTRACT_INCLUDE,
      });

      await prisma.$executeRaw`
        INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
        VALUES(gen_random_uuid(), 'CREATE', 'Contract', ${contract.id}::uuid, ${req.user!.email}, now())
      `;

      const contractRootId = await getContractRoot(contract.id);
      void queueForIndexing('contract', contractRootId);

      try { await emitHook('postCreateContract', { id: contract.id, body: req.body, user: req.user }); } catch (e) { console.error('[plugin-hook] postCreateContract', e); }

      res.status(201).json(contract);
    } catch (error: unknown) {
      console.error('[POST /api/contracts] Error:', error);
      if (typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === 'P2002') {
        res.status(409).json({ error: 'A contract with this number already exists' });
        return;
      }
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * DELETE /api/contracts/:id — hard delete (ADMIN only).
   * Blocks (409) if contract has active addendums — delete those first.
   */
  router.delete('/:id', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const contractId = req.params.id as string;
    try {
      const existing = await prisma.contract.findUnique({
        where: { id: contractId },
        select: { id: true, contractNumber: true, parentContractId: true },
      });
      if (!existing) { res.status(404).json({ error: 'Contract not found' }); return; }

      const addendums = await prisma.$queryRaw<{ c: bigint }[]>`
        SELECT COUNT(*) AS c FROM "contracts" WHERE parent_contract_id = ${contractId}::uuid`;
      if (Number(addendums[0]?.c ?? 0) > 0) {
        res.status(409).json({
          error: 'Cannot delete contract with active addendums. Delete those first.',
          addendumCount: Number(addendums[0]?.c ?? 0),
        });
        return;
      }

      const rootId = await getContractRoot(contractId);

      await prisma.$transaction(async (tx) => {
        await tx.contract.delete({ where: { id: contractId } });
        await tx.$executeRaw`
          INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, details, created_at)
          VALUES(gen_random_uuid(), 'DELETE', 'Contract', ${contractId}::uuid, ${req.user!.email},
                 ${JSON.stringify({ contractNumber: existing.contractNumber, wasAddendum: !!existing.parentContractId })}::jsonb, now())`;
      });

      // RAG cleanup — best-effort, does not fail the response
      try {
        await prisma.$executeRaw`DELETE FROM "rag_chunks" WHERE entity_type = 'contract' AND entity_id = ${contractId}::uuid`;
        await prisma.$executeRaw`DELETE FROM "rag_entity_index" WHERE entity_type = 'contract' AND entity_id = ${contractId}::uuid`;
      } catch (e) { console.error('[DELETE /api/contracts/:id] RAG cleanup error:', e); }

      if (rootId && rootId !== contractId) {
        void queueForIndexing('contract', rootId);
      }

      res.json({ ok: true, deletedId: contractId });
    } catch (error: unknown) {
      console.error('[DELETE /api/contracts/:id] Error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PATCH /api/contracts/:id — update a contract (ADMIN only)
  router.patch('/:id', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const parsed = ContractUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid contract data' });
      return;
    }
    const { contractNumber, startDate, endDate, vendorId, parentContractId } = parsed.data;
    const contractId = req.params.id as string;
    try {
      const contract = await prisma.contract.update({
        where: { id: contractId },
        data: {
          contractNumber,
          startDate:        new Date(startDate),
          endDate:          endDate ? new Date(endDate) : null,
          vendorId,
          parentContractId: parentContractId ?? null,
        },
        include: CONTRACT_INCLUDE,
      });
      await prisma.$executeRaw`
        INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
        VALUES(gen_random_uuid(), 'UPDATE', 'Contract', ${contractId}::uuid, ${req.user!.email}, now())
      `;
      const contractRootId = await getContractRoot(contract.id);
      void queueForIndexing('contract', contractRootId);
      res.json(contract);
    } catch (error: unknown) {
      console.error('[PATCH /api/contracts/:id] Error:', error);
      if (typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === 'P2002') {
        res.status(409).json({ error: 'A contract with this number already exists' });
        return;
      }
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/contracts/:id/documents — list documents for a contract
  router.get('/:id/documents', authenticateToken, requireUuidParam('id'), async (req: Request, res: Response) => {
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
        FROM "document_contracts" dc
        JOIN "documents" d ON dc.document_id = d.id
        JOIN "document_types" dt ON d.document_type_id = dt.id
        LEFT JOIN "documents" v ON v.root_id = d.id AND v.is_latest = true
        WHERE dc.contract_id = ${req.params.id}::uuid AND d.root_id IS NULL AND d.${visCol} = true
        ORDER BY d.created_at DESC`;
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  /**
   * DELETE /api/contracts/:id/documents/:docId — unlink a document from a contract.
   * Idempotent: returns 200 even if the link did not exist.
   */
  router.delete('/:id/documents/:docId', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const IdSchema = z.object({ id: z.string().uuid(), docId: z.string().uuid() });
    const parsed = IdSchema.safeParse(req.params);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid contract or document id' }); return; }
    const { id: contractId, docId } = parsed.data;
    try {
      await prisma.$executeRaw`DELETE FROM "document_contracts" WHERE contract_id = ${contractId}::uuid AND document_id = ${docId}::uuid`;
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at) VALUES(gen_random_uuid(),'UNLINK_DOCUMENT','Contract',${contractId}::uuid,${req.user!.email},${JSON.stringify({ documentId: docId })}::jsonb,now())`;
      const rootId = await getContractRoot(contractId);
      void queueForIndexing('contract', rootId);
      res.json({ ok: true });
    } catch (e) { console.error('[DELETE /api/contracts/:id/documents/:docId]', e); res.status(500).json({ error: 'Internal server error' }); }
  });

  // GET /api/contracts/:id/cis — list CIs associated with a contract
  router.get('/:id/cis', authenticateToken, requireUuidParam('id'), async (req: Request, res: Response) => {
    const contractId = req.params.id as string;
    try {
      const rows = await prisma.$queryRaw<{
        id: string; name: string; apiSlug: string; environment: string; criticality: string;
      }[]>`
        SELECT ci.id::text AS id, ci.name, ci.api_slug AS "apiSlug",
               ci.environment::text AS environment, ci.criticality::text AS criticality
        FROM "configuration_items" ci
        JOIN "_ContractToCI" ctc ON ctc."A" = ci.id
        WHERE ctc."B" = ${contractId}::uuid`;
      res.json(rows);
    } catch (e) { res.status(500).json({ error: 'Failed to fetch CIs for contract' }); }
  });

  // POST /api/contracts/:id/cis — bulk associate CIs to a contract
  router.post('/:id/cis', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const schema = z.object({ ciIds: z.array(z.string().uuid()).min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'ciIds must be a non-empty array of UUIDs' }); return; }
    const { ciIds } = parsed.data;
    const contractId = req.params.id as string;
    try {
      await prisma.contract.update({
        where: { id: contractId },
        data: { cis: { connect: ciIds.map((cid) => ({ id: cid })) } },
      });
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at) VALUES(gen_random_uuid(),'LINK_CI','Contract',${contractId}::uuid,${req.user!.email},${JSON.stringify({ ciIds })}::jsonb,now())`;

      const rootId = await getContractRoot(contractId);
      void queueForIndexing('contract', rootId);
      for (const cid of ciIds) { void queueForIndexing('ci', cid); }

      res.json({ associated: ciIds.length });
    } catch (e) { res.status(500).json({ error: 'Failed to associate CIs to contract' }); }
  });

  // DELETE /api/contracts/:id/cis/:ciId — disassociate CI from contract
  router.delete('/:id/cis/:ciId', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const contractId = req.params.id as string;
    const ciId = req.params.ciId as string;
    try {
      await prisma.contract.update({
        where: { id: contractId },
        data: { cis: { disconnect: [{ id: ciId }] } },
      });
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at) VALUES(gen_random_uuid(),'UNLINK_CI','Contract',${contractId}::uuid,${req.user!.email},${JSON.stringify({ ciId })}::jsonb,now())`;

      const rootId = await getContractRoot(contractId);
      void queueForIndexing('contract', rootId);
      void queueForIndexing('ci', ciId);

      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Failed to disassociate CI from contract' }); }
  });

  return router;
}
