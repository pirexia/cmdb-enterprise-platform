import type { PrismaClient } from '@prisma/client';

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
