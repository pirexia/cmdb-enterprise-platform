-- Plugin Engine v2.8.0
-- Migration: plugin_registry, plugin_hooks, plugin_cron_jobs, plugin_routes,
--            plugin_data_backups, plugin_data_store

CREATE TABLE IF NOT EXISTS "plugin_registry" (
  "id"            uuid        NOT NULL DEFAULT gen_random_uuid(),
  "plugin_id"     text        NOT NULL,
  "name"          text        NOT NULL,
  "version"       text        NOT NULL,
  "author"        text        NOT NULL,
  "license_type"  text        NOT NULL,
  "status"        text        NOT NULL,
  "manifest"      jsonb       NOT NULL,
  "config"        jsonb       NOT NULL DEFAULT '{}',
  "permissions"   text[]      NOT NULL DEFAULT '{}',
  "checksum"      text        NOT NULL,
  "installed_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"    timestamptz NOT NULL DEFAULT now(),
  "last_error"    text,
  "approved_by"   text,
  "approved_at"   timestamptz,
  "data_retention" text       NOT NULL DEFAULT 'HARD',
  CONSTRAINT "plugin_registry_pkey"     PRIMARY KEY ("id"),
  CONSTRAINT "plugin_registry_plugin_id_key" UNIQUE ("plugin_id")
);

CREATE INDEX IF NOT EXISTS "plugin_registry_status_idx"    ON "plugin_registry" ("status");
CREATE INDEX IF NOT EXISTS "plugin_registry_plugin_id_idx" ON "plugin_registry" ("plugin_id");

CREATE TABLE IF NOT EXISTS "plugin_hooks" (
  "id"           uuid    NOT NULL DEFAULT gen_random_uuid(),
  "plugin_id"    uuid    NOT NULL,
  "event"        text    NOT NULL,
  "priority"     integer NOT NULL DEFAULT 50,
  "handler_code" text    NOT NULL,
  "is_active"    boolean NOT NULL DEFAULT true,
  CONSTRAINT "plugin_hooks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "plugin_hooks_plugin_id_fkey"
    FOREIGN KEY ("plugin_id") REFERENCES "plugin_registry" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "plugin_hooks_plugin_id_idx" ON "plugin_hooks" ("plugin_id");
CREATE INDEX IF NOT EXISTS "plugin_hooks_event_idx"     ON "plugin_hooks" ("event");

CREATE TABLE IF NOT EXISTS "plugin_cron_jobs" (
  "id"           uuid        NOT NULL DEFAULT gen_random_uuid(),
  "plugin_id"    uuid        NOT NULL,
  "name"         text        NOT NULL,
  "schedule"     text        NOT NULL,
  "handler_code" text        NOT NULL,
  "is_active"    boolean     NOT NULL DEFAULT true,
  "last_run_at"  timestamptz,
  "next_run_at"  timestamptz,
  CONSTRAINT "plugin_cron_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "plugin_cron_jobs_plugin_id_fkey"
    FOREIGN KEY ("plugin_id") REFERENCES "plugin_registry" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "plugin_cron_jobs_plugin_id_idx" ON "plugin_cron_jobs" ("plugin_id");

CREATE TABLE IF NOT EXISTS "plugin_routes" (
  "id"            uuid    NOT NULL DEFAULT gen_random_uuid(),
  "plugin_id"     uuid    NOT NULL,
  "method"        text    NOT NULL,
  "path"          text    NOT NULL,
  "handler_code"  text    NOT NULL,
  "is_active"     boolean NOT NULL DEFAULT true,
  "requires_auth" boolean NOT NULL DEFAULT true,
  "required_role" text,
  CONSTRAINT "plugin_routes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "plugin_routes_plugin_id_method_path_key" UNIQUE ("plugin_id", "method", "path"),
  CONSTRAINT "plugin_routes_plugin_id_fkey"
    FOREIGN KEY ("plugin_id") REFERENCES "plugin_registry" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "plugin_data_backups" (
  "id"          uuid        NOT NULL DEFAULT gen_random_uuid(),
  "plugin_id"   uuid        NOT NULL,
  "backup_path" text        NOT NULL,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "size_bytes"  integer     NOT NULL,
  "reason"      text        NOT NULL,
  CONSTRAINT "plugin_data_backups_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "plugin_data_backups_plugin_id_fkey"
    FOREIGN KEY ("plugin_id") REFERENCES "plugin_registry" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "plugin_data_backups_plugin_id_idx" ON "plugin_data_backups" ("plugin_id");

CREATE TABLE IF NOT EXISTS "plugin_data_store" (
  "id"         uuid  NOT NULL DEFAULT gen_random_uuid(),
  "table_name" text  NOT NULL,
  "entity_id"  uuid  NOT NULL,
  "plugin_id"  text  NOT NULL,
  "data"       jsonb NOT NULL,
  CONSTRAINT "plugin_data_store_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "plugin_data_store_table_name_entity_id_plugin_id_key"
    UNIQUE ("table_name", "entity_id", "plugin_id")
);

CREATE INDEX IF NOT EXISTS "plugin_data_store_table_entity_idx" ON "plugin_data_store" ("table_name", "entity_id");
CREATE INDEX IF NOT EXISTS "plugin_data_store_plugin_id_idx"    ON "plugin_data_store" ("plugin_id");
