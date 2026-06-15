import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireUuidParam(param: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!UUID_RE.test((req.params[param] as string) ?? '')) {
      res.status(400).json({ error: 'Invalid ID format' });
      return;
    }
    next();
  };
}

export function requireAuditRole(req: Request, res: Response, next: NextFunction): void {
  const role = (req as any).user?.role;
  if (role !== 'ADMIN' && role !== 'AUDITOR') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
}

export function requireAdminRole(req: Request, res: Response, next: NextFunction): void {
  if ((req as any).user?.role !== 'ADMIN') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
}

export function makePlanLoader(prisma: PrismaClient) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const plan = await prisma.$queryRaw<{id: string}[]>`
      SELECT id FROM "decommission_plan" WHERE id = ${req.params.id as string}::uuid LIMIT 1
    `;
    if (plan.length === 0) {
      res.status(404).json({ error: 'Plan not found' });
      return;
    }
    next();
  };
}
