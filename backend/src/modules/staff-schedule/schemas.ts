import { z } from 'zod';

// ─── Allowlists (TEXT+Zod pattern — D5, avoids PG enum migration friction) ────

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
export type ScheduleStatus = (typeof SCHEDULE_STATUS)[number];

// Subset of SCHEDULE_STATUS that is GDPR Art. 9 special-category health data (D2/D4).
export const HEALTH_STATUSES: readonly string[] = ['BAJA_MEDICA', 'BAJA_PATERNIDAD'];

export const ALERT_TYPE = [
  'TELEWORK_QUOTA',
  'WEEKLY_HOURS',
  'DAILY_HOURS',
  'PRESENCE_PCT',
  'FLEX_RANGE',
  'GUARDIA_COVERAGE',
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
