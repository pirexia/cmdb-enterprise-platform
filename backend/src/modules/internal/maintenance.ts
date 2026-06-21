import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';

const BULK_BATCH_TTL_HOURS       = parseInt(process.env.BULK_BATCH_TTL_HOURS       ?? '24',  10);
const BULK_REAPED_RETENTION_DAYS = parseInt(process.env.BULK_REAPED_RETENTION_DAYS ?? '7',   10);
const AUDIT_RETENTION_DAYS       = parseInt(process.env.AUDIT_RETENTION_DAYS       ?? '365', 10);
const STAGING_DIR                = path.join(process.env.DOCUMENTS_DIR ?? '/app/documents', '..', 'staging');

/**
 * Endpoints de mantenimiento del sistema — solo accesibles via M2M.
 * Reemplazan los 4 crons de node-cron de index.ts (migrados a workflows n8n en v3.0.0).
 *
 * POST /api/internal/maintenance/purge-audit-logs    — purga audit_logs antiguos (≥AUDIT_RETENTION_DAYS)
 * POST /api/internal/maintenance/cleanup-trusted-devices — elimina trusted_devices expirados
 * POST /api/internal/maintenance/dcim-power-scan     — genera audit log por racks con sobrepotencia
 * POST /api/internal/maintenance/cleanup-bulk-staging — limpia batches de importación expirados
 *
 * Cada endpoint devuelve { ok, deleted?, cleaned?, ... } para el log de n8n.
 * Todos insertan en audit_logs si procede (ISO 27001 A.8.15).
 */
