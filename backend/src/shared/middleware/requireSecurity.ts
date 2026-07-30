import { Request, Response, NextFunction } from 'express';
import { UserRole } from '../types.js';

// Role gate for the Security area (Greenbone/CrowdStrike upload + the
// vuln-import staging review workflow) — ADMIN and SOC only. Deliberately
// scoped to this module's own routes rather than folded into the shared
// requireAdmin/requireAudit middleware, which are reused across unrelated
// modules (contracts, licenses, DCIM, ...) where SOC has no business.

const SECURITY_READ_ROLES:  UserRole[] = ['ADMIN', 'AUDITOR', 'SOC'];
const SECURITY_WRITE_ROLES: UserRole[] = ['ADMIN', 'SOC'];

/** Read access: existing ADMIN/AUDITOR visibility, plus SOC. */
export function requireSecurityRead(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || !SECURITY_READ_ROLES.includes(req.user.role)) {
    res.status(403).json({ error: 'Security read access requires ADMIN, AUDITOR or SOC role.' });
    return;
  }
  next();
}

/** Write access: SOC operates this area with the same authority ADMIN has today. */
export function requireSecurityWrite(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || !SECURITY_WRITE_ROLES.includes(req.user.role)) {
    res.status(403).json({ error: 'Security write access requires ADMIN or SOC role.' });
    return;
  }
  next();
}
