-- Migration: 20260604120000_dcim_initial
-- DCIM Module: buildings, floors, rooms, aisles, footprints + hardware_cis DCIM extensions
-- Part of v2.6.0 feature branch feature/dcim-rooms

-- ─── 1. DCIM Buildings ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "dcim_buildings" (
  "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
  "branch_id"   UUID         NOT NULL,
  "name"        VARCHAR(255) NOT NULL,
  "code"        VARCHAR(50),
  "notes"       TEXT,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dcim_buildings_pkey"                 PRIMARY KEY ("id"),
  CONSTRAINT "dcim_buildings_branch_id_fkey"       FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "dcim_buildings_branch_id_name_key"   UNIQUE ("branch_id", "name")
);

CREATE INDEX IF NOT EXISTS "dcim_buildings_branch_id_idx" ON "dcim_buildings"("branch_id");

-- ─── 2. DCIM Floors ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "dcim_floors" (
  "id"           UUID         NOT NULL DEFAULT gen_random_uuid(),
  "building_id"  UUID         NOT NULL,
  "name"         VARCHAR(255) NOT NULL,
  "level_number" INTEGER      NOT NULL,
  "notes"        TEXT,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dcim_floors_pkey"                          PRIMARY KEY ("id"),
  CONSTRAINT "dcim_floors_building_id_fkey"              FOREIGN KEY ("building_id") REFERENCES "dcim_buildings"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "dcim_floors_building_id_level_number_key"  UNIQUE ("building_id", "level_number")
);

-- ─── 3. DCIM Rooms ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "dcim_rooms" (
  "id"         UUID         NOT NULL DEFAULT gen_random_uuid(),
  "floor_id"   UUID         NOT NULL,
  "name"       VARCHAR(255) NOT NULL,
  "kind"       VARCHAR(30)  NOT NULL,
  "width_mm"   INTEGER,
  "depth_mm"   INTEGER,
  "notes"      TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dcim_rooms_pkey"              PRIMARY KEY ("id"),
  CONSTRAINT "dcim_rooms_floor_id_fkey"     FOREIGN KEY ("floor_id") REFERENCES "dcim_floors"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "dcim_rooms_floor_id_name_key" UNIQUE ("floor_id", "name"),
  CONSTRAINT "dcim_rooms_width_mm_check"    CHECK ("width_mm" IS NULL OR ("width_mm" > 0 AND "width_mm" < 100000)),
  CONSTRAINT "dcim_rooms_depth_mm_check"    CHECK ("depth_mm" IS NULL OR ("depth_mm" > 0 AND "depth_mm" < 100000))
);

-- ─── 4. DCIM Aisles ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "dcim_aisles" (
  "id"         UUID         NOT NULL DEFAULT gen_random_uuid(),
  "room_id"    UUID         NOT NULL,
  "name"       VARCHAR(255) NOT NULL,
  "kind"       VARCHAR(20),
  "order_idx"  INTEGER      NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dcim_aisles_pkey"              PRIMARY KEY ("id"),
  CONSTRAINT "dcim_aisles_room_id_fkey"      FOREIGN KEY ("room_id") REFERENCES "dcim_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "dcim_aisles_room_id_name_key"  UNIQUE ("room_id", "name")
);

-- ─── 5. DCIM Footprints ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "dcim_footprints" (
  "id"          UUID        NOT NULL DEFAULT gen_random_uuid(),
  "room_id"     UUID        NOT NULL,
  "aisle_id"    UUID,
  "label"       VARCHAR(50) NOT NULL,
  "kind"        VARCHAR(30) NOT NULL,
  "active"      BOOLEAN     NOT NULL DEFAULT true,
  "grid_x"      INTEGER     NOT NULL,
  "grid_y"      INTEGER     NOT NULL,
  "rack_ci_id"  UUID,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dcim_footprints_pkey"                       PRIMARY KEY ("id"),
  CONSTRAINT "dcim_footprints_room_id_fkey"               FOREIGN KEY ("room_id") REFERENCES "dcim_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "dcim_footprints_aisle_id_fkey"              FOREIGN KEY ("aisle_id") REFERENCES "dcim_aisles"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "dcim_footprints_rack_ci_id_fkey"            FOREIGN KEY ("rack_ci_id") REFERENCES "configuration_items"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "dcim_footprints_rack_ci_id_key"             UNIQUE ("rack_ci_id"),
  CONSTRAINT "dcim_footprints_room_id_grid_x_grid_y_key"  UNIQUE ("room_id", "grid_x", "grid_y")
);

