-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Add CITypeCategory LOGICAL + CIType SISTEMA
-- Used by the Decommission Plan module to identify logical system containers.
-- Both inserts are idempotent (ON CONFLICT DO NOTHING).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. New category: Logical / Aplicación
INSERT INTO "ci_type_categories" ("code", "name", "sort_order")
VALUES ('LOGICAL', 'Lógico / Aplicación', 7)
ON CONFLICT ("code") DO NOTHING;

-- 2. New CI type: Sistema
INSERT INTO "ci_types" ("code", "name", "category_code", "sort_order", "is_system")
VALUES ('SISTEMA', 'Sistema', 'LOGICAL', 10, true)
ON CONFLICT ("code") DO NOTHING;
