BEGIN;

ALTER TABLE "vuln_import_batches"
  ADD COLUMN IF NOT EXISTS "progress_phase" VARCHAR(30),
  ADD COLUMN IF NOT EXISTS "progress_current" INTEGER,
  ADD COLUMN IF NOT EXISTS "progress_total" INTEGER,
  ADD COLUMN IF NOT EXISTS "error_message" TEXT;

COMMIT;
