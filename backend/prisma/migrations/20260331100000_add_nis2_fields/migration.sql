-- NIS2 / ISO 22301 / GDPR compliance fields
-- BusinessImpact and DataClassification are stored as TEXT (no PG enum needed)

ALTER TABLE "configuration_items"
  ADD COLUMN IF NOT EXISTS "business_impact"      TEXT,
  ADD COLUMN IF NOT EXISTS "recovery_priority"    INTEGER,
  ADD COLUMN IF NOT EXISTS "rto"                  INTEGER,
  ADD COLUMN IF NOT EXISTS "rpo"                  INTEGER,
  ADD COLUMN IF NOT EXISTS "spof_risk"            BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "contains_pii"         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "data_classification"  TEXT;
