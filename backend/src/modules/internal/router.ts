import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticateService } from '../../shared/middleware/serviceAuth.js';
import { createInternalAlertsRouter }      from './alerts.js';
import { createInternalMaintenanceRouter } from './maintenance.js';
import { createInternalRagRouter, type RagQueueFunctions } from './rag.js';
import { createInternalBulkRouter }  from './bulk.js';
import { createInternalUsersRouter }  from './users.js';
import { createInternalBackupRouter }  from './backup.js';
import { createInternalNotifyRouter }  from './notify.js';

/**
 * Router para /api/internal/*
 *
 * Exclusivamente para tráfico máquina-a-máquina desde n8n-workers.
 * nginx bloquea este path externamente (deny all → 404).
 * Todos los endpoints requieren X-CMDB-Service-Token.
 *
 * Endpoints iniciales:
 *   GET /api/internal/health         — health check (sin auth, para Podman healthcheck)
 *   GET /api/internal/n8n-gate       — valida JWT de usuario ADMIN para nginx auth_request
 *
 * Los endpoints de dominio (alerts, rag, users, notify, backup) se añaden
 * en Tareas 3-8 como sub-routers montados aquí.
 */
export function createInternalRouter(prisma: PrismaClient, ragFns?: RagQueueFunctions): Router {
  const router = Router();

  // ── GET /api/internal/health — sin auth, para healthchecks internos ──────────
  router.get('/health', (_req: Request, res: Response): void => {
    res.json({ status: 'ok', service: 'cmdb-internal' });
  });

  // ── GET /api/internal/n8n-gate — nginx auth_request para /n8n/ ───────────────
  // nginx llama a este endpoint con la cookie/header JWT del usuario.
  // Devuelve 200 si es ADMIN válido, 401/403 en caso contrario.
  // Solo se expone vía nginx auth_request, no directamente.
  router.get('/n8n-gate', async (req: Request, res: Response): Promise<void> => {
    const jwt = await import('jsonwebtoken');
    const JWT_SECRET = process.env.JWT_SECRET;
    if (!JWT_SECRET) {
      res.status(401).json({ error: 'Server misconfiguration.' });
      return;
    }

    const cookieToken  = (req as Request & { cookies?: Record<string, string> }).cookies?.['cmdb_token'];
    const authHeader   = req.headers['authorization'];
    const bearerToken  = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
    const token        = cookieToken ?? bearerToken;

    if (!token) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }

    try {
      const payload = jwt.default.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as { role?: string; id?: string };
      if (payload.role !== 'ADMIN') {
        res.status(403).json({ error: 'ADMIN role required to access n8n.' });
        return;
      }
      // Confirm user is still active
      const user = await prisma.user.findUnique({
        where: { id: payload.id },
        select: { active: true, role: true },
      });
      if (!user?.active || user.role !== 'ADMIN') {
        res.status(403).json({ error: 'Account inactive or role changed.' });
        return;
      }
      res.status(200).json({ ok: true });
    } catch {
      res.status(401).json({ error: 'Invalid or expired token.' });
    }
  });

  // ── Service-authenticated endpoints ──────────────────────────────────────────
  // Todos los endpoints de dominio requieren authenticateService.

  // Ping — para tests de conectividad desde n8n
  router.get('/ping', authenticateService, (_req: Request, res: Response): void => {
    res.json({ pong: true, ts: new Date().toISOString() });
  });

  // Alertas — scan + record (T3)
  router.use('/alerts', authenticateService, createInternalAlertsRouter(prisma));

  // Mantenimiento del sistema — purge audit, trusted devices, DCIM power, bulk staging (T3.5)
  router.use('/maintenance', authenticateService, createInternalMaintenanceRouter(prisma));

  // RAG indexing queue — process-batch híbrido (T4)
  if (ragFns) {
    router.use('/rag', authenticateService, createInternalRagRouter(ragFns));
  }

  // Importaciones masivas CI vía n8n (T5)
  router.use('/bulk', authenticateService, createInternalBulkRouter(prisma));

  // Sincronización LDAP/AD vía n8n (T6)
  router.use('/users', authenticateService, createInternalUsersRouter(prisma));

  // Backup automatizado vía n8n (T7)
  router.use('/backup', authenticateService, createInternalBackupRouter(prisma));

  // Configuración de canales Teams/Slack para el workflow n8n "Notificaciones" (T8)
  router.use('/notify', authenticateService, createInternalNotifyRouter(prisma));

  return router;
}
