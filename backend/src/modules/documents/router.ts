import { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import multer from 'multer';
import { PrismaClient, Prisma } from '@prisma/client';
import { z } from 'zod';
import { createAuthenticateToken } from '../../shared/middleware/authenticate.js';
import { requireAdmin }           from '../../shared/middleware/requireAdmin.js';
import { requireUuidParam }       from '../../shared/middleware/requireUuidParam.js';
import { parseDocument } from '../../services/docParser.js';
import { isOllamaHealthy, analyzeDocumentForImport, type BulkAnalysisRaw } from '../../services/ragService.js';
import { getContractRoot, getLicenseRoot } from '../../services/entitySerializer.js';
import { emitHook } from '../plugins/index.js';
import { docVisibilitySqlCol } from '../../shared/utils/docVisibility.js';
import {
  ALLOWED_EXTENSIONS, validateMagicBytes, docVisibilityFilter,
  normalizeAnalysis,
  BulkValidationError, BulkItemDecisionBase, BulkItemDecisionSchema,
  type BulkItemDecision, type BulkItemRow, type CiMatch,
} from './schemas.js';

const DOCUMENTS_DIR = process.env.DOCUMENTS_DIR ?? '/app/documents';
const MAX_DOCUMENT_SIZE_MB = parseInt(process.env.MAX_DOCUMENT_SIZE_MB ?? '50', 10);
const MAX_FILE_SIZE = MAX_DOCUMENT_SIZE_MB * 1024 * 1024;

// ── Bulk document import (staging) ────────────────────────────────────────────
// Files land in STAGING_DIR (UUID names) until the user confirms each line, at
// which point they are moved into DOCUMENTS_DIR as real Document records.
const STAGING_DIR          = process.env.BULK_STAGING_DIR ?? path.join(DOCUMENTS_DIR, '_staging');
const BULK_MAX_FILES       = parseInt(process.env.BULK_MAX_FILES ?? '20', 10);
const BULK_MAX_TOTAL_BYTES = parseInt(process.env.BULK_MAX_TOTAL_MB ?? '200', 10) * 1024 * 1024;
const BULK_BATCH_TTL_HOURS    = parseInt(process.env.BULK_BATCH_TTL_HOURS ?? '24', 10);
// Items analyzed per cron tick — kept small so AI bulk analysis never starves
// the normal RAG indexing queue (both share the single CPU-bound Ollama).
const BULK_ANALYZE_BUDGET     = parseInt(process.env.BULK_ANALYZE_BUDGET ?? '2', 10);
// Max concurrent open batches per user (non-terminal states). Prevents DoS / staging exhaustion.
const BULK_MAX_OPEN_BATCHES   = parseInt(process.env.BULK_MAX_OPEN_BATCHES ?? '5', 10);
// Max total staging bytes held by a single user across all open batches (default 500 MB).
// Prevents peak disk exhaustion when multiple large batches are open simultaneously.
const BULK_MAX_USER_STAGING_BYTES = parseInt(process.env.BULK_MAX_USER_STAGING_MB ?? '500', 10) * 1024 * 1024;
// Days to retain REAPED batch rows in the DB before final deletion. Gives users time
// to see expired batches in the list view (Task C) without causing table bloat.
const BULK_REAPED_RETENTION_DAYS = parseInt(process.env.BULK_REAPED_RETENTION_DAYS ?? '7', 10);
const DOCS_MAX_PAGE_SIZE = 250;

// ── matchCIsForImport — takes prisma as parameter ─────────────────────────────
async function matchCIsForImport(prisma: PrismaClient, hints: string[]): Promise<CiMatch[]> {
  const seen = new Set<string>();
  const out: CiMatch[] = [];
  for (const rawHint of hints.slice(0, 20)) {
    const hint = String(rawHint).trim();
    if (hint.length < 3) continue;
    const escaped = hint.replace(/[\\%_]/g, (c) => '\\' + c);
    const like = `%${escaped}%`;
    const rows = await prisma.$queryRaw<{ ciId: string; name: string; serial: string | null; matchType: string }[]>`
      SELECT ci.id::text AS "ciId", ci.name AS name, h.serial_number AS serial,
             CASE WHEN h.serial_number ILIKE ${like} ESCAPE '\\' THEN 'serial' ELSE 'name' END AS "matchType"
      FROM "configuration_items" ci
      LEFT JOIN "hardware_cis" h ON h.ci_id = ci.id
      WHERE h.serial_number ILIKE ${like} ESCAPE '\\' OR ci.name ILIKE ${like} ESCAPE '\\'
      LIMIT 5`;
    for (const r of rows) {
      if (seen.has(r.ciId)) continue;
      seen.add(r.ciId);
      out.push({ ciId: r.ciId, name: r.name, serial: r.serial, matchType: r.matchType === 'serial' ? 'serial' : 'name' });
    }
    if (out.length >= 25) break;
  }
  return out;
}

// ── recomputeBatchStatus ─────────────────────────────────────────────────────
/** Recomputes a batch's aggregate status from its items. Reused on commit. */
/**
 * Batch status state machine:
 *   UPLOADED           → just created, no items processed yet
 *   ANALYZING          → at least one item still in PENDING_ANALYSIS or ANALYZING
 *   READY              → all analyzed (ANALYZED), none committed, none in error
 *   ERROR              → all processed, no items pending/committed, but some items in ERROR
 *   PARTIALLY_COMMITTED→ some committed, others still pending review or in error
 *   COMMITTED          → every item committed
 *   DISCARDED          → all items removed by user (total=0)
 *   REAPED             → set by the TTL cleanup cron (external transition, not computed here)
 */
async function recomputeBatchStatus(prisma: PrismaClient, batchId: string): Promise<void> {
  const rows = await prisma.$queryRaw<{ total: bigint; pending: bigint; committed: bigint; errors: bigint; warnings: bigint }[]>`
    SELECT COUNT(*) AS total,
           COUNT(*) FILTER (WHERE status IN ('PENDING_ANALYSIS','ANALYZING')) AS pending,
           COUNT(*) FILTER (WHERE status = 'COMMITTED') AS committed,
           COUNT(*) FILTER (WHERE status = 'ERROR') AS errors,
           COUNT(*) FILTER (WHERE status = 'WARNING') AS warnings
    FROM "bulk_import_item" WHERE batch_id = ${batchId}::uuid`;
  const total     = Number(rows[0]?.total     ?? 0);
  const pending   = Number(rows[0]?.pending   ?? 0);
  const committed = Number(rows[0]?.committed ?? 0);
  const errors    = Number(rows[0]?.errors    ?? 0);
  const warnings  = Number(rows[0]?.warnings  ?? 0);
  let status: string;
  if (total === 0)               status = 'DISCARDED';
  else if (pending > 0)          status = 'ANALYZING';
  else if (committed === total)  status = 'COMMITTED';
  else if (committed > 0)        status = 'PARTIALLY_COMMITTED';
  else if (errors > 0 && committed === 0 && pending === 0 && warnings === 0) status = 'ERROR';
  else if (warnings > 0 && committed === 0 && pending === 0) status = 'READY_WITH_WARNINGS';
  else                           status = 'READY';
  await prisma.$executeRaw`UPDATE "bulk_import_batch" SET status = ${status}, updated_at = now() WHERE id = ${batchId}::uuid`;
}


export function createDocumentsRouter(
  prisma: PrismaClient,
  queueForIndexing: (type: string, id: string) => void | Promise<void>,
): Router {
  const authenticateToken = createAuthenticateToken(prisma);
  // Ensure document directories exist
  if (!fs.existsSync(DOCUMENTS_DIR)) fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });
  if (!fs.existsSync(STAGING_DIR)) fs.mkdirSync(STAGING_DIR, { recursive: true });

  // ── queueDocumentForIndexing (closure over prisma) ──────────────────────────
  async function queueDocumentForIndexing(documentId: string, versionNumber: number): Promise<void> {
  if (process.env.RAG_ENABLED !== 'true') return;
  try {
    await prisma.$executeRaw`
      INSERT INTO "rag_document_index"(id, document_id, version_number, status, created_at, updated_at)
      VALUES(gen_random_uuid(), ${documentId}::uuid, ${versionNumber}, 'PENDING', now(), now())
      ON CONFLICT (document_id, version_number) DO UPDATE SET status='PENDING', updated_at=now()`;
  } catch (e) {
    console.error('[RAG] queueDocumentForIndexing error:', e);
  }
}

  // ── materializeBulkItem (closure over prisma + queueForIndexing) ─────────────
