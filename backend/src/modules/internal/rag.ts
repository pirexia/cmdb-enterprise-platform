import { Router, Request, Response } from 'express';

/**
 * Endpoint interno RAG — enfoque híbrido (Decisión D-B, T4).
 *
 * n8n despacha POST /api/internal/rag/process-batch cada 30 s.
 * El backend ejecuta la lógica probada (processRagQueue + processBulkImportQueue +
 * processCIBulkImportQueue) y devuelve contadores. n8n gestiona el scheduling
 * y los reintentos en caso de fallo.
 *
 * Las tres funciones se inyectan desde index.ts para no mover código complejo
 * de sus closures actuales y evitar regresiones.
 */
export interface RagQueueFunctions {
  processRagQueue:          () => Promise<void>;
  processBulkImportQueue:   () => Promise<void>;
  processCIBulkImportQueue: () => Promise<void>;
}

export function createInternalRagRouter(fns: RagQueueFunctions): Router {
  const router = Router();

  // ── POST /api/internal/rag/process-batch ─────────────────────────────────────
  // Ejecuta un ciclo completo de indexado RAG + análisis IA de importaciones.
  // Llamado por el workflow n8n "RAG Indexing" cada 30 s.
  //
  // Respuesta: { ok, durationMs } — los contadores detallados van a los logs
  // internos del backend (processRagQueue ya los imprime).
  router.post('/process-batch', async (_req: Request, res: Response): Promise<void> => {
    if (process.env.RAG_ENABLED !== 'true') {
      res.json({ ok: true, skipped: true, reason: 'RAG_ENABLED is not "true"' });
      return;
    }

    const start = Date.now();
    const errors: string[] = [];

    try {
      await fns.processRagQueue();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[internal/rag/process-batch] processRagQueue error:', msg);
      errors.push(`processRagQueue: ${msg}`);
    }

    try {
      await fns.processBulkImportQueue();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[internal/rag/process-batch] processBulkImportQueue error:', msg);
      errors.push(`processBulkImportQueue: ${msg}`);
    }

    try {
      await fns.processCIBulkImportQueue();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[internal/rag/process-batch] processCIBulkImportQueue error:', msg);
      errors.push(`processCIBulkImportQueue: ${msg}`);
    }

    const durationMs = Date.now() - start;

    if (errors.length > 0) {
      // Errores parciales: devolver 207 para que n8n pueda loguear pero no reintentar todo
      res.status(207).json({ ok: false, durationMs, errors });
      return;
    }

    res.json({ ok: true, durationMs });
  });

  return router;
}
