-- Add sso_provider column to distinguish between SSO providers
-- (microsoft, ldap) for users provisioned via external identity providers.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "sso_provider" VARCHAR(50);

-- Tag existing LDAP shadow users (sso_external_id currently stores email for LDAP users)
UPDATE "users"
SET sso_provider = 'ldap'
WHERE sso_external_id IS NOT NULL
  AND sso_external_id LIKE '%@%';
