-- v3.5.11 — Per-user telework quota override (staff schedule).
--
-- Three independent knobs on `users`, all optional. When none is set the user
-- keeps the department-wide monthly cap
-- (department_schedule_config.monthly_telework_cap), i.e. the previous
-- behaviour is preserved for every existing row.
--
--   telework_full        true  => exempt from the telework quota entirely
--                                 (e.g. 100% remote on medical grounds)
--   telework_quota_days  N     => hard monthly cap of N telework days
--   telework_quota_pct   P     => cap of round(P% * Mon-Fri days of the month)
--
-- Resolution priority: full > days > pct > department default.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "telework_full" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "telework_quota_days" INTEGER;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "telework_quota_pct" INTEGER;

-- Value ranges mirrored from UserTeleworkQuotaSchema (Zod) so the invariant
-- also holds for any write that does not go through the API.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_telework_quota_days_range') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_telework_quota_days_range"
      CHECK ("telework_quota_days" IS NULL OR ("telework_quota_days" >= 0 AND "telework_quota_days" <= 31));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_telework_quota_pct_range') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_telework_quota_pct_range"
      CHECK ("telework_quota_pct" IS NULL OR ("telework_quota_pct" >= 0 AND "telework_quota_pct" <= 100));
  END IF;
END $$;
