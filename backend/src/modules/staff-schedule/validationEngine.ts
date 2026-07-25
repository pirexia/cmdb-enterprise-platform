import { AlertSeverity, AlertType, HEALTH_STATUSES } from './schemas.js';

// Floating point tolerance for hour comparisons (D8).
export const EPS = 0.01;

// Statuses that never count as worked time (D9 / computeNetHours pseudocode).
const NON_WORKING_STATUSES = new Set(['VACACIONES', 'BAJA_MEDICA', 'BAJA_PATERNIDAD', 'AUSENTE', 'VIAJE']);

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
): GeneratedAlert[] {
  const alerts: GeneratedAlert[] = [];
  const isSummer = detectSummer(schedule.weekStart, summer ?? null);
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
    const target = weeklyTargetsByUser[userId] ?? cfg.weeklyTargetNetHours;
    const hasIntensiveFriday = es.some((e) => e.status === 'INTENSIVO' && weekdayIso(e.date) === 5);
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
    const teleMonth = teleworkCountsByUser[userId] ?? 0;
    if (teleMonth > cfg.monthlyTeleworkCap) {
      alerts.push({
        type: 'TELEWORK_QUOTA',
        severity: 'ERROR',
        message: `Telework days this month (${teleMonth}) exceed the cap (${cfg.monthlyTeleworkCap})`,
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
    for (const e of es) {
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

  // ── PRESENCE_PCT (WARNING): per day, % of PRESENCIAL covering the core ────
  const days = Array.from(new Set(entries.map((e) => e.date))).sort();
  const deptUserCount = new Set(entries.map((e) => e.userId)).size;
  for (const day of days) {
    if (deptUserCount === 0) continue;
    const dayEntries = entries.filter((e) => e.date === day);
    const present = dayEntries.filter((e) =>
      e.status === 'PRESENCIAL' &&
      !!e.startTime && !!e.endTime &&
      e.startTime <= cfg.presenceStart && e.endTime >= cfg.presenceEnd,
    ).length;
    const pct = (present / deptUserCount) * 100;
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
