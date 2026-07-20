import { Prisma } from '@prisma/client';
import type { PluginStatus } from './schemas.js';

// Widened to Prisma.TransactionClient (issue #172) — the base PrismaClient is
// also assignable to it, so these helpers work both standalone and when
// passed the `tx` client from inside a `prisma.$transaction(async (tx) => {})`.
export async function getActivePlugins(prisma: Prisma.TransactionClient) {
  return prisma.pluginRegistry.findMany({
    where: { status: 'ACTIVE' },
    include: { hooks: true, cronJobs: true, routes: true },
  });
}

export async function setPluginStatus(
  prisma: Prisma.TransactionClient,
  id: string,
  status: PluginStatus,
  lastError?: string | null,
) {
  return prisma.pluginRegistry.update({
    where: { id },
    data: { status, lastError: lastError ?? null, updatedAt: new Date() },
  });
}

export async function createBackupRecord(
  prisma: Prisma.TransactionClient,
  pluginId: string,
  backupPath: string,
  sizeBytes: number,
  reason: string,
) {
  return prisma.pluginDataBackup.create({
    data: { pluginId, backupPath, sizeBytes, reason },
  });
}
