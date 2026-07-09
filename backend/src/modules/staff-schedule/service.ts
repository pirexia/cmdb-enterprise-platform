import { PrismaClient } from '@prisma/client';
import { HEALTH_STATUSES } from './schemas.js';
import {
  computeNetHours,
  detectSummer,
  validate,
  EntryLike,
  ValidationConfig,
  SummerPeriodLike,
  ScheduleLike,
  GeneratedAlert,
} from './validationEngine.js';
import { loadScheduleWithEntries, countTeleworkThisMonth, loadDepartmentUsers } from './queries.js';
import { canUserEditDepartment } from './authz.js';

export class ScheduleServiceError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

interface Viewer {
  id: string;
  role: string;
}

export interface MaskedEntryFields {
  status: string;
  startTime: string | null;
  endTime: string | null;
  notes: string | null;
  healthMasked?: boolean;
}

// maskEntryForViewer(entry, viewer) — GDPR Art. 9 (D4). This is the single
// most important security control in this module: the precise health-leave
// status (BAJA_MEDICA/BAJA_PATERNIDAD) must NEVER be serialized to a viewer
// who is neither ADMIN nor the entry's own owner. Called server-side before
// every response that could expose entries (view, export, monthly summary) —
// never trust the client to hide this.
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

interface AlertLike {
  id: string;
  type: string;
  severity: string;
  message: string;
  userId: string | null;
  date: Date | null;
  resolved: boolean;
}

// Alerts of type BAJA_CONFLICT reference a specific userId's health-leave
// status by construction. Same Art. 9 principle as entries: don't leak whose
// health status conflicted to a viewer who isn't ADMIN or that same user.
// (Conservative addition beyond the literal spec — see module report.)
function maskAlertForViewer(alert: AlertLike, viewer: Viewer) {
  if (alert.type === 'BAJA_CONFLICT' && viewer.role !== 'ADMIN' && viewer.id !== alert.userId) {
    return { ...alert, userId: null };
  }
  return alert;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDaysUtc(d: Date, days: number): Date {
  const copy = new Date(d);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function parseDateOnly(v: string | Date): Date {
  if (v instanceof Date) return new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()));
  return new Date(`${v.slice(0, 10)}T00:00:00.000Z`);
}

// Merge Department + DepartmentScheduleConfig into the shape validationEngine
// expects (see ValidationConfig doc comment for why these live on two models).
async function loadValidationConfig(prisma: PrismaClient, departmentId: string): Promise<ValidationConfig> {
  const [department, config] = await Promise.all([
    prisma.department.findUnique({ where: { id: departmentId } }),
    prisma.departmentScheduleConfig.findUnique({ where: { departmentId } }),
  ]);
  if (!department) throw new ScheduleServiceError(404, 'Department not found');

  return {
    winterDailyNetHours: config?.winterDailyNetHours ?? 8.0,
    winterMaxDailyNetHours: config?.winterMaxDailyNetHours ?? 9.0,
    winterBreakMinutes: config?.winterBreakMinutes ?? 60,
    winterFridayNetHours: config?.winterFridayNetHours ?? 6.0,
    summerDailyNetHours: config?.summerDailyNetHours ?? 8.0,
    summerMaxDailyNetHours: config?.summerMaxDailyNetHours ?? 9.0,
    summerBreakMinutes: config?.summerBreakMinutes ?? 30,
    summerFridayNetHours: config?.summerFridayNetHours ?? 6.0,
    weeklyTargetNetHours: config?.weeklyTargetNetHours ?? 40.0,
    monthlyTeleworkCap: config?.monthlyTeleworkCap ?? 10,
    flexEntryStart: config?.flexEntryStart ?? '07:00',
    flexEntryEnd: config?.flexEntryEnd ?? '10:30',
    flexExitStart: config?.flexExitStart ?? '16:00',
    flexExitEnd: config?.flexExitEnd ?? '19:00',
    presenceStart: department.presenceStart,
    presenceEnd: department.presenceEnd,
    minPresencePct: department.minPresencePct,
  };
}

async function loadSummerForYear(prisma: PrismaClient, year: number): Promise<SummerPeriodLike | null> {
  const summer = await prisma.summerSchedule.findUnique({ where: { year } });
  if (!summer) return null;
  return { year: summer.year, startDate: isoDate(summer.startDate), endDate: isoDate(summer.endDate) };
}

// createSchedule — auto-creates base PRESENCIAL entries (Mon-Fri) for every
// active user in the department.
export async function createSchedule(
  prisma: PrismaClient,
  params: { departmentId: string; weekStart: string; createdBy: string },
) {
  const weekStartDate = parseDateOnly(params.weekStart);
  const weekEndDate = addDaysUtc(weekStartDate, 4);
  const year = weekStartDate.getUTCFullYear();
  const summer = await loadSummerForYear(prisma, year);
  const isSummerWeek = detectSummer(isoDate(weekStartDate), summer);

  const schedule = await prisma.staffSchedule.create({
    data: {
      departmentId: params.departmentId,
      weekStart: weekStartDate,
      weekEnd: weekEndDate,
      year,
      isSummerWeek,
      createdBy: params.createdBy,
      status: 'DRAFT',
    },
  });

  const users = await loadDepartmentUsers(prisma, params.departmentId);
  const entriesData = users.flatMap((u) =>
    Array.from({ length: 5 }, (_, i) => ({
      scheduleId: schedule.id,
      userId: u.id,
      date: addDaysUtc(weekStartDate, i),
      status: 'PRESENCIAL',
    })),
  );
  if (entriesData.length > 0) {
    await prisma.scheduleEntry.createMany({ data: entriesData });
  }
  return schedule;
}

