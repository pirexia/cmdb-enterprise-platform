import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { scanAlerts }    from '../alerts/engine.js';
import { buildAlertHtml } from '../alerts/email-builder.js';
import { getConfig, getRules, getLastSuccessfulRun, createRun } from '../alerts/queries.js';
import { insertAlertAudit } from '../alerts/audit.js';
import type { AlertLocale } from '../alerts/schemas.js';

const RecordRunSchema = z.object({
  trigger:     z.enum(['CRON', 'MANUAL']),
  status:      z.enum(['SENT', 'ALL_CLEAR', 'SKIPPED', 'FAILED']),
  totalAlerts: z.number().int().min(0),
  breakdown:   z.record(z.unknown()),
  recipients:  z.array(z.string().email()),
  messageId:   z.string().optional(),
  errorMsg:    z.string().optional(),
});

/**
 * Endpoints internos de alertas — solo accesibles via M2M (X-CMDB-Service-Token).
 * Llamados por el workflow n8n "Alertas CMDB".
 *
 * GET  /api/internal/alerts/scan   — Escanea alertas y devuelve HTML+payload
 *                                    sin enviar email ni registrar run.
 * POST /api/internal/alerts/record — Registra el resultado de un run ejecutado
 *                                    por n8n (audit log + alert_run).
 */
export function createInternalAlertsRouter(prisma: PrismaClient): Router {
  const router = Router();

  // ── GET /api/internal/alerts/scan ────────────────────────────────────────────
  // n8n llama a este endpoint cada vez que el Schedule Trigger activa el workflow.
  // Devuelve todo lo que n8n necesita para decidir si enviar el email y cómo.
  //
  // Campos de respuesta:
  //   shouldSend  — false si está desactivado, ya se ejecutó hoy, o dedup activo
  //   reason      — motivo humano de shouldSend=false (para el log de n8n)
  //   subject     — asunto del email ya formateado
  //   htmlBody    — HTML completo del email (generado por email-builder.ts + i18n)
  //   recipients  — lista de emails destinatarios (global + reglas)
  //   breakdown   — desglose por categoría (para el registro posterior)
  //   fingerprint — hash del estado para dedup en el siguiente run
  //   totalAlerts — número de alertas encontradas
  router.get('/scan', async (_req: Request, res: Response): Promise<void> => {
    try {
      const config = await getConfig(prisma);
      const rules  = await getRules(prisma);

      if (!config.enabled) {
        res.json({ shouldSend: false, reason: 'alerts_disabled', totalAlerts: 0, breakdown: {}, recipients: [], htmlBody: '', subject: '', fingerprint: '' });
        return;
      }

      const scan = await scanAlerts(prisma, rules);

      // Dedup: si la huella coincide con el último run exitoso, no enviar de nuevo
      if (config.suppressUnchanged) {
        const last = await getLastSuccessfulRun(prisma);
        if (last) {
          const lastFp = (last.breakdown as Record<string, unknown>)['fingerprint'];
          if (lastFp === scan.fingerprint) {
            res.json({ shouldSend: false, reason: 'fingerprint_unchanged', totalAlerts: scan.items.length, breakdown: scan.breakdown, recipients: [], htmlBody: '', subject: '', fingerprint: scan.fingerprint });
            return;
          }
        }
      }

      const globalRecipients = config.recipients ?? [];
      const ruleRecipients   = rules.flatMap((r) => r.recipients);
      const allRecipients    = [...new Set([...globalRecipients, ...ruleRecipients])];

      if (allRecipients.length === 0 && scan.items.length === 0 && !config.sendAllClear) {
        res.json({ shouldSend: false, reason: 'no_recipients_no_alerts', totalAlerts: 0, breakdown: {}, recipients: [], htmlBody: '', subject: '', fingerprint: scan.fingerprint });
        return;
      }

      if (scan.items.length === 0 && !config.sendAllClear) {
        res.json({ shouldSend: false, reason: 'all_clear_suppressed', totalAlerts: 0, breakdown: scan.breakdown, recipients: allRecipients, htmlBody: '', subject: '', fingerprint: scan.fingerprint });
        return;
      }

      const locale    = (config.locale ?? 'es') as AlertLocale;
      const htmlBody  = buildAlertHtml(scan, locale);
      const dateLabel = new Date().toLocaleDateString('es-ES');
      const total     = scan.items.length;
      const subject   = total === 0
        ? `✅ CMDB — All clear (${dateLabel})`
        : `⚠️ CMDB — ${total} alert(s) (${dateLabel})`;

      res.json({
        shouldSend:  true,
        reason:      'ok',
        subject,
        htmlBody,
        recipients:  allRecipients,
        breakdown:   { ...scan.breakdown, fingerprint: scan.fingerprint },
        fingerprint: scan.fingerprint,
        totalAlerts: total,
      });
    } catch (err) {
      console.error('[internal/alerts/scan]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── POST /api/internal/alerts/record ─────────────────────────────────────────
  // n8n llama a este endpoint DESPUÉS de enviar (o intentar enviar) el email,
  // para persistir el resultado en alert_runs + audit_logs.
  router.post('/record', async (req: Request, res: Response): Promise<void> => {
    const parsed = RecordRunSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation error', details: parsed.error.flatten() });
      return;
    }
    try {
      const run = await createRun(prisma, {
        ...parsed.data,
        finishedAt: new Date(),
      });
      await insertAlertAudit(prisma, 'ALERT_CRON_RUN', 'n8n-service', run.id);
      res.json({ runId: run.id, status: run.status });
    } catch (err) {
      console.error('[internal/alerts/record]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
