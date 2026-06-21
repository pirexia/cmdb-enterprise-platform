/**
 * @deprecated v3.0.0 — El cron de alertas se migró al workflow n8n "Alertas CMDB".
 *
 * El scheduling diario ya no vive aquí. n8n llama a:
 *   GET  /api/internal/alerts/scan   — para obtener HTML + payload
 *   POST /api/internal/alerts/record — para registrar el resultado
 *
 * El endpoint manual POST /api/alerts/run-now sigue disponible en el router público
 * para ejecución bajo demanda desde la UI (usa pipeline.ts directamente).
 *
 * Este archivo se conserva para no romper el import en index.ts; la función
 * exportada es ahora un no-op.
 */

import type { PrismaClient } from '@prisma/client';

export function startAlertScheduler(_prisma: PrismaClient): void {
  console.log('[alerts:scheduler] v3.0.0 — scheduling delegado a n8n workflow "Alertas CMDB".');
}
