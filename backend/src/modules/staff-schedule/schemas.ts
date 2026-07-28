import { z } from 'zod';

// ─── Allowlists (TEXT+Zod pattern — D5, avoids PG enum migration friction) ────

export const SCHEDULE_STATUS = [
  'PRESENCIAL',
  'TELETRABAJO',
  'VACACIONES',
  'BAJA_MEDICA',
  'BAJA_PATERNIDAD',
  'INTENSIVO',
  'INTENSIVO_TELETRABAJO',
  'VIAJE',
  'AUSENTE',
] as const;
export type ScheduleStatus = (typeof SCHEDULE_STATUS)[number];

// Subset of SCHEDULE_STATUS that is GDPR Art. 9 special-category health data (D2/D4).
export const HEALTH_STATUSES: readonly string[] = ['BAJA_MEDICA', 'BAJA_PATERNIDAD'];

// Statuses worked from home — they consume the monthly telework quota.
// INTENSIVO_TELETRABAJO (v3.5.11) is a continuous shift done remotely: it is
// telework for quota purposes and intensive for hour-computation purposes.
export const TELEWORK_STATUSES: readonly string[] = ['TELETRABAJO', 'INTENSIVO_TELETRABAJO'];

// Continuous-shift statuses: no break is deducted and the flexible entry/exit
// window does not apply (they have their own fixed schedule).
export const INTENSIVE_STATUSES: readonly string[] = ['INTENSIVO', 'INTENSIVO_TELETRABAJO'];

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
export type AlertType = (typeof ALERT_TYPE)[number];

export const ALERT_SEVERITY = ['WARNING', 'ERROR'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITY)[number];

export const SCHEDULE_STATE = ['DRAFT', 'PUBLISHED'] as const;
export type ScheduleState = (typeof SCHEDULE_STATE)[number];

// "HH:MM" 24h, D8
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const timeSchema = z.string().regex(TIME_RE, 'Must be HH:MM (24h)');

// ─── Departments ───────────────────────────────────────────────────────────

export const DepartmentSchema = z.object({
  name: z.string().min(1).max(200),
  code: z.string().min(1).max(50),
  serviceStart: timeSchema,
  serviceEnd: timeSchema,
  presenceStart: timeSchema,
  presenceEnd: timeSchema,
  minPresencePct: z.number().int().min(0).max(100).default(50),
});
export const DepartmentUpdateSchema = DepartmentSchema.partial();

// ─── Department schedule config ────────────────────────────────────────────

export const DeptConfigSchema = z.object({
  winterDailyNetHours: z.number().min(0).max(24).optional(),
  winterMaxDailyNetHours: z.number().min(0).max(24).optional(),
  winterBreakMinutes: z.number().int().min(0).max(600).optional(),
  winterFridayNetHours: z.number().min(0).max(24).optional(),
  summerDailyNetHours: z.number().min(0).max(24).optional(),
  summerMaxDailyNetHours: z.number().min(0).max(24).optional(),
  summerBreakMinutes: z.number().int().min(0).max(600).optional(),
  summerFridayNetHours: z.number().min(0).max(24).optional(),
  weeklyTargetNetHours: z.number().min(0).max(168).optional(),
  monthlyTeleworkCap: z.number().int().min(0).max(31).optional(),
  flexEntryStart: timeSchema.optional(),
  flexEntryEnd: timeSchema.optional(),
  flexExitStart: timeSchema.optional(),
  flexExitEnd: timeSchema.optional(),
});

// ─── Summer schedule (global period, D7) ───────────────────────────────────

export const SummerSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  startDate: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Invalid date'),
  endDate: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Invalid date'),
});

// ─── Schedules ──────────────────────────────────────────────────────────────

export const ScheduleCreateSchema = z.object({
  departmentId: z.string().uuid(),
  weekStart: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Invalid date'),
});

