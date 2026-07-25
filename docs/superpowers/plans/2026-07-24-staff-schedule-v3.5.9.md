# Staff Schedule Rework (v3.5.9) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the net-hours calculation bug, redesign GUARDIA as a per-entry complement with a DB-enforced one-guard-per-department-per-day rule, fix and extend week cloning, add a read-only "all departments" view, add per-user weekly-hours overrides, add a `WORKER` role scoped to Staff Schedule read access, and ship several UX improvements (auto-fill exit time, apply-to-week, import-previous-week) to the existing Staff Schedule module (`backend/src/modules/staff-schedule/`, `frontend/app/staff-schedule/`).

**Architecture:** All changes extend the existing v3.5.0/v3.5.1 module — no new module is created. Backend: two new migrations (PG enum values must land in their own transaction, per the v3.4.4 precedent), `ScheduleEntry` gains `departmentId` (denormalized, for a DB-level partial unique index) and `onGuard` (boolean complement), `User` gains `weeklyTargetHours` (nullable override). Frontend: existing components get new props (`readOnly`, `onApplyWeek`, `onSaveEntries`) rather than being rewritten; two small new components (`AllDepartmentsView`, week-target picker) are added.

**Tech Stack:** Express 5 + TypeScript, Prisma 6 (raw-SQL migrations, `IF NOT EXISTS` guards), Zod, Next.js 16 / React 19, Jest.

## Global Constraints

