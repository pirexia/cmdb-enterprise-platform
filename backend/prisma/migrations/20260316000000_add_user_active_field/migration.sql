-- AlterTable: add active field to users
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "active" BOOLEAN NOT NULL DEFAULT true;
