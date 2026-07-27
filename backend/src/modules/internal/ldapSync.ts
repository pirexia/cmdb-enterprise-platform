import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { runLdapGroupSync, LdapSyncInProgressError } from '../integrations/ldapSyncService.js';
import { LdapDirectoryError } from '../../services/ldapDirectory.js';

/**
 * POST /api/internal/ldap/sync — disparo máquina-a-máquina desde el workflow
 * diario de n8n (v3.5.10).
 *
 * Ejecuta exactamente la misma función que el botón de la UI. n8n solo decide
 * CUÁNDO se sincroniza; el backend decide QUÉ significa sincronizar. Sustituye
 * al esquema anterior, en el que n8n consultaba el directorio y calculaba el
 * diff con un nodo Code — dos implementaciones de la misma regla de acceso.
 *
 * nginx bloquea /api/internal/* desde el exterior; el router padre exige
 * X-CMDB-Service-Token.
 */
export function createInternalLdapSyncRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.post('/sync', async (_req: Request, res: Response): Promise<void> => {
    try {
      const result = await runLdapGroupSync(prisma, 'n8n@cmdb.local');
      res.status(result.errors.length > 0 ? 207 : 200).json(result);
    } catch (error) {
      if (error instanceof LdapDirectoryError && error.code === 'NOT_CONFIGURED') {
        // El workflow no debería estar activo sin grupo configurado; si llega
        // aquí, el 400 lo hace evidente en el historial de ejecuciones de n8n.
        res.status(400).json({ error: 'LDAP_GROUP_NOT_CONFIGURED' });
        return;
      }
      if (error instanceof LdapSyncInProgressError) {
        // Solape con una sincronización manual: no es un fallo, se reintentará
        // en la siguiente pasada.
        res.status(409).json({ error: 'SYNC_IN_PROGRESS' });
        return;
      }
      console.error('[internal/ldap/sync] Error:', error);
      res.status(502).json({ error: 'LDAP_DIRECTORY_UNAVAILABLE' });
    }
  });

  return router;
}