export interface EntryInput {
  userId: string;
  date: string;
  status: string;
  startTime?: string | null;
  endTime?: string | null;
  notes?: string | null;
}

// updateEntries — only allowed while the schedule is DRAFT (D10).
export async function updateEntries(prisma: PrismaClient, scheduleId: string, entries: EntryInput[]) {
  const schedule = await prisma.staffSchedule.findUnique({ where: { id: scheduleId }, select: { status: true } });
  if (!schedule) throw new ScheduleServiceError(404, 'Schedule not found');
  if (schedule.status !== 'DRAFT') {
    throw new ScheduleServiceError(409, 'Schedule is not editable once published');
  }

  for (const e of entries) {
    const date = parseDateOnly(e.date);
    await prisma.scheduleEntry.upsert({
      where: { scheduleId_userId_date: { scheduleId, userId: e.userId, date } },
      create: {
        scheduleId,
        userId: e.userId,
        date,
        status: e.status,
        startTime: e.startTime ?? null,
        endTime: e.endTime ?? null,
        notes: e.notes ?? null,
      },
      update: {
        status: e.status,
        startTime: e.startTime ?? null,
        endTime: e.endTime ?? null,
        notes: e.notes ?? null,
      },
    });
  }
}

// runValidation — computes V1-V7, wipes previous alerts, persists new ones.
export async function runValidation(prisma: PrismaClient, scheduleId: string): Promise<GeneratedAlert[]> {
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

  await prisma.scheduleAlert.deleteMany({ where: { scheduleId } });
  if (alerts.length > 0) {
    await prisma.scheduleAlert.createMany({
      data: alerts.map((a) => ({
        scheduleId,
        type: a.type,
        severity: a.severity,
        message: a.message,
        userId: a.userId ?? null,
        date: a.date ? parseDateOnly(a.date) : null,
      })),
    });
  }
  return alerts;
}

// publish — DRAFT -> PUBLISHED. Rejects if unresolved ERROR alerts remain (D10).
export async function publish(prisma: PrismaClient, scheduleId: string) {
  const schedule = await prisma.staffSchedule.findUnique({ where: { id: scheduleId }, select: { id: true } });
  if (!schedule) throw new ScheduleServiceError(404, 'Schedule not found');

  const openErrors = await prisma.scheduleAlert.count({
    where: { scheduleId, severity: 'ERROR', resolved: false },
  });
  if (openErrors > 0) {
    throw new ScheduleServiceError(409, 'Cannot publish: unresolved ERROR alerts remain');
  }
  return prisma.staffSchedule.update({ where: { id: scheduleId }, data: { status: 'PUBLISHED' } });
}

// unpublish — PUBLISHED -> DRAFT. Router must have already enforced ADMIN (D10).
export async function unpublish(prisma: PrismaClient, scheduleId: string) {
  const schedule = await prisma.staffSchedule.findUnique({ where: { id: scheduleId }, select: { id: true } });
  if (!schedule) throw new ScheduleServiceError(404, 'Schedule not found');
  return prisma.staffSchedule.update({ where: { id: scheduleId }, data: { status: 'DRAFT' } });
}

