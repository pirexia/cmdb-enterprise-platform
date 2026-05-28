-- Migration: merge providers → vendors, then drop providers table
-- Any provider name not already in vendors is inserted.
-- The providers table is then dropped (no FK relations existed).

INSERT INTO "vendors" (id, name, created_at, updated_at)
SELECT id, name, created_at, updated_at
FROM   "providers"
WHERE  name NOT IN (SELECT name FROM "vendors");

DROP TABLE "providers";
