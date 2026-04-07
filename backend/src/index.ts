import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import crypto from 'crypto';
// eslint-disable-next-line @typescript-eslint/no-require-imports
// @ts-ignore — helmet is installed in the Docker container via npm install
const helmet = require('helmet') as { default: (...args: unknown[]) => unknown } | ((...args: unknown[]) => unknown);
const helmetFn = typeof helmet === 'function' ? helmet : (helmet as { default: (...args: unknown[]) => unknown }).default;
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import https from 'https';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import { PrismaClient, Prisma, Criticality, Environment } from '@prisma/client';
import { runAndSendAlerts } from './services/emailService';
import { authenticateLDAP } from './services/ldap';
import { lookupEolWithFallbacks, fetchProductCycles } from './services/eolService';
import * as speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import multer from 'multer';

// ─── App setup ────────────────────────────────────────────────────────────────

const APP_ENV = process.env.APP_ENV ?? 'prod';
const IS_DEV = APP_ENV === 'dev';

// ── Conditional logging helper ────────────────────────────────────────────────
const log = {
  info: (...args: unknown[]) => { if (IS_DEV) console.log(...args); },
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
};

const app    = express();
const prisma = new PrismaClient();
const PORT   = process.env.PORT || 3000;

// ── JWT Secret — must be set via environment variable in production ────────────
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('[FATAL] JWT_SECRET environment variable is not set. Refusing to start in production.');
    process.exit(1);
  } else {
    console.warn('[SECURITY WARNING] JWT_SECRET is not set. Using insecure development default. NEVER use this in production!');
  }
}
const JWT_SECRET_VALUE = JWT_SECRET ?? 'cmdb-dev-secret-change-in-production';

// Trusted device TTL (default 30 days, configurable via env)
const TRUSTED_DEVICE_TTL_DAYS = parseInt(process.env.TRUSTED_DEVICE_TTL_DAYS ?? '30', 10);

// ── Password Policy (configurable via env) ────────────────────────────────────
const PASSWORD_MIN_LENGTH_ADMIN  = parseInt(process.env.PASSWORD_MIN_LENGTH_ADMIN  ?? '16', 10);
const PASSWORD_MIN_LENGTH_VIEWER = parseInt(process.env.PASSWORD_MIN_LENGTH_VIEWER ?? '12', 10);
const PASSWORD_HISTORY_COUNT     = parseInt(process.env.PASSWORD_HISTORY_COUNT     ?? '20', 10);
// bcrypt work factor — NIST SP 800-63B / OWASP recommends ≥12 (≥2^12 iterations)
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS ?? '12', 10);

// ─── Types ────────────────────────────────────────────────────────────────────

type UserRole = 'ADMIN' | 'AUDITOR' | 'VIEWER';

interface JwtPayload {
  id:               string;
  username:         string;
  email:            string;
  role:             UserRole;
  mfaSetupRequired?: boolean; // true = limited token, only /api/auth/mfa/* allowed
}

// Extend Express Request to carry the decoded JWT payload
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

// ─── Middleware ───────────────────────────────────────────────────────────────

// ── Helmet — security headers (ISO 27001 A.8.24, A.10.1) ─────────────────────
// Sets: X-Content-Type-Options, X-Frame-Options (clickjacking), HSTS,
//       X-XSS-Protection, Content-Security-Policy, Referrer-Policy, etc.
const isHttps = process.env.HTTPS_ENABLED === 'true';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.use((helmetFn as any)({
  // HSTS only meaningful over HTTPS
  hsts: isHttps
    ? { maxAge: 31536000, includeSubDomains: true, preload: true }
    : false,
  // Relax CSP for API-only server (no HTML served)
  contentSecurityPolicy: false,
}));

// ── CORS — strict allow-list from environment ─────────────────────────────────
const ALLOWED_ORIGINS = (
  process.env.CORS_ORIGINS ?? 'http://localhost:3001,http://localhost:3000'
).split(',').map((o) => o.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow server-to-server calls (no Origin header) and listed origins
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`[CORS] Blocked request from origin: ${origin}`);
      callback(new Error(`CORS policy: origin ${origin} not allowed`));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

app.use(express.json({ limit: '2mb' }));

// ── Rate limiting (OWASP: Brute-force prevention) ────────────────────────────

// Strict limiter for login: 10 attempts per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de acceso. Inténtelo de nuevo en 15 minutos.' },
  skipSuccessfulRequests: true, // only count failed attempts
});

// General API limiter: 300 requests per minute per IP
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas peticiones. Inténtelo de nuevo en un momento.' },
});

app.use('/api/', apiLimiter);

// ── Zod schemas (input validation) ───────────────────────────────────────────

const LoginSchema = z.object({
  email:       z.string().email('Email inválido').max(254),
  password:    z.string().min(1, 'La contraseña es obligatoria').max(128),
  mfaCode:     z.string().length(6).regex(/^\d{6}$/).optional(),
  trustDevice: z.boolean().optional(),
  deviceToken: z.string().max(128).optional(),
});

const CICreateSchema = z.object({
  name:        z.string().min(1).max(200),
  apiSlug:     z.string().min(1).max(200).regex(/^[a-z0-9-]+$/, 'Slug solo puede contener letras minúsculas, números y guiones'),
  criticality: z.enum(['LOW', 'MEDIUM', 'HIGH', 'MISSION_CRITICAL']),
  environment: z.enum(['DEVELOPMENT', 'TESTING', 'STAGING', 'PRODUCTION']),
  ciType:      z.string().max(50).optional(),
  status:      z.string().max(50).optional(),
  inventoryNumber: z.string().max(100).optional(),
  businessOwnerId: z.string().uuid().optional(),
  technicalLeadId: z.string().uuid().optional(),
  branchId:        z.string().uuid().optional(),
  ciModelId:       z.string().uuid().optional(),
  eolDate:         z.string().optional(),
  eosDate:         z.string().optional(),
  businessImpact:     z.enum(['LOW','MEDIUM','HIGH','CRITICAL']).optional(),
  recoveryPriority:   z.number().int().min(1).max(5).optional(),
  rto:                z.number().int().min(0).optional(),
  rpo:                z.number().int().min(0).optional(),
  spofRisk:           z.boolean().optional(),
  containsPii:        z.boolean().optional(),
  dataClassification: z.enum(['PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED']).optional(),
});

const ContractCreateSchema = z.object({
  contractNumber:    z.string().min(1).max(100),
  startDate:         z.string().min(1),
  endDate:           z.string().optional(),
  vendorId:          z.string().uuid(),
  parentContractId:  z.string().uuid().optional(),
  ciIds:             z.array(z.string().uuid()).optional(),
});

// ── Auth middleware ────────────────────────────────────────────────────────────

function authenticateToken(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: 'Authentication required. Please login.' });
    return;
  }

  let payload: JwtPayload;
  try {
    payload = jwt.verify(token, JWT_SECRET_VALUE) as JwtPayload;
  } catch {
    res.status(403).json({ error: 'Invalid or expired token. Please login again.' });
    return;
  }

  // Limited token (admin awaiting mandatory MFA setup) may only call MFA endpoints
  if (payload.mfaSetupRequired) {
    const allowedPaths = ['/api/auth/mfa/setup', '/api/auth/mfa/enable'];
    if (!allowedPaths.includes(req.path)) {
      res.status(403).json({ error: 'MFA_SETUP_REQUIRED', message: 'Configure MFA to access this resource.' });
      return;
    }
  }

  // Verify the user is still active in the database — a deactivated user's
  // existing JWT must be rejected immediately without waiting for expiry.
  prisma.$queryRaw<{ active: boolean }[]>`
    SELECT COALESCE(active, true) AS active FROM "users" WHERE id = ${payload.id}::uuid LIMIT 1
  `.then((rows) => {
    if (!rows.length || !rows[0].active) {
      res.status(403).json({ error: 'Account deactivated. Please contact an administrator.' });
      return;
    }
    req.user = payload;
    next();
  }).catch(() => {
    res.status(500).json({ error: 'Internal server error' });
  });
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || req.user.role !== 'ADMIN') {
    res.status(403).json({ error: 'Admin role required for this operation.' });
    return;
  }
  next();
}

/** Allows ADMIN and AUDITOR roles (read-only audit access). */
function requireAudit(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || !(['ADMIN', 'AUDITOR'] as UserRole[]).includes(req.user.role)) {
    res.status(403).json({ error: 'Audit access requires ADMIN or AUDITOR role.' });
    return;
  }
  next();
}

// ─── Password Policy ──────────────────────────────────────────────────────────

/** Common/weak passwords dictionary (case-insensitive check). */
const COMMON_PASSWORDS = new Set([
  'password','password1','password12','password123','password1234','password12345','password123456',
  'password1!','password@123','password@1234','p@ssword','p@ssword1','p@ssw0rd','passw0rd',
  'passw0rd1','passw0rd!','p@$$word','p@$$w0rd','passwort','contraseña','contrasena',
  'admin','admin1','admin12','admin123','admin1234','admin12345','admin123456',
  'admin@123','admin@1234','admin1234!','@dmin123','administrator','administrador',
  'welcome','welcome1','welcome123','welcome1234','welcome@123','welcome@1234','bienvenido',
  'letmein','letmein1','letmein123','letmein1234',
  'qwerty','qwerty1','qwerty12','qwerty123','qwerty1234','qwerty12345','qwerty@123',
  'azerty','azerty123','azerty@123',
  'abc123','abc1234','abc12345','123abc','123abc!',
  '123456','1234567','12345678','123456789','1234567890',
  '123456789!','12345678!','1234567!','12345678@',
  '11111111','22222222','33333333','44444444','55555555',
  '99999999','00000000','111111111','000000000',
  'aaaaaaaaa','aaaaaaaa1','aaaaaaaa!',
  'iloveyou','iloveyou1','iloveyou!','tequiero',
  'sunshine','sunshine1','monkey','monkey1','dragon','dragon1','master','master1',
  'trustno1','baseball','football','soccer','hockey','tennis','basketball',
  'batman','superman','spiderman','ironman','captain',
  'michael','jessica','ashley','jennifer','thomas',
  'changeme','changeme1','changeme123','changeme1234!','changeme@123',
  'test','test1','test12','test123','test1234','test@123','test@1234','testing',
  'pass','pass1','pass123','pass@123','pass@1234','pass1234',
  'login','login1','login123','login@123',
  'user','user1','user123','user@123','user1234','usuario',
  'root','root1','root123','root@123','rootadmin','root@1234',
  'secret','secret1','secret123','secret@123','secreto',
  'default','default1','default123','default@123',
  'company','company1','company123','company@123','empresa',
  'summer','summer23','summer2023','summer@2023','summer2024',
  'winter','winter23','winter2023','winter@2023','winter2024',
  'spring','spring23','spring2023','spring@2023',
  'autumn','autumn23','autumn2023',
  'january','february','march','april','august',
  'september','october','november','december',
  'monday','tuesday','wednesday','thursday','friday',
  'computer','computer1','computer@1','internet','internet1',
  'security','security1','security@1','seguridad',
  'qazwsx','qazwsxedc','zxcvbnm','asdfgh','asdfghjk',
  'asd123','123qwe','123asd',
  'helpme','helpme1','helpme123','mustang','shadow','ranger','hunter',
  'corvette','porsche','ferrari','mercedes','toyota',
  'liverpool','chelsea','madrid','barcelona','arsenal',
  'google','google123','facebook','facebook1','twitter',
  'linkedin','linkedin1','microsoft','microsoft1','windows',
  'manager','manager1','manager@1','gerente',
  'support','support1','support@1','soporte',
  'service','service1','service@1','servicio',
  'system','system1','system@1','sistema',
  'cmdb','cmdb123','cmdb@123','cmdb1234','cmdb@1234',
]);

/**
 * Validates a password against the security policy.
 * Returns an array of error messages (empty = valid).
 * Only applies to local (non-LDAP) users.
 */
function validatePasswordPolicy(password: string, role: UserRole): string[] {
  const errors: string[] = [];
  const minLen = role === 'ADMIN' ? PASSWORD_MIN_LENGTH_ADMIN : PASSWORD_MIN_LENGTH_VIEWER;

  if (password.length < minLen) {
    errors.push(`La contraseña debe tener al menos ${minLen} caracteres para el rol ${role}.`);
  }
  if (!/[A-Z]/.test(password)) errors.push('Debe contener al menos una letra mayúscula (A-Z).');
  if (!/[a-z]/.test(password)) errors.push('Debe contener al menos una letra minúscula (a-z).');
  if (!/[0-9]/.test(password)) errors.push('Debe contener al menos un número (0-9).');
  if (!/[^A-Za-z0-9]/.test(password)) errors.push('Debe contener al menos un carácter especial (!@#$%^&*…).');
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    errors.push('La contraseña es demasiado común o predecible. Elige una más segura.');
  }
  return errors;
}

/** Returns true if the password matches any of the last N history entries. */
async function isPasswordInHistory(userId: string, newPassword: string): Promise<boolean> {
  type HistRow = { hash: string };
  const history = await prisma.$queryRaw<HistRow[]>`
    SELECT hash FROM "password_history"
    WHERE user_id = ${userId}::uuid
    ORDER BY created_at DESC
    LIMIT ${PASSWORD_HISTORY_COUNT}
  `;
  for (const entry of history) {
    if (await bcrypt.compare(newPassword, entry.hash)) return true;
  }
  return false;
}

