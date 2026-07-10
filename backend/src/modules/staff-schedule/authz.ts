import { Prisma } from '@prisma/client';

// Shared row-level authorization check (D3): an ADMIN can always edit; a
// non-ADMIN can edit only departments they manage (DepartmentManager row).
// Used by both middleware.ts (as a gate) and service.ts (to compute the
// `canEdit` field returned to the client — never trust the client to hide
// controls on its own). Accepts a transaction client so it can run inside a
// write transaction as well as standalone (issue #172).
export async function canUserEditDepartment(
  prisma: Prisma.TransactionClient,
  userId: string,
  role: string,
  departmentId: string | null | undefined,
): Promise<boolean> {
  if (role === 'ADMIN') return true;
  if (!departmentId) return false;
  const mgr = await prisma.departmentManager.findFirst({
    where: { departmentId, userId },
    select: { id: true },
  });
  return !!mgr;
}
