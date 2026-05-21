-- Migration: Formalize audit_logs.details column + composite index (RAG v2 E0b)
--
-- Context (v2.N7 / PF-7):
--   Schema drift detected by pre-flight Explore agent: production code in
--   backend/src/index.ts already INSERTs into audit_logs.details from at least
--   three sites (ASK_RAG, RAG_BACKFILL, SSO_LOGIN), but the column was not
--   declared in any prior migration nor in prisma/schema.prisma. This commit
--   reconciles the live schema before the main RAG-entities migration runs,
--   so the v2 worker (INDEX_BATCH per-batch summaries) and the new ASK_RAG_VULN
--   audit event can rely on a typed jsonb column.
--
-- Compliance:
--   ISO 27001:2022 A.8.15 (Logging) — formalises an audit field already in use.
--   GDPR Art.30 (Records of processing) — the column carries non-PII metadata
--     (query hash, counts, queue tick id); ensures DPIA documents what is stored.
--   NIS2 Art.23 (Incident notification) — composite index on (action, created_at)
--     accelerates the 24h/72h incident investigation queries.
--
-- Lock analysis:
--   - ADD COLUMN IF NOT EXISTS ... jsonb (nullable, no default): metadata-only
--     change in PostgreSQL >= 11. ACCESS EXCLUSIVE for a few ms.
--   - CREATE INDEX (not concurrently): ShareLock on the table. At current
--     scale (< 200k rows) completes in < 200ms. Wrapped with lock_timeout to
--     fail fast if a long-running transaction is holding the table.

SET lock_timeout = '3s';

-- ── 1. Add jsonb column to formalise the existing usage ─────────────────────
ALTER TABLE "audit_logs"
  ADD COLUMN IF NOT EXISTS "details" jsonb;

COMMENT ON COLUMN "audit_logs"."details" IS
  'Non-PII event metadata as JSON. Populated by ASK_RAG (queryHash, latencyMs), INDEX_BATCH (per-type counts), RAG_BACKFILL_ENTITIES (counts), SSO_LOGIN (provider). Never store raw question text or PII here — only hashes, identifiers, counters.';

-- ── 2. Composite index for incident / RAG audit queries ─────────────────────
-- Used by:
--   * NIS2 Art.23 incident search ("show all FAILED_LOGIN in the last 24h")
--   * RAG dashboards filtering by action=ASK_RAG ordered by recency
--   * Worker observability ("most recent INDEX_BATCH")
CREATE INDEX IF NOT EXISTS "idx_audit_logs_action_created_at"
  ON "audit_logs" ("action", "created_at" DESC);

RESET lock_timeout;