// cloneToNextWeek — copies all entries verbatim to a new DRAFT schedule one week later.
export async function cloneToNextWeek(prisma: PrismaClient, scheduleId: string, createdBy: string) {
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

export interface ScheduleView {
  schedule: {
    id: string;
    departmentId: string;
    weekStart: string;
    weekEnd: string;
    status: string;
    year: number;
    isSummerWeek: boolean;
  };
  days: string[];
  rows: Array<{
    userId: string;
    username: string;
    entries: Record<string, MaskedEntryFields>;
    summary: { weeklyNetHours: number; teleworkDaysMonth: number; travelDays: number; guardDays: number };
  }>;
  alerts: Array<{
    id: string;
    type: string;
    severity: string;
    message: string;
    userId: string | null;
    date: string | null;
    resolved: boolean;
  }>;
  canEdit: boolean;
}

// buildScheduleView — the GET /:id shape (masked per viewer, D4). Also the
// backbone reused by export.ts (which must always receive an already-masked view).
export async function buildScheduleView(
  prisma: PrismaClient,
  scheduleId: string,
  viewer: Viewer,
): Promise<ScheduleView | null> {
  const schedule = await loadScheduleWithEntries(prisma, scheduleId);
  if (!schedule) return null;

  const cfg = await loadValidationConfig(prisma, schedule.departmentId);
  const canEdit = await canUserEditDepartment(prisma, viewer.id, viewer.role, schedule.departmentId);

  const days: string[] = Array.from({ length: 5 }, (_, i) => isoDate(addDaysUtc(schedule.weekStart, i)));

  const byUser = new Map<string, { username: string; entriesReal: typeof schedule.entries }>();
  for (const e of schedule.entries) {
    if (!byUser.has(e.userId)) {
      byUser.set(e.userId, { username: e.user.username, entriesReal: [] });
    }
    byUser.get(e.userId)!.entriesReal.push(e);
  }

  const month = schedule.weekStart.getUTCMonth() + 1;
  const rows: ScheduleView['rows'] = [];
  for (const [userId, data] of byUser) {
    const entries: Record<string, MaskedEntryFields> = {};
    for (const e of data.entriesReal) {
      entries[isoDate(e.date)] = maskEntryForViewer(
        { status: e.status, startTime: e.startTime, endTime: e.endTime, notes: e.notes, userId: e.userId },
        viewer,
      );
    }

    // Aggregate figures computed from the real (unmasked) data: statuses that
    // trigger masking (BAJA_*) always compute to 0 net hours anyway (same as
    // AUSENTE) and are excluded from telework/travel/guard counters, so no
    // health-status information is leaked through these aggregates.
    const weeklyNetHours = data.entriesReal.reduce(
      (sum, e) => sum + computeNetHours(
        { userId: e.userId, date: isoDate(e.date), status: e.status, startTime: e.startTime, endTime: e.endTime },
        cfg,
        schedule.isSummerWeek,
      ),
      0,
    );
    const travelDays = data.entriesReal.filter((e) => e.status === 'VIAJE').length;
    const guardDays = data.entriesReal.filter((e) => e.status === 'GUARDIA').length;
    const teleworkDaysMonth = await countTeleworkThisMonth(prisma, userId, schedule.year, month);

    rows.push({
      userId,
      username: data.username,
      entries,
      summary: { weeklyNetHours, teleworkDaysMonth, travelDays, guardDays },
    });
  }

  const alerts = schedule.alerts.map((a) => {
    const masked = maskAlertForViewer(
      { id: a.id, type: a.type, severity: a.severity, message: a.message, userId: a.userId, date: a.date, resolved: a.resolved },
      viewer,
    );
    return {
      id: masked.id,
      type: masked.type,
      severity: masked.severity,
      message: masked.message,
      userId: masked.userId,
      date: masked.date ? isoDate(masked.date) : null,
      resolved: masked.resolved,
    };
  });

  return {
    schedule: {
      id: schedule.id,
      departmentId: schedule.departmentId,
      weekStart: isoDate(schedule.weekStart),
      weekEnd: isoDate(schedule.weekEnd),
      status: schedule.status,
      year: schedule.year,
      isSummerWeek: schedule.isSummerWeek,
    },
    days,
    rows,
    alerts,
    canEdit,
  };
}

export interface MonthlySummary {
  userId: string;
  year: number;
  month: number;
  netHours: number;
  teleworkDays: number;
  travelDays: number;
  guardDays: number;
  vacationDays: number;
  healthLeaveDays?: number; // only present for ADMIN or the user themselves (Art. 9)
}

// GET /user/:userId/monthly — aggregate summary across all schedules that
// touch this user in the given month. AUDITOR/manager viewers who are not
// the user themselves never see a `healthLeaveDays` figure at all (rather
// than a masked/zeroed one) — the mere existence of the metric would signal
// health-leave activity, so it's omitted outright for unauthorized viewers.
export async function getMonthlySummary(
  prisma: PrismaClient,
  userId: string,
  year: number,
  month: number,
  viewer: Viewer,
): Promise<MonthlySummary> {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  const entries = await prisma.scheduleEntry.findMany({
    where: { userId, date: { gte: start, lt: end } },
    include: { schedule: { select: { isSummerWeek: true, departmentId: true } } },
  });

  const isAuthorized = viewer.role === 'ADMIN' || viewer.id === userId;
  const count = (pred: (s: string) => boolean) => entries.filter((e) => pred(e.status)).length;

  const cfgCache = new Map<string, ValidationConfig>();
  let netHours = 0;
  for (const e of entries) {
    const deptId = e.schedule.departmentId;
    let cfg = cfgCache.get(deptId);
    if (!cfg) {
      cfg = await loadValidationConfig(prisma, deptId);
      cfgCache.set(deptId, cfg);
    }
    netHours += computeNetHours(
      { userId: e.userId, date: isoDate(e.date), status: e.status, startTime: e.startTime, endTime: e.endTime },
      cfg,
      e.schedule.isSummerWeek,
    );
  }

  const summary: MonthlySummary = {
    userId,
    year,
    month,
    netHours,
    teleworkDays: count((s) => s === 'TELETRABAJO'),
    travelDays: count((s) => s === 'VIAJE'),
    guardDays: count((s) => s === 'GUARDIA'),
    vacationDays: count((s) => s === 'VACACIONES'),
  };
  if (isAuthorized) {
    summary.healthLeaveDays = count((s) => HEALTH_STATUSES.includes(s));
  }
  return summary;
}