/** Inserts a new hash into password_history and prunes entries beyond the limit. */
async function recordPasswordHistory(userId: string, hash: string): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "password_history"(id, user_id, hash, created_at)
    VALUES(gen_random_uuid(), ${userId}::uuid, ${hash}, now())
  `;
  // Prune old entries beyond the configured limit
  await prisma.$executeRaw`
    DELETE FROM "password_history"
    WHERE user_id = ${userId}::uuid
    AND id NOT IN (
      SELECT id FROM "password_history"
      WHERE user_id = ${userId}::uuid
      ORDER BY created_at DESC
      LIMIT ${PASSWORD_HISTORY_COUNT}
    )
  `;
}

// ─── Prisma includes ──────────────────────────────────────────────────────────

const CI_INCLUDE = {
  hardware: true,
  software: true,
  location: true,
  costCenter: true,
  businessOwner: { select: { id: true, username: true, email: true } },
  technicalLead: { select: { id: true, username: true, email: true } },
  parentCI:  { select: { id: true, name: true, apiSlug: true } },
  childCIs:  { select: { id: true, name: true, apiSlug: true } },
  ciTypeDef: { select: { id: true, code: true, name: true, categoryCode: true } },
  contracts: {
    select: {
      id:             true,
      contractNumber: true,
      endDate:        true,
      vendor:         { select: { id: true, name: true } },
    },
  },
} as const;

// Flatten ciTypeDef relation into flat fields for backward-compatible API response
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function flattenCI(ci: any) {
  const { ciTypeDef, ciTypeId, ...rest } = ci;
  return {
    ...rest,
    ciTypeId:   ciTypeDef?.id           ?? null,
    ciType:     ciTypeDef?.code         ?? null,
    ciTypeName: ciTypeDef?.name         ?? null,
    ciTypeCategoryCode: ciTypeDef?.categoryCode ?? null,
  };
}

const CONTRACT_INCLUDE = {
  vendor: { select: { id: true, name: true } },
  cis: {
    select: {
      id: true, name: true, apiSlug: true,
      environment: true, criticality: true,
    },
  },
  parentContract: { select: { id: true, contractNumber: true } },
  addendums:      { select: { id: true, contractNumber: true } },
} as const;

// ─── Vulnerability types ──────────────────────────────────────────────────────

type VulnSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
type VulnStatus   = 'NUEVO' | 'ASIGNADO' | 'EN_CURSO' | 'PARADO' | 'RESUELTO';

interface Vulnerability {
  cve:         string;
  severity:    VulnSeverity;
  description: string;
  source?:     string;
  cvss_score?: number | null;
  status:      VulnStatus;
  importedAt:  string;
}

// ─── Public routes ────────────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * POST /api/auth/login
 * Returns a signed JWT on valid credentials.
 * Handles MFA verification, trusted devices, and first-login MFA prompts.
 */
app.post('/api/auth/login', loginLimiter, async (req: Request, res: Response) => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Datos de acceso inválidos' });
    return;
  }
  const { email, password, mfaCode, trustDevice, deviceToken } = parsed.data;

  try {
    type UserRow = {
      id: string; username: string; email: string; password: string | null;
      role: string; active: boolean;
      mfa_enabled: boolean; mfa_secret: string | null; mfa_prompted_at: Date | null;
    };

    let user: UserRow | null = null;
    let ldapSuccess = false;

    const isLocalAccount = email.endsWith('@cmdb.local') || email.endsWith('@cmdb.internal');

    if (process.env.USE_LDAP === 'true' && !isLocalAccount) {
      try {
        await authenticateLDAP(email, password);
        ldapSuccess = true;
        log.info(`[POST /api/auth/login] LDAP authentication successful for ${email}`);
      } catch (ldapErr) {
        log.warn('[POST /api/auth/login] LDAP authentication failed, attempting local fallback:', ldapErr);
      }

      if (ldapSuccess) {
        let rows = await prisma.$queryRaw<UserRow[]>`
          SELECT id, username, email, password, role, COALESCE(active, true) AS active,
                 mfa_enabled, mfa_secret, mfa_prompted_at
          FROM "users" WHERE email = ${email} LIMIT 1
        `;
        if (rows.length === 0) {
          const username  = email.split('@')[0];
          const dummyHash = await bcrypt.hash(`ldap-provisioned-${Date.now()}`, BCRYPT_ROUNDS);
          await prisma.$executeRaw`
            INSERT INTO "users" (id, username, email, password, role, sso_external_id, created_at, updated_at)
            VALUES (gen_random_uuid(), ${username}, ${email}, ${dummyHash}, 'VIEWER', ${email}, now(), now())
          `;
          rows = await prisma.$queryRaw<UserRow[]>`
            SELECT id, username, email, password, role, COALESCE(active, true) AS active,
                   mfa_enabled, mfa_secret, mfa_prompted_at
            FROM "users" WHERE email = ${email} LIMIT 1
          `;
          log.info(`[POST /api/auth/login] Auto-provisioned LDAP shadow user: ${email}`);
        }
        user = rows[0];
      }
    }

    if (!ldapSuccess) {
      const rows = await prisma.$queryRaw<UserRow[]>`
        SELECT id, username, email, password, role, COALESCE(active, true) AS active,
               mfa_enabled, mfa_secret, mfa_prompted_at
        FROM "users" WHERE email = ${email} LIMIT 1
      `;
      if (!rows[0] || !rows[0].password) {
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }
      const valid = await bcrypt.compare(password, rows[0].password);
      if (!valid) {
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }
      user = rows[0];
      log.info(`[POST /api/auth/login] Local authentication successful for ${email}`);
    }

    if (!user) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    if (!user.active) {
      res.status(401).json({ error: 'Account is disabled. Contact your administrator.' });
      return;
    }

    // ── Helper: build and sign full JWT ──────────────────────────────────────
    const signFullToken = () => {
      const p: JwtPayload = { id: user!.id, username: user!.username, email: user!.email, role: user!.role as UserRole };
      return jwt.sign(p, JWT_SECRET_VALUE, { expiresIn: '8h' });
    };
    const userObj = () => ({ id: user!.id, username: user!.username, email: user!.email, role: user!.role, mfa_enabled: user!.mfa_enabled });

    // ── Helper: create trusted device record ──────────────────────────────────
    const createTrustedDevice = async (): Promise<string> => {
      const tok      = crypto.randomBytes(32).toString('hex');
      const expiry   = new Date();
      expiry.setDate(expiry.getDate() + TRUSTED_DEVICE_TTL_DAYS);
      const ua  = req.headers['user-agent'] ?? null;
      const ip  = req.ip ?? null;
      await prisma.$executeRaw`
        INSERT INTO "trusted_devices" (id, user_id, token, user_agent, ip_address, expires_at, created_at, last_seen_at)
        VALUES (gen_random_uuid(), ${user!.id}::uuid, ${tok}, ${ua}, ${ip}, ${expiry}, now(), now())
      `;
      return tok;
    };

    // ── MFA enabled path ──────────────────────────────────────────────────────
    if (user.mfa_enabled && user.mfa_secret) {
      // Check trusted device first
      if (deviceToken) {
        const trusted = await prisma.$queryRaw<{ id: string }[]>`
          SELECT id FROM "trusted_devices"
          WHERE token = ${deviceToken} AND user_id = ${user.id}::uuid AND expires_at > now()
          LIMIT 1
        `;
        if (trusted.length > 0) {
          await prisma.$executeRaw`UPDATE "trusted_devices" SET last_seen_at = now() WHERE token = ${deviceToken}`;
          res.json({ token: signFullToken(), user: userObj() });
          return;
        }
      }

      // Need MFA code
      if (!mfaCode) {
        res.status(401).json({ error: 'MFA_REQUIRED' });
        return;
      }

      const mfaValid = speakeasy.totp.verify({ secret: user.mfa_secret, encoding: 'base32', token: mfaCode, window: 1 });
      if (!mfaValid) {
        res.status(401).json({ error: 'INVALID_MFA_CODE' });
        return;
      }

      let newDeviceToken: string | undefined;
      if (trustDevice) newDeviceToken = await createTrustedDevice();

      res.json({ token: signFullToken(), user: userObj(), ...(newDeviceToken ? { deviceToken: newDeviceToken } : {}) });
      return;
    }

    // ── MFA not enabled: check if setup is needed ─────────────────────────────
    if (user.role === 'ADMIN') {
      // Admin: mandatory MFA setup — issue short-lived limited token
      const limitedPayload: JwtPayload = { id: user.id, username: user.username, email: user.email, role: user.role as UserRole, mfaSetupRequired: true };
      const limitedToken = jwt.sign(limitedPayload, JWT_SECRET_VALUE, { expiresIn: '15m' });
      res.json({ token: limitedToken, user: userObj(), requireAction: 'MFA_SETUP_REQUIRED' });
      return;
    }

    // Non-admin: suggest MFA on first login
    if (!user.mfa_prompted_at) {
      await prisma.$executeRaw`UPDATE "users" SET mfa_prompted_at = now(), updated_at = now() WHERE id = ${user.id}::uuid`;
      res.json({ token: signFullToken(), user: userObj(), requireAction: 'MFA_SETUP_SUGGESTED' });
      return;
    }

    // Normal login (non-admin, already prompted before or MFA skipped)
    res.json({ token: signFullToken(), user: userObj() });

  } catch (error) {
    console.error('[POST /api/auth/login] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Protected routes (authentication required from here on) ─────────────────

// ── Users ────────────────────────────────────────────────────────────────────

app.get('/api/users', authenticateToken, async (_req: Request, res: Response) => {
  try {
    type UserRow = { id: string; username: string; email: string; role: string; active: boolean; sso_external_id: string | null; mfa_enabled: boolean; created_at: Date };
    const users = await prisma.$queryRaw<UserRow[]>`
      SELECT id, username, email, role,
             COALESCE(active, true) AS active,
             sso_external_id, mfa_enabled, created_at
      FROM "users" ORDER BY username ASC
    `;
    res.json(users);
  } catch (error) {
    console.error('[GET /api/users] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /api/users/:id/role
 * Changes a user's role (ADMIN | VIEWER). ADMIN only.
 */
app.patch('/api/users/:id/role', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const { role } = req.body as { role?: string };
  if (!role || !(['ADMIN', 'AUDITOR', 'VIEWER'] as string[]).includes(role)) {
    res.status(400).json({ error: 'role must be "ADMIN", "AUDITOR" or "VIEWER"' });
    return;
  }
  try {
    await prisma.$executeRaw`UPDATE "users" SET role = ${role}, updated_at = now() WHERE id = ${id}::uuid`;
    await prisma.$executeRaw`
      INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
      VALUES(gen_random_uuid(), ${'SET_ROLE:' + role}, 'USER', ${id}, ${req.user!.email}, now())
    `;
    res.json({ id, role, message: `Role updated to ${role}` });
  } catch (e) {
    console.error('[PATCH /api/users/:id/role]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /api/users/:id/status
 * Activates or deactivates a user account. ADMIN only.
 * Body: { active: boolean }
 */
app.patch('/api/users/:id/status', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const { active } = req.body as { active?: boolean };
  if (typeof active !== 'boolean') {
    res.status(400).json({ error: 'active must be a boolean' });
    return;
  }
  // Prevent self-deactivation
  if (id === req.user!.id && !active) {
    res.status(400).json({ error: 'You cannot deactivate your own account' });
    return;
  }
  try {
    await prisma.$executeRaw`UPDATE "users" SET active = ${active}, updated_at = now() WHERE id = ${id}::uuid`;
    await prisma.$executeRaw`
      INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
      VALUES(gen_random_uuid(), ${active ? 'ACTIVATE_USER' : 'DEACTIVATE_USER'}, 'USER', ${id}, ${req.user!.email}, now())
    `;
    res.json({ id, active, message: active ? 'User activated' : 'User deactivated' });
  } catch (e) {
    console.error('[PATCH /api/users/:id/status]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/profile/change-password
 * Authenticated user changes their own password. Local (non-LDAP) accounts only.
 * Body: { currentPassword, newPassword }
 */
app.post('/api/profile/change-password', authenticateToken, async (req: Request, res: Response) => {
  const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword?: string };
  if (!currentPassword || !newPassword) {
    res.status(400).json({ error: 'currentPassword and newPassword are required.' });
    return;
  }
  try {
    type UserRow = { id: string; password: string | null; sso_external_id: string | null; role: string };
    const rows = await prisma.$queryRaw<UserRow[]>`
      SELECT id, password, sso_external_id, role FROM "users" WHERE id = ${req.user!.id}::uuid
    `;
    const user = rows[0];
    if (!user) { res.status(404).json({ error: 'User not found.' }); return; }

    // LDAP/AD users cannot change password here
    if (user.sso_external_id) {
      res.status(403).json({ error: 'LDAP_USER', message: 'Los usuarios LDAP/AD deben cambiar su contraseña a través del controlador de dominio.' });
      return;
    }
    if (!user.password) { res.status(400).json({ error: 'No hay contraseña local configurada.' }); return; }

    // Verify current password
    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) {
      res.status(401).json({ error: 'WRONG_CURRENT_PASSWORD', message: 'La contraseña actual es incorrecta.' });
      return;
    }

    // Cannot reuse current password
    if (currentPassword === newPassword) {
      res.status(422).json({ error: 'PASSWORD_POLICY', details: ['La nueva contraseña no puede ser igual a la actual.'] });
      return;
    }

    // Policy check (length, complexity, dictionary)
    const policyErrors = validatePasswordPolicy(newPassword, user.role as UserRole);
    if (policyErrors.length > 0) {
      res.status(422).json({ error: 'PASSWORD_POLICY', details: policyErrors });
      return;
    }

    // Password history check
    const inHistory = await isPasswordInHistory(user.id, newPassword);
    if (inHistory) {
      res.status(422).json({ error: 'PASSWORD_HISTORY', message: `No puedes reutilizar ninguna de tus últimas ${PASSWORD_HISTORY_COUNT} contraseñas.` });
      return;
    }

    // Apply change
    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await prisma.$executeRaw`UPDATE "users" SET password = ${newHash}, updated_at = now() WHERE id = ${user.id}::uuid`;
    await recordPasswordHistory(user.id, newHash);
    await prisma.$executeRaw`
      INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
      VALUES(gen_random_uuid(), 'CHANGE_PASSWORD', 'USER', ${user.id}, ${req.user!.email}, now())
    `;

    res.json({ message: 'Contraseña actualizada correctamente.' });
  } catch (e) {
    console.error('[POST /api/profile/change-password]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/users/:id/reset-password
 * Admin resets another user's password. Local (non-LDAP) accounts only.
 * Body: { newPassword }
 */
app.post('/api/users/:id/reset-password', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const { newPassword } = req.body as { newPassword?: string };
  if (!newPassword) { res.status(400).json({ error: 'newPassword is required.' }); return; }
  try {
    type UserRow = { id: string; sso_external_id: string | null; role: string; email: string };
    const rows = await prisma.$queryRaw<UserRow[]>`
      SELECT id, sso_external_id, role, email FROM "users" WHERE id = ${id}::uuid
    `;
    const user = rows[0];
    if (!user) { res.status(404).json({ error: 'User not found.' }); return; }

    if (user.sso_external_id) {
      res.status(403).json({ error: 'LDAP_USER', message: 'No se puede resetear la contraseña de usuarios LDAP/AD.' });
      return;
    }

    const policyErrors = validatePasswordPolicy(newPassword, user.role as UserRole);
    if (policyErrors.length > 0) {
      res.status(422).json({ error: 'PASSWORD_POLICY', details: policyErrors });
      return;
    }

    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await prisma.$executeRaw`UPDATE "users" SET password = ${newHash}, updated_at = now() WHERE id = ${id}::uuid`;
    await recordPasswordHistory(user.id, newHash);
    await prisma.$executeRaw`
      INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
      VALUES(gen_random_uuid(), 'RESET_PASSWORD', 'USER', ${id}, ${req.user!.email}, now())
    `;

    res.json({ message: `Contraseña reseteada para el usuario ${user.email}.` });
  } catch (e) {
    console.error('[POST /api/users/:id/reset-password]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Vendors ──────────────────────────────────────────────────────────────────

app.get('/api/vendors', authenticateToken, async (_req: Request, res: Response) => {
  try {
    const vendors = await prisma.vendor.findMany({
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    res.json(vendors);
  } catch (error) {
    console.error('[GET /api/vendors] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Configuration Items ───────────────────────────────────────────────────────

const CI_MAX_PAGE_SIZE = 500;
app.get('/api/cis', authenticateToken, async (req: Request, res: Response) => {
  const rawLimit = parseInt(String(req.query.limit ?? '200'), 10);
  const limit    = Math.min(isNaN(rawLimit) || rawLimit < 1 ? 200 : rawLimit, CI_MAX_PAGE_SIZE);
  const rawPage  = parseInt(String(req.query.page  ?? '1'),   10);
  const page     = isNaN(rawPage) || rawPage < 1 ? 1 : rawPage;
  const skip     = (page - 1) * limit;
  try {
    const [total, cis] = await Promise.all([
      prisma.cI.count(),
      prisma.cI.findMany({ include: CI_INCLUDE, orderBy: { createdAt: 'asc' }, skip, take: limit }),
    ]);
    res.json({ total, page, limit, data: cis.map(flattenCI) });
  } catch (error) {
    console.error('[GET /api/cis] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/cis', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  log.info('[POST /api/cis] Body received:', JSON.stringify(req.body, null, 2));
  const ciParsed = CICreateSchema.safeParse(req.body);
  if (!ciParsed.success) {
    res.status(400).json({ error: ciParsed.error.issues[0]?.message ?? 'Datos de CI inválidos' });
    return;
  }
  try {
    const {
      name, apiSlug, criticality, environment,
      ciTypeId, status, inventoryNumber,
      branchId, ciModelId,
      businessOwnerId, technicalLeadId, hardware, software,
      eolDate: eolDateRaw, eosDate: eosDateRaw,
      businessImpact, recoveryPriority, rto, rpo, spofRisk, containsPii, dataClassification,
    } = req.body as {
      name: string; apiSlug: string;
      criticality: Criticality; environment: Environment;
      ciTypeId?: string; status?: string; inventoryNumber?: string;
      branchId?: string; ciModelId?: string;
      businessOwnerId?: string; technicalLeadId?: string;
      hardware?: { serialNumber: string; model: string; manufacturer: string };
      software?: { version: string; licenseType: string };
      eolDate?: string; eosDate?: string;
      businessImpact?: string; recoveryPriority?: number; rto?: number; rpo?: number;
      spofRisk?: boolean; containsPii?: boolean; dataClassification?: string;
    };

    if (!name || !apiSlug || !criticality || !environment) {
      res.status(400).json({ error: 'Missing required fields: name, apiSlug, criticality, environment' });
      return;
    }

    const validCriticalities: Criticality[] = ['LOW', 'MEDIUM', 'HIGH', 'MISSION_CRITICAL'];
    const validEnvironments: Environment[]  = ['DEVELOPMENT', 'TESTING', 'STAGING', 'PRODUCTION'];
    if (!validCriticalities.includes(criticality)) { res.status(400).json({ error: `Invalid criticality: ${criticality}` }); return; }
    if (!validEnvironments.includes(environment))  { res.status(400).json({ error: `Invalid environment: ${environment}` });  return; }
    if (hardware && software)                      { res.status(400).json({ error: 'A CI cannot be both Hardware and Software' }); return; }

    // ── EOL auto-populate from endoflife.date if dates not provided ───────────
    let resolvedEolDate:     Date | null = eolDateRaw  ? new Date(eolDateRaw)  : null;
    let resolvedSupportDate: Date | null = eosDateRaw  ? new Date(eosDateRaw)  : null;

    if (!resolvedEolDate && !resolvedSupportDate) {
      const swVersion = (software as { version?: string } | undefined)?.version;
      const mfr       = (hardware as { manufacturer?: string } | undefined)?.manufacturer;
      const mdl       = (hardware as { model?: string } | undefined)?.model;
      const aliases   = [name, mfr && mdl ? `${mfr} ${mdl}` : '', mdl ?? '', name].filter(Boolean) as string[];
      const eolInfo   = await lookupEolWithFallbacks(aliases, swVersion).catch(() => null);
      if (eolInfo) {
        if (eolInfo.eolDate     && !resolvedEolDate)     resolvedEolDate     = eolInfo.eolDate;
        if (eolInfo.supportDate && !resolvedSupportDate) resolvedSupportDate = eolInfo.supportDate;
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ci = await prisma.cI.create({
      data: {
        name, apiSlug, criticality, environment,
        ciTypeId:        ciTypeId        || null,
        status:          status          || "ACTIVO",
        inventoryNumber: inventoryNumber || null,
        branchId:        branchId        || null,
        ciModelId:       ciModelId       || null,
        eolDate:         resolvedEolDate     || null,
        eosDate:         resolvedSupportDate || null,
        businessOwnerId: businessOwnerId || null,
        technicalLeadId: technicalLeadId || null,
        businessImpact:     businessImpact     || null,
        recoveryPriority:   recoveryPriority   ?? null,
        rto:                rto                ?? null,
        rpo:                rpo                ?? null,
        spofRisk:           spofRisk           ?? false,
        containsPii:        containsPii        ?? false,
        dataClassification: dataClassification || null,
        ...(hardware && { hardware: { create: { serialNumber: hardware.serialNumber, model: hardware.model, manufacturer: hardware.manufacturer } } }),
        ...(software && { software: { create: { version: software.version, licenseType: software.licenseType } } }),
      } as Parameters<typeof prisma.cI.create>[0]['data'],
      include: CI_INCLUDE,
    });

    // Audit log (raw — Prisma client types regenerate after migrate)
    await prisma.$executeRaw`
      INSERT INTO "audit_logs" (id, action, entity, entity_id, user_email, created_at)
      VALUES (gen_random_uuid(), 'CREATE_CI', 'CI', ${ci.id}, ${req.user!.email}, now())
    `;

    res.status(201).json(flattenCI(ci));
  } catch (error: unknown) {
    console.error('[POST /api/cis] Error:', error);
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === 'P2002') {
      res.status(409).json({ error: 'A CI with this slug or serial number already exists' });
      return;
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /api/cis/:id
 * Updates a Configuration Item.
 * ADMIN only.
 */
app.patch('/api/cis/:id', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  log.info(`[PATCH /api/cis/${id}] Body received:`, JSON.stringify(req.body, null, 2));

  try {
    const {
      name, criticality, environment, ciTypeId, status, inventoryNumber,
      branchId, ciModelId, businessOwnerId, technicalLeadId,
      eolDate: eolDateRaw, eosDate: eosDateRaw,
      businessImpact, recoveryPriority, rto, rpo, spofRisk, containsPii, dataClassification,
    } = req.body as {
      name?: string; criticality?: Criticality; environment?: Environment;
      ciTypeId?: string | null; status?: string; inventoryNumber?: string;
      branchId?: string | null; ciModelId?: string | null;
      businessOwnerId?: string | null; technicalLeadId?: string | null;
      eolDate?: string | null; eosDate?: string | null;
      businessImpact?: string | null; recoveryPriority?: number | null; rto?: number | null; rpo?: number | null;
      spofRisk?: boolean; containsPii?: boolean; dataClassification?: string | null;
    };

    const updateData: Record<string, unknown> = {};
    if (name) updateData.name = name;
    if (criticality) updateData.criticality = criticality;
    if (environment) updateData.environment = environment;
    if (ciTypeId !== undefined) updateData.ciTypeId = ciTypeId || null;
    if (status) updateData.status = status;
    if (inventoryNumber !== undefined) updateData.inventoryNumber = inventoryNumber || null;
    if (branchId !== undefined) updateData.branchId = branchId || null;
    if (ciModelId !== undefined) updateData.ciModelId = ciModelId || null;
    if (businessOwnerId !== undefined) updateData.businessOwnerId = businessOwnerId || null;
    if (technicalLeadId !== undefined) updateData.technicalLeadId = technicalLeadId || null;
    if (eolDateRaw !== undefined) updateData.eolDate = eolDateRaw ? new Date(eolDateRaw) : null;
    if (eosDateRaw !== undefined) updateData.eosDate = eosDateRaw ? new Date(eosDateRaw) : null;
    if (businessImpact     !== undefined) updateData.businessImpact     = businessImpact     || null;
    if (recoveryPriority   !== undefined) updateData.recoveryPriority   = recoveryPriority   ?? null;
    if (rto                !== undefined) updateData.rto                = rto                ?? null;
    if (rpo                !== undefined) updateData.rpo                = rpo                ?? null;
    if (spofRisk           !== undefined) updateData.spofRisk           = spofRisk;
    if (containsPii        !== undefined) updateData.containsPii        = containsPii;
    if (dataClassification !== undefined) updateData.dataClassification = dataClassification || null;

    const ci = await prisma.cI.update({
      where: { id },
      data: updateData,
      include: CI_INCLUDE,
    });

    await prisma.$executeRaw`
      INSERT INTO "audit_logs" (id, action, entity, entity_id, user_email, created_at)
      VALUES (gen_random_uuid(), 'UPDATE_CI', 'CI', ${id}, ${req.user!.email}, now())
    `;

    res.json(flattenCI(ci));
  } catch (error: unknown) {
    console.error('[PATCH /api/cis/:id] Error:', error);
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === 'P2025') {
      res.status(404).json({ error: 'CI not found' });
      return;
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/cis/:id
 * Deletes a Configuration Item (cascade deletes hardware/software).
 * ADMIN only.
 */
app.delete('/api/cis/:id', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  const id = req.params.id as string;

  try {
    // Check if CI exists
    const ci = await prisma.cI.findUnique({ where: { id }, select: { name: true } });
    if (!ci) {
      res.status(404).json({ error: 'CI not found' });
      return;
    }

    // Delete CI (cascade handles hardware/software via Prisma schema)
    await prisma.cI.delete({ where: { id } });

    await prisma.$executeRaw`
      INSERT INTO "audit_logs" (id, action, entity, entity_id, user_email, created_at)
      VALUES (gen_random_uuid(), ${'DELETE_CI:' + ci.name}, 'CI', ${id}, ${req.user!.email}, now())
    `;

    res.json({ id, message: `CI "${ci.name}" deleted successfully` });
  } catch (error) {
    console.error('[DELETE /api/cis/:id] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Vulnerability Lifecycle ───────────────────────────────────────────────────

/**
 * PATCH /api/vulnerabilities
 * Updates the status of a single vulnerability within a CI's JSON array.
 *
 * Body: { ciId: string, cve: string, status: VulnStatus }
 */
app.patch('/api/vulnerabilities', authenticateToken, async (req: Request, res: Response) => {
  const { ciId, cve, status } = req.body as {
    ciId:   string;
    cve:    string;
    status: VulnStatus;
  };

  if (!ciId || !cve || !status) {
    res.status(400).json({ error: 'Missing required fields: ciId, cve, status' });
    return;
  }

  const validStatuses: VulnStatus[] = ['NUEVO', 'ASIGNADO', 'EN_CURSO', 'PARADO', 'RESUELTO'];
  if (!validStatuses.includes(status)) {
    res.status(400).json({ error: `Invalid status: ${status}. Must be one of ${validStatuses.join(', ')}` });
    return;
  }

  try {
    // Fetch current vulnerabilities
    type VulnRow = { id: string; vulnerabilities: unknown };
    const rows = await prisma.$queryRaw<VulnRow[]>`
      SELECT id, vulnerabilities FROM "configuration_items" WHERE id = ${ciId}::uuid LIMIT 1
    `;

    if (rows.length === 0) {
      res.status(404).json({ error: `CI with id ${ciId} not found` });
      return;
    }

    const currentVulns = (rows[0].vulnerabilities ?? []) as Vulnerability[];
    const vuln = currentVulns.find((v) => v.cve === cve);

    if (!vuln) {
      res.status(404).json({ error: `Vulnerability ${cve} not found in CI ${ciId}` });
      return;
    }

    const updated = currentVulns.map((v) =>
      v.cve === cve ? { ...v, status, updatedAt: new Date().toISOString() } : v
    );

    await prisma.$executeRaw`
      UPDATE "configuration_items"
      SET "vulnerabilities" = ${JSON.stringify(updated)}::jsonb
      WHERE "id" = ${ciId}::uuid
    `;

    // Audit log (raw — Prisma client types regenerate after migrate)
    const entityId = `${ciId}:${cve}`;
    const action   = `UPDATE_VULN_STATUS:${status}`;
    await prisma.$executeRaw`
      INSERT INTO "audit_logs" (id, action, entity, entity_id, user_email, created_at)
      VALUES (gen_random_uuid(), ${action}, 'VULNERABILITY', ${entityId}, ${req.user!.email}, now())
    `;

    res.json({ ciId, cve, status, message: `Status updated to ${status}` });
  } catch (error) {
    console.error('[PATCH /api/vulnerabilities] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Contracts ─────────────────────────────────────────────────────────────────

app.get('/api/contracts', authenticateToken, async (_req: Request, res: Response) => {
  try {
    const contracts = await prisma.contract.findMany({
      include: CONTRACT_INCLUDE,
      orderBy: { startDate: 'desc' },
    });
    res.json({ total: contracts.length, data: contracts });
  } catch (error) {
    console.error('[GET /api/contracts] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/contracts', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  log.info('[POST /api/contracts] Body received:', JSON.stringify(req.body, null, 2));
  const contractParsed = ContractCreateSchema.safeParse(req.body);
  if (!contractParsed.success) {
    res.status(400).json({ error: contractParsed.error.issues[0]?.message ?? 'Datos de contrato inválidos' });
    return;
  }
  try {
    const { contractNumber, startDate, endDate, vendorId, parentContractId, ciIds } = contractParsed.data;

    const contract = await prisma.contract.create({
      data: {
        contractNumber,
        startDate:        new Date(startDate),
        endDate:          endDate ? new Date(endDate) : null,
        vendorId,
        parentContractId: parentContractId || null,
        ...(ciIds && ciIds.length > 0 && { cis: { connect: ciIds.map((id) => ({ id })) } }),
      },
      include: CONTRACT_INCLUDE,
    });

    res.status(201).json(contract);
  } catch (error: unknown) {
    console.error('[POST /api/contracts] Error:', error);
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === 'P2002') {
      res.status(409).json({ error: 'A contract with this number already exists' });
      return;
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── EOL Catalog Proxy ─────────────────────────────────────────────────────────

const POPULAR_MANUFACTURERS = [
  'Dell','HP','HPE','Cisco','IBM','Lenovo','Apple','Microsoft','Intel','AMD',
  'Nvidia','NetApp','EMC','Oracle','Sun Microsystems','Juniper Networks',
  'Aruba Networks','Fortinet','Palo Alto Networks','VMware',
  'Red Hat','Canonical','Google','Amazon Web Services','Huawei',
  'Samsung','Sophos','Check Point','F5 Networks','Broadcom',
];

app.post('/api/masters/sync-catalog', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  const { action, query } = req.body as { action?: string; query?: string };

  if (action === 'sync-manufacturers') {
    let created = 0; let skipped = 0; let errors = 0;
    const errorLog: string[] = [];
    for (const name of POPULAR_MANUFACTURERS) {
      try {
        const r = await prisma.$executeRaw`
          INSERT INTO "manufacturers"(id, name, created_at, updated_at)
          VALUES(gen_random_uuid(), ${name}, now(), now())
          ON CONFLICT (name) DO NOTHING
        `;
        if (Number(r) > 0) { created++; } else { skipped++; }
      } catch (e) {
        errors++;
        errorLog.push(`${name}: ${String(e).slice(0, 80)}`);
        console.error(`[sync-manufacturers] Error inserting "${name}":`, e);
      }
    }
    log.info(`[sync-manufacturers] created=${created}, skipped=${skipped}, errors=${errors}`);
    res.json({ message: `${created} insertados, ${skipped} ya existían, ${errors} errores`, created, skipped, errors, errorLog });
    return;
  }

  if (action === 'search') {
    if (!query?.trim()) { res.status(400).json({ error: 'query is required' }); return; }
    const slug   = query.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 60);
    const cycles = await fetchProductCycles(slug).catch(() => null);
    if (!cycles) {
      res.json({ product: slug, cycles: [], found: false, message: `"${query}" no encontrado en endoflife.date` });
      return;
    }
    res.json({ product: slug, cycles, found: true });
    return;
  }

  res.status(400).json({ error: 'action must be "sync-manufacturers" or "search"' });
});

// ── Bulk CI Import ────────────────────────────────────────────────────────────

/**
 * POST /api/cis/bulk
 * Accepts an array of up to 500 CI objects and creates them.
 * Returns a 207 Multi-Status with per-row results.
 * ADMIN only.
 */
app.post('/api/cis/bulk', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  type BulkRow = {
    name?: string; ciType?: string; criticality?: string; environment?: string;
    manufacturer?: string; serialNumber?: string; model?: string;
    version?: string; licenseType?: string;
    licenseModel?: string; licenseMetric?: string; licenseQty?: string; licenseExpiry?: string;
    // ignored extra columns (ipAddress, description, status)
    [key: string]: unknown;
  };

  const rows = req.body as BulkRow[];
  if (!Array.isArray(rows) || rows.length === 0) {
    res.status(400).json({ error: 'Body must be a non-empty array of CI objects' });
    return;
  }
  if (rows.length > 500) {
    res.status(400).json({ error: 'Max 500 rows per import' });
    return;
  }

  // Load ci_types lookup map (code → id) for bulk import resolution
  const allCITypes = await prisma.cIType.findMany({ select: { id: true, code: true } });
  const ciTypeCodeToId = new Map<string, string>(allCITypes.map(t => [t.code, t.id]));
  // Legacy alias
  if (ciTypeCodeToId.has('NETWORK')) ciTypeCodeToId.set('NETWORK_EQUIPMENT', ciTypeCodeToId.get('NETWORK')!);

  const validCriticalities = ['LOW', 'MEDIUM', 'HIGH', 'MISSION_CRITICAL'];
  const validEnvironments  = ['DEVELOPMENT', 'TESTING', 'STAGING', 'PRODUCTION'];

  const hwTypes = [
    'PHYSICAL_SERVER','VIRTUAL_SERVER','NETWORK','NETWORK_EQUIPMENT','STORAGE','BACKUP',
    'HARDWARE','DESKTOP','LAPTOP','PRINTER','SCANNER','MONITOR',
    'VIDEOCONFERENCE','SMART_DISPLAY','TIME_CLOCK','IP_PHONE',
    'SMARTPHONE','TABLET','PDA','BARCODE_SCANNER',
    'IP_CAMERA','UPS','WIFI_AP','CLOUD_INSTANCE','CLOUD_STORAGE',
  ];
  const swTypes = ['SOFTWARE','DATABASE','BACKUP','BASE_SOFTWARE','LICENSE'];

  const results: { name: string; status: 'created' | 'error'; id?: string; error?: string }[] = [];
  let successCount = 0;
  let errorCount   = 0;

  for (const row of rows) {
    const name = (row.name ?? '').trim();
    if (!name) {
      results.push({ name: '(vacío)', status: 'error', error: 'Missing required field: name' });
      errorCount++; continue;
    }

    const ciTypeCode = (row.ciType ?? 'OTHER').trim().toUpperCase();
    const ciTypeId   = ciTypeCodeToId.get(ciTypeCode) ?? ciTypeCodeToId.get('OTHER') ?? null;
    const crit    = (row.criticality ?? '').trim().toUpperCase();
    const env     = (row.environment  ?? '').trim().toUpperCase();
    const criticality = (validCriticalities.includes(crit) ? crit : 'MEDIUM') as Criticality;
    const environment = (validEnvironments.includes(env)   ? env  : 'PRODUCTION') as Environment;

    // Unique slug: name-slug + random suffix
    const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 40);
    const apiSlug = `${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;

    const needsHw = hwTypes.includes(ciTypeCode);
    const needsSw = swTypes.includes(ciTypeCode);

    try {
      const ci = await prisma.cI.create({
        data: {
          name, apiSlug, criticality, environment, ciTypeId,
          ...(needsHw && {
            hardware: {
              create: {
                serialNumber: (row.serialNumber ?? `AUTO-${Date.now()}`).trim() || `AUTO-${Date.now()}`,
                model:        (row.model        ?? 'Unknown').trim() || 'Unknown',
                manufacturer: (row.manufacturer ?? 'Unknown').trim() || 'Unknown',
              },
            },
          }),
          ...(needsSw && {
            software: {
              create: {
                version:     (row.version     ?? '1.0').trim() || '1.0',
                licenseType: (row.licenseType ?? '').trim(),
              },
            },
          }),
        } as Parameters<typeof prisma.cI.create>[0]['data'],
      });
      results.push({ name, status: 'created', id: ci.id });
      successCount++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ name, status: 'error', error: msg });
      errorCount++;
    }
  }

  res.status(207).json({
    message: `Importación completa: ${successCount} creados, ${errorCount} errores`,
    successCount, errorCount, results,
  });
});

