import type { PrismaClient } from '@prisma/client';
import type { AlertConfigUpdate, AlertRuleUpdate } from './schemas.js';

export async function getConfig(prisma: PrismaClient) {
  let config = await prisma.alertConfig.findUnique({ where: { id: 'default' } });
  if (!config) {
    config = await prisma.alertConfig.create({ data: { id: 'default' } });
  }
  return config;
}

export async function getRules(prisma: PrismaClient) {
  return prisma.alertRule.findMany({ orderBy: { category: 'asc' } });
}

export async function getHistory(prisma: PrismaClient, limit = 50) {
  return prisma.alertRun.findMany({ orderBy: { startedAt: 'desc' }, take: limit });
}

export async function getLastSuccessfulRun(prisma: PrismaClient) {
  return prisma.alertRun.findFirst({
    where:   { status: { in: ['SENT', 'ALL_CLEAR'] } },
    orderBy: { startedAt: 'desc' },
  });
}

export async function upsertConfig(prisma: PrismaClient, data: AlertConfigUpdate) {
  return prisma.alertConfig.upsert({
    where:  { id: 'default' },
    create: { id: 'default', ...data },
    update: data,
  });
}

export async function upsertRule(prisma: PrismaClient, category: string, data: AlertRuleUpdate) {
  return prisma.alertRule.upsert({
    where:  { category },
    create: { category, ...data },
    update: data,
  });
}

export async function createRun(prisma: PrismaClient, data: {
  trigger:     string;
  status:      string;
  totalAlerts: number;
  breakdown:   object;
  recipients:  string[];
  messageId?:  string | null;
  errorMsg?:   string | null;
  finishedAt?: Date;
}) {
  return prisma.alertRun.create({ data });
}
