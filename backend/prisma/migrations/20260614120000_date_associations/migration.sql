-- T5: Entity-Date association tables (lifecycle dates per CI, OS, BSW, DeviceModel)
-- DateType master created in migration 20260614100000_date_types (T4).
-- Mirror triggers: on INSERT/UPDATE of a canonical code association, sync the
-- legacy eol_date / eos_date columns on the parent entity for backward compat.

BEGIN;

-- ─── ci_dates ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "ci_dates" (
  "id"          UUID        NOT NULL DEFAULT gen_random_uuid(),
  "ci_id"       UUID        NOT NULL,
  "date_type_id" UUID       NOT NULL,
  "date_value"  DATE        NOT NULL,
  "notes"       TEXT,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "ci_dates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ci_dates_ci_id_date_type_id_key" UNIQUE ("ci_id", "date_type_id"),
  CONSTRAINT "ci_dates_ci_id_fkey"
    FOREIGN KEY ("ci_id") REFERENCES "configuration_items"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ci_dates_date_type_id_fkey"
    FOREIGN KEY ("date_type_id") REFERENCES "date_types"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "ci_dates_ci_id_idx"   ON "ci_dates"("ci_id");

-- Mirror trigger: keep configuration_items.eol_date / eos_date in sync
CREATE OR REPLACE FUNCTION sync_ci_eol_eos() RETURNS TRIGGER AS $$
DECLARE
  v_code TEXT;
BEGIN
  SELECT code INTO v_code FROM date_types WHERE id = NEW.date_type_id;
  IF v_code = 'end-of-life' THEN
    UPDATE configuration_items SET eol_date = NEW.date_value WHERE id = NEW.ci_id;
  ELSIF v_code = 'end-of-support' THEN
    UPDATE configuration_items SET eos_date = NEW.date_value WHERE id = NEW.ci_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_ci_eol_eos ON "ci_dates";
CREATE TRIGGER trg_sync_ci_eol_eos
  AFTER INSERT OR UPDATE ON "ci_dates"
  FOR EACH ROW EXECUTE FUNCTION sync_ci_eol_eos();

-- Null-out mirror when association is deleted
CREATE OR REPLACE FUNCTION sync_ci_eol_eos_delete() RETURNS TRIGGER AS $$
DECLARE
  v_code TEXT;
BEGIN
  SELECT code INTO v_code FROM date_types WHERE id = OLD.date_type_id;
  IF v_code = 'end-of-life' THEN
    UPDATE configuration_items SET eol_date = NULL WHERE id = OLD.ci_id;
  ELSIF v_code = 'end-of-support' THEN
    UPDATE configuration_items SET eos_date = NULL WHERE id = OLD.ci_id;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_ci_eol_eos_del ON "ci_dates";
CREATE TRIGGER trg_sync_ci_eol_eos_del
  AFTER DELETE ON "ci_dates"
  FOR EACH ROW EXECUTE FUNCTION sync_ci_eol_eos_delete();

-- ─── operating_system_dates ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "operating_system_dates" (
  "id"                 UUID        NOT NULL DEFAULT gen_random_uuid(),
  "operating_system_id" UUID       NOT NULL,
  "date_type_id"       UUID        NOT NULL,
  "date_value"         DATE        NOT NULL,
  "notes"              TEXT,
  "created_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "operating_system_dates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "operating_system_dates_os_id_date_type_id_key" UNIQUE ("operating_system_id", "date_type_id"),
  CONSTRAINT "operating_system_dates_os_id_fkey"
    FOREIGN KEY ("operating_system_id") REFERENCES "operating_systems"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "operating_system_dates_date_type_id_fkey"
    FOREIGN KEY ("date_type_id") REFERENCES "date_types"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "os_dates_os_id_idx" ON "operating_system_dates"("operating_system_id");

-- ─── base_software_dates ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "base_software_dates" (
  "id"              UUID        NOT NULL DEFAULT gen_random_uuid(),
  "base_software_id" UUID       NOT NULL,
  "date_type_id"    UUID        NOT NULL,
  "date_value"      DATE        NOT NULL,
  "notes"           TEXT,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "base_software_dates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "base_software_dates_bsw_id_date_type_id_key" UNIQUE ("base_software_id", "date_type_id"),
  CONSTRAINT "base_software_dates_bsw_id_fkey"
    FOREIGN KEY ("base_software_id") REFERENCES "base_software"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "base_software_dates_date_type_id_fkey"
    FOREIGN KEY ("date_type_id") REFERENCES "date_types"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "bsw_dates_bsw_id_idx" ON "base_software_dates"("base_software_id");

-- ─── device_model_dates ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "device_model_dates" (
  "id"              UUID        NOT NULL DEFAULT gen_random_uuid(),
  "device_model_id" UUID        NOT NULL,
  "date_type_id"    UUID        NOT NULL,
  "date_value"      DATE        NOT NULL,
  "notes"           TEXT,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "device_model_dates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "device_model_dates_dm_id_date_type_id_key" UNIQUE ("device_model_id", "date_type_id"),
  CONSTRAINT "device_model_dates_dm_id_fkey"
    FOREIGN KEY ("device_model_id") REFERENCES "device_models"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "device_model_dates_date_type_id_fkey"
    FOREIGN KEY ("date_type_id") REFERENCES "date_types"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "dm_dates_dm_id_idx" ON "device_model_dates"("device_model_id");

-- Mirror trigger: keep device_models.eol_date / eos_date in sync
CREATE OR REPLACE FUNCTION sync_dm_eol_eos() RETURNS TRIGGER AS $$
DECLARE
  v_code TEXT;
BEGIN
  SELECT code INTO v_code FROM date_types WHERE id = NEW.date_type_id;
  IF v_code = 'hw-end-of-life' THEN
    UPDATE device_models SET eol_date = NEW.date_value WHERE id = NEW.device_model_id;
  ELSIF v_code = 'hw-end-of-support' THEN
    UPDATE device_models SET eos_date = NEW.date_value WHERE id = NEW.device_model_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_dm_eol_eos ON "device_model_dates";
CREATE TRIGGER trg_sync_dm_eol_eos
  AFTER INSERT OR UPDATE ON "device_model_dates"
  FOR EACH ROW EXECUTE FUNCTION sync_dm_eol_eos();

CREATE OR REPLACE FUNCTION sync_dm_eol_eos_delete() RETURNS TRIGGER AS $$
DECLARE
  v_code TEXT;
BEGIN
  SELECT code INTO v_code FROM date_types WHERE id = OLD.date_type_id;
  IF v_code = 'hw-end-of-life' THEN
    UPDATE device_models SET eol_date = NULL WHERE id = OLD.device_model_id;
  ELSIF v_code = 'hw-end-of-support' THEN
    UPDATE device_models SET eos_date = NULL WHERE id = OLD.device_model_id;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_dm_eol_eos_del ON "device_model_dates";
CREATE TRIGGER trg_sync_dm_eol_eos_del
  AFTER DELETE ON "device_model_dates"
  FOR EACH ROW EXECUTE FUNCTION sync_dm_eol_eos_delete();

-- ─── Backfill: migrate existing eol_date/eos_date → ci_dates (if any) ────────

INSERT INTO "ci_dates" ("id", "ci_id", "date_type_id", "date_value")
SELECT
  gen_random_uuid(),
  ci.id,
  dt.id,
  ci.eol_date::date
FROM "configuration_items" ci
CROSS JOIN (SELECT id FROM "date_types" WHERE code = 'end-of-life') dt
WHERE ci.eol_date IS NOT NULL
ON CONFLICT ("ci_id", "date_type_id") DO NOTHING;

INSERT INTO "ci_dates" ("id", "ci_id", "date_type_id", "date_value")
SELECT
  gen_random_uuid(),
  ci.id,
  dt.id,
  ci.eos_date::date
FROM "configuration_items" ci
CROSS JOIN (SELECT id FROM "date_types" WHERE code = 'end-of-support') dt
WHERE ci.eos_date IS NOT NULL
ON CONFLICT ("ci_id", "date_type_id") DO NOTHING;

INSERT INTO "device_model_dates" ("id", "device_model_id", "date_type_id", "date_value")
SELECT
  gen_random_uuid(),
  dm.id,
  dt.id,
  dm.eol_date::date
FROM "device_models" dm
CROSS JOIN (SELECT id FROM "date_types" WHERE code = 'hw-end-of-life') dt
WHERE dm.eol_date IS NOT NULL
ON CONFLICT ("device_model_id", "date_type_id") DO NOTHING;

INSERT INTO "device_model_dates" ("id", "device_model_id", "date_type_id", "date_value")
SELECT
  gen_random_uuid(),
  dm.id,
  dt.id,
  dm.eos_date::date
FROM "device_models" dm
CROSS JOIN (SELECT id FROM "date_types" WHERE code = 'hw-end-of-support') dt
WHERE dm.eos_date IS NOT NULL
ON CONFLICT ("device_model_id", "date_type_id") DO NOTHING;

COMMIT;