const EntryUpdateSchema = z.object({
  userId: z.string().uuid(),
  date: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Invalid date'),
  status: z.enum(SCHEDULE_STATUS),
  onGuard: z.boolean().optional(),
  startTime: timeSchema.nullable().optional(),
  endTime: timeSchema.nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export const EntriesUpdateSchema = z.object({
  entries: z.array(EntryUpdateSchema).min(1),
});

// ─── Managers / user-department assignment ─────────────────────────────────

export const ManagerAssignSchema = z.object({
  userId: z.string().uuid(),
});

export const UserDeptAssignSchema = z.object({
  departmentId: z.string().uuid().nullable(),
});

// ─── Clone / import-previous-week ──────────────────────────────────────────

export const CloneScheduleSchema = z.object({
  targetWeekStart: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Invalid date'),
});

// ─── Per-user weekly hours override ────────────────────────────────────────

export const UserWeeklyHoursSchema = z.object({
  weeklyTargetHours: z.number().min(0).max(80).nullable(),
});

// ─── Per-user telework quota override (v3.5.11) ────────────────────────────
//
// Three independent knobs, resolved by priority full > days > pct > department
// default (see resolveTeleworkCap in validationEngine.ts). All optional: a user
// with none of them set keeps the department-wide monthly cap.
export const UserTeleworkQuotaSchema = z.object({
  teleworkFull: z.boolean(),
  teleworkQuotaDays: z.number().int().min(0).max(31).nullable(),
  teleworkQuotaPct: z.number().int().min(0).max(100).nullable(),
});

// ─── Worker search selector (v3.5.12, R5/D4) ───────────────────────────────

export const UserSearchSchema = z.object({
  q: z.string().min(2, 'q must be at least 2 characters'),
});

// ─── Worker entries by range (v3.5.12, R5/D6) ──────────────────────────────
// Bounded to 62 days server-side (covers both the weekly and monthly worker
// views) — unbounded ranges from an authenticated endpoint are a NIS2
// availability concern, not just a UX one.
const isoDateRefine = (v: string) => !Number.isNaN(Date.parse(v));

export const UserEntriesRangeSchema = z
  .object({
    from: z.string().refine(isoDateRefine, 'Invalid date'),
    to: z.string().refine(isoDateRefine, 'Invalid date'),
  })
  .refine((data) => Date.parse(data.to) >= Date.parse(data.from), {
    message: 'to must not be before from',
    path: ['to'],
  })
  .refine((data) => (Date.parse(data.to) - Date.parse(data.from)) / 86400000 <= 62, {
    message: 'Range cannot exceed 62 days',
    path: ['to'],
  });

// ─── Schedule list range (v3.5.12, R6) ─────────────────────────────────────
// GET / accepts from/to over weekStart IN ADDITION to the pre-existing exact
// weekStart param (never replacing it — existing callers must keep working
// unchanged). Bounded to 6 weeks (42 days) server-side (D6).
export const ScheduleRangeSchema = z
  .object({
    from: z.string().refine(isoDateRefine, 'Invalid date'),
    to: z.string().refine(isoDateRefine, 'Invalid date'),
  })
  .refine((data) => Date.parse(data.to) >= Date.parse(data.from), {
    message: 'to must not be before from',
    path: ['to'],
  })
  .refine((data) => (Date.parse(data.to) - Date.parse(data.from)) / 86400000 <= 42, {
    message: 'Range cannot exceed 6 weeks',
    path: ['to'],
  });

// ─── Print audit (v3.5.12, R7/D7) ──────────────────────────────────────────
export const PRINT_SCOPE = ['DEPARTMENT_WEEK', 'DEPARTMENT_MONTH', 'WORKER'] as const;
export type PrintScope = (typeof PRINT_SCOPE)[number];

export const PrintAuditSchema = z.object({
  scope: z.enum(PRINT_SCOPE),
  targetId: z.string().uuid(),
  from: z.string().refine(isoDateRefine, 'Invalid date').optional(),
  to: z.string().refine(isoDateRefine, 'Invalid date').optional(),
});
