import path from 'path';
import { PrismaClient } from '@prisma/client';
import { parseDocument }     from '../../services/docParser.js';
import { chunkSections }     from '../../services/chunker.js';
import { getEmbeddingsBatch, isOllamaHealthy } from '../../services/ragService.js';
import {
  vulnUuid,
  serializeCI, serializeContract, serializeLicense, serializeVulnerability,
  serializeDecommissionPlan, type EntityParseResult,
} from '../../services/entitySerializer.js';

const DOCUMENTS_DIR = process.env.DOCUMENTS_DIR ?? '/app/documents';

export type RagEntityType = 'ci' | 'contract' | 'license' | 'vulnerability' | 'decommission';

export function createRagQueue(prisma: PrismaClient) {
  /**
   * Enqueues a non-document entity for asynchronous RAG indexing.
   *
   * Idempotent UPSERT with an ARCH-3 guard: never overwrites a row whose status
   * is INDEXING (would race with the worker mid-flight). The next worker tick
   * picks up PENDING rows.
   *
   * For vulnerabilities, the caller must derive entityId via vulnUuid(ciId, cve)
   * from entitySerializer.ts — never pass raw CI UUID for a 'vulnerability' type.
   */
  async function queueEntityForIndexing(entityType: RagEntityType, entityId: string): Promise<void> {
    if (process.env.RAG_ENABLED !== 'true') return;
    try {
      await prisma.$executeRaw`
        INSERT INTO "rag_entity_index"(id, entity_type, entity_id, status, created_at, updated_at)
        VALUES(gen_random_uuid(), ${entityType}, ${entityId}::uuid, 'PENDING', now(), now())
        ON CONFLICT (entity_type, entity_id) DO UPDATE
          SET status='PENDING', updated_at=now()
          WHERE "rag_entity_index".status != 'INDEXING'`;
    } catch (e) {
      console.error('[RAG] queueEntityForIndexing error:', e);
    }
  }

  /**
   * Synchronously purges all chunks + index row for an entity. Call this BEFORE
   * the HTTP response of DELETE handlers (await, not void) so the chunks never
   * survive their parent entity (GDPR Art.17 / ISO 27001 A.8.10).
   */
  async function purgeEntityFromRag(entityType: RagEntityType, entityId: string): Promise<void> {
    if (process.env.RAG_ENABLED !== 'true') return;
    try {
      await prisma.$executeRaw`DELETE FROM "rag_chunks" WHERE entity_type = ${entityType} AND entity_id = ${entityId}::uuid`;
      await prisma.$executeRaw`DELETE FROM "rag_entity_index" WHERE entity_type = ${entityType} AND entity_id = ${entityId}::uuid`;
    } catch (e) {
      console.error('[RAG] purgeEntityFromRag error:', e);
    }
  }

  async function processRagQueue(): Promise<void> {
    if (process.env.RAG_ENABLED !== 'true') return;
    if (!(await isOllamaHealthy())) return;

    // Per-cycle counters (used by the INDEX_BATCH audit row at the end)
    let docsProcessed = 0, docsErrors = 0;
    let ciProcessed = 0, ciErrors = 0;
    let contractProcessed = 0, contractErrors = 0;
    let licenseProcessed = 0, licenseErrors = 0;
    let vulnProcessed = 0, vulnErrors = 0;
    let decommissionProcessed = 0, decommissionErrors = 0;

    const pending = await prisma.$queryRaw<{ id: string; document_id: string; version_number: number }[]>`
      SELECT id::text AS id, document_id::text AS document_id, version_number
      FROM "rag_document_index"
      WHERE status = 'PENDING'
      ORDER BY created_at
      LIMIT 3`;

    for (const row of pending) {
      try {
        await prisma.$executeRaw`
          UPDATE "rag_document_index" SET status='INDEXING', updated_at=now() WHERE id=${row.id}::uuid`;

        const docRows = await prisma.$queryRaw<{ id: string; file_name: string; mime_type: string; title: string; version_number: number }[]>`
          SELECT id::text AS id, file_name, mime_type, title, version_number
          FROM "documents"
          WHERE id=${row.document_id}::uuid
          LIMIT 1`;

        if (!docRows.length) {
          await prisma.$executeRaw`
            UPDATE "rag_document_index" SET status='ERROR', error_message='Document not found', updated_at=now()
            WHERE id=${row.id}::uuid`;
          continue;
        }

        const doc = docRows[0];
        const filePath = path.join(DOCUMENTS_DIR, doc.file_name);
        const parseResult = await parseDocument(filePath, doc.mime_type, doc.title);

        if (parseResult.sections.length === 0) {
          await prisma.$executeRaw`
            UPDATE "rag_document_index" SET status='READY', chunk_count=0, indexed_at=now(), updated_at=now()
            WHERE id=${row.id}::uuid`;
          continue;
        }

        const chunks = chunkSections(parseResult.sections);

        await prisma.$executeRaw`
          DELETE FROM "rag_chunks"
          WHERE document_id=${row.document_id}::uuid AND version_number=${row.version_number}`;

        const texts = chunks.map((c) => c.content);
        const embeddings = await getEmbeddingsBatch(texts);

        for (let i = 0; i < chunks.length; i++) {
          const embeddingStr = `[${embeddings[i].join(',')}]`;
          const docId = row.document_id;
          const versionNumber = row.version_number;
          await prisma.$executeRaw`
            INSERT INTO "rag_chunks"(id, document_id, version_number, chunk_index, section_path, page_start, page_end, token_count, content, embedding, metadata, entity_type, entity_id, created_at)
            VALUES(gen_random_uuid(), ${docId}::uuid, ${versionNumber}, ${chunks[i].chunkIndex}, ${chunks[i].sectionPath ?? null}, ${chunks[i].pageStart ?? null}, ${chunks[i].pageEnd ?? null}, ${chunks[i].tokenCount}, ${chunks[i].content}, ${embeddingStr}::vector, '{}'::jsonb, 'document', ${docId}::uuid, now())`;
        }

        await prisma.$executeRaw`
          UPDATE "rag_document_index" SET status='READY', chunk_count=${chunks.length}, indexed_at=now(), updated_at=now()
          WHERE id=${row.id}::uuid`;

        await prisma.$executeRaw`
          INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
          VALUES(gen_random_uuid(), 'INDEX_DOC', 'Document', ${row.document_id}::uuid, 'system', now())`;
        docsProcessed++;
      } catch (e) {
        console.error('[RAG] processRagQueue doc error:', e);
        const errMsg = String(e).slice(0, 500);
        await prisma.$executeRaw`
          UPDATE "rag_document_index" SET status='ERROR', error_message=${errMsg}, updated_at=now()
          WHERE id=${row.id}::uuid`;
        docsErrors++;
      }
    }

    // ── Entity queue (plan §10.1 priority + budget) ────────────────────────────
    // Up to 3 entity slots per tick, allocated:
    //   1) up to 3 vulnerabilities,
    //   2) then up to 2 contract|license,
    //   3) then up to 1 ci.
    type EntityRow = { id: string; entity_type: RagEntityType; entity_id: string };

    // Lookup helper for vulnerability re-index:
    // 1) Fast path — read (ciId, cve) from the most recent existing chunk metadata.
    // 2) Slow path — scan configuration_items.vulnerabilities JSON arrays and match
    //    vulnUuid(ciId, cve) against the given entityId. Only triggers on first index.
    const resolveVulnTuple = async (
      entityId: string,
    ): Promise<{ ciId: string; cve: string } | null> => {
      try {
        const chunkRows = await prisma.$queryRaw<{ ci_id: string | null; cve: string | null }[]>`
          SELECT metadata->>'ciId' AS ci_id, metadata->>'cve' AS cve
          FROM "rag_chunks"
          WHERE entity_type = 'vulnerability' AND entity_id = ${entityId}::uuid
          ORDER BY created_at DESC
          LIMIT 1`;
        if (chunkRows.length > 0 && chunkRows[0].ci_id && chunkRows[0].cve) {
          return { ciId: chunkRows[0].ci_id, cve: chunkRows[0].cve };
        }
      } catch (e) {
        console.error('[RAG] resolveVulnTuple chunk lookup error:', e);
      }
      // Fallback: scan CI vulnerability arrays.
      try {
        const ciRows = await prisma.$queryRaw<{ id: string; vulnerabilities: unknown }[]>`
          SELECT id::text AS id, vulnerabilities
          FROM "configuration_items"
          WHERE vulnerabilities IS NOT NULL
            AND jsonb_typeof(vulnerabilities) = 'array'
            AND jsonb_array_length(vulnerabilities) > 0`;
        for (const ciRow of ciRows) {
          const arr = Array.isArray(ciRow.vulnerabilities) ? ciRow.vulnerabilities : [];
          for (const v of arr) {
            if (!v || typeof v !== 'object') continue;
            const cve = (v as { cve?: unknown }).cve;
            if (typeof cve !== 'string' || cve.length === 0) continue;
            if (vulnUuid(ciRow.id, cve) === entityId) {
              return { ciId: ciRow.id, cve };
            }
          }
        }
      } catch (e) {
        console.error('[RAG] resolveVulnTuple scan error:', e);
      }
      return null;
    };

    // Slot 1: vulnerabilities (up to 3)
    const vulnRows = await prisma.$queryRaw<EntityRow[]>`
      SELECT id::text AS id, entity_type, entity_id::text AS entity_id
      FROM "rag_entity_index"
      WHERE status = 'PENDING' AND entity_type = 'vulnerability'
      ORDER BY created_at
      LIMIT 3`;
    let entitySlotsRemaining = 3 - vulnRows.length;

    // Slot 2: contracts + licenses (max 2 — capped at remaining slots)
    const clLimit = Math.min(2, entitySlotsRemaining);
    const contractLicenseRows = clLimit > 0
      ? await prisma.$queryRaw<EntityRow[]>`
          SELECT id::text AS id, entity_type, entity_id::text AS entity_id
          FROM "rag_entity_index"
          WHERE status = 'PENDING' AND entity_type IN ('contract','license','decommission')
          ORDER BY created_at
          LIMIT ${clLimit}`
      : [];
    entitySlotsRemaining -= contractLicenseRows.length;

    // Slot 3: ci (max 1 — capped at remaining slots)
    const ciLimit = Math.min(1, entitySlotsRemaining);
    const ciRows = ciLimit > 0
      ? await prisma.$queryRaw<EntityRow[]>`
          SELECT id::text AS id, entity_type, entity_id::text AS entity_id
          FROM "rag_entity_index"
          WHERE status = 'PENDING' AND entity_type = 'ci'
          ORDER BY created_at
          LIMIT ${ciLimit}`
      : [];

    const entityRows: EntityRow[] = [...vulnRows, ...contractLicenseRows, ...ciRows];

    for (const row of entityRows) {
      try {
        await prisma.$executeRaw`UPDATE "rag_entity_index" SET status='INDEXING', updated_at=now() WHERE id=${row.id}::uuid`;

        // Resolve the entity → EntityParseResult via the appropriate serializer.
        let parseResult: EntityParseResult | null = null;
        let vulnTuple: { ciId: string; cve: string } | null = null;

        try {
          if (row.entity_type === 'ci') {
            parseResult = await serializeCI(row.entity_id);
          } else if (row.entity_type === 'contract') {
            parseResult = await serializeContract(row.entity_id);
          } else if (row.entity_type === 'license') {
            parseResult = await serializeLicense(row.entity_id);
          } else if (row.entity_type === 'vulnerability') {
            vulnTuple = await resolveVulnTuple(row.entity_id);
            if (vulnTuple) {
              parseResult = await serializeVulnerability(vulnTuple.ciId, vulnTuple.cve);
            }
          } else if (row.entity_type === 'decommission') {
            parseResult = await serializeDecommissionPlan(row.entity_id);
          }
        } catch (serErr) {
          // Serializer threw (e.g. entity not found) — treat as missing content.
          console.error('[RAG] entity serializer error:', serErr);
          parseResult = null;
        }

        // ARCH-4 guard: missing entity → purge and mark ERROR.
        if (!parseResult || parseResult.sections.length === 0) {
          await prisma.$executeRaw`
            UPDATE "rag_entity_index" SET status='ERROR', error_message='Entity not found', updated_at=now()
            WHERE id=${row.id}::uuid`;
          await purgeEntityFromRag(row.entity_type, row.entity_id);
          if (row.entity_type === 'ci') ciErrors++;
          else if (row.entity_type === 'contract') contractErrors++;
          else if (row.entity_type === 'license') licenseErrors++;
          else if (row.entity_type === 'vulnerability') vulnErrors++;
          else if (row.entity_type === 'decommission') decommissionErrors++;
          continue;
        }

        // minChunkTokens:1 — entity serializations are intentionally short (structured
        // metadata, not prose). The default 50-token floor discards them entirely.
        const chunks = chunkSections(parseResult.sections, { minChunkTokens: 1 });

        // Replace existing chunks for this (entity_type, entity_id).
        await prisma.$executeRaw`
          DELETE FROM "rag_chunks"
          WHERE entity_type = ${row.entity_type} AND entity_id = ${row.entity_id}::uuid`;

        const texts = chunks.map((c) => c.content);
        const embeddings = texts.length > 0 ? await getEmbeddingsBatch(texts) : [];

        // Build metadata: title + entityType/entityId; vulns also carry (ciId, cve)
        // so the next re-index resolves without scanning JSON arrays.
        const baseMeta: Record<string, unknown> = {
          title: parseResult.title,
          entityType: row.entity_type,
          entityId: row.entity_id,
        };
        if (row.entity_type === 'vulnerability' && vulnTuple) {
          baseMeta.ciId = vulnTuple.ciId;
          baseMeta.cve = vulnTuple.cve;
        }
        const metaStr = JSON.stringify(baseMeta);

        for (let i = 0; i < chunks.length; i++) {
          const embeddingStr = `[${embeddings[i].join(',')}]`;
          await prisma.$executeRaw`
            INSERT INTO "rag_chunks"(id, document_id, version_number, chunk_index, section_path, page_start, page_end, token_count, content, embedding, metadata, entity_type, entity_id, created_at)
            VALUES(gen_random_uuid(), NULL, 1, ${chunks[i].chunkIndex}, ${chunks[i].sectionPath ?? null}, ${chunks[i].pageStart ?? null}, ${chunks[i].pageEnd ?? null}, ${chunks[i].tokenCount}, ${chunks[i].content}, ${embeddingStr}::vector, ${metaStr}::jsonb, ${row.entity_type}, ${row.entity_id}::uuid, now())`;
        }

        await prisma.$executeRaw`
          UPDATE "rag_entity_index" SET status='READY', chunk_count=${chunks.length}, indexed_at=now(), updated_at=now()
          WHERE id=${row.id}::uuid`;

        if (row.entity_type === 'ci') ciProcessed++;
        else if (row.entity_type === 'contract') contractProcessed++;
        else if (row.entity_type === 'license') licenseProcessed++;
        else if (row.entity_type === 'vulnerability') vulnProcessed++;
        else if (row.entity_type === 'decommission') decommissionProcessed++;
      } catch (e) {
        console.error('[RAG] processRagQueue entity error:', e);
        const errMsg = String(e).slice(0, 500);
        try {
          await prisma.$executeRaw`
            UPDATE "rag_entity_index" SET status='ERROR', error_message=${errMsg}, updated_at=now()
            WHERE id=${row.id}::uuid`;
        } catch (e2) {
          console.error('[RAG] processRagQueue entity error-mark failure:', e2);
        }
        if (row.entity_type === 'ci') ciErrors++;
        else if (row.entity_type === 'contract') contractErrors++;
        else if (row.entity_type === 'license') licenseErrors++;
        else if (row.entity_type === 'vulnerability') vulnErrors++;
        else if (row.entity_type === 'decommission') decommissionErrors++;
      }
    }

    // ── INDEX_BATCH audit row (v2.N5 / ENT-06) ─────────────────────────────────
    // Aggregates the cycle's work. Skip when nothing happened (idle ticks).
    const totalActivity =
      docsProcessed + docsErrors +
      ciProcessed + ciErrors +
      contractProcessed + contractErrors +
      licenseProcessed + licenseErrors +
      vulnProcessed + vulnErrors;

    if (totalActivity > 0) {
      try {
        await prisma.$executeRaw`
          INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, details, created_at)
          VALUES(gen_random_uuid(), 'INDEX_BATCH', 'RagEntityIndex', 'system', 'system',
            ${JSON.stringify({
              cycle_at: new Date().toISOString(),
              docs: { processed: docsProcessed, errors: docsErrors },
              ci: { processed: ciProcessed, errors: ciErrors },
              contract: { processed: contractProcessed, errors: contractErrors },
              license: { processed: licenseProcessed, errors: licenseErrors },
              vulnerability: { processed: vulnProcessed, errors: vulnErrors },
              decommission: { processed: decommissionProcessed, errors: decommissionErrors },
            })}::jsonb, now())`;
      } catch (e) {
        console.error('[RAG] processRagQueue audit batch error:', e);
      }
    }
  }

  return { queueEntityForIndexing, purgeEntityFromRag, processRagQueue };
}
