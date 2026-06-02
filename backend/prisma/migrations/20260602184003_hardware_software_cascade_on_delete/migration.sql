-- Fix FK delete behaviour to match Prisma schema (onDelete: Cascade).
--
-- Root cause: the original init migration created hardware_cis.ci_id and
-- software_cis.ci_id with ON DELETE RESTRICT, but schema.prisma declares
-- onDelete: Cascade. Postgres has been rejecting every CI delete that
-- carried hardware or software with "violates foreign key constraint".
--
-- This migration drops and re-creates both FKs with ON DELETE CASCADE so
-- that deleting a CI removes its hardware/software child row automatically.
--
-- The ALTER TABLE briefly acquires ACCESS EXCLUSIVE on each table; both
-- tables are 1:1 with configuration_items, so the lock window is very short.

ALTER TABLE "hardware_cis" DROP CONSTRAINT "hardware_cis_ci_id_fkey";
ALTER TABLE "hardware_cis"
  ADD CONSTRAINT "hardware_cis_ci_id_fkey"
  FOREIGN KEY ("ci_id") REFERENCES "configuration_items"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "software_cis" DROP CONSTRAINT "software_cis_ci_id_fkey";
ALTER TABLE "software_cis"
  ADD CONSTRAINT "software_cis_ci_id_fkey"
  FOREIGN KEY ("ci_id") REFERENCES "configuration_items"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
