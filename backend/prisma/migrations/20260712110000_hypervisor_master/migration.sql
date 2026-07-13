-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Hypervisor master table
-- Replaces the per-connector CI.vcenter_sync JSON blob with a proper master-data
-- table for "which system manages this CI's lifecycle" (VMware vCenter, Oracle
-- OLVM, Solaris zones, ...), following the same pattern as ci_types.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "hypervisors" (
  "id"         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "code"       TEXT        UNIQUE NOT NULL,
  "name"       TEXT        NOT NULL,
  -- System-seeded hypervisors (created because a connector for them exists) cannot be
  -- edited or deleted via the UI/API — enforced at the app layer, same convention as
  -- ci_types.is_system.
  "is_system"  BOOLEAN     NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO "hypervisors" ("code", "name", "is_system") VALUES
  ('VMWARE', 'VMware vSphere / vCenter', true)
ON CONFLICT ("code") DO NOTHING;
