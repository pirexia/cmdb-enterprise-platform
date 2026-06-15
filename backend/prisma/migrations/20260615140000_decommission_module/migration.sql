-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Decommission Plan module tables
-- All tables use IF NOT EXISTS / ON CONFLICT DO NOTHING — fully idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Main plan
CREATE TABLE IF NOT EXISTS "decommission_plan" (
  "id"            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"          TEXT        NOT NULL,
  "system_ci_id"  UUID        NOT NULL REFERENCES "configuration_items"("id") ON DELETE RESTRICT,
  "status"        TEXT        NOT NULL DEFAULT 'DRAFT'
                              CHECK ("status" IN ('DRAFT','ACTIVE','COMPLETED','CANCELLED')),
  "created_by"    TEXT        NOT NULL,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "completed_at"  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS "idx_decommission_plan_system_ci_id"
  ON "decommission_plan"("system_ci_id");

-- 2. CIs belonging to a plan
CREATE TABLE IF NOT EXISTS "decommission_plan_ci" (
  "id"             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "plan_id"        UUID        NOT NULL REFERENCES "decommission_plan"("id") ON DELETE CASCADE,
  "ci_id"          UUID        NOT NULL REFERENCES "configuration_items"("id") ON DELETE CASCADE,
  "parent_ci_id"   UUID,
  "depth"          INTEGER     NOT NULL DEFAULT 0,
  "is_shared"      BOOLEAN     NOT NULL DEFAULT false,
  "scheduled_date" TIMESTAMPTZ,
  "notes"          TEXT,
  "sort_order"     INTEGER     NOT NULL DEFAULT 0,
  UNIQUE ("plan_id", "ci_id")
);

CREATE INDEX IF NOT EXISTS "idx_dplan_ci_plan_id"  ON "decommission_plan_ci"("plan_id");
CREATE INDEX IF NOT EXISTS "idx_dplan_ci_ci_id"    ON "decommission_plan_ci"("ci_id");

-- 3. Documents linked to a plan
CREATE TABLE IF NOT EXISTS "decommission_plan_document" (
  "id"          UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  "plan_id"     UUID  NOT NULL REFERENCES "decommission_plan"("id") ON DELETE CASCADE,
  "document_id" UUID  NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "source"      TEXT  NOT NULL DEFAULT 'AUTO' CHECK ("source" IN ('AUTO','MANUAL')),
  UNIQUE ("plan_id", "document_id")
);

CREATE INDEX IF NOT EXISTS "idx_dplan_doc_plan_id" ON "decommission_plan_document"("plan_id");

-- 4. Contracts linked to a plan
CREATE TABLE IF NOT EXISTS "decommission_plan_contract" (
  "id"          UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  "plan_id"     UUID  NOT NULL REFERENCES "decommission_plan"("id") ON DELETE CASCADE,
  "contract_id" UUID  NOT NULL REFERENCES "contracts"("id") ON DELETE CASCADE,
  "source"      TEXT  NOT NULL DEFAULT 'AUTO' CHECK ("source" IN ('AUTO','MANUAL')),
  UNIQUE ("plan_id", "contract_id")
);

CREATE INDEX IF NOT EXISTS "idx_dplan_contract_plan_id" ON "decommission_plan_contract"("plan_id");

-- 5. Licenses linked to a plan
CREATE TABLE IF NOT EXISTS "decommission_plan_license" (
  "id"         UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  "plan_id"    UUID  NOT NULL REFERENCES "decommission_plan"("id") ON DELETE CASCADE,
  "license_id" UUID  NOT NULL REFERENCES "licenses"("id") ON DELETE CASCADE,
  "source"     TEXT  NOT NULL DEFAULT 'AUTO' CHECK ("source" IN ('AUTO','MANUAL')),
  UNIQUE ("plan_id", "license_id")
);

CREATE INDEX IF NOT EXISTS "idx_dplan_license_plan_id" ON "decommission_plan_license"("plan_id");
