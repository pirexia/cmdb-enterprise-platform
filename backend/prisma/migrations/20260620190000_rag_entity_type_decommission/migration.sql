-- Add 'decommission' to rag_entity_index entity_type check constraint
-- and 'decommission' to rag_chunks entity_type check constraint

ALTER TABLE "rag_entity_index"
  DROP CONSTRAINT IF EXISTS "rag_entity_index_entity_type_check";

ALTER TABLE "rag_entity_index"
  ADD CONSTRAINT "rag_entity_index_entity_type_check"
  CHECK (entity_type = ANY (ARRAY['ci'::text, 'contract'::text, 'license'::text, 'vulnerability'::text, 'decommission'::text]));

-- rag_chunks also has an entity_type check — extend it too
ALTER TABLE "rag_chunks"
  DROP CONSTRAINT IF EXISTS "rag_chunks_entity_type_check";

ALTER TABLE "rag_chunks"
  ADD CONSTRAINT "rag_chunks_entity_type_check"
  CHECK (entity_type = ANY (ARRAY['document'::text, 'ci'::text, 'contract'::text, 'license'::text, 'vulnerability'::text, 'decommission'::text]));
