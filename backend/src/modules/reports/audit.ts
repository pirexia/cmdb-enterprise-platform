import type { PrismaClient } from '@prisma/client';

// NOTE (issue #172): both functions below log *read access* (VIEW_REPORT /
// EXPORT_REPORT). Reports are read-only — no business data is mutated — so a
// failed audit insert is a monitoring gap (A.9 logging), never an "unlogged
// write". That's why the error is swallowed here (best-effort access logging
// that must not break a legitimate read/export). Do NOT copy this swallow
// pattern into modules that mutate data: those must run the mutation and its
// audit insert in a single transaction (see modules/staff-schedule/audit.ts +
// router.ts) so the two commit or roll back together.

export async function logReportView(
  prisma: PrismaClient,
  userEmail: string,
  reportId: string,
  filters: Record<string, unknown>,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: 'VIEW_REPORT',
        entity: 'report',
        entityId: reportId,
        userEmail,
        details: JSON.stringify({ filters }),
      },
    });
  } catch {
    // Non-blocking — log internally only
    console.error('[reports] audit VIEW_REPORT failed for', reportId);
  }
}

export async function logReportExport(
  prisma: PrismaClient,
  userEmail: string,
  reportId: string,
  format: string,
  filters: Record<string, unknown>,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: 'EXPORT_REPORT',
        entity: 'report',
        entityId: reportId,
        userEmail,
        details: JSON.stringify({ format, filters }),
      },
    });
  } catch {
    console.error('[reports] audit EXPORT_REPORT failed for', reportId);
  }
}
