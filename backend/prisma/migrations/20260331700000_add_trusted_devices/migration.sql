-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Add trusted_devices table and mfa_prompted_at field to users
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Add mfa_prompted_at to users (NULL = never prompted, NOT NULL = already shown the MFA suggestion)
ALTER TABLE "users" ADD COLUMN "mfa_prompted_at" TIMESTAMPTZ;

-- 2. Create trusted_devices table
CREATE TABLE "trusted_devices" (
  "id"           UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "user_id"      UUID        NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token"        TEXT        NOT NULL,
  "user_agent"   TEXT,
  "ip_address"   TEXT,
  "expires_at"   TIMESTAMPTZ NOT NULL,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "last_seen_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "trusted_devices_token_key" UNIQUE ("token")
);

CREATE INDEX "trusted_devices_user_id_idx" ON "trusted_devices"("user_id");
