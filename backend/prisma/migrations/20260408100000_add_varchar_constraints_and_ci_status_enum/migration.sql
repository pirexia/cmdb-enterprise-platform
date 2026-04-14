-- Migration: add_varchar_constraints_and_ci_status_enum
-- Fix #43: Add @db.VarChar(n) constraints to String fields
-- Fix #44: Convert CI.status from String? to CIStatus enum

-- ─── Step 1: Create CIStatus enum type ──────────────────────────────────────
CREATE TYPE "CIStatus" AS ENUM ('ACTIVO', 'INACTIVO', 'RETIRADO');

-- ─── Step 2: VarChar constraints — users ────────────────────────────────────
ALTER TABLE "users"
  ALTER COLUMN "username"           TYPE VARCHAR(100),
  ALTER COLUMN "email"              TYPE VARCHAR(255),
  ALTER COLUMN "password"           TYPE VARCHAR(255),
  ALTER COLUMN "sso_external_id"    TYPE VARCHAR(255),
  ALTER COLUMN "mfa_secret"         TYPE VARCHAR(255),
  ALTER COLUMN "mfa_pending_secret" TYPE VARCHAR(255);

-- ─── Step 3: VarChar constraints — cost_centers ─────────────────────────────
ALTER TABLE "cost_centers"
  ALTER COLUMN "code" TYPE VARCHAR(50),
  ALTER COLUMN "name" TYPE VARCHAR(255);

-- ─── Step 4: VarChar constraints — contracts ────────────────────────────────
ALTER TABLE "contracts"
  ALTER COLUMN "contract_number" TYPE VARCHAR(100);

-- ─── Step 5: VarChar constraints — branches ─────────────────────────────────
ALTER TABLE "branches"
  ALTER COLUMN "name"             TYPE VARCHAR(255),
  ALTER COLUMN "branch_code"      TYPE VARCHAR(50),
  ALTER COLUMN "physical_address" TYPE VARCHAR(500);

-- ─── Step 6: VarChar constraints — configuration_items (non-status) ─────────
ALTER TABLE "configuration_items"
  ALTER COLUMN "name"                TYPE VARCHAR(255),
  ALTER COLUMN "api_slug"            TYPE VARCHAR(300),
  ALTER COLUMN "verification_source" TYPE VARCHAR(100),
  ALTER COLUMN "inventory_number"    TYPE VARCHAR(100),
  ALTER COLUMN "assigned_user"       TYPE VARCHAR(255),
  ALTER COLUMN "user_dni"            TYPE VARCHAR(20),
  ALTER COLUMN "floor"               TYPE VARCHAR(50),
  ALTER COLUMN "room"                TYPE VARCHAR(100),
  ALTER COLUMN "rack"                TYPE VARCHAR(50),
  ALTER COLUMN "rack_unit"           TYPE VARCHAR(20),
  ALTER COLUMN "vlan"                TYPE VARCHAR(20),
  ALTER COLUMN "console_ip"          TYPE VARCHAR(45);

-- ─── Step 7: Convert CI.status to CIStatus enum ─────────────────────────────
-- Coerce NULLs and set NOT NULL before changing type
UPDATE "configuration_items" SET "status" = 'ACTIVO' WHERE "status" IS NULL;

-- Drop default first so PostgreSQL can perform the USING cast cleanly
ALTER TABLE "configuration_items" ALTER COLUMN "status" DROP DEFAULT;

-- Convert column type using explicit CAST
ALTER TABLE "configuration_items"
  ALTER COLUMN "status" TYPE "CIStatus"
    USING "status"::"CIStatus";

-- Re-apply NOT NULL and new typed default
ALTER TABLE "configuration_items"
  ALTER COLUMN "status" SET NOT NULL,
  ALTER COLUMN "status" SET DEFAULT 'ACTIVO'::"CIStatus";

-- ─── Step 8: VarChar constraints — hardware_cis ─────────────────────────────
ALTER TABLE "hardware_cis"
  ALTER COLUMN "serial_number" TYPE VARCHAR(255),
  ALTER COLUMN "model"         TYPE VARCHAR(255),
  ALTER COLUMN "manufacturer"  TYPE VARCHAR(255);

-- ─── Step 9: VarChar constraints — software_cis ─────────────────────────────
ALTER TABLE "software_cis"
  ALTER COLUMN "version"      TYPE VARCHAR(100),
  ALTER COLUMN "license_type" TYPE VARCHAR(100);

-- ─── Step 10: VarChar constraints — audit_logs ──────────────────────────────
ALTER TABLE "audit_logs"
  ALTER COLUMN "action"     TYPE VARCHAR(100),
  ALTER COLUMN "entity"     TYPE VARCHAR(100),
  ALTER COLUMN "entity_id"  TYPE VARCHAR(36),
  ALTER COLUMN "user_email" TYPE VARCHAR(255);

-- ─── Step 11: VarChar constraints — licenses ────────────────────────────────
ALTER TABLE "licenses"
  ALTER COLUMN "name"           TYPE VARCHAR(255),
  ALTER COLUMN "license_number" TYPE VARCHAR(100),
  ALTER COLUMN "metric_unit"    TYPE VARCHAR(50),
  ALTER COLUMN "currency"       TYPE VARCHAR(3);

-- ─── Step 12: VarChar constraints — license_users ───────────────────────────
ALTER TABLE "license_users"
  ALTER COLUMN "name"  TYPE VARCHAR(255),
  ALTER COLUMN "dni"   TYPE VARCHAR(20),
  ALTER COLUMN "email" TYPE VARCHAR(255);
