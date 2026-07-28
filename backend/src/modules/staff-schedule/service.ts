import { Prisma } from '@prisma/client';
import { HEALTH_STATUSES, TELEWORK_STATUSES } from './schemas.js';
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
import { loadScheduleWithEntries, countTeleworkThisMonth, loadDepartmentUsers, loadWeeklyTargetHours,
         buildScheduleVisibilityFilter, loadManagedDepartmentIds, loadDepartmentMembers,
         loadDepartmentManagerIds, loadTeleworkQuotas } from './queries.js';
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

// canViewSummary(prisma, viewerId, role, departmentId) — R2/D1/D2. Deliberately
// delegates to canUserEditDepartment instead of reimplementing the "ADMIN or
// manager of this department" rule: canEdit and "can see the weekly-hours
// summary" must share exactly one source of truth so they can never diverge
// (this was flagged as a regression risk in the spec — a second copy of the
// same rule is how it would happen). Exported so the same check can gate the
// per-department `summary` block in buildScheduleView (B1) and the per-entry
// `weeklyTargetHours` field in listUserEntries (B3).
export async function canViewSummary(
  prisma: Prisma.TransactionClient,
  viewerId: string,
  role: string,
  departmentId: string | null | undefined,
): Promise<boolean> {
  return canUserEditDepartment(prisma, viewerId, role, departmentId);
}

export interface MaskedEntryFields {
  status: string;
  onGuard: boolean;
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
async function loadValidationConfig(prisma: Prisma.TransactionClient, departmentId: string): Promise<ValidationConfig> {
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

async function loadSummerForYear(prisma: Prisma.TransactionClient, year: number): Promise<SummerPeriodLike | null> {
  const summer = await prisma.summerSchedule.findUnique({ where: { year } });
  if (!summer) return null;
  return { year: summer.year, startDate: isoDate(summer.startDate), endDate: isoDate(summer.endDate) };
}

// createSchedule — auto-creates base PRESENCIAL entries (Mon-Fri) for every
// active user in the department.
export async function createSchedule(
  prisma: Prisma.TransactionClient,
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
      departmentId: params.departmentId,
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
  onGuard?: boolean;
  startTime?: string | null;
  endTime?: string | null;
  notes?: string | null;
}

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
      // Prisma reports `meta.target` for a unique-constraint violation as the
      // COLUMN TUPLE the constraint covers (e.g. ['department_id','date']),
      // not the index name — even for a partial index. A naive
      // `.includes('on_guard')` string check against that tuple never
      // matches (confirmed live: `String(['department_id','date'])` is
      // `"department_id,date"`, no 'on_guard' substring), silently falling
      // through to the generic 500 handler instead of the intended 409.
      // schedule_entries_on_guard_unique is the only constraint on exactly
      // (department_id, date). The sibling constraint (scheduleId, userId,
      // date) is Prisma-schema-declared, so Prisma reports ITS violations
      // using the camelCase Prisma field names ('scheduleId'/'userId'), never
      // the snake_case DB column 'department_id' — so this check needs no
      // extra disambiguation against it.
      const target = err?.meta?.target;
      const isGuardUniqueViolation =
        err?.code === 'P2002' &&
        Array.isArray(target) &&
        target.includes('department_id') &&
        target.includes('date');
      if (isGuardUniqueViolation) {
        throw new ScheduleServiceError(409, `Another worker is already on GUARDIA duty on ${e.date} for this department`);
      }
      throw err;
    }
  }
}

