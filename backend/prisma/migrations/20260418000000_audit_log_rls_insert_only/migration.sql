-- Migration: audit_log_rls_insert_only
-- Goal: Prevent accidental or malicious deletion of audit trail rows while
-- still allowing UPDATE (required for GDPR Art.17 pseudonymisation).
--
-- Note: REVOKE DELETE FROM <owner> has no effect in PostgreSQL when the
-- revoking role is the owner — hence Row-Level Security with FORCE.
-- The absence of a DELETE policy means no role (including the table owner)
-- can delete rows when FORCE ROW LEVEL SECURITY is active.
--
-- UPDATE is preserved via an explicit policy because GDPR Art.17 requires
-- pseudonymisation (replacing user_email with a hash) on erasure requests.

ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;

-- Allow SELECT for all (audit viewers need read access)
CREATE POLICY audit_select ON "audit_logs"
  FOR SELECT USING (true);

-- Allow INSERT for all (app creates log entries on every write operation)
CREATE POLICY audit_insert ON "audit_logs"
  FOR INSERT WITH CHECK (true);

-- Allow UPDATE for all (required for pseudonymisation on user erasure)
CREATE POLICY audit_update ON "audit_logs"
  FOR UPDATE USING (true) WITH CHECK (true);

-- No DELETE policy → DELETE blocked for all roles including owner
