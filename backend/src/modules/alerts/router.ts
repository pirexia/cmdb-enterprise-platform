import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AlertConfigUpdateSchema, AlertRuleUpdateSchema, CategoryParamSchema } from './schemas.js';
import { getConfig, getRules, getHistory, upsertConfig, upsertRule } from './queries.js';
import { scanAlerts } from './engine.js';
import { buildAlertHtml } from './email-builder.js';
import { sendEmail, smtpConfigured } from './smtp-transport.js';
import { insertAlertAudit } from './audit.js';
import { runAlertsPipeline } from './pipeline.js';
import type { AlertLocale } from './schemas.js';

function requireAdmin(req: Request, res: Response, next: () => void): void {
  if ((req as Request & { user?: { role?: string } }).user?.role !== 'ADMIN') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
}

function userEmail(req: Request): string {
  return (req as Request & { user?: { email?: string } }).user?.email ?? 'unknown';
}

export function createAlertsRouter(prisma: PrismaClient): Router {
  const router = Router();

  // All routes in this module require ADMIN
  router.use(requireAdmin);

  // ── GET /api/alerts/config ────────────────────────────────────────────────
  router.get('/config', async (_req: Request, res: Response): Promise<void> => {
    try {
      const config = await getConfig(prisma);
      // Never expose SMTP credentials in the response (A02)
      res.json({
        ...config,
        smtpConfigured: smtpConfigured(),
        smtpHost:  process.env.SMTP_HOST  ? process.env.SMTP_HOST  : null,
        smtpPort:  process.env.SMTP_PORT  ? parseInt(process.env.SMTP_PORT, 10) : null,
      });
    } catch {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── PUT /api/alerts/config ────────────────────────────────────────────────
  router.put('/config', async (req: Request, res: Response): Promise<void> => {
    const parsed = AlertConfigUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', details: parsed.error.flatten() });
      return;
    }
    try {
      const config = await upsertConfig(prisma, parsed.data);
      await insertAlertAudit(prisma, 'UPDATE_ALERT_CONFIG', userEmail(req), 'default');
      res.json(config);
    } catch {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/alerts/rules ─────────────────────────────────────────────────
  router.get('/rules', async (_req: Request, res: Response): Promise<void> => {
    try {
      res.json(await getRules(prisma));
    } catch {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── PUT /api/alerts/rules/:category ──────────────────────────────────────
  router.put('/rules/:category', async (req: Request, res: Response): Promise<void> => {
    const catParsed = CategoryParamSchema.safeParse(req.params);
    if (!catParsed.success) {
      res.status(400).json({ error: 'Invalid category' });
      return;
    }
    const bodyParsed = AlertRuleUpdateSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: 'Validation error', details: bodyParsed.error.flatten() });
      return;
    }
    try {
      const rule = await upsertRule(prisma, catParsed.data.category, bodyParsed.data);
      await insertAlertAudit(prisma, 'UPDATE_ALERT_RULE', userEmail(req), catParsed.data.category);
      res.json(rule);
    } catch {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── POST /api/alerts/test ─────────────────────────────────────────────────
  // Builds and sends a test email from current data — ignores suppressUnchanged
  router.post('/test', async (req: Request, res: Response): Promise<void> => {
    try {
      const config = await getConfig(prisma);
      const rules  = await getRules(prisma);
      const scan   = await scanAlerts(prisma, rules);

      const locale     = (config.locale ?? 'es') as AlertLocale;
      const html       = buildAlertHtml(scan, locale);
      const recipients = (req.body?.recipients as string[] | undefined)
        ?? [...(config.recipients ?? []), ...(process.env.ALERT_RECIPIENT ? [process.env.ALERT_RECIPIENT] : [])];

      if (recipients.length === 0) {
        res.status(422).json({ error: 'No recipients configured. Set recipients in config or ALERT_RECIPIENT env var.' });
        return;
      }

      const validated = z.array(z.string().email()).safeParse(recipients);
      if (!validated.success) {
        res.status(400).json({ error: 'Invalid recipient email(s)' });
        return;
      }

      const date    = new Date().toLocaleDateString('es-ES');
      const subject = `[TEST] ⚠️ CMDB Alert Report — ${date}`;
      const result  = await sendEmail(html, subject, validated.data);

      await insertAlertAudit(prisma, 'ALERT_TEST_SEND', userEmail(req), 'default');

      res.json({
        status:      'SENT',
        totalAlerts: scan.items.length,
        breakdown:   scan.breakdown,
        messageId:   result.messageId,
        accepted:    result.accepted,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.error('[alerts:test]', msg);
      res.status(500).json({ error: 'Failed to send test email', detail: msg });
    }
  });

  // ── POST /api/alerts/run-now ──────────────────────────────────────────────
  // Full pipeline run, dedup bypassed (MANUAL trigger)
  router.post('/run-now', async (req: Request, res: Response): Promise<void> => {
    try {
      await insertAlertAudit(prisma, 'ALERT_RUN_NOW', userEmail(req), 'default');
      const result = await runAlertsPipeline(prisma, 'MANUAL', true);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.error('[alerts:run-now]', msg);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/alerts/history ───────────────────────────────────────────────
  router.get('/history', async (req: Request, res: Response): Promise<void> => {
    try {
      const limit = Math.min(parseInt((req.query['limit'] as string) ?? '50', 10) || 50, 200);
      res.json(await getHistory(prisma, limit));
    } catch {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
