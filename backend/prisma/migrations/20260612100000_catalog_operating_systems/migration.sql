-- T4: OperatingSystem catalog master data
-- Tables: operating_systems, document_operating_systems, license_operating_systems

CREATE TABLE IF NOT EXISTS "operating_systems" (
  "id"              UUID         NOT NULL DEFAULT gen_random_uuid(),
  "code"            VARCHAR(50)  NOT NULL,
  "name"            VARCHAR(255) NOT NULL,
  "version"         VARCHAR(100),
  "manufacturer_id" UUID,
  "is_system"       BOOLEAN      NOT NULL DEFAULT false,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "operating_systems_pkey"        PRIMARY KEY ("id"),
  CONSTRAINT "operating_systems_code_key"    UNIQUE ("code"),
  CONSTRAINT "operating_systems_mfr_fkey"    FOREIGN KEY ("manufacturer_id")
    REFERENCES "manufacturers"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "operating_systems_manufacturer_id_idx"
  ON "operating_systems"("manufacturer_id");

CREATE TABLE IF NOT EXISTS "document_operating_systems" (
  "document_id"         UUID NOT NULL,
  "operating_system_id" UUID NOT NULL,
  CONSTRAINT "document_operating_systems_pkey" PRIMARY KEY ("document_id", "operating_system_id"),
  CONSTRAINT "document_os_doc_fkey" FOREIGN KEY ("document_id")
    REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "document_os_os_fkey"  FOREIGN KEY ("operating_system_id")
    REFERENCES "operating_systems"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "document_operating_systems_doc_idx"
  ON "document_operating_systems"("document_id");
CREATE INDEX IF NOT EXISTS "document_operating_systems_os_idx"
  ON "document_operating_systems"("operating_system_id");

CREATE TABLE IF NOT EXISTS "license_operating_systems" (
  "license_id"          UUID NOT NULL,
  "operating_system_id" UUID NOT NULL,
  CONSTRAINT "license_operating_systems_pkey" PRIMARY KEY ("license_id", "operating_system_id"),
  CONSTRAINT "license_os_lic_fkey" FOREIGN KEY ("license_id")
    REFERENCES "licenses"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "license_os_os_fkey"  FOREIGN KEY ("operating_system_id")
    REFERENCES "operating_systems"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "license_operating_systems_lic_idx"
  ON "license_operating_systems"("license_id");
CREATE INDEX IF NOT EXISTS "license_operating_systems_os_idx"
  ON "license_operating_systems"("operating_system_id");
