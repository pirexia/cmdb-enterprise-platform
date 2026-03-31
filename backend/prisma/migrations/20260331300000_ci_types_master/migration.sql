-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: CI Types master table
-- Replaces the hardcoded ci_type TEXT column with a proper FK to a managed
-- ci_types table, with fixed categories and referential integrity.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. Fixed categories (seed-only, never user-modified) ─────────────────────
CREATE TABLE "ci_type_categories" (
  "code"       TEXT        PRIMARY KEY,
  "name"       TEXT        NOT NULL,
  "sort_order" INTEGER     NOT NULL DEFAULT 0
);

INSERT INTO "ci_type_categories" ("code","name","sort_order") VALUES
  ('INFRASTRUCTURE', 'Infraestructura',      1),
  ('USER_DEVICE',    'Puesto de Usuario',    2),
  ('MOBILITY_IOT',   'Movilidad / IoT',      3),
  ('MEETING_ROOM',   'Sala / Reuniones',     4),
  ('CLOUD',          'Cloud',                5),
  ('SOFTWARE',       'Software / Licencias', 6);

-- ─── 2. Manageable CI types (subcategories) ───────────────────────────────────
CREATE TABLE "ci_types" (
  "id"            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  "code"          TEXT        UNIQUE NOT NULL,
  "name"          TEXT        NOT NULL,
  "category_code" TEXT        NOT NULL
                              REFERENCES "ci_type_categories"("code") ON DELETE RESTRICT,
  "sort_order"    INTEGER     NOT NULL DEFAULT 0,
  -- System types cannot be deleted (enforced at app layer)
  "is_system"     BOOLEAN     NOT NULL DEFAULT false,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── 3. Seed system CI types ──────────────────────────────────────────────────
INSERT INTO "ci_types" ("code","name","category_code","sort_order","is_system") VALUES
  -- Infraestructura
  ('PHYSICAL_SERVER', 'Servidor Físico',   'INFRASTRUCTURE', 10, true),
  ('VIRTUAL_SERVER',  'Servidor Virtual',  'INFRASTRUCTURE', 20, true),
  ('DATABASE',        'Base de Datos',     'INFRASTRUCTURE', 30, true),
  ('NETWORK',         'Red / Networking',  'INFRASTRUCTURE', 40, true),
  ('STORAGE',         'Almacenamiento',    'INFRASTRUCTURE', 50, true),
  ('BACKUP',          'Backup',            'INFRASTRUCTURE', 60, true),
  ('HARDWARE',        'Hardware General',  'INFRASTRUCTURE', 70, true),
  ('OTHER',           'Otro',              'INFRASTRUCTURE', 99, true),
  -- Puesto de usuario
  ('DESKTOP',         'Escritorio',        'USER_DEVICE',    10, true),
  ('LAPTOP',          'Portátil',          'USER_DEVICE',    20, true),
  ('PRINTER',         'Impresora',         'USER_DEVICE',    30, true),
  ('SCANNER',         'Escáner',           'USER_DEVICE',    40, true),
  ('MONITOR',         'Monitor',           'USER_DEVICE',    50, true),
  -- Movilidad / IoT
  ('SMARTPHONE',      'Smartphone',        'MOBILITY_IOT',   10, true),
  ('TABLET',          'Tablet',            'MOBILITY_IOT',   20, true),
  ('PDA',             'PDA',               'MOBILITY_IOT',   30, true),
  ('BARCODE_SCANNER', 'Lector de Código',  'MOBILITY_IOT',   40, true),
  ('IP_CAMERA',       'Cámara IP',         'MOBILITY_IOT',   50, true),
  ('UPS',             'SAI / UPS',         'MOBILITY_IOT',   60, true),
  ('WIFI_AP',         'Punto de Acceso',   'MOBILITY_IOT',   70, true),
  ('IP_PHONE',        'Teléfono IP',       'MOBILITY_IOT',   80, true),
  -- Sala / Reuniones
  ('VIDEOCONFERENCE', 'Videoconferencia',  'MEETING_ROOM',   10, true),
  ('SMART_DISPLAY',   'Pantalla Smart',    'MEETING_ROOM',   20, true),
  ('TIME_CLOCK',      'Reloj de Fichaje',  'MEETING_ROOM',   30, true),
  -- Cloud
  ('CLOUD_INSTANCE',  'Instancia Cloud',   'CLOUD',          10, true),
  ('CLOUD_STORAGE',   'Storage Cloud',     'CLOUD',          20, true),
  -- Software / Licencias
  ('SOFTWARE',        'Software',          'SOFTWARE',       10, true),
  ('BASE_SOFTWARE',   'Software Base',     'SOFTWARE',       20, true),
  ('LICENSE',         'Licencia',          'SOFTWARE',       30, true);

-- ─── 4. Add FK column to configuration_items ──────────────────────────────────
ALTER TABLE "configuration_items"
  ADD COLUMN "ci_type_id" UUID
  REFERENCES "ci_types"("id") ON DELETE RESTRICT;

-- ─── 5. Migrate existing ci_type text values → ci_type_id ────────────────────
-- Direct code match (covers all codes except legacy NETWORK_EQUIPMENT)
UPDATE "configuration_items" ci
SET "ci_type_id" = ct.id
FROM "ci_types" ct
WHERE ci."ci_type" IS NOT NULL
  AND ci."ci_type" = ct."code";

-- Legacy alias: NETWORK_EQUIPMENT → NETWORK
UPDATE "configuration_items" ci
SET "ci_type_id" = ct.id
FROM "ci_types" ct
WHERE ci."ci_type" = 'NETWORK_EQUIPMENT'
  AND ct."code"    = 'NETWORK'
  AND ci."ci_type_id" IS NULL;

-- ─── 6. Drop old untyped text column ─────────────────────────────────────────
ALTER TABLE "configuration_items" DROP COLUMN "ci_type";

-- ─── 7. Performance index on FK ───────────────────────────────────────────────
CREATE INDEX "idx_ci_ci_type_id" ON "configuration_items"("ci_type_id");
