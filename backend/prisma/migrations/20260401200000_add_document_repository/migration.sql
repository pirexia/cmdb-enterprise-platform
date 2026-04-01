-- Document Types master table
CREATE TABLE "document_types" (
  "id"         UUID        NOT NULL DEFAULT gen_random_uuid(),
  "code"       TEXT        NOT NULL,
  "name"       TEXT        NOT NULL,
  "is_system"  BOOLEAN     NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "document_types_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "document_types_code_key" ON "document_types"("code");

-- Documents table
CREATE TABLE "documents" (
  "id"               UUID        NOT NULL DEFAULT gen_random_uuid(),
  "title"            TEXT        NOT NULL,
  "description"      TEXT,
  "document_type_id" UUID        NOT NULL,
  "root_id"          UUID,
  "version_number"   INTEGER     NOT NULL DEFAULT 1,
  "is_latest"        BOOLEAN     NOT NULL DEFAULT true,
  "file_name"        TEXT        NOT NULL,
  "original_name"    TEXT        NOT NULL,
  "mime_type"        TEXT        NOT NULL,
  "file_size"        INTEGER     NOT NULL,
  "uploaded_by"      TEXT        NOT NULL,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "documents" ADD CONSTRAINT "documents_document_type_id_fkey" FOREIGN KEY ("document_type_id") REFERENCES "document_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "documents" ADD CONSTRAINT "documents_root_id_fkey" FOREIGN KEY ("root_id") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Document Relations
CREATE TABLE "document_relations" (
  "id"            UUID        NOT NULL DEFAULT gen_random_uuid(),
  "source_doc_id" UUID        NOT NULL,
  "target_doc_id" UUID        NOT NULL,
  "relation_type" TEXT        NOT NULL,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "document_relations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "document_relations_source_doc_id_target_doc_id_key" ON "document_relations"("source_doc_id","target_doc_id");
ALTER TABLE "document_relations" ADD CONSTRAINT "document_relations_source_doc_id_fkey" FOREIGN KEY ("source_doc_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_relations" ADD CONSTRAINT "document_relations_target_doc_id_fkey" FOREIGN KEY ("target_doc_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Document ↔ CI association
CREATE TABLE "document_cis" (
  "id"          UUID        NOT NULL DEFAULT gen_random_uuid(),
  "document_id" UUID        NOT NULL,
  "ci_id"       UUID        NOT NULL,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "document_cis_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "document_cis_document_id_ci_id_key" ON "document_cis"("document_id","ci_id");
ALTER TABLE "document_cis" ADD CONSTRAINT "document_cis_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_cis" ADD CONSTRAINT "document_cis_ci_id_fkey" FOREIGN KEY ("ci_id") REFERENCES "configuration_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Document ↔ Contract association
CREATE TABLE "document_contracts" (
  "id"          UUID        NOT NULL DEFAULT gen_random_uuid(),
  "document_id" UUID        NOT NULL,
  "contract_id" UUID        NOT NULL,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "document_contracts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "document_contracts_document_id_contract_id_key" ON "document_contracts"("document_id","contract_id");
ALTER TABLE "document_contracts" ADD CONSTRAINT "document_contracts_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_contracts" ADD CONSTRAINT "document_contracts_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed default document types
INSERT INTO "document_types" ("id","code","name","is_system","created_at","updated_at") VALUES
  (gen_random_uuid(),'CONTRATO','Contrato',true,now(),now()),
  (gen_random_uuid(),'ADENDA','Adenda',true,now(),now()),
  (gen_random_uuid(),'DOC_TECNICO','Doc. Técnico',true,now(),now()),
  (gen_random_uuid(),'OFERTA','Oferta',true,now(),now()),
  (gen_random_uuid(),'LICENCIA','Licencia',true,now(),now());
