-- AlterTable — add vcenter_sync column for vCenter integration metadata
ALTER TABLE "configuration_items" ADD COLUMN IF NOT EXISTS "vcenter_sync" jsonb;