export function createInternalMaintenanceRouter(prisma: PrismaClient): Router {
  const router = Router();

  // ── POST /api/internal/maintenance/purge-audit-logs ──────────────────────────
  // Equivale al AuditPurgeCron (03:00 daily). Elimina audit_logs >AUDIT_RETENTION_DAYS.
  router.post('/purge-audit-logs', async (_req: Request, res: Response): Promise<void> => {
    if (AUDIT_RETENTION_DAYS <= 0) {
      res.json({ ok: true, skipped: true, reason: 'AUDIT_RETENTION_DAYS=0 — purge disabled' });
      return;
    }
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - AUDIT_RETENTION_DAYS);
      const result = await prisma.$executeRaw`
        DELETE FROM "audit_logs" WHERE created_at < ${cutoffDate}`;
      const deleted = Number(result);
      console.log(`[maintenance/purge-audit-logs] Deleted ${deleted} record(s) older than ${AUDIT_RETENTION_DAYS} days`);
      res.json({ ok: true, deleted, cutoffDate: cutoffDate.toISOString(), retentionDays: AUDIT_RETENTION_DAYS });
    } catch (err) {
      console.error('[maintenance/purge-audit-logs]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── POST /api/internal/maintenance/cleanup-trusted-devices ───────────────────
  // Equivale al TrustedDeviceCron (02:00 daily). Elimina tokens de dispositivos expirados.
  router.post('/cleanup-trusted-devices', async (_req: Request, res: Response): Promise<void> => {
    try {
      const result = await prisma.$executeRaw`DELETE FROM "trusted_devices" WHERE expires_at < now()`;
      const deleted = Number(result);
      console.log(`[maintenance/cleanup-trusted-devices] Deleted ${deleted} expired token(s)`);
      res.json({ ok: true, deleted });
    } catch (err) {
      console.error('[maintenance/cleanup-trusted-devices]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── POST /api/internal/maintenance/dcim-power-scan ───────────────────────────
  // Equivale al DcimPowerCron (04:00 daily). Detecta racks con sobrepotencia y
  // emite un audit log DCIM_POWER_ALERT por rack (NIS2 Art.23 — trazabilidad).
  router.post('/dcim-power-scan', async (_req: Request, res: Response): Promise<void> => {
    try {
      const { getOverpowerAlerts } = await import('../dcim/queries.js');
      const alerts = await getOverpowerAlerts(prisma);
      if (alerts.length === 0) {
        res.json({ ok: true, alertsFound: 0 });
        return;
      }
      for (const alert of alerts) {
        await prisma.$executeRaw`
          INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
          VALUES (
            gen_random_uuid(),
            'DCIM_POWER_ALERT',
            'CI',
            ${alert.rackCiId}::uuid,
            'system@cmdb.local',
            now()
          )`;
      }
      console.log(`[maintenance/dcim-power-scan] Logged ${alerts.length} overpower rack alert(s)`);
      res.json({ ok: true, alertsFound: alerts.length, rackIds: alerts.map((a) => a.rackCiId) });
    } catch (err) {
      console.error('[maintenance/dcim-power-scan]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── POST /api/internal/maintenance/cleanup-bulk-staging ──────────────────────
  // Equivale al BulkCleanupCron (cada hora). Marca REAPED los batches expirados,
  // elimina sus staged files, y borra permanentemente los REAPED con >BULK_REAPED_RETENTION_DAYS.
  router.post('/cleanup-bulk-staging', async (_req: Request, res: Response): Promise<void> => {
    try {
      // Pass 1: marcar REAPED batches expirados (no en estado terminal)
      const stale = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM "bulk_import_batch"
        WHERE created_at < now() - make_interval(hours => ${BULK_BATCH_TTL_HOURS}::int)
          AND status NOT IN ('REAPED','COMMITTED','DISCARDED')`;

      let cleaned = 0;
      for (const b of stale) {
        const meta = await prisma.$queryRaw<{ created_by: string; file_count: number; committed: bigint; non_committed: bigint }[]>`
          SELECT b.created_by, b.file_count,
                 COUNT(i.id) FILTER (WHERE i.status = 'COMMITTED')  AS committed,
                 COUNT(i.id) FILTER (WHERE i.status <> 'COMMITTED') AS non_committed
          FROM "bulk_import_batch" b LEFT JOIN "bulk_import_item" i ON i.batch_id = b.id
          WHERE b.id = ${b.id}::uuid GROUP BY b.id`;

        const items = await prisma.$queryRaw<{ stagedFileName: string }[]>`
          SELECT staged_file_name AS "stagedFileName" FROM "bulk_import_item"
          WHERE batch_id = ${b.id}::uuid AND status != 'COMMITTED'`;

        for (const it of items) {
          try { fs.unlinkSync(path.join(STAGING_DIR, path.basename(it.stagedFileName))); } catch {}
        }

        await prisma.$executeRaw`UPDATE "bulk_import_batch" SET status='REAPED', updated_at=now() WHERE id = ${b.id}::uuid`;

        const m = meta[0];
        if (m) {
          try {
            await prisma.$executeRaw`
              INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, details, created_at)
              VALUES(gen_random_uuid(),'BULK_REAP_BATCH','BulkImportBatch',${b.id}::uuid,${m.created_by},
                     ${JSON.stringify({ ttlHours: BULK_BATCH_TTL_HOURS, fileCount: m.file_count, committed: Number(m.committed), nonCommittedReaped: Number(m.non_committed) })}::jsonb, now())`;
          } catch (e2) { console.error('[maintenance/cleanup-bulk-staging] audit write failed:', e2); }
        }
        cleaned++;
      }

      // Pass 2: borrar definitivamente REAPED con >BULK_REAPED_RETENTION_DAYS
      const oldReaped = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM "bulk_import_batch"
        WHERE status = 'REAPED'
          AND updated_at < now() - make_interval(days => ${BULK_REAPED_RETENTION_DAYS}::int)`;

      for (const r of oldReaped) {
        await prisma.$executeRaw`DELETE FROM "bulk_import_batch" WHERE id = ${r.id}::uuid`;
      }

      console.log(`[maintenance/cleanup-bulk-staging] Reaped ${cleaned}, deleted ${oldReaped.length} old REAPED`);
      res.json({ ok: true, reaped: cleaned, permanentlyDeleted: oldReaped.length });
    } catch (err) {
      console.error('[maintenance/cleanup-bulk-staging]', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
