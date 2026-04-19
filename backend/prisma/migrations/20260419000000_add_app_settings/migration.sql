CREATE TABLE IF NOT EXISTS "AppSettings" (
  "key"        TEXT PRIMARY KEY,
  "value"      TEXT NOT NULL DEFAULT '',
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO "AppSettings" ("key", "value") VALUES
  ('sidebar_bg',    '#0f172a'),
  ('accent_color',  '#3b82f6'),
  ('company_name',  'CMDB Platform'),
  ('logo_data',     ''),
  ('logo_mime',     '')
ON CONFLICT ("key") DO NOTHING;