CREATE INDEX IF NOT EXISTS "dcim_footprints_room_id_idx" ON "dcim_footprints"("room_id");

-- ─── 6. Extend hardware_cis with DCIM fields ──────────────────────────────────
-- sizeU + powerW: all hardware placed in racks
-- rackTotal* / rackWidth* / rackDepth*: rack-specific capacity fields
-- parentRackCiId + uPosition + orientation: physical placement within a rack

ALTER TABLE "hardware_cis"
  ADD COLUMN IF NOT EXISTS "size_u"            INTEGER,
  ADD COLUMN IF NOT EXISTS "power_w"           INTEGER,
  ADD COLUMN IF NOT EXISTS "rack_total_u"      INTEGER,
  ADD COLUMN IF NOT EXISTS "rack_power_max_w"  INTEGER,
  ADD COLUMN IF NOT EXISTS "rack_width_mm"     INTEGER,
  ADD COLUMN IF NOT EXISTS "rack_depth_mm"     INTEGER,
  ADD COLUMN IF NOT EXISTS "parent_rack_ci_id" UUID,
  ADD COLUMN IF NOT EXISTS "u_position"        INTEGER,
  ADD COLUMN IF NOT EXISTS "orientation"       VARCHAR(10);

ALTER TABLE "hardware_cis"
  ADD CONSTRAINT "hardware_cis_parent_rack_ci_id_fkey"
    FOREIGN KEY ("parent_rack_ci_id") REFERENCES "configuration_items"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "hardware_cis"
  ADD CONSTRAINT "hardware_cis_rack_width_mm_check"
    CHECK ("rack_width_mm" IS NULL OR ("rack_width_mm" > 0 AND "rack_width_mm" < 10000)),
  ADD CONSTRAINT "hardware_cis_rack_depth_mm_check"
    CHECK ("rack_depth_mm" IS NULL OR ("rack_depth_mm" > 0 AND "rack_depth_mm" < 10000));

CREATE INDEX IF NOT EXISTS "hardware_cis_parent_rack_ci_id_idx" ON "hardware_cis"("parent_rack_ci_id");

-- ─── 7. Seed: CIType "Rack" (INFRASTRUCTURE, isSystem=true) ──────────────────

INSERT INTO "ci_types" ("id", "code", "name", "category_code", "sort_order", "is_system", "created_at", "updated_at")
VALUES (
  gen_random_uuid(),
  'RACK',
  'Rack',
  'INFRASTRUCTURE',
  90,
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
) ON CONFLICT ("code") DO NOTHING;

-- ─── ROLLBACK (reverse order — run manually if needed) ───────────────────────
-- DELETE FROM "ci_types" WHERE "code" = 'RACK' AND "is_system" = true;
-- DROP INDEX IF EXISTS "hardware_cis_parent_rack_ci_id_idx";
-- ALTER TABLE "hardware_cis"
--   DROP CONSTRAINT IF EXISTS "hardware_cis_rack_depth_mm_check",
--   DROP CONSTRAINT IF EXISTS "hardware_cis_rack_width_mm_check",
--   DROP CONSTRAINT IF EXISTS "hardware_cis_parent_rack_ci_id_fkey",
--   DROP COLUMN IF EXISTS "orientation",
--   DROP COLUMN IF EXISTS "u_position",
--   DROP COLUMN IF EXISTS "parent_rack_ci_id",
--   DROP COLUMN IF EXISTS "rack_depth_mm",
--   DROP COLUMN IF EXISTS "rack_width_mm",
--   DROP COLUMN IF EXISTS "rack_power_max_w",
--   DROP COLUMN IF EXISTS "rack_total_u",
--   DROP COLUMN IF EXISTS "power_w",
--   DROP COLUMN IF EXISTS "size_u";
-- DROP TABLE IF EXISTS "dcim_footprints";
-- DROP TABLE IF EXISTS "dcim_aisles";
-- DROP TABLE IF EXISTS "dcim_rooms";
-- DROP TABLE IF EXISTS "dcim_floors";
-- DROP TABLE IF EXISTS "dcim_buildings";
