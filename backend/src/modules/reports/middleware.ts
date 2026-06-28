import type { Request, Response, NextFunction } from 'express';
import { getReport, hasRoleAccess } from './registry.js';
import type { ReportDefinition, UserRole } from './types.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { report?: ReportDefinition; }
  }
}

export function requireReportAccess(req: Request, res: Response, next: NextFunction): void {
  const user = (req as unknown as { user?: { role?: UserRole } }).user;
  if (!user) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const id = String(req.params['id'] ?? '');
  const def = getReport(id);
  if (!def) { res.status(404).json({ error: 'Report not found' }); return; }
  if (!hasRoleAccess((user.role ?? 'VIEWER') as UserRole, def.minRole)) {
    res.status(403).json({ error: 'Insufficient role', required: def.minRole });
    return;
  }
  req.report = def;
  next();
}
