-- v3.6.1 — CrowdStrike Spotlight vulnerability source (spec §1 B1).
--
-- Generalizes "vuln_import_entries" (created in 20260729130000_vuln_import_staging
-- for Greenbone-only) so it can also hold CrowdStrike Spotlight entries through
-- the same staging workflow (upload → PENDING batch → review → accept/discard).
--
-- "oid" is Greenbone-specific (an OpenVAS plugin identifier) and has no
-- CrowdStrike equivalent, so it becomes nullable. "port" was already nullable
-- (see the base migration) — DROP NOT NULL on it here is a no-op, kept for
-- documentation/idempotency, not because it's currently required.

ALTER TABLE "vuln_import_entries" ALTER COLUMN "oid" DROP NOT NULL;
ALTER TABLE "vuln_import_entries" ALTER COLUMN "port" DROP NOT NULL;

ALTER TABLE "vuln_import_entries" ADD COLUMN IF NOT EXISTS "products" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "vuln_import_entries" ADD COLUMN IF NOT EXISTS "exprt_rating" VARCHAR(20);
ALTER TABLE "vuln_import_entries" ADD COLUMN IF NOT EXISTS "cisa_kev" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "vuln_import_entries" ADD COLUMN IF NOT EXISTS "cisa_due_date" TIMESTAMP(3);
ALTER TABLE "vuln_import_entries" ADD COLUMN IF NOT EXISTS "exploit_status" VARCHAR(255);
ALTER TABLE "vuln_import_entries" ADD COLUMN IF NOT EXISTS "days_open" INTEGER;
ALTER TABLE "vuln_import_entries" ADD COLUMN IF NOT EXISTS "external_status" VARCHAR(30);
ALTER TABLE "vuln_import_entries" ADD COLUMN IF NOT EXISTS "cvss_version" VARCHAR(20);
