-- v2.8.3+ : Warranty & maintenance are CI-instance-level dates.
--
-- Per the asset lifecycle model, end-of-life belongs to the model, end-of-support
-- to the OS/software, but warranty and maintenance are per-unit and belong to the
-- CI itself. The GENERAL category is the bucket used by the CI lifecycle-date editor
-- (LifecycleDatesEditor entityType="cis" categoryFilter="GENERAL").

-- 1) Add the two CI-assignable date types (idempotent).
INSERT INTO "date_types" ("id", "code", "name", "description", "category", "sort_order", "is_system")
VALUES
  (gen_random_uuid(), 'warranty-end',    'Fin de Garantía',      'Fin de la garantía del equipo (específico de cada CI)',               'GENERAL', 70, FALSE),
  (gen_random_uuid(), 'maintenance-end', 'Fin de Mantenimiento', 'Fin del contrato o periodo de mantenimiento (específico de cada CI)', 'GENERAL', 80, FALSE)
ON CONFLICT ("code") DO NOTHING;

-- 2) Retire the model-level warranty type (warranty is per unit, not per model).
--    Only delete it when no DeviceModel currently references it, to stay non-destructive.
DELETE FROM "date_types"
WHERE "code" = 'hw-end-of-warranty'
  AND NOT EXISTS (
    SELECT 1 FROM "device_model_dates" d WHERE d."date_type_id" = "date_types"."id"
  );
