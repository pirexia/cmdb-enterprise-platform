import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

const SERVICE_TOKEN = process.env.CMDB_SERVICE_TOKEN;

if (!SERVICE_TOKEN || SERVICE_TOKEN.length < 32) {
  if (process.env.NODE_ENV === 'production') {
    console.error('[FATAL] CMDB_SERVICE_TOKEN must be set and ≥32 characters in production.');
    process.exit(1);
  } else {
    console.warn('[SECURITY WARNING] CMDB_SERVICE_TOKEN not set or too short. /api/internal/* unprotected in dev.');
  }
}

/**
 * Middleware de autenticación máquina-a-máquina para rutas /api/internal/*.
 *
 * Valida el header X-CMDB-Service-Token contra CMDB_SERVICE_TOKEN usando
 * comparación en tiempo constante (timingSafeEqual) para prevenir timing attacks.
 * Inyecta un principal sintético ADMIN para que los middlewares RBAC downstream
 * funcionen sin cambios.
 *
 * nginx bloquea /api/internal/ externamente (deny 404), así que este token
 * solo circula por la red interna Podman entre n8n-workers y el backend.
 */
export function authenticateService(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const provided = req.headers['x-cmdb-service-token'];

  const SERVICE_PRINCIPAL = {
    id:       'service',
    username: 'service',
    email:    'service@cmdb.local',
    role:     'ADMIN' as const,
  };

  if (!SERVICE_TOKEN) {
    if (process.env.NODE_ENV !== 'production') {
      req.user = SERVICE_PRINCIPAL;
      return next();
    }
    res.status(401).json({ error: 'Service authentication not configured.' });
    return;
  }

  if (typeof provided !== 'string') {
    res.status(401).json({ error: 'Missing X-CMDB-Service-Token header.' });
    return;
  }

  const expected = Buffer.from(SERVICE_TOKEN, 'utf8');
  const actual   = Buffer.from(provided,      'utf8');

  const valid =
    expected.length === actual.length &&
    crypto.timingSafeEqual(expected, actual);

  if (!valid) {
    res.status(401).json({ error: 'Invalid service token.' });
    return;
  }

  req.user = SERVICE_PRINCIPAL;
  next();
}
