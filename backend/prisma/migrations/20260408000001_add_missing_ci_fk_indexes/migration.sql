-- AddIndex: missing FK indexes for configuration_items.location_id and cost_center_id
-- These were omitted from migration 20260407100000_add_fk_indexes

CREATE INDEX IF NOT EXISTS "configuration_items_location_id_idx"
  ON "configuration_items"("location_id");

CREATE INDEX IF NOT EXISTS "configuration_items_cost_center_id_idx"
  ON "configuration_items"("cost_center_id");
