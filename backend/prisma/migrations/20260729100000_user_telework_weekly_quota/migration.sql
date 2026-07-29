-- v3.5.13 — Cuota de teletrabajo por SEMANA, y exclusividad entre métodos.
--
-- Se añade un cuarto método al bloque introducido en v3.5.11. A partir de esta
-- versión los cuatro son MUTUAMENTE EXCLUYENTES (D4): solo uno puede estar
-- fijado por trabajador, porque tener a la vez "3 dias/semana" y "10 dias/mes"
-- deja indefinido cual manda y produce alertas que el operador no puede
-- explicar.
--
--   telework_full                 => exento por completo
--   telework_quota_days           => tope mensual en dias
--   telework_quota_days_per_week  => tope semanal en dias   (NUEVO)
--   telework_quota_pct            => tope mensual en % de dias L-V del mes
--
-- Ninguno fijado = se sigue aplicando el tope del departamento, es decir, el
-- comportamiento previo se conserva para toda fila existente.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "telework_quota_days_per_week" INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_telework_quota_days_per_week_range') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_telework_quota_days_per_week_range"
      CHECK ("telework_quota_days_per_week" IS NULL
             OR ("telework_quota_days_per_week" >= 0 AND "telework_quota_days_per_week" <= 7));
  END IF;

  -- Exclusividad mutua, forzada tambien para escrituras que no pasen por la API
  -- (el invariante de Zod solo cubre el camino HTTP).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_telework_quota_single_method') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_telework_quota_single_method"
      CHECK (
        (CASE WHEN "telework_full" THEN 1 ELSE 0 END)
      + (CASE WHEN "telework_quota_days" IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN "telework_quota_days_per_week" IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN "telework_quota_pct" IS NOT NULL THEN 1 ELSE 0 END)
      <= 1
      );
  END IF;
END $$;
