-- Migration: Add per-role read ACL flags to documents
--
-- Compliance:
--   ISO 27001:2022 A.5.15 (Access control) — enforces role-based read access
--     at the document level, allowing fine-grained restriction of who can
--     view each document beyond the existing RBAC role gating.
--   ISO 27001:2022 A.5.18 (Access rights) — supports management (granting,
--     reviewing, revoking) of access rights to information resources by
--     making per-document, per-role visibility explicit and auditable.
--
-- Behaviour:
--   Three boolean flags (one per role: ADMIN, AUDITOR, VIEWER) gate read
--   access. Default is TRUE for all three to preserve the pre-existing
--   behaviour (any authenticated user could read any document). New
--   documents inherit the permissive default; tightening is opt-in.
--
-- Index:
--   A composite index on the three flags supports filtered list queries
--   such as "documents readable by AUDITOR" (read_auditor = true).

ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "read_admin" boolean NOT NULL DEFAULT true;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "read_auditor" boolean NOT NULL DEFAULT true;
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "read_viewer" boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS "idx_documents_read_acl" ON "documents"("read_admin","read_auditor","read_viewer");
