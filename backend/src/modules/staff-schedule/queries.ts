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
