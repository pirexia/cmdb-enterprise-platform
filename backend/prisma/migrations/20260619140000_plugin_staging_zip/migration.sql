-- L-08: track the staging ZIP filename on the registry row so validate/install/
-- uninstall can locate it in O(1) instead of scanning + parsing every staging zip.
-- Nullable; legacy rows fall back to the manifest-scan path in code.
ALTER TABLE "plugin_registry" ADD COLUMN IF NOT EXISTS "staging_zip" TEXT;
