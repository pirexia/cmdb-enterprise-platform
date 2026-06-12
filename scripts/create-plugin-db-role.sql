-- Bootstrap script: create restricted PostgreSQL role for Plugin Engine DDL migrations
-- Run ONCE as superuser (admin) on the target database.
-- Usage: psql -U admin -d cmdb_db -f scripts/create-plugin-db-role.sql
--
-- Security model (D2):
--   cmdb_plugin can CREATE tables/indexes ONLY if they start with plg_
--   cmdb_plugin cannot SELECT/UPDATE/DELETE on any core table
--   The MigrationRunner validates SQL before executing it (allowlist DDL, plg_ prefix check)
--
-- In production this role's password must be set in PLUGIN_DATABASE_URL.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cmdb_plugin') THEN
    CREATE ROLE cmdb_plugin LOGIN PASSWORD 'CHANGE_ME_IN_PRODUCTION';
  END IF;
END$$;

-- Revoke all default privileges on public schema
REVOKE ALL ON SCHEMA public FROM cmdb_plugin;

-- Grant usage on schema (needed to create objects)
GRANT USAGE ON SCHEMA public TO cmdb_plugin;

-- Grant CREATE on schema so the role can CREATE TABLE/INDEX
GRANT CREATE ON SCHEMA public TO cmdb_plugin;

-- cmdb_plugin has NO privileges on existing core tables
-- (GRANT CREATE only allows creating NEW objects, not accessing existing ones)

-- Allow cmdb_plugin to manage its own objects (needed for down-migrations)
ALTER DEFAULT PRIVILEGES FOR ROLE cmdb_plugin IN SCHEMA public
  GRANT ALL ON TABLES TO cmdb_plugin;

ALTER DEFAULT PRIVILEGES FOR ROLE cmdb_plugin IN SCHEMA public
  GRANT ALL ON SEQUENCES TO cmdb_plugin;

-- Revoke the dangerous superuser-only operations
REVOKE ALL ON DATABASE cmdb_db FROM cmdb_plugin;
GRANT CONNECT ON DATABASE cmdb_db TO cmdb_plugin;

-- Note: The MigrationRunner (engine.ts) further validates SQL before execution:
--   - Rejects DROP/TRUNCATE/ALTER on non-plg_* objects
--   - Requires all CREATE TABLE to use plg_<plugin-id>_ prefix
--   - Uses execFile (not exec) — no shell injection
