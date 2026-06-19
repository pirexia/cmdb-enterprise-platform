import { Request, Response, NextFunction } from 'express';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Defensive guard for :id-style path params. Rejects non-UUID values with 400
 * before they reach Prisma (which would crash with P2023).
 */
export function requireUuidParam(paramName: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const value = req.params[paramName];
    if (typeof value !== 'string' || !UUID_RE.test(value)) {
      res.status(400).json({ error: `Invalid ${paramName} parameter (expected UUID).` });
      return;
    }
    next();
  };
}
