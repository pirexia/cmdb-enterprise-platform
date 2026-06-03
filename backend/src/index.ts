import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import crypto from 'crypto';
// eslint-disable-next-line @typescript-eslint/no-require-imports
// @ts-ignore — helmet is installed in the Docker container via npm install
const helmet = require('helmet') as { default: (...args: unknown[]) => unknown } | ((...args: unknown[]) => unknown);
const helmetFn = typeof helmet === 'function' ? helmet : (helmet as { default: (...args: unknown[]) => unknown }).default;
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
import { PrismaClient, Prisma, Criticality, Environment } from '@prisma/client';
import { runAndSendAlerts } from './services/emailService';
import { authenticateLDAP } from './services/ldap';
import { lookupEolWithFallbacks, fetchProductCycles } from './services/eolService';
import { getSystemInfo } from './services/systemInfoService';
import {
  SSO_ENABLED, ALLOWED_DOMAIN, AUTO_PROVISION, FRONTEND_URL,
  buildAuthorizationUrl, exchangeCodeForTokens, validateIdToken,
  generateCodeVerifier, generateCodeChallenge,
} from './services/microsoftSso';
import { authenticator } from 'otplib';
authenticator.options = { window: 1 }; // accept 1 step before/after current (30-sec clock drift)
import QRCode from 'qrcode';
import multer from 'multer';
import ExcelJS from 'exceljs';
import { parseDocument } from './services/docParser';
import { chunkSections } from './services/chunker';
import {
  getEmbedding, getEmbeddingsBatch, isOllamaHealthy, sanitizeQuery,
  buildRagPrompt, chatWithContext, streamChatWithContext,
  analyzeDocumentForImport,
  analyzeCIRowForImport,
  type RagChunkResult, type Citation, type BulkAnalysisRaw, type CIRowRaw,
} from './services/ragService';
import {
  vulnUuid, getContractRoot, getLicenseRoot,
  serializeCI, serializeContract, serializeLicense, serializeVulnerability, type EntityParseResult,
} from './services/entitySerializer';

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
app.set('trust proxy', 1); // nginx terminates TLS and sets X-Forwarded-For
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
// TLS is terminated by nginx; backend runs plain HTTP internally.
// Helmet is still applied for defence-in-depth on non-nginx traffic.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.use((helmetFn as any)({
  hsts: false, // nginx handles HSTS on the public interface
  contentSecurityPolicy: {
    // Restrictive API-only policy: no content rendered, so only frame-ancestors matters.
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
}));

// ── CORS — derived from FRONTEND_URL (same-origin via nginx gateway) ──────────
// With nginx acting as a unified gateway the browser origin is always
// FRONTEND_URL (= NEXT_PUBLIC_API_URL root). CORS is therefore needed only
// for cross-origin SSO redirects or direct API access.
// FRONTEND_URL is already validated and normalised at module import time in
// services/microsoftSso.ts; fall back to localhost for development.
const _frontendOrigin = (() => {
  try { return new URL(process.env.FRONTEND_URL ?? 'https://localhost').origin; }
  catch { return 'https://localhost'; }
})();
const ALLOWED_ORIGINS = [_frontendOrigin, 'http://localhost:3000', 'https://localhost'];

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
app.use(cookieParser());

const COOKIE_NAME = 'cmdb_token';
const COOKIE_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8 hours — matches JWT expiry

function setAuthCookie(res: Response, token: string): void {
  const isProduction = process.env.NODE_ENV === 'production';
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'strict' : 'lax',
    maxAge: COOKIE_MAX_AGE_MS,
    path: '/',
  });
}

function clearAuthCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

// ── Rate limiting (OWASP: Brute-force prevention) ────────────────────────────

// Strict limiter for login: 10 attempts per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de acceso. Inténtelo de nuevo en 15 minutos.' },
  skipSuccessfulRequests: true, // only count failed attempts
});

// SSO callback limiter: 20 requests per 15 minutes per IP
const ssoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many SSO attempts. Try again in 15 minutes.' },
});

// In-memory SSO state store: state → { nonce, codeVerifier, exp }
// TTL: 10 minutes. Cleaned up on each new initiation request.
interface SsoStateEntry { nonce: string; codeVerifier: string; exp: number }
const ssoStateStore = new Map<string, SsoStateEntry>();
const SSO_STATE_TTL_MS = 10 * 60 * 1000;

function purgeSsoState(): void {
  const now = Date.now();
  for (const [key, val] of ssoStateStore.entries()) {
    if (val.exp < now) ssoStateStore.delete(key);
  }
}

// One-time token store: avoids passing JWT in redirect URL query params.
// Backend stores credentials under a random code (2-min TTL); frontend
// exchanges the code for the real tokens via GET /api/auth/sso/exchange.
interface SsoTokenEntry {
  token: string;
  deviceToken: string;
  user: { id: string; username: string; email: string; role: string; mfa_enabled: boolean };
  exp: number;
}
const ssoTokenStore = new Map<string, SsoTokenEntry>();
const SSO_TOKEN_TTL_MS = 2 * 60 * 1000; // 2 minutes — enough for one browser round-trip

function purgeSsoTokens(): void {
  const now = Date.now();
  for (const [key, val] of ssoTokenStore.entries()) {
    if (val.exp < now) ssoTokenStore.delete(key);
  }
}
// Purge expired token codes every 5 minutes
setInterval(purgeSsoTokens, 5 * 60 * 1000);

// General API limiter: 300 requests per minute per IP
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Demasiadas peticiones. Inténtelo de nuevo en un momento.' },
});

app.use('/api/', apiLimiter);

// Admin RAG ops limiter: 1 request per minute per IP (backfill is heavy)
const ragBackfillLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 1,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Rate limited. Try again in a minute.' },
});

// Chat ask limiter: 10 requests/min per IP (separate from global apiLimiter)
const chatAskLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Demasiadas consultas al asistente. Inténtelo de nuevo en un minuto.' },
});

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

const ChatSessionCreateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
});

const ChatAskSchema = z.object({
  sessionId: z.string().uuid().optional(), // if omitted, a new session is created
  question:  z.string().min(1).max(2000),
  topK:      z.number().int().min(1).max(20).optional(),
  // Optional allowlist of entity types to restrict retrieval to (v2 RAG-entities).
  // Unknown values are rejected by the enum; an empty/omitted array means "no filter".
  entityTypes: z
    .array(z.enum(['document', 'ci', 'contract', 'license', 'vulnerability']))
    .optional(),
  // UI locale — forces the model to reply in that language regardless of context language.
  lang: z.enum(['es', 'en', 'de', 'pt', 'fr', 'it']).optional(),
});

// ── Auth middleware ────────────────────────────────────────────────────────────

