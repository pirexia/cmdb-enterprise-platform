-- Migration: bulk document import (staging area + AI analysis)
-- Two staging tables back the bulk-upload flow. Files live in a staging dir on
-- disk until the user confirms a line; only then are real Document/Contract/
-- License records materialized. Idempotent (IF NOT EXISTS) per project workflow.

-- ── Batch: one row per bulk upload ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "bulk_import_batch" (
  "id"          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_by"  VARCHAR(255) NOT NULL,
  "status"      VARCHAR(30)  NOT NULL DEFAULT 'UPLOADED',
  "file_count"  INTEGER      NOT NULL DEFAULT 0,
  "total_bytes" BIGINT       NOT NULL DEFAULT 0,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updated_at"  TIMESTAMP(3) NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_bulk_import_batch_status"  ON "bulk_import_batch" ("status");
CREATE INDEX IF NOT EXISTS "idx_bulk_import_batch_creator" ON "bulk_import_batch" ("created_by");
CREATE INDEX IF NOT EXISTS "idx_bulk_import_batch_created" ON "bulk_import_batch" ("created_at");

-- ── Item: one row per uploaded file within a batch ───────────────────────────
CREATE TABLE IF NOT EXISTS "bulk_import_item" (
  "id"                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "batch_id"              UUID         NOT NULL,
  "staged_file_name"      VARCHAR(255) NOT NULL,
  "original_name"         VARCHAR(500) NOT NULL,
  "mime_type"             VARCHAR(255) NOT NULL,
  "file_size"             INTEGER      NOT NULL DEFAULT 0,
  "status"                VARCHAR(30)  NOT NULL DEFAULT 'PENDING_ANALYSIS',
  "analysis"              JSONB        NOT NULL DEFAULT '{}',
  "error_message"         TEXT,
  "committed_document_id" UUID,
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updated_at"            TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT "bulk_import_item_batch_fk"
    FOREIGN KEY ("batch_id") REFERENCES "bulk_import_batch" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_bulk_import_item_batch"  ON "bulk_import_item" ("batch_id");
CREATE INDEX IF NOT EXISTS "idx_bulk_import_item_status" ON "bulk_import_item" ("status");
