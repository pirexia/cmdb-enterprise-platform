-- v2.8.4: Alert Module tables
-- Creates alert_config (singleton), alert_rules (per-category), alert_runs (history)

CREATE TABLE IF NOT EXISTS "alert_config" (
    "id"                TEXT        NOT NULL DEFAULT 'default',
    "enabled"           BOOLEAN     NOT NULL DEFAULT TRUE,
    "send_time_hour"    INTEGER     NOT NULL DEFAULT 8,
    "send_time_minute"  INTEGER     NOT NULL DEFAULT 30,
    "timezone"          VARCHAR(64) NOT NULL DEFAULT 'UTC',
    "locale"            VARCHAR(10) NOT NULL DEFAULT 'es',
    "recipients"        TEXT[]      NOT NULL DEFAULT '{}',
    "send_all_clear"    BOOLEAN     NOT NULL DEFAULT FALSE,
    "suppress_unchanged" BOOLEAN    NOT NULL DEFAULT TRUE,
    "updated_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_config_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "alert_rules" (
    "id"          UUID        NOT NULL DEFAULT gen_random_uuid(),
    "category"    VARCHAR(50) NOT NULL,
    "enabled"     BOOLEAN     NOT NULL DEFAULT TRUE,
    "warn_days"   INTEGER     NOT NULL DEFAULT 30,
    "recipients"  TEXT[]      NOT NULL DEFAULT '{}',
    "updated_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_rules_pkey"      PRIMARY KEY ("id"),
    CONSTRAINT "alert_rules_category_key" UNIQUE ("category")
);

CREATE TABLE IF NOT EXISTS "alert_runs" (
    "id"           UUID         NOT NULL DEFAULT gen_random_uuid(),
    "trigger"      VARCHAR(20)  NOT NULL,
    "started_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at"  TIMESTAMP(3),
    "status"       VARCHAR(20)  NOT NULL,
    "total_alerts" INTEGER      NOT NULL DEFAULT 0,
    "breakdown"    JSONB        NOT NULL DEFAULT '{}',
    "recipients"   TEXT[]       NOT NULL DEFAULT '{}',
    "message_id"   VARCHAR(255),
    "error_msg"    TEXT,

    CONSTRAINT "alert_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "alert_runs_started_at_idx" ON "alert_runs" ("started_at" DESC);

-- Seed: singleton config row (idempotent)
INSERT INTO "alert_config" ("id") VALUES ('default')
ON CONFLICT ("id") DO NOTHING;

-- Seed: 7 default alert rules (idempotent)
INSERT INTO "alert_rules" ("category", "enabled", "warn_days") VALUES
    ('eol',           TRUE,  90),
    ('eos',           TRUE,  90),
    ('warranty',      TRUE,  60),
    ('maintenance',   TRUE,  60),
    ('contract',      TRUE,  60),
    ('vulnerability', TRUE,   0),
    ('license',       TRUE,  30)
ON CONFLICT ("category") DO NOTHING;