// ── Audit Logs ────────────────────────────────────────────────────────────────

/**
 * GET /api/audit-logs
 * Returns up to 500 audit log entries ordered by date descending.
 * Supports optional ?from=ISO&to=ISO date-range filtering.
 * Resolves entity_name via LEFT JOINs for CI, VULNERABILITY, Document, USER, CI_RELATION, SYSTEM.
 * ADMIN and AUDITOR only.
 */
app.get('/api/audit-logs', authenticateToken, requireAudit, async (req: Request, res: Response) => {
  try {
    // ── Validate optional date-range params ──────────────────────────────────
    const { from, to } = req.query as { from?: string; to?: string };
    let fromDate: Date | undefined;
    let toDate: Date | undefined;

    if (from) {
      fromDate = new Date(from);
      if (isNaN(fromDate.getTime())) {
        res.status(400).json({ error: 'Invalid "from" date parameter' });
        return;
      }
    }
    if (to) {
      toDate = new Date(to);
      if (isNaN(toDate.getTime())) {
        res.status(400).json({ error: 'Invalid "to" date parameter' });
        return;
      }
    }

    // ── Build dynamic WHERE clause ───────────────────────────────────────────
    const conditions: Prisma.Sql[] = [];
    if (fromDate) conditions.push(Prisma.sql`al.created_at >= ${fromDate}::timestamptz`);
    if (toDate) conditions.push(Prisma.sql`al.created_at <= ${toDate}::timestamptz`);
    const whereClause = conditions.length > 0
      ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}`
      : Prisma.empty;

    type AuditRow = { id: string; action: string; entity: string; entity_id: string; user_email: string; created_at: Date; entity_name: string | null };
    const logs = await prisma.$queryRaw<AuditRow[]>`
      SELECT
        al.id, al.action, al.entity, al.entity_id, al.user_email, al.created_at,
        CASE al.entity
          WHEN 'CI' THEN ci.name
          WHEN 'VULNERABILITY' THEN CONCAT(vuln_ci.name, ' · ', split_part(al.entity_id, ':', 2))
          WHEN 'Document' THEN doc.title
          WHEN 'USER' THEN u.email
          WHEN 'CI_RELATION' THEN CONCAT(src.name, ' → ', tgt.name)
          WHEN 'SYSTEM' THEN al.entity_id
          ELSE NULL
        END AS entity_name
      FROM audit_logs al
      LEFT JOIN configuration_items ci ON al.entity = 'CI' AND al.entity_id::uuid = ci.id
      LEFT JOIN configuration_items vuln_ci ON al.entity = 'VULNERABILITY' AND split_part(al.entity_id, ':', 1)::uuid = vuln_ci.id
      LEFT JOIN documents doc ON al.entity = 'Document' AND al.entity_id::uuid = doc.id
      LEFT JOIN users u ON al.entity = 'USER' AND al.entity_id::uuid = u.id
      LEFT JOIN ci_relations rel ON al.entity = 'CI_RELATION' AND al.entity_id::uuid = rel.id
      LEFT JOIN configuration_items src ON al.entity = 'CI_RELATION' AND rel.source_ci_id = src.id
      LEFT JOIN configuration_items tgt ON al.entity = 'CI_RELATION' AND rel.target_ci_id = tgt.id
      ${whereClause}
      ORDER BY al.created_at DESC
      LIMIT 500
    `;
    res.json({ total: logs.length, data: logs });
  } catch (error) {
    console.error('[GET /api/audit-logs] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── MFA (TOTP) ────────────────────────────────────────────────────────────────

/**
 * POST /api/auth/mfa/setup
 * Generates a TOTP secret + QR code Data URL for the authenticated user.
 * The secret is persisted as mfa_pending_secret (NOT mfa_secret) so the
 * client cannot supply its own secret during /mfa/enable.
 */
app.post('/api/auth/mfa/setup', authenticateToken, async (req: Request, res: Response) => {
  try {
    const secretObj = speakeasy.generateSecret({ name: `CMDB Enterprise (${req.user!.email})`, length: 20 });
    const secret    = secretObj.base32;
    const otpauth   = secretObj.otpauth_url ?? speakeasy.otpauthURL({ secret, label: req.user!.email, issuer: 'CMDB Enterprise', encoding: 'base32' });
    const qrDataUrl = await QRCode.toDataURL(otpauth);

    // Store the pending secret server-side so /mfa/enable can retrieve it
    // without trusting any client-supplied value.
    await prisma.$executeRaw`
      UPDATE "users" SET mfa_pending_secret = ${secret}, updated_at = now() WHERE id = ${req.user!.id}::uuid
    `;

    res.json({ secret, qrDataUrl });
  } catch (error) {
    console.error('[POST /api/auth/mfa/setup] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/auth/mfa/enable
 * Verifies the first TOTP code against the server-stored pending secret,
 * persists the secret, and returns a new full JWT.
 * Body: { code: string, trustDevice?: boolean }
 * NOTE: 'secret' is intentionally NOT accepted from the client — it is read
 * from mfa_pending_secret to prevent a bypass via a client-controlled value.
 */
app.post('/api/auth/mfa/enable', authenticateToken, async (req: Request, res: Response) => {
  const { code, trustDevice } = req.body as { code?: string; trustDevice?: boolean };
  if (!code) {
    res.status(400).json({ error: 'code is required' });
    return;
  }
  try {
    // Retrieve the server-generated pending secret — never trust the client
    const rows = await prisma.$queryRaw<{ mfa_pending_secret: string | null }[]>`
      SELECT mfa_pending_secret FROM "users" WHERE id = ${req.user!.id}::uuid LIMIT 1
    `;
    const secret = rows[0]?.mfa_pending_secret ?? null;
    if (!secret) {
      res.status(400).json({ error: 'MFA setup not initiated. Please call /api/auth/mfa/setup first.' });
      return;
    }
    const valid = speakeasy.totp.verify({ secret, encoding: 'base32', token: code, window: 1 });
    if (!valid) {
      res.status(400).json({ error: 'Invalid TOTP code. Please try again.' });
      return;
    }
    await prisma.$executeRaw`
      UPDATE "users"
      SET mfa_secret = ${secret}, mfa_enabled = true, mfa_pending_secret = NULL, updated_at = now()
      WHERE id = ${req.user!.id}::uuid
    `;
    // Issue a new full JWT (replaces limited token if admin had mfaSetupRequired)
    const newPayload: JwtPayload = { id: req.user!.id, username: req.user!.username, email: req.user!.email, role: req.user!.role };
    const newToken = jwt.sign(newPayload, JWT_SECRET_VALUE, { expiresIn: '8h' });

    let newDeviceToken: string | undefined;
    if (trustDevice) {
      newDeviceToken = crypto.randomBytes(32).toString('hex');
      const expiry = new Date();
      expiry.setDate(expiry.getDate() + TRUSTED_DEVICE_TTL_DAYS);
      const ua = req.headers['user-agent'] ?? null;
      const ip = req.ip ?? null;
      await prisma.$executeRaw`
        INSERT INTO "trusted_devices" (id, user_id, token, user_agent, ip_address, expires_at, created_at, last_seen_at)
        VALUES (gen_random_uuid(), ${req.user!.id}::uuid, ${newDeviceToken}, ${ua}, ${ip}, ${expiry}, now(), now())
      `;
    }

    const userObj = { id: req.user!.id, username: req.user!.username, email: req.user!.email, role: req.user!.role, mfa_enabled: true };
    res.json({ message: 'MFA enabled successfully', token: newToken, user: userObj, ...(newDeviceToken ? { deviceToken: newDeviceToken } : {}) });
  } catch (error) {
    console.error('[POST /api/auth/mfa/enable] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── SSL/TLS Certificate Management ──────────────────────────────────────────

/**
 * POST /api/admin/certificates/csr
 * Generates a private key and CSR for SSL/TLS certificates.
 * Body: { cn: string, o?: string, ou?: string, c?: string, st?: string }
 * Returns: { csr: string, message: string }
 * ADMIN only.
 */
app.post('/api/admin/certificates/csr', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  const { cn, o, ou, c, st } = req.body as { cn?: string; o?: string; ou?: string; c?: string; st?: string };

  if (!cn?.trim()) {
    res.status(400).json({ error: 'cn (Common Name) is required' });
    return;
  }

  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    const certDir = '/app/certs';
    const keyPath = path.join(certDir, 'server.key');
    const csrPath = path.join(certDir, 'server.csr');

    // Ensure directory exists (mapped from host via volume)
    fs.mkdirSync(certDir, { recursive: true });

    // Build OpenSSL subject string
    const subject = `/CN=${cn}${c ? `/C=${c}` : ''}${st ? `/ST=${st}` : ''}${o ? `/O=${o}` : ''}${ou ? `/OU=${ou}` : ''}`;

    // Generate new private key and CSR
    const cmd = `openssl req -new -newkey rsa:2048 -nodes -keyout "${keyPath}" -out "${csrPath}" -subj "${subject}"`;
    
    log.info(`[POST /api/admin/certificates/csr] Generating CSR with subject: ${subject}`);
    const { stderr } = await execAsync(cmd);
    
    if (stderr && !stderr.includes('writing')) {
      log.warn(`[POST /api/admin/certificates/csr] OpenSSL stderr: ${stderr}`);
    }

    // Read generated CSR
    const csrContent = fs.readFileSync(csrPath, 'utf8');

    res.json({
      csr: csrContent,
      message: 'CSR generated successfully. Send this to your CA for signing. The private key has been saved securely.',
      keyPath: '/certs/server.key (inside container)',
      csrPath: '/certs/server.csr (inside container)',
    });

  } catch (error) {
    log.error('[POST /api/admin/certificates/csr] Error:', error);
    res.status(500).json({ error: 'Failed to generate CSR. Ensure OpenSSL is available.' });
  }
});

/**
 * POST /api/admin/certificates/upload
 * Uploads a signed certificate file (.crt/.pem) from the CA.
 * Body: { certificate: string } (PEM-encoded certificate content)
 * Returns: { message: string }
 * ADMIN only.
 */
app.post('/api/admin/certificates/upload', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  const { certificate } = req.body as { certificate?: string };

  if (!certificate?.trim()) {
    res.status(400).json({ error: 'certificate content is required (PEM format)' });
    return;
  }

  // Validate PEM format
  if (!certificate.includes('-----BEGIN CERTIFICATE-----') || !certificate.includes('-----END CERTIFICATE-----')) {
    res.status(400).json({ error: 'Invalid certificate format. Must be PEM-encoded.' });
    return;
  }

  try {
    const certDir = '/app/certs';
    const certPath = path.join(certDir, 'server.crt');

    // Ensure directory exists (mapped from host via volume)
    fs.mkdirSync(certDir, { recursive: true });

    // Write certificate to file
    fs.writeFileSync(certPath, certificate.trim() + '\n', { mode: 0o600 });

    log.info(`[POST /api/admin/certificates/upload] Certificate uploaded successfully by ${req.user!.email}`);

    // Audit log
    await prisma.$executeRaw`
      INSERT INTO "audit_logs" (id, action, entity, entity_id, user_email, created_at)
      VALUES (gen_random_uuid(), 'UPLOAD_CERTIFICATE', 'SYSTEM', 'ssl-cert', ${req.user!.email}, now())
    `;

    res.json({
      message: 'Certificate uploaded successfully. Restart the backend container to apply changes.',
      restartCommand: 'docker compose -f docker-compose.prod.yml restart backend',
      certPath: '/certs/server.crt (inside container)',
    });

  } catch (error) {
    log.error('[POST /api/admin/certificates/upload] Error:', error);
    res.status(500).json({ error: 'Failed to save certificate' });
  }
});

// ─── Admin Utilities ──────────────────────────────────────────────────────────

/**
 * POST /api/admin/reset-vulnerabilities
 * Clears the vulnerabilities field on ALL CIs (sets to empty array []).
 * Use this to wipe simulation/test data before a fresh connector import.
 * ADMIN only.
 */
app.post('/api/admin/reset-vulnerabilities', authenticateToken, requireAdmin, async (_req: Request, res: Response) => {
  try {
    const result = await prisma.$executeRaw`
      UPDATE "configuration_items"
      SET "vulnerabilities" = '[]'::jsonb
      WHERE "vulnerabilities" IS NOT NULL
    `;
    log.info(`[POST /api/admin/reset-vulnerabilities] Reset ${result} CI(s)`);
    res.json({ message: `Vulnerabilities cleared on ${result} configuration item(s)`, reset: result });
  } catch (error) {
    console.error('[POST /api/admin/reset-vulnerabilities] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Master Data CRUD ─────────────────────────────────────────────────────────
// All endpoints use raw SQL (Prisma client regenerates inside Docker post-migration)

type MasterRow = { id: string; name: string; [k: string]: unknown };

// ── Debug: verify manufacturers table ──────────────────────────────────────────
app.get('/api/masters/manufacturers/debug', authenticateToken, requireAdmin, async (_req, res) => {
  try {
    const rows  = await prisma.$queryRaw<{ id: string; name: string }[]>`SELECT id::text, name FROM "manufacturers" ORDER BY name ASC`;
    const count = await prisma.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*) AS c FROM "manufacturers"`;
    res.json({ count: Number(count[0]?.c ?? 0), rows });
  } catch (e) { res.status(500).json({ error: 'Internal server error' }); }
});

