-- Migration: CI bulk import staging tables
-- Mirror of bulk_import_batch/item for document imports, but for CIs.
-- Each item holds one row from the uploaded XLSX; analysis JSON contains
-- AI-extracted fields + conflict detection results.

CREATE TABLE IF NOT EXISTS "ci_bulk_import_batch" (
  "id"              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "created_by"      VARCHAR(255) NOT NULL,
  "status"          VARCHAR(30)  NOT NULL DEFAULT 'UPLOADED',
  "row_count"       INTEGER      NOT NULL DEFAULT 0,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updated_at"      TIMESTAMP(3) NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_ci_bulk_batch_status"   ON "ci_bulk_import_batch" ("status");
CREATE INDEX IF NOT EXISTS "idx_ci_bulk_batch_creator"  ON "ci_bulk_import_batch" ("created_by");
CREATE INDEX IF NOT EXISTS "idx_ci_bulk_batch_created"  ON "ci_bulk_import_batch" ("created_at");

CREATE TABLE IF NOT EXISTS "ci_bulk_import_item" (
  "id"                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "batch_id"          UUID         NOT NULL,
  "row_index"         INTEGER      NOT NULL,          -- 1-based row number in the XLSX
  "raw_data"          JSONB        NOT NULL DEFAULT '{}', -- verbatim parsed row
  "status"            VARCHAR(30)  NOT NULL DEFAULT 'PENDING_ANALYSIS',
  "analysis"          JSONB        NOT NULL DEFAULT '{}', -- AI result + conflicts
  "error_message"     TEXT,
  "committed_ci_id"   UUID,                           -- set when CI created
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updated_at"        TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT "ci_bulk_item_batch_fk"
    FOREIGN KEY ("batch_id") REFERENCES "ci_bulk_import_batch" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_ci_bulk_item_batch"  ON "ci_bulk_import_item" ("batch_id");
CREATE INDEX IF NOT EXISTS "idx_ci_bulk_item_status" ON "ci_bulk_import_item" ("status");
