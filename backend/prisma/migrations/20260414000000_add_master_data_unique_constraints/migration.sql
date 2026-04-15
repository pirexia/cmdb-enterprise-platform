-- Migration: add_master_data_unique_constraints
-- Adds UNIQUE constraints on the name column of master data tables that were
-- missing them, preventing duplicate entries at the database level.
--
-- Before applying to production verify no existing duplicates:
--   SELECT name, COUNT(*) FROM vendors       GROUP BY name HAVING COUNT(*) > 1;
--   SELECT name, COUNT(*) FROM cost_centers  GROUP BY name HAVING COUNT(*) > 1;
--   SELECT name, COUNT(*) FROM branches      GROUP BY name HAVING COUNT(*) > 1;

ALTER TABLE "vendors"
  ADD CONSTRAINT "vendors_name_key" UNIQUE ("name");

ALTER TABLE "cost_centers"
  ADD CONSTRAINT "cost_centers_name_key" UNIQUE ("name");

ALTER TABLE "branches"
  ADD CONSTRAINT "branches_name_key" UNIQUE ("name");
