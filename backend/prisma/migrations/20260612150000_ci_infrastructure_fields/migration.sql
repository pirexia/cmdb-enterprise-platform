-- T6: CI infrastructure fields
-- New columns on configuration_items + FK to operating_systems

ALTER TABLE "configuration_items" ADD COLUMN IF NOT EXISTS "cpu_model"           VARCHAR(255);
ALTER TABLE "configuration_items" ADD COLUMN IF NOT EXISTS "v_cpus"              INTEGER;
ALTER TABLE "configuration_items" ADD COLUMN IF NOT EXISTS "ram"                 VARCHAR(100);
ALTER TABLE "configuration_items" ADD COLUMN IF NOT EXISTS "disk"                VARCHAR(100);
ALTER TABLE "configuration_items" ADD COLUMN IF NOT EXISTS "admin_ip"            VARCHAR(45);
ALTER TABLE "configuration_items" ADD COLUMN IF NOT EXISTS "mgmt_ip"             VARCHAR(45);
ALTER TABLE "configuration_items" ADD COLUMN IF NOT EXISTS "host_name"           VARCHAR(255);
ALTER TABLE "configuration_items" ADD COLUMN IF NOT EXISTS "cluster_name"        VARCHAR(255);
ALTER TABLE "configuration_items" ADD COLUMN IF NOT EXISTS "operating_system_id" UUID;
ALTER TABLE "configuration_items" ADD COLUMN IF NOT EXISTS "firmware_version"    VARCHAR(100);
ALTER TABLE "configuration_items" ADD COLUMN IF NOT EXISTS "dns"                 VARCHAR(255);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'configuration_items_os_fkey'
  ) THEN
    ALTER TABLE "configuration_items"
      ADD CONSTRAINT "configuration_items_os_fkey"
      FOREIGN KEY ("operating_system_id") REFERENCES "operating_systems"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "configuration_items_operating_system_id_idx"
  ON "configuration_items"("operating_system_id");
