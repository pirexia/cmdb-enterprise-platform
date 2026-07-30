import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { ZodError } from 'zod';
import { createAuthenticateToken } from '../../shared/middleware/authenticate.js';
import { requireSecurityRead, requireSecurityWrite } from '../../shared/middleware/requireSecurity.js';
import { vulnUuid } from '../../services/entitySerializer.js';
import { UnsupportedGreenboneFormatError } from './parser.js';
import { UploadRequestSchema, PatchEntrySchema, BulkDecisionSchema } from './schemas.js';
import {
  uploadReport, listBatches, getBatchDetail, patchEntry, bulkDecision, discardBatch, acceptBatch,
  BatchNotFoundError, EntryNotFoundError, BatchNotPendingError, CiNotFoundError, BlockingAmbiguityError,
} from './service.js';

// Router for the Greenbone real-format staging/review workflow (spec §D9 —
// this is its own module, not grown onto index.ts or integrations/router.ts,
// which owns the legacy direct-merge Greenbone endpoint left untouched by
// this task).

export interface RagOps {
  queueEntity: (entityType: string, entityId: string) => Promise<void>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The 20MB body-size ceiling for this route (spec D10) is enforced in
// index.ts via a path-scoped `express.json({limit:'20mb'})` mounted on
// '/api/vuln-import/upload' AHEAD of the app-wide `express.json({limit:'2mb'})`.
// A route-local body parser here would run too late: the global 2MB parser
// (registered before this router is mounted) would already have rejected —
// or already parsed — the body by the time Express reached this router's
// own middleware, since Express dispatches path-matching middleware in
// registration order. See index.ts around the global express.json() call.

export function createVulnImportRouter(prisma: PrismaClient, rag?: RagOps): Router {
  const router = Router();
  const authenticateToken = createAuthenticateToken(prisma);

  const queueCi = (ciId: string) => { if (rag) void rag.queueEntity('ci', ciId); };
  const queueVuln = (ciId: string, vulnKey: string) => { if (rag) void rag.queueEntity('vulnerability', vulnUuid(ciId, vulnKey)); };

  // ── POST /upload ────────────────────────────────────────────────────────
  router.post('/upload', authenticateToken, requireSecurityWrite, async (req: Request, res: Response) => {
    try {
      const body = UploadRequestSchema.parse(req.body);
      const result = await uploadReport(prisma, body, req.user!.email);
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof UnsupportedGreenboneFormatError) {
        res.status(400).json({ error: err.message });
        return;
      }
      if (err instanceof ZodError) {
        res.status(400).json({ error: 'Invalid Greenbone report', details: err.issues });
        return;
      }
      console.error('[POST /api/vuln-import/upload] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /batches ─────────────────────────────────────────────────────────
  router.get('/batches', authenticateToken, requireSecurityRead, async (req: Request, res: Response) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const page = req.query.page ? parseInt(String(req.query.page), 10) : undefined;
      const pageSize = req.query.pageSize ? parseInt(String(req.query.pageSize), 10) : undefined;
      const result = await listBatches(prisma, { status, page, pageSize });
      res.json(result);
    } catch (err) {
      console.error('[GET /api/vuln-import/batches] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /batches/:id ─────────────────────────────────────────────────────
  router.get('/batches/:id', authenticateToken, requireSecurityRead, async (req: Request, res: Response) => {
    try {
      if (!UUID_RE.test(req.params.id as string)) { res.status(404).json({ error: 'BATCH_NOT_FOUND' }); return; }
      const classification = typeof req.query.classification === 'string' ? req.query.classification : undefined;
      const severity = typeof req.query.severity === 'string' ? req.query.severity : undefined;
      const decision = typeof req.query.decision === 'string' ? req.query.decision : undefined;
      const result = await getBatchDetail(prisma, req.params.id as string, { classification, severity, decision });
      res.json(result);
    } catch (err) {
      if (err instanceof BatchNotFoundError) { res.status(404).json({ error: 'BATCH_NOT_FOUND' }); return; }
      console.error('[GET /api/vuln-import/batches/:id] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── PATCH /batches/:id/entries/:entryId ─────────────────────────────────
  router.patch('/batches/:id/entries/:entryId', authenticateToken, requireSecurityWrite, async (req: Request, res: Response) => {
    try {
      const body = PatchEntrySchema.parse(req.body);
      const updated = await patchEntry(prisma, req.params.id as string, req.params.entryId as string, body, req.user!.email);
      res.json(updated);
    } catch (err) {
      if (err instanceof ZodError) { res.status(400).json({ error: 'Invalid request body', details: err.issues }); return; }
      if (err instanceof BatchNotFoundError || err instanceof EntryNotFoundError) { res.status(404).json({ error: err.message }); return; }
      if (err instanceof BatchNotPendingError) { res.status(409).json({ error: 'BATCH_NOT_PENDING' }); return; }
      if (err instanceof CiNotFoundError) { res.status(422).json({ error: 'CI_NOT_FOUND' }); return; }
      console.error('[PATCH /api/vuln-import/batches/:id/entries/:entryId] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── POST /batches/:id/entries/bulk-decision ─────────────────────────────
  router.post('/batches/:id/entries/bulk-decision', authenticateToken, requireSecurityWrite, async (req: Request, res: Response) => {
    try {
      const body = BulkDecisionSchema.parse(req.body);
      const result = await bulkDecision(prisma, req.params.id as string, body, req.user!.email);
      res.json({ updated: result.count });
    } catch (err) {
      if (err instanceof ZodError) { res.status(400).json({ error: 'Invalid request body', details: err.issues }); return; }
      if (err instanceof BatchNotFoundError) { res.status(404).json({ error: 'BATCH_NOT_FOUND' }); return; }
      if (err instanceof BatchNotPendingError) { res.status(409).json({ error: 'BATCH_NOT_PENDING' }); return; }
      console.error('[POST /api/vuln-import/batches/:id/entries/bulk-decision] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── POST /batches/:id/accept ─────────────────────────────────────────────
  router.post('/batches/:id/accept', authenticateToken, requireSecurityWrite, async (req: Request, res: Response) => {
    try {
      const result = await acceptBatch(prisma, req.params.id as string, req.user!.email);

      // External side effects (RAG reindex) happen AFTER the transaction has
      // committed (spec D8) — fire-and-forget, never blocking the response
      // and never able to roll back the already-committed DB write.
      for (const t of result.touched) {
        queueCi(t.ciId);
        for (const vulnKey of t.vulnKeys) queueVuln(t.ciId, vulnKey);
      }

      res.json(result.summary);
    } catch (err) {
      if (err instanceof BatchNotFoundError) { res.status(404).json({ error: 'BATCH_NOT_FOUND' }); return; }
      if (err instanceof BatchNotPendingError) { res.status(409).json({ error: 'BATCH_NOT_PENDING' }); return; }
      if (err instanceof BlockingAmbiguityError) {
        res.status(422).json({ error: 'UNRESOLVED_MATCHES', entries: err.entries });
        return;
      }
      console.error('[POST /api/vuln-import/batches/:id/accept] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── POST /batches/:id/discard ─────────────────────────────────────────────
  router.post('/batches/:id/discard', authenticateToken, requireSecurityWrite, async (req: Request, res: Response) => {
    try {
      const updated = await discardBatch(prisma, req.params.id as string, req.user!.email);
      res.json(updated);
    } catch (err) {
      if (err instanceof BatchNotFoundError) { res.status(404).json({ error: 'BATCH_NOT_FOUND' }); return; }
      if (err instanceof BatchNotPendingError) { res.status(409).json({ error: 'BATCH_NOT_PENDING' }); return; }
      console.error('[POST /api/vuln-import/batches/:id/discard] Error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
