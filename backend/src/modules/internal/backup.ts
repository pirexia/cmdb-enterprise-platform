import { Router, Request, Response } from 'express';
import { PrismaClient }              from '@prisma/client';
import { execFile }                  from 'child_process';
import { promisify }                 from 'util';
import fs                            from 'fs';
import path                          from 'path';

const execFileAsync = promisify(execFile);

const BACKUP_DIR           = process.env.BACKUP_DIR            ?? '/app/backups';
const BACKUP_RETENTION_DAYS = parseInt(process.env.BACKUP_RETENTION_DAYS ?? '30', 10);
const DOCUMENTS_DIR         = process.env.DOCUMENTS_DIR         ?? '/app/documents';

/**
 * Endpoints internos para backup automatizado vía n8n (T7, Decisión D-D).
 *
 * El workflow n8n "Backup CMDB" llama a POST /trigger, ejecuta el dump y tar,
 * sube el resultado al destino remoto configurado en n8n, y llama a POST /record
 * para dejar trazabilidad en audit_logs.
 *
 * Exclusiones (D-D): server.key/server.crt se excluyen del backup automatizado.
 * Ver docs/BACKUP_RESTORE_GUIDE.md para backup manual de certificados.
 *
 * POST /api/internal/backup/trigger — ejecuta pg_dump + tar docs
 * POST /api/internal/backup/record  — registra resultado en audit_logs
 * GET  /api/internal/backup/list    — lista backups locales disponibles
 */
export function createInternalBackupRouter(prisma: PrismaClient): Router {
  const router = Router();

  // ── POST /api/internal/backup/trigger ────────────────────────────────────────
  // Ejecuta pg_dump (formato custom, comprimido) + tar de documents/.
  // Usa execFile (no exec) para evitar inyección de shell.
  // PGPASSWORD se pasa como variable de entorno, nunca como argumento de línea de comandos.
  router.post('/trigger', async (_req: Request, res: Response): Promise<void> => {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      res.status(500).json({ error: 'DATABASE_URL no configurado' }); return;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(dbUrl);
    } catch {
      res.status(500).json({ error: 'DATABASE_URL inválida' }); return;
    }

    const pgHost     = parsedUrl.hostname;
    const pgPort     = parsedUrl.port || '5432';
    const pgUser     = parsedUrl.username;
    const pgPassword = decodeURIComponent(parsedUrl.password);
    const pgDbName   = parsedUrl.pathname.replace(/^\//, '');

    await fs.promises.mkdir(BACKUP_DIR, { recursive: true });

    const ts        = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupId  = `cmdb_${ts}`;
    const dumpFile  = path.join(BACKUP_DIR, `${backupId}.dump`);
    const docsFile  = path.join(BACKUP_DIR, `${backupId}_docs.tar.gz`);

    // ── pg_dump ───────────────────────────────────────────────────────────────
    try {
      await execFileAsync('pg_dump', [
        '-h', pgHost,
        '-p', pgPort,
        '-U', pgUser,
        '-d', pgDbName,
        '--format=custom',
        '--compress=9',
        '--no-password',
        '-f', dumpFile,
      ], {
        env: { ...process.env, PGPASSWORD: pgPassword },
        timeout: 10 * 60 * 1000,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[internal/backup/trigger] pg_dump error:', msg);
      res.status(500).json({ error: 'pg_dump falló', details: msg }); return;
    }

    // ── tar documents/ ────────────────────────────────────────────────────────
    let docsOk = false;
    try {
      await execFileAsync('tar', ['-czf', docsFile, '-C', path.dirname(DOCUMENTS_DIR), path.basename(DOCUMENTS_DIR)], {
        timeout: 10 * 60 * 1000,
      });
      docsOk = true;
    } catch (e) {
      console.error('[internal/backup/trigger] tar docs error:', e);
    }

    // ── Tamaño en MB ──────────────────────────────────────────────────────────
    const dumpStat = await fs.promises.stat(dumpFile).catch(() => null);
    const docsStat = docsOk ? await fs.promises.stat(docsFile).catch(() => null) : null;
    const dumpMb   = dumpStat ? Math.round(dumpStat.size / (1024 * 1024) * 100) / 100 : 0;
    const docsMb   = docsStat ? Math.round(docsStat.size / (1024 * 1024) * 100) / 100 : 0;

    // ── Limpieza de backups antiguos ─────────────────────────────────────────
    if (BACKUP_RETENTION_DAYS > 0) {
      try {
        const cutoff = Date.now() - BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
        const entries = await fs.promises.readdir(BACKUP_DIR);
        for (const entry of entries) {
          if (!entry.startsWith('cmdb_')) continue;
          const fullPath = path.join(BACKUP_DIR, entry);
          const stat = await fs.promises.stat(fullPath).catch(() => null);
          if (stat && stat.mtimeMs < cutoff) {
            await fs.promises.unlink(fullPath).catch(() => {});
          }
        }
      } catch (e) {
        console.error('[internal/backup/trigger] cleanup error:', e);
      }
    }

    console.log(`[internal/backup/trigger] ${backupId} — dump=${dumpMb}MB docs=${docsMb}MB`);
    res.json({
      ok: true,
      backupId,
      dumpPath:  dumpFile,
      docsPath:  docsOk ? docsFile : null,
      dumpMb,
      docsMb,
    });
  });

  // ── POST /api/internal/backup/record ─────────────────────────────────────────
  // n8n llama a este endpoint tras subir el backup al destino remoto (o al
  // finalizar el workflow). Genera un registro en audit_logs para trazabilidad.
  router.post('/record', async (req: Request, res: Response): Promise<void> => {
    const { backupId, success, destination, totalMb } = req.body as {
      backupId:    string;
      success:     boolean;
      destination: string;
      totalMb?:    number;
    };

    if (!backupId || typeof success !== 'boolean') {
      res.status(400).json({ error: 'backupId y success son requeridos' }); return;
    }

    try {
      await prisma.$executeRaw`
        INSERT INTO "audit_logs"(id, action, entity, user_email, details, created_at)
        VALUES(gen_random_uuid(), ${success ? 'BACKUP_SUCCESS' : 'BACKUP_FAILURE'}, 'System',
               'n8n@cmdb.local',
               ${JSON.stringify({ backupId, destination: destination ?? 'local', totalMb: totalMb ?? null })}::jsonb,
               now())`;

      res.json({ ok: true });
    } catch (e) {
      console.error('[internal/backup/record]', e);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/internal/backup/list ────────────────────────────────────────────
  // Lista backups locales para que n8n pueda decidir qué subir / qué eliminar.
  router.get('/list', async (_req: Request, res: Response): Promise<void> => {
    try {
      await fs.promises.mkdir(BACKUP_DIR, { recursive: true });
      const entries = await fs.promises.readdir(BACKUP_DIR);
      const files = await Promise.all(
        entries
          .filter((e) => e.startsWith('cmdb_'))
          .map(async (e) => {
            const stat = await fs.promises.stat(path.join(BACKUP_DIR, e)).catch(() => null);
            return stat ? { name: e, sizeMb: Math.round(stat.size / (1024 * 1024) * 100) / 100, mtime: stat.mtime } : null;
          }),
      );
      res.json({ backups: files.filter(Boolean).sort((a, b) => (b!.mtime > a!.mtime ? 1 : -1)) });
    } catch (e) {
      console.error('[internal/backup/list]', e);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
