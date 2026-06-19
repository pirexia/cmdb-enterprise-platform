import { Request, Response, NextFunction } from 'express';
import { UserRole } from '../types.js';

/** Allows ADMIN and AUDITOR roles (read-only audit access). */
export function requireAudit(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || !(['ADMIN', 'AUDITOR'] as UserRole[]).includes(req.user.role)) {
    res.status(403).json({ error: 'Audit access requires ADMIN or AUDITOR role.' });
    return;
  }
  next();
}
