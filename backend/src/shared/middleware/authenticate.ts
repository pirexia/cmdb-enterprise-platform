import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { JwtPayload } from '../types.js';

const COOKIE_NAME = 'cmdb_token';

const JWT_SECRET_VALUE: string = (() => {
  const s = process.env.JWT_SECRET;
  if (!s) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[FATAL] JWT_SECRET not set. Refusing to start in production.');
      process.exit(1);
    }
    console.warn('[SECURITY WARNING] JWT_SECRET not set. Using insecure dev default.');
  }
  return s ?? 'cmdb-dev-secret-change-in-production';
})();

/**
 * Factory that returns the authenticateToken middleware bound to the given
 * PrismaClient. Reads the JWT from the HttpOnly cookie or Authorization header,
 * verifies the signature (HS256), enforces MFA-setup gating, and confirms the
 * user is still active in the database.
 */
export function createAuthenticateToken(prisma: PrismaClient) {
  return async function authenticateToken(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const cookieToken = req.cookies?.[COOKIE_NAME] as string | undefined;
    const authHeader  = req.headers['authorization'];
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
    const token       = cookieToken ?? bearerToken ?? null;

    if (!token) {
      res.status(401).json({ error: 'Authentication required. Please login.' });
      return;
    }

    let payload: JwtPayload;
    try {
      payload = jwt.verify(token, JWT_SECRET_VALUE, { algorithms: ['HS256'] }) as JwtPayload;
    } catch {
      res.status(403).json({ error: 'Invalid or expired token. Please login again.' });
      return;
    }

    // Limited token (admin awaiting mandatory MFA setup) may only call MFA endpoints.
    if (payload.mfaSetupRequired) {
      const allowedPaths = ['/api/auth/mfa/setup', '/api/auth/mfa/enable'];
      if (!allowedPaths.includes(req.path)) {
        res.status(403).json({ error: 'MFA_SETUP_REQUIRED', message: 'Configure MFA to access this resource.' });
        return;
      }
    }

    // Verify the user is still active — a deactivated user's JWT must be
    // rejected immediately without waiting for natural expiry.
    try {
      const rows = await prisma.$queryRaw<{ active: boolean }[]>`
        SELECT COALESCE(active, true) AS active FROM "users" WHERE id = ${payload.id}::uuid LIMIT 1
      `;
      if (!rows.length || !rows[0].active) {
        res.status(403).json({ error: 'Account deactivated. Please contact an administrator.' });
        return;
      }
      req.user = payload;
      next();
    } catch {
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}

export { COOKIE_NAME };
