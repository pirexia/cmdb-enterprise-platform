-- T5: BaseSoftware catalog master data
-- Tables: base_software, ci_base_software, document_base_software, license_base_software

CREATE TABLE IF NOT EXISTS "base_software" (
  "id"              UUID         NOT NULL DEFAULT gen_random_uuid(),
  "code"            VARCHAR(50)  NOT NULL,
  "name"            VARCHAR(255) NOT NULL,
  "version"         VARCHAR(100),
  "manufacturer_id" UUID,
  "is_system"       BOOLEAN      NOT NULL DEFAULT false,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "base_software_pkey"     PRIMARY KEY ("id"),
  CONSTRAINT "base_software_code_key" UNIQUE ("code"),
  CONSTRAINT "base_software_mfr_fkey" FOREIGN KEY ("manufacturer_id")
    REFERENCES "manufacturers"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "base_software_manufacturer_id_idx"
  ON "base_software"("manufacturer_id");

CREATE TABLE IF NOT EXISTS "ci_base_software" (
  "ci_id"            UUID NOT NULL,
  "base_software_id" UUID NOT NULL,
  CONSTRAINT "ci_base_software_pkey" PRIMARY KEY ("ci_id", "base_software_id"),
  CONSTRAINT "ci_base_software_ci_fkey" FOREIGN KEY ("ci_id")
    REFERENCES "configuration_items"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ci_base_software_bsw_fkey" FOREIGN KEY ("base_software_id")
    REFERENCES "base_software"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "ci_base_software_ci_idx"
  ON "ci_base_software"("ci_id");
CREATE INDEX IF NOT EXISTS "ci_base_software_bsw_idx"
  ON "ci_base_software"("base_software_id");

CREATE TABLE IF NOT EXISTS "document_base_software" (
  "document_id"      UUID NOT NULL,
  "base_software_id" UUID NOT NULL,
  CONSTRAINT "document_base_software_pkey" PRIMARY KEY ("document_id", "base_software_id"),
  CONSTRAINT "document_bsw_doc_fkey" FOREIGN KEY ("document_id")
    REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "document_bsw_bsw_fkey" FOREIGN KEY ("base_software_id")
    REFERENCES "base_software"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "document_base_software_doc_idx"
  ON "document_base_software"("document_id");
CREATE INDEX IF NOT EXISTS "document_base_software_bsw_idx"
  ON "document_base_software"("base_software_id");

CREATE TABLE IF NOT EXISTS "license_base_software" (
  "license_id"       UUID NOT NULL,
  "base_software_id" UUID NOT NULL,
  CONSTRAINT "license_base_software_pkey" PRIMARY KEY ("license_id", "base_software_id"),
  CONSTRAINT "license_bsw_lic_fkey" FOREIGN KEY ("license_id")
    REFERENCES "licenses"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "license_bsw_bsw_fkey" FOREIGN KEY ("base_software_id")
    REFERENCES "base_software"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "license_base_software_lic_idx"
  ON "license_base_software"("license_id");
CREATE INDEX IF NOT EXISTS "license_base_software_bsw_idx"
  ON "license_base_software"("base_software_id");
