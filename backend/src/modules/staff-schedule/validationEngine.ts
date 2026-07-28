import { AlertSeverity, AlertType, HEALTH_STATUSES, INTENSIVE_STATUSES, TARGET_REDUCING_STATUSES, TELEWORK_STATUSES } from './schemas.js';

// Floating point tolerance for hour comparisons (D8).
export const EPS = 0.01;

// Statuses that never count as worked time (D9 / computeNetHours pseudocode).
// FESTIVO/FESTIVO_LOCAL (v3.5.12) join this set for the same reason
// VACACIONES already does: a holiday is not worked time.
const NON_WORKING_STATUSES = new Set(['VACACIONES', 'FESTIVO', 'FESTIVO_LOCAL', 'BAJA_MEDICA', 'BAJA_PATERNIDAD', 'AUSENTE', 'VIAJE']);

export interface EntryLike {
  userId: string;
  date: string; // ISO "YYYY-MM-DD"
  status: string;
  onGuard?: boolean;
  startTime?: string | null;
  endTime?: string | null;
}

// Merges the relevant DepartmentScheduleConfig fields with the Department
// fields (presenceStart/presenceEnd/minPresencePct) that the validation
// pseudocode addresses via `cfg.*`. In the finalized schema these two groups
// of fields live on different models (DepartmentScheduleConfig vs
// Department) — service.ts is responsible for merging them into this shape
// before calling validate() (documented deviation, see module report).
export interface ValidationConfig {
  winterDailyNetHours: number;
  winterMaxDailyNetHours: number;
  winterBreakMinutes: number;
  winterFridayNetHours: number;
  summerDailyNetHours: number;
  summerMaxDailyNetHours: number;
  summerBreakMinutes: number;
  summerFridayNetHours: number;
  weeklyTargetNetHours: number;
  monthlyTeleworkCap: number;
  flexEntryStart: string;
  flexEntryEnd: string;
  flexExitStart: string;
  flexExitEnd: string;
  // from Department
  presenceStart: string;
  presenceEnd: string;
  minPresencePct: number;
}

export interface SummerPeriodLike {
  year: number;
  startDate: string; // ISO date
  endDate: string;   // ISO date
}

export interface ScheduleLike {
  id: string;
  weekStart: string; // ISO date, Monday
  year: number;
}

export interface GeneratedAlert {
  type: AlertType;
  severity: AlertSeverity;
  message: string;
  userId?: string;
  date?: string;
}

function toDate(v: string): Date {
  // Dates are plain "YYYY-MM-DD" — parse as UTC to avoid TZ drift.
  return new Date(`${v.slice(0, 10)}T00:00:00.000Z`);
}

