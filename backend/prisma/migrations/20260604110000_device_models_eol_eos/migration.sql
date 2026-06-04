-- Task S (v2.5.3): expose EOL/EOS on device_models so masters UI can store
-- vendor-level support dates as defaults. CI.eol_date / CI.eos_date remain
-- the per-instance source of truth (sync-eol still propagates to CIs).

ALTER TABLE "device_models"
  ADD COLUMN IF NOT EXISTS "eol_date" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "eos_date" TIMESTAMP(3);
