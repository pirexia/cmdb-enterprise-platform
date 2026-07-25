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

// Block VIEWER and WORKER roles from all DCIM endpoints (read + write).
// WORKER is VIEWER-equivalent everywhere except the Staff Schedule module,
// which grants it read access explicitly — it must not fall through here.
export function requireDcimAccess(req: Request, res: Response, next: NextFunction): void {
  const role = (req as any).user?.role;
  if (!role || role === 'VIEWER' || role === 'WORKER') {
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
