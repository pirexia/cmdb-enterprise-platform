import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import multer from 'multer';
import ExcelJS from 'exceljs';

const CI_BULK_MAX_ROWS      = parseInt(process.env.CI_BULK_MAX_ROWS      ?? '500', 10);
const BULK_MAX_OPEN_BATCHES = parseInt(process.env.BULK_MAX_OPEN_BATCHES ?? '5',   10);

const INTERNAL_CREATOR = 'n8n@cmdb.local';

/**
 * Endpoint interno para importaciones masivas de CIs desde n8n (T5, Decisión D-C).
 *
 * El workflow n8n "Bulk Import CIs" llama a POST /api/internal/bulk/submit
 * con el fichero XLSX y obtiene un batchId. A partir de ahí, el pipeline
 * existente (processCIBulkImportQueue) procesa el análisis IA en background
 * y el administrador revisa/confirma en la UI.
 *
 * POST /api/internal/bulk/submit — subir XLSX → crear staging batch
 * GET  /api/internal/bulk/batches/:id — consultar estado del batch (para polling desde n8n)
 */

const xlsxUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, cb) {
    if (file.originalname.toLowerCase().endsWith('.xlsx')) { cb(null, true); }
    else { cb(new Error('Solo se permiten ficheros .xlsx')); }
  },
});

function xlsxUploadMiddleware(req: Request, res: Response, next: NextFunction): void {
  xlsxUpload.single('file')(req, res, (err: unknown) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        res.status(400).json({ error: 'El fichero XLSX no puede superar 10 MB' }); return;
      }
      res.status(400).json({ error: (err as Error).message || 'Error al subir el fichero' }); return;
    }
    next();
  });
}

