import { PrismaClient } from '@prisma/client';

// Load a schedule with its entries (incl. user id/username) and alerts.
// Returns null if the schedule does not exist.
export async function loadScheduleWithEntries(prisma: PrismaClient, scheduleId: string) {
  return prisma.staffSchedule.findUnique({
    where: { id: scheduleId },
    include: {
      entries: {
        include: { user: { select: { id: true, username: true } } },
        orderBy: [{ userId: 'asc' }, { date: 'asc' }],
      },
      alerts: { orderBy: [{ severity: 'asc' }, { createdAt: 'asc' }] },
    },
  });
}

// Count TELETRABAJO entries for a user within a given calendar month.
// A user belongs to exactly one department, so we can filter directly on
// userId + date range without needing to join back through the department.
export async function countTeleworkThisMonth(
  prisma: PrismaClient,
  userId: string,
  year: number,
  month: number, // 1-12
): Promise<number> {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1)); // first day of next month (exclusive)
  return prisma.scheduleEntry.count({
    where: {
      userId,
      status: 'TELETRABAJO',
      date: { gte: start, lt: end },
    },
  });
}

// All active users belonging to a department (used to auto-populate a new
// weekly schedule's base entries).
export async function loadDepartmentUsers(prisma: PrismaClient, departmentId: string) {
  return prisma.user.findMany({
    where: { departmentId, active: true },
    select: { id: true, username: true },
    orderBy: { username: 'asc' },
  });
}
