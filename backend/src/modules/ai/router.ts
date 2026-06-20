import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { PrismaClient, Prisma } from '@prisma/client';
import { createAuthenticateToken } from '../../shared/middleware/authenticate.js';
import { requireAdmin }            from '../../shared/middleware/requireAdmin.js';
import { docVisibilitySqlCol }     from '../../shared/utils/docVisibility.js';
import {
  getEmbedding, sanitizeQuery,
  buildRagPrompt, chatWithContext, streamChatWithContext,
  type RagChunkResult, type Citation,
} from '../../services/ragService.js';
import { vulnUuid } from '../../services/entitySerializer.js';
import type { RagEntityType } from './queue.js';

// ── Schemas ───────────────────────────────────────────────────────────────────

const ChatSessionCreateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
});

const ChatAskSchema = z.object({
  sessionId:   z.string().uuid().optional(),
  question:    z.string().min(1).max(2000),
  topK:        z.number().int().min(1).max(20).optional(),
  entityTypes: z
    .array(z.enum(['document', 'ci', 'contract', 'license', 'vulnerability', 'decommission']))
    .optional(),
  lang: z.enum(['es', 'en', 'de', 'pt', 'fr', 'it']).optional(),
});

const BackfillSchema = z.object({
  entityTypes: z
    .array(z.enum(['document', 'ci', 'contract', 'license', 'vulnerability', 'decommission']))
    .optional(),
});

// ── Stats cache ───────────────────────────────────────────────────────────────

let _statsCache: { text: string; expiresAt: number } | null = null;

