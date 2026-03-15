-- AlterTable: add lastCheckDate and verificationSource to configuration_items
ALTER TABLE "configuration_items"
  ADD COLUMN IF NOT EXISTS "last_check_date"      TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "verification_source"  TEXT;
