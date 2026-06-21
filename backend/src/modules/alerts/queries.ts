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
  // Separate new fields (Prisma client not yet regenerated for T8 columns)
  const { teamsWebhookUrl, slackBotToken, slackChannel, ...ormData } = data;

  const config = await prisma.alertConfig.upsert({
    where:  { id: 'default' },
    create: { id: 'default', ...ormData },
    update: ormData,
  });

  // Persist notify-channel fields via raw SQL if any are provided
  const hasChannelUpdate = teamsWebhookUrl !== undefined || slackBotToken !== undefined || slackChannel !== undefined;
  if (hasChannelUpdate) {
    await prisma.$executeRaw`
      UPDATE "alert_config" SET
        teams_webhook_url = COALESCE(${teamsWebhookUrl ?? null}, teams_webhook_url),
        slack_bot_token   = COALESCE(${slackBotToken   ?? null}, slack_bot_token),
        slack_channel     = COALESCE(${slackChannel     ?? null}, slack_channel)
      WHERE id = 'default'`;
  }

  return config;
}

export async function upsertRule(prisma: PrismaClient, category: string, data: AlertRuleUpdate) {
  // Separate channels field (Prisma client not yet regenerated for T8 column)
  const { channels, ...ormData } = data;

  const rule = await prisma.alertRule.upsert({
    where:  { category },
    create: { category, ...ormData },
    update: ormData,
  });

  if (channels !== undefined) {
    await prisma.$executeRaw`
      UPDATE "alert_rules" SET channels = ${channels}::text[]
      WHERE category = ${category}`;
  }

  return rule;
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
