-- v3.6.0 (follow-up) — Nuevo rol SOC: acceso operativo completo al área de
-- Seguridad (subida/revisión/aceptación de informes Greenbone/CrowdStrike,
-- staging de vulnerabilidades), equivalente a ADMIN solo en ese ámbito.
--
-- ALTER TYPE ... ADD VALUE no puede ejecutarse dentro de la misma transacción
-- que después USA el valor nuevo (PG 12+), pero SÍ puede ejecutarse sola en
-- su propia transacción/migración — que es exactamente lo que hace este
-- fichero, sin ningún UPDATE que dependa de 'SOC' en el mismo paso.
-- IF NOT EXISTS hace el ADD VALUE idempotente ante un reintento.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'SOC';
