-- v3.5.10 — Renombra el rol WORKER a MANAGER y añade users.display_name.
--
-- ALTER TYPE ... RENAME VALUE sí puede ejecutarse dentro de una transacción
-- (a diferencia de ADD VALUE en PG < 12), por lo que es seguro bajo
-- `prisma migrate deploy`. Al ser un renombrado, las filas existentes conservan
-- su valor automáticamente: ningún usuario pierde su rol.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'UserRole' AND e.enumlabel = 'WORKER'
  ) THEN
    ALTER TYPE "UserRole" RENAME VALUE 'WORKER' TO 'MANAGER';
  END IF;
END $$;

-- displayName de AD (p.ej. "Andrés Matías López"). PII: incluida en la
-- anonimización de DELETE /api/users/:id/erase (GDPR Art.17).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "display_name" VARCHAR(255);
