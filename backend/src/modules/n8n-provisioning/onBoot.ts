/**
 * n8n-provisioning · auto-aprovisionamiento al arrancar el backend.
 *
 * `provisionOnBoot()` es fire-and-forget: no bloquea el arranque y nunca lanza.
 * Si N8N_API_KEY no está configurada, omite el aprovisionamiento y registra un aviso.
 * Si n8n aún no está listo, reintenta con backoff hasta `maxRetries` veces.
 */
import { PrismaClient } from '@prisma/client';
import { loadN8nProvisioningConfig } from './config.js';
import { makeN8nApiClient } from './apiClient.js';
import { provisionAll } from './provisioner.js';

const LOG_PREFIX = '[n8n-provisioning]';

/** Espera `ms` milisegundos (usable como mock en tests). */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function provisionOnBoot(retryDelayMs = 6000, maxRetries = 10): void {
  void (async () => {
    try {
      const cfg = loadN8nProvisioningConfig();
      if (!cfg.apiKey) {
        console.warn(`${LOG_PREFIX} N8N_API_KEY no configurada; aprovisionamiento omitido.`);
        return;
      }

      const client = makeN8nApiClient(cfg);
      const prisma  = new PrismaClient();

      // Reintentar hasta que n8n responda
      let attempt = 0;
      while (attempt < maxRetries) {
        try {
          await client.listWorkflows();
          break; // n8n listo
        } catch {
          attempt++;
          if (attempt >= maxRetries) {
            console.error(
              `${LOG_PREFIX} n8n no disponible tras ${maxRetries} intentos; aprovisionamiento cancelado.`
            );
            return;
          }
          console.log(`${LOG_PREFIX} n8n no responde (intento ${attempt}/${maxRetries}); reintentando en ${retryDelayMs}ms...`);
          await sleep(retryDelayMs);
        }
      }

      const report = await provisionAll(client, cfg, prisma);

      const ok  = report.errors.length === 0;
      const msg = `creds=${report.credentials.map((c) => `${c.name}:${c.action}`).join(',')} wfs=${report.workflows.map((w) => `${w.name}:${w.action}`).join(',')}`;
      if (ok) {
        console.log(`${LOG_PREFIX} aprovisionamiento completado. ${msg}`);
      } else {
        console.warn(`${LOG_PREFIX} aprovisionamiento con errores: ${report.errors.join(' | ')}. ${msg}`);
      }
    } catch (err) {
      // Nunca fatal
      console.error(`${LOG_PREFIX} error inesperado:`, err instanceof Error ? err.message : err);
    }
  })();
}
