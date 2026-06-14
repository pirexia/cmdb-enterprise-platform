-- T4: DateType master catalog (Tipos de Fechas de Ciclo de Vida)
-- Association tables (ci_dates, operating_system_dates, base_software_dates,
-- device_model_dates) are created in migration 20260614120000_date_associations (T5).

BEGIN;

-- Enum
DO $$ BEGIN
  CREATE TYPE "DateTypeCategory" AS ENUM ('HARDWARE', 'SOFTWARE', 'OS', 'GENERAL');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Table
CREATE TABLE IF NOT EXISTS "date_types" (
  "id"          UUID         NOT NULL DEFAULT gen_random_uuid(),
  "code"        VARCHAR(50)  NOT NULL,
  "name"        VARCHAR(255) NOT NULL,
  "description" TEXT,
  "category"    "DateTypeCategory" NOT NULL,
  "sort_order"  INTEGER      NOT NULL DEFAULT 0,
  "is_system"   BOOLEAN      NOT NULL DEFAULT FALSE,
  "created_at"  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  "updated_at"  TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT "date_types_pkey"     PRIMARY KEY ("id"),
  CONSTRAINT "date_types_code_key" UNIQUE ("code")
);

CREATE INDEX IF NOT EXISTS "date_types_category_idx"   ON "date_types"("category");
CREATE INDEX IF NOT EXISTS "date_types_sort_order_idx" ON "date_types"("sort_order");

-- Seed: 16 canonical lifecycle date types (idempotent)
INSERT INTO "date_types" ("id", "code", "name", "category", "sort_order", "is_system")
VALUES
  -- GENERAL — canonical EOL/EOS used as mirror sources for CI.eol_date / CI.eos_date
  (gen_random_uuid(), 'end-of-life',             'Fin de Vida Útil',                  'GENERAL',  10, TRUE),
  (gen_random_uuid(), 'end-of-support',          'Fin de Soporte',                    'GENERAL',  20, TRUE),
  (gen_random_uuid(), 'deployment-date',         'Fecha de Despliegue',               'GENERAL',  30, FALSE),
  (gen_random_uuid(), 'decommission-date',       'Fecha de Baja Programada',          'GENERAL',  40, FALSE),
  (gen_random_uuid(), 'purchase-date',           'Fecha de Compra',                   'GENERAL',  50, FALSE),
  (gen_random_uuid(), 'review-date',             'Fecha de Revisión',                 'GENERAL',  60, FALSE),

  -- HARDWARE — DeviceModel lifecycle; hw-end-of-life / hw-end-of-support mirror DeviceModel.eol_date / eos_date
  (gen_random_uuid(), 'hw-end-of-life',          'Fin de Vida (Hardware)',             'HARDWARE', 10, TRUE),
  (gen_random_uuid(), 'hw-end-of-support',       'Fin de Soporte (Hardware)',          'HARDWARE', 20, TRUE),
  (gen_random_uuid(), 'hw-end-of-manufacture',   'Fin de Fabricación',                'HARDWARE', 30, FALSE),
  (gen_random_uuid(), 'hw-end-of-warranty',      'Fin de Garantía',                   'HARDWARE', 40, FALSE),

  -- SOFTWARE — BaseSoftware lifecycle
  (gen_random_uuid(), 'sw-end-of-life',          'Fin de Vida (Software)',             'SOFTWARE', 10, TRUE),
  (gen_random_uuid(), 'sw-end-of-support',       'Fin de Soporte (Software)',          'SOFTWARE', 20, TRUE),
  (gen_random_uuid(), 'sw-end-of-extended-support','Fin de Soporte Extendido (SW)',    'SOFTWARE', 30, FALSE),

  -- OS — OperatingSystem lifecycle
  (gen_random_uuid(), 'os-end-of-life',          'Fin de Vida (SO)',                   'OS',       10, TRUE),
  (gen_random_uuid(), 'os-end-of-support',       'Fin de Soporte (SO)',                'OS',       20, TRUE),
  (gen_random_uuid(), 'os-end-of-extended-support','Fin de Soporte Extendido (SO)',    'OS',       30, FALSE)

ON CONFLICT ("code") DO NOTHING;

COMMIT;
