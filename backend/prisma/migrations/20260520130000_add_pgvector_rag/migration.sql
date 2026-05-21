-- Migration: Add pgvector extension and RAG subsystem tables
--
-- Compliance:
--   ISO 27001:2022 A.5.15 (Access control) — rag_chunks inherits document
--     ACL via document_id FK; visibility is enforced at query time by the
--     docVisibilitySqlCol() helper in backend/src/index.ts.
--   ISO 27001:2022 A.8.15 (Logging) — rag_chat_messages stores session/msg
--     IDs referenced by audit_logs.entity_id for ASK_RAG entries.
--   GDPR Art.5 (Storage limitation) — retention enforced by scheduled purge
--     (90 days for sessions/messages; cascade delete for chunks on doc delete).
--   NIS2 Art.21 — see docs/security/rag-dpia.md §11.

-- ── pgvector extension ────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS vector;

-- ── rag_document_index ────────────────────────────────────────────────────────
-- Tracks indexing state for each document version. One row per (documentId,
-- versionNumber). Only the latest version (isLatest=true) is actively queried.
CREATE TABLE IF NOT EXISTS "rag_document_index" (
  "id"             uuid        NOT NULL DEFAULT gen_random_uuid(),
  "document_id"    uuid        NOT NULL,
  "version_number" integer     NOT NULL DEFAULT 1,
  "status"         text        NOT NULL DEFAULT 'PENDING'
                               CHECK (status IN ('PENDING','INDEXING','READY','ERROR')),
  "error_message"  text,
  "chunk_count"    integer     NOT NULL DEFAULT 0,
  "indexed_at"     timestamptz,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "updated_at"     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "rag_document_index_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "rag_document_index_document_id_fkey"
    FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "rag_document_index_unique" UNIQUE ("document_id", "version_number")
);

CREATE INDEX IF NOT EXISTS "idx_rag_doc_index_status"
  ON "rag_document_index"("status");
CREATE INDEX IF NOT EXISTS "idx_rag_doc_index_document_id"
  ON "rag_document_index"("document_id");

-- ── rag_chunks ────────────────────────────────────────────────────────────────
-- Text fragments extracted from documents with their vector embeddings.
-- CASCADE DELETE ensures chunks are removed when their parent document
-- is deleted, fulfilling GDPR Art.17 (right to erasure).
CREATE TABLE IF NOT EXISTS "rag_chunks" (
  "id"              uuid        NOT NULL DEFAULT gen_random_uuid(),
  "document_id"     uuid        NOT NULL,
  "version_number"  integer     NOT NULL DEFAULT 1,
  "chunk_index"     integer     NOT NULL,
  "section_path"    text,
  "page_start"      integer,
  "page_end"        integer,
  "token_count"     integer     NOT NULL DEFAULT 0,
  "content"         text        NOT NULL,
  "embedding"       vector(1024),
  "metadata"        jsonb       NOT NULL DEFAULT '{}',
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "rag_chunks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "rag_chunks_document_id_fkey"
    FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_rag_chunks_document_id"
  ON "rag_chunks"("document_id");

-- HNSW index for fast approximate nearest-neighbour search (cosine similarity).
-- m=16 ef_construction=64 are balanced defaults for up to ~500k chunks.
CREATE INDEX IF NOT EXISTS "idx_rag_chunks_embedding_hnsw"
  ON "rag_chunks" USING hnsw ("embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- ── rag_chat_sessions ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "rag_chat_sessions" (
  "id"         uuid        NOT NULL DEFAULT gen_random_uuid(),
  "user_id"    uuid        NOT NULL,
  "title"      text        NOT NULL DEFAULT 'Nueva consulta',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "rag_chat_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "rag_chat_sessions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_rag_chat_sessions_user_id"
  ON "rag_chat_sessions"("user_id");
CREATE INDEX IF NOT EXISTS "idx_rag_chat_sessions_created_at"
  ON "rag_chat_sessions"("created_at");

-- ── rag_chat_messages ─────────────────────────────────────────────────────────
-- Stores question+answer pairs. citations is a JSONB array of
-- {documentId, documentTitle, versionNumber, page, section, snippet}.
-- query_hash is SHA-256(question) stored for audit without exposing PII.
CREATE TABLE IF NOT EXISTS "rag_chat_messages" (
  "id"           uuid        NOT NULL DEFAULT gen_random_uuid(),
  "session_id"   uuid        NOT NULL,
  "role"         text        NOT NULL CHECK (role IN ('user','assistant')),
  "content"      text        NOT NULL,
  "citations"    jsonb       NOT NULL DEFAULT '[]',
  "query_hash"   text,
  "model_used"   text,
  "tokens_used"  integer,
  "latency_ms"   integer,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "rag_chat_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "rag_chat_messages_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "rag_chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_rag_chat_messages_session_id"
  ON "rag_chat_messages"("session_id");
CREATE INDEX IF NOT EXISTS "idx_rag_chat_messages_created_at"
  ON "rag_chat_messages"("created_at");
