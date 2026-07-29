-- v3.5.13 — Horario de verano configurable por departamento.
--
-- Hasta ahora el periodo de verano era global (summer_schedules, unico por
-- año) y se aplicaba a todos los departamentos por igual. Hay departamentos
-- que no disfrutan de horario de verano, asi que la activacion pasa a ser una
-- decision por departamento, con periodo propio opcional.
--
--   summer_enabled = false          => ese departamento no tiene verano nunca
--   summer_enabled = true  + fechas => usa SU periodo
--   summer_enabled = true  sin fechas => usa el periodo global del año
--
-- El valor por defecto true + fechas nulas reproduce exactamente el
-- comportamiento anterior para todos los departamentos existentes.

ALTER TABLE "department_schedule_configs"
  ADD COLUMN IF NOT EXISTS "summer_enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "department_schedule_configs"
  ADD COLUMN IF NOT EXISTS "summer_start_date" DATE;
ALTER TABLE "department_schedule_configs"
  ADD COLUMN IF NOT EXISTS "summer_end_date" DATE;

DO $$
BEGIN
  -- O ambas fechas o ninguna: media configuracion no es interpretable.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dept_summer_dates_both_or_neither') THEN
    ALTER TABLE "department_schedule_configs" ADD CONSTRAINT "dept_summer_dates_both_or_neither"
      CHECK (("summer_start_date" IS NULL) = ("summer_end_date" IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dept_summer_dates_ordered') THEN
    ALTER TABLE "department_schedule_configs" ADD CONSTRAINT "dept_summer_dates_ordered"
      CHECK ("summer_start_date" IS NULL OR "summer_end_date" >= "summer_start_date");
  END IF;
END $$;
