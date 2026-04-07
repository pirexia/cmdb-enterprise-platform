-- Migration: add mfa_pending_secret column to users table
-- Stores the server-generated TOTP secret temporarily during MFA setup.
-- The secret is written by /api/auth/mfa/setup and consumed (then cleared)
-- by /api/auth/mfa/enable, ensuring the client cannot supply its own secret.

ALTER TABLE "users" ADD COLUMN "mfa_pending_secret" TEXT;
