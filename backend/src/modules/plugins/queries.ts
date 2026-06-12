import { PrismaClient } from '@prisma/client';
import type { PluginStatus } from './schemas.js';

export async function getActivePlugins(prisma: PrismaClient) {
  return prisma.pluginRegistry.findMany({
    where: { status: 'ACTIVE' },
    include: { hooks: true, cronJobs: true, routes: true },
  });
}

export async function setPluginStatus(
  prisma: PrismaClient,
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
  prisma: PrismaClient,
  pluginId: string,
  backupPath: string,
  sizeBytes: number,
  reason: string,
) {
  return prisma.pluginDataBackup.create({
    data: { pluginId, backupPath, sizeBytes, reason },
  });
}
