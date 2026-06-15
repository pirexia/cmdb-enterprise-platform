import cron from 'node-cron';
import type { PrismaClient } from '@prisma/client';
import { getConfig } from './queries.js';
import { runAlertsPipeline } from './pipeline.js';

// 5-minute cache so hourly ticks don't hit DB every time the time doesn't match
let cachedConfig: { value: Awaited<ReturnType<typeof getConfig>>; at: number } | null = null;
const CONFIG_CACHE_MS = 5 * 60 * 1000;

async function getCachedConfig(prisma: PrismaClient) {
  if (cachedConfig && Date.now() - cachedConfig.at < CONFIG_CACHE_MS) {
    return cachedConfig.value;
  }
  const value  = await getConfig(prisma);
  cachedConfig = { value, at: Date.now() };
  return value;
}

function getHourMinuteInTz(date: Date, tz: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour:     '2-digit',
    minute:   '2-digit',
    hour12:   false,
  }).formatToParts(date);
  return {
    hour:   parseInt(parts.find((p) => p.type === 'hour')?.value   ?? '0', 10),
    minute: parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10),
  };
}

async function alreadyRanToday(prisma: PrismaClient, tz: string): Promise<boolean> {
  // Compute midnight of today in the configured timezone as a UTC timestamp
  const now    = new Date();
  const ymParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const y = ymParts.find((p) => p.type === 'year')?.value;
  const m = ymParts.find((p) => p.type === 'month')?.value;
  const d = ymParts.find((p) => p.type === 'day')?.value;
  // Parse "YYYY-MM-DD 00:00:00" in that timezone
  const midnightLocal = new Date(`${y}-${m}-${d}T00:00:00`);
  // Adjust to get true UTC midnight for that tz
  const tzOffset = new Date(midnightLocal.toLocaleString('en-US', { timeZone: tz })).getTime()
                 - new Date(midnightLocal.toLocaleString('en-US', { timeZone: 'UTC' })).getTime();
  const todayStartUtc = new Date(midnightLocal.getTime() - tzOffset);

  const existing = await prisma.alertRun.findFirst({
    where: {
      startedAt: { gte: todayStartUtc },
      status:    { in: ['SENT', 'ALL_CLEAR', 'SKIPPED'] },
    },
  });
  return existing !== null;
}

async function hourlyTick(prisma: PrismaClient): Promise<void> {
  try {
    const config = await getCachedConfig(prisma);

    if (!config.enabled) return;

    const tz = config.timezone ?? 'UTC';
    const { hour, minute } = getHourMinuteInTz(new Date(), tz);

    if (hour !== config.sendTimeHour || minute !== config.sendTimeMinute) return;

    // Idempotent guard: don't fire twice in the same day
    if (await alreadyRanToday(prisma, tz)) {
      console.log('[alerts:scheduler] already ran today — skipping');
      return;
    }

    // Invalidate cache so next tick reads fresh config
    cachedConfig = null;

    console.log(`[alerts:scheduler] CRON firing at ${new Date().toISOString()}`);
    const result = await runAlertsPipeline(prisma, 'CRON');
    console.log(`[alerts:scheduler] done — status=${result.status} total=${result.totalAlerts}`);
  } catch (err) {
    console.error('[alerts:scheduler] uncaught error:', err instanceof Error ? err.message : String(err));
  }
}

export function startAlertScheduler(prisma: PrismaClient): void {
  // Tick every minute so we can match the configured HH:MM precisely
  cron.schedule('* * * * *', () => {
    hourlyTick(prisma).catch((e) =>
      console.error('[alerts:scheduler] tick error:', e instanceof Error ? e.message : String(e)),
    );
  });
  console.log('[alerts:scheduler] started — checks every minute against DB-configured send time');
}