// ── Clear all manufacturers (test helper) ──────────────────────────────────────
app.delete('/api/masters/manufacturers/all', authenticateToken, requireAdmin, async (_req, res) => {
  try {
    const n = await prisma.$executeRaw`DELETE FROM "manufacturers"`;
    res.json({ deleted: Number(n), message: `${Number(n)} fabricante(s) eliminados` });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Support Areas
app.get('/api/masters/support-areas', authenticateToken, async (_req, res) => {
  try {
    const rows = await prisma.$queryRaw<MasterRow[]>`SELECT id::text AS id, name FROM "support_areas" ORDER BY name ASC`;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.post('/api/masters/support-areas', authenticateToken, requireAdmin, async (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name?.trim()) { res.status(400).json({ error: 'name required' }); return; }
  try {
    const rows = await prisma.$queryRaw<MasterRow[]>`INSERT INTO "support_areas"(id,name,created_at,updated_at) VALUES(gen_random_uuid(),${name.trim()},now(),now()) RETURNING id::text AS id, name`;
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.patch('/api/masters/support-areas/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name?.trim()) { res.status(400).json({ error: 'name required' }); return; }
  try {
    const rows = await prisma.$queryRaw<MasterRow[]>`UPDATE "support_areas" SET name=${name.trim()}, updated_at=now() WHERE id=${req.params.id}::uuid RETURNING id::text AS id, name`;
    if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.delete('/api/masters/support-areas/:id', authenticateToken, requireAdmin, async (req, res) => {
  try { await prisma.$executeRaw`DELETE FROM "support_areas" WHERE id=${req.params.id}::uuid`; res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

// Branches
app.get('/api/masters/branches', authenticateToken, async (_req, res) => {
  try {
    const rows = await prisma.$queryRaw<(MasterRow & { branch_code: string; physical_address: string | null; support_area_id: string; support_area_name: string })[]>`
      SELECT b.id::text AS id, b.name, b.branch_code, b.physical_address, b.support_area_id::text AS support_area_id, sa.name AS support_area_name
      FROM "branches" b LEFT JOIN "support_areas" sa ON b.support_area_id = sa.id ORDER BY b.name ASC`;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.post('/api/masters/branches', authenticateToken, requireAdmin, async (req, res) => {
  const { name, branchCode, physicalAddress, supportAreaId } = req.body as { name?: string; branchCode?: string; physicalAddress?: string; supportAreaId?: string };
  if (!name?.trim() || !branchCode?.trim() || !supportAreaId) { res.status(400).json({ error: 'name, branchCode, supportAreaId required' }); return; }
  try {
    const rows = await prisma.$queryRaw<MasterRow[]>`
      INSERT INTO "branches"(id,name,branch_code,physical_address,support_area_id,created_at,updated_at)
      VALUES(gen_random_uuid(),${name.trim()},${branchCode.trim()},${physicalAddress || null},${supportAreaId}::uuid,now(),now()) RETURNING id::text AS id, name`;
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.patch('/api/masters/branches/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { name, branchCode, physicalAddress, supportAreaId } = req.body as { name?: string; branchCode?: string; physicalAddress?: string; supportAreaId?: string };
  if (!name?.trim() || !branchCode?.trim() || !supportAreaId) { res.status(400).json({ error: 'name, branchCode, supportAreaId required' }); return; }
  try {
    const rows = await prisma.$queryRaw<MasterRow[]>`
      UPDATE "branches" SET name=${name.trim()}, branch_code=${branchCode.trim()}, physical_address=${physicalAddress || null}, support_area_id=${supportAreaId}::uuid, updated_at=now()
      WHERE id=${req.params.id}::uuid RETURNING id::text AS id, name`;
    if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.delete('/api/masters/branches/:id', authenticateToken, requireAdmin, async (req, res) => {
  try { await prisma.$executeRaw`DELETE FROM "branches" WHERE id=${req.params.id}::uuid`; res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

// Manufacturers
app.get('/api/masters/manufacturers', authenticateToken, async (_req, res) => {
  try {
    const rows = await prisma.$queryRaw<MasterRow[]>`SELECT id::text AS id, name FROM "manufacturers" ORDER BY name ASC`;
    log.info(`[GET /api/masters/manufacturers] rows=${rows.length}`);
    res.json(rows);
  } catch (e) { console.error('[GET /api/masters/manufacturers]', e); res.status(500).json({ error: String(e) }); }
});
app.post('/api/masters/manufacturers', authenticateToken, requireAdmin, async (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name?.trim()) { res.status(400).json({ error: 'name required' }); return; }
  try {
    const rows = await prisma.$queryRaw<MasterRow[]>`INSERT INTO "manufacturers"(id,name,created_at,updated_at) VALUES(gen_random_uuid(),${name.trim()},now(),now()) RETURNING id::text AS id, name`;
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.patch('/api/masters/manufacturers/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name?.trim()) { res.status(400).json({ error: 'name required' }); return; }
  try {
    const rows = await prisma.$queryRaw<MasterRow[]>`UPDATE "manufacturers" SET name=${name.trim()}, updated_at=now() WHERE id=${req.params.id}::uuid RETURNING id::text AS id, name`;
    if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.delete('/api/masters/manufacturers/:id', authenticateToken, requireAdmin, async (req, res) => {
  try { await prisma.$executeRaw`DELETE FROM "manufacturers" WHERE id=${req.params.id}::uuid`; res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

// Device Models
app.get('/api/masters/device-models', authenticateToken, async (_req, res) => {
  try {
    const rows = await prisma.$queryRaw<(MasterRow & { manufacturer_id: string; manufacturer_name: string })[]>`
      SELECT dm.id::text AS id, dm.name, dm.manufacturer_id::text AS manufacturer_id, m.name AS manufacturer_name
      FROM "device_models" dm LEFT JOIN "manufacturers" m ON dm.manufacturer_id = m.id ORDER BY m.name, dm.name`;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.post('/api/masters/device-models', authenticateToken, requireAdmin, async (req, res) => {
  const { name, manufacturerId } = req.body as { name?: string; manufacturerId?: string };
  if (!name?.trim() || !manufacturerId) { res.status(400).json({ error: 'name, manufacturerId required' }); return; }
  try {
    const rows = await prisma.$queryRaw<MasterRow[]>`
      INSERT INTO "device_models"(id,name,manufacturer_id,created_at,updated_at)
      VALUES(gen_random_uuid(),${name.trim()},${manufacturerId}::uuid,now(),now()) RETURNING id::text AS id, name`;
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.patch('/api/masters/device-models/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { name, manufacturerId } = req.body as { name?: string; manufacturerId?: string };
  if (!name?.trim() || !manufacturerId) { res.status(400).json({ error: 'name, manufacturerId required' }); return; }
  try {
    const rows = await prisma.$queryRaw<MasterRow[]>`
      UPDATE "device_models" SET name=${name.trim()}, manufacturer_id=${manufacturerId}::uuid, updated_at=now()
      WHERE id=${req.params.id}::uuid RETURNING id::text AS id, name`;
    if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.delete('/api/masters/device-models/:id', authenticateToken, requireAdmin, async (req, res) => {
  try { await prisma.$executeRaw`DELETE FROM "device_models" WHERE id=${req.params.id}::uuid`; res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

// Providers
app.get('/api/masters/providers', authenticateToken, async (_req, res) => {
  try {
    const rows = await prisma.$queryRaw<MasterRow[]>`SELECT id::text AS id, name FROM "providers" ORDER BY name ASC`;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.post('/api/masters/providers', authenticateToken, requireAdmin, async (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name?.trim()) { res.status(400).json({ error: 'name required' }); return; }
  try {
    const rows = await prisma.$queryRaw<MasterRow[]>`INSERT INTO "providers"(id,name,created_at,updated_at) VALUES(gen_random_uuid(),${name.trim()},now(),now()) RETURNING id::text AS id, name`;
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.patch('/api/masters/providers/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name?.trim()) { res.status(400).json({ error: 'name required' }); return; }
  try {
    const rows = await prisma.$queryRaw<MasterRow[]>`UPDATE "providers" SET name=${name.trim()}, updated_at=now() WHERE id=${req.params.id}::uuid RETURNING id::text AS id, name`;
    if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.delete('/api/masters/providers/:id', authenticateToken, requireAdmin, async (req, res) => {
  try { await prisma.$executeRaw`DELETE FROM "providers" WHERE id=${req.params.id}::uuid`; res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

// Cost Centers
app.get('/api/masters/cost-centers', authenticateToken, async (_req, res) => {
  try {
    const rows = await prisma.$queryRaw<{ id: string; code: string; name: string }[]>`SELECT id::text AS id, code, name FROM "cost_centers" ORDER BY code ASC`;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.post('/api/masters/cost-centers', authenticateToken, requireAdmin, async (req, res) => {
  const { code, name } = req.body as { code?: string; name?: string };
  if (!code?.trim() || !name?.trim()) { res.status(400).json({ error: 'code and name required' }); return; }
  try {
    const rows = await prisma.$queryRaw<{ id: string; code: string; name: string }[]>`
      INSERT INTO "cost_centers"(id,code,name,created_at,updated_at) VALUES(gen_random_uuid(),${code.trim()},${name.trim()},now(),now())
      RETURNING id::text AS id, code, name`;
    res.status(201).json(rows[0]);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('unique') || msg.includes('duplicate')) { res.status(409).json({ error: 'El código ya existe' }); return; }
    res.status(500).json({ error: msg });
  }
});
app.patch('/api/masters/cost-centers/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { code, name } = req.body as { code?: string; name?: string };
  if (!code?.trim() || !name?.trim()) { res.status(400).json({ error: 'code and name required' }); return; }
  try {
    const rows = await prisma.$queryRaw<{ id: string; code: string; name: string }[]>`
      UPDATE "cost_centers" SET code=${code.trim()}, name=${name.trim()}, updated_at=now()
      WHERE id=${req.params.id}::uuid RETURNING id::text AS id, code, name`;
    if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(rows[0]);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('unique') || msg.includes('duplicate')) { res.status(409).json({ error: 'El código ya existe' }); return; }
    res.status(500).json({ error: msg });
  }
});
app.delete('/api/masters/cost-centers/:id', authenticateToken, requireAdmin, async (req, res) => {
  try { await prisma.$executeRaw`DELETE FROM "cost_centers" WHERE id=${req.params.id}::uuid`; res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

// ─── CI Type Categories (read-only, fixed) ─────────────────────────────────────
app.get('/api/masters/ci-type-categories', authenticateToken, async (_req, res) => {
  try {
    const cats = await prisma.cITypeCategory.findMany({
      orderBy: { sortOrder: 'asc' },
      include: {
        ciTypes: {
          orderBy: { sortOrder: 'asc' },
          select: { id: true, code: true, name: true, sortOrder: true, isSystem: true },
        },
      },
    });
    res.json(cats);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ─── CI Types CRUD ─────────────────────────────────────────────────────────────
app.get('/api/masters/ci-types', authenticateToken, async (_req, res) => {
  try {
    const types = await prisma.cIType.findMany({
      orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }],
      select: { id: true, code: true, name: true, categoryCode: true, sortOrder: true, isSystem: true },
    });
    res.json(types);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/masters/ci-types', authenticateToken, requireAdmin, async (req, res) => {
  const { code, name, categoryCode, sortOrder } = req.body as { code?: string; name?: string; categoryCode?: string; sortOrder?: number };
  if (!code?.trim() || !name?.trim() || !categoryCode?.trim()) {
    res.status(400).json({ error: 'code, name and categoryCode are required' }); return;
  }
  try {
    const row = await prisma.cIType.create({
      data: { code: code.trim().toUpperCase(), name: name.trim(), categoryCode: categoryCode.trim(), sortOrder: sortOrder ?? 50, isSystem: false },
      select: { id: true, code: true, name: true, categoryCode: true, sortOrder: true, isSystem: true },
    });
    res.status(201).json(row);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('unique') || msg.includes('Unique')) { res.status(409).json({ error: 'El código ya existe' }); return; }
    res.status(500).json({ error: msg });
  }
});

app.patch('/api/masters/ci-types/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { name, categoryCode, sortOrder } = req.body as { name?: string; categoryCode?: string; sortOrder?: number };
  if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return; }
  const id = String(req.params.id);
  try {
    const row = await prisma.cIType.update({
      where: { id },
      data: { name: name.trim(), ...(categoryCode && { categoryCode }), ...(sortOrder !== undefined && { sortOrder }) },
      select: { id: true, code: true, name: true, categoryCode: true, sortOrder: true, isSystem: true },
    });
    res.json(row);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.delete('/api/masters/ci-types/:id', authenticateToken, requireAdmin, async (req, res) => {
  const id = String(req.params.id);
  try {
    const row = await prisma.cIType.findUnique({ where: { id }, select: { code: true } });
    if (!row) { res.status(404).json({ error: 'Tipo no encontrado' }); return; }
    // Check if any CI uses this type before attempting delete
    const ciCount = await prisma.cI.count({ where: { ciTypeId: id } });
    if (ciCount > 0) {
      res.status(409).json({ error: `No se puede eliminar: ${ciCount} CI${ciCount > 1 ? 's' : ''} tienen este tipo asignado` });
      return;
    }
    await prisma.cIType.delete({ where: { id } });
    res.json({ ok: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: msg });
  }
});

/**
 * POST /api/masters/device-models/:id/sync-eol
 * Looks up EOL dates for the device model on endoflife.date and updates
 * all CIs linked to this model with the resolved dates.
 * ADMIN only.
 */
app.post('/api/masters/device-models/:id/sync-eol', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  try {
    type ModelRow = { id: string; name: string; manufacturer_name: string };
    const rows = await prisma.$queryRaw<ModelRow[]>`
      SELECT dm.id, dm.name, m.name AS manufacturer_name
      FROM "device_models" dm LEFT JOIN "manufacturers" m ON dm.manufacturer_id = m.id
      WHERE dm.id = ${id}::uuid LIMIT 1
    `;
    if (rows.length === 0) { res.status(404).json({ error: 'Model not found' }); return; }

    const model  = rows[0];
    const eolInfo = await lookupEolWithFallbacks(
      [model.name, `${model.manufacturer_name} ${model.name}`, model.manufacturer_name].filter(Boolean)
    ).catch(() => null);

    if (!eolInfo?.eolDate && !eolInfo?.supportDate) {
      res.json({ message: `No EOL data found for "${model.name}" on endoflife.date`, updated: 0 });
      return;
    }

    // Update all CIs linked to this device model
    let updated = 0;
    if (eolInfo.eolDate) {
      const r = await prisma.$executeRaw`
        UPDATE "configuration_items"
        SET eol_date = ${eolInfo.eolDate}, updated_at = now()
        WHERE ci_model_id = ${id}::uuid AND eol_date IS NULL
      `;
      updated = Number(r);
    }
    if (eolInfo.supportDate) {
      await prisma.$executeRaw`
        UPDATE "configuration_items"
        SET eos_date = ${eolInfo.supportDate}, updated_at = now()
        WHERE ci_model_id = ${id}::uuid AND eos_date IS NULL
      `;
    }

    res.json({
      message:     `EOL sync complete for model "${model.name}"`,
      eolDate:     eolInfo.eolDate,
      supportDate: eolInfo.supportDate,
      updated,
    });
  } catch (error) {
    console.error('[POST /api/masters/device-models/:id/sync-eol] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── CI Relationships (Topology) ──────────────────────────────────────────────

/**
 * GET /api/cis/:id/relations
 * Returns all relationships for a specific CI (both outgoing and incoming).
 */
app.get('/api/cis/:id/relations', authenticateToken, async (req: Request, res: Response) => {
  const id    = req.params.id as string;
  // depth: how many hops from the root CI to traverse (1–4, default 1)
  const depth = Math.min(Math.max(parseInt(req.query.depth as string) || 1, 1), 4);

  try {
    type RelationRow = {
      id: string;
      source_ci_id: string;
      target_ci_id: string;
      relation_type: string;
      created_at: Date;
      source_name: string;
      source_slug: string;
      target_name: string;
      target_slug: string;
      depth: number;
    };

    let relations: RelationRow[];

    if (depth === 1) {
      // Simple query — direct relations only
      relations = await prisma.$queryRaw<RelationRow[]>`
        SELECT
          r.id::text,
          r.source_ci_id::text,
          r.target_ci_id::text,
          r.relation_type,
          r.created_at,
          s.name        AS source_name,
          s.api_slug    AS source_slug,
          t.name        AS target_name,
          t.api_slug    AS target_slug,
          1             AS depth
        FROM ci_relations r
        JOIN configuration_items s ON r.source_ci_id = s.id
        JOIN configuration_items t ON r.target_ci_id = t.id
        WHERE r.source_ci_id = ${id}::uuid OR r.target_ci_id = ${id}::uuid
        ORDER BY r.created_at DESC
      `;
    } else {
      // Recursive CTE — traverses up to `depth` hops from the root CI.
      // Cycle prevention: the `visited` array tracks CIs already on the
      // current path; a frontier CI already in `visited` is not expanded.
      // DISTINCT ON keeps the minimum-depth occurrence of each relation.
      relations = await prisma.$queryRaw<RelationRow[]>`
        WITH RECURSIVE traversal AS (
          -- Base: edges directly touching the root CI
          SELECT
            r.id,
            r.source_ci_id,
            r.target_ci_id,
            r.relation_type,
            r.created_at,
            s.name        AS source_name,
            s.api_slug    AS source_slug,
            t.name        AS target_name,
            t.api_slug    AS target_slug,
            1::int        AS depth,
            CASE WHEN r.source_ci_id = ${id}::uuid
                 THEN r.target_ci_id
                 ELSE r.source_ci_id END AS frontier,
            ARRAY[${id}::uuid]          AS visited
          FROM ci_relations r
          JOIN configuration_items s ON r.source_ci_id = s.id
          JOIN configuration_items t ON r.target_ci_id = t.id
          WHERE r.source_ci_id = ${id}::uuid
             OR r.target_ci_id = ${id}::uuid

          UNION ALL

          -- Recursive: expand one hop from the frontier CI
          SELECT
            r.id,
            r.source_ci_id,
            r.target_ci_id,
            r.relation_type,
            r.created_at,
            s.name,
            s.api_slug,
            t.name,
            t.api_slug,
            prev.depth + 1,
            CASE WHEN r.source_ci_id = prev.frontier
                 THEN r.target_ci_id
                 ELSE r.source_ci_id END,
            prev.visited || prev.frontier
          FROM ci_relations r
          JOIN configuration_items s ON r.source_ci_id = s.id
          JOIN configuration_items t ON r.target_ci_id = t.id
          JOIN traversal prev ON (
               r.source_ci_id = prev.frontier
            OR r.target_ci_id = prev.frontier
          )
          WHERE prev.depth < ${depth}
            AND NOT (prev.frontier = ANY(prev.visited))
        )
        SELECT DISTINCT ON (id::text)
          id::text,
          source_ci_id::text,
          target_ci_id::text,
          relation_type,
          created_at,
          source_name,
          source_slug,
          target_name,
          target_slug,
          depth
        FROM traversal
        ORDER BY id::text, depth ASC
      `;
    }

    const outgoing = relations.filter((r) => r.source_ci_id === id);
    const incoming = relations.filter((r) => r.target_ci_id === id);

    res.json({ outgoing, incoming, all: relations, total: relations.length });
  } catch (error) {
    console.error('[GET /api/cis/:id/relations] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/cis/:id/relations
 * Creates a new relationship between two CIs.
 * Body: { targetCiId: string, relationType: string }
 * ADMIN only.
 */
app.post('/api/cis/:id/relations', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  const sourceCiId = req.params.id as string;
  const { targetCiId, relationType } = req.body as { targetCiId?: string; relationType?: string };

  if (!targetCiId || !relationType) {
    res.status(400).json({ error: 'targetCiId and relationType are required' });
    return;
  }

  const validTypes = ['HOSTS', 'DEPENDS_ON', 'CONNECTED_TO', 'PROVIDES_SERVICE', 'BACKED_UP_BY'];
  if (!validTypes.includes(relationType)) {
    res.status(400).json({ error: `Invalid relationType. Must be one of: ${validTypes.join(', ')}` });
    return;
  }

  if (sourceCiId === targetCiId) {
    res.status(400).json({ error: 'A CI cannot have a relationship with itself' });
    return;
  }

  try {
    // Check if both CIs exist
    const ciCheck = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) AS count FROM configuration_items WHERE id IN (${sourceCiId}::uuid, ${targetCiId}::uuid)
    `;
    
    if (Number(ciCheck[0]?.count) !== 2) {
      res.status(404).json({ error: 'One or both CIs not found' });
      return;
    }

    // Create relation
    const relation = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO ci_relations (id, source_ci_id, target_ci_id, relation_type, created_by, created_at)
      VALUES (gen_random_uuid(), ${sourceCiId}::uuid, ${targetCiId}::uuid, ${relationType}::"RelationType", ${req.user!.email}, now())
      RETURNING id::text
    `;

    await prisma.$executeRaw`
      INSERT INTO "audit_logs" (id, action, entity, entity_id, user_email, created_at)
      VALUES (gen_random_uuid(), ${'CREATE_RELATION:' + relationType}, 'CI_RELATION', ${relation[0].id}, ${req.user!.email}, now())
    `;

    res.status(201).json({ id: relation[0].id, sourceCiId, targetCiId, relationType, message: 'Relationship created successfully' });
  } catch (error: unknown) {
    console.error('[POST /api/cis/:id/relations] Error:', error);
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === '23505') {
      res.status(409).json({ error: 'This relationship already exists' });
      return;
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/relations
 * Creates a new relationship between two CIs.
 * Body: { sourceCiId: string, targetCiId: string, relationType: string }
 * ADMIN only.
 */
app.post('/api/relations', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  const { sourceCiId, targetCiId, relationType } = req.body as { sourceCiId?: string; targetCiId?: string; relationType?: string };

  if (!sourceCiId || !targetCiId || !relationType) {
    res.status(400).json({ error: 'sourceCiId, targetCiId and relationType are required' });
    return;
  }

  const validTypes = ['HOSTS', 'DEPENDS_ON', 'CONNECTED_TO', 'PROVIDES_SERVICE', 'BACKED_UP_BY'];
  if (!validTypes.includes(relationType)) {
    res.status(400).json({ error: `Invalid relationType. Must be one of: ${validTypes.join(', ')}` });
    return;
  }

  if (sourceCiId === targetCiId) {
    res.status(400).json({ error: 'A CI cannot have a relationship with itself' });
    return;
  }

  try {
    const ciCheck = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) AS count FROM configuration_items WHERE id IN (${sourceCiId}::uuid, ${targetCiId}::uuid)
    `;

    if (Number(ciCheck[0]?.count) !== 2) {
      res.status(404).json({ error: 'One or both CIs not found' });
      return;
    }

    const relation = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO ci_relations (id, source_ci_id, target_ci_id, relation_type, created_by, created_at)
      VALUES (gen_random_uuid(), ${sourceCiId}::uuid, ${targetCiId}::uuid, ${relationType}::"RelationType", ${req.user!.email}, now())
      RETURNING id::text
    `;

    await prisma.$executeRaw`
      INSERT INTO "audit_logs" (id, action, entity, entity_id, user_email, created_at)
      VALUES (gen_random_uuid(), ${'CREATE_RELATION:' + relationType}, 'CI_RELATION', ${relation[0].id}, ${req.user!.email}, now())
    `;

    res.status(201).json({ id: relation[0].id, sourceCiId, targetCiId, relationType, message: 'Relationship created successfully' });
  } catch (error: unknown) {
    console.error('[POST /api/relations] Error:', error);
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === '23505') {
      res.status(409).json({ error: 'This relationship already exists' });
      return;
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/relations/:id
 * Deletes a CI relationship.
 * ADMIN only.
 */
app.delete('/api/relations/:id', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  const id = req.params.id as string;

  try {
    await prisma.$executeRaw`DELETE FROM ci_relations WHERE id = ${id}::uuid`;

    await prisma.$executeRaw`
      INSERT INTO "audit_logs" (id, action, entity, entity_id, user_email, created_at)
      VALUES (gen_random_uuid(), 'DELETE_RELATION', 'CI_RELATION', ${id}, ${req.user!.email}, now())
    `;

    res.json({ id, message: 'Relationship deleted successfully' });
  } catch (error) {
    console.error('[DELETE /api/relations/:id] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /api/cis/:id/verification
 * Updates the lastCheckDate and verificationSource fields for a CI.
 * Used by the frontend when an admin manually verifies EOL/EOS status from external sources.
 * Body: { lastCheckDate?: string (ISO), verificationSource?: string }
 */
app.patch('/api/cis/:id/verification', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const { lastCheckDate, verificationSource } = req.body as {
    lastCheckDate?: string;
    verificationSource?: string;
  };
  try {
    const checkDate = lastCheckDate ? new Date(lastCheckDate) : new Date();
    const source    = verificationSource ?? 'MANUAL';

    await prisma.$executeRaw`
      UPDATE "configuration_items"
      SET    last_check_date      = ${checkDate},
             verification_source  = ${source},
             updated_at           = now()
      WHERE  id = ${id}::uuid
    `;

    // Audit log
    await prisma.$executeRaw`
      INSERT INTO "audit_logs" (id, action, entity, entity_id, user_email, created_at)
      VALUES (gen_random_uuid(), ${'UPDATE_VERIFICATION:' + source}, 'CI', ${id}, ${req.user!.email}, now())
    `;

    res.json({ id, lastCheckDate: checkDate, verificationSource: source, message: 'Verification updated' });
  } catch (error) {
    console.error('[PATCH /api/cis/:id/verification] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Integration Connectors ───────────────────────────────────────────────────

/**
 * POST /api/integrations/greenbone
 *
 * Ingests a Greenbone OpenVAS JSON report.
 * Matches each result to a CI by hostname/name and updates its vulnerabilities.
 *
 * Body structure (see docs/mocks/greenbone_sample.json):
 * {
 *   scanner: string,
 *   scan_date: string,
 *   results: Array<{
 *     host: { hostname: string, ip?: string },
 *     vulnerabilities: Array<{ cve: string, severity: string, name: string, cvss_score: number, description: string }>
 *   }>
 * }
 */
app.post('/api/integrations/greenbone', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  log.info('[POST /api/integrations/greenbone] Processing report…');
  try {
    type GBVuln = { cve: string; severity: string; name: string; cvss_score?: number; description: string };
    type GBResult = { host: { hostname: string; ip?: string }; vulnerabilities: GBVuln[] };
    const { results = [] } = req.body as { results: GBResult[] };

    const processed: { ci: string; matched: boolean; vulnCount: number }[] = [];

    for (const result of results) {
      const hostname = result.host?.hostname ?? '';
      if (!hostname) continue;

      // Find CI by case-insensitive name match
      // Escape LIKE wildcards to prevent wildcard injection (%, _, \)
      const escapedHostnameGB = hostname.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
      type CIRow = { id: string; name: string };
      const rows = await prisma.$queryRaw<CIRow[]>`
        SELECT id, name FROM "configuration_items"
        WHERE LOWER(name) LIKE LOWER(${'%' + escapedHostnameGB + '%'}) ESCAPE '\\'
        ORDER BY LENGTH(name) ASC
        LIMIT 1
      `;

      if (rows.length === 0) {
        processed.push({ ci: hostname, matched: false, vulnCount: 0 });
        continue;
      }

      const ci = rows[0];

      // Read existing vulnerabilities so we can MERGE instead of replace.
      // This preserves lifecycle status (RESUELTO, EN_PROGRESO, etc.) set by analysts
      // and retains vulns from other sources (CrowdStrike) that Greenbone doesn't report.
      type ExistingVulnRow = { vulnerabilities: unknown };
      const existingRows = await prisma.$queryRaw<ExistingVulnRow[]>`
        SELECT vulnerabilities FROM "configuration_items" WHERE id = ${ci.id}::uuid LIMIT 1
      `;
      const existingVulns = (existingRows[0]?.vulnerabilities ?? []) as Vulnerability[];
      // Index existing vulns by CVE for O(1) lookup
      const existingByCve = new Map(existingVulns.map((v) => [v.cve, v]));

      // Normalise incoming vulnerabilities to our standard format
      const importedAt = new Date().toISOString();
      const incoming = (result.vulnerabilities ?? []).map((v) => ({
        cve:         v.cve,
        severity:    v.severity?.toUpperCase() as VulnSeverity,
        description: v.description ?? v.name ?? '',
        source:      'greenbone' as const,
        cvss_score:  v.cvss_score ?? null,
        status:      'NUEVO' as VulnStatus,
        importedAt,
      }));

      // Merge: update existing entries (preserve status), add new ones
      const incomingByCve = new Map(incoming.map((v) => [v.cve, v]));
      const merged: Vulnerability[] = [
        // Existing vulns: refresh fields from Greenbone if re-reported; keep status
        ...existingVulns.map((existing) => {
          const fresh = incomingByCve.get(existing.cve);
          if (!fresh) return existing; // not in this report — keep as-is
          return { ...fresh, status: existing.status }; // update metadata, preserve status
        }),
        // New vulns not previously known
        ...incoming.filter((v) => !existingByCve.has(v.cve)),
      ];

      await prisma.$executeRaw`
        UPDATE "configuration_items"
        SET "vulnerabilities" = ${JSON.stringify(merged)}::jsonb
        WHERE "id" = ${ci.id}::uuid
      `;

      const newCount = incoming.filter((v) => !existingByCve.has(v.cve)).length;
      processed.push({ ci: ci.name, matched: true, vulnCount: merged.length });
      log.info(`  ✓ ${ci.name} → ${merged.length} total (${newCount} new, ${incoming.length - newCount} updated)`);
    }

    res.json({
      message: 'Greenbone report processed',
      processed,
      totalMatched: processed.filter((p) => p.matched).length,
      totalUnmatched: processed.filter((p) => !p.matched).length,
    });
  } catch (error) {
    console.error('[POST /api/integrations/greenbone] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/integrations/crowdstrike
 *
 * Ingests a CrowdStrike Falcon agent status export.
 * Matches each device to a CI by hostname and updates its agentStatus field.
 *
 * Body structure (see docs/mocks/crowdstrike_sample.json):
 * {
 *   platform: string,
 *   export_date: string,
 *   devices: Array<{
 *     hostname: string, agent_id: string, agent_version: string,
 *     status: string, prevention_policy: string, last_seen: string,
 *     detections: Array<any>
 *   }>
 * }
 */
app.post('/api/integrations/crowdstrike', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  log.info('[POST /api/integrations/crowdstrike] Processing report…');
  try {
    type CSDevice = {
      hostname: string; agent_id: string; agent_version: string;
      status: string; prevention_policy: string; last_seen: string;
      detections: unknown[];
    };
    const { devices = [] } = req.body as { devices: CSDevice[] };

    const processed: { ci: string; matched: boolean; status: string }[] = [];

    for (const device of devices) {
      const hostname = device.hostname ?? '';
      if (!hostname) continue;

      // Escape LIKE wildcards to prevent wildcard injection (%, _, \)
      const escapedHostnameCS = hostname.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
      type CIRow = { id: string; name: string };
      const rows = await prisma.$queryRaw<CIRow[]>`
        SELECT id, name FROM "configuration_items"
        WHERE LOWER(name) LIKE LOWER(${'%' + escapedHostnameCS + '%'}) ESCAPE '\\'
        ORDER BY LENGTH(name) ASC
        LIMIT 1
      `;

      if (rows.length === 0) {
        processed.push({ ci: hostname, matched: false, status: 'unmatched' });
        continue;
      }

      const ci = rows[0];

      const agentData = {
        agentId:          device.agent_id,
        agentVersion:     device.agent_version,
        status:           device.status,
        preventionPolicy: device.prevention_policy,
        lastSeen:         device.last_seen,
        detections:       device.detections ?? [],
        source:           'crowdstrike',
        updatedAt:        new Date().toISOString(),
      };

      await prisma.$executeRaw`
        UPDATE "configuration_items"
        SET "agent_status" = ${JSON.stringify(agentData)}::jsonb
        WHERE "id" = ${ci.id}::uuid
      `;

      processed.push({ ci: ci.name, matched: true, status: device.status });
      log.info(`  ✓ ${ci.name} → agent ${device.status}, ${device.detections?.length ?? 0} detection(s)`);
    }

    res.json({
      message: 'CrowdStrike report processed',
      processed,
      totalMatched: processed.filter((p) => p.matched).length,
      totalUnmatched: processed.filter((p) => !p.matched).length,
    });
  } catch (error) {
    console.error('[POST /api/integrations/crowdstrike] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Document Repository ──────────────────────────────────────────────────────

const DOCUMENTS_DIR = process.env.DOCUMENTS_DIR ?? '/app/documents';
const MAX_FILE_SIZE = parseInt(process.env.MAX_DOCUMENT_SIZE_MB ?? '50', 10) * 1024 * 1024;

// Allowed file extensions and their expected magic bytes
const ALLOWED_EXTENSIONS = new Set([
  'pdf', 'docx', 'xlsx', 'pptx', 'doc', 'txt', 'csv', 'png', 'jpg', 'jpeg', 'odt', 'ods',
]);

// Magic bytes map: extension → [offset, bytes as hex string]
const MAGIC_BYTES: Record<string, Array<{ offset: number; hex: string }>> = {
  pdf:  [{ offset: 0, hex: '25504446' }],                                     // %PDF
  png:  [{ offset: 0, hex: '89504e47' }],                                     // PNG
  jpg:  [{ offset: 0, hex: 'ffd8ff' }],                                       // JPEG
  jpeg: [{ offset: 0, hex: 'ffd8ff' }],
  // DOCX, XLSX, PPTX, ODT, ODS are ZIP-based:
  docx: [{ offset: 0, hex: '504b0304' }],
  xlsx: [{ offset: 0, hex: '504b0304' }],
  pptx: [{ offset: 0, hex: '504b0304' }],
  odt:  [{ offset: 0, hex: '504b0304' }],
  ods:  [{ offset: 0, hex: '504b0304' }],
  // DOC (legacy): D0CF11E0 (Compound Document)
  doc:  [{ offset: 0, hex: 'd0cf11e0' }],
  // TXT and CSV: no reliable magic bytes, allow if extension matches
  txt:  [],
  csv:  [],
};

function validateMagicBytes(buffer: Buffer, ext: string): boolean {
  const checks = MAGIC_BYTES[ext];
  if (!checks) return false;
  if (checks.length === 0) return true; // txt/csv: accept on extension
  return checks.some(({ offset, hex }) => {
    const slice = buffer.slice(offset, offset + hex.length / 2);
    return slice.toString('hex').startsWith(hex.toLowerCase());
  });
}

// Ensure documents directory exists
if (!fs.existsSync(DOCUMENTS_DIR)) {
  fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });
}

// Multer storage: memory storage so we can validate before writing to disk
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
    if (ALLOWED_EXTENSIONS.has(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Tipo de archivo no permitido: .${ext}`));
    }
  },
});

// ── Document Types master ─────────────────────────────────────────────────────

app.get('/api/masters/document-types', authenticateToken, async (_req, res) => {
  try {
    const rows = await prisma.$queryRaw<{ id: string; code: string; name: string; isSystem: boolean }[]>`
      SELECT id::text AS id, code, name, is_system AS "isSystem"
      FROM "document_types" ORDER BY name ASC`;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/masters/document-types', authenticateToken, requireAdmin, async (req, res) => {
  const { code, name } = req.body as { code?: string; name?: string };
  if (!code?.trim() || !name?.trim()) { res.status(400).json({ error: 'code and name required' }); return; }
  try {
    const rows = await prisma.$queryRaw<{ id: string; code: string; name: string }[]>`
      INSERT INTO "document_types"(id,code,name,is_system,created_at,updated_at)
      VALUES(gen_random_uuid(),${code.trim().toUpperCase()},${name.trim()},false,now(),now())
      RETURNING id::text AS id, code, name`;
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.patch('/api/masters/document-types/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name?.trim()) { res.status(400).json({ error: 'name required' }); return; }
  try {
    const rows = await prisma.$queryRaw<{ id: string; code: string; name: string }[]>`
      UPDATE "document_types" SET name=${name.trim()}, updated_at=now()
      WHERE id=${req.params.id}::uuid AND is_system=false
      RETURNING id::text AS id, code, name`;
    if (!rows.length) { res.status(404).json({ error: 'Not found or system type' }); return; }
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.delete('/api/masters/document-types/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await prisma.$executeRaw`
      DELETE FROM "document_types" WHERE id=${req.params.id}::uuid AND is_system=false`;
    if (Number(result) === 0) { res.status(404).json({ error: 'Not found or system type' }); return; }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── Documents CRUD ────────────────────────────────────────────────────────────

// GET /api/documents — list root documents with latest version info
const DOCS_MAX_PAGE_SIZE = 500;
app.get('/api/documents', authenticateToken, async (req, res) => {
  const rawLimit = parseInt(String(req.query.limit ?? '200'), 10);
  const limit    = Math.min(isNaN(rawLimit) || rawLimit < 1 ? 200 : rawLimit, DOCS_MAX_PAGE_SIZE);
  const rawPage  = parseInt(String(req.query.page  ?? '1'),   10);
  const page     = isNaN(rawPage) || rawPage < 1 ? 1 : rawPage;
  const offset   = (page - 1) * limit;
  try {
    const [countRows, rows] = await Promise.all([
      prisma.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*) AS c FROM "documents" WHERE root_id IS NULL`,
      prisma.$queryRaw<{
        id: string; title: string; description: string | null;
        documentTypeId: string; documentTypeName: string; documentTypeCode: string;
        versionNumber: number; originalName: string; mimeType: string;
        fileSize: number; uploadedBy: string; createdAt: Date;
        latestVersionId: string;
      }[]>`
        SELECT d.id::text AS id, d.title, d.description,
               d.document_type_id::text AS "documentTypeId",
               dt.name AS "documentTypeName", dt.code AS "documentTypeCode",
               COALESCE(v.version_number, d.version_number) AS "versionNumber",
               COALESCE(v.original_name, d.original_name) AS "originalName",
               COALESCE(v.mime_type, d.mime_type) AS "mimeType",
               COALESCE(v.file_size, d.file_size) AS "fileSize",
               COALESCE(v.uploaded_by, d.uploaded_by) AS "uploadedBy",
               d.created_at AS "createdAt",
               COALESCE(v.id::text, d.id::text) AS "latestVersionId"
        FROM "documents" d
        JOIN "document_types" dt ON d.document_type_id = dt.id
        LEFT JOIN "documents" v ON v.root_id = d.id AND v.is_latest = true
        WHERE d.root_id IS NULL
        ORDER BY d.created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
    ]);
    res.json({ total: Number(countRows[0]?.c ?? 0), page, limit, data: rows });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// GET /api/documents/:id — document detail with versions, relations, associations
app.get('/api/documents/:id', authenticateToken, async (req, res) => {
  try {
    const rows = await prisma.$queryRaw<{
      id: string; title: string; description: string | null;
      documentTypeId: string; documentTypeName: string; documentTypeCode: string;
      rootId: string | null; versionNumber: number; isLatest: boolean;
      fileName: string; originalName: string; mimeType: string;
      fileSize: number; uploadedBy: string; createdAt: Date;
    }[]>`
      SELECT d.id::text AS id, d.title, d.description,
             d.document_type_id::text AS "documentTypeId",
             dt.name AS "documentTypeName", dt.code AS "documentTypeCode",
             d.root_id::text AS "rootId", d.version_number AS "versionNumber",
             d.is_latest AS "isLatest", d.file_name AS "fileName",
             d.original_name AS "originalName", d.mime_type AS "mimeType",
             d.file_size AS "fileSize", d.uploaded_by AS "uploadedBy",
             d.created_at AS "createdAt"
      FROM "documents" d
      JOIN "document_types" dt ON d.document_type_id = dt.id
      WHERE d.id = ${req.params.id}::uuid`;
    if (!rows.length) { res.status(404).json({ error: 'Document not found' }); return; }
    const doc = rows[0];

    // Root id for version queries
    const rootId = doc.rootId ?? doc.id;

    const [versions, relations, cis, contracts, notes] = await Promise.all([
      // All versions of this document tree
      prisma.$queryRaw<{ id: string; versionNumber: number; isLatest: boolean; originalName: string; mimeType: string; uploadedBy: string; createdAt: Date }[]>`
        SELECT id::text AS id, version_number AS "versionNumber", is_latest AS "isLatest",
               original_name AS "originalName", mime_type AS "mimeType", uploaded_by AS "uploadedBy", created_at AS "createdAt"
        FROM "documents"
        WHERE (root_id = ${rootId}::uuid OR id = ${rootId}::uuid)
        ORDER BY version_number ASC`,
      // Document relations
      prisma.$queryRaw<{ id: string; targetDocId: string; targetTitle: string; relationType: string }[]>`
        SELECT dr.id::text AS id, dr.target_doc_id::text AS "targetDocId",
               td.title AS "targetTitle", dr.relation_type AS "relationType"
        FROM "document_relations" dr
        JOIN "documents" td ON dr.target_doc_id = td.id
        WHERE dr.source_doc_id = ${rootId}::uuid`,
      // Associated CIs
      prisma.$queryRaw<{ ciId: string; ciName: string; ciSlug: string }[]>`
        SELECT dc.ci_id::text AS "ciId", ci.name AS "ciName", ci.api_slug AS "ciSlug"
        FROM "document_cis" dc
        JOIN "configuration_items" ci ON dc.ci_id = ci.id
        WHERE dc.document_id = ${rootId}::uuid`,
      // Associated Contracts
      prisma.$queryRaw<{ contractId: string; contractNumber: string }[]>`
        SELECT dco.contract_id::text AS "contractId", c.contract_number AS "contractNumber"
        FROM "document_contracts" dco
        JOIN "contracts" c ON dco.contract_id = c.id
        WHERE dco.document_id = ${rootId}::uuid`,
      // Notes
      prisma.$queryRaw<{ id: string; content: string; createdBy: string; createdAt: Date }[]>`
        SELECT id::text AS id, content, created_by AS "createdBy", created_at AS "createdAt"
        FROM "document_notes"
        WHERE document_id = ${rootId}::uuid
        ORDER BY created_at ASC`,
    ]);

    res.json({ ...doc, versions, relations, cis, contracts, notes });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// POST /api/documents — upload new document
app.post('/api/documents', authenticateToken, requireAdmin, upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) { res.status(400).json({ error: 'File required' }); return; }

  const ext = path.extname(req.file.originalname).toLowerCase().replace('.', '');
  if (!validateMagicBytes(req.file.buffer, ext)) {
    res.status(400).json({ error: 'El contenido del archivo no coincide con la extensión declarada' });
    return;
  }

  const { title, description, documentTypeId, ciIds, contractIds } = req.body as {
    title?: string; description?: string; documentTypeId?: string;
    ciIds?: string; contractIds?: string;
  };

  if (!title?.trim() || !documentTypeId) {
    res.status(400).json({ error: 'title and documentTypeId required' });
    return;
  }

  // Store with UUID-based filename (prevents path traversal / enumeration)
  const storedFileName = `${crypto.randomUUID()}.${ext}`;
  const filePath = path.join(DOCUMENTS_DIR, storedFileName);

  try {
    fs.writeFileSync(filePath, req.file.buffer);
  } catch {
    res.status(500).json({ error: 'Error saving file' });
    return;
  }

  try {
    const parsedCiIds: string[] = ciIds ? JSON.parse(ciIds) : [];
    const parsedContractIds: string[] = contractIds ? JSON.parse(contractIds) : [];

    const rows = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "documents"(id,title,description,document_type_id,root_id,version_number,is_latest,file_name,original_name,mime_type,file_size,uploaded_by,created_at,updated_at)
      VALUES(gen_random_uuid(),${title.trim()},${description?.trim() || null},${documentTypeId}::uuid,NULL,1,true,${storedFileName},${req.file.originalname},${req.file.mimetype},${req.file.size},${req.user!.email},now(),now())
      RETURNING id::text AS id`;

    const docId = rows[0].id;

    // Create CI associations
    for (const ciId of parsedCiIds) {
      await prisma.$executeRaw`INSERT INTO "document_cis"(id,document_id,ci_id) VALUES(gen_random_uuid(),${docId}::uuid,${ciId}::uuid) ON CONFLICT DO NOTHING`;
    }
    // Create Contract associations
    for (const contractId of parsedContractIds) {
      await prisma.$executeRaw`INSERT INTO "document_contracts"(id,document_id,contract_id) VALUES(gen_random_uuid(),${docId}::uuid,${contractId}::uuid) ON CONFLICT DO NOTHING`;
    }

    // Audit log
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CREATE','Document',${docId},${req.user!.email},now())`;

    res.status(201).json({ id: docId });
  } catch (e) {
    // Clean up uploaded file on DB error
    try { fs.unlinkSync(filePath); } catch {}
    res.status(500).json({ error: String(e) });
  }
});

// PATCH /api/documents/:id — update metadata (title, description, type)
app.patch('/api/documents/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { title, description, documentTypeId } = req.body as { title?: string; description?: string; documentTypeId?: string };
  if (!title?.trim()) { res.status(400).json({ error: 'title required' }); return; }
  try {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      UPDATE "documents" SET title=${title.trim()}, description=${description?.trim() || null},
        document_type_id=COALESCE(${documentTypeId || null}::uuid, document_type_id), updated_at=now()
      WHERE id=${req.params.id}::uuid RETURNING id::text AS id`;
    if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'UPDATE','Document',${req.params.id},${req.user!.email},now())`;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// DELETE /api/documents/:id — delete document (and file from disk)
app.delete('/api/documents/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const rows = await prisma.$queryRaw<{ file_name: string; root_id: string | null }[]>`
      SELECT file_name, root_id::text AS root_id FROM "documents" WHERE id=${req.params.id}::uuid`;
    if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }

    await prisma.$executeRaw`DELETE FROM "documents" WHERE id=${req.params.id}::uuid`;

    // Delete file from disk
    const filePath = path.join(DOCUMENTS_DIR, rows[0].file_name);
    try { fs.unlinkSync(filePath); } catch {}

    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'DELETE','Document',${req.params.id},${req.user!.email},now())`;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// GET /api/documents/:id/download — authenticated file download
// Requires Authorization: Bearer <token> header (query param not accepted — tokens in URLs leak via logs/referrers)
// Supports ?inline=true to display in browser instead of triggering download
app.get('/api/documents/:id/download', async (req, res) => {
  const authHeader = req.headers['authorization'];
  const tokenStr = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!tokenStr) { res.status(401).json({ error: 'Authentication required' }); return; }

  try {
    jwt.verify(tokenStr, JWT_SECRET_VALUE) as JwtPayload;
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' }); return;
  }

  // Support ?inline=true to display in browser instead of download
  const inline = req.query.inline === 'true';

  // Allowlist of MIME types safe to render inline in a browser context.
  // Everything else is forced to attachment/octet-stream to prevent stored XSS
  // (e.g. SVG files can execute embedded JavaScript when served inline as image/svg+xml).
  const SAFE_INLINE_MIME_TYPES = new Set([
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'text/plain',
  ]);

  try {
    const rows = await prisma.$queryRaw<{ file_name: string; original_name: string; mime_type: string }[]>`
      SELECT file_name, original_name, mime_type FROM "documents" WHERE id=${req.params.id}::uuid`;
    if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
    const { file_name, original_name, mime_type } = rows[0];
    const filePath = path.join(DOCUMENTS_DIR, file_name);
    if (!fs.existsSync(filePath)) { res.status(404).json({ error: 'File not found on disk' }); return; }

    const serveInline = inline && SAFE_INLINE_MIME_TYPES.has(mime_type);
    const contentType = serveInline ? mime_type : 'application/octet-stream';
    const disposition = serveInline ? 'inline' : `attachment; filename="${encodeURIComponent(original_name)}"`;

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', disposition);
    // Extra defence: prevent browser from sniffing a different MIME type
    res.setHeader('X-Content-Type-Options', 'nosniff');
    fs.createReadStream(filePath).pipe(res as unknown as NodeJS.WritableStream);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// POST /api/documents/:id/versions — upload new version
app.post('/api/documents/:id/versions', authenticateToken, requireAdmin, upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) { res.status(400).json({ error: 'File required' }); return; }

  const ext = path.extname(req.file.originalname).toLowerCase().replace('.', '');
  if (!validateMagicBytes(req.file.buffer, ext)) {
    res.status(400).json({ error: 'El contenido del archivo no coincide con la extensión declarada' });
    return;
  }

  try {
    // Find the root document
    const rootRows = await prisma.$queryRaw<{ id: string; root_id: string | null }[]>`
      SELECT id::text AS id, root_id::text AS root_id FROM "documents" WHERE id=${req.params.id}::uuid`;
    if (!rootRows.length) { res.status(404).json({ error: 'Document not found' }); return; }

    const rootId = rootRows[0].root_id ?? rootRows[0].id;

    // Get current max version number
    const maxRows = await prisma.$queryRaw<{ max: number }[]>`
      SELECT COALESCE(MAX(version_number), 0) AS max FROM "documents"
      WHERE root_id = ${rootId}::uuid OR id = ${rootId}::uuid`;
    const nextVersion = (maxRows[0]?.max ?? 0) + 1;

    // Store file
    const storedFileName = `${crypto.randomUUID()}.${ext}`;
    const filePath = path.join(DOCUMENTS_DIR, storedFileName);
    fs.writeFileSync(filePath, req.file.buffer);

    // Mark previous latest as not latest (only version children, not the root document itself)
    await prisma.$executeRaw`UPDATE "documents" SET is_latest=false WHERE root_id=${rootId}::uuid`;

    // Get document type and title from root
    const metaRows = await prisma.$queryRaw<{ title: string; document_type_id: string }[]>`
      SELECT title, document_type_id::text AS document_type_id FROM "documents" WHERE id=${rootId}::uuid`;

    // Insert new version
    const newRows = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "documents"(id,title,description,document_type_id,root_id,version_number,is_latest,file_name,original_name,mime_type,file_size,uploaded_by,created_at,updated_at)
      VALUES(gen_random_uuid(),${metaRows[0].title},NULL,${metaRows[0].document_type_id}::uuid,${rootId}::uuid,${nextVersion},true,${storedFileName},${req.file.originalname},${req.file.mimetype},${req.file.size},${req.user!.email},now(),now())
      RETURNING id::text AS id`;

    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'VERSION','Document',${newRows[0].id},${req.user!.email},now())`;

    res.status(201).json({ id: newRows[0].id, versionNumber: nextVersion });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// DELETE /api/documents/:rootId/versions/:versionId — delete a specific version
app.delete('/api/documents/:rootId/versions/:versionId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    // Fetch the version to delete
    const vRows = await prisma.$queryRaw<{ id: string; root_id: string | null; is_latest: boolean; file_name: string; version_number: number }[]>`
      SELECT id::text AS id, root_id::text AS root_id, is_latest, file_name, version_number
      FROM "documents" WHERE id=${req.params.versionId}::uuid`;
    if (!vRows.length) { res.status(404).json({ error: 'Version not found' }); return; }
    const ver = vRows[0];

    // Cannot delete root document via this endpoint
    if (!ver.root_id) { res.status(400).json({ error: 'Use DELETE /api/documents/:id to delete the root document' }); return; }

    const wasLatest = ver.is_latest;

    // Delete the version record
    await prisma.$executeRaw`DELETE FROM "documents" WHERE id=${req.params.versionId}::uuid`;

    // Delete the file from disk
    try { fs.unlinkSync(path.join(DOCUMENTS_DIR, ver.file_name)); } catch {}

    // If this was the latest version, promote the previous one
    if (wasLatest) {
      const prevRows = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM "documents"
        WHERE root_id=${ver.root_id}::uuid
        ORDER BY version_number DESC LIMIT 1`;
      if (prevRows.length) {
        await prisma.$executeRaw`UPDATE "documents" SET is_latest=true WHERE id=${prevRows[0].id}::uuid`;
      }
      // If no more versions, the root document is the current file (is_latest stays true on root)
    }

    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'DELETE_VERSION','Document',${req.params.versionId},${req.user!.email},now())`;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// POST /api/documents/:id/relations — add relation to another document
app.post('/api/documents/:id/relations', authenticateToken, requireAdmin, async (req, res) => {
  const { targetDocId, relationType } = req.body as { targetDocId?: string; relationType?: string };
  if (!targetDocId || !relationType) { res.status(400).json({ error: 'targetDocId and relationType required' }); return; }
  const validTypes = ['AMENDMENT_OF', 'RELATED_TO', 'SUPERSEDES'];
  if (!validTypes.includes(relationType)) { res.status(400).json({ error: 'Invalid relationType' }); return; }
  try {
    await prisma.$executeRaw`
      INSERT INTO "document_relations"(id,source_doc_id,target_doc_id,relation_type,created_at)
      VALUES(gen_random_uuid(),${req.params.id}::uuid,${targetDocId}::uuid,${relationType},now())
      ON CONFLICT DO NOTHING`;
    res.status(201).json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// DELETE /api/documents/:id/relations/:targetId — remove relation
app.delete('/api/documents/:id/relations/:targetId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await prisma.$executeRaw`DELETE FROM "document_relations" WHERE source_doc_id=${req.params.id}::uuid AND target_doc_id=${req.params.targetId}::uuid`;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// POST /api/documents/:id/ci/:ciId — associate document with CI
app.post('/api/documents/:id/ci/:ciId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await prisma.$executeRaw`INSERT INTO "document_cis"(id,document_id,ci_id) VALUES(gen_random_uuid(),${req.params.id}::uuid,${req.params.ciId}::uuid) ON CONFLICT DO NOTHING`;
    res.status(201).json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// DELETE /api/documents/:id/ci/:ciId — remove CI association
app.delete('/api/documents/:id/ci/:ciId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await prisma.$executeRaw`DELETE FROM "document_cis" WHERE document_id=${req.params.id}::uuid AND ci_id=${req.params.ciId}::uuid`;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// POST /api/documents/:id/contract/:contractId — associate with contract
app.post('/api/documents/:id/contract/:contractId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await prisma.$executeRaw`INSERT INTO "document_contracts"(id,document_id,contract_id) VALUES(gen_random_uuid(),${req.params.id}::uuid,${req.params.contractId}::uuid) ON CONFLICT DO NOTHING`;
    res.status(201).json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// DELETE /api/documents/:id/contract/:contractId — remove contract association
app.delete('/api/documents/:id/contract/:contractId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await prisma.$executeRaw`DELETE FROM "document_contracts" WHERE document_id=${req.params.id}::uuid AND contract_id=${req.params.contractId}::uuid`;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// GET /api/cis/:id/documents — get documents for a CI
app.get('/api/cis/:id/documents', authenticateToken, async (req, res) => {
  try {
    const rows = await prisma.$queryRaw<{ id: string; title: string; documentTypeName: string; documentTypeCode: string; originalName: string; versionNumber: number; uploadedBy: string; createdAt: Date; latestVersionId: string }[]>`
      SELECT d.id::text AS id, d.title, dt.name AS "documentTypeName", dt.code AS "documentTypeCode",
             COALESCE(v.original_name, d.original_name) AS "originalName",
             COALESCE(v.version_number, d.version_number) AS "versionNumber",
             COALESCE(v.uploaded_by, d.uploaded_by) AS "uploadedBy",
             d.created_at AS "createdAt",
             COALESCE(v.id::text, d.id::text) AS "latestVersionId"
      FROM "document_cis" dc
      JOIN "documents" d ON dc.document_id = d.id
      JOIN "document_types" dt ON d.document_type_id = dt.id
      LEFT JOIN "documents" v ON v.root_id = d.id AND v.is_latest = true
      WHERE dc.ci_id = ${req.params.id}::uuid AND d.root_id IS NULL
      ORDER BY d.created_at DESC`;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// GET /api/contracts/:id/documents — get documents for a contract
app.get('/api/contracts/:id/documents', authenticateToken, async (req, res) => {
  try {
    const rows = await prisma.$queryRaw<{ id: string; title: string; documentTypeName: string; documentTypeCode: string; originalName: string; versionNumber: number; uploadedBy: string; createdAt: Date; latestVersionId: string; mimeType: string }[]>`
      SELECT d.id::text AS id, d.title, dt.name AS "documentTypeName", dt.code AS "documentTypeCode",
             COALESCE(v.original_name, d.original_name) AS "originalName",
             COALESCE(v.version_number, d.version_number) AS "versionNumber",
             COALESCE(v.uploaded_by, d.uploaded_by) AS "uploadedBy",
             d.created_at AS "createdAt",
             COALESCE(v.id::text, d.id::text) AS "latestVersionId",
             COALESCE(v.mime_type, d.mime_type) AS "mimeType"
      FROM "document_contracts" dc
      JOIN "documents" d ON dc.document_id = d.id
      JOIN "document_types" dt ON d.document_type_id = dt.id
      LEFT JOIN "documents" v ON v.root_id = d.id AND v.is_latest = true
      WHERE dc.contract_id = ${req.params.id}::uuid AND d.root_id IS NULL
      ORDER BY d.created_at DESC`;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ─── Bulk Association Endpoints ───────────────────────────────────────────────

// POST /api/documents/:id/cis — Bulk associate CIs to a document
app.post('/api/documents/:id/cis', authenticateToken, requireAdmin, async (req, res) => {
  const schema = z.object({ ciIds: z.array(z.string().uuid()).min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'ciIds must be a non-empty array of UUIDs' }); return; }
  const { ciIds } = parsed.data;
  const docId = req.params.id;
  try {
    let associated = 0;
    for (const ciId of ciIds) {
      await prisma.$executeRaw`INSERT INTO "document_cis"(id,document_id,ci_id) VALUES(gen_random_uuid(),${docId}::uuid,${ciId}::uuid) ON CONFLICT DO NOTHING`;
      associated++;
    }
    res.json({ associated });
  } catch (e) { res.status(500).json({ error: 'Failed to associate CIs to document' }); }
});

// POST /api/documents/:id/contracts — Bulk associate contracts to a document
app.post('/api/documents/:id/contracts', authenticateToken, requireAdmin, async (req, res) => {
  const schema = z.object({ contractIds: z.array(z.string().uuid()).min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'contractIds must be a non-empty array of UUIDs' }); return; }
  const { contractIds } = parsed.data;
  const docId = req.params.id;
  try {
    let associated = 0;
    for (const contractId of contractIds) {
      await prisma.$executeRaw`INSERT INTO "document_contracts"(id,document_id,contract_id) VALUES(gen_random_uuid(),${docId}::uuid,${contractId}::uuid) ON CONFLICT DO NOTHING`;
      associated++;
    }
    res.json({ associated });
  } catch (e) { res.status(500).json({ error: 'Failed to associate contracts to document' }); }
});

// GET /api/cis/:id/contracts — List contracts associated with a CI
app.get('/api/cis/:id/contracts', authenticateToken, async (req, res) => {
  const ciId = req.params.id as string;
  try {
    const rows = await prisma.$queryRaw<{ id: string; contractNumber: string; startDate: Date; endDate: Date | null; vendorId: string; vendorName: string }[]>`
      SELECT c.id::text AS id, c.contract_number AS "contractNumber", c.start_date AS "startDate", c.end_date AS "endDate",
             v.id::text AS "vendorId", v.name AS "vendorName"
      FROM contracts c
      JOIN vendors v ON c.vendor_id = v.id
      JOIN "_ContractToCI" ctc ON ctc."A" = c.id
      WHERE ctc."B" = ${ciId}::uuid`;
    const result = rows.map((r) => ({
      id: r.id,
      contractNumber: r.contractNumber,
      startDate: r.startDate,
      endDate: r.endDate,
      vendor: { id: r.vendorId, name: r.vendorName },
    }));
    res.json(result);
  } catch (e) { res.status(500).json({ error: 'Failed to fetch contracts for CI' }); }
});

// POST /api/cis/:id/contracts — Bulk associate contracts to a CI
app.post('/api/cis/:id/contracts', authenticateToken, requireAdmin, async (req, res) => {
  const schema = z.object({ contractIds: z.array(z.string().uuid()).min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'contractIds must be a non-empty array of UUIDs' }); return; }
  const { contractIds } = parsed.data;
  const ciId = req.params.id as string;
  try {
    await prisma.cI.update({
      where: { id: ciId },
      data: { contracts: { connect: contractIds.map((cid) => ({ id: cid })) } },
    });
    res.json({ associated: contractIds.length });
  } catch (e) { res.status(500).json({ error: 'Failed to associate contracts to CI' }); }
});

// DELETE /api/cis/:id/contracts/:contractId — Disassociate contract from CI
app.delete('/api/cis/:id/contracts/:contractId', authenticateToken, requireAdmin, async (req, res) => {
  const ciId = req.params.id as string;
  const contractId = req.params.contractId as string;
  try {
    await prisma.cI.update({
      where: { id: ciId },
      data: { contracts: { disconnect: [{ id: contractId }] } },
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Failed to disassociate contract from CI' }); }
});

// POST /api/cis/:id/documents — Bulk associate documents to a CI
app.post('/api/cis/:id/documents', authenticateToken, requireAdmin, async (req, res) => {
  const schema = z.object({ documentIds: z.array(z.string().uuid()).min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'documentIds must be a non-empty array of UUIDs' }); return; }
  const { documentIds } = parsed.data;
  const ciId = req.params.id as string;
  try {
    let associated = 0;
    for (const documentId of documentIds) {
      await prisma.$executeRaw`INSERT INTO "document_cis"(id,document_id,ci_id) VALUES(gen_random_uuid(),${documentId}::uuid,${ciId}::uuid) ON CONFLICT DO NOTHING`;
      associated++;
    }
    res.json({ associated });
  } catch (e) { res.status(500).json({ error: 'Failed to associate documents to CI' }); }
});

// DELETE /api/cis/:id/documents/:docId — Remove document association from CI
app.delete('/api/cis/:id/documents/:docId', authenticateToken, requireAdmin, async (req, res) => {
  const ciId = req.params.id as string;
  const docId = req.params.docId as string;
  try {
    await prisma.$executeRaw`DELETE FROM "document_cis" WHERE document_id=${docId}::uuid AND ci_id=${ciId}::uuid`;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Failed to remove document association from CI' }); }
});

// GET /api/contracts/:id/cis — List CIs associated with a contract
app.get('/api/contracts/:id/cis', authenticateToken, async (req, res) => {
  const contractId = req.params.id as string;
  try {
    const rows = await prisma.$queryRaw<{ id: string; name: string; apiSlug: string; environment: string; criticality: string }[]>`
      SELECT ci.id::text AS id, ci.name, ci.api_slug AS "apiSlug", ci.environment::text AS environment, ci.criticality::text AS criticality
      FROM "CI" ci
      JOIN "_ContractToCI" ctc ON ctc."B" = ci.id
      WHERE ctc."A" = ${contractId}::uuid`;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Failed to fetch CIs for contract' }); }
});

// POST /api/contracts/:id/cis — Bulk associate CIs to a contract
app.post('/api/contracts/:id/cis', authenticateToken, requireAdmin, async (req, res) => {
  const schema = z.object({ ciIds: z.array(z.string().uuid()).min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'ciIds must be a non-empty array of UUIDs' }); return; }
  const { ciIds } = parsed.data;
  const contractId = req.params.id as string;
  try {
    await prisma.contract.update({
      where: { id: contractId },
      data: { cis: { connect: ciIds.map((cid) => ({ id: cid })) } },
    });
    res.json({ associated: ciIds.length });
  } catch (e) { res.status(500).json({ error: 'Failed to associate CIs to contract' }); }
});

// DELETE /api/contracts/:id/cis/:ciId — Disassociate CI from contract
app.delete('/api/contracts/:id/cis/:ciId', authenticateToken, requireAdmin, async (req, res) => {
  const contractId = req.params.id as string;
  const ciId = req.params.ciId as string;
  try {
    await prisma.contract.update({
      where: { id: contractId },
      data: { cis: { disconnect: [{ id: ciId }] } },
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Failed to disassociate CI from contract' }); }
});

// ─── Document Notes ───────────────────────────────────────────────────────────

// GET /api/documents/:id/notes — get all notes for a document (resolves to root)
app.get('/api/documents/:id/notes', authenticateToken, async (req, res) => {
  try {
    const docRows = await prisma.$queryRaw<{ id: string; root_id: string | null }[]>`
      SELECT id::text AS id, root_id::text AS root_id FROM "documents" WHERE id=${req.params.id}::uuid`;
    if (!docRows.length) { res.status(404).json({ error: 'Not found' }); return; }
    const rootId = docRows[0].root_id ?? docRows[0].id;
    const rows = await prisma.$queryRaw<{ id: string; content: string; createdBy: string; createdAt: Date }[]>`
      SELECT id::text AS id, content, created_by AS "createdBy", created_at AS "createdAt"
      FROM "document_notes"
      WHERE document_id = ${rootId}::uuid
      ORDER BY created_at ASC`;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// POST /api/documents/:id/notes — add a note (any authenticated user)
app.post('/api/documents/:id/notes', authenticateToken, async (req, res) => {
  const { content } = req.body as { content?: string };
  if (!content?.trim()) { res.status(400).json({ error: 'content required' }); return; }
  try {
    const docRows = await prisma.$queryRaw<{ id: string; root_id: string | null }[]>`
      SELECT id::text AS id, root_id::text AS root_id FROM "documents" WHERE id=${req.params.id}::uuid`;
    if (!docRows.length) { res.status(404).json({ error: 'Not found' }); return; }
    const rootId = docRows[0].root_id ?? docRows[0].id;
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "document_notes"(id, document_id, content, created_by, created_at)
      VALUES(gen_random_uuid(), ${rootId}::uuid, ${content.trim()}, ${req.user!.email}, now())
      RETURNING id::text AS id`;
    res.status(201).json({ id: rows[0].id });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ─── Alert Engine (Misión 14) ─────────────────────────────────────────────────

/**
 * POST /api/admin/test-email
 * Manually triggers the full alert scan + email send pipeline.
 * ADMIN only. Use this to verify SMTP config without waiting for the daily cron.
 */
app.post('/api/admin/test-email', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  log.info(`[POST /api/admin/test-email] Manual trigger by ${req.user?.email}`);
  try {
    const result = await runAndSendAlerts();
    res.json({
      message: result.sent
        ? `✅ Alert report sent to ${process.env.ALERT_RECIPIENT}`
        : '⚠️ Alert scan completed but email was NOT sent (check SMTP config or ALERT_RECIPIENT)',
      eolAlerts:       result.eolAlerts.length,
      contractAlerts:  result.contractAlerts.length,
      vulnAlerts:      result.vulnAlerts.length,
      sent:            result.sent,
      messageId:       result.messageId,
      scannedAt:       result.scannedAt,
    });
  } catch (error) {
    console.error('[POST /api/admin/test-email] Error:', error);
    res.status(500).json({ error: String(error) });
  }
});

// ─── Daily Alert Cron (08:30 AM every day) ───────────────────────────────────
// To test immediately without waiting, temporarily change the schedule to:
//   '* * * * *'   (every minute)
// The current schedule: '30 8 * * *' = daily at 08:30

const CRON_SCHEDULE = process.env.ALERT_CRON_SCHEDULE ?? '30 8 * * *';

cron.schedule(CRON_SCHEDULE, () => {
  log.info(`[AlertCron] Triggered at ${new Date().toISOString()} (schedule: ${CRON_SCHEDULE})`);
  runAndSendAlerts()
    .then((r) => log.info(`[AlertCron] Done — sent=${r.sent}, alerts=${r.eolAlerts.length + r.contractAlerts.length + r.vulnAlerts.length}`))
    .catch((e) => log.error('[AlertCron] Error:', e));
}, {
  timezone: 'Europe/Madrid',
});

log.info(`[AlertCron] Scheduled — "${CRON_SCHEDULE}" (TZ: Europe/Madrid). Use POST /api/admin/test-email to trigger manually.`);

// ─── Audit Log Purge Cron (03:00 AM every day) ───────────────────────────────
// Deletes audit log records older than AUDIT_RETENTION_DAYS to prevent table bloat.
// Default retention: 365 days (1 year). Set AUDIT_RETENTION_DAYS=0 to disable.

const AUDIT_RETENTION_DAYS = parseInt(process.env.AUDIT_RETENTION_DAYS ?? '365', 10);

if (AUDIT_RETENTION_DAYS > 0) {
  cron.schedule('0 3 * * *', async () => {
    try {
      log.info(`[AuditPurgeCron] Triggered at ${new Date().toISOString()}`);
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - AUDIT_RETENTION_DAYS);

      const result = await prisma.$executeRaw`
        DELETE FROM "audit_logs"
        WHERE created_at < ${cutoffDate}
      `;

      const deleted = Number(result);
      log.info(`[AuditPurgeCron] [INFO] Deleted ${deleted} audit log record(s) older than ${AUDIT_RETENTION_DAYS} days (cutoff: ${cutoffDate.toISOString()})`);
    } catch (error) {
      log.error('[AuditPurgeCron] Error during purge:', error);
    }
  }, {
    timezone: 'Europe/Madrid',
  });

  log.info(`[AuditPurgeCron] Scheduled daily at 03:00 AM (TZ: Europe/Madrid) — Retention: ${AUDIT_RETENTION_DAYS} days`);
} else {
  log.info('[AuditPurgeCron] Disabled (AUDIT_RETENTION_DAYS=0)');
}

// ── Trusted device cleanup (daily at 02:00 AM) ────────────────────────────────
cron.schedule('0 2 * * *', async () => {
  try {
    const result = await prisma.$executeRaw`DELETE FROM "trusted_devices" WHERE expires_at < now()`;
    log.info(`[TrustedDeviceCron] Cleaned up ${Number(result)} expired trusted device(s)`);
  } catch (e) {
    log.error('[TrustedDeviceCron] Cleanup error:', e);
  }
}, { timezone: 'Europe/Madrid' });

// ─── License Repository API ──────────────────────────────────────────────────

// ── Zod schemas ───────────────────────────────────────────────────────────────
const LicenseMasterSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  categoryCode: z.string().min(1),
  description: z.string().optional(),
});

const LicenseSchema = z.object({
  name: z.string().min(1),
  licenseNumber: z.string().min(1),
  vendorId: z.string().uuid().optional().nullable(),
  startDate: z.string(),
  endDate: z.string().optional().nullable(),
  licenseTypeId: z.string().uuid().optional().nullable(),
  licenseMetricId: z.string().uuid().optional().nullable(),
  metricValue: z.number().int().positive().optional().nullable(),
  metricUnit: z.string().optional().nullable(),
  cost: z.number().positive().optional().nullable(),
  currency: z.string().default('EUR'),
  status: z.string().optional(),
  notes: z.string().optional().nullable(),
  parentLicenseId: z.string().uuid().optional().nullable(),
});

const LicenseUserSchema = z.object({
  name: z.string().min(1),
  dni: z.string().optional().nullable(),
  email: z.string().email().optional().or(z.literal('')).nullable(),
});

// ── Group 1: License Metric Categories + Metrics Master ───────────────────────

// GET /api/masters/license-metric-categories — list all with their metrics
app.get('/api/masters/license-metric-categories', authenticateToken, async (_req, res) => {
  try {
    const rows = await prisma.$queryRaw<{
      code: string; name: string; sortOrder: number;
      metricId: string | null; metricCode: string | null; metricName: string | null;
      metricDescription: string | null; metricIsSystem: boolean | null;
    }[]>`
      SELECT lmc.code, lmc.name, lmc.sort_order AS "sortOrder",
             lm.id::text AS "metricId", lm.code AS "metricCode", lm.name AS "metricName",
             lm.description AS "metricDescription", lm.is_system AS "metricIsSystem"
      FROM "license_metric_categories" lmc
      LEFT JOIN "license_metrics" lm ON lm.category_code = lmc.code
      ORDER BY lmc.sort_order ASC, lm.name ASC`;
    // Group by category
    const map = new Map<string, { code: string; name: string; sortOrder: number; metrics: object[] }>();
    for (const r of rows) {
      if (!map.has(r.code)) map.set(r.code, { code: r.code, name: r.name, sortOrder: r.sortOrder, metrics: [] });
      if (r.metricId) {
        map.get(r.code)!.metrics.push({
          id: r.metricId, code: r.metricCode, name: r.metricName,
          description: r.metricDescription, isSystem: r.metricIsSystem,
        });
      }
    }
    res.json([...map.values()]);
  } catch (e) { res.status(500).json({ error: 'Failed to fetch license metric categories' }); }
});

// GET /api/masters/license-metrics — flat list
app.get('/api/masters/license-metrics', authenticateToken, async (_req, res) => {
  try {
    const rows = await prisma.$queryRaw<{
      id: string; code: string; name: string; categoryCode: string;
      description: string | null; isSystem: boolean;
    }[]>`
      SELECT id::text AS id, code, name, category_code AS "categoryCode",
             description, is_system AS "isSystem"
      FROM "license_metrics" ORDER BY name ASC`;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Failed to fetch license metrics' }); }
});

// POST /api/masters/license-metrics — create
app.post('/api/masters/license-metrics', authenticateToken, requireAdmin, async (req, res) => {
  const parsed = LicenseMasterSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'code, name and categoryCode are required' }); return; }
  const { code, name, categoryCode, description } = parsed.data;
  try {
    const rows = await prisma.$queryRaw<{ id: string; code: string; name: string }[]>`
      INSERT INTO "license_metrics"(id, code, name, category_code, description, is_system, created_at, updated_at)
      VALUES(gen_random_uuid(), ${code.trim().toUpperCase()}, ${name.trim()}, ${categoryCode.trim()}, ${description ?? null}, false, now(), now())
      RETURNING id::text AS id, code, name`;
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: 'Failed to create license metric' }); }
});

// PATCH /api/masters/license-metrics/:id — update name/description (system and custom)
app.patch('/api/masters/license-metrics/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { name, description } = req.body as { name?: string; description?: string };
  if (!name?.trim()) { res.status(400).json({ error: 'name required' }); return; }
  const id = req.params.id as string;
  try {
    const rows = await prisma.$queryRaw<{ id: string; code: string; name: string; isSystem: boolean }[]>`
      UPDATE "license_metrics"
      SET name = ${name.trim()}, description = ${description ?? null}, updated_at = now()
      WHERE id = ${id}::uuid
      RETURNING id::text AS id, code, name, is_system AS "isSystem"`;
    if (!rows.length) { res.status(404).json({ error: 'License metric not found' }); return; }
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: 'Failed to update license metric' }); }
});

// DELETE /api/masters/license-metrics/:id — blocked if any license references it
app.delete('/api/masters/license-metrics/:id', authenticateToken, requireAdmin, async (req, res) => {
  const id = req.params.id as string;
  try {
    const used = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "licenses" WHERE license_metric_id = ${id}::uuid`;
    if (Number(used[0]?.count ?? 0) > 0) {
      res.status(409).json({ error: 'No se puede eliminar: existen licencias que utilizan esta métrica' });
      return;
    }
    const result = await prisma.$executeRaw`DELETE FROM "license_metrics" WHERE id = ${id}::uuid`;
    if (Number(result) === 0) { res.status(404).json({ error: 'License metric not found' }); return; }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Failed to delete license metric' }); }
});

// ── Group 2: License Type Categories + Types Master ───────────────────────────

// GET /api/masters/license-type-categories — list all with their types
app.get('/api/masters/license-type-categories', authenticateToken, async (_req, res) => {
  try {
    const rows = await prisma.$queryRaw<{
      code: string; name: string; sortOrder: number;
      typeId: string | null; typeCode: string | null; typeName: string | null;
      typeDescription: string | null; typeIsSystem: boolean | null;
    }[]>`
      SELECT ltc.code, ltc.name, ltc.sort_order AS "sortOrder",
             lt.id::text AS "typeId", lt.code AS "typeCode", lt.name AS "typeName",
             lt.description AS "typeDescription", lt.is_system AS "typeIsSystem"
      FROM "license_type_categories" ltc
      LEFT JOIN "license_types" lt ON lt.category_code = ltc.code
      ORDER BY ltc.sort_order ASC, lt.name ASC`;
    const map = new Map<string, { code: string; name: string; sortOrder: number; types: object[] }>();
    for (const r of rows) {
      if (!map.has(r.code)) map.set(r.code, { code: r.code, name: r.name, sortOrder: r.sortOrder, types: [] });
      if (r.typeId) {
        map.get(r.code)!.types.push({
          id: r.typeId, code: r.typeCode, name: r.typeName,
          description: r.typeDescription, isSystem: r.typeIsSystem,
        });
      }
    }
    res.json([...map.values()]);
  } catch (e) { res.status(500).json({ error: 'Failed to fetch license type categories' }); }
});

// GET /api/masters/license-types — flat list
app.get('/api/masters/license-types', authenticateToken, async (_req, res) => {
  try {
    const rows = await prisma.$queryRaw<{
      id: string; code: string; name: string; categoryCode: string;
      description: string | null; isSystem: boolean;
    }[]>`
      SELECT id::text AS id, code, name, category_code AS "categoryCode",
             description, is_system AS "isSystem"
      FROM "license_types" ORDER BY name ASC`;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Failed to fetch license types' }); }
});

// POST /api/masters/license-types — create
app.post('/api/masters/license-types', authenticateToken, requireAdmin, async (req, res) => {
  const parsed = LicenseMasterSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'code, name and categoryCode are required' }); return; }
  const { code, name, categoryCode, description } = parsed.data;
  try {
    const rows = await prisma.$queryRaw<{ id: string; code: string; name: string }[]>`
      INSERT INTO "license_types"(id, code, name, category_code, description, is_system, created_at, updated_at)
      VALUES(gen_random_uuid(), ${code.trim().toUpperCase()}, ${name.trim()}, ${categoryCode.trim()}, ${description ?? null}, false, now(), now())
      RETURNING id::text AS id, code, name`;
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: 'Failed to create license type' }); }
});

// PATCH /api/masters/license-types/:id — update name/description (system and custom)
app.patch('/api/masters/license-types/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { name, description } = req.body as { name?: string; description?: string };
  if (!name?.trim()) { res.status(400).json({ error: 'name required' }); return; }
  const id = req.params.id as string;
  try {
    const rows = await prisma.$queryRaw<{ id: string; code: string; name: string; isSystem: boolean }[]>`
      UPDATE "license_types"
      SET name = ${name.trim()}, description = ${description ?? null}, updated_at = now()
      WHERE id = ${id}::uuid
      RETURNING id::text AS id, code, name, is_system AS "isSystem"`;
    if (!rows.length) { res.status(404).json({ error: 'License type not found' }); return; }
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: 'Failed to update license type' }); }
});

// DELETE /api/masters/license-types/:id — blocked if any license references it
app.delete('/api/masters/license-types/:id', authenticateToken, requireAdmin, async (req, res) => {
  const id = req.params.id as string;
  try {
    const used = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "licenses" WHERE license_type_id = ${id}::uuid`;
    if (Number(used[0]?.count ?? 0) > 0) {
      res.status(409).json({ error: 'No se puede eliminar: existen licencias que utilizan este tipo' });
      return;
    }
    const result = await prisma.$executeRaw`DELETE FROM "license_types" WHERE id = ${id}::uuid`;
    if (Number(result) === 0) { res.status(404).json({ error: 'License type not found' }); return; }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Failed to delete license type' }); }
});

// ── Group 3: Licenses CRUD ─────────────────────────────────────────────────────

// GET /api/licenses — list all licenses (summary with vendor, type, metric, counts)
const LICENSES_MAX_PAGE_SIZE = 500;
app.get('/api/licenses', authenticateToken, async (req, res) => {
  const rawLimit = parseInt(String(req.query.limit ?? '200'), 10);
  const limit    = Math.min(isNaN(rawLimit) || rawLimit < 1 ? 200 : rawLimit, LICENSES_MAX_PAGE_SIZE);
  const rawPage  = parseInt(String(req.query.page  ?? '1'),   10);
  const page     = isNaN(rawPage) || rawPage < 1 ? 1 : rawPage;
  const offset   = (page - 1) * limit;
  try {
    type LicenseRow = { id: string; name: string; licenseNumber: string; startDate: Date; endDate: Date | null; status: string | null; currency: string | null; cost: string | null; vendorName: string | null; licenseTypeName: string | null; licenseMetricName: string | null; ciCount: bigint; addendumCount: bigint; };
    const [countRows, rows] = await Promise.all([
      prisma.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*) AS c FROM "licenses" WHERE parent_license_id IS NULL`,
      prisma.$queryRaw<LicenseRow[]>`
        SELECT
          l.id::text AS id, l.name,
          l.license_number AS "licenseNumber",
          l.start_date AS "startDate", l.end_date AS "endDate",
          l.status, l.currency, l.cost::text AS cost,
          v.name AS "vendorName",
          lt.name AS "licenseTypeName",
          lm.name AS "licenseMetricName",
          (SELECT COUNT(*) FROM "_LicenseToCI" lci WHERE lci."A" = l.id) AS "ciCount",
          (SELECT COUNT(*) FROM "licenses" al WHERE al.parent_license_id = l.id) AS "addendumCount"
        FROM "licenses" l
        LEFT JOIN "vendors" v ON v.id = l.vendor_id
        LEFT JOIN "license_types" lt ON lt.id = l.license_type_id
        LEFT JOIN "license_metrics" lm ON lm.id = l.license_metric_id
        ORDER BY l.created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
    ]);
    res.json({
      total: Number(countRows[0]?.c ?? 0), page, limit,
      data: rows.map((r) => ({ ...r, ciCount: Number(r.ciCount), addendumCount: Number(r.addendumCount), cost: r.cost ? parseFloat(r.cost) : null })),
    });
  } catch (e) { res.status(500).json({ error: 'Failed to fetch licenses' }); }
});

// GET /api/licenses/:id — license detail with all relations
app.get('/api/licenses/:id', authenticateToken, async (req, res) => {
  const id = req.params.id as string;
  try {
    const license = await prisma.license.findUnique({
      where: { id },
      include: {
        vendor: true,
        licenseType: true,
        licenseMetric: true,
        cis: { select: { id: true, name: true, apiSlug: true, environment: true, criticality: true } },
        licenseUsers: { orderBy: { createdAt: 'asc' } },
        addendums: { select: { id: true, name: true, licenseNumber: true, status: true, startDate: true, endDate: true } },
        parentLicense: { select: { id: true, name: true, licenseNumber: true } },
      },
    });
    if (!license) { res.status(404).json({ error: 'License not found' }); return; }
    // Fetch documents with latestVersionId + mimeType (same pattern as contracts)
    const docs = await prisma.$queryRaw<{
      id: string; title: string; documentTypeName: string; documentTypeCode: string;
      originalName: string; versionNumber: number; uploadedBy: string;
      createdAt: Date; latestVersionId: string; mimeType: string;
    }[]>`
      SELECT d.id::text AS id, d.title, dt.name AS "documentTypeName", dt.code AS "documentTypeCode",
             COALESCE(v.original_name, d.original_name) AS "originalName",
             COALESCE(v.version_number, d.version_number) AS "versionNumber",
             COALESCE(v.uploaded_by, d.uploaded_by) AS "uploadedBy",
             d.created_at AS "createdAt",
             COALESCE(v.id::text, d.id::text) AS "latestVersionId",
             COALESCE(v.mime_type, d.mime_type) AS "mimeType"
      FROM "document_licenses" dl
      JOIN "documents" d ON dl.document_id = d.id
      JOIN "document_types" dt ON d.document_type_id = dt.id
      LEFT JOIN "documents" v ON v.root_id = d.id AND v.is_latest = true
      WHERE dl.license_id = ${id}::uuid AND d.root_id IS NULL
      ORDER BY d.created_at DESC`;
    res.json({ ...license, documents: docs });
  } catch (e) { res.status(500).json({ error: 'Failed to fetch license' }); }
});

// POST /api/licenses — create a license
app.post('/api/licenses', authenticateToken, requireAdmin, async (req, res) => {
  const parsed = LicenseSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid license data', details: parsed.error.flatten() }); return; }
  const d = parsed.data;
  try {
    const license = await prisma.license.create({
      data: {
        name: d.name,
        licenseNumber: d.licenseNumber,
        vendorId: d.vendorId ?? null,
        startDate: new Date(d.startDate),
        endDate: d.endDate ? new Date(d.endDate) : null,
        licenseTypeId: d.licenseTypeId ?? null,
        licenseMetricId: d.licenseMetricId ?? null,
        metricValue: d.metricValue ?? null,
        metricUnit: d.metricUnit ?? null,
        cost: d.cost ?? null,
        currency: d.currency,
        status: d.status ?? 'ACTIVO',
        notes: d.notes ?? null,
        parentLicenseId: d.parentLicenseId ?? null,
      },
    });
    res.status(201).json(license);
  } catch (e) { res.status(500).json({ error: 'Failed to create license' }); }
});

// PATCH /api/licenses/:id — update any field
app.patch('/api/licenses/:id', authenticateToken, requireAdmin, async (req, res) => {
  const id = req.params.id as string;
  const parsed = LicenseSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid license data' }); return; }
  const d = parsed.data;
  try {
    const license = await prisma.license.update({
      where: { id },
      data: {
        ...(d.name !== undefined && { name: d.name }),
        ...(d.licenseNumber !== undefined && { licenseNumber: d.licenseNumber }),
        ...(d.vendorId !== undefined && { vendorId: d.vendorId }),
        ...(d.startDate !== undefined && { startDate: new Date(d.startDate) }),
        ...(d.endDate !== undefined && { endDate: d.endDate ? new Date(d.endDate) : null }),
        ...(d.licenseTypeId !== undefined && { licenseTypeId: d.licenseTypeId }),
        ...(d.licenseMetricId !== undefined && { licenseMetricId: d.licenseMetricId }),
        ...(d.metricValue !== undefined && { metricValue: d.metricValue }),
        ...(d.metricUnit !== undefined && { metricUnit: d.metricUnit }),
        ...(d.cost !== undefined && { cost: d.cost }),
        ...(d.currency !== undefined && { currency: d.currency }),
        ...(d.status !== undefined && { status: d.status }),
        ...(d.notes !== undefined && { notes: d.notes }),
        ...(d.parentLicenseId !== undefined && { parentLicenseId: d.parentLicenseId }),
      },
    });
    res.json(license);
  } catch (e) { res.status(500).json({ error: 'Failed to update license' }); }
});

// DELETE /api/licenses/:id — delete (cascade handles relations)
app.delete('/api/licenses/:id', authenticateToken, requireAdmin, async (req, res) => {
  const id = req.params.id as string;
  try {
    await prisma.license.delete({ where: { id } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Failed to delete license' }); }
});

// ── Group 4: License ↔ CI associations ────────────────────────────────────────

// GET /api/licenses/:id/cis — list CIs for a license
app.get('/api/licenses/:id/cis', authenticateToken, async (req, res) => {
  const licenseId = req.params.id as string;
  try {
    const rows = await prisma.$queryRaw<{
      id: string; name: string; apiSlug: string; environment: string; criticality: string;
    }[]>`
      SELECT ci.id::text AS id, ci.name, ci.api_slug AS "apiSlug",
             ci.environment::text AS environment, ci.criticality::text AS criticality
      FROM "CI" ci
      JOIN "_LicenseToCI" lci ON lci."B" = ci.id
      WHERE lci."A" = ${licenseId}::uuid`;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Failed to fetch CIs for license' }); }
});

// POST /api/licenses/:id/cis — bulk associate CIs
app.post('/api/licenses/:id/cis', authenticateToken, requireAdmin, async (req, res) => {
  const schema = z.object({ ciIds: z.array(z.string().uuid()).min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'ciIds must be a non-empty array of UUIDs' }); return; }
  const { ciIds } = parsed.data;
  const licenseId = req.params.id as string;
  try {
    await prisma.license.update({
      where: { id: licenseId },
      data: { cis: { connect: ciIds.map((cid) => ({ id: cid })) } },
    });
    res.json({ associated: ciIds.length });
  } catch (e) { res.status(500).json({ error: 'Failed to associate CIs to license' }); }
});

// DELETE /api/licenses/:id/cis/:ciId — disassociate one CI
app.delete('/api/licenses/:id/cis/:ciId', authenticateToken, requireAdmin, async (req, res) => {
  const licenseId = req.params.id as string;
  const ciId = req.params.ciId as string;
  try {
    await prisma.license.update({
      where: { id: licenseId },
      data: { cis: { disconnect: [{ id: ciId }] } },
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Failed to disassociate CI from license' }); }
});

// ── Group 5: License ↔ Document associations ──────────────────────────────────

// GET /api/licenses/:id/documents — list docs with latestVersionId + mimeType
app.get('/api/licenses/:id/documents', authenticateToken, async (req, res) => {
  const licenseId = req.params.id as string;
  try {
    const rows = await prisma.$queryRaw<{
      id: string; title: string; documentTypeName: string; documentTypeCode: string;
      originalName: string; versionNumber: number; uploadedBy: string;
      createdAt: Date; latestVersionId: string; mimeType: string;
    }[]>`
      SELECT d.id::text AS id, d.title, dt.name AS "documentTypeName", dt.code AS "documentTypeCode",
             COALESCE(v.original_name, d.original_name) AS "originalName",
             COALESCE(v.version_number, d.version_number) AS "versionNumber",
             COALESCE(v.uploaded_by, d.uploaded_by) AS "uploadedBy",
             d.created_at AS "createdAt",
             COALESCE(v.id::text, d.id::text) AS "latestVersionId",
             COALESCE(v.mime_type, d.mime_type) AS "mimeType"
      FROM "document_licenses" dl
      JOIN "documents" d ON dl.document_id = d.id
      JOIN "document_types" dt ON d.document_type_id = dt.id
      LEFT JOIN "documents" v ON v.root_id = d.id AND v.is_latest = true
      WHERE dl.license_id = ${licenseId}::uuid AND d.root_id IS NULL
      ORDER BY d.created_at DESC`;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Failed to fetch documents for license' }); }
});

// POST /api/licenses/:id/documents — bulk associate documents
app.post('/api/licenses/:id/documents', authenticateToken, requireAdmin, async (req, res) => {
  const schema = z.object({ documentIds: z.array(z.string().uuid()).min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'documentIds must be a non-empty array of UUIDs' }); return; }
  const { documentIds } = parsed.data;
  const licenseId = req.params.id as string;
  try {
    let associated = 0;
    for (const documentId of documentIds) {
      await prisma.$executeRaw`
        INSERT INTO "document_licenses"(id, document_id, license_id)
        VALUES(gen_random_uuid(), ${documentId}::uuid, ${licenseId}::uuid)
        ON CONFLICT DO NOTHING`;
      associated++;
    }
    res.json({ associated });
  } catch (e) { res.status(500).json({ error: 'Failed to associate documents to license' }); }
});

// DELETE /api/licenses/:id/documents/:docId — remove from document_licenses
app.delete('/api/licenses/:id/documents/:docId', authenticateToken, requireAdmin, async (req, res) => {
  const licenseId = req.params.id as string;
  const docId = req.params.docId as string;
  try {
    await prisma.$executeRaw`
      DELETE FROM "document_licenses" WHERE document_id = ${docId}::uuid AND license_id = ${licenseId}::uuid`;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Failed to remove document association from license' }); }
});

// ── Group 6: License Users ─────────────────────────────────────────────────────

// GET /api/licenses/:id/users — list LicenseUsers
app.get('/api/licenses/:id/users', authenticateToken, async (req, res) => {
  const licenseId = req.params.id as string;
  try {
    const users = await prisma.licenseUser.findMany({
      where: { licenseId },
      orderBy: { createdAt: 'asc' },
    });
    res.json(users);
  } catch (e) { res.status(500).json({ error: 'Failed to fetch license users' }); }
});

// POST /api/licenses/:id/users — create a LicenseUser
app.post('/api/licenses/:id/users', authenticateToken, requireAdmin, async (req, res) => {
  const parsed = LicenseUserSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid user data', details: parsed.error.flatten() }); return; }
  const { name, dni, email } = parsed.data;
  const licenseId = req.params.id as string;
  try {
    const user = await prisma.licenseUser.create({
      data: {
        licenseId,
        name,
        dni: dni ?? null,
        email: email || null,
      },
    });
    res.status(201).json(user);
  } catch (e) { res.status(500).json({ error: 'Failed to create license user' }); }
});

// DELETE /api/licenses/:id/users/:userId — delete a LicenseUser
app.delete('/api/licenses/:id/users/:userId', authenticateToken, requireAdmin, async (req, res) => {
  const userId = req.params.userId as string;
  try {
    await prisma.licenseUser.delete({ where: { id: userId } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Failed to delete license user' }); }
});

// ─── Server ───────────────────────────────────────────────────────────────────

// ─── Server startup — HTTP or HTTPS ──────────────────────────────────────────

const CERT_DIR  = '/app/certs';
const CERT_KEY  = path.join(CERT_DIR, 'server.key');
const CERT_FILE = path.join(CERT_DIR, 'server.crt');

if (isHttps && fs.existsSync(CERT_KEY) && fs.existsSync(CERT_FILE)) {
  // ── HTTPS mode ────────────────────────────────────────────────────────────
  const httpsOptions = {
    key:  fs.readFileSync(CERT_KEY),
    cert: fs.readFileSync(CERT_FILE),
  };
  https.createServer(httpsOptions, app).listen(PORT, () => {
    console.log(`🔐 CMDB API running at https://localhost:${PORT} (TLS enabled)`);
    console.log(`   Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
  });
} else {
  if (isHttps) {
    console.warn('[TLS] HTTPS_ENABLED=true but certs not found in backend/certs/. Falling back to HTTP.');
    console.warn('[TLS] Run: bash backend/scripts/generate-certs.sh  (or the .ps1 variant on Windows)');
  }
  // ── HTTP fallback (development) ───────────────────────────────────────────
  app.listen(PORT, () => {
    console.log(`🚀 CMDB API running at http://localhost:${PORT}`);
    console.log(`   Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
    console.log(`   → POST /api/auth/login                (public)`);
    console.log(`   → GET  /api/users                     (any role)`);
    console.log(`   → GET  /api/vendors                   (any role)`);
    console.log(`   → GET  /api/cis                       (any role)`);
    console.log(`   → POST /api/cis                       (ADMIN only)`);
    console.log(`   → PATCH /api/vulnerabilities          (any role)`);
    console.log(`   → POST /api/admin/reset-vulnerabilities (ADMIN only)`);
    console.log(`   → GET  /api/contracts                 (any role)`);
    console.log(`   → POST /api/contracts                 (ADMIN only)`);
    console.log(`   → POST /api/integrations/greenbone    (ADMIN only)`);
    console.log(`   → POST /api/integrations/crowdstrike  (ADMIN only)`);
    console.log(`   → GET  /api/audit-logs               (ADMIN only)`);
    console.log(`   → POST /api/cis/bulk                 (ADMIN only)`);
  });
}

process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Closing Prisma connection...');
  await prisma.$disconnect();
  process.exit(0);
});
