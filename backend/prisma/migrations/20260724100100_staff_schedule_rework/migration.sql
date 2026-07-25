-- v3.5.9: Staff Schedule rework.
--  * GUARDIA becomes a per-entry complement (on_guard) instead of a status
--    value, so a worker can be TELETRABAJO + on guard simultaneously.
--  * schedule_entries.department_id is denormalized from staff_schedules so a
--    DB-level partial unique index can enforce "at most one worker on guard
--    per department per day" without a join (A01 — filter at the DB layer).
--  * users.weekly_target_hours: optional per-user override of the
--    department's default 40h/week target (reduced-hours workers).

ALTER TABLE "schedule_entries" ADD COLUMN IF NOT EXISTS "department_id" UUID;
ALTER TABLE "schedule_entries" ADD COLUMN IF NOT EXISTS "on_guard" BOOLEAN NOT NULL DEFAULT false;

UPDATE "schedule_entries" se
SET "department_id" = ss."department_id"
FROM "staff_schedules" ss
WHERE se."schedule_id" = ss."id" AND se."department_id" IS NULL;

ALTER TABLE "schedule_entries" ALTER COLUMN "department_id" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'schedule_entries_department_id_fkey'
  ) THEN
    ALTER TABLE "schedule_entries"
      ADD CONSTRAINT "schedule_entries_department_id_fkey"
      FOREIGN KEY ("department_id") REFERENCES "departments"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "schedule_entries_department_id_idx" ON "schedule_entries"("department_id");

-- Data migration: GUARDIA was a status value; move it to the new on_guard
-- flag and fall the underlying day back to PRESENCIAL (the common real-world
-- case: on-call while otherwise present).
UPDATE "schedule_entries" SET "on_guard" = true, "status" = 'PRESENCIAL' WHERE "status" = 'GUARDIA';

CREATE UNIQUE INDEX IF NOT EXISTS "schedule_entries_on_guard_unique"
  ON "schedule_entries"("department_id", "date")
  WHERE "on_guard" = true;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "weekly_target_hours" DOUBLE PRECISION;