/**
 * Materializes one staged item into a real Document (+ optional Contract /
 * Addendum / License) and associations, in a single transaction. The file is
 * copied to the documents store first and only deleted from staging on success;
 * on failure the destination copy is removed so nothing is orphaned.
 */
  async function materializeBulkItem(
  item: BulkItemRow,
  decision: BulkItemDecision,
  userEmail: string,
): Promise<{ documentId: string; contractId?: string; licenseId?: string }> {
  if (item.status === 'COMMITTED') throw new BulkValidationError('El elemento ya fue confirmado');

  // ── Existence checks (clean errors instead of raw FK violations) ───────────
  const dtype = await prisma.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM "document_types" WHERE id=${decision.documentTypeId}::uuid LIMIT 1`;
  if (!dtype.length) throw new BulkValidationError('Tipo de documento no encontrado');

  if (decision.vendorId) {
    const v = await prisma.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM "vendors" WHERE id=${decision.vendorId}::uuid LIMIT 1`;
    if (!v.length) throw new BulkValidationError('Proveedor no encontrado');
  }
  if (decision.target === 'addendum' && decision.parentContractId) {
    const p = await prisma.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM "contracts" WHERE id=${decision.parentContractId}::uuid LIMIT 1`;
    if (!p.length) throw new BulkValidationError('Contrato padre no encontrado');
  }
  if (decision.ciIds && decision.ciIds.length > 0) {
    const found = await prisma.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*) AS c FROM "configuration_items" WHERE id IN (${Prisma.join(decision.ciIds.map((id) => Prisma.sql`${id}::uuid`))})`;
    if (Number(found[0]?.c ?? 0) !== decision.ciIds.length) throw new BulkValidationError('Uno o más CIs no existen');
  }

  // ── Copy staged → final store (keep staging copy until DB commit succeeds) ──
  const ext = (path.extname(item.staged_file_name).replace('.', '') || path.extname(item.original_name).replace('.', '')).toLowerCase();
  const finalName = `${crypto.randomUUID()}.${ext}`;
  const stagedPath = path.join(STAGING_DIR, path.basename(item.staged_file_name));
  const finalPath  = path.join(DOCUMENTS_DIR, finalName);
  if (!fs.existsSync(stagedPath)) throw new BulkValidationError('El fichero en staging ya no existe');

  // Re-validate magic bytes at commit time (BULK-A08-2): the staged file could have
  // been tampered with between upload and commit, or the upload-time check bypassed.
  const headerBuf = Buffer.alloc(16);
  const fd = fs.openSync(stagedPath, 'r');
  fs.readSync(fd, headerBuf, 0, 16, 0);
  fs.closeSync(fd);
  if (!validateMagicBytes(headerBuf, ext)) {
    throw new BulkValidationError('El fichero en staging no supera la validación de tipo (magic bytes)');
  }

  fs.copyFileSync(stagedPath, finalPath);

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Atomically CLAIM the row first: a concurrent/retried commit blocks on this
      // row lock, then sees status='COMMITTED' and affects 0 rows → we abort. This
      // closes the TOCTOU between the pre-transaction status snapshot and the flip,
      // preventing duplicate Document/Contract/License rows + orphaned files.
      const claimed = await tx.$executeRaw`
        UPDATE "bulk_import_item" SET status='COMMITTED', error_message=NULL, updated_at=now()
        WHERE id=${item.id}::uuid AND status <> 'COMMITTED'`;
      if (Number(claimed) === 0) throw new BulkValidationError('El elemento ya fue confirmado');

      const docRows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "documents"(id,title,description,document_type_id,root_id,version_number,is_latest,file_name,original_name,mime_type,file_size,uploaded_by,created_at,updated_at)
        VALUES(gen_random_uuid(), ${decision.title.trim()}, ${decision.description?.trim() || null}, ${decision.documentTypeId}::uuid, NULL, 1, true, ${finalName}, ${item.original_name}, ${item.mime_type}, ${item.file_size}, ${userEmail}, now(), now())
        RETURNING id::text AS id`;
      const documentId = docRows[0].id;
      await tx.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CREATE','Document',${documentId},${userEmail},now())`;

      let contractId: string | undefined;
      let licenseId: string | undefined;

      if (decision.target === 'contract' || decision.target === 'addendum') {
        const contract = await tx.contract.create({
          data: {
            contractNumber:   decision.entityNumber!,
            startDate:        new Date(decision.startDate!),
            endDate:          decision.endDate ? new Date(decision.endDate) : null,
            vendorId:         decision.vendorId!,
            parentContractId: decision.target === 'addendum' ? decision.parentContractId! : null,
            ...(decision.ciIds && decision.ciIds.length > 0 && { cis: { connect: decision.ciIds.map((id) => ({ id })) } }),
          },
        });
        contractId = contract.id;
        await tx.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CREATE','Contract',${contractId}::uuid,${userEmail},now())`;
        await tx.$executeRaw`INSERT INTO "document_contracts"(id,document_id,contract_id) VALUES(gen_random_uuid(),${documentId}::uuid,${contractId}::uuid) ON CONFLICT DO NOTHING`;
      } else if (decision.target === 'license') {
        const license = await tx.license.create({
          data: {
            name:          decision.licenseName!,
            licenseNumber: decision.entityNumber!,
            vendorId:      decision.vendorId ?? null,
            startDate:     new Date(decision.startDate!),
            endDate:       decision.endDate ? new Date(decision.endDate) : null,
            ...(decision.ciIds && decision.ciIds.length > 0 && { cis: { connect: decision.ciIds.map((id) => ({ id })) } }),
          },
        });
        licenseId = license.id;
        await tx.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CREATE','License',${licenseId}::uuid,${userEmail},now())`;
        await tx.$executeRaw`INSERT INTO "document_licenses"(id,document_id,license_id) VALUES(gen_random_uuid(),${documentId}::uuid,${licenseId}::uuid) ON CONFLICT DO NOTHING`;
      }

      // Associate selected CIs with the Document itself (independent of entity links)
      for (const ciId of decision.ciIds ?? []) {
        await tx.$executeRaw`INSERT INTO "document_cis"(id,document_id,ci_id) VALUES(gen_random_uuid(),${documentId}::uuid,${ciId}::uuid) ON CONFLICT DO NOTHING`;
      }

      // Status already set to COMMITTED by the claim above; just record the link.
      await tx.$executeRaw`UPDATE "bulk_import_item" SET committed_document_id=${documentId}::uuid, updated_at=now() WHERE id=${item.id}::uuid`;

      return { documentId, contractId, licenseId };
    });

    // Success: drop the staging copy and queue async indexing.
    try { fs.unlinkSync(stagedPath); } catch {}
    void queueDocumentForIndexing(result.documentId, 1);
    if (result.contractId) { try { void queueForIndexing('contract', await getContractRoot(result.contractId)); } catch {} }
    if (result.licenseId)  { try { void queueForIndexing('license',  await getLicenseRoot(result.licenseId));   } catch {} }
    return result;
  } catch (e) {
    try { fs.unlinkSync(finalPath); } catch {}
    // Surface duplicate contract/license number as a clean message
    if (typeof e === 'object' && e !== null && 'code' in e && (e as { code: string }).code === 'P2002') {
      throw new BulkValidationError('Ya existe un contrato o licencia con ese número');
    }
    throw e;
  }
}

  // ── Multer middleware ─────────────────────────────────────────────────────
  // Multer storage: memory storage so we can validate before writing to disk
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
      if (ALLOWED_EXTENSIONS.has(ext)) {
        cb(null, true);
      } else {
        cb(new Error(`Tipo de archivo no permitido: .${ext}`));
      }
    },
  });

  // Multer for bulk upload: same per-file guards, plus a per-batch file-count cap.
  const bulkUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_SIZE, files: BULK_MAX_FILES },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
      if (ALLOWED_EXTENSIONS.has(ext)) {
        cb(null, true);
      } else {
        cb(new Error(`Tipo de archivo no permitido: .${ext}`));
      }
    },
  });

  /** Runs the bulk multer middleware and converts its errors into clean 400s. */
  function bulkUploadMiddleware(req: Request, res: Response, next: NextFunction): void {
    bulkUpload.array('files', BULK_MAX_FILES)(req, res, (err: unknown) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            res.status(400).json({ error: `Cada fichero debe ser ≤ ${MAX_DOCUMENT_SIZE_MB} MB` }); return;
          }
          if (err.code === 'LIMIT_FILE_COUNT') {
            res.status(400).json({ error: `Máximo ${BULK_MAX_FILES} ficheros por lote` }); return;
          }
          res.status(400).json({ error: 'Error al procesar la subida' }); return;
        }
        res.status(400).json({ error: (err as Error).message || 'Tipo de archivo no permitido' }); return;
      }
      next();
    });
  }

  const router = Router();

  // ── Documents CRUD ────────────────────────────────────────────────────────────

  // GET /api/documents — list root documents with latest version info
  router.get('/', authenticateToken, async (req, res) => {
    const rawLimit = parseInt(String(req.query.limit ?? '200'), 10);
    const limit    = Math.min(isNaN(rawLimit) || rawLimit < 1 ? 200 : rawLimit, DOCS_MAX_PAGE_SIZE);
    const rawPage  = parseInt(String(req.query.page  ?? '1'),   10);
    const page     = isNaN(rawPage) || rawPage < 1 ? 1 : rawPage;
    const offset   = (page - 1) * limit;
    const visCol = Prisma.raw(`"${docVisibilitySqlCol(req.user!.role)}"`);
    try {
      const [countRows, rows] = await Promise.all([
        prisma.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*) AS c FROM "documents" WHERE root_id IS NULL AND ${visCol} = true`,
        prisma.$queryRaw<{
          id: string; title: string; description: string | null;
          documentTypeId: string; documentTypeName: string; documentTypeCode: string;
          versionNumber: number; originalName: string; mimeType: string;
          fileSize: number; uploadedBy: string; createdAt: Date;
          latestVersionId: string;
        }[]>`
          SELECT d.id::text AS id, d.title, d.description,
                 d.document_type_id::text AS "documentTypeId",
                 dt.name AS "documentTypeName", dt.code AS "documentTypeCode",
                 COALESCE(v.version_number, d.version_number) AS "versionNumber",
                 COALESCE(v.original_name, d.original_name) AS "originalName",
                 COALESCE(v.mime_type, d.mime_type) AS "mimeType",
                 COALESCE(v.file_size, d.file_size) AS "fileSize",
                 COALESCE(v.uploaded_by, d.uploaded_by) AS "uploadedBy",
                 d.created_at AS "createdAt",
                 COALESCE(v.id::text, d.id::text) AS "latestVersionId"
          FROM "documents" d
          JOIN "document_types" dt ON d.document_type_id = dt.id
          LEFT JOIN "documents" v ON v.root_id = d.id AND v.is_latest = true
          WHERE d.root_id IS NULL AND d.${visCol} = true
          ORDER BY d.created_at DESC
          LIMIT ${limit} OFFSET ${offset}`,
      ]);
      res.json({ total: Number(countRows[0]?.c ?? 0), page, limit, data: rows });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  // GET /api/documents/:id — document detail with versions, relations, associations
  router.get('/:id', authenticateToken, requireUuidParam('id'), async (req, res) => {
    const visCol = Prisma.raw(`"${docVisibilitySqlCol(req.user!.role)}"`);
    try {
      const rows = await prisma.$queryRaw<{
        id: string; title: string; description: string | null;
        documentTypeId: string; documentTypeName: string; documentTypeCode: string;
        rootId: string | null; versionNumber: number; isLatest: boolean;
        fileName: string; originalName: string; mimeType: string;
        fileSize: number; uploadedBy: string; createdAt: Date;
      }[]>`
        SELECT d.id::text AS id, d.title, d.description,
               d.document_type_id::text AS "documentTypeId",
               dt.name AS "documentTypeName", dt.code AS "documentTypeCode",
               d.root_id::text AS "rootId", d.version_number AS "versionNumber",
               d.is_latest AS "isLatest", d.file_name AS "fileName",
               d.original_name AS "originalName", d.mime_type AS "mimeType",
               d.file_size AS "fileSize", d.uploaded_by AS "uploadedBy",
               d.created_at AS "createdAt"
        FROM "documents" d
        JOIN "document_types" dt ON d.document_type_id = dt.id
        JOIN "documents" root ON root.id = COALESCE(d.root_id, d.id)
        WHERE d.id = ${req.params.id}::uuid AND root.${visCol} = true`;
      if (!rows.length) { res.status(404).json({ error: 'Document not found' }); return; }
      const doc = rows[0];

      // Root id for version queries
      const rootId = doc.rootId ?? doc.id;

      const [versions, relations, cis, contracts, notes] = await Promise.all([
        // All versions of this document tree
        prisma.$queryRaw<{ id: string; versionNumber: number; isLatest: boolean; originalName: string; mimeType: string; uploadedBy: string; createdAt: Date }[]>`
          SELECT id::text AS id, version_number AS "versionNumber", is_latest AS "isLatest",
                 original_name AS "originalName", mime_type AS "mimeType", uploaded_by AS "uploadedBy", created_at AS "createdAt"
          FROM "documents"
          WHERE (root_id = ${rootId}::uuid OR id = ${rootId}::uuid)
          ORDER BY version_number ASC`,
        // Document relations
        prisma.$queryRaw<{ id: string; targetDocId: string; targetTitle: string; relationType: string }[]>`
          SELECT dr.id::text AS id, dr.target_doc_id::text AS "targetDocId",
                 td.title AS "targetTitle", dr.relation_type AS "relationType"
          FROM "document_relations" dr
          JOIN "documents" td ON dr.target_doc_id = td.id
          WHERE dr.source_doc_id = ${rootId}::uuid`,
        // Associated CIs
        prisma.$queryRaw<{ ciId: string; ciName: string; ciSlug: string }[]>`
          SELECT dc.ci_id::text AS "ciId", ci.name AS "ciName", ci.api_slug AS "ciSlug"
          FROM "document_cis" dc
          JOIN "configuration_items" ci ON dc.ci_id = ci.id
          WHERE dc.document_id = ${rootId}::uuid`,
        // Associated Contracts
        prisma.$queryRaw<{ contractId: string; contractNumber: string }[]>`
          SELECT dco.contract_id::text AS "contractId", c.contract_number AS "contractNumber"
          FROM "document_contracts" dco
          JOIN "contracts" c ON dco.contract_id = c.id
          WHERE dco.document_id = ${rootId}::uuid`,
        // Notes
        prisma.$queryRaw<{ id: string; content: string; createdBy: string; createdAt: Date }[]>`
          SELECT id::text AS id, content, created_by AS "createdBy", created_at AS "createdAt"
          FROM "document_notes"
          WHERE document_id = ${rootId}::uuid
          ORDER BY created_at ASC`,
      ]);

      res.json({ ...doc, versions, relations, cis, contracts, notes });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  // POST /api/documents — upload new document
  router.post('/', authenticateToken, requireAdmin, upload.single('file'), async (req: Request, res: Response) => {
    if (!req.file) { res.status(400).json({ error: 'File required' }); return; }

    const ext = path.extname(req.file.originalname).toLowerCase().replace('.', '');
    if (!validateMagicBytes(req.file.buffer, ext)) {
      res.status(400).json({ error: 'El contenido del archivo no coincide con la extensión declarada' });
      return;
    }

    const { title, description, documentTypeId, ciIds, contractIds } = req.body as {
      title?: string; description?: string; documentTypeId?: string;
      ciIds?: string; contractIds?: string;
    };

    if (!title?.trim() || !documentTypeId) {
      res.status(400).json({ error: 'title and documentTypeId required' });
      return;
    }

    // Store with UUID-based filename (prevents path traversal / enumeration)
    const storedFileName = `${crypto.randomUUID()}.${ext}`;
    const filePath = path.join(DOCUMENTS_DIR, storedFileName);

    try {
      fs.writeFileSync(filePath, req.file.buffer);
    } catch {
      res.status(500).json({ error: 'Error saving file' });
      return;
    }

    try {
      // Plugin pre-hook — may cancel upload
      const preCreateDocument = await emitHook('preCreateDocument', { body: req.body, user: req.user }, 'pre');
      if (preCreateDocument?.cancel) {
        res.status(409).json({ error: preCreateDocument.reason ?? 'Blocked by plugin' });
        return;
      }

      const parsedCiIds: string[] = ciIds ? JSON.parse(ciIds) : [];
      const parsedContractIds: string[] = contractIds ? JSON.parse(contractIds) : [];

      const rows = await prisma.$queryRaw<{ id: string }[]>`
        INSERT INTO "documents"(id,title,description,document_type_id,root_id,version_number,is_latest,file_name,original_name,mime_type,file_size,uploaded_by,created_at,updated_at)
        VALUES(gen_random_uuid(),${title.trim()},${description?.trim() || null},${documentTypeId}::uuid,NULL,1,true,${storedFileName},${req.file.originalname},${req.file.mimetype},${req.file.size},${req.user!.email},now(),now())
        RETURNING id::text AS id`;

      const docId = rows[0].id;

      // Create CI associations
      for (const ciId of parsedCiIds) {
        await prisma.$executeRaw`INSERT INTO "document_cis"(id,document_id,ci_id) VALUES(gen_random_uuid(),${docId}::uuid,${ciId}::uuid) ON CONFLICT DO NOTHING`;
      }
      // Create Contract associations
      for (const contractId of parsedContractIds) {
        await prisma.$executeRaw`INSERT INTO "document_contracts"(id,document_id,contract_id) VALUES(gen_random_uuid(),${docId}::uuid,${contractId}::uuid) ON CONFLICT DO NOTHING`;
      }

      // Audit log
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CREATE','Document',${docId},${req.user!.email},now())`;

      void queueDocumentForIndexing(docId, 1);

      // Plugin post-hook — fire-and-forget, must not fail the response
      try { await emitHook('postCreateDocument', { id: docId, body: req.body, user: req.user }); } catch(e) { console.error('[plugin-hook] postCreateDocument', e); }

      res.status(201).json({ id: docId });
    } catch (e) {
      // Clean up uploaded file on DB error
      try { fs.unlinkSync(filePath); } catch {}
      console.error(e);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PATCH /api/documents/:id — update metadata (title, description, type)
  router.patch('/:id', authenticateToken, requireAdmin, requireUuidParam('id'), async (req, res) => {
    const { title, description, documentTypeId } = req.body as { title?: string; description?: string; documentTypeId?: string };
    if (!title?.trim()) { res.status(400).json({ error: 'title required' }); return; }
    try {
      const rows = await prisma.$queryRaw<{ id: string }[]>`
        UPDATE "documents" SET title=${title.trim()}, description=${description?.trim() || null},
          document_type_id=COALESCE(${documentTypeId || null}::uuid, document_type_id), updated_at=now()
        WHERE id=${req.params.id}::uuid RETURNING id::text AS id`;
      if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'UPDATE','Document',${req.params.id},${req.user!.email},now())`;
      res.json({ ok: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  // PATCH /api/documents/:id/acl — update role-based visibility flags (ADMIN only)
  router.patch('/:id/acl', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const { readAdmin, readAuditor, readViewer } = req.body as { readAdmin?: boolean; readAuditor?: boolean; readViewer?: boolean };
    if (readAdmin === undefined && readAuditor === undefined && readViewer === undefined) {
      res.status(400).json({ error: 'At least one ACL field required' }); return;
    }
    for (const [k, v] of Object.entries({ readAdmin, readAuditor, readViewer })) {
      if (v !== undefined && typeof v !== 'boolean') {
        res.status(400).json({ error: `${k} must be a boolean` }); return;
      }
    }
    try {
      const updates: Prisma.Sql[] = [];
      if (readAdmin !== undefined)   updates.push(Prisma.sql`read_admin = ${readAdmin}`);
      if (readAuditor !== undefined) updates.push(Prisma.sql`read_auditor = ${readAuditor}`);
      if (readViewer !== undefined)  updates.push(Prisma.sql`read_viewer = ${readViewer}`);
      const setClause = Prisma.join(updates, ', ');

      const rows = await prisma.$queryRaw<{ id: string }[]>`
        UPDATE "documents"
        SET ${setClause}, updated_at = now()
        WHERE id = ${req.params.id}::uuid AND root_id IS NULL
        RETURNING id::text AS id`;
      if (!rows.length) { res.status(404).json({ error: 'Document not found' }); return; }
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at)
        VALUES(gen_random_uuid(),'UPDATE_DOC_ACL','Document',${req.params.id}::uuid,${req.user!.email},now())`;
      res.json({ id: rows[0].id, readAdmin: readAdmin ?? null, readAuditor: readAuditor ?? null, readViewer: readViewer ?? null });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  // DELETE /api/documents/:id — delete document (and file from disk)
  router.delete('/:id', authenticateToken, requireAdmin, requireUuidParam('id'), async (req, res) => {
    try {
      const rows = await prisma.$queryRaw<{ file_name: string; root_id: string | null }[]>`
        SELECT file_name, root_id::text AS root_id FROM "documents" WHERE id=${req.params.id}::uuid`;
      if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }

      await prisma.$executeRaw`DELETE FROM "documents" WHERE id=${req.params.id}::uuid`;

      // Delete file from disk
      const filePath = path.join(DOCUMENTS_DIR, rows[0].file_name);
      try { fs.unlinkSync(filePath); } catch {}

      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'DELETE','Document',${req.params.id},${req.user!.email},now())`;
      res.json({ ok: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  // POST /api/documents/:id/reindex — force re-queue the latest version for RAG indexing (ADMIN only)
  router.post('/:id/reindex', authenticateToken, requireAdmin, requireUuidParam('id'), async (req, res) => {
    try {
      const rows = await prisma.$queryRaw<{ id: string; version_number: number }[]>`
        SELECT id::text AS id, version_number FROM "documents"
        WHERE (id=${req.params.id}::uuid OR root_id=${req.params.id}::uuid) AND is_latest=true
        LIMIT 1`;
      if (!rows.length) { res.status(404).json({ error: 'Document not found' }); return; }
      await queueDocumentForIndexing(rows[0].id, rows[0].version_number);
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at)
        VALUES(gen_random_uuid(),'REINDEX_DOC','Document',${req.params.id}::uuid,${req.user!.email},now())`;
      res.json({ ok: true, queued: rows[0].id });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  // ─── Bulk Document Import (staging) ───────────────────────────────────────────
  // ADMIN-only multi-file upload → staging area. The AI worker (processBulkImport-
  // Queue) analyzes each file; the user then reviews/corrects and materializes
  // real Document/Contract/License records line by line via the commit endpoints.

  // POST /api/documents/bulk/batches — upload N files into a new staging batch
  router.post('/bulk/batches', authenticateToken, requireAdmin, bulkUploadMiddleware, async (req: Request, res: Response) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) { res.status(400).json({ error: 'Se requiere al menos un fichero' }); return; }

    // Per-batch total-size guard (per-file size + count already enforced by multer)
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    if (totalBytes > BULK_MAX_TOTAL_BYTES) {
      res.status(400).json({ error: `El lote supera el máximo de ${Math.floor(BULK_MAX_TOTAL_BYTES / (1024 * 1024))} MB` });
      return;
    }

    // Enforce concurrent-batch limit per user (prevents staging exhaustion / DoS).
    // Terminal states (COMMITTED, DISCARDED, REAPED) do not count toward the limit.
    try {
      const openRows = await prisma.$queryRaw<{ c: bigint }[]>`
        SELECT COUNT(*) AS c FROM "bulk_import_batch"
        WHERE created_by = ${req.user!.email}
          AND status NOT IN ('COMMITTED','DISCARDED','REAPED')`;
      const open = Number(openRows[0]?.c ?? 0);
      if (open >= BULK_MAX_OPEN_BATCHES) {
        res.status(429).json({
          error: `Has alcanzado el límite de ${BULK_MAX_OPEN_BATCHES} lotes abiertos simultáneos. Confirma o descarta alguno antes de subir uno nuevo.`,
          openBatches: open,
          maxBatches: BULK_MAX_OPEN_BATCHES,
        });
        return;
      }
      // Per-user staging-bytes cap: bounds peak disk usage across all open batches.
      const bytesRows = await prisma.$queryRaw<{ used: bigint }[]>`
        SELECT COALESCE(SUM(total_bytes), 0) AS used FROM "bulk_import_batch"
        WHERE created_by = ${req.user!.email}
          AND status NOT IN ('COMMITTED','DISCARDED','REAPED')`;
      const usedBytes = Number(bytesRows[0]?.used ?? 0);
      if (usedBytes + totalBytes > BULK_MAX_USER_STAGING_BYTES) {
        const maxMb = Math.floor(BULK_MAX_USER_STAGING_BYTES / (1024 * 1024));
        const usedMb = Math.floor(usedBytes / (1024 * 1024));
        res.status(429).json({
          error: `El almacenamiento temporal de tus lotes abiertos superaría el límite de ${maxMb} MB (en uso: ${usedMb} MB). Confirma o descarta algún lote primero.`,
          usedBytes,
          maxBytes: BULK_MAX_USER_STAGING_BYTES,
        });
        return;
      }
    } catch (e) { console.error('[POST /api/documents/bulk/batches] limit check error:', e); }

    // Validate magic bytes for EVERY file before writing anything to disk
    for (const f of files) {
      const ext = path.extname(f.originalname).toLowerCase().replace('.', '');
      if (!validateMagicBytes(f.buffer, ext)) {
        res.status(400).json({ error: `El contenido de "${f.originalname}" no coincide con su extensión declarada` });
        return;
      }
    }

    try { fs.mkdirSync(STAGING_DIR, { recursive: true }); }
    catch { res.status(500).json({ error: 'Error preparando el almacenamiento' }); return; }

    const written: string[] = [];
    let batchId: string | null = null;
    try {
      const batchRows = await prisma.$queryRaw<{ id: string }[]>`
        INSERT INTO "bulk_import_batch"(id, created_by, status, file_count, total_bytes, created_at, updated_at)
        VALUES(gen_random_uuid(), ${req.user!.email}, 'UPLOADED', ${files.length}, ${totalBytes}, now(), now())
        RETURNING id::text AS id`;
      batchId = batchRows[0].id;

      for (const f of files) {
        const ext = path.extname(f.originalname).toLowerCase().replace('.', '');
        const stagedName = `${crypto.randomUUID()}.${ext}`;
        fs.writeFileSync(path.join(STAGING_DIR, stagedName), f.buffer);
        written.push(stagedName);
        await prisma.$executeRaw`
          INSERT INTO "bulk_import_item"(id, batch_id, staged_file_name, original_name, mime_type, file_size, status, analysis, created_at, updated_at)
          VALUES(gen_random_uuid(), ${batchId}::uuid, ${stagedName}, ${f.originalname}, ${f.mimetype}, ${f.size}, 'PENDING_ANALYSIS', '{}'::jsonb, now(), now())`;
      }

      await prisma.$executeRaw`
        INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, details, created_at)
        VALUES(gen_random_uuid(), 'BULK_UPLOAD', 'BulkImportBatch', ${batchId}::uuid, ${req.user!.email},
               ${JSON.stringify({ fileCount: files.length, totalBytes })}::jsonb, now())`;

      res.status(201).json({ batchId, fileCount: files.length });
    } catch (e) {
      for (const name of written) { try { fs.unlinkSync(path.join(STAGING_DIR, name)); } catch {} }
      if (batchId) { try { await prisma.$executeRaw`DELETE FROM "bulk_import_batch" WHERE id=${batchId}::uuid`; } catch {} }
      console.error('[POST /api/documents/bulk/batches]', e);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/documents/bulk/batches — list the caller's batches (most recent first)
  router.get('/bulk/batches', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
    try {
      const [countRows, rows] = await Promise.all([
        prisma.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*) AS c FROM "bulk_import_batch" WHERE created_by = ${req.user!.email}`,
        prisma.$queryRaw<{ id: string; status: string; fileCount: number; totalBytes: string; createdAt: Date; committed: bigint; pending: bigint; errors: bigint; warnings: bigint }[]>`
          SELECT b.id::text AS id, b.status, b.file_count AS "fileCount", b.total_bytes::text AS "totalBytes",
                 b.created_at AS "createdAt",
                 COUNT(i.id) FILTER (WHERE i.status = 'COMMITTED') AS committed,
                 COUNT(i.id) FILTER (WHERE i.status IN ('PENDING_ANALYSIS','ANALYZING')) AS pending,
                 COUNT(i.id) FILTER (WHERE i.status = 'ERROR') AS errors,
                 COUNT(i.id) FILTER (WHERE i.status = 'WARNING') AS warnings
          FROM "bulk_import_batch" b
          LEFT JOIN "bulk_import_item" i ON i.batch_id = b.id
          WHERE b.created_by = ${req.user!.email}
          GROUP BY b.id
          ORDER BY b.created_at DESC
          LIMIT 100`,
      ]);
      const total = Number(countRows[0]?.c ?? 0);
      res.json({ total, truncated: total > 100, batches: rows.map((r) => ({ ...r, totalBytes: Number(r.totalBytes), committed: Number(r.committed), pending: Number(r.pending), errors: Number(r.errors), warnings: Number(r.warnings) })) });
    } catch (e) { console.error('[GET /api/documents/bulk/batches]', e); res.status(500).json({ error: 'Internal server error' }); }
  });

  // GET /api/documents/bulk/batches/:id — batch detail + items (polling target)
  router.get('/bulk/batches/:id', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    try {
      const batchRows = await prisma.$queryRaw<{ id: string; status: string; fileCount: number; totalBytes: string; createdBy: string; createdAt: Date }[]>`
        SELECT id::text AS id, status, file_count AS "fileCount", total_bytes::text AS "totalBytes",
               created_by AS "createdBy", created_at AS "createdAt"
        FROM "bulk_import_batch"
        WHERE id = ${req.params.id}::uuid AND created_by = ${req.user!.email}
        LIMIT 1`;
      if (!batchRows.length) { res.status(404).json({ error: 'Batch not found' }); return; }

      const items = await prisma.$queryRaw<{ id: string; originalName: string; mimeType: string; fileSize: number; status: string; analysis: unknown; errorMessage: string | null; committedDocumentId: string | null; createdAt: Date }[]>`
        SELECT id::text AS id, original_name AS "originalName", mime_type AS "mimeType",
               file_size AS "fileSize", status, analysis, error_message AS "errorMessage",
               committed_document_id::text AS "committedDocumentId", created_at AS "createdAt"
        FROM "bulk_import_item"
        WHERE batch_id = ${req.params.id}::uuid
        ORDER BY created_at ASC`;

      res.json({ ...batchRows[0], totalBytes: Number(batchRows[0].totalBytes), items });
    } catch (e) { console.error('[GET /api/documents/bulk/batches/:id]', e); res.status(500).json({ error: 'Internal server error' }); }
  });

  // DELETE /api/documents/bulk/items/:id — discard a single staged item
  router.delete('/bulk/items/:id', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    try {
      const rows = await prisma.$queryRaw<{ stagedFileName: string; status: string }[]>`
        SELECT i.staged_file_name AS "stagedFileName", i.status
        FROM "bulk_import_item" i
        JOIN "bulk_import_batch" b ON b.id = i.batch_id
        WHERE i.id = ${req.params.id}::uuid AND b.created_by = ${req.user!.email}
        LIMIT 1`;
      if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
      if (rows[0].status !== 'COMMITTED') {
        try { fs.unlinkSync(path.join(STAGING_DIR, path.basename(rows[0].stagedFileName))); } catch {}
      }
      await prisma.$executeRaw`DELETE FROM "bulk_import_item" WHERE id = ${req.params.id}::uuid`;
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'BULK_DISCARD_ITEM','BulkImportItem',${req.params.id}::uuid,${req.user!.email},now())`;
      res.json({ ok: true });
    } catch (e) { console.error('[DELETE /api/documents/bulk/items/:id]', e); res.status(500).json({ error: 'Internal server error' }); }
  });

  // DELETE /api/documents/bulk/batches/:id — discard a whole batch (+ staged files)
  router.delete('/bulk/batches/:id', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    try {
      const batch = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM "bulk_import_batch"
        WHERE id = ${req.params.id}::uuid AND created_by = ${req.user!.email} LIMIT 1`;
      if (!batch.length) { res.status(404).json({ error: 'Not found' }); return; }

      const items = await prisma.$queryRaw<{ stagedFileName: string }[]>`
        SELECT staged_file_name AS "stagedFileName" FROM "bulk_import_item"
        WHERE batch_id = ${req.params.id}::uuid AND status != 'COMMITTED'`;
      for (const it of items) {
        try { fs.unlinkSync(path.join(STAGING_DIR, path.basename(it.stagedFileName))); } catch {}
      }

      await prisma.$executeRaw`DELETE FROM "bulk_import_batch" WHERE id = ${req.params.id}::uuid`;
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'BULK_DISCARD_BATCH','BulkImportBatch',${req.params.id}::uuid,${req.user!.email},now())`;
      res.json({ ok: true });
    } catch (e) { console.error('[DELETE /api/documents/bulk/batches/:id]', e); res.status(500).json({ error: 'Internal server error' }); }
  });

  // PATCH /api/documents/bulk/items/:id — persist the user's reviewed decision
  router.patch('/bulk/items/:id', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    const parsed = BulkItemDecisionBase.partial().safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Datos inválidos' }); return; }
    try {
      const rows = await prisma.$queryRaw<{ id: string; status: string }[]>`
        SELECT i.id::text AS id, i.status
        FROM "bulk_import_item" i JOIN "bulk_import_batch" b ON b.id = i.batch_id
        WHERE i.id = ${req.params.id}::uuid AND b.created_by = ${req.user!.email} LIMIT 1`;
      if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
      if (rows[0].status === 'COMMITTED') { res.status(409).json({ error: 'El elemento ya fue confirmado' }); return; }
      await prisma.$executeRaw`
        UPDATE "bulk_import_item"
        SET analysis = jsonb_set(COALESCE(analysis, '{}'::jsonb), '{decision}', ${JSON.stringify(parsed.data)}::jsonb, true),
            updated_at = now()
        WHERE id = ${req.params.id}::uuid`;
      res.json({ ok: true });
    } catch (e) { console.error('[PATCH /api/documents/bulk/items/:id]', e); res.status(500).json({ error: 'Internal server error' }); }
  });

  // POST /api/documents/bulk/items/:id/commit — materialize one reviewed item
  router.post('/bulk/items/:id/commit', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    try {
      const rows = await prisma.$queryRaw<(BulkItemRow & { analysis: unknown })[]>`
        SELECT i.id::text AS id, i.batch_id::text AS batch_id, i.staged_file_name AS staged_file_name,
               i.original_name AS original_name, i.mime_type AS mime_type, i.file_size AS file_size,
               i.status, i.analysis
        FROM "bulk_import_item" i JOIN "bulk_import_batch" b ON b.id = i.batch_id
        WHERE i.id = ${req.params.id}::uuid AND b.created_by = ${req.user!.email} LIMIT 1`;
      if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
      const item = rows[0];

      // Prefer the decision in the request body; fall back to the persisted one.
      const source = req.body && Object.keys(req.body).length > 0
        ? req.body
        : (item.analysis as { decision?: unknown } | null)?.decision;
      const parsed = BulkItemDecisionSchema.safeParse(source);
      if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Decisión inválida' }); return; }

      const result = await materializeBulkItem(item, parsed.data, req.user!.email);
      await recomputeBatchStatus(prisma, item.batch_id);
      res.status(201).json(result);
    } catch (e) {
      if (e instanceof BulkValidationError) { res.status(400).json({ error: e.message }); return; }
      console.error('[POST /api/documents/bulk/items/:id/commit]', e);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/documents/bulk/batches/:id/commit — commit every reviewed item at once
  router.post('/bulk/batches/:id/commit', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    try {
      const batch = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM "bulk_import_batch"
        WHERE id = ${req.params.id}::uuid AND created_by = ${req.user!.email} LIMIT 1`;
      if (!batch.length) { res.status(404).json({ error: 'Not found' }); return; }

      const items = await prisma.$queryRaw<(BulkItemRow & { analysis: unknown })[]>`
        SELECT i.id::text AS id, i.batch_id::text AS batch_id, i.staged_file_name AS staged_file_name,
               i.original_name AS original_name, i.mime_type AS mime_type, i.file_size AS file_size,
               i.status, i.analysis
        FROM "bulk_import_item" i
        WHERE i.batch_id = ${req.params.id}::uuid AND i.status IN ('ANALYZED','ERROR','WARNING')
        ORDER BY i.created_at ASC`;

      const results: { itemId: string; ok: boolean; documentId?: string; error?: string }[] = [];
      for (const item of items) {
        const decision = (item.analysis as { decision?: unknown } | null)?.decision;
        const parsed = BulkItemDecisionSchema.safeParse(decision);
        if (!parsed.success) { results.push({ itemId: item.id, ok: false, error: parsed.error.issues[0]?.message ?? 'Decisión incompleta' }); continue; }
        try {
          const r = await materializeBulkItem(item, parsed.data, req.user!.email);
          results.push({ itemId: item.id, ok: true, documentId: r.documentId });
        } catch (e) {
          results.push({ itemId: item.id, ok: false, error: e instanceof BulkValidationError ? e.message : 'Error interno' });
        }
      }
      await recomputeBatchStatus(prisma, req.params.id as string);
      res.json({ results });
    } catch (e) { console.error('[POST /api/documents/bulk/batches/:id/commit]', e); res.status(500).json({ error: 'Internal server error' }); }
  });

  // POST /api/documents/bulk/items/:id/reanalyze — flip one ANALYZED/ERROR item back
  // to PENDING_ANALYSIS so the worker re-processes it (useful after OCR or other
  // pipeline improvements that landed AFTER the original analysis).
  router.post('/bulk/items/:id/reanalyze', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    try {
      const rows = await prisma.$queryRaw<{ id: string; batch_id: string }[]>`
        SELECT i.id::text AS id, i.batch_id::text AS batch_id
        FROM "bulk_import_item" i JOIN "bulk_import_batch" b ON b.id = i.batch_id
        WHERE i.id = ${req.params.id}::uuid AND b.created_by = ${req.user!.email}
          AND i.status IN ('ANALYZED','ERROR','WARNING') LIMIT 1`;
      if (!rows.length) { res.status(404).json({ error: 'Not found or not re-analyzable' }); return; }
      await prisma.$executeRaw`
        UPDATE "bulk_import_item" SET status='PENDING_ANALYSIS', error_message=NULL, updated_at=now()
        WHERE id = ${req.params.id}::uuid`;
      await recomputeBatchStatus(prisma, rows[0].batch_id);
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'BULK_REANALYZE_ITEM','BulkImportItem',${req.params.id}::uuid,${req.user!.email},now())`;
      res.json({ ok: true });
    } catch (e) { console.error('[POST /api/documents/bulk/items/:id/reanalyze]', e); res.status(500).json({ error: 'Internal server error' }); }
  });

  // POST /api/documents/bulk/batches/:id/reanalyze — re-queue every ANALYZED/ERROR
  // item in the batch (committed items are skipped). Returns how many were queued.
  router.post('/bulk/batches/:id/reanalyze', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
    try {
      const batch = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM "bulk_import_batch"
        WHERE id = ${req.params.id}::uuid AND created_by = ${req.user!.email} LIMIT 1`;
      if (!batch.length) { res.status(404).json({ error: 'Not found' }); return; }
      const result = await prisma.$executeRaw`
        UPDATE "bulk_import_item" SET status='PENDING_ANALYSIS', error_message=NULL, updated_at=now()
        WHERE batch_id = ${req.params.id}::uuid AND status IN ('ANALYZED','ERROR','WARNING')`;
      const count = Number(result);
      await recomputeBatchStatus(prisma, req.params.id as string);
      await prisma.$executeRaw`
        INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at)
        VALUES(gen_random_uuid(),'BULK_REANALYZE_BATCH','BulkImportBatch',${req.params.id}::uuid,${req.user!.email},
               ${JSON.stringify({ count })}::jsonb, now())`;
      res.json({ ok: true, count });
    } catch (e) { console.error('[POST /api/documents/bulk/batches/:id/reanalyze]', e); res.status(500).json({ error: 'Internal server error' }); }
  });

  // GET /api/documents/:id/index-status — return the latest version's RAG indexing status
  router.get('/:id/index-status', authenticateToken, requireUuidParam('id'), async (req: Request, res: Response) => {
    try {
      const rows = await prisma.$queryRaw<{ status: string | null; chunk_count: number | null; indexed_at: Date | null; error_message: string | null; updated_at: Date | null }[]>`
        SELECT r.status, r.chunk_count, r.indexed_at, r.error_message, r.updated_at
        FROM "documents" d
        LEFT JOIN "rag_document_index" r
          ON r.document_id = d.id AND r.version_number = d.version_number
        WHERE (d.id = ${req.params.id}::uuid OR d.root_id = ${req.params.id}::uuid)
          AND d.is_latest = true
        LIMIT 1`;
      if (!rows.length) { res.status(404).json({ error: 'Document not found' }); return; }
      const r = rows[0];
      res.json({
        status:        r.status ?? 'NOT_INDEXED',
        chunkCount:    r.chunk_count   ?? 0,
        indexedAt:     r.indexed_at,
        errorMessage:  r.error_message,
        updatedAt:     r.updated_at,
      });
    } catch (e) { console.error('[GET /api/documents/:id/index-status]', e); res.status(500).json({ error: 'Internal server error' }); }
  });


  // GET /api/documents/:id/download — authenticated file download
  // Uses authenticateToken middleware (checks JWT + deactivated-user status in DB)
  // Supports ?inline=true to display in browser instead of triggering download
  router.get('/:id/download', authenticateToken, requireUuidParam('id'), async (req: Request, res: Response) => {
    // Support ?inline=true to display in browser instead of download
    const inline = req.query.inline === 'true';

    // Allowlist of MIME types safe to render inline in a browser context.
    // Everything else is forced to attachment/octet-stream to prevent stored XSS
    // (e.g. SVG files can execute embedded JavaScript when served inline as image/svg+xml).
    const SAFE_INLINE_MIME_TYPES = new Set([
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
    ]);

    const visCol = Prisma.raw(`"${docVisibilitySqlCol(req.user!.role)}"`);
    try {
      const rows = await prisma.$queryRaw<{ file_name: string; original_name: string; mime_type: string }[]>`
        SELECT d.file_name, d.original_name, d.mime_type
        FROM "documents" d
        JOIN "documents" root ON root.id = COALESCE(d.root_id, d.id)
        WHERE d.id = ${req.params.id}::uuid AND root.${visCol} = true`;
      if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
      const { file_name, original_name, mime_type } = rows[0];
      const filePath = path.join(DOCUMENTS_DIR, file_name);
      if (!fs.existsSync(filePath)) { res.status(404).json({ error: 'File not found on disk' }); return; }

      const serveInline = inline && SAFE_INLINE_MIME_TYPES.has(mime_type);
      const contentType = serveInline ? mime_type : 'application/octet-stream';
      const disposition = serveInline ? 'inline' : `attachment; filename="${encodeURIComponent(original_name)}"`;

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', disposition);
      // Extra defence: prevent browser from sniffing a different MIME type
      res.setHeader('X-Content-Type-Options', 'nosniff');
      fs.createReadStream(filePath).pipe(res as unknown as NodeJS.WritableStream);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  // POST /api/documents/:id/versions — upload new version
  router.post('/:id/versions', authenticateToken, requireAdmin, requireUuidParam('id'), upload.single('file'), async (req: Request, res: Response) => {
    if (!req.file) { res.status(400).json({ error: 'File required' }); return; }

    const ext = path.extname(req.file.originalname).toLowerCase().replace('.', '');
    if (!validateMagicBytes(req.file.buffer, ext)) {
      res.status(400).json({ error: 'El contenido del archivo no coincide con la extensión declarada' });
      return;
    }

    try {
      // Find the root document
      const rootRows = await prisma.$queryRaw<{ id: string; root_id: string | null }[]>`
        SELECT id::text AS id, root_id::text AS root_id FROM "documents" WHERE id=${req.params.id}::uuid`;
      if (!rootRows.length) { res.status(404).json({ error: 'Document not found' }); return; }

      const rootId = rootRows[0].root_id ?? rootRows[0].id;

      // Get current max version number
      const maxRows = await prisma.$queryRaw<{ max: number }[]>`
        SELECT COALESCE(MAX(version_number), 0) AS max FROM "documents"
        WHERE root_id = ${rootId}::uuid OR id = ${rootId}::uuid`;
      const nextVersion = (maxRows[0]?.max ?? 0) + 1;

      // Store file
      const storedFileName = `${crypto.randomUUID()}.${ext}`;
      const filePath = path.join(DOCUMENTS_DIR, storedFileName);
      try {
        fs.writeFileSync(filePath, req.file.buffer);
      } catch {
        res.status(500).json({ error: 'Error saving file' });
        return;
      }

      // Mark previous latest as not latest (only version children, not the root document itself)
      await prisma.$executeRaw`UPDATE "documents" SET is_latest=false WHERE root_id=${rootId}::uuid`;

      // Get document type and title from root
      const metaRows = await prisma.$queryRaw<{ title: string; document_type_id: string }[]>`
        SELECT title, document_type_id::text AS document_type_id FROM "documents" WHERE id=${rootId}::uuid`;

      // Insert new version
      const newRows = await prisma.$queryRaw<{ id: string }[]>`
        INSERT INTO "documents"(id,title,description,document_type_id,root_id,version_number,is_latest,file_name,original_name,mime_type,file_size,uploaded_by,created_at,updated_at)
        VALUES(gen_random_uuid(),${metaRows[0].title},NULL,${metaRows[0].document_type_id}::uuid,${rootId}::uuid,${nextVersion},true,${storedFileName},${req.file.originalname},${req.file.mimetype},${req.file.size},${req.user!.email},now(),now())
        RETURNING id::text AS id`;

      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'VERSION','Document',${newRows[0].id},${req.user!.email},now())`;

      void queueDocumentForIndexing(newRows[0].id, nextVersion);
      res.status(201).json({ id: newRows[0].id, versionNumber: nextVersion });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  // DELETE /api/documents/:rootId/versions/:versionId — delete a specific version
  router.delete('/:rootId/versions/:versionId', authenticateToken, requireAdmin, async (req, res) => {
    try {
      // Fetch the version to delete
      const vRows = await prisma.$queryRaw<{ id: string; root_id: string | null; is_latest: boolean; file_name: string; version_number: number }[]>`
        SELECT id::text AS id, root_id::text AS root_id, is_latest, file_name, version_number
        FROM "documents" WHERE id=${req.params.versionId}::uuid`;
      if (!vRows.length) { res.status(404).json({ error: 'Version not found' }); return; }
      const ver = vRows[0];

      // Cannot delete root document via this endpoint
      if (!ver.root_id) { res.status(400).json({ error: 'Use DELETE /api/documents/:id to delete the root document' }); return; }

      const wasLatest = ver.is_latest;

      // Delete the version record
      await prisma.$executeRaw`DELETE FROM "documents" WHERE id=${req.params.versionId}::uuid`;

      // Delete the file from disk
      try { fs.unlinkSync(path.join(DOCUMENTS_DIR, ver.file_name)); } catch {}

      // If this was the latest version, promote the previous one
      if (wasLatest) {
        const prevRows = await prisma.$queryRaw<{ id: string }[]>`
          SELECT id::text AS id FROM "documents"
          WHERE root_id=${ver.root_id}::uuid
          ORDER BY version_number DESC LIMIT 1`;
        if (prevRows.length) {
          await prisma.$executeRaw`UPDATE "documents" SET is_latest=true WHERE id=${prevRows[0].id}::uuid`;
        }
        // If no more versions, the root document is the current file (is_latest stays true on root)
      }

      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'DELETE_VERSION','Document',${req.params.versionId},${req.user!.email},now())`;
      res.json({ ok: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  // POST /api/documents/:id/relations — add relation to another document
  router.post('/:id/relations', authenticateToken, requireAdmin, requireUuidParam('id'), async (req, res) => {
    const { targetDocId, relationType } = req.body as { targetDocId?: string; relationType?: string };
    if (!targetDocId || !relationType) { res.status(400).json({ error: 'targetDocId and relationType required' }); return; }
    const validTypes = ['AMENDMENT_OF', 'RELATED_TO', 'SUPERSEDES'];
    if (!validTypes.includes(relationType)) { res.status(400).json({ error: 'Invalid relationType' }); return; }
    try {
      await prisma.$executeRaw`
        INSERT INTO "document_relations"(id,source_doc_id,target_doc_id,relation_type,created_at)
        VALUES(gen_random_uuid(),${req.params.id}::uuid,${targetDocId}::uuid,${relationType},now())
        ON CONFLICT DO NOTHING`;
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at) VALUES(gen_random_uuid(),'LINK_DOCUMENT','Document',${req.params.id}::uuid,${req.user!.email},${JSON.stringify({targetDocId,relationType})}::jsonb,now())`;
      res.status(201).json({ ok: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  // DELETE /api/documents/:id/relations/:targetId — remove relation
  router.delete('/:id/relations/:targetId', authenticateToken, requireAdmin, requireUuidParam('id'), async (req, res) => {
    try {
      await prisma.$executeRaw`DELETE FROM "document_relations" WHERE source_doc_id=${req.params.id}::uuid AND target_doc_id=${req.params.targetId}::uuid`;
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at) VALUES(gen_random_uuid(),'UNLINK_DOCUMENT','Document',${req.params.id}::uuid,${req.user!.email},${JSON.stringify({targetDocId:req.params.targetId})}::jsonb,now())`;
      res.json({ ok: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  // POST /api/documents/:id/ci/:ciId — associate document with CI
  router.post('/:id/ci/:ciId', authenticateToken, requireAdmin, requireUuidParam('id'), async (req, res) => {
    try {
      await prisma.$executeRaw`INSERT INTO "document_cis"(id,document_id,ci_id) VALUES(gen_random_uuid(),${req.params.id}::uuid,${req.params.ciId}::uuid) ON CONFLICT DO NOTHING`;
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at) VALUES(gen_random_uuid(),'LINK_DOCUMENT','Document',${req.params.id}::uuid,${req.user!.email},${JSON.stringify({ciId:req.params.ciId})}::jsonb,now())`;
      res.status(201).json({ ok: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  // DELETE /api/documents/:id/ci/:ciId — remove CI association
  router.delete('/:id/ci/:ciId', authenticateToken, requireAdmin, requireUuidParam('id'), async (req, res) => {
    try {
      await prisma.$executeRaw`DELETE FROM "document_cis" WHERE document_id=${req.params.id}::uuid AND ci_id=${req.params.ciId}::uuid`;
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at) VALUES(gen_random_uuid(),'UNLINK_DOCUMENT','Document',${req.params.id}::uuid,${req.user!.email},${JSON.stringify({ciId:req.params.ciId})}::jsonb,now())`;
      res.json({ ok: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  // POST /api/documents/:id/contract/:contractId — associate with contract
  router.post('/:id/contract/:contractId', authenticateToken, requireAdmin, requireUuidParam('id'), async (req, res) => {
    try {
      await prisma.$executeRaw`INSERT INTO "document_contracts"(id,document_id,contract_id) VALUES(gen_random_uuid(),${req.params.id}::uuid,${req.params.contractId}::uuid) ON CONFLICT DO NOTHING`;
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at) VALUES(gen_random_uuid(),'LINK_DOCUMENT','Document',${req.params.id}::uuid,${req.user!.email},${JSON.stringify({contractId:req.params.contractId})}::jsonb,now())`;
      res.status(201).json({ ok: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  // DELETE /api/documents/:id/contract/:contractId — remove contract association
  router.delete('/:id/contract/:contractId', authenticateToken, requireAdmin, requireUuidParam('id'), async (req, res) => {
    try {
      await prisma.$executeRaw`DELETE FROM "document_contracts" WHERE document_id=${req.params.id}::uuid AND contract_id=${req.params.contractId}::uuid`;
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at) VALUES(gen_random_uuid(),'UNLINK_DOCUMENT','Document',${req.params.id}::uuid,${req.user!.email},${JSON.stringify({contractId:req.params.contractId})}::jsonb,now())`;
      res.json({ ok: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  // POST /api/documents/:id/cis — Bulk associate CIs to a document
  router.post('/:id/cis', authenticateToken, requireAdmin, requireUuidParam('id'), async (req, res) => {
    const schema = z.object({ ciIds: z.array(z.string().uuid()).min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'ciIds must be a non-empty array of UUIDs' }); return; }
    const { ciIds } = parsed.data;
    const docId = req.params.id;
    try {
      let associated = 0;
      for (const ciId of ciIds) {
        await prisma.$executeRaw`INSERT INTO "document_cis"(id,document_id,ci_id) VALUES(gen_random_uuid(),${docId}::uuid,${ciId}::uuid) ON CONFLICT DO NOTHING`;
        associated++;
      }
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at) VALUES(gen_random_uuid(),'LINK_DOCUMENT','Document',${docId}::uuid,${req.user!.email},${JSON.stringify({ciIds,count:associated})}::jsonb,now())`;
      res.json({ associated });
    } catch (e) { res.status(500).json({ error: 'Failed to associate CIs to document' }); }
  });

  // POST /api/documents/:id/contracts — Bulk associate contracts to a document
  router.post('/:id/contracts', authenticateToken, requireAdmin, requireUuidParam('id'), async (req, res) => {
    const schema = z.object({ contractIds: z.array(z.string().uuid()).min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'contractIds must be a non-empty array of UUIDs' }); return; }
    const { contractIds } = parsed.data;
    const docId = req.params.id;
    try {
      let associated = 0;
      for (const contractId of contractIds) {
        await prisma.$executeRaw`INSERT INTO "document_contracts"(id,document_id,contract_id) VALUES(gen_random_uuid(),${docId}::uuid,${contractId}::uuid) ON CONFLICT DO NOTHING`;
        associated++;
      }
      await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at) VALUES(gen_random_uuid(),'LINK_DOCUMENT','Document',${docId}::uuid,${req.user!.email},${JSON.stringify({contractIds,count:associated})}::jsonb,now())`;
      res.json({ associated });
    } catch (e) { res.status(500).json({ error: 'Failed to associate contracts to document' }); }
  });

  router.get('/:id/notes', authenticateToken, requireUuidParam('id'), async (req, res) => {
    const visCol = Prisma.raw(`"${docVisibilitySqlCol(req.user!.role)}"`);
    try {
      const docRows = await prisma.$queryRaw<{ id: string; root_id: string | null }[]>`
        SELECT d.id::text AS id, d.root_id::text AS root_id
        FROM "documents" d
        JOIN "documents" root ON root.id = COALESCE(d.root_id, d.id)
        WHERE d.id = ${req.params.id}::uuid AND root.${visCol} = true`;
      if (!docRows.length) { res.status(404).json({ error: 'Not found' }); return; }
      const rootId = docRows[0].root_id ?? docRows[0].id;
      const rows = await prisma.$queryRaw<{ id: string; content: string; createdBy: string; createdAt: Date }[]>`
        SELECT id::text AS id, content, created_by AS "createdBy", created_at AS "createdAt"
        FROM "document_notes"
        WHERE document_id = ${rootId}::uuid
        ORDER BY created_at ASC`;
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  // POST /api/documents/:id/notes — add a note (any authenticated user)
  router.post('/:id/notes', authenticateToken, requireUuidParam('id'), async (req, res) => {
    const { content } = req.body as { content?: string };
    if (!content?.trim()) { res.status(400).json({ error: 'content required' }); return; }
    try {
      const docRows = await prisma.$queryRaw<{ id: string; root_id: string | null }[]>`
        SELECT id::text AS id, root_id::text AS root_id FROM "documents" WHERE id=${req.params.id}::uuid`;
      if (!docRows.length) { res.status(404).json({ error: 'Not found' }); return; }
      const rootId = docRows[0].root_id ?? docRows[0].id;
      const rows = await prisma.$queryRaw<{ id: string }[]>`
        INSERT INTO "document_notes"(id, document_id, content, created_by, created_at)
        VALUES(gen_random_uuid(), ${rootId}::uuid, ${content.trim()}, ${req.user!.email}, now())
        RETURNING id::text AS id`;
      res.status(201).json({ id: rows[0].id });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  return router;
}

export function createBulkQueueProcessor(prisma: PrismaClient): () => Promise<void> {
  /**
   * Analyzes up to BULK_ANALYZE_BUDGET staged items per tick: parses the file,
   * asks Ollama to extract structured metadata, matches CIs, and stores the
   * (validated) suggestion JSON. Runs after processRagQueue on the same cron.
   */
    return async function processBulkImportQueue(): Promise<void> {
    if (process.env.RAG_ENABLED !== 'true') return;
    if (!(await isOllamaHealthy())) return;

    // Safety valve: items stuck in ANALYZING longer than max expected time (OCR + Ollama + margin)
    // are reset to ERROR so they don't block the queue permanently (e.g. after a crash).
    const stuckThresholdSecs = Math.ceil((BULK_BATCH_TTL_HOURS * 3600) / 20); // never more than 1/20 of TTL
    const maxAnalysisSecs = Math.ceil((
      parseInt(process.env.OCR_DOC_TIMEOUT_MS ?? '600000', 10) +
      parseInt(process.env.RAG_CHAT_TIMEOUT_MS  ?? '180000', 10)
    ) / 1000) + 120;
    const stuckSecs = Math.min(stuckThresholdSecs, maxAnalysisSecs);
    await prisma.$executeRaw`
      UPDATE "bulk_import_item"
      SET status = 'ERROR', error_message = 'Analysis timed out (stuck in ANALYZING)',  updated_at = now()
      WHERE status = 'ANALYZING'
        AND updated_at < now() - make_interval(secs => ${stuckSecs}::int)`;

    // Serialisation guard: if any item is still ANALYZING, wait for it to finish
    // before starting new ones. Prevents concurrent OCR + Ollama calls that saturate
    // CPU and cause Ollama timeouts when processing large batches.
    const inFlight = await prisma.$queryRaw<{ c: bigint }[]>`
      SELECT COUNT(*) AS c FROM "bulk_import_item" WHERE status = 'ANALYZING'`;
    if (Number(inFlight[0]?.c ?? 0) > 0) return;

    const pending = await prisma.$queryRaw<{ id: string; batch_id: string; staged_file_name: string; mime_type: string; original_name: string }[]>`
      SELECT id::text AS id, batch_id::text AS batch_id, staged_file_name, mime_type, original_name
      FROM "bulk_import_item"
      WHERE status = 'PENDING_ANALYSIS'
      ORDER BY created_at ASC
      LIMIT 1`;

    const touchedBatches = new Set<string>();

    for (const item of pending) {
      touchedBatches.add(item.batch_id);
      try {
        await prisma.$executeRaw`UPDATE "bulk_import_item" SET status='ANALYZING', updated_at=now() WHERE id=${item.id}::uuid`;

        const filePath = path.join(STAGING_DIR, path.basename(item.staged_file_name));
        const parseResult = await parseDocument(filePath, item.mime_type, item.original_name);
        const text = parseResult.sections.map((s) => s.text).join('\n\n').trim();

        // OCR-A09-1: audit when Tesseract OCR fallback was triggered
        if (parseResult.ocrUsed) {
          await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at)
            VALUES(gen_random_uuid(),'OCR_INVOKED','Document',${item.id}::uuid,'system/cron',
            ${JSON.stringify({ itemId: item.id, fileName: item.original_name })}::jsonb,now())`.catch(() => {});
        }

        let analysis: Record<string, unknown>;
        let finalStatus: 'ANALYZED' | 'WARNING';
        if (!text) {
          // No extractable text (e.g. image, scanned PDF without readable OCR result).
          // Mark as WARNING so the UI surfaces it for manual review/classification
          // (legitimately-empty text files keep ANALYZED — they aren't a warning case).
          analysis = { textExtracted: false, ciMatches: [], analyzedAt: new Date().toISOString() };
          finalStatus = item.mime_type === 'text/plain' ? 'ANALYZED' : 'WARNING';
        } else {
          const raw = await analyzeDocumentForImport(text, { fileName: item.original_name });
          const norm = normalizeAnalysis(raw);
          const ciMatches = await matchCIsForImport(prisma, norm.ciHints);
          analysis = { ...norm, ciMatches, textExtracted: true, analyzedAt: new Date().toISOString() };
          finalStatus = 'ANALYZED';
        }

        await prisma.$executeRaw`
          UPDATE "bulk_import_item"
          SET status=${finalStatus}, analysis=${JSON.stringify(analysis)}::jsonb, error_message=NULL, updated_at=now()
          WHERE id=${item.id}::uuid`;
      } catch (e) {
        console.error('[RAG] processBulkImportQueue item error:', e);
        // OCR-A09-1: best-effort OCR_FAILED audit for PDF items that errored
        if (item.mime_type === 'application/pdf') {
          await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at)
            VALUES(gen_random_uuid(),'OCR_FAILED','Document',${item.id}::uuid,'system/cron',
            ${JSON.stringify({ itemId: item.id, fileName: item.original_name, error: String(e).slice(0, 200) })}::jsonb,now())`.catch(() => {});
        }
        const errMsg = String(e).slice(0, 500);
        try {
          await prisma.$executeRaw`
            UPDATE "bulk_import_item" SET status='ERROR', error_message=${errMsg}, updated_at=now()
            WHERE id=${item.id}::uuid`;
        } catch (e2) {
          console.error('[RAG] processBulkImportQueue error-mark failure:', e2);
        }
      }
    }

    for (const batchId of touchedBatches) {
      try { await recomputeBatchStatus(prisma, batchId); }
      catch (e) { console.error('[RAG] processBulkImportQueue batch-status error:', e); }
    }
  }
}
