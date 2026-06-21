-- Migration: add Teams/Slack notification channels to alert_config and alert_rules (v3.0.0 T8)

ALTER TABLE "alert_config"
  ADD COLUMN IF NOT EXISTS "teams_webhook_url" VARCHAR(2048),
  ADD COLUMN IF NOT EXISTS "slack_bot_token"   VARCHAR(512),
  ADD COLUMN IF NOT EXISTS "slack_channel"     VARCHAR(255);

ALTER TABLE "alert_rules"
  ADD COLUMN IF NOT EXISTS "channels" TEXT[] NOT NULL DEFAULT '{"email"}';