// runValidation — computes V1-V7, wipes previous alerts, persists new ones.
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
  const teleworkQuotasByUser = await loadTeleworkQuotas(prisma, userIds);

  const scheduleLike: ScheduleLike = { id: schedule.id, weekStart: isoDate(schedule.weekStart), year: schedule.year };
  const alerts = validate(
    scheduleLike, entriesLike, cfg, summer, teleworkCountsByUser, weeklyTargetsByUser, teleworkQuotasByUser,
  );

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
export async function publish(prisma: Prisma.TransactionClient, scheduleId: string) {
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
export async function unpublish(prisma: Prisma.TransactionClient, scheduleId: string) {
  const schedule = await prisma.staffSchedule.findUnique({ where: { id: scheduleId }, select: { id: true } });
  if (!schedule) throw new ScheduleServiceError(404, 'Schedule not found');
  return prisma.staffSchedule.update({ where: { id: scheduleId }, data: { status: 'DRAFT' } });
}

// syncScheduleMembers — DRAFT only. Adds base PRESENCIAL entries (Mon-Fri) for
// active department members who do not yet have ANY entry in this schedule.
// Never touches existing entries — idempotent and non-destructive, unlike
// deleteSchedule. Added in the v3.5.10 refinement round to cover two related
// gaps: a schedule created/cloned before the department had its final
// membership (entries missing for members added later), and a new hire
// joining a department that already has schedules planned months ahead.
export async function syncScheduleMembers(
  prisma: Prisma.TransactionClient,
  scheduleId: string,
): Promise<{ added: number }> {
  const schedule = await prisma.staffSchedule.findUnique({
    where: { id: scheduleId },
    select: { status: true, departmentId: true, weekStart: true },
  });
  if (!schedule) throw new ScheduleServiceError(404, 'Schedule not found');
  if (schedule.status !== 'DRAFT') {
    throw new ScheduleServiceError(409, 'Cannot sync members on a published schedule; unpublish first');
  }

  const [members, present] = await Promise.all([
    loadDepartmentMembers(prisma, schedule.departmentId),
    prisma.scheduleEntry.findMany({ where: { scheduleId }, distinct: ['userId'], select: { userId: true } }),
  ]);
  const presentIds = new Set(present.map((p) => p.userId));
  const missing = members.filter((m) => !presentIds.has(m.id));

  const entriesData = missing.flatMap((m) =>
    Array.from({ length: 5 }, (_, i) => ({
      scheduleId,
      userId: m.id,
      departmentId: schedule.departmentId,
      date: addDaysUtc(schedule.weekStart, i),
      status: 'PRESENCIAL',
    })),
  );
  if (entriesData.length > 0) {
    await prisma.scheduleEntry.createMany({ data: entriesData });
  }
  return { added: missing.length };
}

// deleteSchedule — DRAFT only (D10: PUBLISHED is immutable; unpublish first).
// ScheduleEntry/ScheduleAlert cascade via onDelete: Cascade in schema.prisma.
// Added in the v3.5.10 refinement round: a schedule cloned/created before the
// department had its final membership had no way to be discarded so the week
// could be re-cloned from scratch.
export async function deleteSchedule(prisma: Prisma.TransactionClient, scheduleId: string): Promise<void> {
  const schedule = await prisma.staffSchedule.findUnique({ where: { id: scheduleId }, select: { status: true } });
  if (!schedule) throw new ScheduleServiceError(404, 'Schedule not found');
  if (schedule.status !== 'DRAFT') {
    throw new ScheduleServiceError(409, 'Cannot delete a published schedule; unpublish first');
  }
  await prisma.staffSchedule.delete({ where: { id: scheduleId } });
}

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
    displayName: string | null;
    entries: Record<string, MaskedEntryFields>;
    // Optional since v3.5.12 (R2/D1): omitted entirely — never sent zeroed —
    // for a viewer who is neither ADMIN nor manager of this row's department.
    // Same precedent as MonthlySummary.healthLeaveDays: the mere presence of
    // the field is informative, so an unauthorized viewer must not see the key.
    summary?: { weeklyNetHours: number; teleworkDaysWeek: number; teleworkDaysMonth: number; travelDays: number; guardDays: number; weeklyTargetHours: number };
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

// Comparador puro para el orden manager-first (v3.5.10 refinamiento).
// Extraído para poder probarlo sin montar toda la maquinaria de
// buildScheduleView (consultas a BD, masking, resúmenes semanales, etc.).
export function sortRowManagerFirst(
  a: { userId: string; displayName: string | null; username: string },
  b: { userId: string; displayName: string | null; username: string },
  managerIds: Set<string>,
): number {
  const aIsManager = managerIds.has(a.userId) ? 0 : 1;
  const bIsManager = managerIds.has(b.userId) ? 0 : 1;
  if (aIsManager !== bIsManager) return aIsManager - bIsManager;
  return (a.displayName ?? a.username).localeCompare(b.displayName ?? b.username);
}

// buildScheduleView — the GET /:id shape (masked per viewer, D4). Also the
// backbone reused by export.ts (which must always receive an already-masked view).
export async function buildScheduleView(
  prisma: Prisma.TransactionClient,
  scheduleId: string,
  viewer: Viewer,
): Promise<ScheduleView | null> {
  // v3.5.10 — La visibilidad se resuelve EN la consulta: VIEWER y AUDITOR solo
  // alcanzan horarios publicados; MANAGER además cualquier estado de los
  // departamentos que gestiona; ADMIN todo. Un horario fuera de alcance
  // devuelve null y el router responde 404 — nunca 403, para no revelar que
  // existe un borrador ajeno.
  const managed = viewer.role === 'ADMIN' ? [] : await loadManagedDepartmentIds(prisma, viewer.id);
  const visibility = buildScheduleVisibilityFilter(viewer.role, managed);

  const schedule = await loadScheduleWithEntries(prisma, scheduleId, visibility);
  if (!schedule) return null;

  const cfg = await loadValidationConfig(prisma, schedule.departmentId);
  const canEdit = await canUserEditDepartment(prisma, viewer.id, viewer.role, schedule.departmentId);
  // R2/D1/D2 — a single schedule belongs to a single department, so this is
  // resolved once for the whole view, not per row.
  const showSummary = await canViewSummary(prisma, viewer.id, viewer.role, schedule.departmentId);

  const days: string[] = Array.from({ length: 5 }, (_, i) => isoDate(addDaysUtc(schedule.weekStart, i)));

  const byUser = new Map<string, { username: string; displayName: string | null; entriesReal: typeof schedule.entries }>();
  for (const e of schedule.entries) {
    if (!byUser.has(e.userId)) {
      byUser.set(e.userId, { username: e.user.username, displayName: e.user.displayName ?? null, entriesReal: [] });
    }
    byUser.get(e.userId)!.entriesReal.push(e);
  }

  const month = schedule.weekStart.getUTCMonth() + 1;
  const weeklyTargetsByUser = await loadWeeklyTargetHours(prisma, Array.from(byUser.keys()), cfg.weeklyTargetNetHours);
  const rows: ScheduleView['rows'] = [];
  for (const [userId, data] of byUser) {
    const entries: Record<string, MaskedEntryFields> = {};
    for (const e of data.entriesReal) {
      entries[isoDate(e.date)] = maskEntryForViewer(
        { status: e.status, startTime: e.startTime, endTime: e.endTime, notes: e.notes, userId: e.userId, onGuard: e.onGuard },
        viewer,
      );
    }

    // Aggregate figures computed from the real (unmasked) data. weeklyNetHours,
    // travelDays and teleworkDaysWeek/Month are keyed off `status` itself
    // (VIAJE / TELETRABAJO / BAJA_* are mutually exclusive status values), so a
    // BAJA_* entry can never contribute to those counters by construction — no
    // extra filtering needed, no health-status information leaks through them.
    // `onGuard`, however, is an orthogonal per-entry flag (Task 4) that can be
    // true on a BAJA_* entry at the same time (nothing currently enforces
    // otherwise; BAJA_CONFLICT is only a non-blocking WARNING). guardDays must
    // therefore explicitly exclude HEALTH_STATUSES entries — without it, a
    // masked health-leave day (shown to a non-owner/non-ADMIN viewer as
    // {status:'AUSENTE', onGuard:false}) could still silently increment a
    // guardDays total they can see, leaking that the masked day was not a
    // normal absence (GDPR Art. 9).
    const weeklyNetHours = data.entriesReal.reduce(
      (sum, e) => sum + computeNetHours(
        { userId: e.userId, date: isoDate(e.date), status: e.status, startTime: e.startTime, endTime: e.endTime },
        cfg,
        schedule.isSummerWeek,
      ),
      0,
    );
    const travelDays = data.entriesReal.filter((e) => e.status === 'VIAJE').length;
    const guardDays = data.entriesReal.filter((e) => e.onGuard && !HEALTH_STATUSES.includes(e.status)).length;
    const teleworkDaysWeek = data.entriesReal.filter((e) => TELEWORK_STATUSES.includes(e.status)).length;
    const teleworkDaysMonth = await countTeleworkThisMonth(prisma, userId, schedule.year, month);
    const weeklyTargetHours = weeklyTargetsByUser[userId] ?? cfg.weeklyTargetNetHours;

    rows.push({
      userId,
      username: data.username,
      displayName: data.displayName,
      entries,
      // Omitted entirely (not sent as `undefined`/zeroed) when the viewer is
      // not authorized — see the `summary?` doc comment on ScheduleView above.
      ...(showSummary
        ? { summary: { weeklyNetHours, teleworkDaysWeek, teleworkDaysMonth, travelDays, guardDays, weeklyTargetHours } }
        : {}),
    });
  }

  // v3.5.10 refinamiento — el responsable del departamento aparece primero;
  // el resto se ordena alfabéticamente por nombre para mostrar. Antes las
  // filas salían en el orden de iteración del Map (efectivamente por userId,
  // un UUID sin significado para el usuario).
  const managerIds = await loadDepartmentManagerIds(prisma, schedule.departmentId);
  rows.sort((a, b) => sortRowManagerFirst(a, b, managerIds));

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
  prisma: Prisma.TransactionClient,
  userId: string,
  year: number,
  month: number,
  viewer: Viewer,
): Promise<MonthlySummary> {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  // v3.5.10 — El resumen mensual solo agrega horarios que el visor tiene
  // derecho a ver, filtrando por la relación en la propia consulta. Excepción
  // deliberada: el propio usuario ve siempre su resumen completo (son sus
  // datos), igual que el ADMIN.
  const isSelfOrAdmin = viewer.role === 'ADMIN' || viewer.id === userId;
  const managed = isSelfOrAdmin ? [] : await loadManagedDepartmentIds(prisma, viewer.id);
  const scheduleFilter = isSelfOrAdmin
    ? {}
    : buildScheduleVisibilityFilter(viewer.role, managed);

  const entries = await prisma.scheduleEntry.findMany({
    where: { userId, date: { gte: start, lt: end }, schedule: scheduleFilter },
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
    teleworkDays: count((s) => TELEWORK_STATUSES.includes(s)),
    travelDays: count((s) => s === 'VIAJE'),
    // onGuard is orthogonal to status (Task 4) and can be true on a BAJA_*
    // (health-leave) entry — exclude HEALTH_STATUSES entries so this count
    // never leaks masked health-leave information to non-owner/non-ADMIN viewers.
    guardDays: entries.filter((e) => e.onGuard && !HEALTH_STATUSES.includes(e.status)).length,
    vacationDays: count((s) => s === 'VACACIONES'),
  };
  if (isAuthorized) {
    summary.healthLeaveDays = count((s) => HEALTH_STATUSES.includes(s));
  }
  return summary;
}
