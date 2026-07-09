import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { canUserEditDepartment } from './authz.js';

// Reject requests where the named path param is not a valid UUID.
// Mirrors the same helper in DCIM/index.ts.
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

// Block VIEWER role from the whole module (D12). AUDITOR gets read-only
// access (masked); manager/ADMIN get read+write per requireDeptEditAccess.
export function requireScheduleAccess(req: Request, res: Response, next: NextFunction): void {
  const role = (req as any).user?.role;
  if (!role || role === 'VIEWER') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
}

// Require ADMIN role — used for department/config/manager/summer/unpublish endpoints.
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const role = (req as any).user?.role;
  if (role !== 'ADMIN') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
}

// Row-level write authorization (D3). ADMIN always passes. Otherwise the
// caller must be a DepartmentManager of the *target* department, resolved as:
//   - Creation (POST /):            req.body.departmentId
//   - Edit of an existing schedule
//     (PUT /:id, /:id/validate,
//      /:id/publish, /:id/clone):   looked up from StaffSchedule.departmentId
//                                   via req.params.id (requires `prisma`,
//                                   hence this is a factory, not a bare fn).
export function requireDeptEditAccess(prisma: PrismaClient) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = (req as any).user as { id: string; role: string } | undefined;
    if (!user) { res.status(401).json({ error: 'Unauthorized' }); return; }
    if (user.role === 'ADMIN') { next(); return; }

    try {
      let departmentId: string | null | undefined = null;

      // Creation case: departmentId travels in the body.
      if (typeof req.body?.departmentId === 'string') {
        departmentId = req.body.departmentId;
      } else if (typeof req.params.id === 'string') {
        // Edit case: resolve departmentId from the existing schedule row.
        const schedule = await prisma.staffSchedule.findUnique({
          where: { id: req.params.id },
          select: { departmentId: true },
        });
        if (!schedule) { res.status(404).json({ error: 'Schedule not found' }); return; }
        departmentId = schedule.departmentId;
      }

      const allowed = await canUserEditDepartment(prisma, user.id, user.role, departmentId);
      if (!allowed) { res.status(403).json({ error: 'Forbidden' }); return; }
      next();
    } catch (err) {
      console.error('[StaffSchedule] requireDeptEditAccess error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}
