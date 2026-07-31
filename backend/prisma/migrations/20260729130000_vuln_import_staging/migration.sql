-- v3.6.0 — Vulnerability import staging (Greenbone real-format).
--
-- Two new tables: a batch per uploaded scan file, and an entry per candidate
-- vulnerability inside that batch. A PENDING batch never touches inventory,
-- alerts, reports, or RAG (see spec D4) — acceptance is a separate,
-- transactional step handled by a later task (B ... service/router).
--
-- decision defaults to 'EXCLUDE' as a safe fallback only; the classifier
-- (task B4) explicitly sets 'INCLUDE' per the D7 premarking rule — that
-- logic does not live in the DB.

CREATE TABLE IF NOT EXISTS "vuln_import_batches" (
  "id"                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "source"             VARCHAR(50)  NOT NULL,
  "filename"           VARCHAR(500) NOT NULL,
  "task_name"          VARCHAR(255),
  "greenbone_task_id"  VARCHAR(255),
  "scan_start"         TIMESTAMP(3),
  "scan_end"           TIMESTAMP(3),
  "status"             VARCHAR(30)  NOT NULL DEFAULT 'PENDING',
  "uploaded_by"        VARCHAR(255) NOT NULL,
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT now(),
  "resolved_at"        TIMESTAMP(3),
  "resolved_by"        VARCHAR(255),
  "raw_meta"           JSONB
);

CREATE INDEX IF NOT EXISTS "idx_vuln_import_batches_status_created"
  ON "vuln_import_batches" ("status", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "vuln_import_entries" (
  "id"                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  "batch_id"          UUID          NOT NULL,
  "host_address"      VARCHAR(255)  NOT NULL,
  "ci_id"             UUID,                              -- nullable; no declared FK/relation to configuration_items, see task brief
  "match_confidence"  VARCHAR(30),                        -- EXACT_IP/EXACT_NAME/EXACT_HOSTNAME/EXACT_DNS/FUZZY/AMBIGUOUS/UNMATCHED
  "match_candidates"  JSONB,
  "vuln_key"          VARCHAR(500)  NOT NULL,              -- oid@port identity, see spec D1
  "oid"               VARCHAR(255)  NOT NULL,
  "port"              VARCHAR(50),
  "cves"              TEXT[]        NOT NULL DEFAULT '{}',
  "severity_score"    DOUBLE PRECISION NOT NULL,
  "severity"          VARCHAR(20)   NOT NULL,              -- INFO/LOW/MEDIUM/HIGH/CRITICAL
  "name"              VARCHAR(500)  NOT NULL,
  "summary"           TEXT,
  "solution"          TEXT,
  "family"            VARCHAR(255),
  "thread"            VARCHAR(20),                         -- Alarm/Log, metadata only, see spec D2
  "qod"               INTEGER,
  "epss_score"        DOUBLE PRECISION,
  "raw"               JSONB         NOT NULL,               -- full original vulnerability entry, audit/debug
  "existing_status"   VARCHAR(30),                          -- vuln status already on the CI, if any
  "classification"    VARCHAR(30)   NOT NULL,               -- NUEVA/EXISTENTE_PENDIENTE/REAPARECIDA
  "decision"          VARCHAR(20)   NOT NULL DEFAULT 'EXCLUDE', -- INCLUDE/EXCLUDE
  "edited"            BOOLEAN       NOT NULL DEFAULT false,
  CONSTRAINT "vuln_import_entries_batch_fk"
    FOREIGN KEY ("batch_id") REFERENCES "vuln_import_batches" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_vuln_import_entries_batch"
  ON "vuln_import_entries" ("batch_id");
CREATE INDEX IF NOT EXISTS "idx_vuln_import_entries_batch_classification"
  ON "vuln_import_entries" ("batch_id", "classification");
CREATE INDEX IF NOT EXISTS "idx_vuln_import_entries_ci"
  ON "vuln_import_entries" ("ci_id");
