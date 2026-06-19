import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { createAuthenticateToken } from '../../shared/middleware/authenticate.js';
import { requireAdmin }            from '../../shared/middleware/requireAdmin.js';

export function createVendorsRouter(prisma: PrismaClient): Router {
  const router = Router();
  const authenticateToken = createAuthenticateToken(prisma);

  // GET /api/vendors — all authenticated roles
  router.get('/', authenticateToken, async (_req: Request, res: Response) => {
    try {
      const vendors = await prisma.vendor.findMany({
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      });
      res.json(vendors);
    } catch (error) {
      console.error('[GET /api/vendors] Error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/vendors — ADMIN only
  router.post('/', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
    const { name } = req.body as { name?: string };
    if (!name?.trim()) { res.status(400).json({ error: 'name required' }); return; }
    try {
      const rows = await prisma.$queryRaw<{ id: string; name: string }[]>`
        INSERT INTO "vendors"(id,name,created_at,updated_at)
        VALUES(gen_random_uuid(),${name.trim()},now(),now())
        RETURNING id::text AS id, name`;
      await prisma.$executeRaw`
        INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at)
        VALUES(gen_random_uuid(),'CREATE_MASTER','Vendor',${rows[0].id}::uuid,${req.user!.email},now())`;
      res.status(201).json(rows[0]);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  // PATCH /api/vendors/:id — ADMIN only
  router.patch('/:id', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
    const { name } = req.body as { name?: string };
    if (!name?.trim()) { res.status(400).json({ error: 'name required' }); return; }
    try {
      const rows = await prisma.$queryRaw<{ id: string; name: string }[]>`
        UPDATE "vendors" SET name=${name.trim()}, updated_at=now()
        WHERE id=${req.params.id}::uuid RETURNING id::text AS id, name`;
      if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
      await prisma.$executeRaw`
        INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at)
        VALUES(gen_random_uuid(),'UPDATE_MASTER','Vendor',${rows[0].id}::uuid,${req.user!.email},now())`;
      res.json(rows[0]);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
  });

  // DELETE /api/vendors/:id — ADMIN only; 409 on FK constraint violation
  router.delete('/:id', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
    try {
      await prisma.$executeRaw`
        INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at)
        VALUES(gen_random_uuid(),'DELETE_MASTER','Vendor',${req.params.id}::uuid,${req.user!.email},now())`;
      await prisma.$executeRaw`DELETE FROM "vendors" WHERE id=${req.params.id}::uuid`;
      res.json({ ok: true });
    } catch (e: unknown) {
      if (typeof e === 'object' && e !== null && 'code' in e && (e as { code: string }).code === 'P2003') {
        res.status(409).json({ error: 'Cannot delete vendor with associated contracts or licenses' });
        return;
      }
      console.error(e);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
