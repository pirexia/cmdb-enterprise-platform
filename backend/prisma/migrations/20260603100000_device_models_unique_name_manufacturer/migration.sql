-- Fix: add UNIQUE index on device_models(LOWER(name), manufacturer_id) to prevent
-- duplicate rows from concurrent bulk-import workers (OWASP A03-1, v2.5.2).
--
-- Without this index, two workers inserting the same new model simultaneously both
-- succeed, creating silent duplicate master data rows.  With this functional index,
-- the second INSERT hits ON CONFLICT DO NOTHING and the caller re-SELECTs the
-- row created by the first worker.
--
-- Rollback: DROP INDEX IF EXISTS "device_models_name_mfr_key";

CREATE UNIQUE INDEX IF NOT EXISTS "device_models_name_mfr_key"
  ON "device_models" (LOWER(name), manufacturer_id);
