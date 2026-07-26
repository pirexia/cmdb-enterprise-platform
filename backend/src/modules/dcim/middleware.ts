import { Request, Response, NextFunction } from 'express';

// Reject requests where the named path param is not a valid UUID.
// Mirrors the same helper in index.ts — re-exported here so router.ts
// does not need to import from the monolith.
export function requireUuidParam(paramName: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const val = req.params[paramName] as string;
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!val || !uuidRe.test(val)) {
      res.status(400).json({ error: `Invalid ${paramName}: must be a UUID` });
      return;
    }
    next();
  };
}

// v3.5.10 — Solo VIEWER queda bloqueado en DCIM. MANAGER pasa a ser
// equivalente a AUDITOR fuera del módulo de horarios (D3) y por tanto tiene
// acceso aquí; lo que NO gana es el acceso a los registros de auditoría
// (requireAudit y la denylist de informes lo siguen excluyendo).
export function requireDcimAccess(req: Request, res: Response, next: NextFunction): void {
  const role = (req as any).user?.role;
  if (!role || role === 'VIEWER') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
}

// Require ADMIN role for write operations.
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const role = (req as any).user?.role;
  if (role !== 'ADMIN') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
}
