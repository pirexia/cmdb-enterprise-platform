-- ============================================================
-- Migration: 20260521120000_rag_entity_chunks
-- Purpose:   Extiende rag_chunks para soportar entidades no-documento
--
-- Lock analysis (DB-1, DB-3):
--   - ALTER DROP NOT NULL: ACCESS EXCLUSIVE, <1ms (metadata)
--   - ADD COLUMN NOT NULL DEFAULT 'document': metadata-only (PG ≥11)
--   - UPDATE+SET NOT NULL: full scan ~10k rows, <50ms
--   - CREATE INDEX (B-tree): ShareLock, <100ms a la escala actual
--   Total transaction time estimate: 100–200ms en producción
--
-- embedding vector(1024): bge-m3. Cambio de dimension requiere
-- ALTER COLUMN TYPE + REINDEX HNSW (ver SYSADMIN §19.6).
-- ============================================================

SET lock_timeout = '3s';

-- ── Paso 1: document_id nullable (para chunks de entidad) ────────────────────
ALTER TABLE "rag_chunks" ALTER COLUMN "document_id" DROP NOT NULL;

-- ── Paso 2: entity_type ─────────────────────────────────────────────────────
-- ADD COLUMN ... NOT NULL DEFAULT literal es metadata-only en PG ≥11.
-- CHECK named para idempotencia ante re-run (DB-10).
ALTER TABLE "rag_chunks"
  ADD COLUMN IF NOT EXISTS "entity_type" text NOT NULL DEFAULT 'document'
    CONSTRAINT "rag_chunks_entity_type_check"
    CHECK ("entity_type" IN ('document','ci','contract','license','vulnerability'));

-- ── Paso 3: entity_id (nullable temporalmente) ───────────────────────────────
ALTER TABLE "rag_chunks"
  ADD COLUMN IF NOT EXISTS "entity_id" uuid;

-- ── Paso 4: backfill idempotente ─────────────────────────────────────────────
UPDATE "rag_chunks" SET "entity_id" = "document_id" WHERE "entity_id" IS NULL;

-- ── Paso 5: NOT NULL sobre entity_id ─────────────────────────────────────────
ALTER TABLE "rag_chunks" ALTER COLUMN "entity_id" SET NOT NULL;

RESET lock_timeout;

-- ── Paso 6: índice compuesto entity_type+entity_id ───────────────────────────
-- Cubre: lookup chunks por entidad, DELETE en hooks, listing por tipo.
-- Partial WHERE entity_type != 'document' diferido hasta >200k chunks.
CREATE INDEX IF NOT EXISTS "idx_rag_chunks_entity"
  ON "rag_chunks" ("entity_type", "entity_id");

-- ── Paso 7: rag_entity_index ─────────────────────────────────────────────────
-- Deliberadamente SEPARADO de rag_document_index:
--   - rag_document_index: clave (document_id, version_number) — docs versionados
--   - rag_entity_index:   clave (entity_type, entity_id) — entidades mutables
CREATE TABLE IF NOT EXISTS "rag_entity_index" (
  "id"            uuid        NOT NULL DEFAULT gen_random_uuid(),
  "entity_type"   text        NOT NULL
    CONSTRAINT "rag_entity_index_entity_type_check"
    CHECK ("entity_type" IN ('ci','contract','license','vulnerability')),
  "entity_id"     uuid        NOT NULL,
  "status"        text        NOT NULL DEFAULT 'PENDING'
    CONSTRAINT "rag_entity_index_status_check"
    CHECK ("status" IN ('PENDING','INDEXING','READY','ERROR')),
  "error_message" text,
  "chunk_count"   integer     NOT NULL DEFAULT 0,
  "indexed_at"    timestamptz,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "updated_at"    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "rag_entity_index_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "rag_entity_index_unique" UNIQUE ("entity_type", "entity_id")
);

CREATE INDEX IF NOT EXISTS "idx_rag_entity_index_status"
  ON "rag_entity_index" ("status");

COMMENT ON TABLE "rag_entity_index" IS
  'Estado de indexación RAG para entidades no-documento. Tabla separada de rag_document_index porque las entidades son mutables (no versionadas en el pipeline).';
