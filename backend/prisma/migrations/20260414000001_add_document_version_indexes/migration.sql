-- Migration: add_document_version_indexes
-- Adds compound indexes to the documents table to speed up the two most
-- common versioning queries without full table scans as the document
-- repository grows.

-- Query: SELECT * FROM documents WHERE root_id = ? AND is_latest = true
CREATE INDEX IF NOT EXISTS "documents_root_id_is_latest_idx"
  ON "documents" ("root_id", "is_latest");

-- Query: SELECT * FROM documents WHERE root_id = ? ORDER BY version_number DESC
CREATE INDEX IF NOT EXISTS "documents_root_id_version_number_idx"
  ON "documents" ("root_id", "version_number" DESC);
