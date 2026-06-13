-- Tabla propia del plugin (prefijo obligatorio plg_<id>_ con guiones → _)
CREATE TABLE IF NOT EXISTS plg_hello_world_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ci_id       uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS plg_hello_world_log_ci_idx ON plg_hello_world_log (ci_id);
