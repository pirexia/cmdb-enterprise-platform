import type { PrismaClient } from '@prisma/client';
import type { AlertLocale } from './schemas.js';
import { getConfig, getRules, getLastSuccessfulRun, createRun } from './queries.js';
import { scanAlerts } from './engine.js';
import { buildAlertHtml } from './email-builder.js';
import { sendEmail } from './smtp-transport.js';
import { insertAlertAudit } from './audit.js';

export interface PipelineResult {
  runId:       string;
  status:      'SENT' | 'ALL_CLEAR' | 'SKIPPED' | 'FAILED';
  totalAlerts: number;
  breakdown:   Record<string, number>;
  messageId?:  string;
  errorMsg?:   string;
}

export async function runAlertsPipeline(
  prisma:           PrismaClient,
  trigger:          'CRON' | 'MANUAL',
  forceIgnoreDedup: boolean = false,
): Promise<PipelineResult> {
  const startedAt = new Date();
  const config    = await getConfig(prisma);
  const rules     = await getRules(prisma);

  if (!config.enabled && trigger === 'CRON') {
    const run = await createRun(prisma, {
      trigger, status: 'SKIPPED', totalAlerts: 0, breakdown: {},
      recipients: [], finishedAt: new Date(),
    });
    return { runId: run.id, status: 'SKIPPED', totalAlerts: 0, breakdown: {} };
  }

  const scan = await scanAlerts(prisma, rules);

  // Dedup: skip if fingerprint matches last successful run (CRON only)
  if (trigger === 'CRON' && config.suppressUnchanged && !forceIgnoreDedup) {
    const last = await getLastSuccessfulRun(prisma);
    if (last) {
      const lastFp = (last.breakdown as Record<string, unknown>)['fingerprint'];
      if (lastFp === scan.fingerprint) {
        const run = await createRun(prisma, {
          trigger, status: 'SKIPPED', totalAlerts: scan.items.length,
          breakdown: { ...scan.breakdown, fingerprint: scan.fingerprint },
          recipients: [], finishedAt: new Date(),
        });
        return { runId: run.id, status: 'SKIPPED', totalAlerts: scan.items.length, breakdown: scan.breakdown };
      }
    }
  }

  // Resolve recipients
  const globalRecipients = config.recipients ?? [];
  const ruleRecipients   = rules.flatMap((r) => r.recipients);
  const allRecipients    = [...new Set([...globalRecipients, ...ruleRecipients])];

  if (allRecipients.length === 0 && scan.items.length === 0 && !config.sendAllClear) {
    const run = await createRun(prisma, {
      trigger, status: 'SKIPPED', totalAlerts: 0,
      breakdown: { ...scan.breakdown, fingerprint: scan.fingerprint },
      recipients: [], finishedAt: new Date(),
    });
    return { runId: run.id, status: 'SKIPPED', totalAlerts: 0, breakdown: {} };
  }

  if (scan.items.length === 0 && !config.sendAllClear) {
    const run = await createRun(prisma, {
      trigger, status: 'ALL_CLEAR', totalAlerts: 0,
      breakdown: { ...scan.breakdown, fingerprint: scan.fingerprint },
      recipients: allRecipients, finishedAt: new Date(),
    });
    return { runId: run.id, status: 'ALL_CLEAR', totalAlerts: 0, breakdown: {} };
  }

  const locale = (config.locale ?? 'es') as AlertLocale;
  const html   = buildAlertHtml(scan, locale);
  const total  = scan.items.length;

  const dateLabel = startedAt.toLocaleDateString('es-ES');
  const subject   = total === 0
    ? `✅ CMDB — All clear (${dateLabel})`
    : `⚠️ CMDB — ${total} alert(s) (${dateLabel})`;

  try {
    const recipients = allRecipients.length > 0
      ? allRecipients
      : [process.env.ALERT_RECIPIENT ?? ''].filter(Boolean);

    const { messageId } = await sendEmail(html, subject, recipients);

    const status = total === 0 ? 'ALL_CLEAR' : 'SENT';
    const run    = await createRun(prisma, {
      trigger, status, totalAlerts: total,
      breakdown: { ...scan.breakdown, fingerprint: scan.fingerprint },
      recipients, messageId, finishedAt: new Date(),
    });

    await insertAlertAudit(prisma, 'ALERT_CRON_RUN', 'system', run.id);

    return { runId: run.id, status, totalAlerts: total, breakdown: scan.breakdown, messageId };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const run = await createRun(prisma, {
      trigger, status: 'FAILED', totalAlerts: total,
      breakdown: { ...scan.breakdown, fingerprint: scan.fingerprint },
      recipients: allRecipients, errorMsg, finishedAt: new Date(),
    });
    return { runId: run.id, status: 'FAILED', totalAlerts: total, breakdown: scan.breakdown, errorMsg };
  }
}
