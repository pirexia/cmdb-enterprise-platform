-- v3.5.0: Staff Schedule module — departments, per-department schedule config,
-- global summer period, weekly schedules, entries (PII, Art.9 subset masked at
-- the app layer), alerts, and row-level department-manager authorization.
--
-- Status/severity/type columns are TEXT (validated by Zod allowlists in the
-- app), not PG enums — avoids the enum-migration friction hit in v3.4.4.
--
-- FKs to users are ON DELETE CASCADE so the existing GDPR erasure endpoint
-- (DELETE /api/admin/users/:id, which hard-deletes the user row) does not
-- violate a FK when the user has schedule history (docs/PLAN_v3.5.0.md D6).

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "department_id" UUID;

CREATE TABLE IF NOT EXISTS "departments" (
  "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"             TEXT NOT NULL,
  "code"             TEXT NOT NULL UNIQUE,
  "service_start"    TEXT NOT NULL,
  "service_end"      TEXT NOT NULL,
  "presence_start"   TEXT NOT NULL,
  "presence_end"     TEXT NOT NULL,
  "min_presence_pct" INTEGER NOT NULL DEFAULT 50,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"       TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'users_department_id_fkey'
  ) THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_department_id_fkey"
      FOREIGN KEY ("department_id") REFERENCES "departments"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "users_department_id_idx" ON "users"("department_id");

CREATE TABLE IF NOT EXISTS "department_managers" (
  "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "department_id" UUID NOT NULL REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "user_id"       UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "department_managers_department_id_user_id_key" UNIQUE ("department_id", "user_id")
);

CREATE INDEX IF NOT EXISTS "department_managers_user_id_idx" ON "department_managers"("user_id");

CREATE TABLE IF NOT EXISTS "department_schedule_configs" (
  "id"                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "department_id"             UUID NOT NULL UNIQUE REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "winter_daily_net_hours"    DOUBLE PRECISION NOT NULL DEFAULT 8.0,
  "winter_max_daily_net_hours" DOUBLE PRECISION NOT NULL DEFAULT 9.0,
  "winter_break_minutes"      INTEGER NOT NULL DEFAULT 60,
  "winter_friday_net_hours"   DOUBLE PRECISION NOT NULL DEFAULT 6.0,
  "summer_daily_net_hours"    DOUBLE PRECISION NOT NULL DEFAULT 8.0,
  "summer_max_daily_net_hours" DOUBLE PRECISION NOT NULL DEFAULT 9.0,
  "summer_break_minutes"      INTEGER NOT NULL DEFAULT 30,
  "summer_friday_net_hours"   DOUBLE PRECISION NOT NULL DEFAULT 6.0,
  "weekly_target_net_hours"   DOUBLE PRECISION NOT NULL DEFAULT 40.0,
  "monthly_telework_cap"      INTEGER NOT NULL DEFAULT 10,
  "flex_entry_start"          TEXT NOT NULL DEFAULT '07:00',
  "flex_entry_end"            TEXT NOT NULL DEFAULT '10:30',
  "flex_exit_start"           TEXT NOT NULL DEFAULT '16:00',
  "flex_exit_end"             TEXT NOT NULL DEFAULT '19:00'
);

CREATE TABLE IF NOT EXISTS "summer_schedules" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "year"       INTEGER NOT NULL UNIQUE,
  "start_date" DATE NOT NULL,
  "end_date"   DATE NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "staff_schedules" (
  "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "department_id"   UUID NOT NULL REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "week_start"      DATE NOT NULL,
  "week_end"        DATE NOT NULL,
  "status"          TEXT NOT NULL DEFAULT 'DRAFT',
  "year"            INTEGER NOT NULL,
  "is_summer_week"  BOOLEAN NOT NULL DEFAULT false,
  "created_by"      TEXT NOT NULL,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "staff_schedules_department_id_week_start_key" UNIQUE ("department_id", "week_start")
);

CREATE INDEX IF NOT EXISTS "staff_schedules_department_id_idx" ON "staff_schedules"("department_id");
CREATE INDEX IF NOT EXISTS "staff_schedules_week_start_idx" ON "staff_schedules"("week_start");

CREATE TABLE IF NOT EXISTS "schedule_entries" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "schedule_id" UUID NOT NULL REFERENCES "staff_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "user_id"     UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "date"        DATE NOT NULL,
  "status"      TEXT NOT NULL,
  "start_time"  TEXT,
  "end_time"    TEXT,
  "notes"       TEXT,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "schedule_entries_schedule_id_user_id_date_key" UNIQUE ("schedule_id", "user_id", "date")
);

CREATE INDEX IF NOT EXISTS "schedule_entries_schedule_id_idx" ON "schedule_entries"("schedule_id");
CREATE INDEX IF NOT EXISTS "schedule_entries_user_id_idx" ON "schedule_entries"("user_id");
CREATE INDEX IF NOT EXISTS "schedule_entries_date_idx" ON "schedule_entries"("date");

CREATE TABLE IF NOT EXISTS "schedule_alerts" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "schedule_id" UUID NOT NULL REFERENCES "staff_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "type"        TEXT NOT NULL,
  "severity"    TEXT NOT NULL,
  "message"     TEXT NOT NULL,
  "user_id"     UUID,
  "date"        DATE,
  "resolved"    BOOLEAN NOT NULL DEFAULT false,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "schedule_alerts_schedule_id_idx" ON "schedule_alerts"("schedule_id");
CREATE INDEX IF NOT EXISTS "schedule_alerts_type_idx" ON "schedule_alerts"("type");
