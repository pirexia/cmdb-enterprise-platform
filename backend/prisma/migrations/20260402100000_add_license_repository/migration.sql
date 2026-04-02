-- ── License Metric Categories ────────────────────────────────────────────────
CREATE TABLE "license_metric_categories" (
  "code"       TEXT NOT NULL,
  "name"       TEXT NOT NULL,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "license_metric_categories_pkey" PRIMARY KEY ("code")
);

-- ── License Metrics ───────────────────────────────────────────────────────────
CREATE TABLE "license_metrics" (
  "id"            UUID        NOT NULL DEFAULT gen_random_uuid(),
  "code"          TEXT        NOT NULL,
  "name"          TEXT        NOT NULL,
  "category_code" TEXT        NOT NULL,
  "description"   TEXT,
  "is_system"     BOOLEAN     NOT NULL DEFAULT true,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "license_metrics_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "license_metrics_code_key" ON "license_metrics"("code");
ALTER TABLE "license_metrics"
  ADD CONSTRAINT "license_metrics_category_code_fkey"
  FOREIGN KEY ("category_code") REFERENCES "license_metric_categories"("code")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── License Type Categories ───────────────────────────────────────────────────
CREATE TABLE "license_type_categories" (
  "code"       TEXT NOT NULL,
  "name"       TEXT NOT NULL,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "license_type_categories_pkey" PRIMARY KEY ("code")
);

-- ── License Types ─────────────────────────────────────────────────────────────
CREATE TABLE "license_types" (
  "id"            UUID        NOT NULL DEFAULT gen_random_uuid(),
  "code"          TEXT        NOT NULL,
  "name"          TEXT        NOT NULL,
  "category_code" TEXT        NOT NULL,
  "description"   TEXT,
  "is_system"     BOOLEAN     NOT NULL DEFAULT true,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "license_types_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "license_types_code_key" ON "license_types"("code");
ALTER TABLE "license_types"
  ADD CONSTRAINT "license_types_category_code_fkey"
  FOREIGN KEY ("category_code") REFERENCES "license_type_categories"("code")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Licenses ──────────────────────────────────────────────────────────────────
CREATE TABLE "licenses" (
  "id"                UUID           NOT NULL DEFAULT gen_random_uuid(),
  "name"              TEXT           NOT NULL,
  "license_number"    TEXT           NOT NULL,
  "vendor_id"         UUID,
  "start_date"        TIMESTAMPTZ    NOT NULL,
  "end_date"          TIMESTAMPTZ,
  "license_type_id"   UUID,
  "license_metric_id" UUID,
  "metric_value"      INTEGER,
  "metric_unit"       TEXT,
  "cost"              DECIMAL(12,2),
  "currency"          TEXT           DEFAULT 'EUR',
  "status"            TEXT           DEFAULT 'ACTIVO',
  "notes"             TEXT,
  "parent_license_id" UUID,
  "created_at"        TIMESTAMPTZ    NOT NULL DEFAULT now(),
  "updated_at"        TIMESTAMPTZ    NOT NULL DEFAULT now(),
  CONSTRAINT "licenses_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "licenses_license_number_key" ON "licenses"("license_number");
ALTER TABLE "licenses"
  ADD CONSTRAINT "licenses_vendor_id_fkey"
    FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "licenses_license_type_id_fkey"
    FOREIGN KEY ("license_type_id") REFERENCES "license_types"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "licenses_license_metric_id_fkey"
    FOREIGN KEY ("license_metric_id") REFERENCES "license_metrics"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "licenses_parent_license_id_fkey"
    FOREIGN KEY ("parent_license_id") REFERENCES "licenses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── License ↔ CI (implicit M2M, Prisma naming convention) ────────────────────
CREATE TABLE "_LicenseToCI" (
  "A" UUID NOT NULL,
  "B" UUID NOT NULL
);
CREATE UNIQUE INDEX "_LicenseToCI_AB_unique" ON "_LicenseToCI"("A", "B");
CREATE INDEX "_LicenseToCI_B_index" ON "_LicenseToCI"("B");
ALTER TABLE "_LicenseToCI"
  ADD CONSTRAINT "_LicenseToCI_A_fkey"
    FOREIGN KEY ("A") REFERENCES "licenses"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "_LicenseToCI_B_fkey"
    FOREIGN KEY ("B") REFERENCES "configuration_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── License Users ─────────────────────────────────────────────────────────────
CREATE TABLE "license_users" (
  "id"         UUID        NOT NULL DEFAULT gen_random_uuid(),
  "license_id" UUID        NOT NULL,
  "name"       TEXT        NOT NULL,
  "dni"        TEXT,
  "email"      TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "license_users_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "license_users_license_id_idx" ON "license_users"("license_id");
ALTER TABLE "license_users"
  ADD CONSTRAINT "license_users_license_id_fkey"
    FOREIGN KEY ("license_id") REFERENCES "licenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Document ↔ License ────────────────────────────────────────────────────────
CREATE TABLE "document_licenses" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "document_id" UUID NOT NULL,
  "license_id"  UUID NOT NULL,
  CONSTRAINT "document_licenses_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "document_licenses_document_id_license_id_key"
  ON "document_licenses"("document_id", "license_id");
ALTER TABLE "document_licenses"
  ADD CONSTRAINT "document_licenses_document_id_fkey"
    FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "document_licenses_license_id_fkey"
    FOREIGN KEY ("license_id") REFERENCES "licenses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Seed: License Metric Categories ──────────────────────────────────────────
INSERT INTO "license_metric_categories" ("code","name","sort_order") VALUES
  ('USER_BASED',      'Basada en Usuario',                1),
  ('INFRASTRUCTURE',  'Infraestructura y Hardware',       2),
  ('CAPACITY',        'Capacidad y Consumo',              3),
  ('TRANSACTION',     'Transacciones y Negocio',          4),
  ('NETWORK',         'Nodos y Red (Ciberseguridad)',      5),
  ('GLOBAL',          'Modelos Globales',                 6);

-- ── Seed: License Metrics ─────────────────────────────────────────────────────
INSERT INTO "license_metrics" ("id","code","name","category_code","description","is_system") VALUES
  (gen_random_uuid(),'NAMED_USER',          'Usuario Nominal (Named User)',              'USER_BASED',     'Licencia atada a una persona concreta. No se puede compartir.',                         true),
  (gen_random_uuid(),'CONCURRENT_USER',     'Usuario Concurrente/Flotante',             'USER_BASED',     'Limita cuántos usuarios pueden estar conectados simultáneamente.',                     true),
  (gen_random_uuid(),'NODE_LOCKED',         'Puesto de Dispositivo (Node-locked/Seat)', 'USER_BASED',     'Licencia anclada a una máquina física (MAC o disco duro).',                           true),
  (gen_random_uuid(),'MAU_DAU',             'MAU / DAU (Usuarios Activos)',             'USER_BASED',     'Se cobra por usuarios únicos que interactúan en un mes/día.',                         true),
  (gen_random_uuid(),'TIERED_ROLES',        'Basado en Roles (Tiered Users)',           'USER_BASED',     'Precio diferente según nivel de privilegios (Admin, Solo lectura, etc.).',             true),
  (gen_random_uuid(),'CPU_SOCKET',          'Procesador / Socket físico',               'INFRASTRUCTURE', 'Se cobra por ranura de procesador físico en la placa base.',                          true),
  (gen_random_uuid(),'PHYSICAL_CORE',       'Núcleo físico (pCore)',                    'INFRASTRUCTURE', 'Se cobra por núcleo físico real del servidor.',                                       true),
  (gen_random_uuid(),'VIRTUAL_CORE',        'Núcleo virtual (vCore / vCPU)',            'INFRASTRUCTURE', 'Se cobra por núcleos virtuales asignados a una VM o contenedor.',                    true),
  (gen_random_uuid(),'RAM_GB',              'Memoria RAM (GB / TB)',                    'INFRASTRUCTURE', 'El coste escala con los GB/TB de memoria instalada o asignada.',                     true),
  (gen_random_uuid(),'HOST_SERVER',         'Host / Servidor físico',                  'INFRASTRUCTURE', 'Precio fijo por cada servidor completo que ejecute el software.',                    true),
  (gen_random_uuid(),'CLUSTER',             'Clúster',                                 'INFRASTRUCTURE', 'Licenciamiento agrupado para un conjunto de servidores de alta disponibilidad.',     true),
  (gen_random_uuid(),'STORAGE_GB',          'Volumen de Almacenamiento (GB/TB/PB)',     'CAPACITY',       'Se cobra por la cantidad de datos guardados.',                                       true),
  (gen_random_uuid(),'DATA_INGESTION',      'Volumen Ingerido / Procesado',             'CAPACITY',       'Se cobra por la cantidad de datos que entran al sistema por día (SIEM, logs).',     true),
  (gen_random_uuid(),'BANDWIDTH',           'Ancho de Banda / Transferencia',          'CAPACITY',       'Cobro por TB de datos transferidos (CDN, firewalls, nubes).',                        true),
  (gen_random_uuid(),'COMPUTE_HOURS',       'Horas de Computación',                    'CAPACITY',       'Se cobra por minuto u hora que un recurso está activo.',                             true),
  (gen_random_uuid(),'TOKENS',              'Tokens (IA / LLM)',                       'CAPACITY',       'Fragmentos de palabras leídas (input) o generadas (output) por un LLM.',            true),
  (gen_random_uuid(),'API_CALLS',           'Llamadas a la API',                       'TRANSACTION',    'Se cobra por lotes de peticiones (ej. 10€/100.000 requests).',                      true),
  (gen_random_uuid(),'DOCS_PROCESSED',      'Documentos / Entidades procesadas',       'TRANSACTION',    'Nóminas generadas, facturas emitidas, registros procesados, etc.',                  true),
  (gen_random_uuid(),'REVENUE_BASED',       'Basado en Ingresos (Revenue-based)',      'TRANSACTION',    'Gratuito hasta umbral de ingresos; luego se aplica porcentaje (Unreal Engine, etc.).', true),
  (gen_random_uuid(),'TOTAL_HEADCOUNT',     'Total de Empleados (Headcount)',          'TRANSACTION',    'Se cobra por el número total de trabajadores en nómina.',                            true),
  (gen_random_uuid(),'ENDPOINTS',           'Endpoints / Agentes',                     'NETWORK',        'Métrica de EDR/XDR: un agente por portátil, servidor o dispositivo móvil.',        true),
  (gen_random_uuid(),'IP_ADDRESSES',        'Direcciones IP monitorizadas',            'NETWORK',        'Escaneo de vulnerabilidades o gestión de red por rango de IP.',                    true),
  (gen_random_uuid(),'ENTERPRISE_FLAT',     'Tarifa Plana Corporativa (EA/Site)',      'GLOBAL',         'Precio fijo para uso ilimitado en toda la corporación o sede.',                     true),
  (gen_random_uuid(),'FEATURE_ADDON',       'Módulos / Funcionalidades (Add-ons)',     'GLOBAL',         'Software base + licencias adicionales por módulo o funcionalidad.',                  true),
  (gen_random_uuid(),'HARDWARE_DONGLE',     'Hardware Key (Dongle)',                   'GLOBAL',         'Software que requiere un dispositivo USB físico para funcionar.',                    true);

-- ── Seed: License Type Categories ────────────────────────────────────────────
INSERT INTO "license_type_categories" ("code","name","sort_order") VALUES
  ('DURATION',    'Duración y Modelo Financiero',        1),
  ('SOURCE',      'Acceso al Código y Derechos',         2),
  ('ACQUISITION', 'Modelo de Adquisición y Alcance',     3);

-- ── Seed: License Types ───────────────────────────────────────────────────────
INSERT INTO "license_types" ("id","code","name","category_code","description","is_system") VALUES
  (gen_random_uuid(),'PERPETUAL',            'Licencia Perpetua',                       'DURATION',    'Pago único; derecho de uso indefinido de la versión adquirida. Mantenimiento anual opcional (15-25%).', true),
  (gen_random_uuid(),'SUBSCRIPTION',         'Suscripción (Term License)',              'DURATION',    'Alquiler por período (mensual/anual). Incluye soporte y actualizaciones. Cesa si no se renueva.',       true),
  (gen_random_uuid(),'PROPRIETARY',          'Propietaria / Comercial (Closed Source)', 'SOURCE',     'Código oculto. Prohibida la ingeniería inversa, modificación y redistribución.',                       true),
  (gen_random_uuid(),'OPEN_PERMISSIVE',      'Open Source Permisiva (MIT/Apache/BSD)',  'SOURCE',     'Código público. Uso, modificación e integración en productos comerciales permitidos.',                  true),
  (gen_random_uuid(),'OPEN_COPYLEFT',        'Open Source Copyleft (GNU GPL)',          'SOURCE',     'Código público con efecto vírico: las modificaciones distribuidas deben publicarse bajo la misma licencia.', true),
  (gen_random_uuid(),'FREEWARE',             'Freeware',                                'SOURCE',     'Gratuito indefinidamente pero propietario. A menudo solo para uso personal/no comercial.',             true),
  (gen_random_uuid(),'FREEMIUM',             'Freemium',                                'SOURCE',     'Base gratuita; funcionalidades avanzadas o soporte enterprise requieren licencia de pago.',            true),
  (gen_random_uuid(),'OEM',                  'OEM (Original Equipment Manufacturer)',   'ACQUISITION', 'Atada al hardware en que viene instalada. No transferible a otro equipo.',                           true),
  (gen_random_uuid(),'FPP_RETAIL',           'FPP / Retail',                            'ACQUISITION', 'Licencia comercial estándar transferible entre equipos al retirar el software del original.',         true),
  (gen_random_uuid(),'VOLUME',               'Licencia por Volumen (Volume Licensing)', 'ACQUISITION', 'Clave maestra o KMS para activar cientos de equipos desde un único contrato.',                       true),
  (gen_random_uuid(),'ENTERPRISE_AGREEMENT', 'Acuerdo Corporativo (Enterprise Agreement)', 'ACQUISITION', 'Contrato marco masivo: cuota fija y uso ilimitado en toda la infraestructura global.',          true),
  (gen_random_uuid(),'NFR',                  'NFR (Not For Resale)',                    'ACQUISITION', 'Licencias gratuitas funcionales para partners/integradores. Solo para demo/formación, nunca producción.', true),
  (gen_random_uuid(),'ACADEMIC_GOV',         'Académica / Gubernamental',               'ACQUISITION', 'Mismo producto comercial con descuento drástico. Solo válida mientras se mantenga el estatus.', true),
  (gen_random_uuid(),'EVALUATION',           'Evaluación / Trialware',                  'ACQUISITION', 'Licencia gratuita limitada por tiempo (30-90 días) o funcionalidad. Requiere clave comercial al vencer.', true);
