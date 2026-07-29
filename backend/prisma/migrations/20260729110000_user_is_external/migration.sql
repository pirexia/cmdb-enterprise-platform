-- v3.5.13 — Marca de trabajador externo (proteccion de datos).
--
-- Un trabajador externo aparece en los calendarios como "Externo (INI)" en vez
-- de con su nombre. El enmascarado se aplica EN SERVIDOR para los roles sin
-- necesidad de conocer la identidad (VIEWER): el nombre real no llega siquiera
-- al navegador. Ver maskIdentityForViewer en service.ts.
--
-- Por defecto false: ninguna fila existente cambia de comportamiento.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_external" BOOLEAN NOT NULL DEFAULT false;
