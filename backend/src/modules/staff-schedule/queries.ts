import { Prisma } from '@prisma/client';
import { TELEWORK_STATUSES } from './schemas.js';
import type { TeleworkQuota } from './validationEngine.js';

// Client type accepted by every query helper: the base PrismaClient OR an
// interactive transaction client. Read helpers can run inside a transaction
// alongside a write + its audit insert (issue #172), so they must accept `tx`.
type Db = Prisma.TransactionClient;

// Load a schedule with its entries (incl. user id/username) and alerts.
// Returns null if the schedule does not exist OR si el visor no tiene derecho a
// verlo: el filtro de visibilidad viaja EN la cláusula WHERE (v3.5.10), de modo
// que un borrador ajeno es indistinguible de uno inexistente (404, nunca 403 —
// no se revela su existencia). El default vacío conserva el comportamiento de
// los llamantes internos que ya han validado el acceso por otra vía.
export async function loadScheduleWithEntries(
  prisma: Db,
  scheduleId: string,
  visibility: Prisma.StaffScheduleWhereInput = {},
) {
  return prisma.staffSchedule.findFirst({
    where: { AND: [{ id: scheduleId }, visibility] },
    include: {
      entries: {
        include: { user: { select: { id: true, username: true, displayName: true } } },
        orderBy: [{ userId: 'asc' }, { date: 'asc' }],
      },
      alerts: { orderBy: [{ severity: 'asc' }, { createdAt: 'asc' }] },
    },
  });
}

// Count telework entries for a user within a given calendar month.
// A user belongs to exactly one department, so we can filter directly on
// userId + date range without needing to join back through the department.
export async function countTeleworkThisMonth(
  prisma: Db,
  userId: string,
  year: number,
  month: number, // 1-12
): Promise<number> {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1)); // first day of next month (exclusive)
  return prisma.scheduleEntry.count({
    where: {
      userId,
      // Every remote status consumes the quota, including the intensive
      // (continuous) remote shift added in v3.5.11.
      status: { in: [...TELEWORK_STATUSES] },
      date: { gte: start, lt: end },
    },
  });
}

// All active users belonging to a department (used to auto-populate a new
// weekly schedule's base entries).
export async function loadDepartmentUsers(prisma: Db, departmentId: string) {
  return prisma.user.findMany({
    where: { departmentId, active: true },
    select: { id: true, username: true, displayName: true },
    orderBy: { username: 'asc' },
  });
}

// ── Visibilidad de horarios por rol (v3.5.10) ────────────────────────────────
// Se aplica SIEMPRE en la cláusula WHERE de Prisma, nunca por post-filtrado en
// memoria: los controles de acceso a filas deben ser filtros de BD (A01).
//
//   ADMIN            → sin filtro (ve, crea, edita y publica en todos)
//   MANAGER          → publicados de todos + cualquier estado de sus departamentos
//   VIEWER / AUDITOR → solo publicados
//
// Un rol desconocido cae en la rama más restrictiva por diseño (fail-closed):
// añadir un rol nuevo al enum sin tocar esta función no abre datos por accidente.
export function buildScheduleVisibilityFilter(
  role: string,
  managedDepartmentIds: string[],
): Prisma.StaffScheduleWhereInput {
  if (role === 'ADMIN') return {};
  if (role === 'MANAGER' && managedDepartmentIds.length > 0) {
    return { OR: [{ status: 'PUBLISHED' }, { departmentId: { in: managedDepartmentIds } }] };
  }
  return { status: 'PUBLISHED' };
}

// Departamentos que el usuario gestiona (filas DepartmentManager). No se llama
// para ADMIN: su filtro es vacío y no necesita la consulta.
export async function loadManagedDepartmentIds(prisma: Db, userId: string): Promise<string[]> {
  const rows = await prisma.departmentManager.findMany({
    where: { userId },
    select: { departmentId: true },
  });
  return rows.map((r) => r.departmentId);
}

// ── Managers y miembros de un departamento (v3.5.10 refinamiento) ───────────
// El panel de configuración necesitaba mostrar quién gestiona el departamento
// y quién pertenece a él; no existía ningún GET para ninguna de las dos cosas.

export interface DepartmentManagerInfo {
  id: string;
  username: string;
  displayName: string | null;
  email: string;
}

export async function loadDepartmentManagers(prisma: Db, departmentId: string): Promise<DepartmentManagerInfo[]> {
  const rows = await prisma.departmentManager.findMany({
    where: { departmentId },
    select: { user: { select: { id: true, username: true, displayName: true, email: true } } },
  });
  return rows.map((r) => r.user);
}

export interface DepartmentMemberInfo {
  id: string;
  username: string;
  displayName: string | null;
  email: string;
  weeklyTargetHours: number | null;
  teleworkFull: boolean;
  teleworkQuotaDays: number | null;
  teleworkQuotaPct: number | null;
}