async function authenticateToken(req: Request, res: Response, next: NextFunction): Promise<void> {
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
    DELETE FROM "password_history" ph
    WHERE ph.user_id = ${userId}::uuid
    AND NOT EXISTS (
      SELECT 1
      FROM (
        SELECT id
        FROM "password_history"
        WHERE user_id = ${userId}::uuid
        ORDER BY created_at DESC
        LIMIT ${PASSWORD_HISTORY_COUNT}
      ) recent
      WHERE recent.id = ph.id
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

const healthHandler = (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
};
app.get('/health', healthHandler);
app.get('/api/health', healthHandler);

// ── System info (admin only) ──────────────────────────────────────────────────
app.get('/api/system-info', authenticateToken, requireAdmin, async (_req: Request, res: Response) => {
  try {
    const info = await getSystemInfo(prisma);
    res.json(info);
  } catch (err) {
    console.error('[system-info]', err);
    res.status(500).json({ error: 'Failed to retrieve system information' });
  }
});

/**
 * GET /api/auth/sso/status
 * Returns whether Microsoft SSO is configured and which domain is expected.
 * Public — no authentication required. Used by the frontend login page.
 */
app.get('/api/auth/sso/status', (_req: Request, res: Response) => {
  res.json({ enabled: SSO_ENABLED, domain: ALLOWED_DOMAIN || undefined });
});

/**
 * GET /api/auth/sso/microsoft
 * Initiates the Microsoft SSO OAuth2 Authorization Code + PKCE flow.
 * Generates and stores state (CSRF) + nonce (replay protection) server-side,
 * then redirects the browser to the Azure AD single-tenant authorization URL.
 */
app.get('/api/auth/sso/microsoft', ssoLimiter, (req: Request, res: Response) => {
  if (!SSO_ENABLED) {
    res.status(404).json({ error: 'Microsoft SSO is not enabled' });
    return;
  }

  purgeSsoState();

  const state        = crypto.randomUUID();
  const nonce        = crypto.randomBytes(16).toString('hex');
  const codeVerifier = generateCodeVerifier();
  const challenge    = generateCodeChallenge(codeVerifier);

  ssoStateStore.set(state, { nonce, codeVerifier, exp: Date.now() + SSO_STATE_TTL_MS });

  const authUrl = buildAuthorizationUrl(state, nonce, challenge);
  res.redirect(302, authUrl);
});

/**
 * GET /api/auth/sso/microsoft/callback
 * Handles the Azure AD OAuth2 callback. Validates state, exchanges code for
 * tokens, validates the ID token fully, finds/creates the user, creates a
 * trusted device entry (SSO = trusted, no TOTP ever needed), issues a JWT,
 * and redirects to the frontend.
 */
app.get('/api/auth/sso/microsoft/callback', ssoLimiter, async (req: Request, res: Response) => {
  const REDIRECT_ERROR = `${FRONTEND_URL}/login?error=sso_failed`;

  if (!SSO_ENABLED) {
    res.redirect(302, REDIRECT_ERROR);
    return;
  }

  const { code, state, error: oauthError } = req.query as Record<string, string | undefined>;

  // Azure AD returned an error (e.g., user cancelled, access denied)
  if (oauthError) {
    log.warn(`[SSO callback] Azure AD error: ${oauthError}`);
    res.redirect(302, REDIRECT_ERROR);
    return;
  }

  if (!code || !state) {
    res.redirect(302, REDIRECT_ERROR);
    return;
  }

  // CSRF: validate state
  const stateEntry = ssoStateStore.get(state);
  if (!stateEntry || stateEntry.exp < Date.now()) {
    log.warn('[SSO callback] Invalid or expired state parameter');
    ssoStateStore.delete(state);
    res.redirect(302, REDIRECT_ERROR);
    return;
  }
  ssoStateStore.delete(state); // one-time use

  try {
    // Exchange code for tokens (PKCE)
    const tokens = await exchangeCodeForTokens(code, stateEntry.codeVerifier);

    // Validate ID token (signature, iss, aud, tid, nonce, domain)
    const claims = await validateIdToken(tokens.id_token, stateEntry.nonce);

    const msOid   = claims.oid;
    const email   = claims.email!;
    const name    = claims.name ?? email.split('@')[0];
    const username = email.split('@')[0];

    // ── Find or provision user ────────────────────────────────────────────────
    type UserRow = {
      id: string; username: string; email: string; role: string;
      active: boolean; sso_external_id: string | null;
    };

    // 1. Lookup by Azure OID (sso_external_id = oid, sso_provider = 'microsoft')
    let rows = await prisma.$queryRaw<UserRow[]>`
      SELECT id, username, email, role, COALESCE(active, true) AS active, sso_external_id
      FROM "users"
      WHERE sso_external_id = ${msOid} AND sso_provider = 'microsoft'
      LIMIT 1
    `;

    // 2. If not found by OID, try by email and link the account
    if (rows.length === 0) {
      rows = await prisma.$queryRaw<UserRow[]>`
        SELECT id, username, email, role, COALESCE(active, true) AS active, sso_external_id
        FROM "users" WHERE email = ${email} LIMIT 1
      `;
      if (rows.length > 0) {
        // Link existing account to Microsoft SSO
        await prisma.$executeRaw`
          UPDATE "users"
          SET sso_external_id = ${msOid}, sso_provider = 'microsoft', updated_at = now()
          WHERE id = ${rows[0].id}::uuid
        `;
        log.info(`[SSO] Linked existing user ${email} to Microsoft OID ${msOid}`);
      }
    }

    // 3. Auto-provision new user if allowed
    if (rows.length === 0) {
      if (!AUTO_PROVISION) {
        log.warn(`[SSO] User ${email} not found and auto-provision is disabled`);
        res.redirect(302, `${FRONTEND_URL}/login?error=sso_not_provisioned`);
        return;
      }
      await prisma.$executeRaw`
        INSERT INTO "users" (id, username, email, password, role, sso_external_id, sso_provider, created_at, updated_at)
        VALUES (gen_random_uuid(), ${username}, ${email}, NULL, 'VIEWER', ${msOid}, 'microsoft', now(), now())
      `;
      rows = await prisma.$queryRaw<UserRow[]>`
        SELECT id, username, email, role, COALESCE(active, true) AS active, sso_external_id
        FROM "users" WHERE email = ${email} LIMIT 1
      `;
      log.info(`[SSO] Auto-provisioned new Microsoft SSO user: ${email} (name: ${name})`);
    }

    const user = rows[0];

    if (!user.active) {
      log.warn(`[SSO] Disabled account attempted SSO login: ${email}`);
      res.redirect(302, `${FRONTEND_URL}/login?error=sso_account_disabled`);
      return;
    }

    // ── Create trusted device (SSO auth = trusted, MFA never required) ────────
    const deviceToken = crypto.randomBytes(32).toString('hex');
    const expiry      = new Date();
    expiry.setDate(expiry.getDate() + (parseInt(process.env.TRUSTED_DEVICE_TTL_DAYS ?? '30', 10) || 30));
    const ua = req.headers['user-agent'] ?? '';
    const ip = req.ip ?? '';
    await prisma.$executeRaw`
      INSERT INTO "trusted_devices" (id, user_id, token, user_agent, ip_address, expires_at, created_at, last_seen_at)
      VALUES (gen_random_uuid(), ${user.id}::uuid, ${deviceToken}, ${ua}, ${ip}, ${expiry}, now(), now())
      ON CONFLICT DO NOTHING
    `;

    // ── Issue JWT ──────────────────────────────────────────────────────────────
    const payload: JwtPayload = {
      id: user.id, username: user.username, email: user.email, role: user.role as UserRole,
    };
    const token = jwt.sign(payload, JWT_SECRET_VALUE, { expiresIn: '8h', algorithm: 'HS256' as const });

    // Audit log
    await prisma.$executeRaw`
      INSERT INTO "audit_logs" (id, action, entity, entity_id, user_email, details, created_at)
      VALUES (gen_random_uuid(), 'LOGIN_SSO', 'User', ${user.id}, ${user.email}, 'Microsoft SSO login', now())
    `;

    log.info(`[SSO] Successful login: ${email}`);

    // ── Redirect to frontend with a one-time exchange code ───────────────────
    // Tokens are NOT passed in the URL (would leak via logs, Referer headers,
    // browser history). Instead we store them server-side under a random code
    // with a 2-minute TTL. The frontend exchanges the code via
    // GET /api/auth/sso/exchange?code=<code> to retrieve the real tokens.
    purgeSsoTokens();
    const exchangeCode = crypto.randomUUID();
    ssoTokenStore.set(exchangeCode, {
      token,
      deviceToken,
      user: { id: user.id, username: user.username, email: user.email, role: user.role, mfa_enabled: false },
      exp: Date.now() + SSO_TOKEN_TTL_MS,
    });
    const redirectUrl = new URL(`${FRONTEND_URL}/auth/sso-callback`);
    redirectUrl.searchParams.set('code', exchangeCode);
    res.redirect(302, redirectUrl.toString());

  } catch (err) {
    log.warn('[SSO callback] Error during SSO flow:', err);
    res.redirect(302, REDIRECT_ERROR);
  }
});

/**
 * GET /api/auth/sso/exchange
 * One-time token exchange: the frontend sends the short-lived `code` received
 * in the SSO callback redirect and gets back the real JWT, deviceToken, and
 * user object. The code is deleted immediately (single-use).
 */
app.get('/api/auth/sso/exchange', ssoLimiter, async (req: Request, res: Response) => {
  const code = typeof req.query.code === 'string' ? req.query.code.trim() : null;
  if (!code) {
    res.status(400).json({ error: 'Missing exchange code' });
    return;
  }
  const entry = ssoTokenStore.get(code);
  if (!entry || entry.exp < Date.now()) {
    ssoTokenStore.delete(code);
    res.status(401).json({ error: 'Exchange code is invalid or has expired' });
    return;
  }
  ssoTokenStore.delete(code); // one-time use — delete immediately
  setAuthCookie(res, entry.token);
  res.json({ token: entry.token, deviceToken: entry.deviceToken, user: entry.user });
});

/**
 * POST /api/auth/logout
 * Clears the HttpOnly session cookie. No auth required — even expired tokens
 * must be clearable. LOGOUT is logged only when the token is still valid (to
 * avoid blocking cookie clearance when the JWT has already expired — G-M01).
 */
app.post('/api/auth/logout', async (req: Request, res: Response) => {
  try {
    const cookieToken = req.cookies?.[COOKIE_NAME] as string | undefined;
    const authHeader  = req.headers['authorization'];
    const bearer      = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
    const raw         = cookieToken ?? bearer ?? null;
    if (raw) {
      const payload = jwt.verify(raw, JWT_SECRET_VALUE, { algorithms: ['HS256'] }) as JwtPayload;
      await prisma.$executeRaw`
        INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
        VALUES(gen_random_uuid(), 'LOGOUT', 'User', ${payload.id}::uuid, ${payload.email}, now())`;
    }
  } catch { /* expired/invalid token or DB error — always clear the cookie */ }
  clearAuthCookie(res);
  res.json({ message: 'Logged out.' });
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
      // LDAP_STRICT_MODE=true: block local auth fallback for LDAP-provisioned accounts.
      // This prevents the (already-safe) fallback when the LDAP server is unreachable.
      // LDAP shadow users have a random bcrypt hash they don't know, so fallback is
      // already safe by design — but strict mode makes this an explicit policy.
      if (process.env.LDAP_STRICT_MODE === 'true' && process.env.USE_LDAP === 'true' && !isLocalAccount) {
        log.warn(`[POST /api/auth/login] LDAP_STRICT_MODE: blocking local fallback for ${email}`);
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }

      const rows = await prisma.$queryRaw<UserRow[]>`
        SELECT id, username, email, password, role, COALESCE(active, true) AS active,
               mfa_enabled, mfa_secret, mfa_prompted_at
        FROM "users" WHERE email = ${email} LIMIT 1
      `;
      if (!rows[0] || !rows[0].password) {
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }
      // Safety note: LDAP shadow users have password = bcrypt(random-token) so
      // bcrypt.compare against a real user-supplied password will always fail.
      // LDAP_STRICT_MODE adds an explicit policy-level block before this check.
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

    // Audit: primary credential verified — log before branching on MFA
    await prisma.$executeRaw`
      INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
      VALUES(gen_random_uuid(), 'LOGIN', 'User', ${user.id}::uuid, ${user.email}, now())
    `;

    // ── Helper: build and sign full JWT ──────────────────────────────────────
    const signFullToken = () => {
      const p: JwtPayload = { id: user!.id, username: user!.username, email: user!.email, role: user!.role as UserRole };
      return jwt.sign(p, JWT_SECRET_VALUE, { expiresIn: '8h', algorithm: 'HS256' as const });
    };
    const userObj = () => ({ id: user!.id, username: user!.username, email: user!.email, role: user!.role, mfa_enabled: user!.mfa_enabled });

    // ── Helper: create trusted device record ──────────────────────────────────
    const createTrustedDevice = async (): Promise<string> => {
      const tok      = crypto.randomBytes(32).toString('hex');
      const expiry   = new Date();
      expiry.setDate(expiry.getDate() + TRUSTED_DEVICE_TTL_DAYS);
      // Bind token to client IP and User-Agent at creation time (Issue #25)
      const ua  = req.headers['user-agent'] ?? '';
      const ip  = req.ip ?? '';
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
        // Validate token against stored IP and User-Agent binding (Issue #25)
        const currentUa = req.headers['user-agent'] ?? '';
        const currentIp = req.ip ?? '';
        const trusted = await prisma.$queryRaw<{ id: string }[]>`
          SELECT id FROM "trusted_devices"
          WHERE token = ${deviceToken}
            AND user_id = ${user.id}::uuid
            AND expires_at > now()
            AND user_agent = ${currentUa}
            AND ip_address = ${currentIp}
          LIMIT 1
        `;
        if (trusted.length > 0) {
          await prisma.$executeRaw`UPDATE "trusted_devices" SET last_seen_at = now() WHERE token = ${deviceToken}`;
          const t1 = signFullToken();
          setAuthCookie(res, t1);
          res.json({ token: t1, user: userObj() });
          return;
        }
      }

      // Need MFA code
      if (!mfaCode) {
        res.status(401).json({ error: 'MFA_REQUIRED' });
        return;
      }

      const mfaValid = authenticator.check(mfaCode, user.mfa_secret as string);
      if (!mfaValid) {
        res.status(401).json({ error: 'INVALID_MFA_CODE' });
        return;
      }

      let newDeviceToken: string | undefined;
      if (trustDevice) newDeviceToken = await createTrustedDevice();

      const t2 = signFullToken();
      setAuthCookie(res, t2);
      res.json({ token: t2, user: userObj(), ...(newDeviceToken ? { deviceToken: newDeviceToken } : {}) });
      return;
    }

    // ── MFA not enabled: check if setup is needed ─────────────────────────────
    if (user.role === 'ADMIN') {
      // Admin: mandatory MFA setup — issue short-lived limited token
      const limitedPayload: JwtPayload = { id: user.id, username: user.username, email: user.email, role: user.role as UserRole, mfaSetupRequired: true };
      const limitedToken = jwt.sign(limitedPayload, JWT_SECRET_VALUE, { expiresIn: '15m', algorithm: 'HS256' as const });
      setAuthCookie(res, limitedToken);
      res.json({ token: limitedToken, user: userObj(), requireAction: 'MFA_SETUP_REQUIRED' });
      return;
    }

    // Non-admin: suggest MFA on first login
    if (!user.mfa_prompted_at) {
      await prisma.$executeRaw`UPDATE "users" SET mfa_prompted_at = now(), updated_at = now() WHERE id = ${user.id}::uuid`;
      const t4a = signFullToken();
      setAuthCookie(res, t4a);
      res.json({ token: t4a, user: userObj(), requireAction: 'MFA_SETUP_SUGGESTED' });
      return;
    }

    // Normal login (non-admin, already prompted before or MFA skipped)
    const t4b = signFullToken();
    setAuthCookie(res, t4b);
    res.json({ token: t4b, user: userObj() });

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
    type UserRow = { id: string; password: string | null; sso_external_id: string | null; sso_provider: string | null; role: string };
    const rows = await prisma.$queryRaw<UserRow[]>`
      SELECT id, password, sso_external_id, sso_provider, role FROM "users" WHERE id = ${req.user!.id}::uuid
    `;
    const user = rows[0];
    if (!user) { res.status(404).json({ error: 'User not found.' }); return; }

    // SSO users cannot change password here
    if (user.sso_external_id) {
      if (user.sso_provider === 'microsoft') {
        res.status(403).json({ error: 'SSO_USER', message: 'Los usuarios de Microsoft SSO deben cambiar su contraseña en el portal de Microsoft 365.' });
      } else {
        res.status(403).json({ error: 'LDAP_USER', message: 'Los usuarios LDAP/AD deben cambiar su contraseña a través del controlador de dominio.' });
      }
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
    type UserRow = { id: string; sso_external_id: string | null; sso_provider: string | null; role: string; email: string };
    const rows = await prisma.$queryRaw<UserRow[]>`
      SELECT id, sso_external_id, sso_provider, role, email FROM "users" WHERE id = ${id}::uuid
    `;
    const user = rows[0];
    if (!user) { res.status(404).json({ error: 'User not found.' }); return; }

    if (user.sso_external_id) {
      if (user.sso_provider === 'microsoft') {
        res.status(403).json({ error: 'SSO_USER', message: 'No se puede resetear la contraseña de usuarios de Microsoft SSO.' });
      } else {
        res.status(403).json({ error: 'LDAP_USER', message: 'No se puede resetear la contraseña de usuarios LDAP/AD.' });
      }
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

/**
 * DELETE /api/admin/users/:id
 * GDPR Art. 17 right to erasure. ADMIN only.
 *
 * Performs structured erasure:
 *   1. Pseudonymises audit_logs entries (replaces email with a stable hash)
 *   2. Clears all PII fields on the user record (email, password, MFA secrets, SSO id)
 *   3. Hard-deletes trusted_devices and password_history (cascade from user delete)
 *   4. Hard-deletes the user row
 *
 * The audit trail sequence is preserved (action/entity/timestamps intact).
 * The requesting admin cannot erase their own account.
 */
app.delete('/api/admin/users/:id', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  const targetId = req.params.id as string;

  // Prevent self-erasure
  if (targetId === req.user!.id) {
    res.status(400).json({ error: 'You cannot erase your own account.' });
    return;
  }

  try {
    // 1. Resolve the user and get their email
    const rows = await prisma.$queryRaw<{ id: string; email: string; username: string }[]>`
      SELECT id::text AS id, email, username FROM "users" WHERE id = ${targetId}::uuid LIMIT 1
    `;
    if (!rows.length) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }
    const { email } = rows[0];

    // 2. Pseudonymise audit_logs: replace user_email with a stable, non-reversible token.
    //    The token is deterministic so repeat erasures produce the same result (idempotent).
    const pseudoToken = '[deleted-' +
      crypto.createHash('sha256').update(email + JWT_SECRET_VALUE).digest('hex').slice(0, 16) +
      ']';
    await prisma.$executeRaw`
      UPDATE "audit_logs" SET user_email = ${pseudoToken} WHERE user_email = ${email}
    `;

    // 3. Hard-delete the user (trusted_devices + password_history cascade automatically)
    await prisma.$executeRaw`DELETE FROM "users" WHERE id = ${targetId}::uuid`;

    // 4. Record the erasure in the audit log under the admin's email
    await prisma.$executeRaw`
      INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
      VALUES(gen_random_uuid(), 'GDPR_ERASURE', 'USER', ${targetId}::uuid, ${req.user!.email}, now())
    `;

    log.info(`[DELETE /api/admin/users/${targetId}] GDPR erasure completed by ${req.user!.email}. Audit logs pseudonymised as ${pseudoToken}.`);
    res.json({ message: 'User erased. Audit log entries pseudonymised.' });

  } catch (error) {
    log.error('[DELETE /api/admin/users/:id] Error:', error);
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

app.post('/api/vendors', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  const { name } = req.body as { name?: string };
  if (!name?.trim()) { res.status(400).json({ error: 'name required' }); return; }
  try {
    const rows = await prisma.$queryRaw<{ id: string; name: string }[]>`
      INSERT INTO "vendors"(id,name,created_at,updated_at)
      VALUES(gen_random_uuid(),${name.trim()},now(),now())
      RETURNING id::text AS id, name`;
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CREATE_MASTER','Vendor',${rows[0].id}::uuid,${req.user!.email},now())`;
    res.status(201).json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

app.patch('/api/vendors/:id', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  const { name } = req.body as { name?: string };
  if (!name?.trim()) { res.status(400).json({ error: 'name required' }); return; }
  try {
    const rows = await prisma.$queryRaw<{ id: string; name: string }[]>`
      UPDATE "vendors" SET name=${name.trim()}, updated_at=now()
      WHERE id=${req.params.id}::uuid RETURNING id::text AS id, name`;
    if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'UPDATE_MASTER','Vendor',${rows[0].id}::uuid,${req.user!.email},now())`;
    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete('/api/vendors/:id', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  try {
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'DELETE_MASTER','Vendor',${req.params.id}::uuid,${req.user!.email},now())`;
    await prisma.$executeRaw`DELETE FROM "vendors" WHERE id=${req.params.id}::uuid`;
    res.json({ ok: true });
  } catch (e: unknown) {
    if (typeof e === 'object' && e !== null && 'code' in e && (e as { code: string }).code === 'P2003') {
      res.status(409).json({ error: 'Cannot delete vendor with associated contracts or licenses' });
      return;
    }
    console.error(e);
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

    // Re-index this entity for the RAG (queue, non-blocking on errors)
    void queueEntityForIndexing('ci', ci.id);

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

    // Re-index this entity for the RAG (queue, non-blocking on errors)
    void queueEntityForIndexing('ci', id);

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
 * PATCH /api/cis/bulk-update — apply the same field changes to many CIs at once.
 * ADMIN only. Body: { ciIds: string[]; updates: Partial<CIBulkUpdateFields> }.
 * Only enums and FK ids are exposed (no unique-per-CI fields like name,
 * inventoryNumber, serial, etc., to prevent integrity issues).
 * Atomic transaction: either all CIs are updated or none. AuditLog stores
 * { ciIds, changes } per CI for forensic reconstruction.
 */
app.patch('/api/cis/bulk-update', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  const BulkUpdateSchema = z.object({
    // Deduplicate to avoid: repeated RAG re-index, inflated audit ciIds, ambiguous affected count
    ciIds: z.array(z.string().uuid()).min(1).max(500).transform((arr) => Array.from(new Set(arr))),
    updates: z.object({
      criticality:        z.enum(['LOW','MEDIUM','HIGH','MISSION_CRITICAL']).optional(),
      environment:        z.enum(['DEVELOPMENT','TESTING','STAGING','PRODUCTION']).optional(),
      status:             z.enum(['ACTIVO','INACTIVO','RETIRADO']).optional(),
      ciTypeId:           z.string().uuid().nullable().optional(),
      costCenterId:       z.string().uuid().nullable().optional(),
      branchId:           z.string().uuid().nullable().optional(),
      businessOwnerId:    z.string().uuid().nullable().optional(),
      technicalLeadId:    z.string().uuid().nullable().optional(),
      businessImpact:     z.enum(['LOW','MEDIUM','HIGH','CRITICAL']).nullable().optional(),
      dataClassification: z.enum(['PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED']).nullable().optional(),
      containsPii:        z.boolean().optional(),
      spofRisk:           z.boolean().optional(),
    }).refine((u) => Object.keys(u).length > 0, { message: 'No fields to update' }),
  });

  const parsed = BulkUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid bulk update payload' });
    return;
  }
  const { ciIds, updates } = parsed.data;

  // Build the Prisma update data — only set fields the caller actually sent.
  const data: Record<string, unknown> = {};
  if (updates.criticality        !== undefined) data.criticality        = updates.criticality;
  if (updates.environment        !== undefined) data.environment        = updates.environment;
  if (updates.status             !== undefined) data.status             = updates.status;
  if (updates.ciTypeId           !== undefined) data.ciTypeId           = updates.ciTypeId;
  if (updates.costCenterId       !== undefined) data.costCenterId       = updates.costCenterId;
  if (updates.branchId           !== undefined) data.branchId           = updates.branchId;
  if (updates.businessOwnerId    !== undefined) data.businessOwnerId    = updates.businessOwnerId;
  if (updates.technicalLeadId    !== undefined) data.technicalLeadId    = updates.technicalLeadId;
  if (updates.businessImpact     !== undefined) data.businessImpact     = updates.businessImpact;
  if (updates.dataClassification !== undefined) data.dataClassification = updates.dataClassification;
  if (updates.containsPii        !== undefined) data.containsPii        = updates.containsPii;
  if (updates.spofRisk           !== undefined) data.spofRisk           = updates.spofRisk;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const upd = await tx.cI.updateMany({
        where: { id: { in: ciIds } },
        data,
      });
      // V2.5.1-A04-2: don't dump full ciIds array (up to 500 UUIDs ≈ 21KB) into
      // details JSONB. Keep count + 10-id sample; per-CI trace is preserved by the
      // queueEntityForIndexing loop below if forensic recreation is ever needed.
      const auditDetails = {
        count: ciIds.length,
        sample: ciIds.slice(0, 10),
        truncated: ciIds.length > 10,
        changes: updates,
        affected: upd.count,
      };
      await tx.$executeRaw`
        INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, details, created_at)
        VALUES(gen_random_uuid(), 'CI_BULK_UPDATE', 'CI', '00000000-0000-0000-0000-000000000000'::uuid, ${req.user!.email},
               ${JSON.stringify(auditDetails)}::jsonb, now())`;
      return upd.count;
    });

    // Re-index every affected CI for RAG (non-blocking).
    for (const id of ciIds) void queueEntityForIndexing('ci', id);

    res.json({ updated: result, requested: ciIds.length });
  } catch (error: unknown) {
    console.error('[PATCH /api/cis/bulk-update] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/cis/bulk-delete — hard-delete many CIs at once (ADMIN only).
 * Body: { ciIds: string[] (1..200) }. Returns { deleted, notFound, requested }.
 *
 * We use POST (not DELETE with body) for broad client compatibility — some
 * proxies strip DELETE bodies. Lower max (200) than bulk-update because
 * hard-delete is irreversible and cascades hardware/software/relations.
 *
 * Per-CI cascade is handled by Prisma schema (onDelete: Cascade on Hardware,
 * Software, CIRelation, DocumentCI, etc.). RAG entries are purged after.
 * Each delete generates an individual DELETE_CI audit entry (alongside the
 * batch CI_BULK_DELETE record) so forensics can trace which CIs went where.
 */
app.post('/api/cis/bulk-delete', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  const BulkDeleteSchema = z.object({
    // Deduplicate: per-CI audit row would be inserted twice for a repeated id while
    // deleteMany only removes the row once → ghost audit + RAG-purge wasted work
    ciIds: z.array(z.string().uuid()).min(1).max(200).transform((arr) => Array.from(new Set(arr))),
    // Opt-in flag to allow destruction of CIs that still have active links
    force: z.boolean().optional(),
  });
  const parsed = BulkDeleteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid bulk-delete payload' });
    return;
  }
  const { ciIds, force } = parsed.data;

  try {
    // Snapshot of names for the audit log (lost after the DELETE).
    const existing = await prisma.$queryRaw<{ id: string; name: string }[]>`
      SELECT id::text AS id, name FROM "configuration_items" WHERE id IN (${Prisma.join(ciIds.map((i) => Prisma.sql`${i}::uuid`))})`;
    const existingMap = new Map(existing.map((r) => [r.id, r.name]));

    // V2.5.1-A04-1: count active associations BEFORE we cascade-delete them silently.
    // Without this check, deleting a CI would silently sever:
    //   - contract↔CI links (M2M _ContractToCI, A=CI/B=Contract)
    //   - license↔CI links  (M2M _LicenseToCI,  A=License/B=CI)
    //   - document↔CI links (document_cis.ci_id, onDelete: Cascade)
    // ...without telling the admin or leaving a forensic trail of WHICH refs were broken.
    const refRows = await prisma.$queryRaw<{ contracts: bigint; licenses: bigint; documents: bigint }[]>`
      SELECT
        (SELECT COUNT(*) FROM "_ContractToCI" WHERE "A" IN (${Prisma.join(ciIds.map((i) => Prisma.sql`${i}::uuid`))})) AS contracts,
        (SELECT COUNT(*) FROM "_LicenseToCI"  WHERE "B" IN (${Prisma.join(ciIds.map((i) => Prisma.sql`${i}::uuid`))})) AS licenses,
        (SELECT COUNT(*) FROM "document_cis"  WHERE ci_id IN (${Prisma.join(ciIds.map((i) => Prisma.sql`${i}::uuid`))})) AS documents`;
    const brokenRefs = {
      contracts: Number(refRows[0]?.contracts ?? 0),
      licenses:  Number(refRows[0]?.licenses  ?? 0),
      documents: Number(refRows[0]?.documents ?? 0),
    };
    const totalBroken = brokenRefs.contracts + brokenRefs.licenses + brokenRefs.documents;

    // If active references exist AND the caller hasn't explicitly opted in with
    // `force: true`, return 409 with a breakdown so the UI can warn the admin.
    if (totalBroken > 0 && !force) {
      res.status(409).json({
        error: 'Some CIs are linked to active contracts/licenses/documents.',
        brokenRefs,
        hint: 'Set { "force": true } in the request body to proceed and sever these associations.',
      });
      return;
    }

    const result = await prisma.$transaction(async (tx) => {
      // Per-CI audit BEFORE delete (so we keep entity_id resolvable to the historical name).
      // V2.5.1-A09-1: name lives in details.name, NOT concatenated into the action column
      // (which is VARCHAR(100) and risks truncation + PII leak per GDPR Art.5).
      for (const id of ciIds) {
        const name = existingMap.get(id);
        if (!name) continue;
        await tx.$executeRaw`
          INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, details, created_at)
          VALUES(gen_random_uuid(), 'DELETE_CI', 'CI', ${id}::uuid, ${req.user!.email},
                 ${JSON.stringify({ name })}::jsonb, now())`;
      }
      // V2.5.1-A04-2 + A09-3: aggregate audit avoids dumping the full UUID array.
      // Persists requested vs actuallyDeleted counts so NIS2 Art.23 traceability
      // distinguishes "I asked to delete 50" from "50 actually went away".
      const actuallyDeletedIds = Array.from(existingMap.keys());
      const notFoundCount = ciIds.length - existing.length;
      const aggDetails = {
        requested: ciIds.length,
        deleted: existing.length,
        notFound: notFoundCount,
        sample: actuallyDeletedIds.slice(0, 10),
        truncated: actuallyDeletedIds.length > 10,
        // V2.5.1-A04-1: forensic trail of associations severed by this delete
        brokenRefs,
        forced: !!force,
      };
      await tx.$executeRaw`
        INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, details, created_at)
        VALUES(gen_random_uuid(), 'CI_BULK_DELETE', 'CI', '00000000-0000-0000-0000-000000000000'::uuid, ${req.user!.email},
               ${JSON.stringify(aggDetails)}::jsonb, now())`;
      // Hard delete (cascades via schema).
      const del = await tx.cI.deleteMany({ where: { id: { in: ciIds } } });
      return del.count;
    });

    // Fire-and-forget RAG purge — don't block the HTTP response for up to N×latency.
    // purgeEntityFromRag is idempotent so retries on the next ragQueue tick are safe.
    for (const id of ciIds) {
      void purgeEntityFromRag('ci', id).catch((e) => console.error('[POST /api/cis/bulk-delete] RAG purge error:', e));
    }

    res.json({ deleted: result, notFound: ciIds.length - existing.length, requested: ciIds.length });
  } catch (error: unknown) {
    console.error('[POST /api/cis/bulk-delete] Error:', error);
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

    // V2.5.1-A09-2: wrap delete + audit in a single transaction so the audit row is
    // never missing when the row is gone (ISO 27001 A.8.15 atomicity).
    // V2.5.1-A09-1: store name in details.name (structured) instead of concatenated
    // into the action column (VARCHAR(100), PII risk).
    await prisma.$transaction(async (tx) => {
      await tx.cI.delete({ where: { id } });
      await tx.$executeRaw`
        INSERT INTO "audit_logs" (id, action, entity, entity_id, user_email, details, created_at)
        VALUES (gen_random_uuid(), 'DELETE_CI', 'CI', ${id}::uuid, ${req.user!.email},
                ${JSON.stringify({ name: ci.name })}::jsonb, now())
      `;
    });

    // Purge RAG asynchronously (don't block the response — RAG is eventually consistent)
    void purgeEntityFromRag('ci', id).catch((e) => console.error('[DELETE /api/cis/:id] RAG purge error:', e));

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

    // Re-index the vulnerability + its parent CI (whose summary line changed)
    void queueEntityForIndexing('vulnerability', vulnUuid(ciId, cve));
    void queueEntityForIndexing('ci', ciId);

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

    await prisma.$executeRaw`
      INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
      VALUES(gen_random_uuid(), 'CREATE', 'Contract', ${contract.id}::uuid, ${req.user!.email}, now())
    `;

    // Re-index the contract ROOT (addenda roll up to their root)
    const contractRootId = await getContractRoot(contract.id);
    void queueEntityForIndexing('contract', contractRootId);

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

/**
 * DELETE /api/contracts/:id — hard delete (ADMIN only).
 * Blocks (409) if the contract has active addendums — user must delete those first.
 * Cascades: DocumentContract rows and the implicit ContractToCI M2M are cleaned by Prisma.
 * Documents and CIs themselves are NOT deleted, only the associations.
 */
app.delete('/api/contracts/:id', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  const IdSchema = z.string().uuid();
  const parsedId = IdSchema.safeParse(req.params.id);
  if (!parsedId.success) {
    res.status(400).json({ error: 'Invalid contract id' });
    return;
  }
  const contractId = parsedId.data;
  try {
    const existing = await prisma.contract.findUnique({
      where: { id: contractId },
      select: { id: true, contractNumber: true, parentContractId: true },
    });
    if (!existing) { res.status(404).json({ error: 'Contract not found' }); return; }

    // Pre-check: addendums (children) must be deleted first.
    const addendums = await prisma.$queryRaw<{ c: bigint }[]>`
      SELECT COUNT(*) AS c FROM "contracts" WHERE parent_contract_id = ${contractId}::uuid`;
    if (Number(addendums[0]?.c ?? 0) > 0) {
      res.status(409).json({
        error: 'Cannot delete contract with active addendums. Delete those first.',
        addendumCount: Number(addendums[0]?.c ?? 0),
      });
      return;
    }

    // Compute root BEFORE delete so we can re-index after.
    const rootId = await getContractRoot(contractId);

    await prisma.$transaction(async (tx) => {
      // Prisma client delete drives cascades for ContractToCI (M2M) and DocumentContract.
      await tx.contract.delete({ where: { id: contractId } });
      await tx.$executeRaw`
        INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, details, created_at)
        VALUES(gen_random_uuid(), 'DELETE', 'Contract', ${contractId}::uuid, ${req.user!.email},
               ${JSON.stringify({ contractNumber: existing.contractNumber, wasAddendum: !!existing.parentContractId })}::jsonb, now())`;
    });

    // Drop RAG index entries for this contract (best-effort) and re-index root if it survives.
    try {
      await prisma.$executeRaw`DELETE FROM "rag_chunks" WHERE entity_type = 'contract' AND entity_id = ${contractId}::uuid`;
      await prisma.$executeRaw`DELETE FROM "rag_entity_index" WHERE entity_type = 'contract' AND entity_id = ${contractId}::uuid`;
    } catch (e) { console.error('[DELETE /api/contracts/:id] RAG cleanup error:', e); }
    if (rootId && rootId !== contractId) {
      void queueEntityForIndexing('contract', rootId);
    }

    res.json({ ok: true, deletedId: contractId });
  } catch (error: unknown) {
    console.error('[DELETE /api/contracts/:id] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/api/contracts/:id', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  const ContractUpdateSchema = z.object({
    contractNumber:   z.string().min(1).max(100),
    startDate:        z.string().min(1),
    endDate:          z.string().nullable().optional(),
    vendorId:         z.string().uuid(),
    parentContractId: z.string().uuid().nullable().optional(),
  });
  const parsed = ContractUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid contract data' });
    return;
  }
  const { contractNumber, startDate, endDate, vendorId, parentContractId } = parsed.data;
  const contractId = req.params.id as string;
  try {
    const contract = await prisma.contract.update({
      where: { id: contractId },
      data: {
        contractNumber,
        startDate:        new Date(startDate),
        endDate:          endDate ? new Date(endDate) : null,
        vendorId,
        parentContractId: parentContractId ?? null,
      },
      include: CONTRACT_INCLUDE,
    });
    await prisma.$executeRaw`
      INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
      VALUES(gen_random_uuid(), 'UPDATE', 'Contract', ${contractId}::uuid, ${req.user!.email}, now())
    `;
    const contractRootId = await getContractRoot(contract.id);
    void queueEntityForIndexing('contract', contractRootId);
    res.json(contract);
  } catch (error: unknown) {
    console.error('[PATCH /api/contracts/:id] Error:', error);
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
    res.json({ message: `${created} insertados, ${skipped} ya existían, ${errors} errores`, created, skipped, errors });
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
 * GET /api/cis/bulk/template.xlsx — download an XLSX template with data-validation
 * dropdowns populated from live master data. Sheet "Datos" has the editable rows;
 * Sheet "Instrucciones" explains every field and lists valid values.
 * ADMIN only (same as upload + commit).
 */
app.get('/api/cis/bulk/template.xlsx', authenticateToken, requireAdmin, async (_req: Request, res: Response) => {
  try {
    const [ciTypes, branches, costCenters, manufacturers] = await Promise.all([
      prisma.$queryRaw<{ code: string; name: string }[]>`SELECT code, name FROM "ci_types" ORDER BY name`,
      prisma.$queryRaw<{ name: string }[]>`SELECT name FROM "branches" ORDER BY name`,
      prisma.$queryRaw<{ name: string }[]>`SELECT name FROM "cost_centers" ORDER BY name`,
      prisma.$queryRaw<{ name: string }[]>`SELECT name FROM "manufacturers" ORDER BY name`,
    ]);

    const ciTypeCodes  = ciTypes.map((t) => t.code);
    const branchNames  = branches.map((b) => b.name);
    const ccNames      = costCenters.map((c) => c.name);
    const mfgNames     = manufacturers.map((m) => m.name);
    const criticalities = ['LOW', 'MEDIUM', 'HIGH', 'MISSION_CRITICAL'];
    const environments  = ['DEVELOPMENT', 'TESTING', 'STAGING', 'PRODUCTION'];
    const statuses      = ['ACTIVO', 'INACTIVO', 'RETIRADO'];
    const businessImpacts = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
    const dataClassifications = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'];

    const wb = new ExcelJS.Workbook();
    wb.creator = 'CMDB Enterprise Platform';
    wb.created = new Date();

    // ── Sheet 1: Datos (editable) ────────────────────────────────────────────
    const ws = wb.addWorksheet('Datos', { views: [{ state: 'frozen', ySplit: 1 }] });

    const COLS = [
      { key: 'name',               header: 'name *',               width: 30 },
      { key: 'ciType',             header: 'ciType *',             width: 22 },
      { key: 'criticality',        header: 'criticality *',        width: 18 },
      { key: 'environment',        header: 'environment *',        width: 18 },
      { key: 'status',             header: 'status',               width: 14 },
      { key: 'inventoryNumber',    header: 'inventoryNumber',      width: 20 },
      { key: 'manufacturer',       header: 'manufacturer',         width: 22 },
      { key: 'serialNumber',       header: 'serialNumber',         width: 22 },
      { key: 'model',              header: 'model',                width: 22 },
      { key: 'branch',             header: 'branch',               width: 22 },
      { key: 'costCenter',         header: 'costCenter',           width: 22 },
      { key: 'version',            header: 'version (SW)',         width: 16 },
      { key: 'licenseType',        header: 'licenseType (SW)',     width: 18 },
      { key: 'eolDate',            header: 'eolDate (YYYY-MM-DD)', width: 20 },
      { key: 'eosDate',            header: 'eosDate (YYYY-MM-DD)', width: 20 },
      { key: 'businessImpact',     header: 'businessImpact',       width: 18 },
      { key: 'dataClassification', header: 'dataClassification',  width: 22 },
      { key: 'assignedUser',       header: 'assignedUser',         width: 22 },
      { key: 'ipAddress',          header: 'ipAddress',            width: 18 },
      { key: 'description',        header: 'description',          width: 40 },
    ];

    ws.columns = COLS;

    // Header row styling
    const headerRow = ws.getRow(1);
    headerRow.eachCell((cell) => {
      cell.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } };
      cell.font   = { color: { argb: 'FFFFFFFF' }, bold: true, size: 10 };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FF1E40AF' } } };
      cell.alignment = { vertical: 'middle' };
    });

    // Two example rows
    ws.addRow({ name: 'PROD-SRV-01', ciType: 'PHYSICAL_SERVER', criticality: 'HIGH', environment: 'PRODUCTION', status: 'ACTIVO', manufacturer: mfgNames[0] ?? 'Dell', serialNumber: 'SN-001', model: 'PowerEdge R740', branch: branchNames[0] ?? '' });
    ws.addRow({ name: 'Office 365 E3', ciType: 'LICENSE', criticality: 'MEDIUM', environment: 'PRODUCTION', status: 'ACTIVO', version: '365', licenseType: 'subscription', eolDate: '2026-12-31' });

    // Data validations (dropdown lists)
    const listVal = (formulae: string) => ({ type: 'list' as const, allowBlank: true, showDropDown: true, formulae: [formulae] });
    const maxRow = 1000;
    for (let r = 2; r <= maxRow; r++) {
      ws.getCell(r, 2).dataValidation  = listVal(`"${ciTypeCodes.slice(0, 30).join(',')}"`);
      ws.getCell(r, 3).dataValidation  = listVal(`"${criticalities.join(',')}"`);
      ws.getCell(r, 4).dataValidation  = listVal(`"${environments.join(',')}"`);
      ws.getCell(r, 5).dataValidation  = listVal(`"${statuses.join(',')}"`);
      ws.getCell(r, 10).dataValidation = branchNames.length ? listVal(`"${branchNames.slice(0, 40).join(',')}"`) : undefined!;
      ws.getCell(r, 11).dataValidation = ccNames.length     ? listVal(`"${ccNames.slice(0, 40).join(',')}"`)     : undefined!;
      ws.getCell(r, 16).dataValidation = listVal(`"${businessImpacts.join(',')}"`);
      ws.getCell(r, 17).dataValidation = listVal(`"${dataClassifications.join(',')}"`);
    }

    // ── Sheet 2: Instrucciones ───────────────────────────────────────────────
    const wi = wb.addWorksheet('Instrucciones');
    const instructions: [string, string][] = [
      ['Campo',               'Descripción y valores válidos'],
      ['name *',              'Nombre del CI. Obligatorio y único.'],
      ['ciType *',            `Tipo de CI. Valores: ${ciTypeCodes.join(', ')}`],
      ['criticality *',       `Criticidad. Valores: ${criticalities.join(', ')}`],
      ['environment *',       `Entorno. Valores: ${environments.join(', ')}`],
      ['status',              `Estado. Valores: ${statuses.join(', ')} (defecto: ACTIVO)`],
      ['inventoryNumber',     'Número de inventario interno (único si se indica).'],
      ['manufacturer',        `Fabricante. Valores maestros: ${mfgNames.slice(0,20).join(', ')}`],
      ['serialNumber',        'Número de serie (hardware). Genera un tipo HardwareCI.'],
      ['model',               'Modelo del dispositivo (hardware).'],
      ['branch',              `Delegación / sede. Valores maestros: ${branchNames.slice(0,20).join(', ')}`],
      ['costCenter',          `Centro de coste. Valores maestros: ${ccNames.slice(0,20).join(', ')}`],
      ['version',             'Versión del software (SW). Si se indica, genera tipo SoftwareCI.'],
      ['licenseType',         'Tipo de licencia del software (SW). Ej: perpetual, subscription.'],
      ['eolDate',             'Fecha de fin de vida (End-of-Life). Formato YYYY-MM-DD.'],
      ['eosDate',             'Fecha de fin de soporte (End-of-Support). Formato YYYY-MM-DD.'],
      ['businessImpact',      `Impacto de negocio (NIS2). Valores: ${businessImpacts.join(', ')}`],
      ['dataClassification',  `Clasificación de datos (GDPR). Valores: ${dataClassifications.join(', ')}`],
      ['assignedUser',        'Nombre del usuario asignado al activo (si aplica).'],
      ['ipAddress',           'Dirección IP de consola de gestión (opcional).'],
      ['description',         'Descripción libre del CI.'],
      ['', ''],
      ['NOTAS:', ''],
      ['* Obligatorio',       'Los campos marcados con * son requeridos por el sistema.'],
      ['Filas 2-3',           'Son filas de ejemplo — borrarlas antes de importar.'],
      ['Conflictos',          'La IA detectará CIs existentes con el mismo nombre, nº de serie o inventario y los marcará para revisión.'],
    ];
    wi.columns = [{ width: 25 }, { width: 80 }];
    instructions.forEach((row, i) => {
      const r = wi.addRow(row);
      if (i === 0) { r.eachCell((c) => { c.font = { bold: true }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }; }); }
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla-cis.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('[GET /api/cis/bulk/template.xlsx]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/cis/bulk/batches — upload XLSX → create staging batch
app.post('/api/cis/bulk/batches', authenticateToken, requireAdmin, ciXlsxUploadMiddleware, async (req: Request, res: Response) => {
  const file = req.file;
  if (!file) { res.status(400).json({ error: 'Se requiere un fichero .xlsx' }); return; }

  // Validate magic bytes: XLSX = ZIP (PK\x03\x04)
  if (file.buffer.length < 4 || file.buffer[0] !== 0x50 || file.buffer[1] !== 0x4B ||
      file.buffer[2] !== 0x03 || file.buffer[3] !== 0x04) {
    res.status(400).json({ error: 'El fichero no es un XLSX válido' }); return;
  }

  // Concurrent-batch limit (shared constant, prevents staging DoS)
  try {
    const openRows = await prisma.$queryRaw<{ c: bigint }[]>`
      SELECT COUNT(*) AS c FROM "ci_bulk_import_batch"
      WHERE created_by = ${req.user!.email}
        AND status NOT IN ('COMMITTED','DISCARDED','REAPED')`;
    if (Number(openRows[0]?.c ?? 0) >= BULK_MAX_OPEN_BATCHES) {
      res.status(429).json({
        error: `Límite de ${BULK_MAX_OPEN_BATCHES} lotes abiertos alcanzado. Confirma o descarta alguno primero.`,
        maxBatches: BULK_MAX_OPEN_BATCHES,
      });
      return;
    }
  } catch (e) { console.error('[POST /api/cis/bulk/batches] limit check error:', e); }

  // Parse XLSX with ExcelJS
  let rows: Array<Record<string, string | null>> = [];
  try {
    const wb = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wb.xlsx.load(file.buffer as any);
    const ws = wb.getWorksheet('Datos') ?? wb.worksheets[0];
    if (!ws) { res.status(400).json({ error: 'El XLSX no contiene la hoja "Datos"' }); return; }

    const headers: string[] = [];
    ws.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
      headers[col - 1] = String(cell.value ?? '').replace(/\s*\*\s*$/, '').trim();
    });

    ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
      if (rowNum === 1) return;
      const obj: Record<string, string | null> = {};
      let hasData = false;
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        const key = headers[col - 1];
        if (!key) return;
        const v = cell.value;
        if (v !== null && v !== undefined && String(v).trim() !== '') {
          obj[key] = String(v).trim();
          hasData = true;
        } else {
          obj[key] = null;
        }
      });
      if (hasData && obj['name']) rows.push(obj);
    });
  } catch (e) {
    console.error('[POST /api/cis/bulk/batches] XLSX parse error:', e);
    res.status(400).json({ error: 'No se pudo leer el fichero XLSX' }); return;
  }

  if (rows.length === 0) { res.status(400).json({ error: 'El XLSX no contiene filas con datos válidos (columna "name" requerida)' }); return; }
  if (rows.length > CI_BULK_MAX_ROWS) { res.status(400).json({ error: `El XLSX excede el límite de ${CI_BULK_MAX_ROWS} filas` }); return; }

  try {
    const batchRows = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "ci_bulk_import_batch"(id, created_by, status, row_count, created_at, updated_at)
      VALUES(gen_random_uuid(), ${req.user!.email}, 'UPLOADED', ${rows.length}, now(), now())
      RETURNING id::text AS id`;
    const batchId = batchRows[0].id;

    for (let i = 0; i < rows.length; i++) {
      await prisma.$executeRaw`
        INSERT INTO "ci_bulk_import_item"(id, batch_id, row_index, raw_data, status, analysis, created_at, updated_at)
        VALUES(gen_random_uuid(), ${batchId}::uuid, ${i + 1}, ${JSON.stringify(rows[i])}::jsonb,
               'PENDING_ANALYSIS', '{}'::jsonb, now(), now())`;
    }

    await prisma.$executeRaw`
      INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, details, created_at)
      VALUES(gen_random_uuid(), 'CI_BULK_UPLOAD', 'CiBulkImportBatch', ${batchId}::uuid, ${req.user!.email},
             ${JSON.stringify({ rowCount: rows.length })}::jsonb, now())`;

    res.status(201).json({ batchId, rowCount: rows.length });
  } catch (e) {
    console.error('[POST /api/cis/bulk/batches]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/cis/bulk/batches — list admin's batches (most recent first)
app.get('/api/cis/bulk/batches', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  try {
    const [countRows, rows] = await Promise.all([
      prisma.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*) AS c FROM "ci_bulk_import_batch" WHERE created_by = ${req.user!.email}`,
      prisma.$queryRaw<{ id: string; status: string; rowCount: number; createdAt: Date; committed: bigint; pending: bigint; errors: bigint }[]>`
        SELECT b.id::text AS id, b.status, b.row_count AS "rowCount", b.created_at AS "createdAt",
               COUNT(i.id) FILTER (WHERE i.status = 'COMMITTED') AS committed,
               COUNT(i.id) FILTER (WHERE i.status IN ('PENDING_ANALYSIS','ANALYZING')) AS pending,
               COUNT(i.id) FILTER (WHERE i.status = 'ERROR') AS errors
        FROM "ci_bulk_import_batch" b
        LEFT JOIN "ci_bulk_import_item" i ON i.batch_id = b.id
        WHERE b.created_by = ${req.user!.email}
        GROUP BY b.id
        ORDER BY b.created_at DESC
        LIMIT 100`,
    ]);
    const total = Number(countRows[0]?.c ?? 0);
    res.json({
      total, truncated: total > 100,
      batches: rows.map(r => ({ ...r, committed: Number(r.committed), pending: Number(r.pending), errors: Number(r.errors) })),
    });
  } catch (e) { console.error('[GET /api/cis/bulk/batches]', e); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/cis/bulk/batches/:id — batch detail + items (polling target)
app.get('/api/cis/bulk/batches/:id', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  try {
    const batchRows = await prisma.$queryRaw<{ id: string; status: string; rowCount: number; createdBy: string; createdAt: Date }[]>`
      SELECT id::text AS id, status, row_count AS "rowCount", created_by AS "createdBy", created_at AS "createdAt"
      FROM "ci_bulk_import_batch"
      WHERE id = ${req.params.id}::uuid AND created_by = ${req.user!.email}
      LIMIT 1`;
    if (!batchRows.length) { res.status(404).json({ error: 'Batch not found' }); return; }

    const items = await prisma.$queryRaw<{ id: string; rowIndex: number; rawData: unknown; status: string; analysis: unknown; errorMessage: string | null; committedCiId: string | null; createdAt: Date }[]>`
      SELECT id::text AS id, row_index AS "rowIndex", raw_data AS "rawData", status,
             analysis, error_message AS "errorMessage", committed_ci_id::text AS "committedCiId", created_at AS "createdAt"
      FROM "ci_bulk_import_item"
      WHERE batch_id = ${req.params.id}::uuid
      ORDER BY row_index ASC`;

    res.json({ ...batchRows[0], items });
  } catch (e) { console.error('[GET /api/cis/bulk/batches/:id]', e); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /api/cis/bulk/items/:id — discard one staged item
app.delete('/api/cis/bulk/items/:id', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  try {
    const rows = await prisma.$queryRaw<{ id: string; batch_id: string; status: string }[]>`
      SELECT i.id::text AS id, i.batch_id::text AS batch_id, i.status
      FROM "ci_bulk_import_item" i
      JOIN "ci_bulk_import_batch" b ON b.id = i.batch_id
      WHERE i.id = ${req.params.id}::uuid AND b.created_by = ${req.user!.email}
      LIMIT 1`;
    if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
    if (rows[0].status === 'COMMITTED') { res.status(409).json({ error: 'El elemento ya fue confirmado y no se puede descartar' }); return; }
    await prisma.$executeRaw`DELETE FROM "ci_bulk_import_item" WHERE id = ${req.params.id}::uuid`;
    await recomputeCIBatchStatus(rows[0].batch_id);
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CI_BULK_DISCARD_ITEM','CiBulkImportItem',${req.params.id}::uuid,${req.user!.email},now())`;
    res.json({ ok: true });
  } catch (e) { console.error('[DELETE /api/cis/bulk/items/:id]', e); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /api/cis/bulk/batches/:id — discard a whole batch
app.delete('/api/cis/bulk/batches/:id', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  try {
    const batch = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM "ci_bulk_import_batch"
      WHERE id = ${req.params.id}::uuid AND created_by = ${req.user!.email} LIMIT 1`;
    if (!batch.length) { res.status(404).json({ error: 'Not found' }); return; }
    await prisma.$executeRaw`DELETE FROM "ci_bulk_import_batch" WHERE id = ${req.params.id}::uuid`;
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CI_BULK_DISCARD_BATCH','CiBulkImportBatch',${req.params.id}::uuid,${req.user!.email},now())`;
    res.json({ ok: true });
  } catch (e) { console.error('[DELETE /api/cis/bulk/batches/:id]', e); res.status(500).json({ error: 'Internal server error' }); }
});

// PATCH /api/cis/bulk/items/:id — save user's reviewed decision
app.patch('/api/cis/bulk/items/:id', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  const parsed = CIBulkDecisionSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Datos inválidos' }); return; }
  try {
    const rows = await prisma.$queryRaw<{ id: string; status: string }[]>`
      SELECT i.id::text AS id, i.status
      FROM "ci_bulk_import_item" i JOIN "ci_bulk_import_batch" b ON b.id = i.batch_id
      WHERE i.id = ${req.params.id}::uuid AND b.created_by = ${req.user!.email} LIMIT 1`;
    if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
    if (rows[0].status === 'COMMITTED') { res.status(409).json({ error: 'El elemento ya fue confirmado' }); return; }
    await prisma.$executeRaw`
      UPDATE "ci_bulk_import_item"
      SET analysis = jsonb_set(COALESCE(analysis, '{}'::jsonb), '{decision}', ${JSON.stringify(parsed.data)}::jsonb, true),
          updated_at = now()
      WHERE id = ${req.params.id}::uuid`;
    res.json({ ok: true });
  } catch (e) { console.error('[PATCH /api/cis/bulk/items/:id]', e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/cis/bulk/items/:id/commit — materialize one reviewed item
app.post('/api/cis/bulk/items/:id/commit', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  try {
    const rows = await prisma.$queryRaw<{ id: string; batch_id: string; status: string; analysis: unknown }[]>`
      SELECT i.id::text AS id, i.batch_id::text AS batch_id, i.status, i.analysis
      FROM "ci_bulk_import_item" i JOIN "ci_bulk_import_batch" b ON b.id = i.batch_id
      WHERE i.id = ${req.params.id}::uuid AND b.created_by = ${req.user!.email} LIMIT 1`;
    if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
    const item = rows[0];

    // Prefer body; fall back to persisted decision
    const source = req.body && Object.keys(req.body).length > 0
      ? req.body
      : (item.analysis as { decision?: unknown } | null)?.decision;
    const parsed = CIBulkDecisionSchema.safeParse(source);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Decisión inválida' }); return; }

    const result = await materializeCIBulkItem(item, parsed.data, req.user!.email);
    await recomputeCIBatchStatus(item.batch_id);
    res.status(201).json(result);
  } catch (e) {
    if (e instanceof CIBulkValidationError) { res.status(400).json({ error: e.message }); return; }
    if (typeof e === 'object' && e !== null && 'code' in e && (e as { code: string }).code === 'P2002') {
      res.status(409).json({ error: 'Conflicto de unicidad: nombre, número de serie o inventario ya existen' }); return;
    }
    console.error('[POST /api/cis/bulk/items/:id/commit]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/cis/bulk/batches/:id/commit — commit all reviewed items in the batch
app.post('/api/cis/bulk/batches/:id/commit', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  try {
    const batch = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM "ci_bulk_import_batch"
      WHERE id = ${req.params.id}::uuid AND created_by = ${req.user!.email} LIMIT 1`;
    if (!batch.length) { res.status(404).json({ error: 'Not found' }); return; }

    const items = await prisma.$queryRaw<{ id: string; batch_id: string; status: string; analysis: unknown }[]>`
      SELECT i.id::text AS id, i.batch_id::text AS batch_id, i.status, i.analysis
      FROM "ci_bulk_import_item" i
      WHERE i.batch_id = ${req.params.id}::uuid AND i.status IN ('ANALYZED','ERROR')
      ORDER BY i.row_index ASC`;

    const results: { itemId: string; ok: boolean; ciId?: string; error?: string }[] = [];
    for (const item of items) {
      const decision = (item.analysis as { decision?: unknown } | null)?.decision;
      const parsed = CIBulkDecisionSchema.safeParse(decision);
      if (!parsed.success) { results.push({ itemId: item.id, ok: false, error: parsed.error.issues[0]?.message ?? 'Decisión incompleta' }); continue; }
      try {
        const r = await materializeCIBulkItem(item, parsed.data, req.user!.email);
        results.push({ itemId: item.id, ok: true, ciId: r.ciId });
      } catch (e) {
        const msg = e instanceof CIBulkValidationError ? e.message
          : (typeof e === 'object' && e !== null && 'code' in e && (e as { code: string }).code === 'P2002')
            ? 'Conflicto de unicidad (nombre, serie o inventario ya existen)'
            : 'Error interno';
        results.push({ itemId: item.id, ok: false, error: msg });
      }
    }
    await recomputeCIBatchStatus(String(req.params.id));
    res.json({ results });
  } catch (e) { console.error('[POST /api/cis/bulk/batches/:id/commit]', e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/cis/bulk/items/:id/reanalyze — re-queue one ANALYZED/ERROR item
app.post('/api/cis/bulk/items/:id/reanalyze', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  try {
    const rows = await prisma.$queryRaw<{ id: string; batch_id: string }[]>`
      SELECT i.id::text AS id, i.batch_id::text AS batch_id
      FROM "ci_bulk_import_item" i JOIN "ci_bulk_import_batch" b ON b.id = i.batch_id
      WHERE i.id = ${req.params.id}::uuid AND b.created_by = ${req.user!.email}
        AND i.status IN ('ANALYZED','ERROR') LIMIT 1`;
    if (!rows.length) { res.status(404).json({ error: 'Not found or not re-analyzable' }); return; }
    await prisma.$executeRaw`
      UPDATE "ci_bulk_import_item" SET status='PENDING_ANALYSIS', error_message=NULL, updated_at=now()
      WHERE id = ${req.params.id}::uuid`;
    await recomputeCIBatchStatus(rows[0].batch_id);
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CI_BULK_REANALYZE_ITEM','CiBulkImportItem',${req.params.id}::uuid,${req.user!.email},now())`;
    res.json({ ok: true });
  } catch (e) { console.error('[POST /api/cis/bulk/items/:id/reanalyze]', e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/cis/bulk/batches/:id/reanalyze — re-queue all ANALYZED/ERROR items
app.post('/api/cis/bulk/batches/:id/reanalyze', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  try {
    const batch = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM "ci_bulk_import_batch"
      WHERE id = ${req.params.id}::uuid AND created_by = ${req.user!.email} LIMIT 1`;
    if (!batch.length) { res.status(404).json({ error: 'Not found' }); return; }
    const batchIdStr = String(req.params.id);
    const count = Number(await prisma.$executeRaw`
      UPDATE "ci_bulk_import_item" SET status='PENDING_ANALYSIS', error_message=NULL, updated_at=now()
      WHERE batch_id = ${batchIdStr}::uuid AND status IN ('ANALYZED','ERROR')`);
    await recomputeCIBatchStatus(batchIdStr);
    await prisma.$executeRaw`
      INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at)
      VALUES(gen_random_uuid(),'CI_BULK_REANALYZE_BATCH','CiBulkImportBatch',${batchIdStr}::uuid,${req.user!.email},
             ${JSON.stringify({ count })}::jsonb, now())`;
    res.json({ ok: true, count });
  } catch (e) { console.error('[POST /api/cis/bulk/batches/:id/reanalyze]', e); res.status(500).json({ error: 'Internal server error' }); }
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
      LEFT JOIN configuration_items ci      ON (CASE WHEN al.entity = 'CI'          THEN al.entity_id::uuid                         ELSE NULL END) = ci.id
      LEFT JOIN configuration_items vuln_ci ON (CASE WHEN al.entity = 'VULNERABILITY' THEN split_part(al.entity_id, ':', 1)::uuid   ELSE NULL END) = vuln_ci.id
      LEFT JOIN documents doc               ON (CASE WHEN al.entity = 'Document'     THEN al.entity_id::uuid                         ELSE NULL END) = doc.id
      LEFT JOIN users u                     ON (CASE WHEN al.entity = 'USER'          THEN al.entity_id::uuid                         ELSE NULL END) = u.id
      LEFT JOIN ci_relations rel            ON (CASE WHEN al.entity = 'CI_RELATION'  THEN al.entity_id::uuid                         ELSE NULL END) = rel.id
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
    const secret  = authenticator.generateSecret();
    const otpauth = authenticator.keyuri(req.user!.email, 'CMDB Enterprise', secret);
    const qrDataUrl = await QRCode.toDataURL(otpauth);

    // Store the pending secret server-side so /mfa/enable can retrieve it
    // without trusting any client-supplied value.
    await prisma.$executeRaw`
      UPDATE "users" SET mfa_pending_secret = ${secret}, updated_at = now() WHERE id = ${req.user!.id}::uuid
    `;
    await prisma.$executeRaw`
      INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
      VALUES(gen_random_uuid(), 'MFA_SETUP_INITIATED', 'User', ${req.user!.id}::uuid, ${req.user!.email}, now())`;

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
    const valid = authenticator.check(code, secret);
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
    const newToken = jwt.sign(newPayload, JWT_SECRET_VALUE, { expiresIn: '8h', algorithm: 'HS256' as const });
    setAuthCookie(res, newToken);

    let newDeviceToken: string | undefined;
    if (trustDevice) {
      newDeviceToken = crypto.randomBytes(32).toString('hex');
      const expiry = new Date();
      expiry.setDate(expiry.getDate() + TRUSTED_DEVICE_TTL_DAYS);
      // Bind token to client IP and User-Agent at creation time (Issue #25)
      const ua = req.headers['user-agent'] ?? '';
      const ip = req.ip ?? '';
      await prisma.$executeRaw`
        INSERT INTO "trusted_devices" (id, user_id, token, user_agent, ip_address, expires_at, created_at, last_seen_at)
        VALUES (gen_random_uuid(), ${req.user!.id}::uuid, ${newDeviceToken}, ${ua}, ${ip}, ${expiry}, now(), now())
      `;
    }

    await prisma.$executeRaw`
      INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
      VALUES(gen_random_uuid(), 'MFA_ENABLED', 'User', ${req.user!.id}::uuid, ${req.user!.email}, now())
    `;
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
 * Body: { cn: string, o?: string, ou?: string, c?: string, st?: string, l?: string, san?: string }
 *   san: comma-separated SANs, e.g. "DNS:cmdb.example.com,IP:10.0.0.1"
 *        If omitted, a DNS SAN is auto-derived from cn.
 * Returns: { csr: string, message: string }
 * ADMIN only.
 */

app.post('/api/admin/certificates/csr', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  const { cn, o, ou, c, st, l, san } = req.body as {
    cn?: string; o?: string; ou?: string; c?: string;
    st?: string; l?: string; san?: string;
  };

  if (!cn?.trim()) {
    res.status(400).json({ error: 'cn (Common Name) is required' });
    return;
  }

  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    const certDir = '/app/certs';
    const keyPath = path.join(certDir, 'server.key');
    const csrPath = path.join(certDir, 'server.csr');

    // Ensure directory exists (mapped from host via volume)
    fs.mkdirSync(certDir, { recursive: true });

    // Strip characters that are structurally special in OpenSSL DN notation
    const safeCn  = cn.trim().replace(/[/\\"'\0]/g, '');
    const safeO   = o?.trim()  ? o.trim().replace(/[/\\"'\0]/g, '')   : '';
    const safeOu  = ou?.trim() ? ou.trim().replace(/[/\\"'\0]/g, '')  : '';
    const safeC   = c?.trim()  ? c.trim().replace(/[/\\"'\0]/g, '')   : '';
    const safeSt  = st?.trim() ? st.trim().replace(/[/\\"'\0]/g, '')  : '';
    const safeL   = l?.trim()  ? l.trim().replace(/[/\\"'\0]/g, '')   : '';

    // Build subject string — field order matches RFC 4514 convention
    const subject =
      `/CN=${safeCn}` +
      (safeC  ? `/C=${safeC}`   : '') +
      (safeSt ? `/ST=${safeSt}` : '') +
      (safeL  ? `/L=${safeL}`   : '') +
      (safeO  ? `/O=${safeO}`   : '') +
      (safeOu ? `/OU=${safeOu}` : '');

    // Build SAN extension — auto-derive from CN if not provided
    let sanValue: string;
    if (san?.trim()) {
      sanValue = san.trim().replace(/[^a-zA-Z0-9.:,\-_*]/g, '');
    } else {
      // Auto-derive: if CN looks like an IP use IP:, otherwise use DNS:
      const ipPattern = /^(\d{1,3}\.){3}\d{1,3}$/;
      sanValue = ipPattern.test(safeCn) ? `IP:${safeCn}` : `DNS:${safeCn}`;
    }
    // Always add localhost so development containers can verify the cert
    if (!sanValue.includes('localhost')) {
      sanValue += ',DNS:localhost,IP:127.0.0.1';
    }

    log.info(`[POST /api/admin/certificates/csr] Generating 4096-bit CSR: ${subject} | SAN: ${sanValue}`);

    // execFile bypasses the shell — args are passed directly to the kernel,
    // making injection structurally impossible regardless of field content
    const { stderr } = await execFileAsync('openssl', [
      'req', '-new', '-newkey', 'rsa:4096', '-nodes',
      '-keyout', keyPath,
      '-out',    csrPath,
      '-subj',   subject,
      '-addext', `subjectAltName=${sanValue}`,
    ]);

    if (stderr && !stderr.includes('writing')) {
      log.warn(`[POST /api/admin/certificates/csr] OpenSSL stderr: ${stderr}`);
    }

    // Secure the private key
    fs.chmodSync(keyPath, 0o600);

    // Read generated CSR
    const csrContent = fs.readFileSync(csrPath, 'utf8');

    res.json({
      csr: csrContent,
      message: 'CSR generated (RSA 4096-bit). Send this to your CA for signing. The private key has been saved securely on the server.',
      san: sanValue,
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
      message: 'Certificate uploaded successfully. Restart the nginx container to apply the new certificate.',
      restartCommand: 'docker compose -f docker-compose.prod.yml restart nginx',
      certPath: '/certs/server.crt (shared volume)',
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
app.post('/api/admin/reset-vulnerabilities', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  try {
    // G-L03: wrap the UPDATE + audit in one transaction so the audit is never skipped
    // G-L01: nil UUID for SYSTEM-scope events (no single entity_id applies)
    const result = await prisma.$transaction(async (tx) => {
      const affected = await tx.$executeRaw`
        UPDATE "configuration_items"
        SET "vulnerabilities" = '[]'::jsonb
        WHERE "vulnerabilities" IS NOT NULL
      `;
      await tx.$executeRaw`
        INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, details, created_at)
        VALUES(gen_random_uuid(), 'RESET_VULNERABILITIES', 'SYSTEM', '00000000-0000-0000-0000-000000000000'::uuid, ${req.user!.email},
               ${JSON.stringify({ affectedCIs: Number(affected) })}::jsonb, now())`;
      return affected;
    });
    log.info(`[POST /api/admin/reset-vulnerabilities] Reset ${result} CI(s)`);

    // RAG mass purge: all vulnerability rows lose their parent data, so wipe
    // both chunks and index entries. Then mark every CI for re-index since
    // its summary line just lost all vulns. Skip CIs already INDEXING to
    // respect the ARCH-3 worker race guard.
    if (process.env.RAG_ENABLED === 'true') {
      try {
        await prisma.$executeRaw`DELETE FROM "rag_chunks" WHERE entity_type = 'vulnerability'`;
        await prisma.$executeRaw`DELETE FROM "rag_entity_index" WHERE entity_type = 'vulnerability'`;
        await prisma.$executeRaw`UPDATE "rag_entity_index" SET status='PENDING', updated_at=now() WHERE entity_type = 'ci' AND status != 'INDEXING'`;
      } catch (e) {
        console.error('[RAG] reset-vulnerabilities purge error:', e);
      }
    }

    res.json({ message: `Vulnerabilities cleared on ${result} configuration item(s)`, reset: Number(result) });
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
app.delete('/api/masters/manufacturers/all', authenticateToken, requireAdmin, async (req, res) => {
  try {
    // G-L03: wrap delete + audit in a single transaction so the audit is never missing
    // G-L01: use nil UUID for entity_id on bulk-delete SYSTEM events
    const n = await prisma.$transaction(async (tx) => {
      const affected = await tx.$executeRaw`DELETE FROM "manufacturers"`;
      await tx.$executeRaw`
        INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, details, created_at)
        VALUES(gen_random_uuid(), 'DELETE_ALL_MASTER', 'Manufacturer', '00000000-0000-0000-0000-000000000000'::uuid, ${req.user!.email},
               ${JSON.stringify({ deleted: Number(affected) })}::jsonb, now())`;
      return affected;
    });
    res.json({ deleted: Number(n), message: `${Number(n)} fabricante(s) eliminados` });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// Support Areas
app.get('/api/masters/support-areas', authenticateToken, async (_req, res) => {
  try {
    const rows = await prisma.$queryRaw<MasterRow[]>`SELECT id::text AS id, name FROM "support_areas" ORDER BY name ASC`;
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});
app.post('/api/masters/support-areas', authenticateToken, requireAdmin, async (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name?.trim()) { res.status(400).json({ error: 'name required' }); return; }
  try {
    const rows = await prisma.$queryRaw<MasterRow[]>`INSERT INTO "support_areas"(id,name,created_at,updated_at) VALUES(gen_random_uuid(),${name.trim()},now(),now()) RETURNING id::text AS id, name`;
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CREATE_MASTER','SupportArea',${rows[0].id}::uuid,${req.user!.email},now())`;
    res.status(201).json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});
app.patch('/api/masters/support-areas/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name?.trim()) { res.status(400).json({ error: 'name required' }); return; }
  try {
    const rows = await prisma.$queryRaw<MasterRow[]>`UPDATE "support_areas" SET name=${name.trim()}, updated_at=now() WHERE id=${req.params.id}::uuid RETURNING id::text AS id, name`;
    if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'UPDATE_MASTER','SupportArea',${rows[0].id}::uuid,${req.user!.email},now())`;
    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});
app.delete('/api/masters/support-areas/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'DELETE_MASTER','SupportArea',${req.params.id}::uuid,${req.user!.email},now())`;
    await prisma.$executeRaw`DELETE FROM "support_areas" WHERE id=${req.params.id}::uuid`;
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// Branches
app.get('/api/masters/branches', authenticateToken, async (_req, res) => {
  try {
    const rows = await prisma.$queryRaw<(MasterRow & { branch_code: string; physical_address: string | null; support_area_id: string; support_area_name: string })[]>`
      SELECT b.id::text AS id, b.name, b.branch_code, b.physical_address, b.support_area_id::text AS support_area_id, sa.name AS support_area_name
      FROM "branches" b LEFT JOIN "support_areas" sa ON b.support_area_id = sa.id ORDER BY b.name ASC`;
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});
app.post('/api/masters/branches', authenticateToken, requireAdmin, async (req, res) => {
  const { name, branchCode, physicalAddress, supportAreaId } = req.body as { name?: string; branchCode?: string; physicalAddress?: string; supportAreaId?: string };
  if (!name?.trim() || !branchCode?.trim() || !supportAreaId) { res.status(400).json({ error: 'name, branchCode, supportAreaId required' }); return; }
  try {
    const rows = await prisma.$queryRaw<MasterRow[]>`
      INSERT INTO "branches"(id,name,branch_code,physical_address,support_area_id,created_at,updated_at)
      VALUES(gen_random_uuid(),${name.trim()},${branchCode.trim()},${physicalAddress || null},${supportAreaId}::uuid,now(),now()) RETURNING id::text AS id, name`;
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CREATE_MASTER','Branch',${rows[0].id}::uuid,${req.user!.email},now())`;
    res.status(201).json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});
app.patch('/api/masters/branches/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { name, branchCode, physicalAddress, supportAreaId } = req.body as { name?: string; branchCode?: string; physicalAddress?: string; supportAreaId?: string };
  if (!name?.trim() || !branchCode?.trim() || !supportAreaId) { res.status(400).json({ error: 'name, branchCode, supportAreaId required' }); return; }
  try {
    const rows = await prisma.$queryRaw<MasterRow[]>`
      UPDATE "branches" SET name=${name.trim()}, branch_code=${branchCode.trim()}, physical_address=${physicalAddress || null}, support_area_id=${supportAreaId}::uuid, updated_at=now()
      WHERE id=${req.params.id}::uuid RETURNING id::text AS id, name`;
    if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'UPDATE_MASTER','Branch',${rows[0].id}::uuid,${req.user!.email},now())`;
    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});
app.delete('/api/masters/branches/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'DELETE_MASTER','Branch',${req.params.id}::uuid,${req.user!.email},now())`;
    await prisma.$executeRaw`DELETE FROM "branches" WHERE id=${req.params.id}::uuid`;
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// Manufacturers
app.get('/api/masters/manufacturers', authenticateToken, async (_req, res) => {
  try {
    const rows = await prisma.$queryRaw<MasterRow[]>`SELECT id::text AS id, name FROM "manufacturers" ORDER BY name ASC`;
    log.info(`[GET /api/masters/manufacturers] rows=${rows.length}`);
    res.json(rows);
  } catch (e) { console.error('[GET /api/masters/manufacturers]', e); res.status(500).json({ error: 'Internal server error' }); }
});
app.post('/api/masters/manufacturers', authenticateToken, requireAdmin, async (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name?.trim()) { res.status(400).json({ error: 'name required' }); return; }
  try {
    const rows = await prisma.$queryRaw<MasterRow[]>`INSERT INTO "manufacturers"(id,name,created_at,updated_at) VALUES(gen_random_uuid(),${name.trim()},now(),now()) RETURNING id::text AS id, name`;
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CREATE_MASTER','Manufacturer',${rows[0].id}::uuid,${req.user!.email},now())`;
    res.status(201).json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});
app.patch('/api/masters/manufacturers/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name?.trim()) { res.status(400).json({ error: 'name required' }); return; }
  try {
    const rows = await prisma.$queryRaw<MasterRow[]>`UPDATE "manufacturers" SET name=${name.trim()}, updated_at=now() WHERE id=${req.params.id}::uuid RETURNING id::text AS id, name`;
    if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'UPDATE_MASTER','Manufacturer',${rows[0].id}::uuid,${req.user!.email},now())`;
    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});
app.delete('/api/masters/manufacturers/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'DELETE_MASTER','Manufacturer',${req.params.id}::uuid,${req.user!.email},now())`;
    await prisma.$executeRaw`DELETE FROM "manufacturers" WHERE id=${req.params.id}::uuid`;
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// Device Models
app.get('/api/masters/device-models', authenticateToken, async (_req, res) => {
  try {
    const rows = await prisma.$queryRaw<(MasterRow & { manufacturer_id: string; manufacturer_name: string })[]>`
      SELECT dm.id::text AS id, dm.name, dm.manufacturer_id::text AS manufacturer_id, m.name AS manufacturer_name
      FROM "device_models" dm LEFT JOIN "manufacturers" m ON dm.manufacturer_id = m.id ORDER BY m.name, dm.name`;
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});
app.post('/api/masters/device-models', authenticateToken, requireAdmin, async (req, res) => {
  const { name, manufacturerId } = req.body as { name?: string; manufacturerId?: string };
  if (!name?.trim() || !manufacturerId) { res.status(400).json({ error: 'name, manufacturerId required' }); return; }
  try {
    const rows = await prisma.$queryRaw<MasterRow[]>`
      INSERT INTO "device_models"(id,name,manufacturer_id,created_at,updated_at)
      VALUES(gen_random_uuid(),${name.trim()},${manufacturerId}::uuid,now(),now()) RETURNING id::text AS id, name`;
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CREATE_MASTER','DeviceModel',${rows[0].id}::uuid,${req.user!.email},now())`;
    res.status(201).json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});
app.patch('/api/masters/device-models/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { name, manufacturerId } = req.body as { name?: string; manufacturerId?: string };
  if (!name?.trim() || !manufacturerId) { res.status(400).json({ error: 'name, manufacturerId required' }); return; }
  try {
    const rows = await prisma.$queryRaw<MasterRow[]>`
      UPDATE "device_models" SET name=${name.trim()}, manufacturer_id=${manufacturerId}::uuid, updated_at=now()
      WHERE id=${req.params.id}::uuid RETURNING id::text AS id, name`;
    if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'UPDATE_MASTER','DeviceModel',${rows[0].id}::uuid,${req.user!.email},now())`;
    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});
app.delete('/api/masters/device-models/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'DELETE_MASTER','DeviceModel',${req.params.id}::uuid,${req.user!.email},now())`;
    await prisma.$executeRaw`DELETE FROM "device_models" WHERE id=${req.params.id}::uuid`;
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// Cost Centers
app.get('/api/masters/cost-centers', authenticateToken, async (_req, res) => {
  try {
    const rows = await prisma.$queryRaw<{ id: string; code: string; name: string }[]>`SELECT id::text AS id, code, name FROM "cost_centers" ORDER BY code ASC`;
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});
app.post('/api/masters/cost-centers', authenticateToken, requireAdmin, async (req, res) => {
  const { code, name } = req.body as { code?: string; name?: string };
  if (!code?.trim() || !name?.trim()) { res.status(400).json({ error: 'code and name required' }); return; }
  try {
    const rows = await prisma.$queryRaw<{ id: string; code: string; name: string }[]>`
      INSERT INTO "cost_centers"(id,code,name,created_at,updated_at) VALUES(gen_random_uuid(),${code.trim()},${name.trim()},now(),now())
      RETURNING id::text AS id, code, name`;
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CREATE_MASTER','CostCenter',${rows[0].id}::uuid,${req.user!.email},now())`;
    res.status(201).json(rows[0]);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('unique') || msg.includes('duplicate')) { res.status(409).json({ error: 'El código ya existe' }); return; }
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
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
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'UPDATE_MASTER','CostCenter',${rows[0].id}::uuid,${req.user!.email},now())`;
    res.json(rows[0]);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('unique') || msg.includes('duplicate')) { res.status(409).json({ error: 'El código ya existe' }); return; }
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
  }
});
app.delete('/api/masters/cost-centers/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'DELETE_MASTER','CostCenter',${req.params.id}::uuid,${req.user!.email},now())`;
    await prisma.$executeRaw`DELETE FROM "cost_centers" WHERE id=${req.params.id}::uuid`;
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
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
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// ─── CI Types CRUD ─────────────────────────────────────────────────────────────
app.get('/api/masters/ci-types', authenticateToken, async (_req, res) => {
  try {
    const types = await prisma.cIType.findMany({
      orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }],
      select: { id: true, code: true, name: true, categoryCode: true, sortOrder: true, isSystem: true },
    });
    res.json(types);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
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
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CREATE_MASTER','CIType',${row.id}::uuid,${req.user!.email},now())`;
    res.status(201).json(row);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('unique') || msg.includes('Unique')) { res.status(409).json({ error: 'El código ya existe' }); return; }
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
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
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'UPDATE_MASTER','CIType',${row.id}::uuid,${req.user!.email},now())`;
    res.json(row);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
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
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'DELETE_MASTER','CIType',${id}::uuid,${req.user!.email},now())`;
    await prisma.cIType.delete({ where: { id } });
    res.json({ ok: true });
  } catch (e: unknown) {
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
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
    // Atomic INSERT...SELECT: inserts only if both CIs exist, eliminating TOCTOU race
    const relation = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO ci_relations (id, source_ci_id, target_ci_id, relation_type, created_by, created_at)
      SELECT gen_random_uuid(), ${sourceCiId}::uuid, ${targetCiId}::uuid, ${relationType}::"RelationType", ${req.user!.email}, now()
      WHERE (SELECT COUNT(*) FROM configuration_items WHERE id IN (${sourceCiId}::uuid, ${targetCiId}::uuid)) = 2
      RETURNING id::text
    `;

    if (!relation.length) {
      res.status(404).json({ error: 'One or both CIs not found.' });
      return;
    }

    await prisma.$executeRaw`
      INSERT INTO "audit_logs" (id, action, entity, entity_id, user_email, created_at)
      VALUES (gen_random_uuid(), ${'CREATE_RELATION:' + relationType}, 'CI_RELATION', ${relation[0].id}, ${req.user!.email}, now())
    `;

    // Re-index BOTH endpoints — each CI's relation list changed
    void queueEntityForIndexing('ci', sourceCiId);
    void queueEntityForIndexing('ci', targetCiId);

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
    // Atomic INSERT...SELECT: inserts only if both CIs exist, eliminating TOCTOU race
    const relation = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO ci_relations (id, source_ci_id, target_ci_id, relation_type, created_by, created_at)
      SELECT gen_random_uuid(), ${sourceCiId}::uuid, ${targetCiId}::uuid, ${relationType}::"RelationType", ${req.user!.email}, now()
      WHERE (SELECT COUNT(*) FROM configuration_items WHERE id IN (${sourceCiId}::uuid, ${targetCiId}::uuid)) = 2
      RETURNING id::text
    `;

    if (!relation.length) {
      res.status(404).json({ error: 'One or both CIs not found.' });
      return;
    }

    await prisma.$executeRaw`
      INSERT INTO "audit_logs" (id, action, entity, entity_id, user_email, created_at)
      VALUES (gen_random_uuid(), ${'CREATE_RELATION:' + relationType}, 'CI_RELATION', ${relation[0].id}, ${req.user!.email}, now())
    `;

    // Re-index BOTH endpoints — each CI's relation list changed
    void queueEntityForIndexing('ci', sourceCiId);
    void queueEntityForIndexing('ci', targetCiId);

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
    // Look up endpoints BEFORE the delete so we can re-index both CIs after
    const endpoints = await prisma.$queryRaw<{ source_ci_id: string; target_ci_id: string }[]>`
      SELECT source_ci_id::text AS source_ci_id, target_ci_id::text AS target_ci_id
      FROM ci_relations WHERE id = ${id}::uuid LIMIT 1
    `;

    await prisma.$executeRaw`DELETE FROM ci_relations WHERE id = ${id}::uuid`;

    await prisma.$executeRaw`
      INSERT INTO "audit_logs" (id, action, entity, entity_id, user_email, created_at)
      VALUES (gen_random_uuid(), 'DELETE_RELATION', 'CI_RELATION', ${id}, ${req.user!.email}, now())
    `;

    // Re-index both endpoints (relation list changed for both)
    if (endpoints.length) {
      void queueEntityForIndexing('ci', endpoints[0].source_ci_id);
      void queueEntityForIndexing('ci', endpoints[0].target_ci_id);
    }

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

    // Re-index this entity for the RAG (queue, non-blocking on errors)
    void queueEntityForIndexing('ci', id);

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

      // Queue every (ci, cve) pair for re-index, plus the parent CI once
      for (const v of merged) {
        void queueEntityForIndexing('vulnerability', vulnUuid(ci.id, v.cve));
      }
      void queueEntityForIndexing('ci', ci.id);
    }

    const totalMatched = processed.filter((p) => p.matched).length;
    await prisma.$executeRaw`
      INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, details, created_at)
      VALUES(gen_random_uuid(), 'INTEGRATION_GREENBONE', 'SYSTEM', '00000000-0000-0000-0000-000000000000'::uuid, ${req.user!.email},
             ${JSON.stringify({ totalMatched, totalUnmatched: processed.length - totalMatched })}::jsonb, now())`;
    res.json({
      message: 'Greenbone report processed',
      processed,
      totalMatched,
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

    const totalMatched = processed.filter((p) => p.matched).length;
    await prisma.$executeRaw`
      INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, details, created_at)
      VALUES(gen_random_uuid(), 'INTEGRATION_CROWDSTRIKE', 'SYSTEM', '00000000-0000-0000-0000-000000000000'::uuid, ${req.user!.email},
             ${JSON.stringify({ totalMatched, totalUnmatched: processed.length - totalMatched })}::jsonb, now())`;
    res.json({
      message: 'CrowdStrike report processed',
      processed,
      totalMatched,
      totalUnmatched: processed.filter((p) => !p.matched).length,
    });
  } catch (error) {
    console.error('[POST /api/integrations/crowdstrike] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Document Repository ──────────────────────────────────────────────────────

const DOCUMENTS_DIR = process.env.DOCUMENTS_DIR ?? '/app/documents';
const MAX_DOCUMENT_SIZE_MB = parseInt(process.env.MAX_DOCUMENT_SIZE_MB ?? '50', 10);
const MAX_FILE_SIZE = MAX_DOCUMENT_SIZE_MB * 1024 * 1024;

// ── Bulk document import (staging) ────────────────────────────────────────────
// Files land in STAGING_DIR (UUID names) until the user confirms each line, at
// which point they are moved into DOCUMENTS_DIR as real Document records.
const STAGING_DIR          = process.env.BULK_STAGING_DIR ?? path.join(DOCUMENTS_DIR, '_staging');
const BULK_MAX_FILES       = parseInt(process.env.BULK_MAX_FILES ?? '20', 10);
const BULK_MAX_TOTAL_BYTES = parseInt(process.env.BULK_MAX_TOTAL_MB ?? '200', 10) * 1024 * 1024;
const BULK_BATCH_TTL_HOURS    = parseInt(process.env.BULK_BATCH_TTL_HOURS ?? '24', 10);
// Items analyzed per cron tick — kept small so AI bulk analysis never starves
// the normal RAG indexing queue (both share the single CPU-bound Ollama).
const BULK_ANALYZE_BUDGET     = parseInt(process.env.BULK_ANALYZE_BUDGET ?? '2', 10);
// Max concurrent open batches per user (non-terminal states). Prevents DoS / staging exhaustion.
const BULK_MAX_OPEN_BATCHES   = parseInt(process.env.BULK_MAX_OPEN_BATCHES ?? '5', 10);
// Max total staging bytes held by a single user across all open batches (default 500 MB).
// Prevents peak disk exhaustion when multiple large batches are open simultaneously.
const BULK_MAX_USER_STAGING_BYTES = parseInt(process.env.BULK_MAX_USER_STAGING_MB ?? '500', 10) * 1024 * 1024;
// Days to retain REAPED batch rows in the DB before final deletion. Gives users time
// to see expired batches in the list view (Task C) without causing table bloat.
const BULK_REAPED_RETENTION_DAYS = parseInt(process.env.BULK_REAPED_RETENTION_DAYS ?? '7', 10);

// ── CI Bulk Import (staging + AI analysis) ────────────────────────────────────
const CI_BULK_MAX_ROWS = parseInt(process.env.CI_BULK_MAX_ROWS ?? '500', 10);

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

// ── Document ACL visibility helpers ──────────────────────────────────────────

/** Returns the Prisma where-clause field that gates read access for this role. */
function docVisibilityFilter(role: string): { readAdmin: boolean } | { readAuditor: boolean } | { readViewer: boolean } {
  if (role === 'ADMIN')   return { readAdmin: true };
  if (role === 'AUDITOR') return { readAuditor: true };
  return { readViewer: true };
}

/**
 * Returns the SQL column name (in snake_case) that gates read access for this role.
 * Values come from an internal allowlist — safe to use with Prisma.raw().
 */
function docVisibilitySqlCol(role: string): string {
  if (role === 'ADMIN')   return 'read_admin';
  if (role === 'AUDITOR') return 'read_auditor';
  return 'read_viewer';
}

// ─── RAG helpers ─────────────────────────────────────────────────────────────

async function queueDocumentForIndexing(documentId: string, versionNumber: number): Promise<void> {
  if (process.env.RAG_ENABLED !== 'true') return;
  try {
    await prisma.$executeRaw`
      INSERT INTO "rag_document_index"(id, document_id, version_number, status, created_at, updated_at)
      VALUES(gen_random_uuid(), ${documentId}::uuid, ${versionNumber}, 'PENDING', now(), now())
      ON CONFLICT (document_id, version_number) DO UPDATE SET status='PENDING', updated_at=now()`;
  } catch (e) {
    console.error('[RAG] queueDocumentForIndexing error:', e);
  }
}

type RagEntityType = 'ci' | 'contract' | 'license' | 'vulnerability';

/**
 * Enqueues a non-document entity for asynchronous RAG indexing.
 *
 * Idempotent UPSERT with an ARCH-3 guard: never overwrites a row whose status
 * is INDEXING (would race with the worker mid-flight). The next worker tick
 * picks up PENDING rows.
 *
 * For vulnerabilities, the caller must derive entityId via vulnUuid(ciId, cve)
 * from entitySerializer.ts — never pass raw CI UUID for a 'vulnerability' type.
 */
async function queueEntityForIndexing(entityType: RagEntityType, entityId: string): Promise<void> {
  if (process.env.RAG_ENABLED !== 'true') return;
  try {
    await prisma.$executeRaw`
      INSERT INTO "rag_entity_index"(id, entity_type, entity_id, status, created_at, updated_at)
      VALUES(gen_random_uuid(), ${entityType}, ${entityId}::uuid, 'PENDING', now(), now())
      ON CONFLICT (entity_type, entity_id) DO UPDATE
        SET status='PENDING', updated_at=now()
        WHERE "rag_entity_index".status != 'INDEXING'`;
  } catch (e) {
    console.error('[RAG] queueEntityForIndexing error:', e);
  }
}

/**
 * Synchronously purges all chunks + index row for an entity. Call this BEFORE
 * the HTTP response of DELETE handlers (await, not void) so the chunks never
 * survive their parent entity (GDPR Art.17 / ISO 27001 A.8.10).
 */
async function purgeEntityFromRag(entityType: RagEntityType, entityId: string): Promise<void> {
  if (process.env.RAG_ENABLED !== 'true') return;
  try {
    await prisma.$executeRaw`DELETE FROM "rag_chunks" WHERE entity_type = ${entityType} AND entity_id = ${entityId}::uuid`;
    await prisma.$executeRaw`DELETE FROM "rag_entity_index" WHERE entity_type = ${entityType} AND entity_id = ${entityId}::uuid`;
  } catch (e) {
    console.error('[RAG] purgeEntityFromRag error:', e);
  }
}

async function processRagQueue(): Promise<void> {
  if (process.env.RAG_ENABLED !== 'true') return;
  if (!(await isOllamaHealthy())) return;

  // Per-cycle counters (used by the INDEX_BATCH audit row at the end)
  let docsProcessed = 0, docsErrors = 0;
  let ciProcessed = 0, ciErrors = 0;
  let contractProcessed = 0, contractErrors = 0;
  let licenseProcessed = 0, licenseErrors = 0;
  let vulnProcessed = 0, vulnErrors = 0;

  const pending = await prisma.$queryRaw<{ id: string; document_id: string; version_number: number }[]>`
    SELECT id::text AS id, document_id::text AS document_id, version_number
    FROM "rag_document_index"
    WHERE status = 'PENDING'
    ORDER BY created_at
    LIMIT 3`;

  for (const row of pending) {
    try {
      await prisma.$executeRaw`
        UPDATE "rag_document_index" SET status='INDEXING', updated_at=now() WHERE id=${row.id}::uuid`;

      const docRows = await prisma.$queryRaw<{ id: string; file_name: string; mime_type: string; title: string; version_number: number }[]>`
        SELECT id::text AS id, file_name, mime_type, title, version_number
        FROM "documents"
        WHERE id=${row.document_id}::uuid
        LIMIT 1`;

      if (!docRows.length) {
        await prisma.$executeRaw`
          UPDATE "rag_document_index" SET status='ERROR', error_message='Document not found', updated_at=now()
          WHERE id=${row.id}::uuid`;
        continue;
      }

      const doc = docRows[0];
      const filePath = path.join(DOCUMENTS_DIR, doc.file_name);
      const parseResult = await parseDocument(filePath, doc.mime_type, doc.title);

      if (parseResult.sections.length === 0) {
        await prisma.$executeRaw`
          UPDATE "rag_document_index" SET status='READY', chunk_count=0, indexed_at=now(), updated_at=now()
          WHERE id=${row.id}::uuid`;
        continue;
      }

      const chunks = chunkSections(parseResult.sections);

      await prisma.$executeRaw`
        DELETE FROM "rag_chunks"
        WHERE document_id=${row.document_id}::uuid AND version_number=${row.version_number}`;

      const texts = chunks.map((c) => c.content);
      const embeddings = await getEmbeddingsBatch(texts);

      for (let i = 0; i < chunks.length; i++) {
        const embeddingStr = `[${embeddings[i].join(',')}]`;
        const docId = row.document_id;
        const versionNumber = row.version_number;
        await prisma.$executeRaw`
          INSERT INTO "rag_chunks"(id, document_id, version_number, chunk_index, section_path, page_start, page_end, token_count, content, embedding, metadata, entity_type, entity_id, created_at)
          VALUES(gen_random_uuid(), ${docId}::uuid, ${versionNumber}, ${chunks[i].chunkIndex}, ${chunks[i].sectionPath ?? null}, ${chunks[i].pageStart ?? null}, ${chunks[i].pageEnd ?? null}, ${chunks[i].tokenCount}, ${chunks[i].content}, ${embeddingStr}::vector, '{}'::jsonb, 'document', ${docId}::uuid, now())`;
      }

      await prisma.$executeRaw`
        UPDATE "rag_document_index" SET status='READY', chunk_count=${chunks.length}, indexed_at=now(), updated_at=now()
        WHERE id=${row.id}::uuid`;

      await prisma.$executeRaw`
        INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
        VALUES(gen_random_uuid(), 'INDEX_DOC', 'Document', ${row.document_id}::uuid, 'system', now())`;
      docsProcessed++;
    } catch (e) {
      console.error('[RAG] processRagQueue doc error:', e);
      const errMsg = String(e).slice(0, 500);
      await prisma.$executeRaw`
        UPDATE "rag_document_index" SET status='ERROR', error_message=${errMsg}, updated_at=now()
        WHERE id=${row.id}::uuid`;
      docsErrors++;
    }
  }

  // ── Entity queue (plan §10.1 priority + budget) ────────────────────────────
  // Up to 3 entity slots per tick, allocated:
  //   1) up to 3 vulnerabilities,
  //   2) then up to 2 contract|license,
  //   3) then up to 1 ci.
  type EntityRow = { id: string; entity_type: RagEntityType; entity_id: string };

  // Lookup helper for vulnerability re-index:
  // 1) Fast path — read (ciId, cve) from the most recent existing chunk metadata.
  // 2) Slow path — scan configuration_items.vulnerabilities JSON arrays and match
  //    vulnUuid(ciId, cve) against the given entityId. Only triggers on first index.
  const resolveVulnTuple = async (
    entityId: string,
  ): Promise<{ ciId: string; cve: string } | null> => {
    try {
      const chunkRows = await prisma.$queryRaw<{ ci_id: string | null; cve: string | null }[]>`
        SELECT metadata->>'ciId' AS ci_id, metadata->>'cve' AS cve
        FROM "rag_chunks"
        WHERE entity_type = 'vulnerability' AND entity_id = ${entityId}::uuid
        ORDER BY created_at DESC
        LIMIT 1`;
      if (chunkRows.length > 0 && chunkRows[0].ci_id && chunkRows[0].cve) {
        return { ciId: chunkRows[0].ci_id, cve: chunkRows[0].cve };
      }
    } catch (e) {
      console.error('[RAG] resolveVulnTuple chunk lookup error:', e);
    }
    // Fallback: scan CI vulnerability arrays.
    try {
      const ciRows = await prisma.$queryRaw<{ id: string; vulnerabilities: unknown }[]>`
        SELECT id::text AS id, vulnerabilities
        FROM "configuration_items"
        WHERE vulnerabilities IS NOT NULL
          AND jsonb_typeof(vulnerabilities) = 'array'
          AND jsonb_array_length(vulnerabilities) > 0`;
      for (const ciRow of ciRows) {
        const arr = Array.isArray(ciRow.vulnerabilities) ? ciRow.vulnerabilities : [];
        for (const v of arr) {
          if (!v || typeof v !== 'object') continue;
          const cve = (v as { cve?: unknown }).cve;
          if (typeof cve !== 'string' || cve.length === 0) continue;
          if (vulnUuid(ciRow.id, cve) === entityId) {
            return { ciId: ciRow.id, cve };
          }
        }
      }
    } catch (e) {
      console.error('[RAG] resolveVulnTuple scan error:', e);
    }
    return null;
  };

  // Slot 1: vulnerabilities (up to 3)
  const vulnRows = await prisma.$queryRaw<EntityRow[]>`
    SELECT id::text AS id, entity_type, entity_id::text AS entity_id
    FROM "rag_entity_index"
    WHERE status = 'PENDING' AND entity_type = 'vulnerability'
    ORDER BY created_at
    LIMIT 3`;
  let entitySlotsRemaining = 3 - vulnRows.length;

  // Slot 2: contracts + licenses (max 2 — capped at remaining slots)
  const clLimit = Math.min(2, entitySlotsRemaining);
  const contractLicenseRows = clLimit > 0
    ? await prisma.$queryRaw<EntityRow[]>`
        SELECT id::text AS id, entity_type, entity_id::text AS entity_id
        FROM "rag_entity_index"
        WHERE status = 'PENDING' AND entity_type IN ('contract','license')
        ORDER BY created_at
        LIMIT ${clLimit}`
    : [];
  entitySlotsRemaining -= contractLicenseRows.length;

  // Slot 3: ci (max 1 — capped at remaining slots)
  const ciLimit = Math.min(1, entitySlotsRemaining);
  const ciRows = ciLimit > 0
    ? await prisma.$queryRaw<EntityRow[]>`
        SELECT id::text AS id, entity_type, entity_id::text AS entity_id
        FROM "rag_entity_index"
        WHERE status = 'PENDING' AND entity_type = 'ci'
        ORDER BY created_at
        LIMIT ${ciLimit}`
    : [];

  const entityRows: EntityRow[] = [...vulnRows, ...contractLicenseRows, ...ciRows];

  for (const row of entityRows) {
    try {
      await prisma.$executeRaw`UPDATE "rag_entity_index" SET status='INDEXING', updated_at=now() WHERE id=${row.id}::uuid`;

      // Resolve the entity → EntityParseResult via the appropriate serializer.
      let parseResult: EntityParseResult | null = null;
      let vulnTuple: { ciId: string; cve: string } | null = null;

      try {
        if (row.entity_type === 'ci') {
          parseResult = await serializeCI(row.entity_id);
        } else if (row.entity_type === 'contract') {
          parseResult = await serializeContract(row.entity_id);
        } else if (row.entity_type === 'license') {
          parseResult = await serializeLicense(row.entity_id);
        } else if (row.entity_type === 'vulnerability') {
          vulnTuple = await resolveVulnTuple(row.entity_id);
          if (vulnTuple) {
            parseResult = await serializeVulnerability(vulnTuple.ciId, vulnTuple.cve);
          }
        }
      } catch (serErr) {
        // Serializer threw (e.g. entity not found) — treat as missing content.
        console.error('[RAG] entity serializer error:', serErr);
        parseResult = null;
      }

      // ARCH-4 guard: missing entity → purge and mark ERROR.
      if (!parseResult || parseResult.sections.length === 0) {
        await prisma.$executeRaw`
          UPDATE "rag_entity_index" SET status='ERROR', error_message='Entity not found', updated_at=now()
          WHERE id=${row.id}::uuid`;
        await purgeEntityFromRag(row.entity_type, row.entity_id);
        if (row.entity_type === 'ci') ciErrors++;
        else if (row.entity_type === 'contract') contractErrors++;
        else if (row.entity_type === 'license') licenseErrors++;
        else if (row.entity_type === 'vulnerability') vulnErrors++;
        continue;
      }

      // minChunkTokens:1 — entity serializations are intentionally short (structured
      // metadata, not prose). The default 50-token floor discards them entirely.
      const chunks = chunkSections(parseResult.sections, { minChunkTokens: 1 });

      // Replace existing chunks for this (entity_type, entity_id).
      await prisma.$executeRaw`
        DELETE FROM "rag_chunks"
        WHERE entity_type = ${row.entity_type} AND entity_id = ${row.entity_id}::uuid`;

      const texts = chunks.map((c) => c.content);
      const embeddings = texts.length > 0 ? await getEmbeddingsBatch(texts) : [];

      // Build metadata: title + entityType/entityId; vulns also carry (ciId, cve)
      // so the next re-index resolves without scanning JSON arrays.
      const baseMeta: Record<string, unknown> = {
        title: parseResult.title,
        entityType: row.entity_type,
        entityId: row.entity_id,
      };
      if (row.entity_type === 'vulnerability' && vulnTuple) {
        baseMeta.ciId = vulnTuple.ciId;
        baseMeta.cve = vulnTuple.cve;
      }
      const metaStr = JSON.stringify(baseMeta);

      for (let i = 0; i < chunks.length; i++) {
        const embeddingStr = `[${embeddings[i].join(',')}]`;
        await prisma.$executeRaw`
          INSERT INTO "rag_chunks"(id, document_id, version_number, chunk_index, section_path, page_start, page_end, token_count, content, embedding, metadata, entity_type, entity_id, created_at)
          VALUES(gen_random_uuid(), NULL, 1, ${chunks[i].chunkIndex}, ${chunks[i].sectionPath ?? null}, ${chunks[i].pageStart ?? null}, ${chunks[i].pageEnd ?? null}, ${chunks[i].tokenCount}, ${chunks[i].content}, ${embeddingStr}::vector, ${metaStr}::jsonb, ${row.entity_type}, ${row.entity_id}::uuid, now())`;
      }

      await prisma.$executeRaw`
        UPDATE "rag_entity_index" SET status='READY', chunk_count=${chunks.length}, indexed_at=now(), updated_at=now()
        WHERE id=${row.id}::uuid`;

      if (row.entity_type === 'ci') ciProcessed++;
      else if (row.entity_type === 'contract') contractProcessed++;
      else if (row.entity_type === 'license') licenseProcessed++;
      else if (row.entity_type === 'vulnerability') vulnProcessed++;
    } catch (e) {
      console.error('[RAG] processRagQueue entity error:', e);
      const errMsg = String(e).slice(0, 500);
      try {
        await prisma.$executeRaw`
          UPDATE "rag_entity_index" SET status='ERROR', error_message=${errMsg}, updated_at=now()
          WHERE id=${row.id}::uuid`;
      } catch (e2) {
        console.error('[RAG] processRagQueue entity error-mark failure:', e2);
      }
      if (row.entity_type === 'ci') ciErrors++;
      else if (row.entity_type === 'contract') contractErrors++;
      else if (row.entity_type === 'license') licenseErrors++;
      else if (row.entity_type === 'vulnerability') vulnErrors++;
    }
  }

  // ── INDEX_BATCH audit row (v2.N5 / ENT-06) ─────────────────────────────────
  // Aggregates the cycle's work. Skip when nothing happened (idle ticks).
  const totalActivity =
    docsProcessed + docsErrors +
    ciProcessed + ciErrors +
    contractProcessed + contractErrors +
    licenseProcessed + licenseErrors +
    vulnProcessed + vulnErrors;

  if (totalActivity > 0) {
    try {
      await prisma.$executeRaw`
        INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, details, created_at)
        VALUES(gen_random_uuid(), 'INDEX_BATCH', 'RagEntityIndex', NULL, 'system',
          ${JSON.stringify({
            cycle_at: new Date().toISOString(),
            docs: { processed: docsProcessed, errors: docsErrors },
            ci: { processed: ciProcessed, errors: ciErrors },
            contract: { processed: contractProcessed, errors: contractErrors },
            license: { processed: licenseProcessed, errors: licenseErrors },
            vulnerability: { processed: vulnProcessed, errors: vulnErrors },
          })}::jsonb, now())`;
    } catch (e) {
      console.error('[RAG] processRagQueue audit batch error:', e);
    }
  }
}

// ─── Bulk import: AI analysis worker ──────────────────────────────────────────

// Validates the UNTRUSTED JSON the model returns. Unknown/extra keys are ignored.
const BulkAnalysisSchema = z.object({
  documentTypeGuess: z.string().max(40).nullable().optional(),
  startDate:         z.string().max(40).nullable().optional(),
  endDate:           z.string().max(40).nullable().optional(),
  vendorName:        z.string().max(255).nullable().optional(),
  entityNumber:      z.string().max(100).nullable().optional(),
  suggestedTarget:   z.enum(['contract', 'addendum', 'license', 'none']).nullable().optional(),
  ciHints:           z.array(z.string().max(255)).max(50).nullable().optional(),
});

interface NormalizedAnalysis {
  documentTypeGuess: string | null;
  startDate:         string | null;
  endDate:           string | null;
  vendorName:        string | null;
  entityNumber:      string | null;
  suggestedTarget:   'contract' | 'addendum' | 'license' | 'none';
  ciHints:           string[];
}

/** Accepts only a strict ISO calendar date (YYYY-MM-DD) that is a real date. */
function parseIsoDateSafe(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  if (isNaN(d.getTime())) return null;
  // Reject e.g. 2026-02-31 which Date silently rolls over
  if (d.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

/** Coerces the model's raw output into a safe, typed shape (never trusts it). */
function normalizeAnalysis(raw: BulkAnalysisRaw): NormalizedAnalysis {
  const parsed = BulkAnalysisSchema.safeParse(raw);
  const d = parsed.success ? parsed.data : {};
  const hints = Array.isArray(d.ciHints)
    ? d.ciHints.filter((h): h is string => typeof h === 'string' && h.trim().length > 0).map((h) => h.trim())
    : [];
  return {
    documentTypeGuess: typeof d.documentTypeGuess === 'string' ? d.documentTypeGuess.slice(0, 40) : null,
    startDate:         parseIsoDateSafe(d.startDate),
    endDate:           parseIsoDateSafe(d.endDate),
    vendorName:        typeof d.vendorName === 'string' ? (d.vendorName.trim().slice(0, 255) || null) : null,
    entityNumber:      typeof d.entityNumber === 'string' ? (d.entityNumber.trim().slice(0, 100) || null) : null,
    suggestedTarget:   d.suggestedTarget ?? 'none',
    ciHints:           hints,
  };
}

interface CiMatch { ciId: string; name: string; serial: string | null; matchType: 'serial' | 'name'; }

/**
 * Finds candidate CIs for the AI's serial/name hints. LIKE wildcards are escaped
 * and ESCAPE '\\' is used (A03). Bounded result set to avoid pathological scans.
 */
async function matchCIsForImport(hints: string[]): Promise<CiMatch[]> {
  const seen = new Set<string>();
  const out: CiMatch[] = [];
  for (const rawHint of hints.slice(0, 20)) {
    const hint = String(rawHint).trim();
    if (hint.length < 3) continue;
    const escaped = hint.replace(/[\\%_]/g, (c) => '\\' + c);
    const like = `%${escaped}%`;
    const rows = await prisma.$queryRaw<{ ciId: string; name: string; serial: string | null; matchType: string }[]>`
      SELECT ci.id::text AS "ciId", ci.name AS name, h.serial_number AS serial,
             CASE WHEN h.serial_number ILIKE ${like} ESCAPE '\\' THEN 'serial' ELSE 'name' END AS "matchType"
      FROM "configuration_items" ci
      LEFT JOIN "hardware_cis" h ON h.ci_id = ci.id
      WHERE h.serial_number ILIKE ${like} ESCAPE '\\' OR ci.name ILIKE ${like} ESCAPE '\\'
      LIMIT 5`;
    for (const r of rows) {
      if (seen.has(r.ciId)) continue;
      seen.add(r.ciId);
      out.push({ ciId: r.ciId, name: r.name, serial: r.serial, matchType: r.matchType === 'serial' ? 'serial' : 'name' });
    }
    if (out.length >= 25) break;
  }
  return out;
}

/** Recomputes a batch's aggregate status from its items. Reused on commit. */
/**
 * Batch status state machine:
 *   UPLOADED           → just created, no items processed yet
 *   ANALYZING          → at least one item still in PENDING_ANALYSIS or ANALYZING
 *   READY              → all analyzed (ANALYZED), none committed, none in error
 *   ERROR              → all processed, no items pending/committed, but some items in ERROR
 *   PARTIALLY_COMMITTED→ some committed, others still pending review or in error
 *   COMMITTED          → every item committed
 *   DISCARDED          → all items removed by user (total=0)
 *   REAPED             → set by the TTL cleanup cron (external transition, not computed here)
 */
async function recomputeBatchStatus(batchId: string): Promise<void> {
  const rows = await prisma.$queryRaw<{ total: bigint; pending: bigint; committed: bigint; errors: bigint; warnings: bigint }[]>`
    SELECT COUNT(*) AS total,
           COUNT(*) FILTER (WHERE status IN ('PENDING_ANALYSIS','ANALYZING')) AS pending,
           COUNT(*) FILTER (WHERE status = 'COMMITTED') AS committed,
           COUNT(*) FILTER (WHERE status = 'ERROR') AS errors,
           COUNT(*) FILTER (WHERE status = 'WARNING') AS warnings
    FROM "bulk_import_item" WHERE batch_id = ${batchId}::uuid`;
  const total     = Number(rows[0]?.total     ?? 0);
  const pending   = Number(rows[0]?.pending   ?? 0);
  const committed = Number(rows[0]?.committed ?? 0);
  const errors    = Number(rows[0]?.errors    ?? 0);
  const warnings  = Number(rows[0]?.warnings  ?? 0);
  let status: string;
  if (total === 0)               status = 'DISCARDED';
  else if (pending > 0)          status = 'ANALYZING';
  else if (committed === total)  status = 'COMMITTED';
  else if (committed > 0)        status = 'PARTIALLY_COMMITTED';
  else if (errors > 0 && committed === 0 && pending === 0 && warnings === 0) status = 'ERROR';
  else if (warnings > 0 && committed === 0 && pending === 0) status = 'READY_WITH_WARNINGS';
  else                           status = 'READY';
  await prisma.$executeRaw`UPDATE "bulk_import_batch" SET status = ${status}, updated_at = now() WHERE id = ${batchId}::uuid`;
}

async function recomputeCIBatchStatus(batchId: string): Promise<void> {
  const rows = await prisma.$queryRaw<{ total: bigint; pending: bigint; committed: bigint; errors: bigint }[]>`
    SELECT COUNT(*) AS total,
           COUNT(*) FILTER (WHERE status IN ('PENDING_ANALYSIS','ANALYZING')) AS pending,
           COUNT(*) FILTER (WHERE status = 'COMMITTED') AS committed,
           COUNT(*) FILTER (WHERE status = 'ERROR') AS errors
    FROM "ci_bulk_import_item" WHERE batch_id = ${batchId}::uuid`;
  const total     = Number(rows[0]?.total     ?? 0);
  const pending   = Number(rows[0]?.pending   ?? 0);
  const committed = Number(rows[0]?.committed ?? 0);
  const errors    = Number(rows[0]?.errors    ?? 0);
  let status: string;
  if (total === 0)              status = 'DISCARDED';
  else if (pending > 0)         status = 'ANALYZING';
  else if (committed === total) status = 'COMMITTED';
  else if (committed > 0)       status = 'PARTIALLY_COMMITTED';
  else if (errors > 0 && committed === 0 && pending === 0) status = 'ERROR';
  else                          status = 'READY';
  await prisma.$executeRaw`UPDATE "ci_bulk_import_batch" SET status = ${status}, updated_at = now() WHERE id = ${batchId}::uuid`;
}

/**
 * Analyzes up to BULK_ANALYZE_BUDGET staged items per tick: parses the file,
 * asks Ollama to extract structured metadata, matches CIs, and stores the
 * (validated) suggestion JSON. Runs after processRagQueue on the same cron.
 */
async function processBulkImportQueue(): Promise<void> {
  if (process.env.RAG_ENABLED !== 'true') return;
  if (!(await isOllamaHealthy())) return;

  // Safety valve: items stuck in ANALYZING longer than max expected time (OCR + Ollama + margin)
  // are reset to ERROR so they don't block the queue permanently (e.g. after a crash).
  const stuckThresholdSecs = Math.ceil((BULK_BATCH_TTL_HOURS * 3600) / 20); // never more than 1/20 of TTL
  const maxAnalysisSecs = Math.ceil((
    parseInt(process.env.OCR_DOC_TIMEOUT_MS ?? '600000', 10) +
    parseInt(process.env.RAG_CHAT_TIMEOUT_MS  ?? '180000', 10)
  ) / 1000) + 120;
  const stuckSecs = Math.min(stuckThresholdSecs, maxAnalysisSecs);
  await prisma.$executeRaw`
    UPDATE "bulk_import_item"
    SET status = 'ERROR', error_message = 'Analysis timed out (stuck in ANALYZING)',  updated_at = now()
    WHERE status = 'ANALYZING'
      AND updated_at < now() - make_interval(secs => ${stuckSecs}::int)`;

  // Serialisation guard: if any item is still ANALYZING, wait for it to finish
  // before starting new ones. Prevents concurrent OCR + Ollama calls that saturate
  // CPU and cause Ollama timeouts when processing large batches.
  const inFlight = await prisma.$queryRaw<{ c: bigint }[]>`
    SELECT COUNT(*) AS c FROM "bulk_import_item" WHERE status = 'ANALYZING'`;
  if (Number(inFlight[0]?.c ?? 0) > 0) return;

  const pending = await prisma.$queryRaw<{ id: string; batch_id: string; staged_file_name: string; mime_type: string; original_name: string }[]>`
    SELECT id::text AS id, batch_id::text AS batch_id, staged_file_name, mime_type, original_name
    FROM "bulk_import_item"
    WHERE status = 'PENDING_ANALYSIS'
    ORDER BY created_at ASC
    LIMIT 1`;

  const touchedBatches = new Set<string>();

  for (const item of pending) {
    touchedBatches.add(item.batch_id);
    try {
      await prisma.$executeRaw`UPDATE "bulk_import_item" SET status='ANALYZING', updated_at=now() WHERE id=${item.id}::uuid`;

      const filePath = path.join(STAGING_DIR, path.basename(item.staged_file_name));
      const parseResult = await parseDocument(filePath, item.mime_type, item.original_name);
      const text = parseResult.sections.map((s) => s.text).join('\n\n').trim();

      // OCR-A09-1: audit when Tesseract OCR fallback was triggered
      if (parseResult.ocrUsed) {
        await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at)
          VALUES(gen_random_uuid(),'OCR_INVOKED','Document',${item.id}::uuid,'system/cron',
          ${JSON.stringify({ itemId: item.id, fileName: item.original_name })}::jsonb,now())`.catch(() => {});
      }

      let analysis: Record<string, unknown>;
      let finalStatus: 'ANALYZED' | 'WARNING';
      if (!text) {
        // No extractable text (e.g. image, scanned PDF without readable OCR result).
        // Mark as WARNING so the UI surfaces it for manual review/classification
        // (legitimately-empty text files keep ANALYZED — they aren't a warning case).
        analysis = { textExtracted: false, ciMatches: [], analyzedAt: new Date().toISOString() };
        finalStatus = item.mime_type === 'text/plain' ? 'ANALYZED' : 'WARNING';
      } else {
        const raw = await analyzeDocumentForImport(text, { fileName: item.original_name });
        const norm = normalizeAnalysis(raw);
        const ciMatches = await matchCIsForImport(norm.ciHints);
        analysis = { ...norm, ciMatches, textExtracted: true, analyzedAt: new Date().toISOString() };
        finalStatus = 'ANALYZED';
      }

      await prisma.$executeRaw`
        UPDATE "bulk_import_item"
        SET status=${finalStatus}, analysis=${JSON.stringify(analysis)}::jsonb, error_message=NULL, updated_at=now()
        WHERE id=${item.id}::uuid`;
    } catch (e) {
      console.error('[RAG] processBulkImportQueue item error:', e);
      // OCR-A09-1: best-effort OCR_FAILED audit for PDF items that errored
      if (item.mime_type === 'application/pdf') {
        await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at)
          VALUES(gen_random_uuid(),'OCR_FAILED','Document',${item.id}::uuid,'system/cron',
          ${JSON.stringify({ itemId: item.id, fileName: item.original_name, error: String(e).slice(0, 200) })}::jsonb,now())`.catch(() => {});
      }
      const errMsg = String(e).slice(0, 500);
      try {
        await prisma.$executeRaw`
          UPDATE "bulk_import_item" SET status='ERROR', error_message=${errMsg}, updated_at=now()
          WHERE id=${item.id}::uuid`;
      } catch (e2) {
        console.error('[RAG] processBulkImportQueue error-mark failure:', e2);
      }
    }
  }

  for (const batchId of touchedBatches) {
    try { await recomputeBatchStatus(batchId); }
    catch (e) { console.error('[RAG] processBulkImportQueue batch-status error:', e); }
  }
}

/**
 * CI bulk analysis concurrency (Task B / v2.5.1).
 * Default 3 workers: CI analysis is cheap (no OCR) so we can saturate Ollama
 * with a few parallel calls. Clamped to [1, 5] to avoid DoS on small hardware.
 */
const _rawCiConcurrency = parseInt(process.env.CI_BULK_CONCURRENCY ?? '3', 10);
const CI_BULK_CONCURRENCY = (!isNaN(_rawCiConcurrency) && _rawCiConcurrency >= 1 && _rawCiConcurrency <= 5)
  ? _rawCiConcurrency
  : 3;

/**
 * Runs an array of async task factories with a maximum concurrency.
 * When a task finishes, the next one starts immediately (not in batches).
 * Errors do not stop the pool — each task captures its own rejection.
 */
async function withConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<Array<{ ok: true; value: T } | { ok: false; error: unknown }>> {
  const results: Array<{ ok: true; value: T } | { ok: false; error: unknown }> = new Array(tasks.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= tasks.length) return;
      try {
        results[idx] = { ok: true, value: await tasks[idx]() };
      } catch (error) {
        results[idx] = { ok: false, error };
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Processes pending CI staging rows per cron tick with bounded concurrency.
 * Calls Ollama to normalize field values, runs DB conflict detection,
 * and stores the combined analysis JSON on each item.
 *
 * Concurrency model: up to CI_BULK_CONCURRENCY items processed in parallel,
 * each new item starting as soon as a slot frees (not in batches).
 */
async function processCIBulkImportQueue(): Promise<void> {
  if (process.env.RAG_ENABLED !== 'true') return;
  if (!(await isOllamaHealthy())) return;

  // Safety valve: reset stuck ANALYZING items (mirrors document bulk worker)
  const maxCISecs = Math.ceil((
    parseInt(process.env.RAG_CHAT_TIMEOUT_MS ?? '180000', 10)
  ) / 1000) + 120;
  await prisma.$executeRaw`
    UPDATE "ci_bulk_import_item"
    SET status = 'ERROR', error_message = 'Analysis timed out (stuck in ANALYZING)', updated_at = now()
    WHERE status = 'ANALYZING'
      AND updated_at < now() - make_interval(secs => ${maxCISecs}::int)`;

  // Concurrency guard: skip if we already have CI_BULK_CONCURRENCY items in flight
  const inFlight = await prisma.$queryRaw<{ c: bigint }[]>`
    SELECT COUNT(*) AS c FROM "ci_bulk_import_item" WHERE status = 'ANALYZING'`;
  const inFlightCount = Number(inFlight[0]?.c ?? 0);
  if (inFlightCount >= CI_BULK_CONCURRENCY) return;

  // Fetch up to (3 × concurrency) pending items so a single tick can drain
  // a small batch even if the worker pool is already partially busy.
  const available = CI_BULK_CONCURRENCY - inFlightCount;
  const fetchLimit = CI_BULK_CONCURRENCY * 3;
  const pending = await prisma.$queryRaw<{ id: string; batch_id: string; raw_data: unknown }[]>`
    SELECT id::text AS id, batch_id::text AS batch_id, raw_data
    FROM "ci_bulk_import_item"
    WHERE status = 'PENDING_ANALYSIS'
    ORDER BY created_at ASC
    LIMIT ${fetchLimit}::int`;

  if (pending.length === 0) return;

  const touchedBatches = new Set<string>();

  const analyzeOne = async (item: { id: string; batch_id: string; raw_data: unknown }) => {
    touchedBatches.add(item.batch_id);
    try {
      // Atomically claim the row — if a concurrent tick already grabbed it the
      // UPDATE affects 0 rows and we skip silently to avoid duplicate work.
      const claimed = await prisma.$executeRaw`
        UPDATE "ci_bulk_import_item" SET status='ANALYZING', updated_at=now()
        WHERE id=${item.id}::uuid AND status='PENDING_ANALYSIS'`;
      if (Number(claimed) === 0) return;

      const raw = (item.raw_data ?? {}) as CIRowRaw;

      // Conflict detection: existing CIs by name, serialNumber, inventoryNumber
      const conflicts: { field: string; existingId: string; existingName: string }[] = [];
      const name = (raw['name'] ?? '').trim();
      if (name) {
        const ms = await prisma.$queryRaw<{ id: string; name: string }[]>`
          SELECT id::text AS id, name FROM "configuration_items" WHERE LOWER(name) = LOWER(${name}) LIMIT 3`;
        for (const m of ms) conflicts.push({ field: 'name', existingId: m.id, existingName: m.name });
      }
      const serial = (raw['serialNumber'] ?? '').trim();
      if (serial) {
        const ms = await prisma.$queryRaw<{ id: string; name: string }[]>`
          SELECT ci.id::text AS id, ci.name FROM "configuration_items" ci
          JOIN "hardware_cis" hw ON hw.ci_id = ci.id
          WHERE LOWER(hw.serial_number) = LOWER(${serial}) LIMIT 3`;
        for (const m of ms) { if (!conflicts.find(c => c.existingId === m.id)) conflicts.push({ field: 'serialNumber', existingId: m.id, existingName: m.name }); }
      }
      const inv = (raw['inventoryNumber'] ?? '').trim();
      if (inv) {
        const ms = await prisma.$queryRaw<{ id: string; name: string }[]>`
          SELECT id::text AS id, name FROM "configuration_items" WHERE LOWER(inventory_number) = LOWER(${inv}) LIMIT 3`;
        for (const m of ms) { if (!conflicts.find(c => c.existingId === m.id)) conflicts.push({ field: 'inventoryNumber', existingId: m.id, existingName: m.name }); }
      }

      // AI normalization (graceful: falls back to raw if Ollama unavailable)
      const normalized = await analyzeCIRowForImport(raw);

      const analysis = { normalized, conflicts, analyzedAt: new Date().toISOString() };

      await prisma.$executeRaw`
        UPDATE "ci_bulk_import_item"
        SET status='ANALYZED', analysis=${JSON.stringify(analysis)}::jsonb, error_message=NULL, updated_at=now()
        WHERE id=${item.id}::uuid`;
    } catch (e) {
      console.error('[CI-Bulk] processCIBulkImportQueue item error:', e);
      const errMsg = String(e).slice(0, 500);
      try {
        await prisma.$executeRaw`
          UPDATE "ci_bulk_import_item" SET status='ERROR', error_message=${errMsg}, updated_at=now()
          WHERE id=${item.id}::uuid`;
      } catch (e2) { console.error('[CI-Bulk] processCIBulkImportQueue error-mark failure:', e2); }
    }
  };

  // Process with bounded concurrency: at most `available` slots in this tick.
  // (If others are mid-flight we don't exceed CI_BULK_CONCURRENCY globally.)
  const tasks = pending.map((item) => () => analyzeOne(item));
  await withConcurrency(tasks, Math.max(1, available));

  for (const batchId of touchedBatches) {
    try { await recomputeCIBatchStatus(batchId); }
    catch (e) { console.error('[CI-Bulk] processCIBulkImportQueue batch-status error:', e); }
  }
}

// ─── Bulk import: commit (materialization) ────────────────────────────────────

/** Thrown for caller-correctable problems (returned as 400 with the message). */
class BulkValidationError extends Error {}

// The user's reviewed decision for one staged item. `target` drives which real
// entity (if any) is created alongside the Document.
const BulkItemDecisionBase = z.object({
  target:           z.enum(['contract', 'addendum', 'license', 'none']),
  documentTypeId:   z.string().uuid(),
  title:            z.string().min(1).max(500),
  description:      z.string().max(2000).nullable().optional(),
  startDate:        z.string().max(40).nullable().optional(),
  endDate:          z.string().max(40).nullable().optional(),
  vendorId:         z.string().uuid().nullable().optional(),
  entityNumber:     z.string().min(1).max(100).nullable().optional(),
  parentContractId: z.string().uuid().nullable().optional(),
  licenseName:      z.string().min(1).max(255).nullable().optional(),
  ciIds:            z.array(z.string().uuid()).max(100).optional(),
});

const BulkItemDecisionSchema = BulkItemDecisionBase.superRefine((d, ctx) => {
  const reqDate = /^\d{4}-\d{2}-\d{2}/;
  if (d.target === 'contract' || d.target === 'addendum') {
    if (!d.entityNumber) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Número de contrato requerido', path: ['entityNumber'] });
    if (!d.vendorId)     ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Proveedor requerido', path: ['vendorId'] });
    if (!d.startDate)    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Fecha de inicio requerida', path: ['startDate'] });
    if (d.target === 'addendum' && !d.parentContractId) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Contrato padre requerido para una adenda', path: ['parentContractId'] });
  }
  if (d.target === 'license') {
    if (!d.entityNumber) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Número de licencia requerido', path: ['entityNumber'] });
    if (!d.licenseName)  ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Nombre de licencia requerido', path: ['licenseName'] });
    if (!d.startDate)    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Fecha de inicio requerida', path: ['startDate'] });
  }
  for (const f of ['startDate', 'endDate'] as const) {
    const v = d[f];
    if (v && !reqDate.test(v)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Formato de fecha inválido en ${f}`, path: [f] });
  }
});
type BulkItemDecision = z.infer<typeof BulkItemDecisionSchema>;

// ── CI Bulk — decision schema (what the user submits to commit one row) ────────
const CIBulkDecisionSchema = z.object({
  name:               z.string().min(1).max(255),
  ciType:             z.string().min(1).max(50),
  criticality:        z.enum(['LOW', 'MEDIUM', 'HIGH', 'MISSION_CRITICAL']),
  environment:        z.enum(['DEVELOPMENT', 'TESTING', 'STAGING', 'PRODUCTION']),
  status:             z.enum(['ACTIVO', 'INACTIVO', 'RETIRADO']).optional(),
  inventoryNumber:    z.string().max(100).nullable().optional(),
  manufacturer:       z.string().max(255).nullable().optional(),
  serialNumber:       z.string().max(255).nullable().optional(),
  model:              z.string().max(255).nullable().optional(),
  branch:             z.string().max(255).nullable().optional(),
  costCenter:         z.string().max(255).nullable().optional(),
  version:            z.string().max(255).nullable().optional(),
  licenseType:        z.string().max(255).nullable().optional(),
  eolDate:            z.string().max(20).nullable().optional(),
  eosDate:            z.string().max(20).nullable().optional(),
  businessImpact:     z.enum(['LOW','MEDIUM','HIGH','CRITICAL']).nullable().optional(),
  dataClassification: z.enum(['PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED']).nullable().optional(),
  assignedUser:       z.string().max(255).nullable().optional(),
  ipAddress:          z.string().max(50).nullable().optional(),
  description:        z.string().max(2000).nullable().optional(),
  forceCreate:        z.boolean().optional(),
});
type CIBulkDecision = z.infer<typeof CIBulkDecisionSchema>;

interface BulkItemRow {
  id: string; batch_id: string; staged_file_name: string;
  original_name: string; mime_type: string; file_size: number; status: string;
}

/**
 * Materializes one staged item into a real Document (+ optional Contract /
 * Addendum / License) and associations, in a single transaction. The file is
 * copied to the documents store first and only deleted from staging on success;
 * on failure the destination copy is removed so nothing is orphaned.
 */
async function materializeBulkItem(
  item: BulkItemRow,
  decision: BulkItemDecision,
  userEmail: string,
): Promise<{ documentId: string; contractId?: string; licenseId?: string }> {
  if (item.status === 'COMMITTED') throw new BulkValidationError('El elemento ya fue confirmado');

  // ── Existence checks (clean errors instead of raw FK violations) ───────────
  const dtype = await prisma.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM "document_types" WHERE id=${decision.documentTypeId}::uuid LIMIT 1`;
  if (!dtype.length) throw new BulkValidationError('Tipo de documento no encontrado');

  if (decision.vendorId) {
    const v = await prisma.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM "vendors" WHERE id=${decision.vendorId}::uuid LIMIT 1`;
    if (!v.length) throw new BulkValidationError('Proveedor no encontrado');
  }
  if (decision.target === 'addendum' && decision.parentContractId) {
    const p = await prisma.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM "contracts" WHERE id=${decision.parentContractId}::uuid LIMIT 1`;
    if (!p.length) throw new BulkValidationError('Contrato padre no encontrado');
  }
  if (decision.ciIds && decision.ciIds.length > 0) {
    const found = await prisma.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*) AS c FROM "configuration_items" WHERE id IN (${Prisma.join(decision.ciIds.map((id) => Prisma.sql`${id}::uuid`))})`;
    if (Number(found[0]?.c ?? 0) !== decision.ciIds.length) throw new BulkValidationError('Uno o más CIs no existen');
  }

  // ── Copy staged → final store (keep staging copy until DB commit succeeds) ──
  const ext = (path.extname(item.staged_file_name).replace('.', '') || path.extname(item.original_name).replace('.', '')).toLowerCase();
  const finalName = `${crypto.randomUUID()}.${ext}`;
  const stagedPath = path.join(STAGING_DIR, path.basename(item.staged_file_name));
  const finalPath  = path.join(DOCUMENTS_DIR, finalName);
  if (!fs.existsSync(stagedPath)) throw new BulkValidationError('El fichero en staging ya no existe');

  // Re-validate magic bytes at commit time (BULK-A08-2): the staged file could have
  // been tampered with between upload and commit, or the upload-time check bypassed.
  const headerBuf = Buffer.alloc(16);
  const fd = fs.openSync(stagedPath, 'r');
  fs.readSync(fd, headerBuf, 0, 16, 0);
  fs.closeSync(fd);
  if (!validateMagicBytes(headerBuf, ext)) {
    throw new BulkValidationError('El fichero en staging no supera la validación de tipo (magic bytes)');
  }

  fs.copyFileSync(stagedPath, finalPath);

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Atomically CLAIM the row first: a concurrent/retried commit blocks on this
      // row lock, then sees status='COMMITTED' and affects 0 rows → we abort. This
      // closes the TOCTOU between the pre-transaction status snapshot and the flip,
      // preventing duplicate Document/Contract/License rows + orphaned files.
      const claimed = await tx.$executeRaw`
        UPDATE "bulk_import_item" SET status='COMMITTED', error_message=NULL, updated_at=now()
        WHERE id=${item.id}::uuid AND status <> 'COMMITTED'`;
      if (Number(claimed) === 0) throw new BulkValidationError('El elemento ya fue confirmado');

      const docRows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "documents"(id,title,description,document_type_id,root_id,version_number,is_latest,file_name,original_name,mime_type,file_size,uploaded_by,created_at,updated_at)
        VALUES(gen_random_uuid(), ${decision.title.trim()}, ${decision.description?.trim() || null}, ${decision.documentTypeId}::uuid, NULL, 1, true, ${finalName}, ${item.original_name}, ${item.mime_type}, ${item.file_size}, ${userEmail}, now(), now())
        RETURNING id::text AS id`;
      const documentId = docRows[0].id;
      await tx.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CREATE','Document',${documentId},${userEmail},now())`;

      let contractId: string | undefined;
      let licenseId: string | undefined;

      if (decision.target === 'contract' || decision.target === 'addendum') {
        const contract = await tx.contract.create({
          data: {
            contractNumber:   decision.entityNumber!,
            startDate:        new Date(decision.startDate!),
            endDate:          decision.endDate ? new Date(decision.endDate) : null,
            vendorId:         decision.vendorId!,
            parentContractId: decision.target === 'addendum' ? decision.parentContractId! : null,
            ...(decision.ciIds && decision.ciIds.length > 0 && { cis: { connect: decision.ciIds.map((id) => ({ id })) } }),
          },
        });
        contractId = contract.id;
        await tx.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CREATE','Contract',${contractId}::uuid,${userEmail},now())`;
        await tx.$executeRaw`INSERT INTO "document_contracts"(id,document_id,contract_id) VALUES(gen_random_uuid(),${documentId}::uuid,${contractId}::uuid) ON CONFLICT DO NOTHING`;
      } else if (decision.target === 'license') {
        const license = await tx.license.create({
          data: {
            name:          decision.licenseName!,
            licenseNumber: decision.entityNumber!,
            vendorId:      decision.vendorId ?? null,
            startDate:     new Date(decision.startDate!),
            endDate:       decision.endDate ? new Date(decision.endDate) : null,
            ...(decision.ciIds && decision.ciIds.length > 0 && { cis: { connect: decision.ciIds.map((id) => ({ id })) } }),
          },
        });
        licenseId = license.id;
        await tx.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CREATE','License',${licenseId}::uuid,${userEmail},now())`;
        await tx.$executeRaw`INSERT INTO "document_licenses"(id,document_id,license_id) VALUES(gen_random_uuid(),${documentId}::uuid,${licenseId}::uuid) ON CONFLICT DO NOTHING`;
      }

      // Associate selected CIs with the Document itself (independent of entity links)
      for (const ciId of decision.ciIds ?? []) {
        await tx.$executeRaw`INSERT INTO "document_cis"(id,document_id,ci_id) VALUES(gen_random_uuid(),${documentId}::uuid,${ciId}::uuid) ON CONFLICT DO NOTHING`;
      }

      // Status already set to COMMITTED by the claim above; just record the link.
      await tx.$executeRaw`UPDATE "bulk_import_item" SET committed_document_id=${documentId}::uuid, updated_at=now() WHERE id=${item.id}::uuid`;

      return { documentId, contractId, licenseId };
    });

    // Success: drop the staging copy and queue async indexing.
    try { fs.unlinkSync(stagedPath); } catch {}
    void queueDocumentForIndexing(result.documentId, 1);
    if (result.contractId) { try { void queueEntityForIndexing('contract', await getContractRoot(result.contractId)); } catch {} }
    if (result.licenseId)  { try { void queueEntityForIndexing('license',  await getLicenseRoot(result.licenseId));   } catch {} }
    return result;
  } catch (e) {
    try { fs.unlinkSync(finalPath); } catch {}
    // Surface duplicate contract/license number as a clean message
    if (typeof e === 'object' && e !== null && 'code' in e && (e as { code: string }).code === 'P2002') {
      throw new BulkValidationError('Ya existe un contrato o licencia con ese número');
    }
    throw e;
  }
}

// ─── CI Bulk import: commit (materialization) ─────────────────────────────────

class CIBulkValidationError extends Error {}

function safeParseDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

async function materializeCIBulkItem(
  item: { id: string; batch_id: string; status: string },
  decision: CIBulkDecision,
  userEmail: string,
): Promise<{ ciId: string }> {
  if (item.status === 'COMMITTED') throw new CIBulkValidationError('El elemento ya fue confirmado');

  // Name conflict check (skip if forceCreate)
  if (!decision.forceCreate) {
    const existing = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM "configuration_items" WHERE LOWER(name) = LOWER(${decision.name}) LIMIT 1`;
    if (existing.length) throw new CIBulkValidationError(`Ya existe un CI con el nombre "${decision.name}"`);
  }

  // Resolve ciType → id
  const allTypes = await prisma.cIType.findMany({ select: { id: true, code: true } });
  const ciTypeMap = new Map(allTypes.map(t => [t.code, t.id]));
  const ciTypeId = ciTypeMap.get(decision.ciType.toUpperCase()) ?? ciTypeMap.get('OTHER') ?? null;

  // Resolve branch / cost center by name
  let branchId: string | null = null;
  if (decision.branch) {
    const b = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM "branches" WHERE LOWER(name) = LOWER(${decision.branch}) LIMIT 1`;
    branchId = b[0]?.id ?? null;
  }
  let costCenterId: string | null = null;
  if (decision.costCenter) {
    const c = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM "cost_centers" WHERE LOWER(name) = LOWER(${decision.costCenter}) LIMIT 1`;
    costCenterId = c[0]?.id ?? null;
  }

  const hwTypes = [
    'PHYSICAL_SERVER','VIRTUAL_SERVER','NETWORK','NETWORK_EQUIPMENT','STORAGE','BACKUP',
    'HARDWARE','DESKTOP','LAPTOP','PRINTER','SCANNER','MONITOR','VIDEOCONFERENCE','SMART_DISPLAY',
    'TIME_CLOCK','IP_PHONE','SMARTPHONE','TABLET','PDA','BARCODE_SCANNER','IP_CAMERA','UPS',
    'WIFI_AP','CLOUD_INSTANCE','CLOUD_STORAGE',
  ];
  const swTypes = ['SOFTWARE','DATABASE','BASE_SOFTWARE','LICENSE','APPLICATION'];
  const ciTypeCode = decision.ciType.toUpperCase();
  const needsHw = hwTypes.includes(ciTypeCode);
  const needsSw = swTypes.includes(ciTypeCode);

  const slug    = decision.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 40);
  const apiSlug = `${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
  const status  = (['ACTIVO','INACTIVO','RETIRADO'].includes(decision.status ?? '') ? decision.status : 'ACTIVO') as string;

  const ci = await prisma.$transaction(async (tx) => {
    // Claim: prevent double-commit (TOCTOU guard)
    const claimed = await tx.$executeRaw`
      UPDATE "ci_bulk_import_item" SET status='COMMITTING', updated_at=now()
      WHERE id=${item.id}::uuid AND status <> 'COMMITTED'`;
    if (Number(claimed) === 0) throw new CIBulkValidationError('El elemento ya fue confirmado');

    // K1: upsert master records for manufacturer + device model so they appear
    // in the Datos Maestros UI and in future "create CI" dropdowns. Without
    // this, manufacturer/model only lived as free-text strings on HardwareCI.
    // Pattern: INSERT … ON CONFLICT DO NOTHING (atomic, safe for concurrent workers).
    let ciModelId: string | null = null;
    let resolvedMfrId: string | null = null;
    if (needsHw && decision.manufacturer?.trim()) {
      const mfrName = decision.manufacturer.trim();
      // Atomic upsert: INSERT first; on conflict (unique name) DO NOTHING then re-SELECT.
      // Prevents 23505 unique_violation when concurrent bulk workers insert the same new manufacturer.
      const insertedMfr = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "manufacturers"(id, name, created_at, updated_at)
        VALUES (gen_random_uuid(), ${mfrName}, now(), now())
        ON CONFLICT (name) DO NOTHING
        RETURNING id::text AS id`;
      let mfrId: string;
      if (insertedMfr.length > 0) {
        mfrId = insertedMfr[0].id;
        await tx.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at) VALUES(gen_random_uuid(),'CREATE_MASTER','Manufacturer',${mfrId}::uuid,${userEmail},${JSON.stringify({ name: mfrName, source: 'ci-bulk-import' })}::jsonb,now())`;
      } else {
        const existing = await tx.$queryRaw<{ id: string }[]>`
          SELECT id::text AS id FROM "manufacturers" WHERE LOWER(name) = LOWER(${mfrName}) LIMIT 1`;
        mfrId = existing[0].id;
      }
      resolvedMfrId = mfrId;

      if (decision.model?.trim()) {
        const modelName = decision.model.trim();
        // Atomic upsert: relies on device_models_name_mfr_key UNIQUE INDEX (migration 20260603100000).
        const insertedModel = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO "device_models"(id, name, manufacturer_id, created_at, updated_at)
          VALUES (gen_random_uuid(), ${modelName}, ${mfrId}::uuid, now(), now())
          ON CONFLICT (lower(name), manufacturer_id) DO NOTHING
          RETURNING id::text AS id`;
        if (insertedModel.length > 0) {
          ciModelId = insertedModel[0].id;
          await tx.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at) VALUES(gen_random_uuid(),'CREATE_MASTER','DeviceModel',${ciModelId}::uuid,${userEmail},${JSON.stringify({ name: modelName, manufacturerId: mfrId, source: 'ci-bulk-import' })}::jsonb,now())`;
        } else {
          const existingModel = await tx.$queryRaw<{ id: string }[]>`
            SELECT id::text AS id FROM "device_models"
            WHERE LOWER(name) = LOWER(${modelName}) AND manufacturer_id = ${mfrId}::uuid LIMIT 1`;
          ciModelId = existingModel[0].id;
        }
      }
    }

    const newCi = await tx.cI.create({
      data: {
        name:               decision.name,
        apiSlug,
        criticality:        decision.criticality as Criticality,
        environment:        decision.environment as Environment,
        status,
        ciTypeId,
        branchId,
        costCenterId,
        ciModelId,
        inventoryNumber:    decision.inventoryNumber   || null,
        assignedUser:       decision.assignedUser      || null,
        businessImpact:     (decision.businessImpact   || null) as string | null,
        dataClassification: (decision.dataClassification || null) as string | null,
        // ipAddress lives on CI.consoleIp in the schema (HardwareCI has no ipAddress field)
        consoleIp:          decision.ipAddress         || null,
        ...(needsHw && {
          hardware: {
            create: {
              serialNumber: decision.serialNumber || `AUTO-${Date.now()}`,
              model:        decision.model        || 'Unknown',
              manufacturer: decision.manufacturer || 'Unknown',
            },
          },
        }),
        ...(needsSw && {
          software: {
            create: {
              version:     decision.version     || '1.0',
              licenseType: decision.licenseType || '',
              eolDate:     safeParseDate(decision.eolDate),
              eosDate:     safeParseDate(decision.eosDate),
            },
          },
        }),
      } as Parameters<typeof tx.cI.create>[0]['data'],
    });

    await tx.$executeRaw`
      UPDATE "ci_bulk_import_item"
      SET status='COMMITTED', committed_ci_id=${newCi.id}::uuid, updated_at=now()
      WHERE id=${item.id}::uuid`;

    await tx.$executeRaw`
      INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, details, created_at)
      VALUES(gen_random_uuid(), 'CI_BULK_COMMIT', 'CI', ${newCi.id}::uuid, ${userEmail},
             ${JSON.stringify({ batchItemId: item.id, ciName: newCi.name, manufacturerId: resolvedMfrId, ciModelId })}::jsonb, now())`;

    return newCi;
  });

  void queueEntityForIndexing('ci', ci.id);
  return { ciId: ci.id };
}

/**
 * Retrieves the top-K most similar chunks for a query, filtered by the user's role ACL.
 *
 * Security: the ACL filter (read_admin/auditor/viewer) is applied BEFORE the kNN
 * search in the same SQL statement — chunks from non-readable documents never
 * leave the database. This prevents data leakage and embedding-membership inference.
 *
 * @param query  - User question (sanitized internally before embedding)
 * @param role   - 'ADMIN' | 'AUDITOR' | 'VIEWER'
 * @param topK   - Number of chunks to return (default 6)
 */
async function ragSearchChunks(
  query: string,
  role: string,
  topK = 6,
  entityTypes?: string[],
): Promise<RagChunkResult[]> {
  const cleanQuery = sanitizeQuery(query);
  const { embedding } = await getEmbedding(cleanQuery);
  const embeddingStr = `[${embedding.join(',')}]`;

  // Allowlisted column name from docVisibilitySqlCol — safe with Prisma.raw()
  const visCol = Prisma.raw(`"${docVisibilitySqlCol(role)}"`);

  // Validate entityTypes against the fixed allowlist.
  // Unknown values are silently dropped (per spec). Empty / undefined → no filter.
  const ALLOWED_ENTITY_TYPES = ['document', 'ci', 'contract', 'license', 'vulnerability'] as const;
  const filteredEntityTypes = Array.isArray(entityTypes)
    ? entityTypes.filter((t): t is (typeof ALLOWED_ENTITY_TYPES)[number] =>
        (ALLOWED_ENTITY_TYPES as readonly string[]).includes(t),
      )
    : [];

  // Relational expansion: when the caller filters by 'contract' or 'license', also pull
  // in chunks from documents and CIs that are associated with those entities via the
  // explicit join tables (document_contracts / _ContractToCI, document_licenses / _LicenseToCI).
  // The document ACL (visCol + is_latest) is enforced for every document reached this way.
  const expandContracts = filteredEntityTypes.includes('contract');
  const expandLicenses  = filteredEntityTypes.includes('license');

  // Pass null when no filter is desired so the SQL `IS NULL` branch matches all rows.
  // Prisma binds JS arrays of strings to Postgres text[] when the SQL casts via ::text[].
  const entityTypesParam: string[] | null =
    filteredEntityTypes.length > 0 ? filteredEntityTypes : null;

  const rows = await prisma.$queryRaw<{
    id: string;
    entity_type: string;
    entity_id: string;
    document_id: string | null;
    title: string | null;
    version_number: number | null;
    section_path: string | null;
    page_start: number | null;
    content: string;
    score: number;
  }[]>`
    SELECT
      c.id::text                   AS id,
      c.entity_type                AS entity_type,
      c.entity_id::text            AS entity_id,
      c.document_id::text          AS document_id,
      COALESCE(d.title, c.metadata->>'title') AS title,
      c.version_number             AS version_number,
      c.section_path               AS section_path,
      c.page_start                 AS page_start,
      c.content                    AS content,
      1 - (c.embedding <=> ${embeddingStr}::vector) AS score
    FROM "rag_chunks" c
    LEFT JOIN "documents" d
      ON c.entity_type = 'document' AND d.id = c.document_id
    LEFT JOIN "documents" root
      ON c.entity_type = 'document' AND root.id = COALESCE(d.root_id, d.id)
    WHERE (
        -- Direct entity chunks (ci / contract / license / vulnerability)
        (c.entity_type IN ('ci','contract','license','vulnerability'))
        OR
        -- Document chunks: standard ACL filter
        (c.entity_type = 'document' AND root.${visCol} = true AND d.is_latest = true)
        OR
        -- Relational expansion: documents linked to a contract in the filter
        (${expandContracts} AND c.entity_type = 'document' AND d.is_latest = true AND root.${visCol} = true
          AND c.document_id IN (
            SELECT dc.document_id FROM "document_contracts" dc
            JOIN "rag_entity_index" rei ON rei.entity_type = 'contract' AND rei.entity_id = dc.contract_id
          )
        )
        OR
        -- Relational expansion: CIs linked to a contract in the filter
        (${expandContracts} AND c.entity_type = 'ci'
          AND c.entity_id IN (
            SELECT ctc."A" FROM "_ContractToCI" ctc
            JOIN "rag_entity_index" rei ON rei.entity_type = 'contract' AND rei.entity_id = ctc."B"
          )
        )
        OR
        -- Relational expansion: documents linked to a license in the filter
        (${expandLicenses} AND c.entity_type = 'document' AND d.is_latest = true AND root.${visCol} = true
          AND c.document_id IN (
            SELECT dl.document_id FROM "document_licenses" dl
            JOIN "rag_entity_index" rei ON rei.entity_type = 'license' AND rei.entity_id = dl.license_id
          )
        )
        OR
        -- Relational expansion: CIs linked to a license in the filter
        (${expandLicenses} AND c.entity_type = 'ci'
          AND c.entity_id IN (
            SELECT ltc."A" FROM "_LicenseToCI" ltc
            JOIN "rag_entity_index" rei ON rei.entity_type = 'license' AND rei.entity_id = ltc."B"
          )
        )
      )
      AND (
        ${entityTypesParam}::text[] IS NULL
        -- When a relational expansion is active, also allow the related entity types
        -- (document / ci) even if they are not explicitly in the filter array.
        OR c.entity_type = ANY(${entityTypesParam}::text[])
        OR (${expandContracts} AND c.entity_type IN ('document','ci'))
        OR (${expandLicenses}  AND c.entity_type IN ('document','ci'))
      )
    ORDER BY c.embedding <=> ${embeddingStr}::vector
    LIMIT ${topK}`;

  return rows.map((r) => ({
    id:             r.id,
    entityType:     r.entity_type as RagChunkResult['entityType'],
    entityId:       r.entity_id,
    documentId:     r.entity_type === 'document' ? (r.document_id ?? undefined) : undefined,
    documentTitle:  r.title ?? '(sin título)',
    versionNumber:  r.entity_type === 'document' ? (r.version_number ?? undefined) : undefined,
    sectionPath:    r.section_path ?? undefined,
    pageStart:      r.page_start   ?? undefined,
    content:        r.content,
    score:          r.score,
  }));
}

/**
 * Audit-logs an ASK_RAG event. Stores only a SHA-256 hash of the query (no PII).
 * Details include sessionId, citation count, and model used.
 */
async function logAskRag(opts: {
  userEmail: string;
  sessionId: string;
  query: string;
  citationCount: number;
  modelUsed: string;
  latencyMs: number;
}): Promise<void> {
  try {
    const queryHash = crypto.createHash('sha256').update(opts.query).digest('hex');
    const details = JSON.stringify({
      queryHash,
      citationCount: opts.citationCount,
      modelUsed:     opts.modelUsed,
      latencyMs:     opts.latencyMs,
    });
    await prisma.$executeRaw`
      INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, details, created_at)
      VALUES(gen_random_uuid(), 'ASK_RAG', 'RagChatSession', ${opts.sessionId}::uuid, ${opts.userEmail}, ${details}, now())`;
  } catch (e) {
    console.error('[RAG] logAskRag error:', e);
  }
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

// Multer for bulk upload: same per-file guards, plus a per-batch file-count cap.
const bulkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: BULK_MAX_FILES },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
    if (ALLOWED_EXTENSIONS.has(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Tipo de archivo no permitido: .${ext}`));
    }
  },
});

/** Runs the bulk multer middleware and converts its errors into clean 400s. */
function bulkUploadMiddleware(req: Request, res: Response, next: NextFunction): void {
  bulkUpload.array('files', BULK_MAX_FILES)(req, res, (err: unknown) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          res.status(400).json({ error: `Cada fichero debe ser ≤ ${MAX_DOCUMENT_SIZE_MB} MB` }); return;
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          res.status(400).json({ error: `Máximo ${BULK_MAX_FILES} ficheros por lote` }); return;
        }
        res.status(400).json({ error: 'Error al procesar la subida' }); return;
      }
      res.status(400).json({ error: (err as Error).message || 'Tipo de archivo no permitido' }); return;
    }
    next();
  });
}

// Multer for CI bulk XLSX upload: single file, 10 MB, .xlsx only
const ciXlsxUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, cb) {
    if (path.extname(file.originalname).toLowerCase() === '.xlsx') { cb(null, true); }
    else { cb(new Error('Solo se permiten ficheros .xlsx')); }
  },
});
function ciXlsxUploadMiddleware(req: Request, res: Response, next: NextFunction): void {
  ciXlsxUpload.single('file')(req, res, (err: unknown) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        res.status(400).json({ error: 'El fichero XLSX no puede superar 10 MB' }); return;
      }
      res.status(400).json({ error: (err as Error).message || 'Error al subir el fichero' }); return;
    }
    next();
  });
}

// ── Document Types master ─────────────────────────────────────────────────────

app.get('/api/masters/document-types', authenticateToken, async (_req, res) => {
  try {
    const rows = await prisma.$queryRaw<{ id: string; code: string; name: string; isSystem: boolean }[]>`
      SELECT id::text AS id, code, name, is_system AS "isSystem"
      FROM "document_types" ORDER BY name ASC`;
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

app.post('/api/masters/document-types', authenticateToken, requireAdmin, async (req, res) => {
  const { code, name } = req.body as { code?: string; name?: string };
  if (!code?.trim() || !name?.trim()) { res.status(400).json({ error: 'code and name required' }); return; }
  try {
    const rows = await prisma.$queryRaw<{ id: string; code: string; name: string }[]>`
      INSERT INTO "document_types"(id,code,name,is_system,created_at,updated_at)
      VALUES(gen_random_uuid(),${code.trim().toUpperCase()},${name.trim()},false,now(),now())
      RETURNING id::text AS id, code, name`;
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CREATE_MASTER','DocumentType',${rows[0].id}::uuid,${req.user!.email},now())`;
    res.status(201).json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
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
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'UPDATE_MASTER','DocumentType',${rows[0].id}::uuid,${req.user!.email},now())`;
    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

app.delete('/api/masters/document-types/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await prisma.$executeRaw`
      DELETE FROM "document_types" WHERE id=${req.params.id}::uuid AND is_system=false`;
    if (Number(result) === 0) { res.status(404).json({ error: 'Not found or system type' }); return; }
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'DELETE_MASTER','DocumentType',${req.params.id}::uuid,${req.user!.email},now())`;
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
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
  const visCol = Prisma.raw(`"${docVisibilitySqlCol(req.user!.role)}"`);
  try {
    const [countRows, rows] = await Promise.all([
      prisma.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*) AS c FROM "documents" WHERE root_id IS NULL AND ${visCol} = true`,
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
        WHERE d.root_id IS NULL AND d.${visCol} = true
        ORDER BY d.created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
    ]);
    res.json({ total: Number(countRows[0]?.c ?? 0), page, limit, data: rows });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/documents/:id — document detail with versions, relations, associations
app.get('/api/documents/:id', authenticateToken, async (req, res) => {
  const visCol = Prisma.raw(`"${docVisibilitySqlCol(req.user!.role)}"`);
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
      JOIN "documents" root ON root.id = COALESCE(d.root_id, d.id)
      WHERE d.id = ${req.params.id}::uuid AND root.${visCol} = true`;
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
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
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

    void queueDocumentForIndexing(docId, 1);
    res.status(201).json({ id: docId });
  } catch (e) {
    // Clean up uploaded file on DB error
    try { fs.unlinkSync(filePath); } catch {}
    console.error(e);
    res.status(500).json({ error: 'Internal server error' });
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
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// PATCH /api/documents/:id/acl — update role-based visibility flags (ADMIN only)
app.patch('/api/documents/:id/acl', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  const { readAdmin, readAuditor, readViewer } = req.body as { readAdmin?: boolean; readAuditor?: boolean; readViewer?: boolean };
  if (readAdmin === undefined && readAuditor === undefined && readViewer === undefined) {
    res.status(400).json({ error: 'At least one ACL field required' }); return;
  }
  for (const [k, v] of Object.entries({ readAdmin, readAuditor, readViewer })) {
    if (v !== undefined && typeof v !== 'boolean') {
      res.status(400).json({ error: `${k} must be a boolean` }); return;
    }
  }
  try {
    const updates: Prisma.Sql[] = [];
    if (readAdmin !== undefined)   updates.push(Prisma.sql`read_admin = ${readAdmin}`);
    if (readAuditor !== undefined) updates.push(Prisma.sql`read_auditor = ${readAuditor}`);
    if (readViewer !== undefined)  updates.push(Prisma.sql`read_viewer = ${readViewer}`);
    const setClause = Prisma.join(updates, ', ');

    const rows = await prisma.$queryRaw<{ id: string }[]>`
      UPDATE "documents"
      SET ${setClause}, updated_at = now()
      WHERE id = ${req.params.id}::uuid AND root_id IS NULL
      RETURNING id::text AS id`;
    if (!rows.length) { res.status(404).json({ error: 'Document not found' }); return; }
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at)
      VALUES(gen_random_uuid(),'UPDATE_DOC_ACL','Document',${req.params.id}::uuid,${req.user!.email},now())`;
    res.json({ id: rows[0].id, readAdmin: readAdmin ?? null, readAuditor: readAuditor ?? null, readViewer: readViewer ?? null });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
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
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/documents/:id/reindex — force re-queue the latest version for RAG indexing (ADMIN only)
app.post('/api/documents/:id/reindex', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const rows = await prisma.$queryRaw<{ id: string; version_number: number }[]>`
      SELECT id::text AS id, version_number FROM "documents"
      WHERE (id=${req.params.id}::uuid OR root_id=${req.params.id}::uuid) AND is_latest=true
      LIMIT 1`;
    if (!rows.length) { res.status(404).json({ error: 'Document not found' }); return; }
    await queueDocumentForIndexing(rows[0].id, rows[0].version_number);
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at)
      VALUES(gen_random_uuid(),'REINDEX_DOC','Document',${req.params.id}::uuid,${req.user!.email},now())`;
    res.json({ ok: true, queued: rows[0].id });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// ─── Bulk Document Import (staging) ───────────────────────────────────────────
// ADMIN-only multi-file upload → staging area. The AI worker (processBulkImport-
// Queue) analyzes each file; the user then reviews/corrects and materializes
// real Document/Contract/License records line by line via the commit endpoints.

// POST /api/documents/bulk/batches — upload N files into a new staging batch
app.post('/api/documents/bulk/batches', authenticateToken, requireAdmin, bulkUploadMiddleware, async (req: Request, res: Response) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) { res.status(400).json({ error: 'Se requiere al menos un fichero' }); return; }

  // Per-batch total-size guard (per-file size + count already enforced by multer)
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  if (totalBytes > BULK_MAX_TOTAL_BYTES) {
    res.status(400).json({ error: `El lote supera el máximo de ${Math.floor(BULK_MAX_TOTAL_BYTES / (1024 * 1024))} MB` });
    return;
  }

  // Enforce concurrent-batch limit per user (prevents staging exhaustion / DoS).
  // Terminal states (COMMITTED, DISCARDED, REAPED) do not count toward the limit.
  try {
    const openRows = await prisma.$queryRaw<{ c: bigint }[]>`
      SELECT COUNT(*) AS c FROM "bulk_import_batch"
      WHERE created_by = ${req.user!.email}
        AND status NOT IN ('COMMITTED','DISCARDED','REAPED')`;
    const open = Number(openRows[0]?.c ?? 0);
    if (open >= BULK_MAX_OPEN_BATCHES) {
      res.status(429).json({
        error: `Has alcanzado el límite de ${BULK_MAX_OPEN_BATCHES} lotes abiertos simultáneos. Confirma o descarta alguno antes de subir uno nuevo.`,
        openBatches: open,
        maxBatches: BULK_MAX_OPEN_BATCHES,
      });
      return;
    }
    // Per-user staging-bytes cap: bounds peak disk usage across all open batches.
    const bytesRows = await prisma.$queryRaw<{ used: bigint }[]>`
      SELECT COALESCE(SUM(total_bytes), 0) AS used FROM "bulk_import_batch"
      WHERE created_by = ${req.user!.email}
        AND status NOT IN ('COMMITTED','DISCARDED','REAPED')`;
    const usedBytes = Number(bytesRows[0]?.used ?? 0);
    if (usedBytes + totalBytes > BULK_MAX_USER_STAGING_BYTES) {
      const maxMb = Math.floor(BULK_MAX_USER_STAGING_BYTES / (1024 * 1024));
      const usedMb = Math.floor(usedBytes / (1024 * 1024));
      res.status(429).json({
        error: `El almacenamiento temporal de tus lotes abiertos superaría el límite de ${maxMb} MB (en uso: ${usedMb} MB). Confirma o descarta algún lote primero.`,
        usedBytes,
        maxBytes: BULK_MAX_USER_STAGING_BYTES,
      });
      return;
    }
  } catch (e) { console.error('[POST /api/documents/bulk/batches] limit check error:', e); }

  // Validate magic bytes for EVERY file before writing anything to disk
  for (const f of files) {
    const ext = path.extname(f.originalname).toLowerCase().replace('.', '');
    if (!validateMagicBytes(f.buffer, ext)) {
      res.status(400).json({ error: `El contenido de "${f.originalname}" no coincide con su extensión declarada` });
      return;
    }
  }

  try { fs.mkdirSync(STAGING_DIR, { recursive: true }); }
  catch { res.status(500).json({ error: 'Error preparando el almacenamiento' }); return; }

  const written: string[] = [];
  let batchId: string | null = null;
  try {
    const batchRows = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "bulk_import_batch"(id, created_by, status, file_count, total_bytes, created_at, updated_at)
      VALUES(gen_random_uuid(), ${req.user!.email}, 'UPLOADED', ${files.length}, ${totalBytes}, now(), now())
      RETURNING id::text AS id`;
    batchId = batchRows[0].id;

    for (const f of files) {
      const ext = path.extname(f.originalname).toLowerCase().replace('.', '');
      const stagedName = `${crypto.randomUUID()}.${ext}`;
      fs.writeFileSync(path.join(STAGING_DIR, stagedName), f.buffer);
      written.push(stagedName);
      await prisma.$executeRaw`
        INSERT INTO "bulk_import_item"(id, batch_id, staged_file_name, original_name, mime_type, file_size, status, analysis, created_at, updated_at)
        VALUES(gen_random_uuid(), ${batchId}::uuid, ${stagedName}, ${f.originalname}, ${f.mimetype}, ${f.size}, 'PENDING_ANALYSIS', '{}'::jsonb, now(), now())`;
    }

    await prisma.$executeRaw`
      INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, details, created_at)
      VALUES(gen_random_uuid(), 'BULK_UPLOAD', 'BulkImportBatch', ${batchId}::uuid, ${req.user!.email},
             ${JSON.stringify({ fileCount: files.length, totalBytes })}::jsonb, now())`;

    res.status(201).json({ batchId, fileCount: files.length });
  } catch (e) {
    for (const name of written) { try { fs.unlinkSync(path.join(STAGING_DIR, name)); } catch {} }
    if (batchId) { try { await prisma.$executeRaw`DELETE FROM "bulk_import_batch" WHERE id=${batchId}::uuid`; } catch {} }
    console.error('[POST /api/documents/bulk/batches]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/documents/bulk/batches — list the caller's batches (most recent first)
app.get('/api/documents/bulk/batches', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  try {
    const [countRows, rows] = await Promise.all([
      prisma.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*) AS c FROM "bulk_import_batch" WHERE created_by = ${req.user!.email}`,
      prisma.$queryRaw<{ id: string; status: string; fileCount: number; totalBytes: string; createdAt: Date; committed: bigint; pending: bigint; errors: bigint; warnings: bigint }[]>`
        SELECT b.id::text AS id, b.status, b.file_count AS "fileCount", b.total_bytes::text AS "totalBytes",
               b.created_at AS "createdAt",
               COUNT(i.id) FILTER (WHERE i.status = 'COMMITTED') AS committed,
               COUNT(i.id) FILTER (WHERE i.status IN ('PENDING_ANALYSIS','ANALYZING')) AS pending,
               COUNT(i.id) FILTER (WHERE i.status = 'ERROR') AS errors,
               COUNT(i.id) FILTER (WHERE i.status = 'WARNING') AS warnings
        FROM "bulk_import_batch" b
        LEFT JOIN "bulk_import_item" i ON i.batch_id = b.id
        WHERE b.created_by = ${req.user!.email}
        GROUP BY b.id
        ORDER BY b.created_at DESC
        LIMIT 100`,
    ]);
    const total = Number(countRows[0]?.c ?? 0);
    res.json({ total, truncated: total > 100, batches: rows.map((r) => ({ ...r, totalBytes: Number(r.totalBytes), committed: Number(r.committed), pending: Number(r.pending), errors: Number(r.errors), warnings: Number(r.warnings) })) });
  } catch (e) { console.error('[GET /api/documents/bulk/batches]', e); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/documents/bulk/batches/:id — batch detail + items (polling target)
app.get('/api/documents/bulk/batches/:id', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  try {
    const batchRows = await prisma.$queryRaw<{ id: string; status: string; fileCount: number; totalBytes: string; createdBy: string; createdAt: Date }[]>`
      SELECT id::text AS id, status, file_count AS "fileCount", total_bytes::text AS "totalBytes",
             created_by AS "createdBy", created_at AS "createdAt"
      FROM "bulk_import_batch"
      WHERE id = ${req.params.id}::uuid AND created_by = ${req.user!.email}
      LIMIT 1`;
    if (!batchRows.length) { res.status(404).json({ error: 'Batch not found' }); return; }

    const items = await prisma.$queryRaw<{ id: string; originalName: string; mimeType: string; fileSize: number; status: string; analysis: unknown; errorMessage: string | null; committedDocumentId: string | null; createdAt: Date }[]>`
      SELECT id::text AS id, original_name AS "originalName", mime_type AS "mimeType",
             file_size AS "fileSize", status, analysis, error_message AS "errorMessage",
             committed_document_id::text AS "committedDocumentId", created_at AS "createdAt"
      FROM "bulk_import_item"
      WHERE batch_id = ${req.params.id}::uuid
      ORDER BY created_at ASC`;

    res.json({ ...batchRows[0], totalBytes: Number(batchRows[0].totalBytes), items });
  } catch (e) { console.error('[GET /api/documents/bulk/batches/:id]', e); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /api/documents/bulk/items/:id — discard a single staged item
app.delete('/api/documents/bulk/items/:id', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  try {
    const rows = await prisma.$queryRaw<{ stagedFileName: string; status: string }[]>`
      SELECT i.staged_file_name AS "stagedFileName", i.status
      FROM "bulk_import_item" i
      JOIN "bulk_import_batch" b ON b.id = i.batch_id
      WHERE i.id = ${req.params.id}::uuid AND b.created_by = ${req.user!.email}
      LIMIT 1`;
    if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
    if (rows[0].status !== 'COMMITTED') {
      try { fs.unlinkSync(path.join(STAGING_DIR, path.basename(rows[0].stagedFileName))); } catch {}
    }
    await prisma.$executeRaw`DELETE FROM "bulk_import_item" WHERE id = ${req.params.id}::uuid`;
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'BULK_DISCARD_ITEM','BulkImportItem',${req.params.id}::uuid,${req.user!.email},now())`;
    res.json({ ok: true });
  } catch (e) { console.error('[DELETE /api/documents/bulk/items/:id]', e); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /api/documents/bulk/batches/:id — discard a whole batch (+ staged files)
app.delete('/api/documents/bulk/batches/:id', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  try {
    const batch = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM "bulk_import_batch"
      WHERE id = ${req.params.id}::uuid AND created_by = ${req.user!.email} LIMIT 1`;
    if (!batch.length) { res.status(404).json({ error: 'Not found' }); return; }

    const items = await prisma.$queryRaw<{ stagedFileName: string }[]>`
      SELECT staged_file_name AS "stagedFileName" FROM "bulk_import_item"
      WHERE batch_id = ${req.params.id}::uuid AND status != 'COMMITTED'`;
    for (const it of items) {
      try { fs.unlinkSync(path.join(STAGING_DIR, path.basename(it.stagedFileName))); } catch {}
    }

    await prisma.$executeRaw`DELETE FROM "bulk_import_batch" WHERE id = ${req.params.id}::uuid`;
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'BULK_DISCARD_BATCH','BulkImportBatch',${req.params.id}::uuid,${req.user!.email},now())`;
    res.json({ ok: true });
  } catch (e) { console.error('[DELETE /api/documents/bulk/batches/:id]', e); res.status(500).json({ error: 'Internal server error' }); }
});

// PATCH /api/documents/bulk/items/:id — persist the user's reviewed decision
app.patch('/api/documents/bulk/items/:id', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  const parsed = BulkItemDecisionBase.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Datos inválidos' }); return; }
  try {
    const rows = await prisma.$queryRaw<{ id: string; status: string }[]>`
      SELECT i.id::text AS id, i.status
      FROM "bulk_import_item" i JOIN "bulk_import_batch" b ON b.id = i.batch_id
      WHERE i.id = ${req.params.id}::uuid AND b.created_by = ${req.user!.email} LIMIT 1`;
    if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
    if (rows[0].status === 'COMMITTED') { res.status(409).json({ error: 'El elemento ya fue confirmado' }); return; }
    await prisma.$executeRaw`
      UPDATE "bulk_import_item"
      SET analysis = jsonb_set(COALESCE(analysis, '{}'::jsonb), '{decision}', ${JSON.stringify(parsed.data)}::jsonb, true),
          updated_at = now()
      WHERE id = ${req.params.id}::uuid`;
    res.json({ ok: true });
  } catch (e) { console.error('[PATCH /api/documents/bulk/items/:id]', e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/documents/bulk/items/:id/commit — materialize one reviewed item
app.post('/api/documents/bulk/items/:id/commit', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  try {
    const rows = await prisma.$queryRaw<(BulkItemRow & { analysis: unknown })[]>`
      SELECT i.id::text AS id, i.batch_id::text AS batch_id, i.staged_file_name AS staged_file_name,
             i.original_name AS original_name, i.mime_type AS mime_type, i.file_size AS file_size,
             i.status, i.analysis
      FROM "bulk_import_item" i JOIN "bulk_import_batch" b ON b.id = i.batch_id
      WHERE i.id = ${req.params.id}::uuid AND b.created_by = ${req.user!.email} LIMIT 1`;
    if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
    const item = rows[0];

    // Prefer the decision in the request body; fall back to the persisted one.
    const source = req.body && Object.keys(req.body).length > 0
      ? req.body
      : (item.analysis as { decision?: unknown } | null)?.decision;
    const parsed = BulkItemDecisionSchema.safeParse(source);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Decisión inválida' }); return; }

    const result = await materializeBulkItem(item, parsed.data, req.user!.email);
    await recomputeBatchStatus(item.batch_id);
    res.status(201).json(result);
  } catch (e) {
    if (e instanceof BulkValidationError) { res.status(400).json({ error: e.message }); return; }
    console.error('[POST /api/documents/bulk/items/:id/commit]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/documents/bulk/batches/:id/commit — commit every reviewed item at once
app.post('/api/documents/bulk/batches/:id/commit', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  try {
    const batch = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM "bulk_import_batch"
      WHERE id = ${req.params.id}::uuid AND created_by = ${req.user!.email} LIMIT 1`;
    if (!batch.length) { res.status(404).json({ error: 'Not found' }); return; }

    const items = await prisma.$queryRaw<(BulkItemRow & { analysis: unknown })[]>`
      SELECT i.id::text AS id, i.batch_id::text AS batch_id, i.staged_file_name AS staged_file_name,
             i.original_name AS original_name, i.mime_type AS mime_type, i.file_size AS file_size,
             i.status, i.analysis
      FROM "bulk_import_item" i
      WHERE i.batch_id = ${req.params.id}::uuid AND i.status IN ('ANALYZED','ERROR','WARNING')
      ORDER BY i.created_at ASC`;

    const results: { itemId: string; ok: boolean; documentId?: string; error?: string }[] = [];
    for (const item of items) {
      const decision = (item.analysis as { decision?: unknown } | null)?.decision;
      const parsed = BulkItemDecisionSchema.safeParse(decision);
      if (!parsed.success) { results.push({ itemId: item.id, ok: false, error: parsed.error.issues[0]?.message ?? 'Decisión incompleta' }); continue; }
      try {
        const r = await materializeBulkItem(item, parsed.data, req.user!.email);
        results.push({ itemId: item.id, ok: true, documentId: r.documentId });
      } catch (e) {
        results.push({ itemId: item.id, ok: false, error: e instanceof BulkValidationError ? e.message : 'Error interno' });
      }
    }
    await recomputeBatchStatus(req.params.id as string);
    res.json({ results });
  } catch (e) { console.error('[POST /api/documents/bulk/batches/:id/commit]', e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/documents/bulk/items/:id/reanalyze — flip one ANALYZED/ERROR item back
// to PENDING_ANALYSIS so the worker re-processes it (useful after OCR or other
// pipeline improvements that landed AFTER the original analysis).
app.post('/api/documents/bulk/items/:id/reanalyze', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  try {
    const rows = await prisma.$queryRaw<{ id: string; batch_id: string }[]>`
      SELECT i.id::text AS id, i.batch_id::text AS batch_id
      FROM "bulk_import_item" i JOIN "bulk_import_batch" b ON b.id = i.batch_id
      WHERE i.id = ${req.params.id}::uuid AND b.created_by = ${req.user!.email}
        AND i.status IN ('ANALYZED','ERROR','WARNING') LIMIT 1`;
    if (!rows.length) { res.status(404).json({ error: 'Not found or not re-analyzable' }); return; }
    await prisma.$executeRaw`
      UPDATE "bulk_import_item" SET status='PENDING_ANALYSIS', error_message=NULL, updated_at=now()
      WHERE id = ${req.params.id}::uuid`;
    await recomputeBatchStatus(rows[0].batch_id);
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'BULK_REANALYZE_ITEM','BulkImportItem',${req.params.id}::uuid,${req.user!.email},now())`;
    res.json({ ok: true });
  } catch (e) { console.error('[POST /api/documents/bulk/items/:id/reanalyze]', e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/documents/bulk/batches/:id/reanalyze — re-queue every ANALYZED/ERROR
// item in the batch (committed items are skipped). Returns how many were queued.
app.post('/api/documents/bulk/batches/:id/reanalyze', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  try {
    const batch = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM "bulk_import_batch"
      WHERE id = ${req.params.id}::uuid AND created_by = ${req.user!.email} LIMIT 1`;
    if (!batch.length) { res.status(404).json({ error: 'Not found' }); return; }
    const result = await prisma.$executeRaw`
      UPDATE "bulk_import_item" SET status='PENDING_ANALYSIS', error_message=NULL, updated_at=now()
      WHERE batch_id = ${req.params.id}::uuid AND status IN ('ANALYZED','ERROR','WARNING')`;
    const count = Number(result);
    await recomputeBatchStatus(req.params.id as string);
    await prisma.$executeRaw`
      INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at)
      VALUES(gen_random_uuid(),'BULK_REANALYZE_BATCH','BulkImportBatch',${req.params.id}::uuid,${req.user!.email},
             ${JSON.stringify({ count })}::jsonb, now())`;
    res.json({ ok: true, count });
  } catch (e) { console.error('[POST /api/documents/bulk/batches/:id/reanalyze]', e); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/documents/:id/index-status — return the latest version's RAG indexing status
app.get('/api/documents/:id/index-status', authenticateToken, async (req: Request, res: Response) => {
  try {
    const rows = await prisma.$queryRaw<{ status: string | null; chunk_count: number | null; indexed_at: Date | null; error_message: string | null; updated_at: Date | null }[]>`
      SELECT r.status, r.chunk_count, r.indexed_at, r.error_message, r.updated_at
      FROM "documents" d
      LEFT JOIN "rag_document_index" r
        ON r.document_id = d.id AND r.version_number = d.version_number
      WHERE (d.id = ${req.params.id}::uuid OR d.root_id = ${req.params.id}::uuid)
        AND d.is_latest = true
      LIMIT 1`;
    if (!rows.length) { res.status(404).json({ error: 'Document not found' }); return; }
    const r = rows[0];
    res.json({
      status:        r.status ?? 'NOT_INDEXED',
      chunkCount:    r.chunk_count   ?? 0,
      indexedAt:     r.indexed_at,
      errorMessage:  r.error_message,
      updatedAt:     r.updated_at,
    });
  } catch (e) { console.error('[GET /api/documents/:id/index-status]', e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/admin/rag/backfill — re-queue un-indexed documents and/or entities (ADMIN only)
// Plan §11: optional body `{ entityTypes?: ('document'|'ci'|'contract'|'license'|'vulnerability')[] }`
// Empty array or omitted → process ALL types.
const BackfillSchema = z.object({
  entityTypes: z
    .array(z.enum(['document', 'ci', 'contract', 'license', 'vulnerability']))
    .optional(),
});

app.post('/api/admin/rag/backfill', authenticateToken, requireAdmin, ragBackfillLimiter, async (req: Request, res: Response) => {
  if (process.env.RAG_ENABLED !== 'true') {
    res.status(503).json({ error: 'RAG subsystem is disabled' });
    return;
  }
  try {
    const parsed = BackfillSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    const requested = parsed.data.entityTypes ?? [];
    const ALL = ['document', 'ci', 'contract', 'license', 'vulnerability'] as const;
    const targets: ReadonlyArray<(typeof ALL)[number]> = requested.length === 0 ? ALL : requested;
    const wants = (t: (typeof ALL)[number]) => targets.includes(t);

    const queued: Record<(typeof ALL)[number], number> = {
      document: 0, ci: 0, contract: 0, license: 0, vulnerability: 0,
    };

    // ── Documents ────────────────────────────────────────────────────────────
    if (wants('document')) {
      const docs = await prisma.$queryRaw<{ id: string; version_number: number }[]>`
        SELECT d.id::text AS id, d.version_number
        FROM "documents" d
        LEFT JOIN "rag_document_index" r
          ON r.document_id = d.id AND r.version_number = d.version_number
        WHERE d.is_latest = true
          AND (r.status IS NULL OR r.status != 'READY')`;
      for (const doc of docs) {
        await prisma.$executeRaw`
          INSERT INTO "rag_document_index"(id, document_id, version_number, status, created_at, updated_at)
          VALUES(gen_random_uuid(), ${doc.id}::uuid, ${doc.version_number}, 'PENDING', now(), now())
          ON CONFLICT (document_id, version_number) DO UPDATE SET status='PENDING', updated_at=now()`;
      }
      queued.document = docs.length;
    }

    // ── CIs ─────────────────────────────────────────────────────────────────
    if (wants('ci')) {
      const cis = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM "configuration_items"`;
      for (const ci of cis) {
        await prisma.$executeRaw`
          INSERT INTO "rag_entity_index"(id, entity_type, entity_id, status, created_at, updated_at)
          VALUES(gen_random_uuid(), 'ci', ${ci.id}::uuid, 'PENDING', now(), now())
          ON CONFLICT (entity_type, entity_id) DO UPDATE
            SET status='PENDING', updated_at=now()
            WHERE "rag_entity_index".status != 'INDEXING'`;
      }
      queued.ci = cis.length;
    }

    // ── Contracts (roots only) ──────────────────────────────────────────────
    if (wants('contract')) {
      const contracts = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM "contracts" WHERE parent_contract_id IS NULL`;
      for (const c of contracts) {
        await prisma.$executeRaw`
          INSERT INTO "rag_entity_index"(id, entity_type, entity_id, status, created_at, updated_at)
          VALUES(gen_random_uuid(), 'contract', ${c.id}::uuid, 'PENDING', now(), now())
          ON CONFLICT (entity_type, entity_id) DO UPDATE
            SET status='PENDING', updated_at=now()
            WHERE "rag_entity_index".status != 'INDEXING'`;
      }
      queued.contract = contracts.length;
    }

    // ── Licenses (roots only) ───────────────────────────────────────────────
    if (wants('license')) {
      const licenses = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM "licenses" WHERE parent_license_id IS NULL`;
      for (const l of licenses) {
        await prisma.$executeRaw`
          INSERT INTO "rag_entity_index"(id, entity_type, entity_id, status, created_at, updated_at)
          VALUES(gen_random_uuid(), 'license', ${l.id}::uuid, 'PENDING', now(), now())
          ON CONFLICT (entity_type, entity_id) DO UPDATE
            SET status='PENDING', updated_at=now()
            WHERE "rag_entity_index".status != 'INDEXING'`;
      }
      queued.license = licenses.length;
    }

    // ── Vulnerabilities (enumerate CI JSON arrays) ──────────────────────────
    if (wants('vulnerability')) {
      const ciRows = await prisma.$queryRaw<{ id: string; vulnerabilities: unknown }[]>`
        SELECT id::text AS id, vulnerabilities
        FROM "configuration_items"
        WHERE vulnerabilities IS NOT NULL
          AND jsonb_typeof(vulnerabilities) = 'array'
          AND jsonb_array_length(vulnerabilities) > 0`;
      let vulnCount = 0;
      for (const ciRow of ciRows) {
        const arr = Array.isArray(ciRow.vulnerabilities) ? ciRow.vulnerabilities : [];
        for (const v of arr) {
          if (!v || typeof v !== 'object') continue;
          const cve = (v as { cve?: unknown }).cve;
          if (typeof cve !== 'string' || cve.length === 0) continue;
          const vId = vulnUuid(ciRow.id, cve);
          await prisma.$executeRaw`
            INSERT INTO "rag_entity_index"(id, entity_type, entity_id, status, created_at, updated_at)
            VALUES(gen_random_uuid(), 'vulnerability', ${vId}::uuid, 'PENDING', now(), now())
            ON CONFLICT (entity_type, entity_id) DO UPDATE
              SET status='PENDING', updated_at=now()
              WHERE "rag_entity_index".status != 'INDEXING'`;
          vulnCount++;
        }
      }
      queued.vulnerability = vulnCount;
    }

    await prisma.$executeRaw`
      INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, details, created_at)
      VALUES(gen_random_uuid(), 'RAG_BACKFILL_ENTITIES', 'System', NULL, ${req.user!.email},
        ${JSON.stringify({ queued_per_type: queued })}::jsonb, now())`;

    res.json({ ok: true, queued });
  } catch (e) {
    console.error('[POST /api/admin/rag/backfill] Error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/documents/:id/download — authenticated file download
// Uses authenticateToken middleware (checks JWT + deactivated-user status in DB)
// Supports ?inline=true to display in browser instead of triggering download
app.get('/api/documents/:id/download', authenticateToken, async (req: Request, res: Response) => {
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
  ]);

  const visCol = Prisma.raw(`"${docVisibilitySqlCol(req.user!.role)}"`);
  try {
    const rows = await prisma.$queryRaw<{ file_name: string; original_name: string; mime_type: string }[]>`
      SELECT d.file_name, d.original_name, d.mime_type
      FROM "documents" d
      JOIN "documents" root ON root.id = COALESCE(d.root_id, d.id)
      WHERE d.id = ${req.params.id}::uuid AND root.${visCol} = true`;
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
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
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
    try {
      fs.writeFileSync(filePath, req.file.buffer);
    } catch {
      res.status(500).json({ error: 'Error saving file' });
      return;
    }

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

    void queueDocumentForIndexing(newRows[0].id, nextVersion);
    res.status(201).json({ id: newRows[0].id, versionNumber: nextVersion });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
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
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
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
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at) VALUES(gen_random_uuid(),'LINK_DOCUMENT','Document',${req.params.id}::uuid,${req.user!.email},${JSON.stringify({targetDocId,relationType})}::jsonb,now())`;
    res.status(201).json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /api/documents/:id/relations/:targetId — remove relation
app.delete('/api/documents/:id/relations/:targetId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await prisma.$executeRaw`DELETE FROM "document_relations" WHERE source_doc_id=${req.params.id}::uuid AND target_doc_id=${req.params.targetId}::uuid`;
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at) VALUES(gen_random_uuid(),'UNLINK_DOCUMENT','Document',${req.params.id}::uuid,${req.user!.email},${JSON.stringify({targetDocId:req.params.targetId})}::jsonb,now())`;
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/documents/:id/ci/:ciId — associate document with CI
app.post('/api/documents/:id/ci/:ciId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await prisma.$executeRaw`INSERT INTO "document_cis"(id,document_id,ci_id) VALUES(gen_random_uuid(),${req.params.id}::uuid,${req.params.ciId}::uuid) ON CONFLICT DO NOTHING`;
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at) VALUES(gen_random_uuid(),'LINK_DOCUMENT','Document',${req.params.id}::uuid,${req.user!.email},${JSON.stringify({ciId:req.params.ciId})}::jsonb,now())`;
    res.status(201).json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /api/documents/:id/ci/:ciId — remove CI association
app.delete('/api/documents/:id/ci/:ciId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await prisma.$executeRaw`DELETE FROM "document_cis" WHERE document_id=${req.params.id}::uuid AND ci_id=${req.params.ciId}::uuid`;
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at) VALUES(gen_random_uuid(),'UNLINK_DOCUMENT','Document',${req.params.id}::uuid,${req.user!.email},${JSON.stringify({ciId:req.params.ciId})}::jsonb,now())`;
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/documents/:id/contract/:contractId — associate with contract
app.post('/api/documents/:id/contract/:contractId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await prisma.$executeRaw`INSERT INTO "document_contracts"(id,document_id,contract_id) VALUES(gen_random_uuid(),${req.params.id}::uuid,${req.params.contractId}::uuid) ON CONFLICT DO NOTHING`;
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at) VALUES(gen_random_uuid(),'LINK_DOCUMENT','Document',${req.params.id}::uuid,${req.user!.email},${JSON.stringify({contractId:req.params.contractId})}::jsonb,now())`;
    res.status(201).json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /api/documents/:id/contract/:contractId — remove contract association
app.delete('/api/documents/:id/contract/:contractId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await prisma.$executeRaw`DELETE FROM "document_contracts" WHERE document_id=${req.params.id}::uuid AND contract_id=${req.params.contractId}::uuid`;
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at) VALUES(gen_random_uuid(),'UNLINK_DOCUMENT','Document',${req.params.id}::uuid,${req.user!.email},${JSON.stringify({contractId:req.params.contractId})}::jsonb,now())`;
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/cis/:id/documents — get documents for a CI
app.get('/api/cis/:id/documents', authenticateToken, async (req, res) => {
  const visCol = Prisma.raw(`"${docVisibilitySqlCol(req.user!.role)}"`);
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
      WHERE dc.ci_id = ${req.params.id}::uuid AND d.root_id IS NULL AND d.${visCol} = true
      ORDER BY d.created_at DESC`;
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/contracts/:id/documents — get documents for a contract
app.get('/api/contracts/:id/documents', authenticateToken, async (req, res) => {
  const visCol = Prisma.raw(`"${docVisibilitySqlCol(req.user!.role)}"`);
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
      WHERE dc.contract_id = ${req.params.id}::uuid AND d.root_id IS NULL AND d.${visCol} = true
      ORDER BY d.created_at DESC`;
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

/**
 * DELETE /api/contracts/:id/documents/:docId — unlink a document from a contract.
 * Idempotent: returns 200 even if the link did not exist.
 */
app.delete('/api/contracts/:id/documents/:docId', authenticateToken, requireAdmin, async (req, res) => {
  const IdSchema = z.object({ id: z.string().uuid(), docId: z.string().uuid() });
  const parsed = IdSchema.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid contract or document id' }); return; }
  const { id: contractId, docId } = parsed.data;
  try {
    await prisma.$executeRaw`DELETE FROM "document_contracts" WHERE contract_id = ${contractId}::uuid AND document_id = ${docId}::uuid`;
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at) VALUES(gen_random_uuid(),'UNLINK_DOCUMENT','Contract',${contractId}::uuid,${req.user!.email},${JSON.stringify({ documentId: docId })}::jsonb,now())`;
    const rootId = await getContractRoot(contractId);
    void queueEntityForIndexing('contract', rootId);
    res.json({ ok: true });
  } catch (e) { console.error('[DELETE /api/contracts/:id/documents/:docId]', e); res.status(500).json({ error: 'Internal server error' }); }
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
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at) VALUES(gen_random_uuid(),'LINK_DOCUMENT','Document',${docId}::uuid,${req.user!.email},${JSON.stringify({ciIds,count:associated})}::jsonb,now())`;
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
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at) VALUES(gen_random_uuid(),'LINK_DOCUMENT','Document',${docId}::uuid,${req.user!.email},${JSON.stringify({contractIds,count:associated})}::jsonb,now())`;
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
      JOIN "_ContractToCI" ctc ON ctc."B" = c.id
      WHERE ctc."A" = ${ciId}::uuid`;
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
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at) VALUES(gen_random_uuid(),'LINK_CI','CI',${ciId}::uuid,${req.user!.email},${JSON.stringify({contractIds})}::jsonb,now())`;

    void queueEntityForIndexing('ci', ciId);
    for (const cid of contractIds) {
      const rootId = await getContractRoot(cid);
      void queueEntityForIndexing('contract', rootId);
    }

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
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at) VALUES(gen_random_uuid(),'UNLINK_CI','CI',${ciId}::uuid,${req.user!.email},${JSON.stringify({contractId})}::jsonb,now())`;

    void queueEntityForIndexing('ci', ciId);
    const rootId = await getContractRoot(contractId);
    void queueEntityForIndexing('contract', rootId);

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
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at) VALUES(gen_random_uuid(),'LINK_CI','CI',${ciId}::uuid,${req.user!.email},${JSON.stringify({documentIds,count:associated})}::jsonb,now())`;

    void queueEntityForIndexing('ci', ciId);

    res.json({ associated });
  } catch (e) { res.status(500).json({ error: 'Failed to associate documents to CI' }); }
});

// DELETE /api/cis/:id/documents/:docId — Remove document association from CI
app.delete('/api/cis/:id/documents/:docId', authenticateToken, requireAdmin, async (req, res) => {
  const ciId = req.params.id as string;
  const docId = req.params.docId as string;
  try {
    await prisma.$executeRaw`DELETE FROM "document_cis" WHERE document_id=${docId}::uuid AND ci_id=${ciId}::uuid`;
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at) VALUES(gen_random_uuid(),'UNLINK_CI','CI',${ciId}::uuid,${req.user!.email},${JSON.stringify({documentId:docId})}::jsonb,now())`;

    void queueEntityForIndexing('ci', ciId);

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Failed to remove document association from CI' }); }
});

// GET /api/contracts/:id/cis — List CIs associated with a contract
app.get('/api/contracts/:id/cis', authenticateToken, async (req, res) => {
  const contractId = req.params.id as string;
  try {
    const rows = await prisma.$queryRaw<{ id: string; name: string; apiSlug: string; environment: string; criticality: string }[]>`
      SELECT ci.id::text AS id, ci.name, ci.api_slug AS "apiSlug", ci.environment::text AS environment, ci.criticality::text AS criticality
      FROM "configuration_items" ci
      JOIN "_ContractToCI" ctc ON ctc."A" = ci.id
      WHERE ctc."B" = ${contractId}::uuid`;
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
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at) VALUES(gen_random_uuid(),'LINK_CI','Contract',${contractId}::uuid,${req.user!.email},${JSON.stringify({ciIds})}::jsonb,now())`;

    const rootId = await getContractRoot(contractId);
    void queueEntityForIndexing('contract', rootId);
    for (const cid of ciIds) {
      void queueEntityForIndexing('ci', cid);
    }

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
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at) VALUES(gen_random_uuid(),'UNLINK_CI','Contract',${contractId}::uuid,${req.user!.email},${JSON.stringify({ciId})}::jsonb,now())`;

    const rootId = await getContractRoot(contractId);
    void queueEntityForIndexing('contract', rootId);
    void queueEntityForIndexing('ci', ciId);

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Failed to disassociate CI from contract' }); }
});

// ─── Document Notes ───────────────────────────────────────────────────────────

// GET /api/documents/:id/notes — get all notes for a document (resolves to root)
app.get('/api/documents/:id/notes', authenticateToken, async (req, res) => {
  const visCol = Prisma.raw(`"${docVisibilitySqlCol(req.user!.role)}"`);
  try {
    const docRows = await prisma.$queryRaw<{ id: string; root_id: string | null }[]>`
      SELECT d.id::text AS id, d.root_id::text AS root_id
      FROM "documents" d
      JOIN "documents" root ON root.id = COALESCE(d.root_id, d.id)
      WHERE d.id = ${req.params.id}::uuid AND root.${visCol} = true`;
    if (!docRows.length) { res.status(404).json({ error: 'Not found' }); return; }
    const rootId = docRows[0].root_id ?? docRows[0].id;
    const rows = await prisma.$queryRaw<{ id: string; content: string; createdBy: string; createdAt: Date }[]>`
      SELECT id::text AS id, content, created_by AS "createdBy", created_at AS "createdAt"
      FROM "document_notes"
      WHERE document_id = ${rootId}::uuid
      ORDER BY created_at ASC`;
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
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
  } catch (e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
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
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── App Settings — Theme & Branding ─────────────────────────────────────────

const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo de imagen no permitido. Use PNG, JPEG o WebP.'));
    }
  },
});

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const ThemeUpdateSchema = z.object({
  sidebarBg:   z.string().regex(HEX_COLOR_RE).optional(),
  accentColor: z.string().regex(HEX_COLOR_RE).optional(),
  companyName: z.string().min(1).max(100).trim().optional(),
});

/**
 * GET /api/settings/theme — public (needed for login page before auth)
 */
app.get('/api/settings/theme', async (_req: Request, res: Response) => {
  try {
    const rows = await (prisma as any).appSettings.findMany({
      where: { key: { in: ['sidebar_bg', 'accent_color', 'company_name', 'logo_data'] } },
    }) as { key: string; value: string }[];
    const s = Object.fromEntries(rows.map((r: { key: string; value: string }) => [r.key, r.value]));
    res.json({
      sidebarBg:   s['sidebar_bg']   ?? '#0f172a',
      accentColor: s['accent_color'] ?? '#3b82f6',
      companyName: s['company_name'] ?? 'CMDB Platform',
      hasLogo:     !!(s['logo_data'] && s['logo_data'].length > 0),
    });
  } catch (error) {
    log.error('[GET /api/settings/theme] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/settings/logo — public, returns binary image
 */
app.get('/api/settings/logo', async (_req: Request, res: Response) => {
  try {
    const rows = await (prisma as any).appSettings.findMany({
      where: { key: { in: ['logo_data', 'logo_mime'] } },
    }) as { key: string; value: string }[];
    const s = Object.fromEntries(rows.map((r: { key: string; value: string }) => [r.key, r.value]));
    if (!s['logo_data'] || s['logo_data'].length === 0) {
      res.status(404).json({ error: 'No logo configured' });
      return;
    }
    const buf = Buffer.from(s['logo_data'], 'base64');
    res.setHeader('Content-Type', s['logo_mime'] || 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(buf);
  } catch (error) {
    log.error('[GET /api/settings/logo] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /api/settings/theme — ADMIN only
 */
app.put('/api/settings/theme', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  const parsed = ThemeUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Datos inválidos', details: parsed.error.flatten() });
    return;
  }
  const { sidebarBg, accentColor, companyName } = parsed.data;
  const updates: { key: string; value: string }[] = [];
  if (sidebarBg)              updates.push({ key: 'sidebar_bg',   value: sidebarBg });
  if (accentColor)            updates.push({ key: 'accent_color', value: accentColor });
  if (companyName !== undefined) updates.push({ key: 'company_name', value: companyName });
  if (updates.length === 0) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }
  try {
    await Promise.all(
      updates.map((u) =>
        (prisma as any).appSettings.upsert({
          where:  { key: u.key },
          update: { value: u.value },
          create: { key: u.key, value: u.value },
        })
      )
    );
    await prisma.$executeRaw`
      INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
      VALUES (gen_random_uuid(), 'UPDATE_THEME', 'AppSettings', 'theme', ${req.user!.email}, now())
    `;
    res.json({ ok: true });
  } catch (error) {
    log.error('[PUT /api/settings/theme] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/settings/logo — ADMIN only, multipart/form-data field "logo"
 */
app.post('/api/settings/logo', authenticateToken, requireAdmin, logoUpload.single('logo'), async (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: 'No se adjuntó ningún archivo' });
    return;
  }
  const buf = req.file.buffer;
  if (buf.length < 12) {
    res.status(400).json({ error: 'El archivo no es una imagen válida (PNG, JPEG o WebP)' });
    return;
  }
  const isPng  = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isWebP = buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
                 buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
  if (!isPng && !isJpeg && !isWebP) {
    res.status(400).json({ error: 'El archivo no es una imagen válida (PNG, JPEG o WebP)' });
    return;
  }
  try {
    const b64 = buf.toString('base64');
    await (prisma as any).$transaction([
      (prisma as any).appSettings.upsert({
        where:  { key: 'logo_data' },
        update: { value: b64 },
        create: { key: 'logo_data', value: b64 },
      }),
      (prisma as any).appSettings.upsert({
        where:  { key: 'logo_mime' },
        update: { value: req.file.mimetype },
        create: { key: 'logo_mime', value: req.file.mimetype },
      }),
    ]);
    await prisma.$executeRaw`
      INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
      VALUES (gen_random_uuid(), 'UPDATE_LOGO', 'AppSettings', 'logo', ${req.user!.email}, now())
    `;
    res.json({ ok: true });
  } catch (error) {
    log.error('[POST /api/settings/logo] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/settings/logo — ADMIN only
 */
app.delete('/api/settings/logo', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  try {
    await (prisma as any).$transaction([
      (prisma as any).appSettings.upsert({ where: { key: 'logo_data' }, update: { value: '' }, create: { key: 'logo_data', value: '' } }),
      (prisma as any).appSettings.upsert({ where: { key: 'logo_mime' }, update: { value: '' }, create: { key: 'logo_mime', value: '' } }),
    ]);
    await prisma.$executeRaw`
      INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
      VALUES (gen_random_uuid(), 'DELETE_LOGO', 'AppSettings', 'logo', ${req.user!.email}, now())
    `;
    res.json({ ok: true });
  } catch (error) {
    log.error('[DELETE /api/settings/logo] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
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

// ── Bulk import staging cleanup (hourly) ──────────────────────────────────────
// Discards abandoned batches older than BULK_BATCH_TTL_HOURS and removes their
// staged files, so the staging area can never grow unbounded (ISO 22301 / NIS2).
cron.schedule('0 * * * *', async () => {
  try {
    // Only reap batches that are not already REAPED/DISCARDED/COMMITTED (terminal states).
    const stale = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM "bulk_import_batch"
      WHERE created_at < now() - make_interval(hours => ${BULK_BATCH_TTL_HOURS}::int)
        AND status NOT IN ('REAPED','COMMITTED','DISCARDED')`;
    let cleaned = 0;
    for (const b of stale) {
      // Look up the batch owner + counts BEFORE reaping so the audit row is attributable.
      const meta = await prisma.$queryRaw<{ created_by: string; file_count: number; committed: bigint; non_committed: bigint }[]>`
        SELECT b.created_by, b.file_count,
               COUNT(i.id) FILTER (WHERE i.status = 'COMMITTED')  AS committed,
               COUNT(i.id) FILTER (WHERE i.status <> 'COMMITTED') AS non_committed
        FROM "bulk_import_batch" b LEFT JOIN "bulk_import_item" i ON i.batch_id = b.id
        WHERE b.id = ${b.id}::uuid GROUP BY b.id`;
      // Delete only staged files (not committed documents, which already moved to DOCUMENTS_DIR).
      const items = await prisma.$queryRaw<{ stagedFileName: string }[]>`
        SELECT staged_file_name AS "stagedFileName" FROM "bulk_import_item"
        WHERE batch_id = ${b.id}::uuid AND status != 'COMMITTED'`;
      for (const it of items) {
        try { fs.unlinkSync(path.join(STAGING_DIR, path.basename(it.stagedFileName))); } catch {}
      }
      // Mark REAPED instead of DELETE: preserves the batch row for the list view (Task C)
      // so the user can see their expired batches and understand what happened to them.
      await prisma.$executeRaw`UPDATE "bulk_import_batch" SET status='REAPED', updated_at=now() WHERE id = ${b.id}::uuid`;
      const m = meta[0];
      if (m) {
        try {
          await prisma.$executeRaw`
            INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, details, created_at)
            VALUES(gen_random_uuid(),'BULK_REAP_BATCH','BulkImportBatch',${b.id}::uuid, ${m.created_by},
                   ${JSON.stringify({
                     ttlHours: BULK_BATCH_TTL_HOURS,
                     fileCount: m.file_count,
                     committed: Number(m.committed),
                     nonCommittedReaped: Number(m.non_committed),
                   })}::jsonb, now())`;
        } catch (e2) { log.error('[BulkCleanupCron] Audit write failed:', e2); }
      }
      cleaned++;
    }
    if (cleaned > 0) log.info(`[BulkCleanupCron] Reaped ${cleaned} stale bulk import batch(es)`);

    // Second pass: permanently DELETE REAPED rows older than BULK_REAPED_RETENTION_DAYS.
    // This prevents indefinite table bloat while giving users time to see expired batches.
    const oldReaped = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM "bulk_import_batch"
      WHERE status = 'REAPED'
        AND updated_at < now() - make_interval(days => ${BULK_REAPED_RETENTION_DAYS}::int)`;
    for (const r of oldReaped) {
      await prisma.$executeRaw`DELETE FROM "bulk_import_batch" WHERE id = ${r.id}::uuid`;
    }
    if (oldReaped.length > 0) log.info(`[BulkCleanupCron] Deleted ${oldReaped.length} expired REAPED batch(es)`);
  } catch (e) {
    log.error('[BulkCleanupCron] Cleanup error:', e);
  }
}, { timezone: 'Europe/Madrid' });

// ─── RAG Document Indexing Queue (every 30 s) ────────────────────────────────
if (process.env.RAG_ENABLED === 'true') {
  cron.schedule('*/30 * * * * *', () => {
    processRagQueue()
      .catch((e) => console.error('[RAG] processRagQueue error:', e))
      .finally(() => {
        processBulkImportQueue().catch((e) => console.error('[RAG] processBulkImportQueue error:', e));
        processCIBulkImportQueue().catch((e) => console.error('[CI-Bulk] processCIBulkImportQueue error:', e));
      });
  }, { timezone: 'Europe/Madrid' });
  console.log('[RAG] Indexing queue processor scheduled (every 30 s).');
} else {
  console.log('[RAG] RAG_ENABLED is not "true" — indexing queue disabled.');
}

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
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CREATE_MASTER','LicenseMetric',${rows[0].id}::uuid,${req.user!.email},now())`;
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
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'UPDATE_MASTER','LicenseMetric',${rows[0].id}::uuid,${req.user!.email},now())`;
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
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'DELETE_MASTER','LicenseMetric',${id}::uuid,${req.user!.email},now())`;
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
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CREATE_MASTER','LicenseType',${rows[0].id}::uuid,${req.user!.email},now())`;
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
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'UPDATE_MASTER','LicenseType',${rows[0].id}::uuid,${req.user!.email},now())`;
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
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'DELETE_MASTER','LicenseType',${id}::uuid,${req.user!.email},now())`;
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
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CREATE','License',${license.id}::uuid,${req.user!.email},now())`;

    // Re-index the license ROOT (addenda roll up to their root)
    const licenseRootId = await getLicenseRoot(license.id);
    void queueEntityForIndexing('license', licenseRootId);

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
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'UPDATE','License',${license.id}::uuid,${req.user!.email},now())`;

    // Re-index the license ROOT
    const licenseRootId = await getLicenseRoot(license.id);
    void queueEntityForIndexing('license', licenseRootId);

    res.json(license);
  } catch (e) { res.status(500).json({ error: 'Failed to update license' }); }
});

// DELETE /api/licenses/:id — delete (cascade handles relations)
app.delete('/api/licenses/:id', authenticateToken, requireAdmin, async (req, res) => {
  const id = req.params.id as string;
  try {
    // Walk to root BEFORE the delete so we know whether to purge or re-queue
    const licenseRootId = await getLicenseRoot(id);
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'DELETE','License',${id}::uuid,${req.user!.email},now())`;
    await prisma.license.delete({ where: { id } });

    // If we just deleted the ROOT, purge its RAG row. If we deleted an
    // addendum, the root is still alive — re-queue it for a fresh index.
    if (licenseRootId === id) {
      await purgeEntityFromRag('license', licenseRootId);
    } else {
      void queueEntityForIndexing('license', licenseRootId);
    }

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
      FROM "configuration_items" ci
      JOIN "_LicenseToCI" lci ON lci."A" = ci.id
      WHERE lci."B" = ${licenseId}::uuid`;
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
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'LINK_CI','License',${licenseId}::uuid,${req.user!.email},now())`;

    // Re-index the license ROOT and each newly attached CI
    const licenseRootId = await getLicenseRoot(licenseId);
    void queueEntityForIndexing('license', licenseRootId);
    for (const cid of ciIds) {
      void queueEntityForIndexing('ci', cid);
    }

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
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'UNLINK_CI','License',${licenseId}::uuid,${req.user!.email},now())`;

    // Re-index the license ROOT and the detached CI
    const licenseRootId = await getLicenseRoot(licenseId);
    void queueEntityForIndexing('license', licenseRootId);
    void queueEntityForIndexing('ci', ciId);

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Failed to disassociate CI from license' }); }
});

// ── Group 5: License ↔ Document associations ──────────────────────────────────

// GET /api/licenses/:id/documents — list docs with latestVersionId + mimeType
app.get('/api/licenses/:id/documents', authenticateToken, async (req, res) => {
  const licenseId = req.params.id as string;
  const visCol = Prisma.raw(`"${docVisibilitySqlCol(req.user!.role)}"`);
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
      WHERE dl.license_id = ${licenseId}::uuid AND d.root_id IS NULL AND d.${visCol} = true
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
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'LINK_DOCUMENT','License',${licenseId}::uuid,${req.user!.email},now())`;

    // Re-index the license ROOT (document list changed)
    const licenseRootId = await getLicenseRoot(licenseId);
    void queueEntityForIndexing('license', licenseRootId);

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
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'UNLINK_DOCUMENT','License',${licenseId}::uuid,${req.user!.email},now())`;

    // Re-index the license ROOT (document list changed)
    const licenseRootId = await getLicenseRoot(licenseId);
    void queueEntityForIndexing('license', licenseRootId);

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
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CREATE','LicenseUser',${user.id}::uuid,${req.user!.email},now())`;

    // Re-index the license ROOT (user total changed)
    const licenseRootId = await getLicenseRoot(licenseId);
    void queueEntityForIndexing('license', licenseRootId);

    res.status(201).json(user);
  } catch (e) { res.status(500).json({ error: 'Failed to create license user' }); }
});

// DELETE /api/licenses/:id/users/:userId — delete a LicenseUser
app.delete('/api/licenses/:id/users/:userId', authenticateToken, requireAdmin, async (req, res) => {
  const userId = req.params.userId as string;
  const licenseId = req.params.id as string;
  try {
    await prisma.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'DELETE','LicenseUser',${userId}::uuid,${req.user!.email},now())`;
    await prisma.licenseUser.delete({ where: { id: userId } });

    // Re-index the license ROOT (user total changed)
    const licenseRootId = await getLicenseRoot(licenseId);
    void queueEntityForIndexing('license', licenseRootId);

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Failed to delete license user' }); }
});

// ─── Chat / RAG assistant endpoints ──────────────────────────────────────────

// GET /api/chat/sessions — list current user's sessions
app.get('/api/chat/sessions', authenticateToken, async (req: Request, res: Response) => {
  try {
    const rows = await prisma.$queryRaw<{ id: string; title: string; created_at: Date; updated_at: Date; message_count: number }[]>`
      SELECT s.id::text AS id, s.title, s.created_at, s.updated_at,
             (SELECT COUNT(*)::int FROM "rag_chat_messages" m WHERE m.session_id = s.id) AS message_count
      FROM "rag_chat_sessions" s
      WHERE s.user_id = ${req.user!.id}::uuid
      ORDER BY s.updated_at DESC
      LIMIT 100`;
    res.json(rows.map(r => ({
      id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at, messageCount: Number(r.message_count),
    })));
  } catch (e) { console.error('[GET /api/chat/sessions]', e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/chat/sessions — create a new session
app.post('/api/chat/sessions', authenticateToken, async (req: Request, res: Response) => {
  const parsed = ChatSessionCreateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }
  const title = parsed.data.title?.trim() || 'Nueva consulta';
  try {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "rag_chat_sessions"(id, user_id, title, created_at, updated_at)
      VALUES(gen_random_uuid(), ${req.user!.id}::uuid, ${title}, now(), now())
      RETURNING id::text AS id`;
    res.status(201).json({ id: rows[0].id, title });
  } catch (e) { console.error('[POST /api/chat/sessions]', e); res.status(500).json({ error: 'Internal server error' }); }
});

// DELETE /api/chat/sessions/:id — delete a session (and its messages via CASCADE)
app.delete('/api/chat/sessions/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      DELETE FROM "rag_chat_sessions"
      WHERE id = ${req.params.id}::uuid AND user_id = ${req.user!.id}::uuid
      RETURNING id::text AS id`;
    if (!rows.length) { res.status(404).json({ error: 'Session not found' }); return; }
    res.json({ ok: true });
  } catch (e) { console.error('[DELETE /api/chat/sessions/:id]', e); res.status(500).json({ error: 'Internal server error' }); }
});

// GET /api/chat/sessions/:id/messages — list messages of a session
app.get('/api/chat/sessions/:id/messages', authenticateToken, async (req: Request, res: Response) => {
  try {
    // Verify session belongs to user
    const owner = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM "rag_chat_sessions"
      WHERE id = ${req.params.id}::uuid AND user_id = ${req.user!.id}::uuid LIMIT 1`;
    if (!owner.length) { res.status(404).json({ error: 'Session not found' }); return; }
    const msgs = await prisma.$queryRaw<{ id: string; role: string; content: string; citations: unknown; model_used: string | null; created_at: Date }[]>`
      SELECT id::text AS id, role, content, citations, model_used, created_at
      FROM "rag_chat_messages"
      WHERE session_id = ${req.params.id}::uuid
      ORDER BY created_at ASC`;
    res.json(msgs.map(m => ({
      id: m.id, role: m.role, content: m.content, citations: m.citations, modelUsed: m.model_used, createdAt: m.created_at,
    })));
  } catch (e) { console.error('[GET /api/chat/sessions/:id/messages]', e); res.status(500).json({ error: 'Internal server error' }); }
});

// POST /api/chat/ask — non-streaming ask
app.post('/api/chat/ask', authenticateToken, chatAskLimiter, async (req: Request, res: Response) => {
  if (process.env.RAG_ENABLED !== 'true') { res.status(503).json({ error: 'El asistente está deshabilitado' }); return; }
  const parsed = ChatAskSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }
  const { question, topK, entityTypes, lang } = parsed.data;
  let { sessionId } = parsed.data;

  try {
    // 1. Create session if not provided
    if (!sessionId) {
      const sessionTitle = question.slice(0, 80);
      const sRows = await prisma.$queryRaw<{ id: string }[]>`
        INSERT INTO "rag_chat_sessions"(id, user_id, title, created_at, updated_at)
        VALUES(gen_random_uuid(), ${req.user!.id}::uuid, ${sessionTitle}, now(), now())
        RETURNING id::text AS id`;
      sessionId = sRows[0].id;
    } else {
      // Verify ownership
      const owner = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM "rag_chat_sessions"
        WHERE id = ${sessionId}::uuid AND user_id = ${req.user!.id}::uuid LIMIT 1`;
      if (!owner.length) { res.status(404).json({ error: 'Session not found' }); return; }
    }

    // 2. Retrieve chunks (ACL pre-filter + kNN)
    const chunks = await ragSearchChunks(question, req.user!.role, topK ?? 6, entityTypes);

    // 3. Build prompt + call LLM
    const messages = buildRagPrompt(question, chunks, lang);
    const start = Date.now();
    const result = await chatWithContext(messages);
    const latencyMs = Date.now() - start;

    // 4. Build citations from chunks
    const citations: Citation[] = chunks.map(c => ({
      entityType:    c.entityType,
      entityId:      c.entityId,
      documentId:    c.documentId,
      documentTitle: c.documentTitle,
      versionNumber: c.versionNumber,
      page:          c.pageStart,
      section:       c.sectionPath,
      snippet:       c.content.slice(0, 200),
    }));

    // 5. Persist messages (user + assistant)
    const queryHash = crypto.createHash('sha256').update(question).digest('hex');
    await prisma.$executeRaw`
      INSERT INTO "rag_chat_messages"(id, session_id, role, content, citations, query_hash, created_at)
      VALUES(gen_random_uuid(), ${sessionId}::uuid, 'user', ${question}, '[]'::jsonb, ${queryHash}, now())`;
    await prisma.$executeRaw`
      INSERT INTO "rag_chat_messages"(id, session_id, role, content, citations, model_used, tokens_used, latency_ms, created_at)
      VALUES(gen_random_uuid(), ${sessionId}::uuid, 'assistant', ${result.content}, ${JSON.stringify(citations)}::jsonb, ${result.model}, ${result.tokensUsed ?? null}, ${latencyMs}, now())`;
    await prisma.$executeRaw`
      UPDATE "rag_chat_sessions" SET updated_at = now() WHERE id = ${sessionId}::uuid`;

    // 6. Audit log (no PII)
    await logAskRag({ userEmail: req.user!.email, sessionId, query: question, citationCount: citations.length, modelUsed: result.model, latencyMs });

    res.json({ sessionId, answer: result.content, citations, modelUsed: result.model, latencyMs });
  } catch (e) {
    console.error('[POST /api/chat/ask]', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/chat/ask/stream — SSE streaming ask
app.post('/api/chat/ask/stream', authenticateToken, chatAskLimiter, async (req: Request, res: Response) => {
  if (process.env.RAG_ENABLED !== 'true') { res.status(503).json({ error: 'El asistente está deshabilitado' }); return; }
  const parsed = ChatAskSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid request' }); return; }
  const { question, topK, entityTypes, lang } = parsed.data;
  let { sessionId } = parsed.data;

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // 1. Create or verify session
    if (!sessionId) {
      const sessionTitle = question.slice(0, 80);
      const sRows = await prisma.$queryRaw<{ id: string }[]>`
        INSERT INTO "rag_chat_sessions"(id, user_id, title, created_at, updated_at)
        VALUES(gen_random_uuid(), ${req.user!.id}::uuid, ${sessionTitle}, now(), now())
        RETURNING id::text AS id`;
      sessionId = sRows[0].id;
    } else {
      const owner = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id::text AS id FROM "rag_chat_sessions"
        WHERE id = ${sessionId}::uuid AND user_id = ${req.user!.id}::uuid LIMIT 1`;
      if (!owner.length) { send('error', { message: 'Session not found' }); res.end(); return; }
    }

    send('session', { sessionId });

    // 2. Retrieve chunks
    const chunks = await ragSearchChunks(question, req.user!.role, topK ?? 6, entityTypes);

    const citations: Citation[] = chunks.map(c => ({
      entityType:    c.entityType,
      entityId:      c.entityId,
      documentId:    c.documentId,
      documentTitle: c.documentTitle,
      versionNumber: c.versionNumber,
      page:          c.pageStart,
      section:       c.sectionPath,
      snippet:       c.content.slice(0, 200),
    }));
    send('citations', citations);

    // 3. Persist user message immediately
    const queryHash = crypto.createHash('sha256').update(question).digest('hex');
    await prisma.$executeRaw`
      INSERT INTO "rag_chat_messages"(id, session_id, role, content, citations, query_hash, created_at)
      VALUES(gen_random_uuid(), ${sessionId}::uuid, 'user', ${question}, '[]'::jsonb, ${queryHash}, now())`;

    // 4. Stream LLM tokens
    const messages = buildRagPrompt(question, chunks, lang);
    const start = Date.now();
    let assistantText = '';
    const { model, tokensUsed } = await streamChatWithContext(messages, (token) => {
      assistantText += token;
      send('token', { t: token });
    });
    const latencyMs = Date.now() - start;

    // 5. Persist assistant message
    await prisma.$executeRaw`
      INSERT INTO "rag_chat_messages"(id, session_id, role, content, citations, model_used, tokens_used, latency_ms, created_at)
      VALUES(gen_random_uuid(), ${sessionId}::uuid, 'assistant', ${assistantText}, ${JSON.stringify(citations)}::jsonb, ${model}, ${tokensUsed ?? null}, ${latencyMs}, now())`;
    await prisma.$executeRaw`
      UPDATE "rag_chat_sessions" SET updated_at = now() WHERE id = ${sessionId}::uuid`;

    // 6. Audit
    await logAskRag({ userEmail: req.user!.email, sessionId, query: question, citationCount: citations.length, modelUsed: model, latencyMs });

    send('done', { modelUsed: model, latencyMs, tokensUsed });
    res.end();
  } catch (e) {
    console.error('[POST /api/chat/ask/stream]', e);
    try { send('error', { message: 'Internal server error' }); } catch {}
    res.end();
  }
});

// ─── Server ───────────────────────────────────────────────────────────────────
// TLS is terminated by the nginx gateway; the backend always starts as plain
// HTTP on PORT (default 3000) and is NOT exposed to the host.

app.listen(PORT, () => {
  console.log(`🚀 CMDB API running at http://localhost:${PORT} (internal — TLS via nginx)`);
  console.log(`   Allowed CORS origins: ${ALLOWED_ORIGINS.join(', ')}`);
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Closing Prisma connection...');
  await prisma.$disconnect();
  process.exit(0);
});
