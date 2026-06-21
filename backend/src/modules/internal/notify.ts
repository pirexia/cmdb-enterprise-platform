import { Router, Request, Response } from 'express';
import { PrismaClient }              from '@prisma/client';

/**
 * Endpoint interno para que el workflow n8n "Notificaciones CMDB" lea
 * la configuración de canales antes de enrutar una notificación (T8).
 *
 * GET /api/internal/notify/config
 *   ← { teamsWebhookUrl, slackBotToken, slackChannel }
 *
 * Nota de seguridad: slackBotToken es sensible. Este endpoint solo es
 * accesible con X-CMDB-Service-Token (M2M) y está bloqueado en nginx
 * para tráfico externo. No loguear el token ni incluirlo en audit_logs.
 */
export function createInternalNotifyRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get('/config', async (_req: Request, res: Response): Promise<void> => {
    try {
      const rows = await prisma.$queryRaw<{
        teams_webhook_url: string | null;
        slack_bot_token:   string | null;
        slack_channel:     string | null;
      }[]>`
        SELECT teams_webhook_url, slack_bot_token, slack_channel
        FROM "alert_config"
        WHERE id = 'default'
        LIMIT 1`;

      const row = rows[0] ?? null;
      res.json({
        teamsWebhookUrl: row?.teams_webhook_url ?? null,
        slackBotToken:   row?.slack_bot_token   ?? null,
        slackChannel:    row?.slack_channel      ?? null,
      });
    } catch (e) {
      console.error('[internal/notify/config]', e);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