export async function loadDepartmentMembers(prisma: Db, departmentId: string): Promise<DepartmentMemberInfo[]> {
  return prisma.user.findMany({
    where: { departmentId, active: true },
    select: {
      id: true, username: true, displayName: true, email: true, weeklyTargetHours: true,
      teleworkFull: true, teleworkQuotaDays: true, teleworkQuotaPct: true,
    },
    orderBy: { username: 'asc' },
  });
}

// Per-user telework quota overrides, keyed by user id. Users without a row in
// the result simply fall back to the department cap (resolveTeleworkCap).
export async function loadTeleworkQuotas(
  prisma: Db,
  userIds: string[],
): Promise<Record<string, TeleworkQuota>> {
  if (userIds.length === 0) return {};
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, teleworkFull: true, teleworkQuotaDays: true, teleworkQuotaPct: true },
  });
  const map: Record<string, TeleworkQuota> = {};
  for (const u of users) {
    map[u.id] = {
      teleworkFull: u.teleworkFull,
      teleworkQuotaDays: u.teleworkQuotaDays,
      teleworkQuotaPct: u.teleworkQuotaPct,
    };
  }
  return map;
}

// Solo los userId de los managers — usado para el ordenado manager-first de
// buildScheduleView, donde no hace falta el resto de campos.
export async function loadDepartmentManagerIds(prisma: Db, departmentId: string): Promise<Set<string>> {
  const rows = await prisma.departmentManager.findMany({
    where: { departmentId },
    select: { userId: true },
  });
  return new Set(rows.map((r) => r.userId));
}

// ── Entradas de un trabajador por rango (v3.5.12, R5/D6) ────────────────────
// Same visibility principle as every other read path in this module: the
// caller passes the already-built `buildScheduleVisibilityFilter(...)` result
// and it is applied IN the WHERE clause via the `schedule` relation filter,
// never post-filtered in memory (A01). A worker can belong to a different
// department at different points across the range (reassignment), so each
// row carries its own (denormalized) departmentId + department name rather
// than a single department for the whole result.

export interface UserEntryRangeRow {
  id: string;
  date: Date;
  status: string;
  onGuard: boolean;
  startTime: string | null;
  endTime: string | null;
  notes: string | null;
  userId: string;
  departmentId: string;
  department: { id: string; name: string };
}

export async function loadUserEntriesInRange(
  prisma: Db,
  userId: string,
  from: Date,
  to: Date,
  visibility: Prisma.StaffScheduleWhereInput,
): Promise<UserEntryRangeRow[]> {
  return prisma.scheduleEntry.findMany({
    where: {
      userId,
      date: { gte: from, lte: to },
      schedule: visibility,
    },
    include: { department: { select: { id: true, name: true } } },
    orderBy: { date: 'asc' },
  });
}

// ── Worker search selector (v3.5.12, R5/D4) ─────────────────────────────────
// GDPR Art. 5.1.c minimisation: the selector needs a label to show and an id
// to key off, nothing else — email is deliberately NOT selected. Only users
// this module can ever schedule are searchable (active + assigned to a
// department); a Prisma `contains` is already parametrized, so no manual
// escaping of `%`/`_` is needed here (that rule targets raw SQL LIKE).

export interface ScheduleUserSearchResult {
  id: string;
  username: string;
  displayName: string | null;
}

export async function searchScheduleUsers(
  prisma: Db,
  q: string,
  limit = 20,
): Promise<ScheduleUserSearchResult[]> {
  const take = Math.max(1, Math.min(limit, 20));
  return prisma.user.findMany({
    where: {
      active: true,
      departmentId: { not: null },
      OR: [
        { username: { contains: q, mode: 'insensitive' } },
        { displayName: { contains: q, mode: 'insensitive' } },
      ],
    },
    select: { id: true, username: true, displayName: true },
    orderBy: { username: 'asc' },
    take,
  });
}

// Override EXPLÍCITO de horas semanales por trabajador (v3.5.13). Devuelve
// null para quien no lo tenga fijado. Sustituye a la loadWeeklyTargetHours
// anterior (override-o-defecto): esa resolución ya no vale, porque no permite
// distinguir "35h pactadas" de "el valor por defecto del departamento resulta
// ser 35" — distinción necesaria desde que computeEffectiveWeeklyTarget suma
// los días planificados en vez de restar sobre un valor plano.
export async function loadWeeklyTargetOverrides(
  prisma: Db,
  userIds: string[],
): Promise<Record<string, number | null>> {
  if (userIds.length === 0) return {};
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, weeklyTargetHours: true },
  });
  const map: Record<string, number | null> = {};
  for (const u of users) map[u.id] = u.weeklyTargetHours ?? null;
  return map;
}
