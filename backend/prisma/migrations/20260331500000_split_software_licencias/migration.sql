-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Split "Software / Licencias" category into two separate categories
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Rename the existing SOFTWARE category to just "Software"
UPDATE "ci_type_categories" SET "name" = 'Software' WHERE "code" = 'SOFTWARE';

-- 2. Create the new LICENCIAS category
INSERT INTO "ci_type_categories" ("code", "name", "sort_order")
VALUES ('LICENCIAS', 'Licencias', 7);

-- 3. Move the LICENSE type to the new LICENCIAS category
UPDATE "ci_types" SET "category_code" = 'LICENCIAS' WHERE "code" = 'LICENSE';
