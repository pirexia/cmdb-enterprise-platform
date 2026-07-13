-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: CI.hypervisor_id + CI.power_state, drop CI.vcenter_sync
-- ─────────────────────────────────────────────────────────────────────────────

-- The vcenter_sync JSON column (added in 20260712100000) is superseded by the
-- hypervisor_id FK below + a plain power_state column — a relational ownership
-- marker usable by ANY future hypervisor connector, not a per-connector JSON blob.
ALTER TABLE "configuration_items" DROP COLUMN IF EXISTS "vcenter_sync";

ALTER TABLE "configuration_items"
  ADD COLUMN IF NOT EXISTS "hypervisor_id" UUID REFERENCES "hypervisors"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "power_state" VARCHAR(20);

CREATE INDEX IF NOT EXISTS "configuration_items_hypervisor_id_idx" ON "configuration_items"("hypervisor_id");