export function createInternalBulkRouter(prisma: PrismaClient): Router {
  const router = Router();

  // ── POST /api/internal/bulk/submit ───────────────────────────────────────────
  // Equivale a POST /api/cis/bulk/batches pero con service auth en lugar de
  // user JWT. El creador se fija como INTERNAL_CREATOR ('n8n@cmdb.local').
  router.post('/submit', xlsxUploadMiddleware, async (req: Request, res: Response): Promise<void> => {
    const file = req.file;
    if (!file) { res.status(400).json({ error: 'Se requiere un fichero .xlsx' }); return; }

    // Magic bytes: XLSX = ZIP (PK\x03\x04)
    if (file.buffer.length < 4 ||
        file.buffer[0] !== 0x50 || file.buffer[1] !== 0x4B ||
        file.buffer[2] !== 0x03 || file.buffer[3] !== 0x04) {
      res.status(400).json({ error: 'El fichero no es un XLSX válido' }); return;
    }

    // Open-batch limit (same constant as the public endpoint)
    try {
      const openRows = await prisma.$queryRaw<{ c: bigint }[]>`
        SELECT COUNT(*) AS c FROM "ci_bulk_import_batch"
        WHERE created_by = ${INTERNAL_CREATOR}
          AND status NOT IN ('COMMITTED','DISCARDED','REAPED')`;
      if (Number(openRows[0]?.c ?? 0) >= BULK_MAX_OPEN_BATCHES) {
        res.status(429).json({
          error: `Límite de ${BULK_MAX_OPEN_BATCHES} lotes abiertos alcanzado (n8n). Confirma o descarta alguno primero.`,
          maxBatches: BULK_MAX_OPEN_BATCHES,
        });
        return;
      }
    } catch (e) { console.error('[internal/bulk/submit] limit check error:', e); }

    // Parse XLSX with ExcelJS
    let rows: Array<Record<string, string | null>> = [];
    try {
      const wb = new ExcelJS.Workbook();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await wb.xlsx.load(file.buffer as any);
      const ws = wb.getWorksheet('Datos') ?? wb.worksheets[0];
      if (!ws) { res.status(400).json({ error: 'El XLSX no contiene la hoja "Datos"' }); return; }

      const headers: string[] = [];
      ws.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
        headers[col - 1] = String(cell.value ?? '').replace(/\s*\*\s*$/, '').trim();
      });

      ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
        if (rowNum === 1) return;
        const obj: Record<string, string | null> = {};
        let hasData = false;
        row.eachCell({ includeEmpty: true }, (cell, col) => {
          const key = headers[col - 1];
          if (!key) return;
          const v = cell.value;
          if (v !== null && v !== undefined && String(v).trim() !== '') {
            obj[key] = String(v).trim();
            hasData = true;
          } else {
            obj[key] = null;
          }
        });
        if (hasData && obj['name']) rows.push(obj);
      });
    } catch (e) {
      console.error('[internal/bulk/submit] XLSX parse error:', e);
      res.status(400).json({ error: 'No se pudo leer el fichero XLSX' }); return;
    }

    if (rows.length === 0) {
      res.status(400).json({ error: 'El XLSX no contiene filas con datos válidos (columna "name" requerida)' }); return;
    }
    if (rows.length > CI_BULK_MAX_ROWS) {
      res.status(400).json({ error: `El XLSX excede el límite de ${CI_BULK_MAX_ROWS} filas` }); return;
    }

    try {
      const batchRows = await prisma.$queryRaw<{ id: string }[]>`
        INSERT INTO "ci_bulk_import_batch"(id, created_by, status, row_count, created_at, updated_at)
        VALUES(gen_random_uuid(), ${INTERNAL_CREATOR}, 'UPLOADED', ${rows.length}, now(), now())
        RETURNING id::text AS id`;
      const batchId = batchRows[0].id;

      for (let i = 0; i < rows.length; i++) {
        await prisma.$executeRaw`
          INSERT INTO "ci_bulk_import_item"(id, batch_id, row_index, raw_data, status, analysis, created_at, updated_at)
          VALUES(gen_random_uuid(), ${batchId}::uuid, ${i + 1}, ${JSON.stringify(rows[i])}::jsonb,
                 'PENDING_ANALYSIS', '{}'::jsonb, now(), now())`;
      }

      await prisma.$executeRaw`
        INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, details, created_at)
        VALUES(gen_random_uuid(), 'CI_BULK_UPLOAD', 'CiBulkImportBatch', ${batchId}::uuid,
               ${INTERNAL_CREATOR}, ${JSON.stringify({ rowCount: rows.length, source: 'n8n' })}::jsonb, now())`;

      console.log(`[internal/bulk/submit] Batch ${batchId} creado por n8n — ${rows.length} fila(s)`);
      res.status(201).json({
        batchId,
        rowCount: rows.length,
        statusUrl: `/api/internal/bulk/batches/${batchId}`,
      });
    } catch (e) {
      console.error('[internal/bulk/submit]', e);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /api/internal/bulk/batches/:id ───────────────────────────────────────
  // Permite al workflow n8n hacer polling del estado del batch sin requerir
  // un token de usuario ADMIN. Solo devuelve campos necesarios para decidir
  // cuándo notificar al operador.
  router.get('/batches/:id', async (req: Request, res: Response): Promise<void> => {
    const id = req.params.id as string;
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      res.status(400).json({ error: 'ID de batch inválido' }); return;
    }
    try {
      const rows = await prisma.$queryRaw<{
        id: string; status: string; rowCount: number; createdAt: Date;
        committed: bigint; pending: bigint; errors: bigint;
      }[]>`
        SELECT b.id::text AS id, b.status, b.row_count AS "rowCount", b.created_at AS "createdAt",
               COUNT(i.id) FILTER (WHERE i.status = 'COMMITTED')                     AS committed,
               COUNT(i.id) FILTER (WHERE i.status IN ('PENDING_ANALYSIS','ANALYZING')) AS pending,
               COUNT(i.id) FILTER (WHERE i.status = 'ANALYSIS_ERROR')                AS errors
        FROM "ci_bulk_import_batch" b
        LEFT JOIN "ci_bulk_import_item" i ON i.batch_id = b.id
        WHERE b.id = ${id}::uuid AND b.created_by = ${INTERNAL_CREATOR}
        GROUP BY b.id`;

      if (rows.length === 0) { res.status(404).json({ error: 'Batch no encontrado' }); return; }

      const r = rows[0];
      res.json({
        id: r.id,
        status: r.status,
        rowCount: r.rowCount,
        createdAt: r.createdAt,
        committed: Number(r.committed),
        pending: Number(r.pending),
        errors: Number(r.errors),
      });
    } catch (e) {
      console.error('[internal/bulk/batches/:id]', e);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