async function getCmdbStats(prisma: PrismaClient): Promise<string> {
  const now = Date.now();
  if (_statsCache && _statsCache.expiresAt > now) return _statsCache.text;

  try {
    type TypeRow  = { tipo: string; estado: string; n: number };
    type TotalRow = { total: number; activos: number };
    type CountRow = { n: number };

    const [byType, totals, contratosR, licenciasR, docsR, vulnsR] = await Promise.all([
      prisma.$queryRaw<TypeRow[]>`
        SELECT ct.name AS tipo, ci.status AS estado, COUNT(*)::int AS n
        FROM configuration_items ci
        LEFT JOIN ci_types ct ON ci.ci_type_id = ct.id
        GROUP BY ct.name, ci.status
        ORDER BY COUNT(*) DESC`,
      prisma.$queryRaw<TotalRow[]>`
        SELECT COUNT(*)::int AS total,
               SUM(CASE WHEN status = 'ACTIVO' THEN 1 ELSE 0 END)::int AS activos
        FROM configuration_items`,
      prisma.$queryRaw<CountRow[]>`SELECT COUNT(*)::int AS n FROM contracts`,
      prisma.$queryRaw<CountRow[]>`SELECT COUNT(*)::int AS n FROM licenses`,
      prisma.$queryRaw<CountRow[]>`SELECT COUNT(*)::int AS n FROM documents WHERE root_id IS NULL`,
      prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(DISTINCT entity_id)::int AS n
        FROM rag_entity_index WHERE entity_type = 'vulnerability' AND status = 'READY'`,
    ]);

    const total   = Number(totals[0]?.total   ?? 0);
    const activos = Number(totals[0]?.activos  ?? 0);

    const typeMap: Record<string, { activo: number; otro: number }> = {};
    for (const row of byType) {
      const t = row.tipo ?? 'Sin tipo';
      if (!typeMap[t]) typeMap[t] = { activo: 0, otro: 0 };
      if (row.estado === 'ACTIVO') typeMap[t].activo += Number(row.n);
      else typeMap[t].otro += Number(row.n);
    }
    const tipoLines = Object.entries(typeMap)
      .sort((a, b) => (b[1].activo + b[1].otro) - (a[1].activo + a[1].otro))
      .map(([t, { activo, otro }]) =>
        otro > 0
          ? `  - ${t}: ${activo + otro} (${activo} activos, ${otro} inactivos/retirados)`
          : `  - ${t}: ${activo}`)
      .join('\n');

    const text = [
      `CIs (Elementos de Configuración): ${total} total (${activos} activos, ${total - activos} inactivos/retirados)`,
      `Por tipo de CI:`,
      tipoLines,
      `Contratos: ${Number(contratosR[0]?.n ?? 0)}`,
      `Licencias: ${Number(licenciasR[0]?.n ?? 0)}`,
      `Documentos: ${Number(docsR[0]?.n ?? 0)}`,
      `Vulnerabilidades indexadas: ${Number(vulnsR[0]?.n ?? 0)}`,
    ].join('\n');

    _statsCache = { text, expiresAt: now + 60_000 };
    return text;
  } catch (err) {
    console.error('[getCmdbStats] error:', err);
    return ''; // graceful degradation — stats failure must not break chat
  }
}

/**
 * Retrieves the top-K most similar chunks for a query, filtered by the user's role ACL.
 *
 * Security: the ACL filter (read_admin/auditor/viewer) is applied BEFORE the kNN
 * search in the same SQL statement — chunks from non-readable documents never
 * leave the database. This prevents data leakage and embedding-membership inference.
 */
async function ragSearchChunks(
  prisma: PrismaClient,
  query: string,
  role: string,
  topK = 6,
  entityTypes?: string[],
): Promise<RagChunkResult[]> {
  const cleanQuery = sanitizeQuery(query);
  const { embedding } = await getEmbedding(cleanQuery);
  const embeddingStr = `[${embedding.join(',')}]`;

  // Allowlisted column name from docVisibilitySqlCol — safe with Prisma.raw()
  const visCol = Prisma.raw(`"${docVisibilitySqlCol(role)}"`);

  // Validate entityTypes against the fixed allowlist.
  // Unknown values are silently dropped (per spec). Empty / undefined → no filter.
  const ALLOWED_ENTITY_TYPES = ['document', 'ci', 'contract', 'license', 'vulnerability', 'decommission'] as const;
  const filteredEntityTypes = Array.isArray(entityTypes)
    ? entityTypes.filter((t): t is (typeof ALLOWED_ENTITY_TYPES)[number] =>
        (ALLOWED_ENTITY_TYPES as readonly string[]).includes(t),
      )
    : [];

  // Relational expansion: when the caller filters by 'contract' or 'license', also pull
  // in chunks from documents and CIs that are associated with those entities via the
  // explicit join tables (document_contracts / _ContractToCI, document_licenses / _LicenseToCI).
  const expandContracts = filteredEntityTypes.includes('contract');
  const expandLicenses  = filteredEntityTypes.includes('license');

  const entityTypesParam: string[] | null =
    filteredEntityTypes.length > 0 ? filteredEntityTypes : null;

  const rows = await prisma.$queryRaw<{
    id: string;
    entity_type: string;
    entity_id: string;
    document_id: string | null;
    title: string | null;
    version_number: number | null;
    section_path: string | null;
    page_start: number | null;
    content: string;
    score: number;
  }[]>`
    SELECT
      c.id::text                   AS id,
      c.entity_type                AS entity_type,
      c.entity_id::text            AS entity_id,
      c.document_id::text          AS document_id,
      COALESCE(d.title, c.metadata->>'title') AS title,
      c.version_number             AS version_number,
      c.section_path               AS section_path,
      c.page_start                 AS page_start,
      c.content                    AS content,
      1 - (c.embedding <=> ${embeddingStr}::vector) AS score
    FROM "rag_chunks" c
    LEFT JOIN "documents" d
      ON c.entity_type = 'document' AND d.id = c.document_id
    LEFT JOIN "documents" root
      ON c.entity_type = 'document' AND root.id = COALESCE(d.root_id, d.id)
    WHERE (
        -- Direct entity chunks (ci / contract / license / vulnerability / decommission)
        (c.entity_type IN ('ci','contract','license','vulnerability','decommission'))
        OR
        -- Document chunks: standard ACL filter
        (c.entity_type = 'document' AND root.${visCol} = true AND d.is_latest = true)
        OR
        -- Relational expansion: documents linked to a contract in the filter
        (${expandContracts} AND c.entity_type = 'document' AND d.is_latest = true AND root.${visCol} = true
          AND c.document_id IN (
            SELECT dc.document_id FROM "document_contracts" dc
            JOIN "rag_entity_index" rei ON rei.entity_type = 'contract' AND rei.entity_id = dc.contract_id
          )
        )
        OR
        -- Relational expansion: CIs linked to a contract in the filter
        (${expandContracts} AND c.entity_type = 'ci'
          AND c.entity_id IN (
            SELECT ctc."A" FROM "_ContractToCI" ctc
            JOIN "rag_entity_index" rei ON rei.entity_type = 'contract' AND rei.entity_id = ctc."B"
          )
        )
        OR
        -- Relational expansion: documents linked to a license in the filter
        (${expandLicenses} AND c.entity_type = 'document' AND d.is_latest = true AND root.${visCol} = true
          AND c.document_id IN (
            SELECT dl.document_id FROM "document_licenses" dl
            JOIN "rag_entity_index" rei ON rei.entity_type = 'license' AND rei.entity_id = dl.license_id
          )
        )
        OR
        -- Relational expansion: CIs linked to a license in the filter
        (${expandLicenses} AND c.entity_type = 'ci'
          AND c.entity_id IN (
            SELECT ltc."A" FROM "_LicenseToCI" ltc
            JOIN "rag_entity_index" rei ON rei.entity_type = 'license' AND rei.entity_id = ltc."B"
          )
        )
      )
      AND (
        ${entityTypesParam}::text[] IS NULL
        OR c.entity_type = ANY(${entityTypesParam}::text[])
        OR (${expandContracts} AND c.entity_type IN ('document','ci'))
        OR (${expandLicenses}  AND c.entity_type IN ('document','ci'))
      )
    ORDER BY c.embedding <=> ${embeddingStr}::vector
    LIMIT ${topK}`;

  return rows.map((r) => ({
    id:            r.id,
    entityType:    r.entity_type as RagChunkResult['entityType'],
    entityId:      r.entity_id,
    documentId:    r.entity_type === 'document' ? (r.document_id ?? undefined) : undefined,
    documentTitle: r.title ?? '(sin título)',
    versionNumber: r.entity_type === 'document' ? (r.version_number ?? undefined) : undefined,
    sectionPath:   r.section_path ?? undefined,
    pageStart:     r.page_start   ?? undefined,
    content:       r.content,
    score:         r.score,
  }));
}

/** Audit-logs an ASK_RAG event. Stores only a SHA-256 hash of the query (no PII). */
async function logAskRag(prisma: PrismaClient, opts: {
  userEmail: string;
  sessionId: string;
  query: string;
  citationCount: number;
  modelUsed: string;
  latencyMs: number;
}): Promise<void> {
  try {
    const queryHash = crypto.createHash('sha256').update(opts.query).digest('hex');
    const details = JSON.stringify({
      queryHash,
      citationCount: opts.citationCount,
      modelUsed:     opts.modelUsed,
      latencyMs:     opts.latencyMs,
    });
    await prisma.$executeRaw`
      INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, details, created_at)
      VALUES(gen_random_uuid(), 'ASK_RAG', 'RagChatSession', ${opts.sessionId}::uuid, ${opts.userEmail}, ${details}, now())`;
  } catch (e) {
    console.error('[RAG] logAskRag error:', e);
  }
}

// ── Router factory ────────────────────────────────────────────────────────────

export function createAiRouter(prisma: PrismaClient): Router {
  const router = Router();
  const authenticateToken = createAuthenticateToken(prisma);

  // Admin RAG ops limiter: 1 request per minute per IP (backfill is heavy)
  const ragBackfillLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 1,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Rate limited. Try again in a minute.' },
  });

  // Chat ask limiter: 10 requests/min per IP (separate from global apiLimiter)
  const chatAskLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Demasiadas consultas al asistente. Inténtelo de nuevo en un minuto.' },
  });

  // GET /api/admin/rag/status — indexing health summary + ERROR rows (ADMIN only)
  router.get('/admin/rag/status', authenticateToken, requireAdmin, async (_req: Request, res: Response) => {
    if (process.env.RAG_ENABLED !== 'true') { res.status(503).json({ error: 'RAG subsystem is disabled' }); return; }
    try {
      type StatusRow = { status: string; n: number };
      type EntityRow = { entity_type: string; status: string; n: number };
      type DocErrRow = { document_id: string; version: number; error: string | null; updated_at: Date };
      type EntErrRow = { entity_type: string; entity_id: string; error: string | null; updated_at: Date };

      const [docByStatus, entityByStatus, docErrors, entityErrors] = await Promise.all([
        prisma.$queryRaw<StatusRow[]>`
          SELECT status, COUNT(*)::int AS n FROM rag_document_index GROUP BY status ORDER BY status`,
        prisma.$queryRaw<EntityRow[]>`
          SELECT entity_type, status, COUNT(*)::int AS n
          FROM rag_entity_index GROUP BY entity_type, status ORDER BY entity_type, status`,
        prisma.$queryRaw<DocErrRow[]>`
          SELECT rdi.document_id::text, rdi.version_number AS version,
                 rdi.error_message AS error, rdi.updated_at,
                 d.title
          FROM rag_document_index rdi
          LEFT JOIN documents d ON d.id = rdi.document_id
          WHERE rdi.status = 'ERROR'
          ORDER BY rdi.updated_at DESC LIMIT 50`,
        prisma.$queryRaw<EntErrRow[]>`
          SELECT entity_type, entity_id::text, error_message AS error, updated_at
          FROM rag_entity_index WHERE status = 'ERROR'
          ORDER BY updated_at DESC LIMIT 50`,
      ]);

      res.json({
        documents: { byStatus: docByStatus, errors: docErrors },
        entities:  { byStatus: entityByStatus, errors: entityErrors },
      });
    } catch (e) {
      console.error('[GET /api/admin/rag/status]', e);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/admin/rag/backfill — re-queue un-indexed documents and/or entities (ADMIN only)
  router.post('/admin/rag/backfill', authenticateToken, requireAdmin, ragBackfillLimiter, async (req: Request, res: Response) => {
    if (process.env.RAG_ENABLED !== 'true') { res.status(503).json({ error: 'RAG subsystem is disabled' }); return; }
    try {
      const parsed = BackfillSchema.safeParse(req.body ?? {});
      if (!parsed.success) { res.status(400).json({ error: 'Invalid request body' }); return; }
      const requested = parsed.data.entityTypes ?? [];
      const ALL = ['document', 'ci', 'contract', 'license', 'vulnerability', 'decommission'] as const;
      const targets: ReadonlyArray<(typeof ALL)[number]> = requested.length === 0 ? ALL : requested;
      const wants = (t: (typeof ALL)[number]) => targets.includes(t);

      const queued: Record<(typeof ALL)[number], number> = {
        document: 0, ci: 0, contract: 0, license: 0, vulnerability: 0, decommission: 0,
      };

      if (wants('document')) {
        const docs = await prisma.$queryRaw<{ id: string; version_number: number }[]>`
          SELECT d.id::text AS id, d.version_number
          FROM "documents" d
          LEFT JOIN "rag_document_index" r
            ON r.document_id = d.id AND r.version_number = d.version_number
          WHERE d.is_latest = true
            AND (r.status IS NULL OR r.status != 'READY')`;
        for (const doc of docs) {
          await prisma.$executeRaw`
            INSERT INTO "rag_document_index"(id, document_id, version_number, status, created_at, updated_at)
            VALUES(gen_random_uuid(), ${doc.id}::uuid, ${doc.version_number}, 'PENDING', now(), now())
            ON CONFLICT (document_id, version_number) DO UPDATE SET status='PENDING', updated_at=now()`;
        }
        queued.document = docs.length;
      }

      if (wants('ci')) {
        const cis = await prisma.$queryRaw<{ id: string }[]>`
          SELECT id::text AS id FROM "configuration_items"`;
        for (const ci of cis) {
          await prisma.$executeRaw`
            INSERT INTO "rag_entity_index"(id, entity_type, entity_id, status, created_at, updated_at)
            VALUES(gen_random_uuid(), 'ci', ${ci.id}::uuid, 'PENDING', now(), now())
            ON CONFLICT (entity_type, entity_id) DO UPDATE
              SET status='PENDING', updated_at=now()
              WHERE "rag_entity_index".status != 'INDEXING'`;
        }
        queued.ci = cis.length;
      }

      if (wants('contract')) {
        const contracts = await prisma.$queryRaw<{ id: string }[]>`
          SELECT id::text AS id FROM "contracts" WHERE parent_contract_id IS NULL`;
        for (const c of contracts) {
          await prisma.$executeRaw`
            INSERT INTO "rag_entity_index"(id, entity_type, entity_id, status, created_at, updated_at)
            VALUES(gen_random_uuid(), 'contract', ${c.id}::uuid, 'PENDING', now(), now())
            ON CONFLICT (entity_type, entity_id) DO UPDATE
              SET status='PENDING', updated_at=now()
              WHERE "rag_entity_index".status != 'INDEXING'`;
        }
        queued.contract = contracts.length;
      }

      if (wants('license')) {
        const licenses = await prisma.$queryRaw<{ id: string }[]>`
          SELECT id::text AS id FROM "licenses" WHERE parent_license_id IS NULL`;
        for (const l of licenses) {
          await prisma.$executeRaw`
            INSERT INTO "rag_entity_index"(id, entity_type, entity_id, status, created_at, updated_at)
            VALUES(gen_random_uuid(), 'license', ${l.id}::uuid, 'PENDING', now(), now())
            ON CONFLICT (entity_type, entity_id) DO UPDATE
              SET status='PENDING', updated_at=now()
              WHERE "rag_entity_index".status != 'INDEXING'`;
        }
        queued.license = licenses.length;
      }

      if (wants('vulnerability')) {
        const ciRows = await prisma.$queryRaw<{ id: string; vulnerabilities: unknown }[]>`
          SELECT id::text AS id, vulnerabilities
          FROM "configuration_items"
          WHERE vulnerabilities IS NOT NULL
            AND jsonb_typeof(vulnerabilities) = 'array'
            AND jsonb_array_length(vulnerabilities) > 0`;
        let vulnCount = 0;
        for (const ciRow of ciRows) {
          const arr = Array.isArray(ciRow.vulnerabilities) ? ciRow.vulnerabilities : [];
          for (const v of arr) {
            if (!v || typeof v !== 'object') continue;
            const cve = (v as { cve?: unknown }).cve;
            if (typeof cve !== 'string' || cve.length === 0) continue;
            const vId = vulnUuid(ciRow.id, cve);
            await prisma.$executeRaw`
              INSERT INTO "rag_entity_index"(id, entity_type, entity_id, status, created_at, updated_at)
              VALUES(gen_random_uuid(), 'vulnerability', ${vId}::uuid, 'PENDING', now(), now())
              ON CONFLICT (entity_type, entity_id) DO UPDATE
                SET status='PENDING', updated_at=now()
                WHERE "rag_entity_index".status != 'INDEXING'`;
            vulnCount++;
          }
        }
        queued.vulnerability = vulnCount;
      }

      if (wants('decommission')) {
        const plans = await prisma.$queryRaw<{ id: string }[]>`
          SELECT id::text AS id FROM "decommission_plan"`;
        for (const p of plans) {
          await prisma.$executeRaw`
            INSERT INTO "rag_entity_index"(id, entity_type, entity_id, status, created_at, updated_at)
            VALUES(gen_random_uuid(), 'decommission', ${p.id}::uuid, 'PENDING', now(), now())
            ON CONFLICT (entity_type, entity_id) DO UPDATE
              SET status='PENDING', updated_at=now()
              WHERE "rag_entity_index".status != 'INDEXING'`;
        }
        queued.decommission = plans.length;
      }

      await prisma.$executeRaw`
        INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, details, created_at)
        VALUES(gen_random_uuid(), 'RAG_BACKFILL_ENTITIES', 'System', 'system', ${req.user!.email},
          ${JSON.stringify({ queued_per_type: queued })}::jsonb, now())`;

      res.json({ ok: true, queued });
    } catch (e) {
      console.error('[POST /api/admin/rag/backfill] Error:', e);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/chat/sessions — list current user's sessions
  router.get('/chat/sessions', authenticateToken, async (req: Request, res: Response) => {
    try {
      const rows = await prisma.$queryRaw<{ id: string; title: string; created_at: Date; updated_at: Date; message_count: number }[]>`
        SELECT s.id::text AS id, s.title, s.created_at, s.updated_at,
               (SELECT COUNT(*)::int FROM "rag_chat_messages" m WHERE m.session_id = s.id) AS message_count
        FROM "rag_chat_sessions" s
        WHERE s.user_id = ${req.user!.id}::uuid
        ORDER BY s.updated_at DESC
        LIMIT 100`;
      res.json(rows.map(r => ({
        id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at, messageCount: Number(r.message_count),
      })));
    } catch (e) { console.error('[GET /api/chat/sessions]', e); res.status(500).json({ error: 'Internal server error' }); }
  });

  // POST /api/chat/sessions — create a new session
  router.post('/chat/sessions', authenticateToken, async (req: Request, res: Response) => {
    const parsed = ChatSessionCreateSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }
    const title = parsed.data.title?.trim() || 'Nueva consulta';
    try {
      const rows = await prisma.$queryRaw<{ id: string }[]>`
        INSERT INTO "rag_chat_sessions"(id, user_id, title, created_at, updated_at)
        VALUES(gen_random_uuid(), ${req.user!.id}::uuid, ${title}, now(), now())
        RETURNING id::text AS id`;
      res.status(201).json({ id: rows[0].id, title });
    } catch (e) { console.error('[POST /api/chat/sessions]', e); res.status(500).json({ error: 'Internal server error' }); }
  });

  // DELETE /api/chat/sessions/:id — delete a session (and its messages via CASCADE)
  router.delete('/chat/sessions/:id', authenticateToken, async (req: Request, res: Response) => {
    try {
      const rows = await prisma.$queryRaw<{ id: string }[]>`
        DELETE FROM "rag_chat_sessions"
        WHERE id = ${req.params.id}::uuid AND user_id = ${req.user!.id}::uuid
        RETURNING id::text AS id`;
      if (!rows.length) { res.status(404).json({ error: 'Session not found' }); return; }
      res.json({ ok: true });
    } catch (e) { console.error('[DELETE /api/chat/sessions/:id]', e); res.status(500).json({ error: 'Internal server error' }); }
  });

  // GET /api/chat/sessions/:id/messages — list messages of a session
  router.get('/chat/sessions/:id/messages', authenticateToken, async (req: Request, res: Response) => {
    try {
      const owner = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM "rag_chat_sessions"
        WHERE id = ${req.params.id}::uuid AND user_id = ${req.user!.id}::uuid LIMIT 1`;
      if (!owner.length) { res.status(404).json({ error: 'Session not found' }); return; }
      const msgs = await prisma.$queryRaw<{ id: string; role: string; content: string; citations: unknown; model_used: string | null; created_at: Date }[]>`
        SELECT id::text AS id, role, content, citations, model_used, created_at
        FROM "rag_chat_messages"
        WHERE session_id = ${req.params.id}::uuid
        ORDER BY created_at ASC`;
      res.json(msgs.map(m => ({
        id: m.id, role: m.role, content: m.content, citations: m.citations, modelUsed: m.model_used, createdAt: m.created_at,
      })));
    } catch (e) { console.error('[GET /api/chat/sessions/:id/messages]', e); res.status(500).json({ error: 'Internal server error' }); }
  });

  // POST /api/chat/ask — non-streaming ask
  router.post('/chat/ask', authenticateToken, chatAskLimiter, async (req: Request, res: Response) => {
    if (process.env.RAG_ENABLED !== 'true') { res.status(503).json({ error: 'El asistente está deshabilitado' }); return; }
    const parsed = ChatAskSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }
    const { question, topK, entityTypes, lang } = parsed.data;
    let { sessionId } = parsed.data;

    try {
      if (!sessionId) {
        const sessionTitle = question.slice(0, 80);
        const sRows = await prisma.$queryRaw<{ id: string }[]>`
          INSERT INTO "rag_chat_sessions"(id, user_id, title, created_at, updated_at)
          VALUES(gen_random_uuid(), ${req.user!.id}::uuid, ${sessionTitle}, now(), now())
          RETURNING id::text AS id`;
        sessionId = sRows[0].id;
      } else {
        const owner = await prisma.$queryRaw<{ id: string }[]>`
          SELECT id::text AS id FROM "rag_chat_sessions"
          WHERE id = ${sessionId}::uuid AND user_id = ${req.user!.id}::uuid LIMIT 1`;
        if (!owner.length) { res.status(404).json({ error: 'Session not found' }); return; }
      }

      const [chunks, cmdbStats] = await Promise.all([
        ragSearchChunks(prisma, question, req.user!.role, topK ?? 6, entityTypes),
        getCmdbStats(prisma),
      ]);

      const messages = buildRagPrompt(question, chunks, lang, cmdbStats);
      const start = Date.now();
      const result = await chatWithContext(messages);
      const latencyMs = Date.now() - start;

      const citations: Citation[] = chunks.map(c => ({
        entityType:    c.entityType,
        entityId:      c.entityId,
        documentId:    c.documentId,
        documentTitle: c.documentTitle,
        versionNumber: c.versionNumber,
        page:          c.pageStart,
        section:       c.sectionPath,
        snippet:       c.content.slice(0, 200),
      }));

      const queryHash = crypto.createHash('sha256').update(question).digest('hex');
      await prisma.$executeRaw`
        INSERT INTO "rag_chat_messages"(id, session_id, role, content, citations, query_hash, created_at)
        VALUES(gen_random_uuid(), ${sessionId}::uuid, 'user', ${question}, '[]'::jsonb, ${queryHash}, now())`;
      await prisma.$executeRaw`
        INSERT INTO "rag_chat_messages"(id, session_id, role, content, citations, model_used, tokens_used, latency_ms, created_at)
        VALUES(gen_random_uuid(), ${sessionId}::uuid, 'assistant', ${result.content}, ${JSON.stringify(citations)}::jsonb, ${result.model}, ${result.tokensUsed ?? null}, ${latencyMs}, now())`;
      await prisma.$executeRaw`
        UPDATE "rag_chat_sessions" SET updated_at = now() WHERE id = ${sessionId}::uuid`;

      await logAskRag(prisma, { userEmail: req.user!.email, sessionId, query: question, citationCount: citations.length, modelUsed: result.model, latencyMs });

      res.json({ sessionId, answer: result.content, citations, modelUsed: result.model, latencyMs });
    } catch (e) {
      console.error('[POST /api/chat/ask]', e);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/chat/ask/stream — SSE streaming ask
  router.post('/chat/ask/stream', authenticateToken, chatAskLimiter, async (req: Request, res: Response) => {
    if (process.env.RAG_ENABLED !== 'true') { res.status(503).json({ error: 'El asistente está deshabilitado' }); return; }
    const parsed = ChatAskSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }
    const { question, topK, entityTypes, lang } = parsed.data;
    let { sessionId } = parsed.data;

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      if (!sessionId) {
        const sessionTitle = question.slice(0, 80);
        const sRows = await prisma.$queryRaw<{ id: string }[]>`
          INSERT INTO "rag_chat_sessions"(id, user_id, title, created_at, updated_at)
          VALUES(gen_random_uuid(), ${req.user!.id}::uuid, ${sessionTitle}, now(), now())
          RETURNING id::text AS id`;
        sessionId = sRows[0].id;
      } else {
        const owner = await prisma.$queryRaw<{ id: string }[]>`
          SELECT id::text AS id FROM "rag_chat_sessions"
          WHERE id = ${sessionId}::uuid AND user_id = ${req.user!.id}::uuid LIMIT 1`;
        if (!owner.length) { send('error', { message: 'Session not found' }); res.end(); return; }
      }

      send('session', { sessionId });

      const [chunks, cmdbStats] = await Promise.all([
        ragSearchChunks(prisma, question, req.user!.role, topK ?? 6, entityTypes),
        getCmdbStats(prisma),
      ]);

      const citations: Citation[] = chunks.map(c => ({
        entityType:    c.entityType,
        entityId:      c.entityId,
        documentId:    c.documentId,
        documentTitle: c.documentTitle,
        versionNumber: c.versionNumber,
        page:          c.pageStart,
        section:       c.sectionPath,
        snippet:       c.content.slice(0, 200),
      }));
      send('citations', citations);

      const queryHash = crypto.createHash('sha256').update(question).digest('hex');
      await prisma.$executeRaw`
        INSERT INTO "rag_chat_messages"(id, session_id, role, content, citations, query_hash, created_at)
        VALUES(gen_random_uuid(), ${sessionId}::uuid, 'user', ${question}, '[]'::jsonb, ${queryHash}, now())`;

      const messages = buildRagPrompt(question, chunks, lang, cmdbStats);
      const start = Date.now();
      let assistantText = '';
      const { model, tokensUsed } = await streamChatWithContext(messages, (token) => {
        assistantText += token;
        send('token', { t: token });
      });
      const latencyMs = Date.now() - start;

      await prisma.$executeRaw`
        INSERT INTO "rag_chat_messages"(id, session_id, role, content, citations, model_used, tokens_used, latency_ms, created_at)
        VALUES(gen_random_uuid(), ${sessionId}::uuid, 'assistant', ${assistantText}, ${JSON.stringify(citations)}::jsonb, ${model}, ${tokensUsed ?? null}, ${latencyMs}, now())`;
      await prisma.$executeRaw`
        UPDATE "rag_chat_sessions" SET updated_at = now() WHERE id = ${sessionId}::uuid`;

      await logAskRag(prisma, { userEmail: req.user!.email, sessionId, query: question, citationCount: citations.length, modelUsed: model, latencyMs });

      send('done', { modelUsed: model, latencyMs, tokensUsed });
      res.end();
    } catch (e) {
      console.error('[POST /api/chat/ask/stream]', e);
      try { send('error', { message: 'Internal server error' }); } catch {}
      res.end();
    }
  });

  return router;
}