- All DB writes that mutate state must have their audit-log insert in the same `prisma.$transaction` (issue #172 pattern) — see `auditStaffSchedule(tx, ...)` usage throughout `router.ts`.
- `status`/`severity`/`type` columns in this module are TEXT validated by Zod allowlists, not PG enums (avoids v3.4.4 enum-migration friction) — keep this pattern for any new TEXT-like fields.
- `UserRole` **is** a real PG enum (`ALTER TYPE ... ADD VALUE`) — a new value must be its own migration, applied before any migration that uses it in a `WHERE`/`::"UserRole"` cast, per the v3.4.4 `INSTALLED_IN` precedent.
- GDPR Art. 9: `BAJA_MEDICA`/`BAJA_PATERNIDAD` masking (`maskEntryForViewer`) must never leak through any new field — `onGuard` must be forced to `false` in the masked branch.
- A01 (OWASP): the one-guard-per-department-per-day rule must be enforced at the DB layer (partial unique index), not just in application code.
- i18n: every new user-facing string needs a key in all 6 locale files (`frontend/locales/{en,es,de,pt,fr,it}.json`).
- `rounded-none` on all new UI elements; `bg-white shadow-sm ring-1 ring-slate-200` for panels — house pattern (see CLAUDE.md "Patrón canónico de la casa").
- Do not run `migrate dev` in Docker — migrations are hand-written `migration.sql` files applied with `prisma migrate deploy` (see CLAUDE.md Environment & Commands).
- Never edit `AuditLog` rows; every new write path gets a `auditStaffSchedule` call.

---

## File Structure

**Backend — modified:**
- `backend/prisma/schema.prisma` — `UserRole` enum, `User.weeklyTargetHours`, `ScheduleEntry.departmentId`/`onGuard`
- `backend/prisma/migrations/20260724100000_add_worker_role/migration.sql` — new
- `backend/prisma/migrations/20260724100100_staff_schedule_rework/migration.sql` — new
- `backend/src/modules/staff-schedule/schemas.ts` — remove `GUARDIA` status, add `onGuard`, `GUARDIA_UNIQUE` alert type, `CloneScheduleSchema`, `UserWeeklyHoursSchema`
- `backend/src/modules/staff-schedule/validationEngine.ts` — Friday break fix, `onGuard`-based V6, new `GUARDIA_UNIQUE` rule, per-user weekly targets
- `backend/src/modules/staff-schedule/queries.ts` — `loadWeeklyTargetHours`
- `backend/src/modules/staff-schedule/service.ts` — `onGuard` plumbing, `cloneToWeek` (replaces `cloneToNextWeek`), `teleworkDaysWeek`/`weeklyTargetHours` in view/summary
- `backend/src/modules/staff-schedule/router.ts` — clone endpoint body, weekly-hours endpoint
- `backend/src/modules/staff-schedule/middleware.ts` — `requireScheduleAccess` allows `WORKER`
- `backend/src/modules/staff-schedule/export.ts` — `onGuard` indicator, `TeleworkDaysWeek` column
- `backend/src/shared/types.ts` — `UserRole` union
- `backend/src/index.ts` — role-change allowlist
- `backend/src/modules/reports/types.ts`, `backend/src/modules/reports/registry.ts` — `UserRole`/`ROLE_RANK`
- `backend/src/modules/internal/users.ts` — bulk-import role enum

**Backend — tests:**
- `backend/src/modules/staff-schedule/__tests__/validationEngine.test.ts` — Friday fix regression, `onGuard` V6/V7, `GUARDIA_UNIQUE`

**Frontend — modified:**
- `frontend/app/staff-schedule/types.ts` — `onGuard`, `teleworkDaysWeek`, `weeklyTargetHours`
- `frontend/app/staff-schedule/hooks/useStaffSchedule.ts` — `clone(targetWeekStart)`, `importPreviousWeek()`, `useAllDepartmentsSchedules`
- `frontend/app/staff-schedule/page.tsx` — clone picker wiring, "todos los departamentos" branch, import-previous-week button
- `frontend/components/staff-schedule/ScheduleEntryPopover.tsx` — onGuard checkbox, auto-fill exit time, apply-to-week
- `frontend/components/staff-schedule/StaffScheduleCalendar.tsx` — `readOnly`, `onSaveEntries`, week/month telework split
- `frontend/components/staff-schedule/ScheduleCell.tsx` — onGuard badge
- `frontend/components/staff-schedule/ScheduleConfigPanel.tsx` — per-user weekly hours field
- `frontend/contexts/AuthContext.tsx`, `frontend/components/Sidebar.tsx`, `frontend/app/settings/page.tsx`, `frontend/app/reports/types/report.ts` — `WORKER` role
- `frontend/locales/{en,es,de,pt,fr,it}.json` — new keys

**Frontend — new:**
- `frontend/components/staff-schedule/WeekTargetPicker.tsx`
- `frontend/components/staff-schedule/AllDepartmentsView.tsx`

**Docs:**
- `docs/STAFF_SCHEDULE.md`, `docs/DPIA_STAFF_SCHEDULE.md`, `docs/USER_MANUAL.md`, `docs/USER_MANUAL.en.md`

---

### Task 1: Schema migrations — WORKER role, onGuard/departmentId, weekly hours

**Files:**
- Create: `backend/prisma/migrations/20260724100000_add_worker_role/migration.sql`
- Create: `backend/prisma/migrations/20260724100100_staff_schedule_rework/migration.sql`
- Modify: `backend/prisma/schema.prisma`

**Interfaces:**
- Produces: `User.weeklyTargetHours: Float?`, `User.role` accepts `'WORKER'`, `ScheduleEntry.departmentId: String`, `ScheduleEntry.onGuard: Boolean`, unique index `schedule_entries_on_guard_unique` on `(department_id, date) WHERE on_guard = true`.

- [ ] **Step 1: Create the enum migration**

```sql
-- backend/prisma/migrations/20260724100000_add_worker_role/migration.sql
-- v3.5.9: WORKER role (VIEWER + Horarios de Personal access only). Added in
-- its own migration because PG forbids using a newly added enum value inside
-- the same transaction that adds it (v3.4.4 INSTALLED_IN precedent).
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'WORKER';
```

- [ ] **Step 2: Create the data/column migration**

```sql
-- backend/prisma/migrations/20260724100100_staff_schedule_rework/migration.sql
-- v3.5.9: Staff Schedule rework.
--  * GUARDIA becomes a per-entry complement (on_guard) instead of a status
--    value, so a worker can be TELETRABAJO + on guard simultaneously.
--  * schedule_entries.department_id is denormalized from staff_schedules so a
--    DB-level partial unique index can enforce "at most one worker on guard
--    per department per day" without a join (A01 — filter at the DB layer).
--  * users.weekly_target_hours: optional per-user override of the
--    department's default 40h/week target (reduced-hours workers).

ALTER TABLE "schedule_entries" ADD COLUMN IF NOT EXISTS "department_id" UUID;
ALTER TABLE "schedule_entries" ADD COLUMN IF NOT EXISTS "on_guard" BOOLEAN NOT NULL DEFAULT false;

UPDATE "schedule_entries" se
SET "department_id" = ss."department_id"
FROM "staff_schedules" ss
WHERE se."schedule_id" = ss."id" AND se."department_id" IS NULL;

ALTER TABLE "schedule_entries" ALTER COLUMN "department_id" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'schedule_entries_department_id_fkey'
  ) THEN
    ALTER TABLE "schedule_entries"
      ADD CONSTRAINT "schedule_entries_department_id_fkey"
      FOREIGN KEY ("department_id") REFERENCES "departments"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "schedule_entries_department_id_idx" ON "schedule_entries"("department_id");

-- Data migration: GUARDIA was a status value; move it to the new on_guard
-- flag and fall the underlying day back to PRESENCIAL (the common real-world
-- case: on-call while otherwise present).
UPDATE "schedule_entries" SET "on_guard" = true, "status" = 'PRESENCIAL' WHERE "status" = 'GUARDIA';

CREATE UNIQUE INDEX IF NOT EXISTS "schedule_entries_on_guard_unique"
  ON "schedule_entries"("department_id", "date")
  WHERE "on_guard" = true;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "weekly_target_hours" DOUBLE PRECISION;
```

- [ ] **Step 3: Update `schema.prisma` — `UserRole` enum**

In `backend/prisma/schema.prisma`, find:
```prisma
enum UserRole {
  ADMIN
  AUDITOR
  VIEWER
}
```
Replace with:
```prisma
enum UserRole {
  ADMIN
  AUDITOR
  VIEWER
  WORKER
}
```

- [ ] **Step 4: Update `schema.prisma` — `User.weeklyTargetHours`**

In the `User` model, near `departmentId`, add:
```prisma
  weeklyTargetHours Float?   @map("weekly_target_hours")
```

- [ ] **Step 5: Update `schema.prisma` — `ScheduleEntry.departmentId`/`onGuard`**

Replace the `ScheduleEntry` model body with:
```prisma
model ScheduleEntry {
  id           String    @id @default(uuid()) @db.Uuid
  scheduleId   String    @db.Uuid @map("schedule_id")
  userId       String    @db.Uuid @map("user_id")
  departmentId String    @db.Uuid @map("department_id")
  date         DateTime  @db.Date
  status       String
  onGuard      Boolean   @default(false) @map("on_guard")
  startTime    String?   @map("start_time")
  endTime      String?   @map("end_time")
  notes        String?

  createdAt    DateTime  @default(now()) @map("created_at")
  updatedAt    DateTime  @updatedAt @map("updated_at")

  schedule     StaffSchedule @relation(fields: [scheduleId], references: [id], onDelete: Cascade, onUpdate: Cascade)
  user         User          @relation(fields: [userId], references: [id], onDelete: Cascade, onUpdate: Cascade)
  department   Department    @relation(fields: [departmentId], references: [id], onDelete: Cascade, onUpdate: Cascade)

  @@unique([scheduleId, userId, date])
  @@index([scheduleId])
  @@index([userId])
  @@index([date])
  @@index([departmentId])
  @@map("schedule_entries")
}
```

- [ ] **Step 6: Add the back-relation on `Department`**

In the `Department` model, add alongside `schedules`:
```prisma
  scheduleEntries ScheduleEntry[]
```

- [ ] **Step 7: Apply migrations and regenerate the client**

```bash
podman exec cmdb-backend-prod npx prisma migrate deploy
podman exec cmdb-backend-prod npx prisma generate
```
Expected: both migrations report "Applied", `prisma generate` completes with no errors.

- [ ] **Step 8: Commit**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations/20260724100000_add_worker_role backend/prisma/migrations/20260724100100_staff_schedule_rework
git commit -m "feat(staff-schedule): add WORKER role, onGuard/departmentId, weekly hours override"
```

---

### Task 2: Fix the Friday net-hours bug

**Files:**
- Modify: `backend/src/modules/staff-schedule/validationEngine.ts:84-98`
- Test: `backend/src/modules/staff-schedule/__tests__/validationEngine.test.ts`

**Interfaces:**
- Consumes: none new.
- Produces: `computeNetHours(entry, cfg, isSummer)` now applies the break on Fridays too (only `INTENSIVO` skips it).

- [ ] **Step 1: Write the failing tests**

In `backend/src/modules/staff-schedule/__tests__/validationEngine.test.ts`, change the import line 1 to also pull in `computeNetHours`:
```ts
import { validate, ValidationConfig, EntryLike, ScheduleLike, computeNetHours } from '../validationEngine';
```
Then add these two tests inside the existing `describe('validationEngine.validate', ...)` block, after test (e):
```ts
  it('(f) Friday PRESENCIAL applies the same break as other days (bug #195 regression)', () => {
    // 07:30-16:00 gross 8.5h, summer break 30min -> net 8.0h, same as Mon-Thu.
    const fri: EntryLike = { userId: 'u1', date: '2026-07-10', status: 'PRESENCIAL', startTime: '07:30', endTime: '16:00' };
    expect(computeNetHours(fri, cfg, true)).toBeCloseTo(8.0, 5);
  });

  it('(g) 5x 07:30-16:00 summer week nets exactly 40h, not 40.5h', () => {
    const entries: EntryLike[] = ['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10'].map((date) => ({
      userId: 'u1', date, status: 'PRESENCIAL', startTime: '07:30', endTime: '16:00',
    }));
    const total = entries.reduce((sum, e) => sum + computeNetHours(e, cfg, true), 0);
    expect(total).toBeCloseTo(40.0, 5);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
podman exec cmdb-backend-prod npx jest staff-schedule/__tests__/validationEngine.test.ts -t "bug #195"
```
Expected: FAIL — actual total is 40.5, not 40.0.

- [ ] **Step 3: Fix `computeNetHours`**

In `backend/src/modules/staff-schedule/validationEngine.ts`, replace:
```ts
export function computeNetHours(entry: EntryLike, cfg: ValidationConfig, isSummer: boolean): number {
  if (NON_WORKING_STATUSES.has(entry.status)) return 0;
  if (!entry.startTime || !entry.endTime) return 0;

  const gross = minutesBetween(entry.startTime, entry.endTime) / 60;
  const isFriday = weekdayIso(entry.date) === 5;
  const isIntensive = entry.status === 'INTENSIVO';

  const brk = isFriday || isIntensive
    ? 0
    : (isSummer ? cfg.summerBreakMinutes : cfg.winterBreakMinutes) / 60;

  return gross - brk;
}
```
With:
```ts
export function computeNetHours(entry: EntryLike, cfg: ValidationConfig, isSummer: boolean): number {
  if (NON_WORKING_STATUSES.has(entry.status)) return 0;
  if (!entry.startTime || !entry.endTime) return 0;

  const gross = minutesBetween(entry.startTime, entry.endTime) / 60;
  const isIntensive = entry.status === 'INTENSIVO';

  // The break applies every working day, including Fridays — only an
  // INTENSIVO (continuous) day skips it. Fixes issue #195: a normal Friday
  // was silently zeroing the break, inflating the weekly total (e.g. 40.5h
  // instead of 40h for a 5x8h week).
  const brk = isIntensive
    ? 0
    : (isSummer ? cfg.summerBreakMinutes : cfg.winterBreakMinutes) / 60;

  return gross - brk;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
podman exec cmdb-backend-prod npx jest staff-schedule/__tests__/validationEngine.test.ts
```
Expected: all tests PASS (including the two new ones and all pre-existing ones — none of the pre-existing tests rely on a non-`INTENSIVO` Friday skipping the break).

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/staff-schedule/validationEngine.ts backend/src/modules/staff-schedule/__tests__/validationEngine.test.ts
git commit -m "fix(staff-schedule): apply break on Fridays, fixing weekly hours over-count"
```

---

### Task 3: GUARDIA as a per-entry complement — schemas + validation engine

**Files:**
- Modify: `backend/src/modules/staff-schedule/schemas.ts`
- Modify: `backend/src/modules/staff-schedule/validationEngine.ts`
- Test: `backend/src/modules/staff-schedule/__tests__/validationEngine.test.ts`

**Interfaces:**
- Consumes: none new.
- Produces: `EntryLike.onGuard?: boolean`, `validate(schedule, entries, cfg, summer, teleworkCountsByUser, weeklyTargetsByUser = {})`, new alert type `GUARDIA_UNIQUE`.

- [ ] **Step 1: Remove `GUARDIA` from the status allowlist, add `onGuard`**

In `backend/src/modules/staff-schedule/schemas.ts`, replace:
```ts
export const SCHEDULE_STATUS = [
  'PRESENCIAL',
  'TELETRABAJO',
  'VACACIONES',
  'BAJA_MEDICA',
  'BAJA_PATERNIDAD',
  'GUARDIA',
  'INTENSIVO',
  'VIAJE',
  'AUSENTE',
] as const;
```
With:
```ts
export const SCHEDULE_STATUS = [
  'PRESENCIAL',
  'TELETRABAJO',
  'VACACIONES',
  'BAJA_MEDICA',
  'BAJA_PATERNIDAD',
  'INTENSIVO',
  'VIAJE',
  'AUSENTE',
] as const;
```
Add `'GUARDIA_UNIQUE'` to `ALERT_TYPE`:
```ts
export const ALERT_TYPE = [
  'TELEWORK_QUOTA',
  'WEEKLY_HOURS',
  'DAILY_HOURS',
  'PRESENCE_PCT',
  'FLEX_RANGE',
  'GUARDIA_COVERAGE',
  'GUARDIA_UNIQUE',
  'BAJA_CONFLICT',
] as const;
```
In `EntryUpdateSchema`, add `onGuard`:
```ts
const EntryUpdateSchema = z.object({
  userId: z.string().uuid(),
  date: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Invalid date'),
  status: z.enum(SCHEDULE_STATUS),
  onGuard: z.boolean().optional(),
  startTime: timeSchema.nullable().optional(),
  endTime: timeSchema.nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});
```
Add two new schemas at the end of the file:
```ts
// ─── Clone / import-previous-week ──────────────────────────────────────────

export const CloneScheduleSchema = z.object({
  targetWeekStart: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Invalid date'),
});

// ─── Per-user weekly hours override ────────────────────────────────────────

export const UserWeeklyHoursSchema = z.object({
  weeklyTargetHours: z.number().min(0).max(80).nullable(),
});
```

- [ ] **Step 2: Write the failing tests**

In `backend/src/modules/staff-schedule/__tests__/validationEngine.test.ts`, replace the two GUARDIA-related tests:
```ts
  it('does not raise GUARDIA_COVERAGE / BAJA_CONFLICT when there is no week-level conflict', () => {
    const entries: EntryLike[] = [
      { userId: 'u1', date: '2026-07-06', status: 'GUARDIA', startTime: '08:00', endTime: '17:00' },
      { userId: 'u1', date: '2026-07-07', status: 'PRESENCIAL', startTime: '08:00', endTime: '17:00' },
    ];
    const alerts = validate(schedule, entries, cfg, null, {});
    expect(alertsOfType(alerts, 'GUARDIA_COVERAGE')).toHaveLength(0);
    expect(alertsOfType(alerts, 'BAJA_CONFLICT')).toHaveLength(0);
  });

  it('raises GUARDIA_COVERAGE when GUARDIA and VIAJE/VACACIONES fall in the same week', () => {
    const entries: EntryLike[] = [
      { userId: 'u1', date: '2026-07-06', status: 'GUARDIA', startTime: '08:00', endTime: '17:00' },
      { userId: 'u1', date: '2026-07-07', status: 'VACACIONES' },
    ];
    const alerts = validate(schedule, entries, cfg, null, {});
    const coverage = alertsOfType(alerts, 'GUARDIA_COVERAGE');
    expect(coverage).toHaveLength(1);
    expect(coverage[0].severity).toBe('ERROR');
  });
```
With:
```ts
  it('does not raise GUARDIA_COVERAGE / BAJA_CONFLICT when there is no week-level conflict', () => {
    const entries: EntryLike[] = [
      { userId: 'u1', date: '2026-07-06', status: 'PRESENCIAL', onGuard: true, startTime: '08:00', endTime: '17:00' },
      { userId: 'u1', date: '2026-07-07', status: 'PRESENCIAL', startTime: '08:00', endTime: '17:00' },
    ];
    const alerts = validate(schedule, entries, cfg, null, {});
    expect(alertsOfType(alerts, 'GUARDIA_COVERAGE')).toHaveLength(0);
    expect(alertsOfType(alerts, 'BAJA_CONFLICT')).toHaveLength(0);
  });

  it('raises GUARDIA_COVERAGE when on-guard and VIAJE/VACACIONES fall in the same week', () => {
    const entries: EntryLike[] = [
      { userId: 'u1', date: '2026-07-06', status: 'PRESENCIAL', onGuard: true, startTime: '08:00', endTime: '17:00' },
      { userId: 'u1', date: '2026-07-07', status: 'VACACIONES' },
    ];
    const alerts = validate(schedule, entries, cfg, null, {});
    const coverage = alertsOfType(alerts, 'GUARDIA_COVERAGE');
    expect(coverage).toHaveLength(1);
    expect(coverage[0].severity).toBe('ERROR');
  });

  it('a worker can be TELETRABAJO and on guard on the same day, with no conflict alert', () => {
    const entries: EntryLike[] = [
      { userId: 'u1', date: '2026-07-06', status: 'TELETRABAJO', onGuard: true, startTime: '08:00', endTime: '17:00' },
    ];
    const alerts = validate(schedule, entries, cfg, null, {});
    expect(alertsOfType(alerts, 'GUARDIA_COVERAGE')).toHaveLength(0);
    expect(alertsOfType(alerts, 'GUARDIA_UNIQUE')).toHaveLength(0);
  });

  it('raises GUARDIA_UNIQUE when two workers are on guard the same day', () => {
    const entries: EntryLike[] = [
      { userId: 'u1', date: '2026-07-06', status: 'PRESENCIAL', onGuard: true, startTime: '08:00', endTime: '17:00' },
      { userId: 'u2', date: '2026-07-06', status: 'TELETRABAJO', onGuard: true, startTime: '08:00', endTime: '17:00' },
    ];
    const alerts = validate(schedule, entries, cfg, null, {});
    const unique = alertsOfType(alerts, 'GUARDIA_UNIQUE');
    expect(unique).toHaveLength(2);
    expect(unique.map((a) => a.userId).sort()).toEqual(['u1', 'u2']);
    expect(unique[0].severity).toBe('ERROR');
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
podman exec cmdb-backend-prod npx jest staff-schedule/__tests__/validationEngine.test.ts -t "on guard"
```
Expected: FAIL — `onGuard` doesn't exist on `EntryLike` yet (TS compile error under ts-jest), or the assertions fail because V6 still reads `status === 'GUARDIA'`.

- [ ] **Step 4: Update `EntryLike` and V6, add V-GUARDIA_UNIQUE**

In `backend/src/modules/staff-schedule/validationEngine.ts`, update the interface:
```ts
export interface EntryLike {
  userId: string;
  date: string; // ISO "YYYY-MM-DD"
  status: string;
  onGuard?: boolean;
  startTime?: string | null;
  endTime?: string | null;
}
```
Replace the V6 block:
```ts
    // ── GUARDIA_COVERAGE (ERROR) — week-level reinterpretation, see note ────
    const guardiaDays = es.filter((e) => e.status === 'GUARDIA');
```
With:
```ts
    // ── GUARDIA_COVERAGE (ERROR) — week-level reinterpretation, see note ────
    const guardiaDays = es.filter((e) => e.onGuard);
```
Add a new block right after the per-user `for` loop closes (after the FLEX_RANGE block, before the `// ── PRESENCE_PCT` section), still inside `validate()`:
```ts
  // ── GUARDIA_UNIQUE (ERROR): more than one worker on guard duty the same
  // day within this schedule. This is a same-schedule early-warning shown in
  // the DRAFT validation UI; the hard, cross-department-history guarantee is
  // the `schedule_entries_on_guard_unique` partial index enforced at write
  // time (service.ts updateEntries), per A01.
  const guardsByDate = new Map<string, string[]>();
  for (const e of entries) {
    if (e.onGuard) {
      const arr = guardsByDate.get(e.date) ?? [];
      arr.push(e.userId);
      guardsByDate.set(e.date, arr);
    }
  }
  for (const [date, userIds] of guardsByDate) {
    if (userIds.length > 1) {
      for (const uid of userIds) {
        alerts.push({
          type: 'GUARDIA_UNIQUE',
          severity: 'ERROR',
          message: `More than one worker is on GUARDIA duty on ${date}`,
          userId: uid,
          date,
        });
      }
    }
  }
```

- [ ] **Step 5: Add per-user weekly targets parameter**

Still in `validationEngine.ts`, change the `validate` signature and the WEEKLY_HOURS block. Replace:
```ts
export function validate(
  schedule: ScheduleLike,
  entries: EntryLike[],
  cfg: ValidationConfig,
  summer: SummerPeriodLike | null | undefined,
  teleworkCountsByUser: Record<string, number>,
): GeneratedAlert[] {
  const alerts: GeneratedAlert[] = [];
  const isSummer = detectSummer(schedule.weekStart, summer ?? null);
  const maxDaily = isSummer ? cfg.summerMaxDailyNetHours : cfg.winterMaxDailyNetHours;
  const target = cfg.weeklyTargetNetHours;
```
With:
```ts
export function validate(
  schedule: ScheduleLike,
  entries: EntryLike[],
  cfg: ValidationConfig,
  summer: SummerPeriodLike | null | undefined,
  teleworkCountsByUser: Record<string, number>,
  weeklyTargetsByUser: Record<string, number> = {},
): GeneratedAlert[] {
  const alerts: GeneratedAlert[] = [];
  const isSummer = detectSummer(schedule.weekStart, summer ?? null);
  const maxDaily = isSummer ? cfg.summerMaxDailyNetHours : cfg.winterMaxDailyNetHours;
```
Then inside the per-user loop, replace:
```ts
    // ── WEEKLY_HOURS (ERROR): intensive Friday but week total below target ──
    const hasIntensiveFriday = es.some((e) => e.status === 'INTENSIVO' && weekdayIso(e.date) === 5);
    if (hasIntensiveFriday) {
      const weekly = es.reduce((sum, e) => sum + computeNetHours(e, cfg, isSummer), 0);
      if (weekly < target - EPS) {
```
With:
```ts
    // ── WEEKLY_HOURS (ERROR): intensive Friday but week total below target ──
    const target = weeklyTargetsByUser[userId] ?? cfg.weeklyTargetNetHours;
    const hasIntensiveFriday = es.some((e) => e.status === 'INTENSIVO' && weekdayIso(e.date) === 5);
    if (hasIntensiveFriday) {
      const weekly = es.reduce((sum, e) => sum + computeNetHours(e, cfg, isSummer), 0);
      if (weekly < target - EPS) {
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
podman exec cmdb-backend-prod npx jest staff-schedule/__tests__/validationEngine.test.ts
```
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/staff-schedule/schemas.ts backend/src/modules/staff-schedule/validationEngine.ts backend/src/modules/staff-schedule/__tests__/validationEngine.test.ts
git commit -m "feat(staff-schedule): GUARDIA becomes a per-entry complement (onGuard), add GUARDIA_UNIQUE rule"
```

---

### Task 4: GUARDIA as a per-entry complement — service layer

**Files:**
- Modify: `backend/src/modules/staff-schedule/queries.ts`
- Modify: `backend/src/modules/staff-schedule/service.ts`

**Interfaces:**
- Consumes: `EntryLike.onGuard` (Task 3), `schedule_entries_on_guard_unique` index (Task 1).
- Produces: `loadWeeklyTargetHours(prisma, userIds, departmentDefault)`, `cloneToWeek(prisma, scheduleId, targetWeekStart, createdBy)` (replaces `cloneToNextWeek`), `ScheduleView.rows[].summary.{teleworkDaysWeek,weeklyTargetHours,guardDays}` (guardDays now onGuard-based).

- [ ] **Step 1: Add `loadWeeklyTargetHours` to `queries.ts`**

In `backend/src/modules/staff-schedule/queries.ts`, add at the end:
```ts
// Resolve each user's effective weekly target: their own override if set,
// otherwise the department's default (used for both V-WEEKLY_HOURS and the
// client-side exit-time autofill).
export async function loadWeeklyTargetHours(
  prisma: Db,
  userIds: string[],
  departmentDefault: number,
): Promise<Record<string, number>> {
  if (userIds.length === 0) return {};
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, weeklyTargetHours: true },
  });
  const map: Record<string, number> = {};
  for (const u of users) map[u.id] = u.weeklyTargetHours ?? departmentDefault;
  return map;
}
```

- [ ] **Step 2: Update `maskEntryForViewer` and `MaskedEntryFields`**

In `backend/src/modules/staff-schedule/service.ts`, replace:
```ts
export interface MaskedEntryFields {
  status: string;
  startTime: string | null;
  endTime: string | null;
  notes: string | null;
  healthMasked?: boolean;
}
```
With:
```ts
export interface MaskedEntryFields {
  status: string;
  onGuard: boolean;
  startTime: string | null;
  endTime: string | null;
  notes: string | null;
  healthMasked?: boolean;
}
```
Replace `maskEntryForViewer`:
```ts
export function maskEntryForViewer(
  entry: { status: string; startTime: string | null; endTime: string | null; notes: string | null; userId: string },
  viewer: Viewer,
): MaskedEntryFields {
  const isHealthStatus = HEALTH_STATUSES.includes(entry.status);
  const isAuthorized = viewer.role === 'ADMIN' || viewer.id === entry.userId;
  if (isHealthStatus && !isAuthorized) {
    return { status: 'AUSENTE', startTime: null, endTime: null, notes: null, healthMasked: true };
  }
  return { status: entry.status, startTime: entry.startTime, endTime: entry.endTime, notes: entry.notes, healthMasked: false };
}
```
With:
```ts
export function maskEntryForViewer(
  entry: { status: string; startTime: string | null; endTime: string | null; notes: string | null; userId: string; onGuard: boolean },
  viewer: Viewer,
): MaskedEntryFields {
  const isHealthStatus = HEALTH_STATUSES.includes(entry.status);
  const isAuthorized = viewer.role === 'ADMIN' || viewer.id === entry.userId;
  if (isHealthStatus && !isAuthorized) {
    // onGuard forced false: don't let guard-duty correlate with a masked
    // health-leave day and leak information about it (Art. 9).
    return { status: 'AUSENTE', startTime: null, endTime: null, notes: null, onGuard: false, healthMasked: true };
  }
  return { status: entry.status, startTime: entry.startTime, endTime: entry.endTime, notes: entry.notes, onGuard: entry.onGuard, healthMasked: false };
}
```

- [ ] **Step 3: Update `EntryInput`, `createSchedule`, `updateEntries`**

Replace:
```ts
export interface EntryInput {
  userId: string;
  date: string;
  status: string;
  startTime?: string | null;
  endTime?: string | null;
  notes?: string | null;
}
```
With:
```ts
export interface EntryInput {
  userId: string;
  date: string;
  status: string;
  onGuard?: boolean;
  startTime?: string | null;
  endTime?: string | null;
  notes?: string | null;
}
```
In `createSchedule`, the base-entries `flatMap` must set `departmentId`:
```ts
  const entriesData = users.flatMap((u) =>
    Array.from({ length: 5 }, (_, i) => ({
      scheduleId: schedule.id,
      userId: u.id,
      departmentId: params.departmentId,
      date: addDaysUtc(weekStartDate, i),
      status: 'PRESENCIAL',
    })),
  );
```
Replace the whole `updateEntries` function:
```ts
// updateEntries — only allowed while the schedule is DRAFT (D10).
export async function updateEntries(prisma: Prisma.TransactionClient, scheduleId: string, entries: EntryInput[]) {
  const schedule = await prisma.staffSchedule.findUnique({
    where: { id: scheduleId },
    select: { status: true, departmentId: true },
  });
  if (!schedule) throw new ScheduleServiceError(404, 'Schedule not found');
  if (schedule.status !== 'DRAFT') {
    throw new ScheduleServiceError(409, 'Schedule is not editable once published');
  }

  for (const e of entries) {
    const date = parseDateOnly(e.date);
    try {
      await prisma.scheduleEntry.upsert({
        where: { scheduleId_userId_date: { scheduleId, userId: e.userId, date } },
        create: {
          scheduleId,
          userId: e.userId,
          departmentId: schedule.departmentId,
          date,
          status: e.status,
          onGuard: e.onGuard ?? false,
          startTime: e.startTime ?? null,
          endTime: e.endTime ?? null,
          notes: e.notes ?? null,
        },
        update: {
          status: e.status,
          onGuard: e.onGuard ?? false,
          startTime: e.startTime ?? null,
          endTime: e.endTime ?? null,
          notes: e.notes ?? null,
        },
      });
    } catch (err: any) {
      if (err?.code === 'P2002' && String(err?.meta?.target ?? '').includes('on_guard')) {
        throw new ScheduleServiceError(409, `Another worker is already on GUARDIA duty on ${e.date} for this department`);
      }
      throw err;
    }
  }
}
```

- [ ] **Step 4: Replace `cloneToNextWeek` with `cloneToWeek`**

Replace the whole `cloneToNextWeek` function:
```ts
// cloneToNextWeek — copies all entries verbatim to a new DRAFT schedule one week later.
export async function cloneToNextWeek(prisma: Prisma.TransactionClient, scheduleId: string, createdBy: string) {
  const origin = await loadScheduleWithEntries(prisma, scheduleId);
  if (!origin) throw new ScheduleServiceError(404, 'Schedule not found');

  const newWeekStart = addDaysUtc(origin.weekStart, 7);
  const newWeekEnd = addDaysUtc(origin.weekEnd, 7);
  const year = newWeekStart.getUTCFullYear();
  const summer = await loadSummerForYear(prisma, year);
  const isSummerWeek = detectSummer(isoDate(newWeekStart), summer);

  const created = await prisma.staffSchedule.create({
    data: {
      departmentId: origin.departmentId,
      weekStart: newWeekStart,
      weekEnd: newWeekEnd,
      year,
      isSummerWeek,
      createdBy,
      status: 'DRAFT',
    },
  });

  const entriesData = origin.entries.map((e) => ({
    scheduleId: created.id,
    userId: e.userId,
    date: addDaysUtc(e.date, 7),
    status: e.status,
    startTime: e.startTime,
    endTime: e.endTime,
    notes: e.notes,
  }));
  if (entriesData.length > 0) {
    await prisma.scheduleEntry.createMany({ data: entriesData });
  }
  return created;
}
```
With:
```ts
// cloneToWeek — copies all entries from `scheduleId` onto a caller-chosen
// target Monday. Used both by the "Clone to week..." picker and by
// "Import previous week" (source = previous week's schedule, target = the
// currently-viewed empty week). Rejects a target that isn't strictly in the
// future, isn't a Monday, or already has a schedule for this department.
export async function cloneToWeek(
  prisma: Prisma.TransactionClient,
  scheduleId: string,
  targetWeekStart: string,
  createdBy: string,
) {
  const origin = await loadScheduleWithEntries(prisma, scheduleId);
  if (!origin) throw new ScheduleServiceError(404, 'Schedule not found');

  const newWeekStart = parseDateOnly(targetWeekStart);
  const todayUtc = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  if (newWeekStart.getTime() <= todayUtc.getTime()) {
    throw new ScheduleServiceError(422, 'Target week must be in the future');
  }
  if (newWeekStart.getUTCDay() !== 1) {
    throw new ScheduleServiceError(422, 'Target week must start on a Monday');
  }

  const existing = await prisma.staffSchedule.findUnique({
    where: { departmentId_weekStart: { departmentId: origin.departmentId, weekStart: newWeekStart } },
    select: { id: true },
  });
  if (existing) {
    throw new ScheduleServiceError(409, 'A schedule already exists for the target week');
  }

  const newWeekEnd = addDaysUtc(newWeekStart, 4);
  const year = newWeekStart.getUTCFullYear();
  const summer = await loadSummerForYear(prisma, year);
  const isSummerWeek = detectSummer(isoDate(newWeekStart), summer);

  const created = await prisma.staffSchedule.create({
    data: {
      departmentId: origin.departmentId,
      weekStart: newWeekStart,
      weekEnd: newWeekEnd,
      year,
      isSummerWeek,
      createdBy,
      status: 'DRAFT',
    },
  });

  const dayOffsetOf = (originDate: Date) => Math.round((originDate.getTime() - origin.weekStart.getTime()) / 86400000);

  const entriesData = origin.entries.map((e) => ({
    scheduleId: created.id,
    userId: e.userId,
    departmentId: origin.departmentId,
    date: addDaysUtc(newWeekStart, dayOffsetOf(e.date)),
    status: e.status,
    onGuard: e.onGuard,
    startTime: e.startTime,
    endTime: e.endTime,
    notes: e.notes,
  }));
  if (entriesData.length > 0) {
    await prisma.scheduleEntry.createMany({ data: entriesData });
  }
  return created;
}
```

- [ ] **Step 5: Update `runValidation` to load and pass weekly targets**

Replace:
```ts
export async function runValidation(prisma: Prisma.TransactionClient, scheduleId: string): Promise<GeneratedAlert[]> {
  const schedule = await loadScheduleWithEntries(prisma, scheduleId);
  if (!schedule) throw new ScheduleServiceError(404, 'Schedule not found');

  const cfg = await loadValidationConfig(prisma, schedule.departmentId);
  const summer = await loadSummerForYear(prisma, schedule.year);

  const entriesLike: EntryLike[] = schedule.entries.map((e) => ({
    userId: e.userId,
    date: isoDate(e.date),
    status: e.status,
    startTime: e.startTime,
    endTime: e.endTime,
  }));

  const month = schedule.weekStart.getUTCMonth() + 1;
  const userIds = Array.from(new Set(entriesLike.map((e) => e.userId)));
  const teleworkCountsByUser: Record<string, number> = {};
  for (const uid of userIds) {
    teleworkCountsByUser[uid] = await countTeleworkThisMonth(prisma, uid, schedule.year, month);
  }

  const scheduleLike: ScheduleLike = { id: schedule.id, weekStart: isoDate(schedule.weekStart), year: schedule.year };
  const alerts = validate(scheduleLike, entriesLike, cfg, summer, teleworkCountsByUser);
```
With:
```ts
export async function runValidation(prisma: Prisma.TransactionClient, scheduleId: string): Promise<GeneratedAlert[]> {
  const schedule = await loadScheduleWithEntries(prisma, scheduleId);
  if (!schedule) throw new ScheduleServiceError(404, 'Schedule not found');

  const cfg = await loadValidationConfig(prisma, schedule.departmentId);
  const summer = await loadSummerForYear(prisma, schedule.year);

  const entriesLike: EntryLike[] = schedule.entries.map((e) => ({
    userId: e.userId,
    date: isoDate(e.date),
    status: e.status,
    onGuard: e.onGuard,
    startTime: e.startTime,
    endTime: e.endTime,
  }));

  const month = schedule.weekStart.getUTCMonth() + 1;
  const userIds = Array.from(new Set(entriesLike.map((e) => e.userId)));
  const teleworkCountsByUser: Record<string, number> = {};
  for (const uid of userIds) {
    teleworkCountsByUser[uid] = await countTeleworkThisMonth(prisma, uid, schedule.year, month);
  }
  const weeklyTargetsByUser = await loadWeeklyTargetHours(prisma, userIds, cfg.weeklyTargetNetHours);

  const scheduleLike: ScheduleLike = { id: schedule.id, weekStart: isoDate(schedule.weekStart), year: schedule.year };
  const alerts = validate(scheduleLike, entriesLike, cfg, summer, teleworkCountsByUser, weeklyTargetsByUser);
```
Add `loadWeeklyTargetHours` to the import at the top of `service.ts`:
```ts
import { loadScheduleWithEntries, countTeleworkThisMonth, loadDepartmentUsers, loadWeeklyTargetHours } from './queries.js';
```

- [ ] **Step 6: Update `buildScheduleView` — masking call, summary fields**

Replace the entries-masking loop body:
```ts
    for (const e of data.entriesReal) {
      entries[isoDate(e.date)] = maskEntryForViewer(
        { status: e.status, startTime: e.startTime, endTime: e.endTime, notes: e.notes, userId: e.userId },
        viewer,
      );
    }
```
With:
```ts
    for (const e of data.entriesReal) {
      entries[isoDate(e.date)] = maskEntryForViewer(
        { status: e.status, startTime: e.startTime, endTime: e.endTime, notes: e.notes, userId: e.userId, onGuard: e.onGuard },
        viewer,
      );
    }
```
Replace the aggregate block and `rows.push`:
```ts
    const travelDays = data.entriesReal.filter((e) => e.status === 'VIAJE').length;
    const guardDays = data.entriesReal.filter((e) => e.status === 'GUARDIA').length;
    const teleworkDaysMonth = await countTeleworkThisMonth(prisma, userId, schedule.year, month);

    rows.push({
      userId,
      username: data.username,
      entries,
      summary: { weeklyNetHours, teleworkDaysMonth, travelDays, guardDays },
    });
```
With:
```ts
    const travelDays = data.entriesReal.filter((e) => e.status === 'VIAJE').length;
    const guardDays = data.entriesReal.filter((e) => e.onGuard).length;
    const teleworkDaysWeek = data.entriesReal.filter((e) => e.status === 'TELETRABAJO').length;
    const teleworkDaysMonth = await countTeleworkThisMonth(prisma, userId, schedule.year, month);
    const weeklyTargetHours = weeklyTargetsByUser[userId] ?? cfg.weeklyTargetNetHours;

    rows.push({
      userId,
      username: data.username,
      entries,
      summary: { weeklyNetHours, teleworkDaysWeek, teleworkDaysMonth, travelDays, guardDays, weeklyTargetHours },
    });
```
Add the `weeklyTargetsByUser` lookup before the `for (const [userId, data] of byUser)` loop (right after `const month = ...` line):
```ts
  const month = schedule.weekStart.getUTCMonth() + 1;
  const weeklyTargetsByUser = await loadWeeklyTargetHours(prisma, Array.from(byUser.keys()), cfg.weeklyTargetNetHours);
```
Update the `ScheduleView` interface's row summary type:
```ts
    summary: { weeklyNetHours: number; teleworkDaysWeek: number; teleworkDaysMonth: number; travelDays: number; guardDays: number; weeklyTargetHours: number };
```

- [ ] **Step 7: Update `getMonthlySummary` guard-days count**

Replace:
```ts
    guardDays: count((s) => s === 'GUARDIA'),
```
With:
```ts
    guardDays: entries.filter((e) => e.onGuard).length,
```

- [ ] **Step 8: Run the full staff-schedule test suite**

```bash
podman exec cmdb-backend-prod npx jest staff-schedule
```
Expected: PASS. `auditTransaction.test.ts` uses mocked Prisma — verify it still compiles/mocks the new `department_id`/`onGuard` fields if it constructs literal entry objects; add the fields to any fixture object it builds if TypeScript complains.

- [ ] **Step 9: Commit**

```bash
git add backend/src/modules/staff-schedule/queries.ts backend/src/modules/staff-schedule/service.ts
git commit -m "feat(staff-schedule): onGuard-aware masking, weekly-hours-aware validation, cloneToWeek"
```

---

### Task 5: Router — clone endpoint, weekly-hours endpoint, WORKER-safe access

**Files:**
- Modify: `backend/src/modules/staff-schedule/router.ts`
- Modify: `backend/src/modules/staff-schedule/middleware.ts`

**Interfaces:**
- Consumes: `cloneToWeek` (Task 4), `CloneScheduleSchema`/`UserWeeklyHoursSchema` (Task 3).
- Produces: `POST /:id/clone` now requires `{ targetWeekStart }`; `PUT /users/:userId/weekly-hours` (ADMIN).

- [ ] **Step 1: Update imports and the clone endpoint**

In `backend/src/modules/staff-schedule/router.ts`, update the import block:
```ts
import {
  DepartmentSchema, DepartmentUpdateSchema,
  DeptConfigSchema,
  SummerSchema,
  ScheduleCreateSchema,
  EntriesUpdateSchema,
  ManagerAssignSchema,
  UserDeptAssignSchema,
  CloneScheduleSchema,
  UserWeeklyHoursSchema,
} from './schemas.js';
```
Update the `service.js` import:
```ts
import {
  createSchedule,
  updateEntries,
  runValidation,
  publish,
  unpublish,
  cloneToWeek,
  buildScheduleView,
  getMonthlySummary,
  ScheduleServiceError,
} from './service.js';
```
Replace the clone route:
```ts
  // POST /api/staff-schedule/:id/clone  (deptEdit) — clones entries to next week
  router.post('/:id/clone', requireUuidParam('id'), requireDeptEditAccess(prisma), async (req: Request, res: Response) => {
    try {
      const created = await prisma.$transaction(async (tx) => {
        const c = await cloneToNextWeek(tx, req.params.id as string, req.user!.email);
        await auditStaffSchedule(tx, { action: 'CLONE_STAFF_SCHEDULE', entity: 'STAFF_SCHEDULE', entityId: c.id, userEmail: req.user!.email });
        return c;
      }, { timeout: 20000 });
      res.status(201).json(created);
    } catch (err: any) {
      if (err?.code === 'P2002') { res.status(409).json({ error: 'A schedule already exists for the next week' }); return; }
      handleServiceError(err, res, 'clone');
    }
  });
```
With:
```ts
  // POST /api/staff-schedule/:id/clone  (deptEdit) — { targetWeekStart } clones
  // entries onto a caller-chosen future, empty Monday. Reused by "Import
  // previous week" (frontend calls this with scheduleId = previous week's
  // schedule and targetWeekStart = the currently-viewed week).
  router.post('/:id/clone', requireUuidParam('id'), requireDeptEditAccess(prisma), async (req: Request, res: Response) => {
    const parsed = CloneScheduleSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    try {
      const created = await prisma.$transaction(async (tx) => {
        const c = await cloneToWeek(tx, req.params.id as string, parsed.data.targetWeekStart, req.user!.email);
        await auditStaffSchedule(tx, { action: 'CLONE_STAFF_SCHEDULE', entity: 'STAFF_SCHEDULE', entityId: c.id, userEmail: req.user!.email });
        return c;
      }, { timeout: 20000 });
      res.status(201).json(created);
    } catch (err: any) {
      if (err?.code === 'P2002') { res.status(409).json({ error: 'A schedule already exists for the target week' }); return; }
      handleServiceError(err, res, 'clone');
    }
  });
```

- [ ] **Step 2: Add the weekly-hours endpoint**

Add right after the `PUT /users/:userId/department` route:
```ts
  // PUT /api/staff-schedule/users/:userId/weekly-hours  (ADMIN)  { weeklyTargetHours }
  router.put('/users/:userId/weekly-hours', requireAdmin, requireUuidParam('userId'), async (req: Request, res: Response) => {
    const parsed = UserWeeklyHoursSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }
    try {
      const user = await prisma.$transaction(async (tx) => {
        const u = await tx.user.update({
          where: { id: req.params.userId as string },
          data: { weeklyTargetHours: parsed.data.weeklyTargetHours },
          select: { id: true, username: true, weeklyTargetHours: true },
        });
        await auditStaffSchedule(tx, { action: 'SET_USER_WEEKLY_HOURS', entity: 'DEPARTMENT', entityId: req.params.userId as string, userEmail: req.user!.email });
        return u;
      });
      res.json(user);
    } catch (err: any) {
      if (err?.code === 'P2025') { res.status(404).json({ error: 'User not found' }); return; }
      console.error('[StaffSchedule] user weekly-hours update error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
```

- [ ] **Step 3: Allow `WORKER` through the module gate**

In `backend/src/modules/staff-schedule/middleware.ts`, replace:
```ts
// Block VIEWER role from the whole module (D12). AUDITOR gets read-only
// access (masked); manager/ADMIN get read+write per requireDeptEditAccess.
export function requireScheduleAccess(req: Request, res: Response, next: NextFunction): void {
  const role = (req as any).user?.role;
  if (!role || role === 'VIEWER') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
}
```
With:
```ts
// Block VIEWER role from the whole module (D12). AUDITOR/WORKER get
// read-only access (masked, all departments); manager/ADMIN get read+write
// per requireDeptEditAccess. WORKER is otherwise VIEWER-equivalent
// everywhere else in the app — this is the only module it can read (v3.5.9).
export function requireScheduleAccess(req: Request, res: Response, next: NextFunction): void {
  const role = (req as any).user?.role;
  if (!role || !['ADMIN', 'AUDITOR', 'WORKER'].includes(role)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
}
```

- [ ] **Step 4: Run the module test suite and `tsc`**

```bash
podman exec cmdb-backend-prod npx jest staff-schedule
cd backend && npx tsc --noEmit
```
Expected: tests PASS; `tsc` shows no new errors beyond the two documented pre-existing ones (license/licenseUser).

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/staff-schedule/router.ts backend/src/modules/staff-schedule/middleware.ts
git commit -m "feat(staff-schedule): clone-to-chosen-week endpoint, weekly-hours endpoint, WORKER read access"
```

---

### Task 6: Export (CSV/XLSX) — onGuard indicator, week/month telework split

**Files:**
- Modify: `backend/src/modules/staff-schedule/export.ts`

**Interfaces:**
- Consumes: `ScheduleView.rows[].summary.teleworkDaysWeek` (Task 4), `entry.onGuard` (Task 4).

- [ ] **Step 1: Update `cellText`, headers, and columns**

Replace the whole file body from `cellText` through the end of `exportScheduleCsv`:
```ts
function cellText(entry: ScheduleView['rows'][number]['entries'][string] | undefined): string {
  if (!entry) return '';
  const guard = entry.onGuard ? ' [GUARDIA]' : '';
  if (entry.startTime && entry.endTime) return `${entry.status} ${entry.startTime}-${entry.endTime}${guard}`;
  return `${entry.status}${guard}`;
}

function escapeCsv(v: string): string {
  return `"${v.replace(/"/g, '""')}"`;
}

export function exportScheduleCsv(view: ScheduleView): string {
  const header = ['Username', ...view.days, 'WeeklyNetHours', 'TeleworkDaysWeek', 'TeleworkDaysMonth', 'TravelDays', 'GuardDays'];
  const lines = view.rows.map((row) => {
    const cells = [
      row.username,
      ...view.days.map((d) => cellText(row.entries[d])),
      String(row.summary.weeklyNetHours),
      String(row.summary.teleworkDaysWeek),
      String(row.summary.teleworkDaysMonth),
      String(row.summary.travelDays),
      String(row.summary.guardDays),
    ];
    return cells.map(escapeCsv).join(',');
  });
  return [header.map(escapeCsv).join(','), ...lines].join('\r\n');
}
```
And update `exportScheduleXlsx`'s columns/row assembly:
```ts
  ws.columns = [
    { header: 'Username', key: 'username', width: 24 },
    ...view.days.map((d) => ({ header: d, key: d, width: 20 })),
    { header: 'WeeklyNetHours', key: 'weeklyNetHours', width: 16 },
    { header: 'TeleworkDaysWeek', key: 'teleworkDaysWeek', width: 16 },
    { header: 'TeleworkDaysMonth', key: 'teleworkDaysMonth', width: 18 },
    { header: 'TravelDays', key: 'travelDays', width: 12 },
    { header: 'GuardDays', key: 'guardDays', width: 12 },
  ];
  ws.getRow(1).font = { bold: true };

  for (const row of view.rows) {
    const wsRow: Record<string, unknown> = { username: row.username };
    for (const d of view.days) wsRow[d] = cellText(row.entries[d]);
    wsRow.weeklyNetHours = row.summary.weeklyNetHours;
    wsRow.teleworkDaysWeek = row.summary.teleworkDaysWeek;
    wsRow.teleworkDaysMonth = row.summary.teleworkDaysMonth;
    wsRow.travelDays = row.summary.travelDays;
    wsRow.guardDays = row.summary.guardDays;
    ws.addRow(wsRow);
  }
```

- [ ] **Step 2: Run `tsc` and commit**

```bash
cd backend && npx tsc --noEmit
git add backend/src/modules/staff-schedule/export.ts
git commit -m "feat(staff-schedule): export shows onGuard indicator and week/month telework columns"
```

---

### Task 7: WORKER role — backend wiring outside the module

**Files:**
- Modify: `backend/src/shared/types.ts`
- Modify: `backend/src/index.ts`
- Modify: `backend/src/modules/reports/types.ts`
- Modify: `backend/src/modules/reports/registry.ts`
- Modify: `backend/src/modules/internal/users.ts`

**Interfaces:**
- Produces: `UserRole` (shared) includes `'WORKER'`; reports `ROLE_RANK.WORKER === ROLE_RANK.VIEWER`.

- [ ] **Step 1: `shared/types.ts`**

```ts
export type UserRole = 'ADMIN' | 'AUDITOR' | 'VIEWER' | 'WORKER';
```

- [ ] **Step 2: `index.ts` role-change endpoint**

In `backend/src/index.ts`, replace:
```ts
  if (!role || !(['ADMIN', 'AUDITOR', 'VIEWER'] as string[]).includes(role)) {
    res.status(400).json({ error: 'role must be "ADMIN", "AUDITOR" or "VIEWER"' });
    return;
  }
```
With:
```ts
  if (!role || !(['ADMIN', 'AUDITOR', 'VIEWER', 'WORKER'] as string[]).includes(role)) {
    res.status(400).json({ error: 'role must be "ADMIN", "AUDITOR", "VIEWER" or "WORKER"' });
    return;
  }
```
The `UPDATE "users" SET role = ${role}::"UserRole"` cast a few lines below needs no change — it already accepts any value validated against the (now 4-value) enum.

- [ ] **Step 3: Reports `UserRole` and rank table**

`backend/src/modules/reports/types.ts`:
```ts
export type UserRole = 'ADMIN' | 'AUDITOR' | 'VIEWER' | 'WORKER';
```
`backend/src/modules/reports/registry.ts` — replace:
```ts
const ROLE_RANK: Record<UserRole, number> = { VIEWER: 1, AUDITOR: 2, ADMIN: 3 };
```
With:
```ts
// WORKER is VIEWER-equivalent everywhere except Staff Schedule (v3.5.9) —
// same rank so report access behaves identically to a VIEWER.
const ROLE_RANK: Record<UserRole, number> = { VIEWER: 1, WORKER: 1, AUDITOR: 2, ADMIN: 3 };
```

- [ ] **Step 4: Bulk-import role enum**

In `backend/src/modules/internal/users.ts`, replace:
```ts
  role:         z.enum(['ADMIN', 'AUDITOR', 'VIEWER']).default('VIEWER'),
```
With:
```ts
  role:         z.enum(['ADMIN', 'AUDITOR', 'VIEWER', 'WORKER']).default('VIEWER'),
```

- [ ] **Step 5: Run `tsc` and the full backend test suite**

```bash
cd backend && npx tsc --noEmit
podman exec cmdb-backend-prod npx jest
```
Expected: `tsc` clean (no new errors); all tests PASS. `Record<UserRole, number>` in `registry.ts` will fail to compile if `WORKER` is missing — this is the safety net that this step verifies.

- [ ] **Step 6: Commit**

```bash
git add backend/src/shared/types.ts backend/src/index.ts backend/src/modules/reports/types.ts backend/src/modules/reports/registry.ts backend/src/modules/internal/users.ts
git commit -m "feat(users): add WORKER role (VIEWER-equivalent, Staff Schedule read access)"
```

---

### Task 8: Frontend types + hooks — onGuard, week/month telework, weekly hours, clone/import, all-departments

**Files:**
- Modify: `frontend/app/staff-schedule/types.ts`
- Modify: `frontend/app/staff-schedule/hooks/useStaffSchedule.ts`

**Interfaces:**
- Produces: `EntryUpdateInput.onGuard`, `MaskedEntryFields.onGuard`, `ScheduleRow.summary.{teleworkDaysWeek,weeklyTargetHours}`, `useSchedule(...).clone(targetWeekStart)`, `useSchedule(...).importPreviousWeek()`, `useAllDepartmentsSchedules(weekStart)`.

- [ ] **Step 1: Update `types.ts`**

Replace `SCHEDULE_STATUS`:
```ts
export const SCHEDULE_STATUS = [
  "PRESENCIAL",
  "TELETRABAJO",
  "VACACIONES",
  "BAJA_MEDICA",
  "BAJA_PATERNIDAD",
  "INTENSIVO",
  "VIAJE",
  "AUSENTE",
] as const;
```
Replace `ALERT_TYPE`:
```ts
export const ALERT_TYPE = [
  "TELEWORK_QUOTA",
  "WEEKLY_HOURS",
  "DAILY_HOURS",
  "PRESENCE_PCT",
  "FLEX_RANGE",
  "GUARDIA_COVERAGE",
  "GUARDIA_UNIQUE",
  "BAJA_CONFLICT",
] as const;
```
Replace `MaskedEntryFields`:
```ts
export interface MaskedEntryFields {
  status: ScheduleStatus | string;
  onGuard: boolean;
  startTime: string | null;
  endTime: string | null;
  notes: string | null;
  healthMasked?: boolean;
}
```
Replace `ScheduleRow`:
```ts
export interface ScheduleRow {
  userId: string;
  username: string;
  entries: Record<string, MaskedEntryFields>;
  summary: {
    weeklyNetHours: number;
    weeklyTargetHours: number;
    teleworkDaysWeek: number;
    teleworkDaysMonth: number;
    travelDays: number;
    guardDays: number;
  };
}
```
Replace `EntryUpdateInput`:
```ts
export interface EntryUpdateInput {
  userId: string;
  date: string;
  status: ScheduleStatus;
  onGuard?: boolean;
  startTime?: string | null;
  endTime?: string | null;
  notes?: string | null;
}
```

- [ ] **Step 2: Update the `clone` action in `useSchedule`**

Replace:
```ts
  const clone = useCallback(async () => {
    if (!scheduleId) return;
    const res = await apiFetch(`/api/staff-schedule/${scheduleId}/clone`, { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Status ${res.status}`);
    }
  }, [scheduleId]);
```
With:
```ts
  const clone = useCallback(async (targetWeekStart: string) => {
    if (!scheduleId) return;
    const res = await apiFetch(`/api/staff-schedule/${scheduleId}/clone`, {
      method: "POST",
      body: JSON.stringify({ targetWeekStart }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Status ${res.status}`);
    }
  }, [scheduleId]);

  // Import the previous week's schedule (same department) onto the currently
  // viewed, empty week. Looks up the previous week's schedule id, then clones
  // it forward via the same endpoint used by the "Clone to week..." picker.
  const importPreviousWeek = useCallback(async () => {
    if (!departmentId) return;
    const prevWeekStart = addDaysIso(weekStart, -7);
    const listRes = await apiFetch(`/api/staff-schedule?departmentId=${departmentId}&weekStart=${prevWeekStart}`);
    if (!listRes.ok) throw new Error(`Status ${listRes.status}`);
    const list: StaffScheduleListItem[] = await listRes.json();
    const prev = list.find((s) => s.weekStart.slice(0, 10) === prevWeekStart);
    if (!prev) throw new Error("No schedule found for the previous week");
    const res = await apiFetch(`/api/staff-schedule/${prev.id}/clone`, {
      method: "POST",
      body: JSON.stringify({ targetWeekStart: weekStart }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Status ${res.status}`);
    }
    await load();
  }, [departmentId, weekStart, load]);
```
Update the hook's return statement to include `importPreviousWeek`:
```ts
  return {
    view,
    scheduleId,
    loading,
    error,
    notFound,
    refetch: load,
    createSchedule,
    saveEntries,
    validate,
    publish,
    unpublish,
    clone,
    importPreviousWeek,
  };
```

- [ ] **Step 3: Add `useAllDepartmentsSchedules`**

Add at the end of `useStaffSchedule.ts`:
```ts
/** Read-only view of every department's schedule for a given week ("Todos los departamentos"). */
export function useAllDepartmentsSchedules(weekStart: string) {
  const [entries, setEntries] = useState<{ department: { id: string; name: string }; view: ScheduleView }[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const listRes = await apiFetch(`/api/staff-schedule?weekStart=${weekStart}`);
      if (!listRes.ok) throw new Error(`Status ${listRes.status}`);
      const list: StaffScheduleListItem[] = await listRes.json();
      const matches = list.filter((s) => s.weekStart.slice(0, 10) === weekStart);
      const results = await Promise.all(
        matches.map(async (s) => {
          const r = await apiFetch(`/api/staff-schedule/${s.id}`);
          if (!r.ok) return null;
          const view: ScheduleView = await r.json();
          return { department: s.department, view };
        }),
      );
      setEntries(results.filter((r): r is { department: { id: string; name: string }; view: ScheduleView } => r !== null));
    } catch {
      setError("error");
    } finally {
      setLoading(false);
    }
  }, [weekStart]);

  useEffect(() => {
    load();
  }, [load]);

  return { entries, loading, error, refetch: load };
}
```

- [ ] **Step 4: Run the frontend type-check**

```bash
cd frontend && npx tsc --noEmit
```
Expected: fails until Tasks 9-11 update the components that consume these types — note the errors, they're the checklist for the next tasks. (If run in isolation before those tasks, expect errors in `ScheduleEntryPopover.tsx`, `ScheduleCell.tsx`, `StaffScheduleCalendar.tsx`, `page.tsx` — proceed to Task 9.)

- [ ] **Step 5: Commit**

```bash
git add frontend/app/staff-schedule/types.ts frontend/app/staff-schedule/hooks/useStaffSchedule.ts
git commit -m "feat(staff-schedule): frontend types/hooks for onGuard, clone-to-week, import-previous-week, all-departments"
```

---

### Task 9: Frontend — ScheduleEntryPopover (onGuard checkbox, auto-fill exit time, apply-to-week)

**Files:**
- Modify: `frontend/components/staff-schedule/ScheduleEntryPopover.tsx`

**Interfaces:**
- Consumes: `EntryUpdateInput.onGuard` (Task 8).
- Produces: new props `breakMinutes: number`, `dailyNetHours: number`, `onApplyWeek: (partial: Omit<EntryUpdateInput, "date">) => Promise<void>`.

- [ ] **Step 1: Add the new props and onGuard/auto-fill/apply-week logic**

Replace the whole file:
```tsx
"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { SCHEDULE_STATUS, type EntryUpdateInput, type MaskedEntryFields, type ScheduleStatus } from "@/app/staff-schedule/types";

interface Props {
  userId: string;
  username: string;
  date: string;
  entry: MaskedEntryFields | undefined;
  breakMinutes: number;
  dailyNetHours: number;
  onClose: () => void;
  onSave: (entry: EntryUpdateInput) => Promise<void>;
  onApplyWeek: (partial: Omit<EntryUpdateInput, "date">) => Promise<void>;
}

const NON_WORKING_STATUSES = new Set(["VACACIONES", "BAJA_MEDICA", "BAJA_PATERNIDAD", "AUSENTE", "VIAJE"]);

export default function ScheduleEntryPopover({
  userId, username, date, entry, breakMinutes, dailyNetHours, onClose, onSave, onApplyWeek,
}: Props) {
  const { t } = useLanguage();
  const [status, setStatus] = useState<ScheduleStatus>((entry?.status as ScheduleStatus) ?? "PRESENCIAL");
  const [onGuard, setOnGuard] = useState(entry?.onGuard ?? false);
  const [startTime, setStartTime] = useState(entry?.startTime ?? "");
  const [endTime, setEndTime] = useState(entry?.endTime ?? "");
  const [notes, setNotes] = useState(entry?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-fill the exit time from the entry time + the department's daily net
  // hours + break, once the worker tabs out of the entry-time field. Never
  // overwrites an exit time the user already set, and skips non-working
  // statuses (vacation, leave, travel, absent) where times aren't meaningful.
  const handleStartTimeBlur = () => {
    if (!startTime || endTime || NON_WORKING_STATUSES.has(status)) return;
    const [h, m] = startTime.split(":").map(Number);
    const totalMinutes = h * 60 + m + Math.round(dailyNetHours * 60) + breakMinutes;
    const endH = Math.floor(totalMinutes / 60) % 24;
    const endM = totalMinutes % 60;
    setEndTime(`${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}`);
  };

  const buildPayload = () => ({
    status,
    onGuard,
    startTime: startTime || null,
    endTime: endTime || null,
    notes: notes || null,
  });

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave({ userId, date, ...buildPayload() });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "error");
    } finally {
      setSaving(false);
    }
  };

  const handleApplyWeek = async () => {
    setApplying(true);
    setError(null);
    try {
      await onApplyWeek({ userId, ...buildPayload() });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "error");
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4" onClick={onClose}>
      <div
        className="w-full max-w-sm bg-white shadow-sm ring-1 ring-slate-200 rounded-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
          <div>
            <p className="text-sm font-semibold text-slate-900">{username}</p>
            <p className="text-xs text-slate-500">{date}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              {t("staffSchedule.entry.status")}
            </label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as ScheduleStatus)}
              className="w-full rounded-none border border-slate-300 px-2.5 py-2 text-sm"
            >
              {SCHEDULE_STATUS.map((s) => (
                <option key={s} value={s}>
                  {t(`staffSchedule.status.${s}`)}
                </option>
              ))}
            </select>
          </div>

          <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
            <input
              type="checkbox"
              checked={onGuard}
              onChange={(e) => setOnGuard(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            {t("staffSchedule.entry.onGuard")}
          </label>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">{t("staffSchedule.entry.startTime")}</label>
              <input
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                onBlur={handleStartTimeBlur}
                className="w-full rounded-none border border-slate-300 px-2.5 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">{t("staffSchedule.entry.endTime")}</label>
              <input
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className="w-full rounded-none border border-slate-300 px-2.5 py-2 text-sm"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">{t("staffSchedule.entry.notes")}</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full rounded-none border border-slate-300 px-2.5 py-2 text-sm"
            />
          </div>

          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3.5">
          <button
            onClick={onClose}
            className="rounded-none border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            {t("actions.cancel")}
          </button>
          <button
            onClick={handleApplyWeek}
            disabled={applying || saving}
            title={t("staffSchedule.entry.applyWeekHint")}
            className="rounded-none border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            {t("staffSchedule.action.applyWeek")}
          </button>
          <button
            onClick={handleSave}
            disabled={saving || applying}
            className="rounded-none bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-white hover:bg-[var(--accent)]/90 shadow-sm disabled:opacity-50"
          >
            {t("staffSchedule.action.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/components/staff-schedule/ScheduleEntryPopover.tsx
git commit -m "feat(staff-schedule): onGuard checkbox, exit-time autofill, apply-to-week in entry popover"
```

---

### Task 10: Frontend — ScheduleCell, StaffScheduleCalendar (readOnly, onGuard badge, week/month telework)

**Files:**
- Modify: `frontend/components/staff-schedule/ScheduleCell.tsx`
- Modify: `frontend/components/staff-schedule/StaffScheduleCalendar.tsx`

**Interfaces:**
- Consumes: `MaskedEntryFields.onGuard`, `ScheduleRow.summary.{teleworkDaysWeek,weeklyTargetHours}` (Task 8), `onApplyWeek` (Task 9).
- Produces: `StaffScheduleCalendar` props `readOnly?: boolean`, `onSaveEntries?: (entries: EntryUpdateInput[]) => Promise<void>`, `departmentConfig: DepartmentScheduleConfig | null`.

- [ ] **Step 1: `ScheduleCell.tsx` — onGuard badge**

Replace the returned `<td>` for a present entry:
```tsx
  return (
    <td className="border border-slate-100 p-1 align-top">
      <button
        type="button"
        onClick={editable ? onClick : undefined}
        disabled={!editable}
        title={entry.healthMasked ? t("staffSchedule.gdpr.maskedNotice") : undefined}
        className={`w-full min-h-[3.5rem] rounded-none px-2 py-1.5 text-left text-xs ${meta.bg} ${meta.text} ${editable ? "hover:opacity-80 cursor-pointer" : "cursor-default"}`}
      >
        <span className="flex items-center gap-1 font-semibold">
          {t(`staffSchedule.status.${entry.status as ScheduleStatus}`)}
          {entry.healthMasked && <Lock className="h-3 w-3 shrink-0" />}
        </span>
        {entry.startTime && entry.endTime && (
          <span className="block mt-0.5 text-[11px] opacity-80">
            {entry.startTime}–{entry.endTime}
          </span>
        )}
      </button>
    </td>
  );
```
With:
```tsx
  return (
    <td className="border border-slate-100 p-1 align-top">
      <button
        type="button"
        onClick={editable ? onClick : undefined}
        disabled={!editable}
        title={entry.healthMasked ? t("staffSchedule.gdpr.maskedNotice") : undefined}
        className={`w-full min-h-[3.5rem] rounded-none px-2 py-1.5 text-left text-xs ${meta.bg} ${meta.text} ${editable ? "hover:opacity-80 cursor-pointer" : "cursor-default"}`}
      >
        <span className="flex items-center gap-1 font-semibold">
          {t(`staffSchedule.status.${entry.status as ScheduleStatus}`)}
          {entry.onGuard && (
            <span className="rounded-none bg-yellow-500 px-1 text-[10px] font-bold text-white" title={t("staffSchedule.entry.onGuard")}>
              G
            </span>
          )}
          {entry.healthMasked && <Lock className="h-3 w-3 shrink-0" />}
        </span>
        {entry.startTime && entry.endTime && (
          <span className="block mt-0.5 text-[11px] opacity-80">
            {entry.startTime}–{entry.endTime}
          </span>
        )}
      </button>
    </td>
  );
```
Also remove the now-unused `GUARDIA` entry from `STATUS_META` (GUARDIA is no longer a status value):
```ts
export const STATUS_META: Record<string, { bg: string; text: string }> = {
  PRESENCIAL: { bg: "bg-blue-100", text: "text-blue-800" },
  TELETRABAJO: { bg: "bg-green-100", text: "text-green-800" },
  VACACIONES: { bg: "bg-orange-100", text: "text-orange-800" },
  BAJA_MEDICA: { bg: "bg-red-100", text: "text-red-800" },
  BAJA_PATERNIDAD: { bg: "bg-emerald-200", text: "text-emerald-900" },
  INTENSIVO: { bg: "bg-purple-100", text: "text-purple-800" },
  VIAJE: { bg: "bg-cyan-100", text: "text-cyan-800" },
  AUSENTE: { bg: "bg-slate-100", text: "text-slate-600" },
};
```

- [ ] **Step 2: `StaffScheduleCalendar.tsx` — readOnly, onSaveEntries, week/month telework, break/dailyNetHours for the popover**

Replace the whole file:
```tsx
"use client";

import { useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import type { DepartmentScheduleConfig, EntryUpdateInput, ScheduleView } from "@/app/staff-schedule/types";
import ScheduleCell from "./ScheduleCell";
import ScheduleEntryPopover from "./ScheduleEntryPopover";

interface Props {
  view: ScheduleView;
  departmentConfig: DepartmentScheduleConfig | null;
  onSaveEntry: (entry: EntryUpdateInput) => Promise<void>;
  onSaveEntries: (entries: EntryUpdateInput[]) => Promise<void>;
  readOnly?: boolean;
}

export default function StaffScheduleCalendar({ view, departmentConfig, onSaveEntry, onSaveEntries, readOnly }: Props) {
  const { t } = useLanguage();
  const [editing, setEditing] = useState<{ userId: string; username: string; date: string } | null>(null);

  const editable = !readOnly && view.canEdit && view.schedule.status === "DRAFT";

  const breakMinutes = view.schedule.isSummerWeek
    ? (departmentConfig?.summerBreakMinutes ?? 30)
    : (departmentConfig?.winterBreakMinutes ?? 60);

  const formatDay = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
      timeZone: "UTC",
    });

  const editingRow = editing ? view.rows.find((r) => r.userId === editing.userId) : undefined;
  const dailyNetHours = editingRow ? editingRow.summary.weeklyTargetHours / 5 : 8;

  return (
    <div className="bg-white shadow-sm ring-1 ring-slate-200 overflow-auto max-h-[70vh]">
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 z-20 bg-slate-50">
          <tr>
            <th className="sticky left-0 z-30 bg-slate-50 border border-slate-100 px-3 py-2 text-left text-xs font-semibold text-slate-600 min-w-[10rem]">
              {t("staffSchedule.calendar.person")}
            </th>
            {view.days.map((d) => (
              <th key={d} className="border border-slate-100 px-2 py-2 text-center text-xs font-semibold text-slate-600 min-w-[9rem]">
                {formatDay(d)}
              </th>
            ))}
            <th className="border border-slate-100 px-3 py-2 text-center text-xs font-semibold text-slate-600 min-w-[10rem]">
              {t("staffSchedule.summary.weeklyHours")}
            </th>
          </tr>
        </thead>
        <tbody>
          {view.rows.map((row) => (
            <tr key={row.userId}>
              <td className="sticky left-0 z-10 bg-white border border-slate-100 px-3 py-2 text-xs font-medium text-slate-800">
                {row.username}
              </td>
              {view.days.map((d) => (
                <ScheduleCell
                  key={d}
                  entry={row.entries[d]}
                  editable={editable}
                  onClick={() => setEditing({ userId: row.userId, username: row.username, date: d })}
                />
              ))}
              <td className="border border-slate-100 px-3 py-2 text-xs text-slate-600">
                <div>{t("staffSchedule.summary.weeklyHours")}: {row.summary.weeklyNetHours.toFixed(1)}h / {row.summary.weeklyTargetHours.toFixed(1)}h</div>
                <div>{t("staffSchedule.summary.teleworkDaysWeek")}: {row.summary.teleworkDaysWeek}</div>
                <div>{t("staffSchedule.summary.teleworkDaysMonth")}: {row.summary.teleworkDaysMonth}</div>
                <div>{t("staffSchedule.summary.travelDays")}: {row.summary.travelDays}</div>
                <div>{t("staffSchedule.summary.guardDays")}: {row.summary.guardDays}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {editing && (
        <ScheduleEntryPopover
          userId={editing.userId}
          username={editing.username}
          date={editing.date}
          entry={view.rows.find((r) => r.userId === editing.userId)?.entries[editing.date]}
          breakMinutes={breakMinutes}
          dailyNetHours={dailyNetHours}
          onClose={() => setEditing(null)}
          onSave={onSaveEntry}
          onApplyWeek={async (partial) => {
            const entries: EntryUpdateInput[] = view.days.map((d) => ({ date: d, ...partial }));
            await onSaveEntries(entries);
          }}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/components/staff-schedule/ScheduleCell.tsx frontend/components/staff-schedule/StaffScheduleCalendar.tsx
git commit -m "feat(staff-schedule): readOnly calendar mode, onGuard badge, week/month telework display"
```

---

### Task 11: Frontend — WeekTargetPicker and clone/import-previous-week UX in page.tsx

**Files:**
- Create: `frontend/components/staff-schedule/WeekTargetPicker.tsx`
- Modify: `frontend/app/staff-schedule/page.tsx`

**Interfaces:**
- Consumes: `mondayOf`, `addDaysIso` (existing, `hooks/useStaffSchedule.ts`), `clone(targetWeekStart)` / `importPreviousWeek()` (Task 8).
- Produces: `WeekTargetPicker` modal component.

- [ ] **Step 1: Create `WeekTargetPicker.tsx`**

```tsx
"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { mondayOf } from "@/app/staff-schedule/hooks/useStaffSchedule";

interface Props {
  onClose: () => void;
  onConfirm: (targetWeekStart: string) => Promise<void>;
}

export default function WeekTargetPicker({ onClose, onConfirm }: Props) {
  const { t } = useLanguage();
  const [date, setDate] = useState(() => {
    const nextMonday = new Date();
    nextMonday.setDate(nextMonday.getDate() + 7);
    return mondayOf(nextMonday);
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async () => {
    setSaving(true);
    setError(null);
    try {
      await onConfirm(mondayOf(new Date(`${date}T00:00:00Z`)));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4" onClick={onClose}>
      <div className="w-full max-w-sm bg-white shadow-sm ring-1 ring-slate-200 rounded-none" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
          <p className="text-sm font-semibold text-slate-900">{t("staffSchedule.clone.pickWeek")}</p>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3 px-5 py-4">
          <label className="block text-xs font-medium text-slate-600 mb-1">{t("staffSchedule.clone.targetWeek")}</label>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full rounded-none border border-slate-300 px-2.5 py-2 text-sm"
          />
          <p className="text-xs text-slate-500">{t("staffSchedule.clone.mustBeFutureEmpty")}</p>
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3.5">
          <button
            onClick={onClose}
            className="rounded-none border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            {t("actions.cancel")}
          </button>
          <button
            onClick={handleConfirm}
            disabled={saving}
            className="rounded-none bg-[var(--accent)] px-4 py-2 text-xs font-semibold text-white hover:bg-[var(--accent)]/90 shadow-sm disabled:opacity-50"
          >
            {t("staffSchedule.action.clone")}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire it into `page.tsx`**

Replace the `handleClone` function and the Clone button, and add the "import previous week" button. First, update the imports:
```tsx
import { useCallback, useState } from "react";
import { RefreshCw, AlertTriangle, Settings, Copy, Download, CheckCircle2, Lock, Unlock, FileDown } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { useDepartments, useSchedule, useScheduleExport, useDepartmentConfig, mondayOf } from "./hooks/useStaffSchedule";
import type { EntryUpdateInput } from "./types";
import WeekSelector from "@/components/staff-schedule/WeekSelector";
import DepartmentFilter from "@/components/staff-schedule/DepartmentFilter";
import StaffScheduleCalendar from "@/components/staff-schedule/StaffScheduleCalendar";
import AlertPanel from "@/components/staff-schedule/AlertPanel";
import ScheduleConfigPanel from "@/components/staff-schedule/ScheduleConfigPanel";
import WeekTargetPicker from "@/components/staff-schedule/WeekTargetPicker";
import AllDepartmentsView from "@/components/staff-schedule/AllDepartmentsView";
```
Add `useDepartmentConfig(departmentId)` and a `showClonePicker` state right after the existing state declarations:
```tsx
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [weekStart, setWeekStart] = useState(() => mondayOf(new Date()));
  const [showConfig, setShowConfig] = useState(false);
  const [showClonePicker, setShowClonePicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const { departments, loading: deptLoading, refetch: refetchDepartments } = useDepartments();
  const { config: departmentConfig } = useDepartmentConfig(departmentId);
  const {
    view,
    loading,
    error,
    notFound,
    createSchedule,
    saveEntries,
    validate,
    publish,
    unpublish,
    clone,
    importPreviousWeek,
  } = useSchedule(departmentId, weekStart);
```
Replace `handleClone`:
```tsx
  const handleClone = () => setShowClonePicker(true);

  const handleCloneConfirm = (targetWeekStart: string) => runAction(async () => {
    await clone(targetWeekStart);
  });

  const handleImportPreviousWeek = () => runAction(importPreviousWeek);
```
In the JSX, replace the existing Clone button:
```tsx
                {canEdit && (
                  <button
                    onClick={handleClone}
                    disabled={busy}
                    className="rounded-none border border-slate-300 bg-white px-3 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 flex items-center gap-1.5 disabled:opacity-50"
                  >
                    <Copy className="h-4 w-4" /> {t("staffSchedule.action.clone")}
                  </button>
                )}
```
With the same block unchanged (it still opens the picker) — no diff needed there since `handleClone` now just opens the modal.
Add the "import previous week" button in the `notFound` block:
```tsx
        {departmentId && !loading && notFound && (
          <div className="bg-white shadow-sm ring-1 ring-slate-200 p-8 text-center space-y-3">
            <p className="text-sm text-slate-500">{t("staffSchedule.empty.noSchedule")}</p>
            <div className="flex items-center justify-center gap-2">
              <button
                onClick={() => runAction(createSchedule)}
                disabled={busy}
                className="rounded-none bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[var(--accent)]/90 shadow-sm disabled:opacity-50"
              >
                {t("staffSchedule.empty.createSchedule")}
              </button>
              <button
                onClick={handleImportPreviousWeek}
                disabled={busy}
                className="rounded-none border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 flex items-center gap-1.5 disabled:opacity-50"
              >
                <FileDown className="h-4 w-4" /> {t("staffSchedule.empty.importPreviousWeek")}
              </button>
            </div>
          </div>
        )}
```
Replace the "no department selected" placeholder block to render the read-only all-departments view instead:
```tsx
        {!departmentId && (
          <AllDepartmentsView weekStart={weekStart} />
        )}
```
Update `StaffScheduleCalendar` usage to pass the new props:
```tsx
        {view && (
          <div className="grid grid-cols-1 xl:grid-cols-[1fr_20rem] gap-6 items-start">
            <StaffScheduleCalendar
              view={view}
              departmentConfig={departmentConfig}
              onSaveEntry={handleSaveEntry}
              onSaveEntries={saveEntries}
            />
            <AlertPanel
              alerts={view.alerts}
              canEdit={canEdit && status === "DRAFT"}
              onRevalidate={() => runAction(validate)}
              revalidating={busy}
              usernameByUserId={usernameByUserId}
            />
          </div>
        )}
```
Add the picker modal at the end, alongside the config modal:
```tsx
      {showConfig && (
        <ScheduleConfigPanel
          departments={departments}
          onClose={() => setShowConfig(false)}
          onDepartmentsChanged={refetchDepartments}
        />
      )}
      {showClonePicker && (
        <WeekTargetPicker
          onClose={() => setShowClonePicker(false)}
          onConfirm={handleCloneConfirm}
        />
      )}
```

- [ ] **Step 3: Run the frontend type-check**

```bash
cd frontend && npx tsc --noEmit
```
Expected: fails until Task 12 creates `AllDepartmentsView` — proceed to Task 12, then re-run.

- [ ] **Step 4: Commit**

```bash
git add frontend/components/staff-schedule/WeekTargetPicker.tsx frontend/app/staff-schedule/page.tsx
git commit -m "feat(staff-schedule): clone-to-chosen-week picker and import-previous-week button"
```

---

### Task 12: Frontend — AllDepartmentsView (read-only "Todos los departamentos")

**Files:**
- Create: `frontend/components/staff-schedule/AllDepartmentsView.tsx`

**Interfaces:**
- Consumes: `useAllDepartmentsSchedules(weekStart)` (Task 8), `StaffScheduleCalendar` with `readOnly` (Task 10).

- [ ] **Step 1: Create the component**

```tsx
"use client";

import { RefreshCw, AlertTriangle } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAllDepartmentsSchedules } from "@/app/staff-schedule/hooks/useStaffSchedule";
import StaffScheduleCalendar from "./StaffScheduleCalendar";

interface Props {
  weekStart: string;
}

// Read-only aggregate of every department's schedule for the given week.
// Editing always requires picking a single department (row-level
// authorization and the write endpoints are per-department) — this view is
// deliberately view-only, per product decision.
export default function AllDepartmentsView({ weekStart }: Props) {
  const { t } = useLanguage();
  const { entries, loading, error } = useAllDepartmentsSchedules(weekStart);

  if (loading) {
    return (
      <div className="bg-white shadow-sm ring-1 ring-slate-200 p-8 flex items-center justify-center gap-3 text-slate-500 text-sm">
        <RefreshCw className="h-4 w-4 animate-spin" />
        {t("common.loading")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        {t("common.unknown_error")}
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="bg-white shadow-sm ring-1 ring-slate-200 p-8 text-center text-sm text-slate-500">
        {t("staffSchedule.empty.noSchedule")}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {entries.map(({ department, view }) => (
        <div key={department.id} className="space-y-2">
          <h2 className="text-sm font-bold text-slate-900">{department.name}</h2>
          <StaffScheduleCalendar
            view={view}
            departmentConfig={null}
            onSaveEntry={async () => {}}
            onSaveEntries={async () => {}}
            readOnly
          />
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Run the frontend type-check**

```bash
cd frontend && npx tsc --noEmit
```
Expected: clean (no new errors).

- [ ] **Step 3: Commit**

```bash
git add frontend/components/staff-schedule/AllDepartmentsView.tsx
git commit -m "feat(staff-schedule): read-only all-departments week view"
```

---

### Task 13: Frontend — WORKER role wiring (AuthContext, Sidebar, settings, reports types)

**Files:**
- Modify: `frontend/contexts/AuthContext.tsx`
- Modify: `frontend/components/Sidebar.tsx`
- Modify: `frontend/app/settings/page.tsx`
- Modify: `frontend/app/reports/types/report.ts`

**Interfaces:**
- Produces: `UserRole` (frontend, both locations) includes `'WORKER'`; Sidebar shows Horarios de Personal to `WORKER`; settings page can assign `WORKER`.

- [ ] **Step 1: `AuthContext.tsx`**

Read the file first to confirm the exact surrounding lines, then change line 14:
```ts
export type UserRole = "ADMIN" | "AUDITOR" | "VIEWER";
```
To:
```ts
export type UserRole = "ADMIN" | "AUDITOR" | "VIEWER" | "WORKER";
```
No other change needed in this file — `isAdmin` stays `user?.role === "ADMIN"` (WORKER must not get admin powers).

- [ ] **Step 2: `Sidebar.tsx` — menu roles and badge color**

Replace:
```tsx
  { type: "link", labelKey: "sidebar.staffSchedule",    href: "/staff-schedule", icon: CalendarDays, roles: ["ADMIN","AUDITOR"]  },
```
With:
```tsx
  { type: "link", labelKey: "sidebar.staffSchedule",    href: "/staff-schedule", icon: CalendarDays, roles: ["ADMIN","AUDITOR","WORKER"]  },
```
Replace the role-badge color block:
```tsx
                user.role === "ADMIN"   ? "bg-red-900/60 text-red-300"    :
                user.role === "AUDITOR" ? "bg-amber-900/60 text-amber-300" :
```
With:
```tsx
                user.role === "ADMIN"   ? "bg-red-900/60 text-red-300"    :
                user.role === "AUDITOR" ? "bg-amber-900/60 text-amber-300" :
                user.role === "WORKER"  ? "bg-sky-900/60 text-sky-300"    :
```
(Verify the fallback branch after these — for VIEWER — is unaffected; keep it as the final `:` else-branch.)

- [ ] **Step 3: `frontend/app/settings/page.tsx` — role type and select option**

Read the file around lines 20-25, 143-160, and 550-562 first, then apply:
- Line 22 type: `"ADMIN" | "AUDITOR" | "VIEWER"` → `"ADMIN" | "AUDITOR" | "VIEWER" | "WORKER"`
- Line 144 `handleRoleChange` param type: same union update
- Line 555 `onChange` cast: same union update
- After the `<option value="VIEWER">` line, add:
```tsx
                                <option value="WORKER">{t('settings.users.role_worker')}</option>
```

- [ ] **Step 4: `frontend/app/reports/types/report.ts`**

```ts
export type UserRole = 'ADMIN' | 'AUDITOR' | 'VIEWER' | 'WORKER';
```

- [ ] **Step 5: Run the frontend type-check**

```bash
cd frontend && npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/contexts/AuthContext.tsx frontend/components/Sidebar.tsx frontend/app/settings/page.tsx frontend/app/reports/types/report.ts
git commit -m "feat(users): WORKER role in frontend — sidebar access, role badge, admin assignment"
```

---

### Task 14: Frontend — ScheduleConfigPanel (per-user weekly hours)

**Files:**
- Modify: `frontend/components/staff-schedule/ScheduleConfigPanel.tsx`

**Interfaces:**
- Consumes: `PUT /api/staff-schedule/users/:userId/weekly-hours` (Task 5).

- [ ] **Step 1: Add a weekly-hours field to the user-department assignment section**

Add state near the other `assign*` state declarations:
```tsx
  const [assignWeeklyHours, setAssignWeeklyHours] = useState("");
  const [weeklyHoursError, setWeeklyHoursError] = useState<string | null>(null);
  const [weeklyHoursSaving, setWeeklyHoursSaving] = useState(false);
```
Add a handler near `handleAssignUserDept`:
```tsx
  const handleSetWeeklyHours = async () => {
    if (!assignUserId) return;
    setWeeklyHoursError(null);
    setWeeklyHoursSaving(true);
    try {
      const res = await apiFetch(`/api/staff-schedule/users/${assignUserId}/weekly-hours`, {
        method: "PUT",
        body: JSON.stringify({ weeklyTargetHours: assignWeeklyHours === "" ? null : Number(assignWeeklyHours) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Status ${res.status}`);
      }
      setAssignWeeklyHours("");
    } catch (e) {
      setWeeklyHoursError(e instanceof Error ? e.message : "error");
    } finally {
      setWeeklyHoursSaving(false);
    }
  };
```
In the JSX, replace the "User → department assignment" section's inner `<div>` to add the hours input and its save button:
```tsx
          {/* User → department assignment */}
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-900">{t("staffSchedule.action.assignDepartment")}</h3>
            <div className="flex items-center gap-2">
              <select
                value={assignUserId}
                onChange={(e) => setAssignUserId(e.target.value)}
                className="flex-1 rounded-none border border-slate-300 px-2.5 py-2 text-sm"
              >
                <option value="">{t("staffSchedule.manager.selectUser")}</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.username} ({u.email})
                  </option>
                ))}
              </select>
              <select
                value={assignDeptId}
                onChange={(e) => setAssignDeptId(e.target.value)}
                className="rounded-none border border-slate-300 px-2.5 py-2 text-sm min-w-[10rem]"
              >
                <option value="">{t("staffSchedule.department.none")}</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={handleAssignUserDept}
                disabled={!assignUserId}
                className="rounded-none bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-white hover:bg-[var(--accent)]/90 shadow-sm disabled:opacity-50"
              >
                {t("staffSchedule.action.save")}
              </button>
            </div>
            {managersError && <p className="text-xs text-red-600">{managersError}</p>}

            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-slate-600 min-w-[10rem]">
                {t("staffSchedule.config.weeklyHoursOverride")}
              </label>
              <input
                type="number"
                min={0}
                max={80}
                step={0.5}
                placeholder={t("staffSchedule.config.weeklyHoursDefault")}
                value={assignWeeklyHours}
                onChange={(e) => setAssignWeeklyHours(e.target.value)}
                className="w-32 rounded-none border border-slate-300 px-2.5 py-2 text-sm"
              />
              <button
                type="button"
                onClick={handleSetWeeklyHours}
                disabled={!assignUserId || weeklyHoursSaving}
                className="rounded-none border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                {t("staffSchedule.action.save")}
              </button>
            </div>
            {weeklyHoursError && <p className="text-xs text-red-600">{weeklyHoursError}</p>}
          </section>
```

- [ ] **Step 2: Run the frontend type-check and commit**

```bash
cd frontend && npx tsc --noEmit
git add frontend/components/staff-schedule/ScheduleConfigPanel.tsx
git commit -m "feat(staff-schedule): per-user weekly hours override in config panel"
```

---

### Task 15: i18n — add all new keys to the 6 locale files

**Files:**
- Modify: `frontend/locales/en.json`, `frontend/locales/es.json`, `frontend/locales/de.json`, `frontend/locales/pt.json`, `frontend/locales/fr.json`, `frontend/locales/it.json`

**Interfaces:**
- Consumes: every `t("staffSchedule.*")` / `t("settings.users.role_worker")` call added in Tasks 9-14.

- [ ] **Step 1: Remove the now-orphaned `GUARDIA` status key and add new keys under `staffSchedule`**

For each of the 6 locale files, under the `staffSchedule` object:
- In `status`: remove the `"GUARDIA": "..."` entry (GUARDIA is no longer a status value).
- In `summary`: replace `"teleworkDays": "..."` with `"teleworkDaysWeek": "..."` and `"teleworkDaysMonth": "..."`.
- In `entry`: add `"onGuard": "..."`.
- In `action`: add `"applyWeek": "..."`.
- In `alert`: add `"GUARDIA_UNIQUE": "..."`.
- Add new top-level `staffSchedule.clone` object: `{ "pickWeek": "...", "targetWeek": "...", "mustBeFutureEmpty": "..." }`.
- In `empty`: add `"importPreviousWeek": "..."`.
- In `config`: add `"weeklyHoursOverride": "..."` and `"weeklyHoursDefault": "..."`.

Exact values per locale:

**es.json:**
```json
"entry": { "onGuard": "De guardia" },
"action": { "applyWeek": "Aplicar a toda la semana" },
"summary": { "teleworkDaysWeek": "Teletrabajo (semana)", "teleworkDaysMonth": "Teletrabajo (mes acumulado)" },
"alert": { "GUARDIA_UNIQUE": "Más de un trabajador de guardia el mismo día" },
"clone": { "pickWeek": "Elegir semana destino", "targetWeek": "Semana destino", "mustBeFutureEmpty": "Debe ser una semana futura sin calendario existente" },
"empty": { "importPreviousWeek": "Importar semana anterior" },
"config": { "weeklyHoursOverride": "Horas semanales (trabajador)", "weeklyHoursDefault": "Por defecto (departamento)" }
```

**en.json:**
```json
"entry": { "onGuard": "On guard" },
"action": { "applyWeek": "Apply to whole week" },
"summary": { "teleworkDaysWeek": "Telework (week)", "teleworkDaysMonth": "Telework (month total)" },
"alert": { "GUARDIA_UNIQUE": "More than one worker on guard the same day" },
"clone": { "pickWeek": "Choose target week", "targetWeek": "Target week", "mustBeFutureEmpty": "Must be a future week with no existing schedule" },
"empty": { "importPreviousWeek": "Import previous week" },
"config": { "weeklyHoursOverride": "Weekly hours (worker)", "weeklyHoursDefault": "Department default" }
```

**de.json:**
```json
"entry": { "onGuard": "Bereitschaftsdienst" },
"action": { "applyWeek": "Auf die ganze Woche anwenden" },
"summary": { "teleworkDaysWeek": "Homeoffice (Woche)", "teleworkDaysMonth": "Homeoffice (Monat gesamt)" },
"alert": { "GUARDIA_UNIQUE": "Mehr als ein Mitarbeiter am selben Tag im Bereitschaftsdienst" },
"clone": { "pickWeek": "Zielwoche auswählen", "targetWeek": "Zielwoche", "mustBeFutureEmpty": "Muss eine zukünftige Woche ohne bestehenden Zeitplan sein" },
"empty": { "importPreviousWeek": "Vorherige Woche importieren" },
"config": { "weeklyHoursOverride": "Wochenstunden (Mitarbeiter)", "weeklyHoursDefault": "Abteilungsstandard" }
```

**pt.json:**
```json
"entry": { "onGuard": "De plantão" },
"action": { "applyWeek": "Aplicar à semana inteira" },
"summary": { "teleworkDaysWeek": "Teletrabalho (semana)", "teleworkDaysMonth": "Teletrabalho (total do mês)" },
"alert": { "GUARDIA_UNIQUE": "Mais de um trabalhador de plantão no mesmo dia" },
"clone": { "pickWeek": "Escolher semana de destino", "targetWeek": "Semana de destino", "mustBeFutureEmpty": "Deve ser uma semana futura sem calendário existente" },
"empty": { "importPreviousWeek": "Importar semana anterior" },
"config": { "weeklyHoursOverride": "Horas semanais (trabalhador)", "weeklyHoursDefault": "Padrão do departamento" }
```

**fr.json:**
```json
"entry": { "onGuard": "D'astreinte" },
"action": { "applyWeek": "Appliquer à toute la semaine" },
"summary": { "teleworkDaysWeek": "Télétravail (semaine)", "teleworkDaysMonth": "Télétravail (total du mois)" },
"alert": { "GUARDIA_UNIQUE": "Plusieurs employés d'astreinte le même jour" },
"clone": { "pickWeek": "Choisir la semaine cible", "targetWeek": "Semaine cible", "mustBeFutureEmpty": "Doit être une semaine future sans planning existant" },
"empty": { "importPreviousWeek": "Importer la semaine précédente" },
"config": { "weeklyHoursOverride": "Heures hebdomadaires (employé)", "weeklyHoursDefault": "Valeur par défaut du département" }
```

**it.json:**
```json
"entry": { "onGuard": "In reperibilità" },
"action": { "applyWeek": "Applica a tutta la settimana" },
"summary": { "teleworkDaysWeek": "Telelavoro (settimana)", "teleworkDaysMonth": "Telelavoro (totale mese)" },
"alert": { "GUARDIA_UNIQUE": "Più di un dipendente in reperibilità lo stesso giorno" },
"clone": { "pickWeek": "Scegli settimana di destinazione", "targetWeek": "Settimana di destinazione", "mustBeFutureEmpty": "Deve essere una settimana futura senza calendario esistente" },
"empty": { "importPreviousWeek": "Importa settimana precedente" },
"config": { "weeklyHoursOverride": "Ore settimanali (dipendente)", "weeklyHoursDefault": "Predefinito del reparto" }
```

- [ ] **Step 2: Add `settings.users.role_worker` to all 6 locales**

In every locale file, under `settings.users`, right after `"role_viewer"`, add:
```json
"role_worker": "WORKER"
```
(Matches the existing pattern — all role labels are literal role names in every locale.)

- [ ] **Step 3: Validate JSON and key parity across locales**

```bash
cd frontend && for f in locales/*.json; do python3 -c "import json,sys; json.load(open('$f'))" && echo "$f OK"; done
python3 -c "
import json
en = json.load(open('locales/en.json'))
def flat(d, prefix=''):
    out = set()
    for k, v in d.items():
        p = f'{prefix}.{k}' if prefix else k
        if isinstance(v, dict):
            out |= flat(v, p)
        else:
            out.add(p)
    return out
en_keys = flat(en)
for loc in ['es','de','pt','fr','it']:
    d = json.load(open(f'locales/{loc}.json'))
    missing = en_keys - flat(d)
    ss_missing = {k for k in missing if k.startswith('staffSchedule') or 'role_worker' in k}
    if ss_missing:
        print(loc, 'MISSING:', ss_missing)
"
```
Expected: all files parse as valid JSON; no missing `staffSchedule.*` or `role_worker` keys reported for any locale.

- [ ] **Step 4: Commit**

```bash
git add frontend/locales/en.json frontend/locales/es.json frontend/locales/de.json frontend/locales/pt.json frontend/locales/fr.json frontend/locales/it.json
git commit -m "i18n: add staff-schedule rework and WORKER role strings (6 languages)"
```

---

### Task 16: Full verification — types, tests, build, deploy, smoke test

**Files:** none (verification only).

- [ ] **Step 1: Backend type-check and full test suite**

```bash
cd backend && npx tsc --noEmit
podman exec cmdb-backend-prod npx jest
```
Expected: `tsc` clean (only the two pre-existing documented errors); all tests PASS.

- [ ] **Step 2: Frontend type-check**

```bash
cd frontend && npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 3: Full stack rebuild**

```bash
podman-compose -f docker-compose.prod.yml down
podman-compose -f docker-compose.prod.yml up -d --build
curl -sk https://localhost/api/health
```
Expected: containers start cleanly; health check returns 200.

- [ ] **Step 4: Manual smoke test — Miguel's 40h regression, guard uniqueness, clone-to-week**

Use the seeded temporary ADMIN (see CLAUDE.md "Testing ADMIN-only flows") to exercise the flows the AUDITOR test account cannot reach (department config, publish/unpublish, clone). Test plan:
1. Create/select a department, set a summer period covering the target week, save department config with `summerBreakMinutes: 30`.
2. Create a schedule for a future Monday; for one worker, set all 5 days to `PRESENCIAL 07:30-16:00`; validate `weeklyNetHours` in the API response is `40.0`, not `40.5`.
3. In the popover, set `onGuard: true` for that worker on one day; save; confirm the calendar cell shows the "G" badge and the day's `status` is unaffected.
4. Set `onGuard: true` for a second worker on the *same* day in the *same* department; expect the save to be rejected with 409 (partial unique index) or, if saved via `/validate`, expect a `GUARDIA_UNIQUE` ERROR alert.
5. From the calendar, click "Clonar" → pick a future Monday with no existing schedule → confirm 201; re-open the picker and pick the *same* target again → confirm 409 with a clear message.
6. From an empty future week, click "Importar semana anterior" → confirm it clones the immediately preceding week's entries.
7. Log in as a `WORKER` user (promote the AUDITOR test account temporarily via the role-change endpoint, test, then revert its role back to AUDITOR): confirm the sidebar shows only Horarios de Personal (plus whatever a VIEWER already sees) and that `/reports`, `/audit`, etc. behave as they would for a VIEWER.
8. Select "Todos los departamentos" in the filter: confirm every department with a schedule for that week renders read-only (no cell is clickable).

Expected: all 8 checks pass. Document actual observed output (not assumptions) before proceeding.

- [ ] **Step 5: Clean up test data**

Delete any schedules/departments created solely for this smoke test, and revert the temporary role changes, per the CLAUDE.md GDPR/test-account cleanup convention.

---

### Task 17: Documentation updates

**Files:**
- Modify: `docs/STAFF_SCHEDULE.md`
- Modify: `docs/DPIA_STAFF_SCHEDULE.md`
- Modify: `docs/USER_MANUAL.md`
- Modify: `docs/USER_MANUAL.en.md`

- [ ] **Step 1: `docs/STAFF_SCHEDULE.md`**

Add a "v3.5.9" changelog section documenting: the Friday break fix (and why the old behavior was wrong), GUARDIA's move from status to `onGuard` complement with the DB-level uniqueness guarantee, the `cloneToWeek`/import-previous-week replacement for the old rigid `cloneToNextWeek`, per-user `weeklyTargetHours`, the `WORKER` role and its exact scope (Staff Schedule read access only, otherwise VIEWER-equivalent), and the new "Todos los departamentos" read-only view.

- [ ] **Step 2: `docs/DPIA_STAFF_SCHEDULE.md`**

Add a note that `onGuard` is not health data and is never masked, but is forced to `false` in the same response branch that masks `BAJA_MEDICA`/`BAJA_PATERNIDAD` (to avoid any correlation leak), and that the new `WORKER` role has been added to the "who can see this data" section — WORKER sees the same masked view as AUDITOR (all departments, health-leave masked unless self/ADMIN).

- [ ] **Step 3: `docs/USER_MANUAL.md` + `docs/USER_MANUAL.en.md`**

Update the Staff Schedule section: guard-duty is now a checkbox, not a dropdown option; explain the new clone flow (pick a target week) and "import previous week"; explain the auto-filled exit time and "apply to whole week" button; explain the new WORKER role and the read-only "all departments" view.

- [ ] **Step 4: Commit**

```bash
git add docs/STAFF_SCHEDULE.md docs/DPIA_STAFF_SCHEDULE.md docs/USER_MANUAL.md docs/USER_MANUAL.en.md
git commit -m "docs: staff schedule rework v3.5.9 (guardia complement, WORKER role, clone-to-week)"
```

---

### Task 18: Release — version bump, PR to develop, tag, PR to main, cleanup

**Files:**
- Modify: `package.json`, `frontend/package.json`, `backend/package.json` (whichever carry the app version — verify against the v3.5.8 release commit before editing).

- [ ] **Step 1: Bump version to 3.5.9**

Confirm which `package.json` file(s) drive the sidebar version badge (per `docs/PLAN_v3.4.1.md` — `footer.version_short`) and bump to `3.5.9`.

- [ ] **Step 2: Push the feature branch and open the PR to `develop`**

```bash
git push -u origin feature/staff-schedule-rework-v3.5.9
gh pr create --base develop --title "feat: staff schedule rework — guardia complement, WORKER role, clone-to-week (v3.5.9)" --body "$(cat <<'EOF'
## Summary
- Fixes weekly hours over-count (Friday break was silently skipped — issue #195)
- GUARDIA becomes a per-entry complement (onGuard), enforced unique per department/day via a DB partial index
- Clone now targets a caller-chosen future week; adds "import previous week"
- Per-user weekly hours override (reduced-hours workers)
- New WORKER role: VIEWER-equivalent + Staff Schedule read access (all departments)
- Read-only "Todos los departamentos" week view
- Exit-time autofill, "apply to whole week" in the entry popover

## Test plan
- [ ] Backend `tsc --noEmit` clean, full jest suite green
- [ ] Frontend `tsc --noEmit` clean
- [ ] Manual smoke test per plan Task 16 (40h regression, guard uniqueness, clone-to-week, WORKER role, all-departments view)
- [ ] Full stack rebuild + `/api/health` 200
EOF
)"
```

- [ ] **Step 3: Confirm with the user before merging**

Per the "merge without review" lesson recorded in memory: **ask the user to name this specific PR before merging**, even though the overall task was pre-approved. Do not run `gh pr merge` without that explicit per-PR confirmation.

- [ ] **Step 4: After merge — tag and release**

```bash
git checkout develop && git pull
git checkout main && git pull
git merge --no-ff develop -m "Merge develop into main for v3.5.9"
git tag v3.5.9
git push origin main --tags
gh release create v3.5.9 --title "v3.5.9" --notes "Staff Schedule rework: guardia complement, WORKER role, clone-to-week, hours-calc fix. See docs/STAFF_SCHEDULE.md."
git push origin develop:main
```
(Ask for confirmation before the `push origin main` and any force-adjacent step, per the Git Safety Protocol — this is a plan, not a standing authorization.)

- [ ] **Step 5: Branch cleanup**

```bash
git branch -d feature/staff-schedule-rework-v3.5.9
git push origin --delete feature/staff-schedule-rework-v3.5.9
```

- [ ] **Step 6: Update CLAUDE.md "Plan Activo"**

Add a v3.5.9 entry to the "Releases recientes" section (following the existing style of prior entries) summarizing: root cause of the 40.5h bug, the guardia redesign and its DB enforcement, the WORKER role and its exact scope, the clone-to-week fix, and any deviations discovered during implementation. Update "Versión actual en producción" and "Rama activa" pointers.

- [ ] **Step 7: Update memory**

Write a new session-state memory file (following the existing `v3_5_8_session_state.md` pattern) summarizing the release, and add its entry to `MEMORY.md`. Note in particular: the exact root cause of the Friday-break bug (useful precedent for future hour-calculation bugs), and the `ROLE_RANK: Record<UserRole,...>` compile-time safety net discovered while wiring WORKER into the reports module (useful precedent for future role additions).

- [ ] **Step 8: `graphify update`**

```bash
graphify update .
```

---

## Self-Review Notes

**Spec coverage** — all 11 user-reported points plus the "Todos los departamentos" bug are covered: 40.5h bug (Task 2), week/month telework split (Task 4/10), guardia as complement + uniqueness (Tasks 1/3/4/5/9/10), clone fix + week picker (Tasks 4/5/8/11), import previous week (Tasks 4/8/11), exit-time autofill (Task 9), per-user weekly hours (Tasks 1/4/5/14), apply-to-week (Task 9), one-department-per-worker (already guaranteed by schema, documented in Task 17), WORKER role (Tasks 1/5/7/13), all-departments read-only view (Tasks 8/11/12).

**Placeholder scan** — every step has literal code, exact SQL, or exact i18n strings; no "TBD"/"handle appropriately" language.

**Type consistency** — `MaskedEntryFields.onGuard`, `EntryUpdateInput.onGuard`, `EntryLike.onGuard`, `ScheduleRow.summary.{teleworkDaysWeek,teleworkDaysMonth,weeklyTargetHours}` are named identically across `schemas.ts`, `service.ts`, `validationEngine.ts`, `queries.ts`, `export.ts`, and the frontend `types.ts`/components. `cloneToWeek` replaces `cloneToNextWeek` consistently in `service.ts` and `router.ts`. `UserRole` (`'WORKER'` added) is updated in all five locations that declare it independently (`backend/src/shared/types.ts`, `backend/src/modules/reports/types.ts`, `frontend/contexts/AuthContext.tsx`, `frontend/app/reports/types/report.ts`, plus the Prisma enum) — `plugins/schemas.ts` is deliberately left untouched (documented non-goal: plugin `requiredRole` does an exact-match check, not a rank comparison, so it is unaffected either way).