// ISO weekday: Monday=1 ... Friday=5 ... Sunday=7 (getUTCDay() Sunday=0 remapped).
function weekdayIso(dateStr: string): number {
  const d = toDate(dateStr).getUTCDay();
  return d === 0 ? 7 : d;
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function minutesBetween(start: string, end: string): number {
  return minutesOf(end) - minutesOf(start);
}

// computeNetHours(entry, cfg, isSummer) — D9 pseudocode.
export function computeNetHours(entry: EntryLike, cfg: ValidationConfig, isSummer: boolean): number {
  if (NON_WORKING_STATUSES.has(entry.status)) return 0;
  if (!entry.startTime || !entry.endTime) return 0;

  const gross = minutesBetween(entry.startTime, entry.endTime) / 60;
  const isIntensive = INTENSIVE_STATUSES.includes(entry.status);

  // The break applies every working day, including Fridays — only an
  // INTENSIVO (continuous) day skips it. Fixes issue #195: a normal Friday
  // was silently zeroing the break, inflating the weekly total (e.g. 40.5h
  // instead of 40h for a 5x8h week).
  const brk = isIntensive
    ? 0
    : (isSummer ? cfg.summerBreakMinutes : cfg.winterBreakMinutes) / 60;

  return gross - brk;
}

// ─── Per-user telework quota (v3.5.11) ─────────────────────────────────────

// Per-user override of the department's monthly telework cap. Every field is
// optional: a user with none of them set falls back to the department default.
export interface TeleworkQuota {
  teleworkFull: boolean;
  teleworkQuotaDays: number | null;
  teleworkQuotaPct: number | null;
}

// Number of Mon-Fri days in a calendar month — the base for a percentage
// quota. Deliberately independent of what has been planned: the cap must not
// move as the schedule gets filled in (user decision, v3.5.11).
export function workingDaysInMonth(year: number, month: number): number {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate(); // month is 1-12
  let count = 0;
  for (let d = 1; d <= days; d++) {
    const wd = new Date(Date.UTC(year, month - 1, d)).getUTCDay();
    if (wd >= 1 && wd <= 5) count++;
  }
  return count;
}

// Resolves the effective monthly telework cap for a user.
// Priority: full telework > fixed days > percentage > department default.
// Returns `null` when the user is exempt (100% telework) — no cap to breach.
export function resolveTeleworkCap(
  quota: TeleworkQuota | undefined,
  departmentCap: number,
  year: number,
  month: number,
): number | null {
  if (!quota) return departmentCap;
  if (quota.teleworkFull) return null;
  if (quota.teleworkQuotaDays != null) return quota.teleworkQuotaDays;
  if (quota.teleworkQuotaPct != null) {
    return Math.round((quota.teleworkQuotaPct / 100) * workingDaysInMonth(year, month));
  }
  return departmentCap;
}

// dailyTargetHours — the contracted hours for a single weekday under the
// department's configured schedule (Friday differs from Mon-Thu; summer
// differs from winter). Used only to size the reduction in
// computeEffectiveWeeklyTarget below, not to validate a specific day.
function dailyTargetHours(wd: number, isSummer: boolean, cfg: ValidationConfig): number {
  if (wd === 5) return isSummer ? cfg.summerFridayNetHours : cfg.winterFridayNetHours;
  return isSummer ? cfg.summerDailyNetHours : cfg.winterDailyNetHours;
}

// computeEffectiveWeeklyTarget (v3.5.12) — reduces `baseTarget` (the
// department default or the user's own weeklyTargetHours override) by the
// contracted hours of every VACACIONES/FESTIVO/FESTIVO_LOCAL day in the
// user's week. A week that includes a holiday should be judged against fewer
// hours, not reported as a shortfall against a flat 40h target. Clamped at 0
// so a week that is entirely holiday/vacation never goes negative.
//
// Deliberately narrower than NON_WORKING_STATUSES: BAJA_MEDICA,
// BAJA_PATERNIDAD, AUSENTE and VIAJE still count as a shortfall against the
// full target (product decision — only vacation/holiday days reduce it).
export function computeEffectiveWeeklyTarget(
  entries: EntryLike[],
  cfg: ValidationConfig,
  isSummer: boolean,
  baseTarget: number,
): number {
  let reduction = 0;
  for (const e of entries) {
    if (TARGET_REDUCING_STATUSES.includes(e.status)) {
      reduction += dailyTargetHours(weekdayIso(e.date), isSummer, cfg);
    }
  }
  return Math.max(0, baseTarget - reduction);
}

// detectSummer(weekStart, summerSchedule) — D7 pseudocode.
export function detectSummer(weekStart: string, summer?: SummerPeriodLike | null): boolean {
  if (!summer) return false;
  const ws = toDate(weekStart).getTime();
  const start = toDate(summer.startDate).getTime();
  const end = toDate(summer.endDate).getTime();
  return ws >= start && ws <= end;
}

// validate(schedule, entries, cfg, summer, teleworkCountsByUser) -> alerts[]
//
// Pure and synchronous by design: `teleworkCountsByUser` must be computed
// beforehand by the caller (service.ts) via an async DB query
// (queries.countTeleworkThisMonth), because the engine itself must stay
// side-effect free and unit-testable without a DB connection.
//
// Deviation note (V6/V7): the spec's pseudocode phrases GUARDIA_COVERAGE and
// BAJA_CONFLICT as "same-day" status intersections, but ScheduleEntry has a
// single `status` column with a uniqueness constraint of one row per
// (schedule, user, date) — a single day cannot literally hold two statuses.
// We reinterpret both rules at the *week* level (the natural granularity of
// a StaffSchedule): if a user has a GUARDIA day anywhere in the week AND a
// VIAJE/VACACIONES day anywhere in the same week, that's a coverage
// conflict (V6); if a user has a BAJA_* day anywhere in the week AND a
// PRESENCIAL/TELETRABAJO day anywhere in the same week, that's flagged as a
// (non-blocking) conflict warning (V7). This keeps the rules meaningful
// instead of permanently dead code under the finalized schema.
export function validate(
  schedule: ScheduleLike,
  entries: EntryLike[],
  cfg: ValidationConfig,
  summer: SummerPeriodLike | null | undefined,
  teleworkCountsByUser: Record<string, number>,
  weeklyTargetsByUser: Record<string, number> = {},
  teleworkQuotasByUser: Record<string, TeleworkQuota> = {},
): GeneratedAlert[] {
  const alerts: GeneratedAlert[] = [];
  const isSummer = detectSummer(schedule.weekStart, summer ?? null);
  // Month the week belongs to — the same month countTeleworkThisMonth uses,
  // and the base for a percentage-expressed telework quota.
  const month = Number(schedule.weekStart.slice(5, 7));
  const maxDaily = isSummer ? cfg.summerMaxDailyNetHours : cfg.winterMaxDailyNetHours;

  // ── DAILY_HOURS (ERROR): Mon-Thu net hours over the daily maximum ─────────
  for (const e of entries) {
    const wd = weekdayIso(e.date);
    if (wd >= 1 && wd <= 4) {
      const net = computeNetHours(e, cfg, isSummer);
      if (net > maxDaily + EPS) {
        alerts.push({
          type: 'DAILY_HOURS',
          severity: 'ERROR',
          message: `Net hours (${net.toFixed(2)}) exceed the daily maximum (${maxDaily})`,
          userId: e.userId,
          date: e.date,
        });
      }
    }
  }

  const byUser = new Map<string, EntryLike[]>();
  for (const e of entries) {
    const arr = byUser.get(e.userId) ?? [];
    arr.push(e);
    byUser.set(e.userId, arr);
  }

  for (const [userId, es] of byUser) {
    // ── WEEKLY_HOURS (ERROR): intensive Friday but week total below target ──
    // Target reduced by VACACIONES/FESTIVO/FESTIVO_LOCAL days in the same
    // week (v3.5.12) — see computeEffectiveWeeklyTarget.
    const baseTarget = weeklyTargetsByUser[userId] ?? cfg.weeklyTargetNetHours;
    const target = computeEffectiveWeeklyTarget(es, cfg, isSummer, baseTarget);
    const hasIntensiveFriday = es.some((e) => INTENSIVE_STATUSES.includes(e.status) && weekdayIso(e.date) === 5);
    if (hasIntensiveFriday) {
      const weekly = es.reduce((sum, e) => sum + computeNetHours(e, cfg, isSummer), 0);
      if (weekly < target - EPS) {
        alerts.push({
          type: 'WEEKLY_HOURS',
          severity: 'ERROR',
          message: `Weekly net hours (${weekly.toFixed(2)}) below target (${target}) despite intensive Friday`,
          userId,
        });
      }
    }

    // ── TELEWORK_QUOTA (ERROR): monthly telework days over the cap ──────────
    // The cap is per user (v3.5.11): a worker on full remote for medical
    // reasons is exempt (cap === null) and must never be flagged; others may
    // carry a days- or percentage-based override of the department cap.
    const teleMonth = teleworkCountsByUser[userId] ?? 0;
    const teleCap = resolveTeleworkCap(teleworkQuotasByUser[userId], cfg.monthlyTeleworkCap, schedule.year, month);
    if (teleCap !== null && teleMonth > teleCap) {
      alerts.push({
        type: 'TELEWORK_QUOTA',
        severity: 'ERROR',
        message: `Telework days this month (${teleMonth}) exceed the cap (${teleCap})`,
        userId,
      });
    }

    // ── GUARDIA_COVERAGE (ERROR) — week-level reinterpretation, see note ────
    const guardiaDays = es.filter((e) => e.onGuard);
    const hasAwayDay = es.some((e) => e.status === 'VIAJE' || e.status === 'VACACIONES');
    if (guardiaDays.length > 0 && hasAwayDay) {
      for (const g of guardiaDays) {
        alerts.push({
          type: 'GUARDIA_COVERAGE',
          severity: 'ERROR',
          message: 'GUARDIA duty conflicts with VIAJE/VACACIONES elsewhere in the same week',
          userId,
          date: g.date,
        });
      }
    }

    // ── BAJA_CONFLICT (WARNING) — week-level reinterpretation, see note ─────
    const bajaDays = es.filter((e) => HEALTH_STATUSES.includes(e.status));
    const hasPresenceDay = es.some((e) => e.status === 'PRESENCIAL' || e.status === 'TELETRABAJO');
    if (bajaDays.length > 0 && hasPresenceDay) {
      for (const b of bajaDays) {
        alerts.push({
          type: 'BAJA_CONFLICT',
          severity: 'WARNING',
          message: 'Health leave status conflicts with a working status elsewhere in the same week',
          userId,
          date: b.date,
        });
      }
    }

    // ── FLEX_RANGE (WARNING): entry/exit outside the flexible window ────────
    // Only applies to statuses that actually use the flexible entry/exit
    // window (PRESENCIAL, TELETRABAJO). INTENSIVO is a continuous shift with
    // its own fixed schedule — the flexible window is not the right check for
    // it (reported during v3.5.10 live verification: a normal INTENSIVO day
    // was incorrectly flagged "outside flexible hours").
    for (const e of es) {
      if (e.status !== 'PRESENCIAL' && e.status !== 'TELETRABAJO') continue;
      if (!e.startTime || !e.endTime) continue;
      if (
        e.startTime < cfg.flexEntryStart || e.startTime > cfg.flexEntryEnd ||
        e.endTime < cfg.flexExitStart || e.endTime > cfg.flexExitEnd
      ) {
        alerts.push({
          type: 'FLEX_RANGE',
          severity: 'WARNING',
          message: `Entry/exit time (${e.startTime}-${e.endTime}) outside the flexible window`,
          userId,
          date: e.date,
        });
      }
    }
  }

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

  // ── PRESENCE_PCT (WARNING): per day, % of the available team on site ──────
  //
  // Two fixes over the original rule (v3.5.11, reported as "always 0.0%"):
  //
  // 1. A worker counts as present when their PRESENCIAL shift *overlaps* the
  //    core window, not when it fully contains it. The old containment test
  //    (start <= presenceStart && end >= presenceEnd) was unsatisfiable in
  //    practice: with a 09:00-18:00 core window (9 h) and ~8.5 h shifts, no
  //    real workday could ever qualify, so the coverage was reported as 0.0%
  //    no matter who was in the office.
  // 2. The denominator only counts workers who are actually available that
  //    day. Somebody on holiday or sick leave cannot be present, so counting
  //    them made a holiday week permanently breach the minimum.
  const days = Array.from(new Set(entries.map((e) => e.date))).sort();
  for (const day of days) {
    const dayEntries = entries.filter((e) => e.date === day);
    const availableCount = dayEntries.filter((e) => !NON_WORKING_STATUSES.has(e.status)).length;
    if (availableCount === 0) continue;
    // A PRESENCIAL entry with no times yet (the shape createSchedule seeds a
    // new week with) counts as present: the planner has declared the person on
    // site, and the window check only makes sense once hours are filled in.
    // Otherwise a brand-new week would always report 0% coverage.
    const present = dayEntries.filter((e) => {
      if (e.status !== 'PRESENCIAL') return false;
      if (!e.startTime || !e.endTime) return true;
      return e.startTime < cfg.presenceEnd && e.endTime > cfg.presenceStart;
    }).length;
    const pct = (present / availableCount) * 100;
    if (pct < cfg.minPresencePct - EPS) {
      alerts.push({
        type: 'PRESENCE_PCT',
        severity: 'WARNING',
        message: `Presence coverage (${pct.toFixed(1)}%) below minimum (${cfg.minPresencePct}%)`,
        date: day,
      });
    }
  }

  return alerts;
}
