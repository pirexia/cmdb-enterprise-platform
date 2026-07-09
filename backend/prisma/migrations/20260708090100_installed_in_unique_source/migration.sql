-- v3.4.4: a CI can be INSTALLED_IN at most one container (DB-level backstop)
CREATE UNIQUE INDEX IF NOT EXISTS "ci_relations_installed_in_source_unique"
  ON "ci_relations" ("source_ci_id")
  WHERE "relation_type" = 'INSTALLED_IN';
