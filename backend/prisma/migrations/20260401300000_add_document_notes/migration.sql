CREATE TABLE "document_notes" (
  "id"          UUID        NOT NULL DEFAULT gen_random_uuid(),
  "document_id" UUID        NOT NULL,
  "content"     TEXT        NOT NULL,
  "created_by"  TEXT        NOT NULL,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "document_notes_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "document_notes" ADD CONSTRAINT "document_notes_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "document_notes_document_id_idx" ON "document_notes"("document_id");
