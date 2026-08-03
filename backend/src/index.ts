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
import { runAlertsPipeline } from './modules/alerts/pipeline';
import { authenticateLDAP, type LdapUserIdentity } from './services/ldap';
import { parseLoginIdentifier } from './services/ldapIdentity';
import {
  isGroupGateEnabled, isUserInRequiredGroup, decideGroupGate,
  LdapDirectoryError, type LdapDirectoryErrorCode,
} from './services/ldapDirectory';
import { lookupEolWithFallbacks } from './services/eolService';
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
  isOllamaHealthy,
  analyzeDocumentForImport,
  analyzeCIRowForImport,
  type BulkAnalysisRaw, type CIRowRaw,
} from './services/ragService';
import {
  vulnUuid, getContractRoot, getLicenseRoot,
} from './services/entitySerializer';
import { createRagQueue, type RagEntityType } from './modules/ai/queue';
import { createAiRouter }                     from './modules/ai/router';
import { createDcimRouter } from './modules/dcim/router';
import { requireDcimAccess } from './modules/dcim/middleware';
import { CIPlacementSchema } from './modules/dcim/schemas';
import { createStaffScheduleRouter } from './modules/staff-schedule/router';
import { requireScheduleAccess } from './modules/staff-schedule/middleware';
import { createDecommissionRouter } from './modules/decommission/router';
import { createCatalogRouter } from './modules/catalog/router';
import { createAlertsRouter } from './modules/alerts/router';
import { startAlertScheduler } from './modules/alerts/scheduler';
import { provisionOnBoot } from './modules/n8n-provisioning/onBoot';
import { VALID_RELATION_TYPES, validateRelationCiTypes } from './relationTypes';
import { emitHook, initializePluginEngine } from './modules/plugins/index';
import { createSettingsRouter } from './modules/settings/router';
import { createVendorsRouter }        from './modules/vendors/router';
import { createIntegrationsRouter }   from './modules/integrations/router';
import { createVulnImportRouter }     from './modules/vuln-import/router';
import { recoverOrphanedRunningBatches } from './modules/vuln-import/queries';
import { createLicensesRouter }       from './modules/licenses/router';
import { createContractsRouter }      from './modules/contracts/router';
import { createMastersRouter }        from './modules/masters/router';
import { createDocumentsRouter, createBulkQueueProcessor } from './modules/documents/router';
import { createInternalRouter }       from './modules/internal/router';
import { createTimelineRouter }       from './modules/timeline/router';
import { createReportsRouter }        from './modules/reports/index';
import { createN8nProvisioningRouter } from './modules/n8n-provisioning/router';
import { docVisibilitySqlCol }        from './shared/utils/docVisibility';
import { UserRole, JwtPayload }  from './shared/types';
import { createAuthenticateToken, COOKIE_NAME } from './shared/middleware/authenticate';
import { requireAdmin }     from './shared/middleware/requireAdmin';
import { requireAudit }     from './shared/middleware/requireAudit';
import { requireUuidParam } from './shared/middleware/requireUuidParam';
import { requireSecurityRead } from './shared/middleware/requireSecurity';
import { escapeLike }       from './shared/utils/likeEscape';
import { buildAuditDetails } from './shared/utils/audit';

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
const { queueEntityForIndexing, purgeEntityFromRag, processRagQueue } = createRagQueue(prisma);
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

// UserRole, JwtPayload, req.user augmentation → shared/types.ts
// escapeLike, buildAuditDetails                → shared/utils/

// Used in legacy CI handlers (outside v2.9.0 scope) for inline UUID validation.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

// ── Raised body-size limit for the Greenbone upload route (spec D10) ─────────
// A multi-host Greenbone scan export can exceed the app-wide 2MB JSON limit
// below; nginx already allows up to 50MB. Express matches middleware in
// registration order, so a path-scoped parser registered here — ahead of the
// blanket `express.json({limit:'2mb'})` — gets first crack at this one route
// and parses (or 413s) against the 20MB ceiling before the global 2MB parser
// ever sees the request. For every other path this middleware simply does
// not match, so the global 2MB limit still applies unchanged everywhere
// else. (Registering the raised limit only inside the vuln-import router
// does NOT work: that router is mounted after this global parser below, so
// the global 2MB parser would already have rejected — or already parsed —
// the body by the time the router's own middleware runs.)
app.use('/api/vuln-import/upload', express.json({ limit: '20mb' }));
// Same ceiling, same reasoning, for POST /api/integrations/crowdstrike
// (v3.6.1): a real CrowdStrike Spotlight export is ~686KB for a SINGLE
// host (docs/mocks/crowdstrike_SRV-MYGESTR01D.json) — a multi-host export
// easily exceeds the 2MB global limit. Must stay registered here, ahead of
// the blanket parser below, for the identical reason as the vuln-import
// route above.
app.use('/api/integrations/crowdstrike', express.json({ limit: '20mb' }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// COOKIE_NAME imported from shared/middleware/authenticate
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
// Skip /api/internal/* — those endpoints have their own auth (M2M token / n8n-gate JWT)
// and are only reachable from nginx subrequests or the internal container network.
// Counting auth_request subrequests (one per n8n asset) against the same IP limit
// would exhaust the quota in seconds during n8n page load.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  skip: (req: Request) => req.path.startsWith('/internal/'),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Demasiadas peticiones. Inténtelo de nuevo en un momento.' },
});

app.use('/api/', apiLimiter);

// Instantiate after prisma is created; const cannot be hoisted like function declarations.
const authenticateToken = createAuthenticateToken(prisma);

// Settings module — GET /theme and GET /logo are public; writes require ADMIN (enforced in router)
app.use('/api/settings', createSettingsRouter(prisma));

// Vendors module — all authenticated; writes require ADMIN (enforced in router)
app.use('/api/vendors', createVendorsRouter(prisma));

// Integrations module — Greenbone + CrowdStrike; all routes require ADMIN (enforced in router)
app.use('/api/integrations', createIntegrationsRouter(
  prisma,
  (t, id) => queueEntityForIndexing(t as RagEntityType, id),
));

// Vuln-import module (v3.6.0) — Greenbone real-format staging/review workflow;
// its own module per spec D9, not grown onto the legacy /api/integrations/greenbone
// endpoint (left untouched). Writes require ADMIN, reads require ADMIN/AUDITOR
// (enforced per-route in the router).
app.use('/api/vuln-import', createVulnImportRouter(prisma, {
  queueEntity: (t, id) => queueEntityForIndexing(t as RagEntityType, id),
}));

// Contracts module — CRUD, doc/CI associations; writes require ADMIN (enforced in router)
app.use('/api/contracts', createContractsRouter(
  prisma,
  (t, id) => queueEntityForIndexing(t as RagEntityType, id),
));

// Licenses module — CRUD, CI/doc/user associations; writes require ADMIN (enforced in router)
app.use('/api/licenses', createLicensesRouter(
  prisma,
  (t, id) => queueEntityForIndexing(t as RagEntityType, id),
  (t, id) => purgeEntityFromRag(t as RagEntityType, id),
));

// Masters module — all master data CRUD (/api/masters/*); writes require ADMIN (enforced in router)
app.use('/api/masters', createMastersRouter(prisma, {
  queueEntity: (t, id) => queueEntityForIndexing(t as RagEntityType, id),
}));

// AI module — RAG admin ops (/api/admin/rag/*) + chat assistant (/api/chat/*)
app.use('/api', createAiRouter(prisma));

// Documents module — CRUD + upload + versioning + bulk import; writes require ADMIN (enforced in router)
app.use('/api/documents', createDocumentsRouter(
  prisma,
  (t, id) => queueEntityForIndexing(t as RagEntityType, id),
));

// DCIM module — VIEWER role blocked at router level via requireDcimAccess
app.use('/api/dcim', authenticateToken, requireDcimAccess, createDcimRouter(prisma));

// Staff Schedule module (v3.5.0) — VIEWER role blocked via requireScheduleAccess
app.use('/api/staff-schedule', authenticateToken, requireScheduleAccess, createStaffScheduleRouter(prisma));

// Decommission module — VIEWER role gets read-only; writes require ADMIN (enforced in router)
app.use('/api/decommission', authenticateToken, createDecommissionRouter(prisma, {
  queueEntity: (type, id) => queueEntityForIndexing(type as RagEntityType, id),
  purgeEntity: (type, id) => purgeEntityFromRag(type as RagEntityType, id),
}));

// Catalog module — master data (OS, etc.); reads open to all authenticated roles
app.use('/api/catalog', authenticateToken, createCatalogRouter(prisma));
app.use('/api/alerts', authenticateToken, createAlertsRouter(prisma));

// Timeline module — read-only Gantt data; all authenticated roles allowed (VIEWER+)
app.use('/api/timeline', authenticateToken, createTimelineRouter(prisma));

// Reports module — 10 core reports + plugin-extensible registry; RBAC per report
app.use('/api/reports', authenticateToken, createReportsRouter(prisma));

// n8n Provisioning — resync bajo demanda (ADMIN only)
app.use('/api/admin/n8n', authenticateToken, requireAdmin, createN8nProvisioningRouter(prisma));

// ── Internal M2M router — /api/internal/* ────────────────────────────────────
// Accessible ONLY from the internal Podman network (n8n-workers → backend).
// nginx blocks this path externally (deny all → 404) as defense-in-depth.
// Endpoints authenticate via X-CMDB-Service-Token (timingSafeEqual comparison).
// RAG queue functions injected here so the internal router can dispatch them
// without moving their complex closures out of index.ts.
app.use('/api/internal', createInternalRouter(prisma, {
  processRagQueue,
  processBulkImportQueue: createBulkQueueProcessor(prisma),
  processCIBulkImportQueue,
}, (t, id) => queueEntityForIndexing(t as RagEntityType, id)));

// ── Zod schemas (input validation) ───────────────────────────────────────────

// Login identifier: local/SSO email, bare sAMAccountName, or NetBIOS DOMAIN\sam.
// Charset is allowlisted (A03 defense-in-depth) — actual LDAP escaping happens
// in services/ldap.ts before any directory query.
const SAM_LOGIN_REGEX     = /^[A-Za-z0-9._-]+$/;
const NETBIOS_LOGIN_REGEX = /^[A-Za-z0-9._-]+\\[A-Za-z0-9._-]+$/;

const LoginSchema = z.object({
  email: z.string().min(1, 'El identificador de acceso es obligatorio').max(254)
    .refine(
      (v) => z.string().email().safeParse(v).success || SAM_LOGIN_REGEX.test(v) || NETBIOS_LOGIN_REGEX.test(v),
      'Identificador de acceso inválido'
    ),
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
  // Infrastructure specs (v2.7.0 T6)
  cpuModel:          z.string().max(255).optional().nullable(),
  vCpus:             z.number().int().min(1).max(4096).optional().nullable(),
  ram:               z.string().max(100).optional().nullable(),
  disk:              z.string().max(100).optional().nullable(),
  adminIp:           z.string().ip().optional().nullable().or(z.literal('')),
  mgmtIp:            z.string().ip().optional().nullable().or(z.literal('')),
  hostName:          z.string().max(255).optional().nullable(),
  clusterName:       z.string().max(255).optional().nullable(),
  operatingSystemId: z.string().uuid().optional().nullable(),
  firmwareVersion:   z.string().max(100).optional().nullable(),
  dns:               z.string().max(255).optional().nullable(),
});

// D3 (v2.7.0): cpuModel only applies to physical servers, vCpus only to virtual ones.
const INFRA_PHYSICAL_CI_TYPES = ['PHYSICAL_SERVER'];
const INFRA_VIRTUAL_CI_TYPES  = ['VIRTUAL_SERVER', 'CLOUD_INSTANCE'];

async function validateInfraFieldsForType(
  ciTypeId: string | null | undefined,
  cpuModel: string | null | undefined,
  vCpus:    number | null | undefined,
): Promise<string | null> {
  if (cpuModel && vCpus != null) {
    return 'cpuModel (servidor físico) y vCpus (servidor virtual) son mutuamente excluyentes';
  }
  if (!ciTypeId) return null;
  const t = await prisma.cIType.findUnique({ where: { id: ciTypeId }, select: { code: true } });
  if (!t) return null;
  if (INFRA_PHYSICAL_CI_TYPES.includes(t.code) && vCpus != null) {
    return `vCpus no aplica a un CI de tipo ${t.code} (físico) — use cpuModel`;
  }
  if (INFRA_VIRTUAL_CI_TYPES.includes(t.code) && cpuModel) {
    return `cpuModel no aplica a un CI de tipo ${t.code} (virtual) — use vCpus`;
  }
  return null;
}

// G2 (v3.5.3): hypervisorId is mandatory for VIRTUAL_SERVER CIs (NOT CLOUD_INSTANCE — scoped narrowly by design).
const REQUIRES_HYPERVISOR_CI_TYPES = ['VIRTUAL_SERVER'];

async function validateHypervisorRequired(
  ciTypeId: string | null | undefined,
  hypervisorId: string | null | undefined,
): Promise<string | null> {
  if (!ciTypeId) return null;
  const t = await prisma.cIType.findUnique({ where: { id: ciTypeId }, select: { code: true } });
  if (!t) return null;
  if (REQUIRES_HYPERVISOR_CI_TYPES.includes(t.code) && !hypervisorId) {
    return `hypervisorId es obligatorio para un CI de tipo ${t.code} (Servidor Virtual)`;
  }
  return null;
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

/**
 * Returns true if the password matches any of the last N history entries.
 * Takes a Prisma.TransactionClient (the base PrismaClient is also assignable
 * to it structurally) so callers can run this inside an enclosing
 * prisma.$transaction(...) alongside the audit-log insert.
 */
async function isPasswordInHistory(db: Prisma.TransactionClient, userId: string, newPassword: string): Promise<boolean> {
  type HistRow = { hash: string };
  const history = await db.$queryRaw<HistRow[]>`
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

/**
 * Inserts a new hash into password_history and prunes entries beyond the limit.
 * Takes a Prisma.TransactionClient (see isPasswordInHistory above) so this
 * mutation can be part of the same transaction as the password UPDATE and
 * the audit-log insert.
 */
async function recordPasswordHistory(db: Prisma.TransactionClient, userId: string, hash: string): Promise<void> {
  await db.$executeRaw`
    INSERT INTO "password_history"(id, user_id, hash, created_at)
    VALUES(gen_random_uuid(), ${userId}::uuid, ${hash}, now())
  `;
  // Prune old entries beyond the configured limit
  await db.$executeRaw`
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
  branch:    { select: { id: true, name: true } },
  businessOwner: { select: { id: true, username: true, email: true } },
  technicalLead: { select: { id: true, username: true, email: true } },
  parentCI:  { select: { id: true, name: true, apiSlug: true } },
  childCIs:  { select: { id: true, name: true, apiSlug: true } },
  ciTypeDef: { select: { id: true, code: true, name: true, categoryCode: true } },
  ciModel:   { select: { id: true, name: true, eolDate: true, eosDate: true, manufacturer: { select: { id: true, name: true } } } },
  operatingSystem: { select: { id: true, name: true, version: true } },
  lifecycleDates: { select: { dateValue: true, dateType: { select: { code: true } } } },
  // v3.4.4 — INSTALLED_IN containment (blade/module → enclosure/converged)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  relationsFrom: {
    where: { relationType: 'INSTALLED_IN' } as any, // v3.4.4: enum value added by migration; client regenerated at container build
    select: { id: true, targetCI: { select: { id: true, name: true, status: true } } },
  },
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
  const { ciTypeDef, ciTypeId, ciModel, relationsFrom, ...rest } = ci;
  const eolEffective = ci.eolDate ?? ciModel?.eolDate ?? null;
  const eosEffective = ci.eosDate ?? ciModel?.eosDate ?? null;
  // v3.4.4 — INSTALLED_IN containment: at most one active relation per source (DB-enforced)
  const installedIn = relationsFrom?.[0] ?? null;
  return {
    ...rest,
    ciTypeId:   ciTypeDef?.id           ?? null,
    ciType:     ciTypeDef?.code         ?? null,
    ciTypeName: ciTypeDef?.name         ?? null,
    ciTypeCategoryCode: ciTypeDef?.categoryCode ?? null,
    eolEffective:  eolEffective,
    eosEffective:  eosEffective,
    eolSource:     ci.eolDate  ? 'ci' : (ciModel?.eolDate  ? 'model' : null),
    eosSource:     ci.eosDate  ? 'ci' : (ciModel?.eosDate  ? 'model' : null),
    ciModelName:   ciModel?.name ?? null,
    manufacturerName: ciModel?.manufacturer?.name ?? null,
    installedInRelationId: installedIn?.id ?? null,
    installedInId:         installedIn?.targetCI?.id ?? null,
    installedInName:       installedIn?.targetCI?.name ?? null,
    installedInStatus:     installedIn?.targetCI?.status ?? null,
  };
}

// ─── Vulnerability types ──────────────────────────────────────────────────────

type VulnSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
type VulnStatus   = 'NUEVO' | 'ASIGNADO' | 'EN_CURSO' | 'PARADO' | 'RESUELTO';

interface Vulnerability {
  cve:         string;
  // Identity per spec D1 (v3.6.0 B6): `${oid}@${port}` for entries from the
  // new Greenbone staging module; absent on entries stored before this
  // migration, which fall back to `cve` as their identity (D1b).
  key?:        string;
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

    // ── Create trusted device (SSO auth = trusted, MFA never required) + audit ──
    // Wrapped in one transaction so the device grant and its audit record
    // either both persist or neither does (A.8.15 — no unlogged session write).
    const deviceToken = crypto.randomBytes(32).toString('hex');
    const expiry      = new Date();
    expiry.setDate(expiry.getDate() + (parseInt(process.env.TRUSTED_DEVICE_TTL_DAYS ?? '30', 10) || 30));
    const ua = req.headers['user-agent'] ?? '';
    const ip = req.ip ?? '';
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "trusted_devices" (id, user_id, token, user_agent, ip_address, expires_at, created_at, last_seen_at)
        VALUES (gen_random_uuid(), ${user.id}::uuid, ${deviceToken}, ${ua}, ${ip}, ${expiry}, now(), now())
        ON CONFLICT DO NOTHING
      `;
      await tx.$executeRaw`
        INSERT INTO "audit_logs" (id, action, entity, entity_id, user_email, details, created_at)
        VALUES (gen_random_uuid(), 'LOGIN_SSO', 'User', ${user.id}, ${user.email}, 'Microsoft SSO login', now())
      `;
    });

    // ── Issue JWT ──────────────────────────────────────────────────────────────
    // Signed only after the transaction commits — no external side effects
    // (JWT signing, cookie-setting, res.redirect) belong inside a DB transaction.
    const payload: JwtPayload = {
      id: user.id, username: user.username, email: user.email, role: user.role as UserRole,
    };
    const token = jwt.sign(payload, JWT_SECRET_VALUE, { expiresIn: '8h', algorithm: 'HS256' as const });

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
      id: string; username: string; displayName: string | null; email: string; password: string | null;
      role: string; active: boolean;
      mfa_enabled: boolean; mfa_secret: string | null; mfa_prompted_at: Date | null;
    };

    let user: UserRow | null = null;
    let ldapSuccess = false;

    // The typed identifier only decides HOW to search AD. The local user row
    // is always keyed off the authoritative sAMAccountName AD returns after a
    // successful bind — never off what the caller typed (see D2 in the plan).
    const identifier = parseLoginIdentifier(email);
    const isLocalAccount = identifier.form === 'local';

    if (process.env.USE_LDAP === 'true' && !isLocalAccount) {
      let ad: LdapUserIdentity | null = null;
      try {
        ad = await authenticateLDAP(identifier.value, password, identifier.ldapAttr);
        ldapSuccess = true;
        log.info(`[POST /api/auth/login] LDAP authentication successful for ${identifier.value}`);
      } catch (ldapErr) {
        log.warn('[POST /api/auth/login] LDAP authentication failed, attempting local fallback:', ldapErr);
      }

      const sam = ad?.sAMAccountName?.toLowerCase();
      if (ldapSuccess && !sam) {
        // AD bound successfully but returned no sAMAccountName — cannot key a
        // stable local identity; treat as a failed login rather than guessing.
        log.warn(`[POST /api/auth/login] LDAP bind succeeded but no sAMAccountName returned for ${identifier.value}`);
        ldapSuccess = false;
      }

      // ── Puerta de grupo de seguridad AD (v3.5.10) ────────────────────────────
      // Se evalúa aquí, con el sAMAccountName autoritativo ya resuelto y ANTES
      // de cualquier auto-heal o auto-provisión: un usuario sin derecho de
      // acceso no debe llegar siquiera a tener fila en la aplicación.
      if (ldapSuccess && sam) {
        let member: boolean | null = null;
        let gateError: LdapDirectoryErrorCode | null = null;
        const gateEnabled = isGroupGateEnabled();

        if (gateEnabled) {
          try {
            member = await isUserInRequiredGroup(sam);
          } catch (e) {
            gateError = e instanceof LdapDirectoryError ? e.code : 'UNAVAILABLE';
            log.error(`[POST /api/auth/login] LDAP_GROUP_CHECK_UNAVAILABLE (${gateError}) al verificar el grupo requerido`);
          }
        }

        const decision = decideGroupGate({ enabled: gateEnabled, member, error: gateError });

        if (decision === 'DENY_UNAVAILABLE') {
          // Fail-closed (D7): no se pudo comprobar la política, así que no se
          // entra. No se toca la fila local — el usuario puede ser perfectamente
          // legítimo y el problema estar en el directorio. Las cuentas locales
          // no pasan por esta rama, de modo que un directorio caído nunca deja
          // al administrador fuera del sistema (ISO 22301).
          res.status(401).json({ error: 'Invalid credentials' });
          return;
        }

        if (decision === 'DENY_AND_DEACTIVATE') {
          const existing = await prisma.$queryRaw<{ id: string }[]>`
            SELECT id::text AS id FROM "users"
            WHERE sso_external_id = ${sam} AND sso_provider = 'ldap' LIMIT 1
          `;
          if (existing.length > 0) {
            // Mutación + auditoría en la MISMA transacción (#172, A.8.15): si el
            // registro falla, la desactivación revierte y no queda una escritura
            // sin rastro.
            await prisma.$transaction(async (tx) => {
              await tx.$executeRaw`
                UPDATE "users" SET active = false, updated_at = now()
                WHERE id = ${existing[0].id}::uuid
              `;
              await tx.$executeRaw`
                INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, details, created_at)
                VALUES(gen_random_uuid(), 'LDAP_GROUP_DENIED', 'User', ${existing[0].id}::uuid,
                       'system@cmdb.local',
                       ${JSON.stringify({ reason: 'not_in_required_group' })}::jsonb, now())
              `;
            });
          }
          // Solo el id técnico en el log, nunca el email ni el nombre (GDPR).
          log.warn(`[POST /api/auth/login] acceso denegado: cuenta LDAP fuera del grupo requerido (userId=${existing[0]?.id ?? 'sin fila local'})`);
          // Mensaje idéntico al de credenciales erróneas: no revelar que la
          // cuenta existe pero carece de grupo (enumeración de usuarios).
          res.status(401).json({ error: 'Invalid credentials' });
          return;
        }
      }

      if (ldapSuccess && sam && ad) {
        let rows = await prisma.$queryRaw<UserRow[]>`
          SELECT id, username, display_name AS "displayName", email, password, role, COALESCE(active, true) AS active,
                 mfa_enabled, mfa_secret, mfa_prompted_at
          FROM "users" WHERE sso_external_id = ${sam} AND sso_provider = 'ldap' LIMIT 1
        `;

        if (rows.length === 0 && ad.mail) {
          // Auto-heal: a shadow user provisioned before the AD-identity migration
          // (keyed by email) now authenticates — bind it to the authoritative sam.
          const byMail = await prisma.$queryRaw<{ id: string }[]>`
            SELECT id FROM "users" WHERE lower(email) = lower(${ad.mail}) LIMIT 1
          `;
          if (byMail.length > 0) {
            await prisma.$executeRaw`
              UPDATE "users" SET sso_external_id = ${sam}, sso_provider = 'ldap', updated_at = now()
              WHERE id = ${byMail[0].id}::uuid
            `;
            await prisma.$executeRaw`
              INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
              VALUES(gen_random_uuid(), 'UPDATE', 'User', ${byMail[0].id}::uuid, ${ad.mail}, now())
            `;
            rows = await prisma.$queryRaw<UserRow[]>`
              SELECT id, username, display_name AS "displayName", email, password, role, COALESCE(active, true) AS active,
                     mfa_enabled, mfa_secret, mfa_prompted_at
              FROM "users" WHERE id = ${byMail[0].id}::uuid LIMIT 1
            `;
            log.info(`[POST /api/auth/login] Auto-healed LDAP identity mapping for ${ad.mail} -> ${sam}`);
          }
        }

        if (rows.length === 0) {
          const username       = ad.sAMAccountName!;
          const provisionEmail = ad.mail ?? `${sam}@${process.env.LDAP_UPN_SUFFIX || 'ldap.local'}`;
          const dummyHash      = await bcrypt.hash(`ldap-provisioned-${Date.now()}`, BCRYPT_ROUNDS);
          try {
            const inserted = await prisma.$queryRaw<{ id: string }[]>`
              INSERT INTO "users" (id, username, email, password, role, sso_external_id, sso_provider, display_name, created_at, updated_at)
              VALUES (gen_random_uuid(), ${username}, ${provisionEmail}, ${dummyHash}, 'VIEWER', ${sam}, 'ldap', ${ad.displayName ?? null}, now(), now())
              RETURNING id
            `;
            await prisma.$executeRaw`
              INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
              VALUES(gen_random_uuid(), 'CREATE', 'User', ${inserted[0].id}::uuid, ${provisionEmail}, now())
            `;
            rows = await prisma.$queryRaw<UserRow[]>`
              SELECT id, username, display_name AS "displayName", email, password, role, COALESCE(active, true) AS active,
                     mfa_enabled, mfa_secret, mfa_prompted_at
              FROM "users" WHERE id = ${inserted[0].id}::uuid LIMIT 1
            `;
            log.info(`[POST /api/auth/login] Auto-provisioned LDAP shadow user: ${username}`);
          } catch (provisionErr) {
            // Unique constraint collision on username/email, or other DB error —
            // surface a generic message, log details internally (A09 — never
            // leak Prisma/DB internals in the API response).
            log.error('[POST /api/auth/login] LDAP auto-provisioning failed:', provisionErr);
            res.status(500).json({ error: 'No se pudo completar el inicio de sesión. Contacte con el administrador.' });
            return;
          }
        }
        user = rows[0];

        // v3.5.10 — El directorio es la fuente de verdad del nombre para
        // mostrar: se refresca en cada login si ha cambiado. No se audita (no
        // es un cambio de gobernanza ni de acceso) y el valor no se escribe en
        // ningún log, por ser dato personal.
        if (ad.displayName) {
          await prisma.$executeRaw`
            UPDATE "users" SET display_name = ${ad.displayName}, updated_at = now()
            WHERE id = ${user.id}::uuid AND display_name IS DISTINCT FROM ${ad.displayName}
          `;
        }
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
        SELECT id, username, display_name AS "displayName", email, password, role, COALESCE(active, true) AS active,
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
    const userObj = () => ({ id: user!.id, username: user!.username, displayName: user!.displayName, email: user!.email, role: user!.role, mfa_enabled: user!.mfa_enabled });

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
          try { await emitHook('postLogin', { userId: user!.id, role: user!.role, email: user!.email }); } catch(e) { console.error('[plugin-hook] postLogin', e); }
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
      try { await emitHook('postLogin', { userId: user!.id, role: user!.role, email: user!.email }); } catch(e) { console.error('[plugin-hook] postLogin', e); }
      res.json({ token: t2, user: userObj(), ...(newDeviceToken ? { deviceToken: newDeviceToken } : {}) });
      return;
    }

    // ── MFA not enabled: check if setup is needed ─────────────────────────────
    if (user.role === 'ADMIN') {
      // Admin: mandatory MFA setup — issue short-lived limited token
      const limitedPayload: JwtPayload = { id: user.id, username: user.username, email: user.email, role: user.role as UserRole, mfaSetupRequired: true };
      const limitedToken = jwt.sign(limitedPayload, JWT_SECRET_VALUE, { expiresIn: '15m', algorithm: 'HS256' as const });
      setAuthCookie(res, limitedToken);
      // postLogin not emitted for limited token — MFA setup not complete yet
      res.json({ token: limitedToken, user: userObj(), requireAction: 'MFA_SETUP_REQUIRED' });
      return;
    }

    // Non-admin: suggest MFA on first login
    if (!user.mfa_prompted_at) {
      await prisma.$executeRaw`UPDATE "users" SET mfa_prompted_at = now(), updated_at = now() WHERE id = ${user.id}::uuid`;
      const t4a = signFullToken();
      setAuthCookie(res, t4a);
      try { await emitHook('postLogin', { userId: user.id, role: user.role, email: user.email }); } catch(e) { console.error('[plugin-hook] postLogin', e); }
      res.json({ token: t4a, user: userObj(), requireAction: 'MFA_SETUP_SUGGESTED' });
      return;
    }

    // Normal login (non-admin, already prompted before or MFA skipped)
    const t4b = signFullToken();
    setAuthCookie(res, t4b);
    try { await emitHook('postLogin', { userId: user.id, role: user.role, email: user.email }); } catch(e) { console.error('[plugin-hook] postLogin', e); }
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
    type UserRow = { id: string; username: string; displayName: string | null; email: string; role: string; active: boolean; sso_external_id: string | null; mfa_enabled: boolean; created_at: Date };
    const users = await prisma.$queryRaw<UserRow[]>`
      SELECT id, username, display_name AS "displayName", email, role,
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
  if (!role || !(['ADMIN', 'AUDITOR', 'VIEWER', 'MANAGER', 'SOC'] as string[]).includes(role)) {
    res.status(400).json({ error: 'role must be "ADMIN", "AUDITOR", "VIEWER", "MANAGER" or "SOC"' });
    return;
  }
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "users" SET role = ${role}::"UserRole", updated_at = now() WHERE id = ${id}::uuid`;
      await tx.$executeRaw`
        INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
        VALUES(gen_random_uuid(), ${'SET_ROLE:' + role}, 'USER', ${id}, ${req.user!.email}, now())
      `;
    });
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
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "users" SET active = ${active}, updated_at = now() WHERE id = ${id}::uuid`;
      await tx.$executeRaw`
        INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
        VALUES(gen_random_uuid(), ${active ? 'ACTIVATE_USER' : 'DEACTIVATE_USER'}, 'USER', ${id}, ${req.user!.email}, now())
      `;
    });
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
    const inHistory = await isPasswordInHistory(prisma, user.id, newPassword);
    if (inHistory) {
      res.status(422).json({ error: 'PASSWORD_HISTORY', message: `No puedes reutilizar ninguna de tus últimas ${PASSWORD_HISTORY_COUNT} contraseñas.` });
      return;
    }

    // Apply change
    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "users" SET password = ${newHash}, updated_at = now() WHERE id = ${user.id}::uuid`;
      await recordPasswordHistory(tx, user.id, newHash);
      await tx.$executeRaw`
        INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
        VALUES(gen_random_uuid(), 'CHANGE_PASSWORD', 'USER', ${user.id}, ${req.user!.email}, now())
      `;
    });

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
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "users" SET password = ${newHash}, updated_at = now() WHERE id = ${id}::uuid`;
      await recordPasswordHistory(tx, user.id, newHash);
      await tx.$executeRaw`
        INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
        VALUES(gen_random_uuid(), 'RESET_PASSWORD', 'USER', ${id}, ${req.user!.email}, now())
      `;
    });

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
 *   3. Hard-deletes trusted_devices, password_history, and (v3.5.0) schedule_entries +
 *      department_managers — all cascade from the user delete below (ON DELETE CASCADE)
 *   4. Hard-deletes the user row
 *
 * The audit trail sequence is preserved (action/entity/timestamps intact).
 * The requesting admin cannot erase their own account.
 *
 * v3.5.0: schedule_entries carries daily whereabouts + a special-category
 * subset (BAJA_MEDICA/BAJA_PATERNIDAD) as Art.9 health data — its FK to
 * users is ON DELETE CASCADE precisely so this endpoint keeps working
 * without a separate erasure branch (docs/PLAN_v3.5.0.md D6).
 */
app.delete('/api/admin/users/:id', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  const targetId = req.params.id as string;

  // Prevent self-erasure
  if (targetId === req.user!.id) {
    res.status(400).json({ error: 'You cannot erase your own account.' });
    return;
  }

  try {
    const pseudoToken = await prisma.$transaction(async (tx) => {
      // 1. Resolve the user and get their email
      const rows = await tx.$queryRaw<{ id: string; email: string; username: string }[]>`
        SELECT id::text AS id, email, username FROM "users" WHERE id = ${targetId}::uuid LIMIT 1
      `;
      if (!rows.length) return null;
      const { email } = rows[0];

      // 2. Pseudonymise audit_logs: replace user_email with a stable, non-reversible token.
      //    The token is deterministic so repeat erasures produce the same result (idempotent).
      const token = '[deleted-' +
        crypto.createHash('sha256').update(email + JWT_SECRET_VALUE).digest('hex').slice(0, 16) +
        ']';
      await tx.$executeRaw`
        UPDATE "audit_logs" SET user_email = ${token} WHERE user_email = ${email}
      `;

      // 3. Hard-delete the user (trusted_devices, password_history, schedule_entries,
      //    department_managers cascade automatically — see FK comments in schema.prisma)
      await tx.$executeRaw`DELETE FROM "users" WHERE id = ${targetId}::uuid`;

      // 4. Record the erasure in the audit log under the admin's email
      await tx.$executeRaw`
        INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
        VALUES(gen_random_uuid(), 'GDPR_ERASURE', 'USER', ${targetId}::uuid, ${req.user!.email}, now())
      `;
      return token;
    });

    if (pseudoToken === null) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }

    log.info(`[DELETE /api/admin/users/${targetId}] GDPR erasure completed by ${req.user!.email}. Audit logs pseudonymised as ${pseudoToken}.`);
    res.json({ message: 'User erased. Audit log entries pseudonymised.' });

  } catch (error) {
    log.error('[DELETE /api/admin/users/:id] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Vendors ──────────────────────────────────────────────────────────────────

// ── Configuration Items ───────────────────────────────────────────────────────

const CI_MAX_PAGE_SIZE = 250;
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

app.get('/api/cis/:id', authenticateToken, requireUuidParam('id'), async (req: Request, res: Response) => {
  try {
    const ci = await prisma.cI.findUnique({ where: { id: req.params.id as string }, include: CI_INCLUDE });
    if (!ci) { res.status(404).json({ error: 'CI not found' }); return; }
    res.json(flattenCI(ci));
  } catch (err) {
    console.error('[GET /api/cis/:id] Error:', err);
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
      cpuModel, vCpus, ram, disk, adminIp, mgmtIp, hostName, clusterName,
      operatingSystemId, firmwareVersion, dns, hypervisorId, powerState,
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
      cpuModel?: string | null; vCpus?: number | null; ram?: string | null; disk?: string | null;
      adminIp?: string | null; mgmtIp?: string | null; hostName?: string | null; clusterName?: string | null;
      operatingSystemId?: string | null; firmwareVersion?: string | null; dns?: string | null;
      hypervisorId?: string | null; powerState?: string | null;
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

    // D3: physical/virtual infra field exclusion
    const infraErr = await validateInfraFieldsForType(ciTypeId, cpuModel, vCpus);
    if (infraErr) { res.status(400).json({ error: infraErr }); return; }

    // G2: hypervisorId mandatory for VIRTUAL_SERVER
    const hypervisorErr = await validateHypervisorRequired(ciTypeId, hypervisorId);
    if (hypervisorErr) { res.status(400).json({ error: hypervisorErr }); return; }

    // Plugin pre-hook — may cancel creation
    const preCreateCI = await emitHook('preCreateCI', { body: req.body, user: req.user }, 'pre');
    if (preCreateCI?.cancel) {
      res.status(409).json({ error: preCreateCI.reason ?? 'Blocked by plugin' });
      return;
    }

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

    const ci = await prisma.$transaction(async (tx) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const created = await tx.cI.create({
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
          cpuModel:           cpuModel           || null,
          vCpus:              vCpus              ?? null,
          ram:                ram                || null,
          disk:               disk               || null,
          adminIp:            adminIp            || null,
          mgmtIp:             mgmtIp             || null,
          hostName:           hostName           || null,
          clusterName:        clusterName        || null,
          operatingSystemId:  operatingSystemId  || null,
          firmwareVersion:    firmwareVersion    || null,
          dns:                dns                || null,
          hypervisorId:       hypervisorId       || null,
          powerState:         powerState         || null,
          ...(hardware && { hardware: { create: { serialNumber: hardware.serialNumber, model: hardware.model, manufacturer: hardware.manufacturer } } }),
          ...(software && { software: { create: { version: software.version, licenseType: software.licenseType } } }),
        } as Parameters<typeof prisma.cI.create>[0]['data'],
        include: CI_INCLUDE,
      });

      // Audit log (raw — Prisma client types regenerate after migrate)
      const createDetails = JSON.stringify(buildAuditDetails(`CI "${created.name}" creado`));
      await tx.$executeRaw`
        INSERT INTO "audit_logs" (id, action, entity, entity_id, user_email, details, created_at)
        VALUES (gen_random_uuid(), 'CREATE_CI', 'CI', ${created.id}, ${req.user!.email}, ${createDetails}::jsonb, now())
      `;
      return created;
    });

    // Re-index this entity for the RAG (queue, non-blocking on errors)
    void queueEntityForIndexing('ci', ci.id);

    // Plugin post-hook — fire-and-forget, must not fail the response
    try { await emitHook('postCreateCI', { id: ci.id, body: req.body, user: req.user }); } catch(e) { console.error('[plugin-hook] postCreateCI', e); }

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
 * PATCH /api/cis/bulk-update — apply the same field changes to many CIs at once.
 * ADMIN only. Body: { ciIds: string[]; updates: Partial<CIBulkUpdateFields> }.
 * Only enums and FK ids are exposed (no unique-per-CI fields like name,
 * inventoryNumber, serial, etc., to prevent integrity issues).
 * Atomic transaction: either all CIs are updated or none. AuditLog stores
 * { ciIds, changes } per CI for forensic reconstruction.
 *
 * IMPORTANT: this route MUST be declared before `/api/cis/:id` so Express
 * matches the literal path first — otherwise `:id` captures "bulk-update"
 * and Prisma fails with P2023 (cannot parse as UUID).
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
    // Validate that non-null FK UUIDs reference existing records (prevents P2003 → 500).
    if (updates.ciTypeId) {
      const exists = await prisma.cIType.findUnique({ where: { id: updates.ciTypeId }, select: { id: true } });
      if (!exists) { res.status(400).json({ error: 'El tipo de CI seleccionado no existe. Recargue la página e inténtelo de nuevo.' }); return; }
    }

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
    // P2003 = FK constraint violation (referenced record does not exist)
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === 'P2003') {
      res.status(400).json({ error: 'Uno de los valores seleccionados ya no existe. Recargue la página e inténtelo de nuevo.' });
      return;
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /api/cis/:id
 * Updates a Configuration Item.
 * ADMIN only. `requireUuidParam('id')` rejects non-UUID path params with 400
 * before they reach Prisma (defensive against future route-ordering mistakes).
 */
app.patch('/api/cis/:id', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
  const id = req.params.id as string;
  log.info(`[PATCH /api/cis/${id}] Body received:`, JSON.stringify(req.body, null, 2));

  try {
    const {
      name, criticality, environment, ciTypeId, status, inventoryNumber,
      branchId, ciModelId, businessOwnerId, technicalLeadId,
      eolDate: eolDateRaw, eosDate: eosDateRaw,
      businessImpact, recoveryPriority, rto, rpo, spofRisk, containsPii, dataClassification,
      cpuModel, vCpus, ram, disk, adminIp, mgmtIp, hostName, clusterName,
      operatingSystemId, firmwareVersion, dns, hypervisorId, powerState,
    } = req.body as {
      name?: string; criticality?: Criticality; environment?: Environment;
      ciTypeId?: string | null; status?: string; inventoryNumber?: string;
      branchId?: string | null; ciModelId?: string | null;
      businessOwnerId?: string | null; technicalLeadId?: string | null;
      eolDate?: string | null; eosDate?: string | null;
      businessImpact?: string | null; recoveryPriority?: number | null; rto?: number | null; rpo?: number | null;
      spofRisk?: boolean; containsPii?: boolean; dataClassification?: string | null;
      cpuModel?: string | null; vCpus?: number | null; ram?: string | null; disk?: string | null;
      adminIp?: string | null; mgmtIp?: string | null; hostName?: string | null; clusterName?: string | null;
      operatingSystemId?: string | null; firmwareVersion?: string | null; dns?: string | null;
      hypervisorId?: string | null; powerState?: string | null;
    };

    // Reject any FK field that is a non-null, non-empty string but not a valid UUID
    // (prevents P2023 "invalid UUID" from Prisma when callers send "null"/garbage strings)
    for (const [field, val] of Object.entries({ ciTypeId, branchId, ciModelId, businessOwnerId, technicalLeadId, operatingSystemId, hypervisorId })) {
      if (val !== undefined && val !== null && !UUID_RE.test(val)) {
        res.status(400).json({ error: `El campo ${field} contiene un valor inválido.` });
        return;
      }
    }

    // D3: physical/virtual infra field exclusion (resolve effective ciTypeId if not changing it)
    if (cpuModel !== undefined || vCpus !== undefined) {
      const effectiveTypeId = ciTypeId !== undefined
        ? ciTypeId
        : (await prisma.cI.findUnique({ where: { id }, select: { ciTypeId: true } }))?.ciTypeId ?? null;
      const current = await prisma.cI.findUnique({ where: { id }, select: { cpuModel: true, vCpus: true } });
      const effCpuModel = cpuModel !== undefined ? cpuModel : current?.cpuModel ?? null;
      const effVCpus    = vCpus    !== undefined ? vCpus    : current?.vCpus    ?? null;
      const infraErr = await validateInfraFieldsForType(effectiveTypeId, effCpuModel, effVCpus);
      if (infraErr) { res.status(400).json({ error: infraErr }); return; }
    }

    // G2: hypervisorId mandatory for VIRTUAL_SERVER (resolve effective ciTypeId/hypervisorId if not changing them)
    if (ciTypeId !== undefined || hypervisorId !== undefined) {
      const effectiveTypeId = ciTypeId !== undefined
        ? ciTypeId
        : (await prisma.cI.findUnique({ where: { id }, select: { ciTypeId: true } }))?.ciTypeId ?? null;
      const effHypervisorId = hypervisorId !== undefined
        ? hypervisorId
        : (await prisma.cI.findUnique({ where: { id }, select: { hypervisorId: true } }))?.hypervisorId ?? null;
      const hypervisorErr = await validateHypervisorRequired(effectiveTypeId, effHypervisorId);
      if (hypervisorErr) { res.status(400).json({ error: hypervisorErr }); return; }
    }

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
    if (cpuModel           !== undefined) updateData.cpuModel           = cpuModel           || null;
    if (vCpus              !== undefined) updateData.vCpus              = vCpus              ?? null;
    if (ram                !== undefined) updateData.ram                = ram                || null;
    if (disk               !== undefined) updateData.disk               = disk               || null;
    if (adminIp            !== undefined) updateData.adminIp            = adminIp            || null;
    if (mgmtIp             !== undefined) updateData.mgmtIp             = mgmtIp             || null;
    if (hostName           !== undefined) updateData.hostName           = hostName           || null;
    if (clusterName        !== undefined) updateData.clusterName        = clusterName        || null;
    if (operatingSystemId  !== undefined) updateData.operatingSystemId  = operatingSystemId  || null;
    if (firmwareVersion    !== undefined) updateData.firmwareVersion    = firmwareVersion    || null;
    if (dns                !== undefined) updateData.dns                = dns                || null;
    if (hypervisorId       !== undefined) updateData.hypervisorId       = hypervisorId       || null;
    if (powerState         !== undefined) updateData.powerState         = powerState         || null;

    // Plugin pre-hook — may cancel update
    const preUpdateCI = await emitHook('preUpdateCI', { id, body: req.body, user: req.user }, 'pre');
    if (preUpdateCI?.cancel) {
      res.status(409).json({ error: preUpdateCI.reason ?? 'Blocked by plugin' });
      return;
    }

    const ci = await prisma.$transaction(async (tx) => {
      const updated = await tx.cI.update({
        where: { id },
        data: updateData,
        include: CI_INCLUDE,
      });

      await tx.$executeRaw`
        INSERT INTO "audit_logs" (id, action, entity, entity_id, user_email, created_at)
        VALUES (gen_random_uuid(), 'UPDATE_CI', 'CI', ${id}, ${req.user!.email}, now())
      `;
      return updated;
    });

    // Re-index this entity for the RAG (queue, non-blocking on errors)
    void queueEntityForIndexing('ci', id);

    // Plugin post-hook — fire-and-forget, must not fail the response
    try { await emitHook('postUpdateCI', { id, body: req.body, user: req.user }); } catch(e) { console.error('[plugin-hook] postUpdateCI', e); }

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
app.delete('/api/cis/:id', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
  const id = req.params.id as string;

  try {
    // Plugin pre-hook — may cancel deletion
    const preDeleteCI = await emitHook('preDeleteCI', { id, user: req.user }, 'pre');
    if (preDeleteCI?.cancel) {
      res.status(409).json({ error: preDeleteCI.reason ?? 'Blocked by plugin' });
      return;
    }

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

    // Plugin post-hook — fire-and-forget, must not fail the response
    try { await emitHook('postDeleteCI', { id, user: req.user }); } catch(e) { console.error('[plugin-hook] postDeleteCI', e); }

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
 * Body: { ciId: string, key?: string, cve: string, status: VulnStatus }
 *
 * Identity (spec D1/D1b, v3.6.0 B6): a vulnerability's real identity is
 * `key` (`${oid}@${port}`), not `cve` — 96% of real Greenbone findings carry
 * no CVE. `key` is optional here and preferred when present; `cve` is kept
 * as the deprecated fallback so an unmigrated client (or a stored entry that
 * predates this migration and never got a `key`) still resolves correctly.
 */
app.patch('/api/vulnerabilities', authenticateToken, async (req: Request, res: Response) => {
  const { ciId, key, cve, status } = req.body as {
    ciId:   string;
    key?:   string;
    cve:    string;
    status: VulnStatus;
  };

  if (!ciId || !(key || cve) || !status) {
    res.status(400).json({ error: 'Missing required fields: ciId, cve, status' });
    return;
  }

  // The identity to match against: prefer the caller's `key`, fall back to `cve`.
  const targetKey = key ?? cve;

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
    const vuln = currentVulns.find((v) => (v.key ?? v.cve) === targetKey);

    if (!vuln) {
      res.status(404).json({ error: `Vulnerability ${targetKey} not found in CI ${ciId}` });
      return;
    }

    const updated = currentVulns.map((v) =>
      (v.key ?? v.cve) === targetKey ? { ...v, status, updatedAt: new Date().toISOString() } : v
    );

    // Issue #172: wrap the vulnerabilities-column update + audit insert in one
    // transaction so the audit is never missing when the status change persists.
    //
    // entity_id is `varchar(36)` — sized for a bare UUID — so it must hold
    // just the CI id, never a composite `${ciId}:${targetKey}` string: a
    // real vulnKey (e.g. an OID@port identity) overflows 36 chars and the
    // raw INSERT fails with Postgres error 22001. The vulnerability's own
    // identity goes in `details` instead, which already exists for this.
    const action = `UPDATE_VULN_STATUS:${status}`;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE "configuration_items"
        SET "vulnerabilities" = ${JSON.stringify(updated)}::jsonb
        WHERE "id" = ${ciId}::uuid
      `;

      // Audit log (raw — Prisma client types regenerate after migrate)
      await tx.$executeRaw`
        INSERT INTO "audit_logs" (id, action, entity, entity_id, user_email, details, created_at)
        VALUES (gen_random_uuid(), ${action}, 'VULNERABILITY', ${ciId}, ${req.user!.email}, ${JSON.stringify({ vulnKey: targetKey })}::jsonb, now())
      `;
    });

    // Re-index the vulnerability + its parent CI (whose summary line changed)
    void queueEntityForIndexing('vulnerability', vulnUuid(ciId, targetKey));
    void queueEntityForIndexing('ci', ciId);

    res.json({ ciId, cve, status, message: `Status updated to ${status}` });
  } catch (error) {
    console.error('[PATCH /api/vulnerabilities] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/vulnerabilities/assignable-users
 * Lists the users a vulnerability can be assigned to: active ADMIN/SOC
 * accounts. ADMIN/AUDITOR/SOC may all read this list (requireSecurityRead —
 * same read gate as the rest of the Security area), even though only
 * ADMIN/SOC would actually perform the assignment.
 *
 * Never returns `email` — GDPR Art. 5.1.c data minimisation. Field shape
 * follows the precedent set by the staff-schedule worker selector
 * (`GET /api/staff-schedule/users`, `searchScheduleUsers` in
 * modules/staff-schedule/queries.ts): `{ id, displayName }`, falling back to
 * `username` when `displayName` is null (see staff-schedule/service.ts's
 * `sortRowManagerFirst` comparator, which uses the same `a.displayName ??
 * a.username` fallback expression).
 *
 * Registered before the `?` param-less legacy PATCH route above on the same
 * path prefix is not a concern here (this is GET on a distinct sub-path,
 * `/api/vulnerabilities/assignable-users`, not `/api/vulnerabilities/:id`).
 */
app.get('/api/vulnerabilities/assignable-users', authenticateToken, requireSecurityRead, async (req: Request, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      where: { active: true, role: { in: ['ADMIN', 'SOC'] } },
      select: { id: true, username: true, displayName: true },
      orderBy: { username: 'asc' },
    });

    const assignable = users.map((u) => ({
      id: u.id,
      displayName: u.displayName ?? u.username,
    }));

    res.json(assignable);
  } catch (error) {
    console.error('[GET /api/vulnerabilities/assignable-users] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
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
    const [ciTypes, branches, costCenters, manufacturers, locations] = await Promise.all([
      prisma.$queryRaw<{ code: string; name: string }[]>`SELECT code, name FROM "ci_types" ORDER BY name`,
      prisma.$queryRaw<{ name: string }[]>`SELECT name FROM "branches" ORDER BY name`,
      prisma.$queryRaw<{ name: string }[]>`SELECT name FROM "cost_centers" ORDER BY name`,
      prisma.$queryRaw<{ name: string }[]>`SELECT name FROM "manufacturers" ORDER BY name`,
      prisma.$queryRaw<{ name: string }[]>`SELECT name FROM "locations" ORDER BY name`,
    ]);

    const ciTypeCodes  = ciTypes.map((t) => t.code);
    const branchNames  = branches.map((b) => b.name);
    const ccNames      = costCenters.map((c) => c.name);
    const mfgNames     = manufacturers.map((m) => m.name);
    const locationNames = locations.map((l) => l.name);
    const criticalities = ['LOW', 'MEDIUM', 'HIGH', 'MISSION_CRITICAL'];
    const environments  = ['DEVELOPMENT', 'TESTING', 'STAGING', 'PRODUCTION'];
    const statuses      = ['ACTIVO', 'INACTIVO', 'RETIRADO'];
    const businessImpacts = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
    const dataClassifications = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'];
    const yesNo = ['YES', 'NO'];

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
      // T7 (v2.7.0): cascade-created masters — appended at the end so the
      // hardcoded dataValidation column indices above keep working.
      { key: 'osName',              header: 'osName',               width: 24 },
      { key: 'osVersion',           header: 'osVersion',            width: 16 },
      { key: 'baseSoftwareName',    header: 'baseSoftwareName',     width: 26 },
      { key: 'baseSoftwareVersion', header: 'baseSoftwareVersion',  width: 18 },
      // v2.8.7: infrastructure + GRC fields (cols 25-48, appended to keep existing validations stable)
      { key: 'userDni',            header: 'userDni',               width: 18 },
      { key: 'adminIp',            header: 'adminIp',               width: 18 },
      { key: 'mgmtIp',             header: 'mgmtIp',                width: 18 },
      { key: 'vlan',               header: 'vlan',                  width: 14 },
      { key: 'cpuModel',           header: 'cpuModel',              width: 24 },
      { key: 'vCpus',              header: 'vCpus',                 width: 10 },
      { key: 'ram',                header: 'ram',                   width: 14 },
      { key: 'disk',               header: 'disk',                  width: 14 },
      { key: 'hostName',           header: 'hostName',              width: 24 },
      { key: 'clusterName',        header: 'clusterName',           width: 24 },
      { key: 'firmwareVersion',    header: 'firmwareVersion',       width: 20 },
      { key: 'dns',                header: 'dns',                   width: 24 },
      { key: 'floor',              header: 'floor',                 width: 14 },
      { key: 'room',               header: 'room',                  width: 18 },
      { key: 'rack',               header: 'rack',                  width: 14 },
      { key: 'rackUnit',           header: 'rackUnit',              width: 12 },
      { key: 'location',           header: 'location',              width: 22 },
      { key: 'businessOwner',      header: 'businessOwner (email)', width: 28 },
      { key: 'technicalLead',      header: 'technicalLead (email)', width: 28 },
      { key: 'rto',                header: 'rto (min)',             width: 12 },
      { key: 'rpo',                header: 'rpo (min)',             width: 12 },
      { key: 'recoveryPriority',   header: 'recoveryPriority (1-5)', width: 20 },
      { key: 'spofRisk',           header: 'spofRisk (YES/NO)',     width: 18 },
      { key: 'containsPii',        header: 'containsPii (YES/NO)',  width: 18 },
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
    ws.addRow({ name: 'PROD-SRV-01', ciType: 'PHYSICAL_SERVER', criticality: 'HIGH', environment: 'PRODUCTION', status: 'ACTIVO', manufacturer: mfgNames[0] ?? 'Dell', serialNumber: 'SN-001', model: 'PowerEdge R740', branch: branchNames[0] ?? '', osName: 'Windows Server', osVersion: '2022', baseSoftwareName: 'Oracle Database', baseSoftwareVersion: '19c', cpuModel: 'Intel Xeon Gold 6230', vCpus: 20, ram: '128GB', disk: '2TB SSD', adminIp: '10.1.1.10', mgmtIp: '10.1.2.10', hostName: 'prod-srv-01.local', clusterName: 'cluster-01', firmwareVersion: '2.9.4', dns: '8.8.8.8,8.8.4.4', vlan: '100', floor: 'B1', room: 'CPD-01', rack: 'RACK-A1', rackUnit: '12', location: locationNames[0] ?? '', rto: 60, rpo: 30, recoveryPriority: 1, spofRisk: 'NO', containsPii: 'NO' });
    ws.addRow({ name: 'Office 365 E3', ciType: 'LICENSE', criticality: 'MEDIUM', environment: 'PRODUCTION', status: 'ACTIVO', version: '365', licenseType: 'subscription', eolDate: '2026-12-31', containsPii: 'YES' });

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
      // v2.8.7: new field dropdowns (cols 41, 46-48)
      if (locationNames.length) ws.getCell(r, 41).dataValidation = listVal(`"${locationNames.slice(0, 40).join(',')}"`);
      ws.getCell(r, 46).dataValidation = listVal(`"1,2,3,4,5"`);
      ws.getCell(r, 47).dataValidation = listVal(`"${yesNo.join(',')}"`);
      ws.getCell(r, 48).dataValidation = listVal(`"${yesNo.join(',')}"`);
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
      ['ipAddress',           'Dirección IP de consola de gestión (opcional). Alias de consoleIp.'],
      ['description',         'Descripción libre del CI.'],
      ['osName',              'Nombre del sistema operativo. Se crea el maestro si no existe.'],
      ['osVersion',           'Versión del sistema operativo.'],
      ['baseSoftwareName',    'Nombre del software base (solo PHYSICAL_SERVER, VIRTUAL_SERVER, CLOUD_INSTANCE).'],
      ['baseSoftwareVersion', 'Versión del software base.'],
      ['', ''],
      ['── INFRAESTRUCTURA ──', ''],
      ['userDni',             'DNI / documento de identidad del usuario asignado.'],
      ['adminIp',             'IP de administración fuera de banda.'],
      ['mgmtIp',              'IP de interfaz de gestión (iDRAC, iLO, IPMI, etc.).'],
      ['vlan',                'ID o nombre de VLAN.'],
      ['cpuModel',            'Modelo de procesador (ej: Intel Xeon Gold 6230).'],
      ['vCpus',               'Número de vCPUs (número entero).'],
      ['ram',                 'Memoria RAM (ej: 128GB).'],
      ['disk',                'Almacenamiento total (ej: 2TB SSD).'],
      ['hostName',            'Nombre FQDN del host (ej: srv-01.dominio.local).'],
      ['clusterName',         'Nombre del clúster al que pertenece el CI.'],
      ['firmwareVersion',     'Versión de firmware (BIOS, UEFI, etc.).'],
      ['dns',                 'Servidores DNS (separados por coma).'],
      ['', ''],
      ['── UBICACIÓN FÍSICA ──', ''],
      ['floor',               'Planta o nivel del edificio (ej: B1, P2).'],
      ['room',                'Sala o sala de servidores (ej: CPD-01).'],
      ['rack',                'Identificador del rack (ej: RACK-A1).'],
      ['rackUnit',            'Unidad de rack (ej: 12).'],
      ['location',            `Localización física maestro. Valores: ${locationNames.slice(0, 20).join(', ')}`],
      ['businessOwner',       'Email del propietario de negocio del CI (debe existir en el sistema).'],
      ['technicalLead',       'Email del responsable técnico del CI (debe existir en el sistema).'],
      ['', ''],
      ['── GRC / CONTINUIDAD ──', ''],
      ['rto',                 'Recovery Time Objective en minutos (número entero).'],
      ['rpo',                 'Recovery Point Objective en minutos (número entero).'],
      ['recoveryPriority',    'Prioridad de recuperación 1 (máxima) a 5 (mínima).'],
      ['spofRisk',            'Riesgo de punto único de fallo. Valores: YES, NO.'],
      ['containsPii',         'Contiene datos personales (GDPR). Valores: YES, NO.'],
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
    const { batchId } = await prisma.$transaction(async (tx) => {
      const batchRows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "ci_bulk_import_batch"(id, created_by, status, row_count, created_at, updated_at)
        VALUES(gen_random_uuid(), ${req.user!.email}, 'UPLOADED', ${rows.length}, now(), now())
        RETURNING id::text AS id`;
      const batchId = batchRows[0].id;

      for (let i = 0; i < rows.length; i++) {
        await tx.$executeRaw`
          INSERT INTO "ci_bulk_import_item"(id, batch_id, row_index, raw_data, status, analysis, created_at, updated_at)
          VALUES(gen_random_uuid(), ${batchId}::uuid, ${i + 1}, ${JSON.stringify(rows[i])}::jsonb,
                 'PENDING_ANALYSIS', '{}'::jsonb, now(), now())`;
      }

      await tx.$executeRaw`
        INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, details, created_at)
        VALUES(gen_random_uuid(), 'CI_BULK_UPLOAD', 'CiBulkImportBatch', ${batchId}::uuid, ${req.user!.email},
               ${JSON.stringify({ rowCount: rows.length })}::jsonb, now())`;

      return { batchId };
    });

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
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`DELETE FROM "ci_bulk_import_item" WHERE id = ${req.params.id}::uuid`;
      await recomputeCIBatchStatus(tx, rows[0].batch_id);
      await tx.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CI_BULK_DISCARD_ITEM','CiBulkImportItem',${req.params.id}::uuid,${req.user!.email},now())`;
    });
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
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`DELETE FROM "ci_bulk_import_batch" WHERE id = ${req.params.id}::uuid`;
      await tx.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CI_BULK_DISCARD_BATCH','CiBulkImportBatch',${req.params.id}::uuid,${req.user!.email},now())`;
    });
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
    await recomputeCIBatchStatus(prisma, item.batch_id);
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
    await recomputeCIBatchStatus(prisma, String(req.params.id));
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
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE "ci_bulk_import_item" SET status='PENDING_ANALYSIS', error_message=NULL, updated_at=now()
        WHERE id = ${req.params.id}::uuid`;
      await recomputeCIBatchStatus(tx, rows[0].batch_id);
      await tx.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CI_BULK_REANALYZE_ITEM','CiBulkImportItem',${req.params.id}::uuid,${req.user!.email},now())`;
    });
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
    const count = await prisma.$transaction(async (tx) => {
      const affected = Number(await tx.$executeRaw`
        UPDATE "ci_bulk_import_item" SET status='PENDING_ANALYSIS', error_message=NULL, updated_at=now()
        WHERE batch_id = ${batchIdStr}::uuid AND status IN ('ANALYZED','ERROR')`);
      await recomputeCIBatchStatus(tx, batchIdStr);
      await tx.$executeRaw`
        INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at)
        VALUES(gen_random_uuid(),'CI_BULK_REANALYZE_BATCH','CiBulkImportBatch',${batchIdStr}::uuid,${req.user!.email},
               ${JSON.stringify({ count: affected })}::jsonb, now())`;
      return affected;
    });
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
    // ── Validate optional params ─────────────────────────────────────────────
    const { from, to, entityName } = req.query as { from?: string; to?: string; entityName?: string };
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
    if (entityName && typeof entityName !== 'string') {
      res.status(400).json({ error: 'Invalid "entityName" parameter' });
      return;
    }

    // ── Date WHERE (inner CTE) ───────────────────────────────────────────────
    const dateConds: Prisma.Sql[] = [];
    if (fromDate) dateConds.push(Prisma.sql`al.created_at >= ${fromDate}::timestamptz`);
    if (toDate)   dateConds.push(Prisma.sql`al.created_at <= ${toDate}::timestamptz`);
    const dateWhere = dateConds.length > 0
      ? Prisma.sql`WHERE ${Prisma.join(dateConds, ' AND ')}`
      : Prisma.empty;

    // ── Entity-name LIKE filter (outer CTE, A03-safe) ────────────────────────
    const nameWhere = entityName
      ? Prisma.sql`WHERE entity_name ILIKE ${'%' + escapeLike(entityName.trim()) + '%'} ESCAPE '\\'`
      : Prisma.empty;

    type AuditRow = {
      id: string; action: string; entity: string; entity_id: string;
      user_email: string; created_at: Date; details: unknown; entity_name: string | null;
    };
    const logs = await prisma.$queryRaw<AuditRow[]>`
      WITH al_named AS (
        SELECT
          al.id, al.action, al.entity, al.entity_id, al.user_email, al.created_at, al.details,
          CASE al.entity
            WHEN 'CI'            THEN ci.name
            WHEN 'VULNERABILITY' THEN CONCAT(vuln_ci.name, ' · ', split_part(al.entity_id, ':', 2))
            WHEN 'Document'      THEN doc.title
            WHEN 'USER'          THEN u.email
            WHEN 'CI_RELATION'   THEN CONCAT(src.name, ' → ', tgt.name)
            WHEN 'SYSTEM'        THEN al.entity_id
            ELSE NULL
          END AS entity_name
        FROM audit_logs al
        LEFT JOIN configuration_items ci      ON (CASE WHEN al.entity = 'CI'            THEN al.entity_id::uuid                       ELSE NULL END) = ci.id
        LEFT JOIN configuration_items vuln_ci ON (CASE WHEN al.entity = 'VULNERABILITY' THEN split_part(al.entity_id, ':', 1)::uuid   ELSE NULL END) = vuln_ci.id
        LEFT JOIN documents doc               ON (CASE WHEN al.entity = 'Document'       THEN al.entity_id::uuid                       ELSE NULL END) = doc.id
        LEFT JOIN users u                     ON (CASE WHEN al.entity = 'USER'           THEN al.entity_id::uuid                       ELSE NULL END) = u.id
        LEFT JOIN ci_relations rel            ON (CASE WHEN al.entity = 'CI_RELATION'   THEN al.entity_id::uuid                       ELSE NULL END) = rel.id
        LEFT JOIN configuration_items src ON al.entity = 'CI_RELATION' AND rel.source_ci_id = src.id
        LEFT JOIN configuration_items tgt ON al.entity = 'CI_RELATION' AND rel.target_ci_id = tgt.id
        ${dateWhere}
      )
      SELECT * FROM al_named
      ${nameWhere}
      ORDER BY created_at DESC
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
    // without trusting any client-supplied value. Mutation + audit insert are
    // atomic (A.8.15) — an unlogged mfa_pending_secret write is a gap too.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE "users" SET mfa_pending_secret = ${secret}, updated_at = now() WHERE id = ${req.user!.id}::uuid
      `;
      await tx.$executeRaw`
        INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
        VALUES(gen_random_uuid(), 'MFA_SETUP_INITIATED', 'User', ${req.user!.id}::uuid, ${req.user!.email}, now())`;
    });

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
    // Mutation + audit insert are atomic (A.8.15) — an unlogged mfa_secret
    // write would be a silent auth-bypass audit gap (highest-risk site here).
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE "users"
        SET mfa_secret = ${secret}, mfa_enabled = true, mfa_pending_secret = NULL, updated_at = now()
        WHERE id = ${req.user!.id}::uuid
      `;
      await tx.$executeRaw`
        INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
        VALUES(gen_random_uuid(), 'MFA_ENABLED', 'User', ${req.user!.id}::uuid, ${req.user!.email}, now())
      `;
    });

    // Issue a new full JWT (replaces limited token if admin had mfaSetupRequired).
    // No external side effects (JWT signing, cookie-setting, res.json) belong
    // inside a DB transaction — these run only after the write above commits.
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
// Issue #172 (review fix): the cert file is a single shared on-disk resource with
// no DB row / row lock behind it. Two concurrent uploads (or an upload racing a
// prior request's compensating restore) could interleave writes and leave the
// file and audit_logs permanently diverged. This is a minimal in-process mutex
// scoped to this one route — it does not protect against multi-process/multi-
// replica deployments, only against concurrent requests within this instance.
let certUploadInProgress = false;

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

  if (certUploadInProgress) {
    res.status(409).json({ error: 'Another certificate upload is already in progress. Try again shortly.' });
    return;
  }
  certUploadInProgress = true;

  try {
    const certDir = '/app/certs';
    const certPath = path.join(certDir, 'server.crt');

    // Ensure directory exists (mapped from host via volume)
    fs.mkdirSync(certDir, { recursive: true });

    // Issue #172: the certificate write is a filesystem side effect, not a DB row,
    // so it cannot join a Prisma transaction with the audit insert. To still avoid
    // an unaudited change reaching disk, snapshot whatever was there before (for
    // restore), write the new cert, then audit — if the audit insert fails, undo
    // the filesystem write (restore previous cert / remove if none existed) so the
    // persisted state always matches what's in audit_logs. This restore is itself
    // a best-effort, non-transactional fs write: if it also throws (disk full,
    // permissions changed mid-request, EIO, read-only fs), that is caught
    // separately below and logged loudly (CERT_RESTORE_FAILED) rather than
    // silently swallowing the original audit error — the system may now hold an
    // unaudited or partially-written cert on disk, which needs manual/operational
    // follow-up since a filesystem write can never be made fully transactional.
    const previousCert = fs.existsSync(certPath) ? fs.readFileSync(certPath) : null;

    // Write certificate to file
    fs.writeFileSync(certPath, certificate.trim() + '\n', { mode: 0o600 });

    try {
      // Audit log
      await prisma.$executeRaw`
        INSERT INTO "audit_logs" (id, action, entity, entity_id, user_email, created_at)
        VALUES (gen_random_uuid(), 'UPLOAD_CERTIFICATE', 'SYSTEM', 'ssl-cert', ${req.user!.email}, now())
      `;
    } catch (auditError) {
      // Compensate: undo the filesystem write so an unaudited cert never persists.
      try {
        if (previousCert !== null) {
          fs.writeFileSync(certPath, previousCert, { mode: 0o600 });
        } else {
          fs.rmSync(certPath, { force: true });
        }
      } catch (restoreError) {
        // The compensating restore itself failed: disk state is now inconsistent
        // with audit_logs and cannot be reconciled automatically. Log loudly and
        // distinctly (internal only — never in the API response) so this is
        // detectable operationally, then still surface the original audit error.
        log.error(
          `[POST /api/admin/certificates/upload] CERT_RESTORE_FAILED — compensating restore failed after audit ` +
            `insert error; on-disk certificate may now be unaudited/inconsistent with audit_logs. ` +
            `Manual verification of ${certPath} required.`,
          { auditError, restoreError }
        );
      }
      throw auditError;
    }

    log.info(`[POST /api/admin/certificates/upload] Certificate uploaded successfully by ${req.user!.email}`);

    res.json({
      message: 'Certificate uploaded successfully. Restart the nginx container to apply the new certificate.',
      restartCommand: 'docker compose -f docker-compose.prod.yml restart nginx',
      certPath: '/certs/server.crt (shared volume)',
    });

  } catch (error) {
    log.error('[POST /api/admin/certificates/upload] Error:', error);
    res.status(500).json({ error: 'Failed to save certificate' });
  } finally {
    certUploadInProgress = false;
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


// ── CI Relationships (Topology) ──────────────────────────────────────────────

/**
 * v3.4.4 — INSTALLED_IN business rules: single container per source + container must not be retired.
 * Shared by both POST /api/cis/:id/relations and POST /api/relations.
 */
async function validateInstalledIn(sourceCiId: string, targetCiId: string): Promise<{ status: number; error: string } | null> {
  const existing = await prisma.cIRelation.findFirst({
    where: { sourceCiId, relationType: 'INSTALLED_IN' as never },
    select: { id: true, targetCI: { select: { name: true } } },
  });
  if (existing) return { status: 409, error: `El CI ya está instalado en "${existing.targetCI.name}". Desinstálalo primero.` };
  const target = await prisma.cI.findUnique({ where: { id: targetCiId }, select: { status: true } });
  if (target?.status === 'RETIRADO') return { status: 422, error: 'El chasis destino está retirado; no admite nuevas instalaciones.' };
  return null;
}

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
      source_status: string;
      target_status: string;
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
          s.status      AS source_status,
          t.status      AS target_status,
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
            s.status      AS source_status,
            t.status      AS target_status,
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
            s.status,
            t.status,
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
          source_status,
          target_status,
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

  if (!VALID_RELATION_TYPES.includes(relationType as never)) {
    res.status(400).json({ error: `Invalid relationType. Must be one of: ${VALID_RELATION_TYPES.join(', ')}` });
    return;
  }

  if (sourceCiId === targetCiId) {
    res.status(400).json({ error: 'A CI cannot have a relationship with itself' });
    return;
  }

  try {
    // T8: CI-type restriction matrix validation (source/target type codes)
    const typeRows = await prisma.$queryRaw<{ id: string; code: string | null }[]>`
      SELECT ci.id::text AS id, t.code
      FROM configuration_items ci LEFT JOIN ci_types t ON t.id = ci.ci_type_id
      WHERE ci.id IN (${sourceCiId}::uuid, ${targetCiId}::uuid)`;
    const srcCode = typeRows.find(r => r.id === sourceCiId)?.code ?? null;
    const tgtCode = typeRows.find(r => r.id === targetCiId)?.code ?? null;
    const matrixErr = validateRelationCiTypes(relationType, srcCode, tgtCode);
    if (matrixErr) { res.status(422).json({ error: matrixErr }); return; }

    // v3.4.4 — INSTALLED_IN business rules (single container per source + container not retired)
    if (relationType === 'INSTALLED_IN') {
      const violation = await validateInstalledIn(sourceCiId, targetCiId);
      if (violation) { res.status(violation.status).json({ error: violation.error }); return; }
    }

    const relation = await prisma.$transaction(async (tx) => {
      // Atomic INSERT...SELECT: inserts only if both CIs exist, eliminating TOCTOU race
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO ci_relations (id, source_ci_id, target_ci_id, relation_type, created_by, created_at)
        SELECT gen_random_uuid(), ${sourceCiId}::uuid, ${targetCiId}::uuid, ${relationType}::"RelationType", ${req.user!.email}, now()
        WHERE (SELECT COUNT(*) FROM configuration_items WHERE id IN (${sourceCiId}::uuid, ${targetCiId}::uuid)) = 2
        RETURNING id::text
      `;

      if (!inserted.length) return inserted;

      await tx.$executeRaw`
        INSERT INTO "audit_logs" (id, action, entity, entity_id, user_email, created_at)
        VALUES (gen_random_uuid(), ${'CREATE_RELATION:' + relationType}, 'CI_RELATION', ${inserted[0].id}, ${req.user!.email}, now())
      `;
      return inserted;
    });

    if (!relation.length) {
      res.status(404).json({ error: 'One or both CIs not found.' });
      return;
    }

    // Re-index BOTH endpoints — each CI's relation list changed
    void queueEntityForIndexing('ci', sourceCiId);
    void queueEntityForIndexing('ci', targetCiId);

    res.status(201).json({ id: relation[0].id, sourceCiId, targetCiId, relationType, message: 'Relationship created successfully' });
  } catch (error: unknown) {
    console.error('[POST /api/cis/:id/relations] Error:', error);
    // 23505 = unique_violation — covers both the legacy (source,target,type) unique
    // constraint and the v3.4.4 partial index ci_relations_installed_in_source_unique
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === '23505') {
      res.status(409).json({ error: 'Relación duplicada o CI ya instalado' });
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

  if (!VALID_RELATION_TYPES.includes(relationType as never)) {
    res.status(400).json({ error: `Invalid relationType. Must be one of: ${VALID_RELATION_TYPES.join(', ')}` });
    return;
  }

  if (sourceCiId === targetCiId) {
    res.status(400).json({ error: 'A CI cannot have a relationship with itself' });
    return;
  }

  try {
    // T8: CI-type restriction matrix validation (source/target type codes)
    const typeRows = await prisma.$queryRaw<{ id: string; code: string | null }[]>`
      SELECT ci.id::text AS id, t.code
      FROM configuration_items ci LEFT JOIN ci_types t ON t.id = ci.ci_type_id
      WHERE ci.id IN (${sourceCiId}::uuid, ${targetCiId}::uuid)`;
    const srcCode = typeRows.find(r => r.id === sourceCiId)?.code ?? null;
    const tgtCode = typeRows.find(r => r.id === targetCiId)?.code ?? null;
    const matrixErr = validateRelationCiTypes(relationType, srcCode, tgtCode);
    if (matrixErr) { res.status(422).json({ error: matrixErr }); return; }

    // v3.4.4 — INSTALLED_IN business rules (single container per source + container not retired)
    if (relationType === 'INSTALLED_IN') {
      const violation = await validateInstalledIn(sourceCiId, targetCiId);
      if (violation) { res.status(violation.status).json({ error: violation.error }); return; }
    }

    const relation = await prisma.$transaction(async (tx) => {
      // Atomic INSERT...SELECT: inserts only if both CIs exist, eliminating TOCTOU race
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO ci_relations (id, source_ci_id, target_ci_id, relation_type, created_by, created_at)
        SELECT gen_random_uuid(), ${sourceCiId}::uuid, ${targetCiId}::uuid, ${relationType}::"RelationType", ${req.user!.email}, now()
        WHERE (SELECT COUNT(*) FROM configuration_items WHERE id IN (${sourceCiId}::uuid, ${targetCiId}::uuid)) = 2
        RETURNING id::text
      `;

      if (!inserted.length) return inserted;

      await tx.$executeRaw`
        INSERT INTO "audit_logs" (id, action, entity, entity_id, user_email, created_at)
        VALUES (gen_random_uuid(), ${'CREATE_RELATION:' + relationType}, 'CI_RELATION', ${inserted[0].id}, ${req.user!.email}, now())
      `;
      return inserted;
    });

    if (!relation.length) {
      res.status(404).json({ error: 'One or both CIs not found.' });
      return;
    }

    // Re-index BOTH endpoints — each CI's relation list changed
    void queueEntityForIndexing('ci', sourceCiId);
    void queueEntityForIndexing('ci', targetCiId);

    res.status(201).json({ id: relation[0].id, sourceCiId, targetCiId, relationType, message: 'Relationship created successfully' });
  } catch (error: unknown) {
    console.error('[POST /api/relations] Error:', error);
    // 23505 = unique_violation — covers both the legacy (source,target,type) unique
    // constraint and the v3.4.4 partial index ci_relations_installed_in_source_unique
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === '23505') {
      res.status(409).json({ error: 'Relación duplicada o CI ya instalado' });
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

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`DELETE FROM ci_relations WHERE id = ${id}::uuid`;

      await tx.$executeRaw`
        INSERT INTO "audit_logs" (id, action, entity, entity_id, user_email, created_at)
        VALUES (gen_random_uuid(), 'DELETE_RELATION', 'CI_RELATION', ${id}, ${req.user!.email}, now())
      `;
    });

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

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE "configuration_items"
        SET    last_check_date      = ${checkDate},
               verification_source  = ${source},
               updated_at           = now()
        WHERE  id = ${id}::uuid
      `;

      // Audit log
      await tx.$executeRaw`
        INSERT INTO "audit_logs" (id, action, entity, entity_id, user_email, created_at)
        VALUES (gen_random_uuid(), ${'UPDATE_VERIFICATION:' + source}, 'CI', ${id}, ${req.user!.email}, now())
      `;
    });

    // Re-index this entity for the RAG (queue, non-blocking on errors)
    void queueEntityForIndexing('ci', id);

    res.json({ id, lastCheckDate: checkDate, verificationSource: source, message: 'Verification updated' });
  } catch (error) {
    console.error('[PATCH /api/cis/:id/verification] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── DCIM — CI physical placement ────────────────────────────────────────────

/**
 * PATCH /api/cis/:id/placement
 * Set or clear the physical location of a hardware CI within a rack.
 * Fields: parentRackCiId, uPosition, orientation, sizeU, powerW (all nullable to clear).
 * ADMIN only. Audit log: CI_PLACEMENT.
 */
app.patch('/api/cis/:id/placement', authenticateToken, requireAdmin, requireUuidParam('id'), async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const parsed = CIPlacementSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const { parentRackCiId, uPosition, orientation, sizeU, powerW } = parsed.data;

  try {
    // Verify the CI exists and is a hardware CI
    const hw = await prisma.hardwareCI.findUnique({ where: { ciId: id } });
    if (!hw) { res.status(404).json({ error: 'Hardware CI not found' }); return; }

    // If placing in a rack, validate rack exists and has capacity
    if (parentRackCiId) {
      const rack = await prisma.hardwareCI.findUnique({ where: { ciId: parentRackCiId } });
      if (!rack) { res.status(400).json({ error: 'Rack CI not found' }); return; }
      if (rack.rackTotalU && uPosition) {
        const slotEnd = uPosition + (sizeU ?? 1) - 1;
        if (slotEnd > rack.rackTotalU) {
          res.status(400).json({ error: `U position ${uPosition}+${sizeU ?? 1}U exceeds rack capacity (${rack.rackTotalU}U)` });
          return;
        }
      }

      // U-slot overlap check — find CIs already placed in this rack that collide
      if (uPosition) {
        const uStart = uPosition;
        const uEnd   = uPosition + (sizeU ?? 1) - 1;
        const occupants = await prisma.hardwareCI.findMany({
          where: {
            parentRackCiId: parentRackCiId,
            ciId          : { not: id },              // exclude self (update case)
            uPosition     : { not: null },
          },
          include: { ci: { select: { id: true, name: true } } },
        });
        const conflicts = occupants.filter((o) => {
          if (o.uPosition == null) return false;
          // Orientation isolation: FRONT and REAR don't conflict with each other
          if (orientation && o.orientation && orientation !== o.orientation) return false;
          const oEnd = o.uPosition + (o.sizeU ?? 1) - 1;
          return uStart <= oEnd && uEnd >= o.uPosition;
        });
        if (conflicts.length > 0) {
          res.status(409).json({
            error       : 'U_OVERLAP',
            conflictsWith: conflicts.map((o) => ({
              ciId  : o.ciId,
              name  : o.ci.name,
              uStart: o.uPosition,
              uEnd  : o.uPosition! + (o.sizeU ?? 1) - 1,
            })),
          });
          return;
        }
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.hardwareCI.update({
        where : { ciId: id },
        data  : { parentRackCiId, uPosition, orientation, sizeU, powerW },
      });

      await tx.$executeRaw`
        INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
        VALUES (gen_random_uuid(), 'CI_PLACEMENT', 'CI', ${id}::uuid, ${req.user!.email}, now())
      `;
    });

    res.json({ id, parentRackCiId, uPosition, orientation, sizeU, powerW });
  } catch (error) {
    console.error('[PATCH /api/cis/:id/placement] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── CI Bulk Import (staging + AI analysis) ────────────────────────────────────
const CI_BULK_MAX_ROWS = parseInt(process.env.CI_BULK_MAX_ROWS ?? '500', 10);

// Shared constants also used by CI-bulk and cron (documents module has its own copies)
const DOCUMENTS_DIR           = process.env.DOCUMENTS_DIR ?? '/app/documents';
const STAGING_DIR             = process.env.BULK_STAGING_DIR ?? `${DOCUMENTS_DIR}/_staging`;
const BULK_BATCH_TTL_HOURS    = parseInt(process.env.BULK_BATCH_TTL_HOURS ?? '24', 10);
const BULK_REAPED_RETENTION_DAYS = parseInt(process.env.BULK_REAPED_RETENTION_DAYS ?? '7', 10);
const BULK_MAX_OPEN_BATCHES   = parseInt(process.env.BULK_MAX_OPEN_BATCHES ?? '5', 10);

// Takes a Prisma.TransactionClient (the base PrismaClient is also assignable
// to it structurally, see isPasswordInHistory above) so callers can run this
// inside an enclosing prisma.$transaction(...) alongside the audit-log insert.
async function recomputeCIBatchStatus(db: Prisma.TransactionClient, batchId: string): Promise<void> {
  const rows = await db.$queryRaw<{ total: bigint; pending: bigint; committed: bigint; errors: bigint }[]>`
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
  await db.$executeRaw`UPDATE "ci_bulk_import_batch" SET status = ${status}, updated_at = now() WHERE id = ${batchId}::uuid`;
}

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
/**
 * Returns true when the raw XLSX row already carries enough well-formed data
 * that calling the LLM is unnecessary: a non-empty name and at least one of
 * serialNumber / ipAddress / inventoryNumber.
 */
function isWellFormedCIRow(raw: CIRowRaw): boolean {
  const name = (raw['name'] ?? '').toString().trim();
  if (!name) return false;
  const serial = (raw['serialNumber'] ?? '').toString().trim();
  const ip = (raw['ipAddress'] ?? '').toString().trim();
  const inv = (raw['inventoryNumber'] ?? '').toString().trim();
  return Boolean(serial || ip || inv);
}

async function processCIBulkImportQueue(): Promise<void> {
  if (process.env.RAG_ENABLED !== 'true') return;
  // NOTE: Ollama is no longer a hard gate — well-formed XLSX rows skip the LLM.
  // Rows that need AI normalization will still fail gracefully (analyzeCIRowForImport
  // falls back to raw if the service is unreachable).
  const ollamaUp = await isOllamaHealthy();

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
      // ipAddress is persisted on CI.consoleIp (column console_ip on configuration_items),
      // not on hardware_cis — see commit logic in this file around line 4950.
      const ipAddr = (raw['ipAddress'] ?? '').trim();
      if (ipAddr) {
        const ms = await prisma.$queryRaw<{ id: string; name: string }[]>`
          SELECT id::text AS id, name FROM "configuration_items"
          WHERE console_ip = ${ipAddr} LIMIT 3`;
        for (const m of ms) { if (!conflicts.find(c => c.existingId === m.id)) conflicts.push({ field: 'ipAddress', existingId: m.id, existingName: m.name }); }
      }

      // Skip AI when the row already carries name + serial/IP/inv. Otherwise
      // try the LLM (which itself falls back to raw if unreachable).
      const wellFormed = isWellFormedCIRow(raw);
      const aiSkipped = wellFormed || !ollamaUp;
      const normalized = aiSkipped ? { ...raw } : await analyzeCIRowForImport(raw);

      const possibleDuplicate = conflicts.length > 0;
      const analysis = {
        normalized,
        conflicts,
        possibleDuplicate,
        aiSkipped,
        analyzedAt: new Date().toISOString(),
      };

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
    try { await recomputeCIBatchStatus(prisma, batchId); }
    catch (e) { console.error('[CI-Bulk] processCIBulkImportQueue batch-status error:', e); }
  }
}

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
  // T7 (v2.7.0): cascade-created masters
  osName:              z.string().max(255).nullable().optional(),
  osVersion:           z.string().max(100).nullable().optional(),
  baseSoftwareName:    z.string().max(255).nullable().optional(),
  baseSoftwareVersion: z.string().max(100).nullable().optional(),
  // v2.8.7: infrastructure + GRC fields
  userDni:             z.string().max(20).nullable().optional(),
  adminIp:             z.string().max(45).nullable().optional(),
  mgmtIp:              z.string().max(45).nullable().optional(),
  vlan:                z.string().max(20).nullable().optional(),
  cpuModel:            z.string().max(255).nullable().optional(),
  vCpus:               z.union([z.number().int(), z.string().regex(/^\d+$/).transform(Number)]).nullable().optional(),
  ram:                 z.string().max(100).nullable().optional(),
  disk:                z.string().max(100).nullable().optional(),
  hostName:            z.string().max(255).nullable().optional(),
  clusterName:         z.string().max(255).nullable().optional(),
  firmwareVersion:     z.string().max(100).nullable().optional(),
  dns:                 z.string().max(255).nullable().optional(),
  floor:               z.string().max(50).nullable().optional(),
  room:                z.string().max(100).nullable().optional(),
  rack:                z.string().max(50).nullable().optional(),
  rackUnit:            z.string().max(20).nullable().optional(),
  location:            z.string().max(255).nullable().optional(),
  businessOwner:       z.string().email().max(255).nullable().optional(),
  technicalLead:       z.string().email().max(255).nullable().optional(),
  rto:                 z.union([z.number().int(), z.string().regex(/^\d+$/).transform(Number)]).nullable().optional(),
  rpo:                 z.union([z.number().int(), z.string().regex(/^\d+$/).transform(Number)]).nullable().optional(),
  recoveryPriority:    z.union([z.number().int().min(1).max(5), z.string().regex(/^[1-5]$/).transform(Number)]).nullable().optional(),
  spofRisk:            z.union([z.boolean(), z.string().transform((s) => s.toUpperCase() === 'YES' || s === 'true' || s === '1')]).nullable().optional(),
  containsPii:         z.union([z.boolean(), z.string().transform((s) => s.toUpperCase() === 'YES' || s === 'true' || s === '1')]).nullable().optional(),
  forceCreate:        z.boolean().optional(),
});
type CIBulkDecision = z.infer<typeof CIBulkDecisionSchema>;

// T7: deterministic master code from natural key (name + version) — the UNIQUE
// constraint on `code` doubles as the natural-key conflict target for atomic
// ON CONFLICT upserts under concurrent bulk workers.
function masterCodeFromNaturalKey(name: string, version?: string | null): string {
  return `${name.trim()}${version?.trim() ? ` ${version.trim()}` : ''}`
    .toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 50);
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
  // v2.8.7: resolve FK lookups for location, businessOwner, technicalLead
  let locationId: string | null = null;
  if (decision.location?.trim()) {
    const l = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM "locations" WHERE LOWER(name) = LOWER(${decision.location.trim()}) LIMIT 1`;
    locationId = l[0]?.id ?? null;
  }
  let businessOwnerId: string | null = null;
  if (decision.businessOwner?.trim()) {
    const u = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM "users" WHERE LOWER(email) = LOWER(${decision.businessOwner.trim()}) AND active = true LIMIT 1`;
    businessOwnerId = u[0]?.id ?? null;
  }
  let technicalLeadId: string | null = null;
  if (decision.technicalLead?.trim()) {
    const u = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM "users" WHERE LOWER(email) = LOWER(${decision.technicalLead.trim()}) AND active = true LIMIT 1`;
    technicalLeadId = u[0]?.id ?? null;
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

    // T7 (v2.7.0): cascade-upsert OperatingSystem by natural key (name+version).
    // The deterministic `code` doubles as conflict target → atomic under concurrency.
    let operatingSystemId: string | null = null;
    if (decision.osName?.trim()) {
      const osName    = decision.osName.trim();
      const osVersion = decision.osVersion?.trim() || null;
      const osCode    = masterCodeFromNaturalKey(osName, osVersion);
      const insertedOs = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "operating_systems"(id, code, name, version, created_at, updated_at)
        VALUES (gen_random_uuid(), ${osCode}, ${osName}, ${osVersion}, now(), now())
        ON CONFLICT (code) DO NOTHING
        RETURNING id::text AS id`;
      if (insertedOs.length > 0) {
        operatingSystemId = insertedOs[0].id;
        await tx.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at) VALUES(gen_random_uuid(),'CREATE_MASTER','OperatingSystem',${operatingSystemId}::uuid,${userEmail},${JSON.stringify({ name: osName, version: osVersion, source: 'ci-bulk-import' })}::jsonb,now())`;
      } else {
        const existingOs = await tx.$queryRaw<{ id: string }[]>`
          SELECT id::text AS id FROM "operating_systems" WHERE code = ${osCode} LIMIT 1`;
        operatingSystemId = existingOs[0]?.id ?? null;
      }
    }

    // T7: cascade-upsert BaseSoftware by natural key (name+version). Linked to the
    // CI afterwards only when the CI type admits base software (D3 allowlist).
    let baseSoftwareId: string | null = null;
    if (decision.baseSoftwareName?.trim()) {
      const bswName    = decision.baseSoftwareName.trim();
      const bswVersion = decision.baseSoftwareVersion?.trim() || null;
      const bswCode    = masterCodeFromNaturalKey(bswName, bswVersion);
      const insertedBsw = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "base_software"(id, code, name, version, created_at, updated_at)
        VALUES (gen_random_uuid(), ${bswCode}, ${bswName}, ${bswVersion}, now(), now())
        ON CONFLICT (code) DO NOTHING
        RETURNING id::text AS id`;
      if (insertedBsw.length > 0) {
        baseSoftwareId = insertedBsw[0].id;
        await tx.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at) VALUES(gen_random_uuid(),'CREATE_MASTER','BaseSoftware',${baseSoftwareId}::uuid,${userEmail},${JSON.stringify({ name: bswName, version: bswVersion, source: 'ci-bulk-import' })}::jsonb,now())`;
      } else {
        const existingBsw = await tx.$queryRaw<{ id: string }[]>`
          SELECT id::text AS id FROM "base_software" WHERE code = ${bswCode} LIMIT 1`;
        baseSoftwareId = existingBsw[0]?.id ?? null;
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
        operatingSystemId, // T7: cascade-created/reused OS master (null if not provided)
        // v2.8.7: infrastructure + GRC fields
        userDni:            decision.userDni            || null,
        adminIp:            decision.adminIp            || null,
        mgmtIp:             decision.mgmtIp             || null,
        vlan:               decision.vlan               || null,
        cpuModel:           decision.cpuModel           || null,
        vCpus:              (typeof decision.vCpus === 'number' ? decision.vCpus : null),
        ram:                decision.ram                || null,
        disk:               decision.disk               || null,
        hostName:           decision.hostName           || null,
        clusterName:        decision.clusterName        || null,
        firmwareVersion:    decision.firmwareVersion    || null,
        dns:                decision.dns                || null,
        floor:              decision.floor              || null,
        room:               decision.room               || null,
        rack:               decision.rack               || null,
        rackUnit:           decision.rackUnit           || null,
        locationId,
        businessOwnerId,
        technicalLeadId,
        rto:                (typeof decision.rto === 'number' ? decision.rto : null),
        rpo:                (typeof decision.rpo === 'number' ? decision.rpo : null),
        recoveryPriority:   (typeof decision.recoveryPriority === 'number' ? decision.recoveryPriority : null),
        spofRisk:           decision.spofRisk === true || (decision.spofRisk as unknown) === 'YES',
        containsPii:        decision.containsPii === true || (decision.containsPii as unknown) === 'YES',
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

    // T7: link Base Software to the CI — only for D3-allowed server types
    const BSW_ALLOWED_TYPES = ['PHYSICAL_SERVER', 'VIRTUAL_SERVER', 'CLOUD_INSTANCE'];
    if (baseSoftwareId && BSW_ALLOWED_TYPES.includes(ciTypeCode)) {
      await tx.$executeRaw`
        INSERT INTO "ci_base_software"(ci_id, base_software_id)
        VALUES (${newCi.id}::uuid, ${baseSoftwareId}::uuid)
        ON CONFLICT DO NOTHING`;
    }

    await tx.$executeRaw`
      UPDATE "ci_bulk_import_item"
      SET status='COMMITTED', committed_ci_id=${newCi.id}::uuid, updated_at=now()
      WHERE id=${item.id}::uuid`;

    await tx.$executeRaw`
      INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, details, created_at)
      VALUES(gen_random_uuid(), 'CI_BULK_COMMIT', 'CI', ${newCi.id}::uuid, ${userEmail},
             ${JSON.stringify({ batchItemId: item.id, ciName: newCi.name, manufacturerId: resolvedMfrId, ciModelId, operatingSystemId, baseSoftwareId })}::jsonb, now())`;

    return newCi;
  });

  void queueEntityForIndexing('ci', ci.id);
  return { ciId: ci.id };
}

// ── CMDB stats cache (60 s TTL) — injected into every RAG prompt so the LLM
// can answer counting/inventory questions correctly regardless of topK. ────────
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
    // Issue #172: wrap the join-table connect + audit insert in one transaction
    // so the audit is never missing when the association persists.
    await prisma.$transaction(async (tx) => {
      await tx.cI.update({
        where: { id: ciId },
        data: { contracts: { connect: contractIds.map((cid) => ({ id: cid })) } },
      });
      await tx.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at) VALUES(gen_random_uuid(),'LINK_CI','CI',${ciId}::uuid,${req.user!.email},${JSON.stringify({contractIds})}::jsonb,now())`;
    });

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
    // Issue #172: wrap the join-table disconnect + audit insert in one
    // transaction so the audit is never missing when the removal persists.
    await prisma.$transaction(async (tx) => {
      await tx.cI.update({
        where: { id: ciId },
        data: { contracts: { disconnect: [{ id: contractId }] } },
      });
      await tx.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at) VALUES(gen_random_uuid(),'UNLINK_CI','CI',${ciId}::uuid,${req.user!.email},${JSON.stringify({contractId})}::jsonb,now())`;
    });

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
    // Issue #172: wrap the join-table inserts + audit insert in one transaction
    // so the audit is never missing when the associations persist.
    const associated = await prisma.$transaction(async (tx) => {
      let count = 0;
      for (const documentId of documentIds) {
        await tx.$executeRaw`INSERT INTO "document_cis"(id,document_id,ci_id) VALUES(gen_random_uuid(),${documentId}::uuid,${ciId}::uuid) ON CONFLICT DO NOTHING`;
        count++;
      }
      await tx.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at) VALUES(gen_random_uuid(),'LINK_CI','CI',${ciId}::uuid,${req.user!.email},${JSON.stringify({documentIds,count})}::jsonb,now())`;
      return count;
    });

    void queueEntityForIndexing('ci', ciId);

    res.json({ associated });
  } catch (e) { res.status(500).json({ error: 'Failed to associate documents to CI' }); }
});

// DELETE /api/cis/:id/documents/:docId — Remove document association from CI
app.delete('/api/cis/:id/documents/:docId', authenticateToken, requireAdmin, async (req, res) => {
  const ciId = req.params.id as string;
  const docId = req.params.docId as string;
  try {
    // Issue #172: wrap the join-table delete + audit insert in one transaction
    // so the audit is never missing when the removal persists.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`DELETE FROM "document_cis" WHERE document_id=${docId}::uuid AND ci_id=${ciId}::uuid`;
      await tx.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,details,created_at) VALUES(gen_random_uuid(),'UNLINK_CI','CI',${ciId}::uuid,${req.user!.email},${JSON.stringify({documentId:docId})}::jsonb,now())`;
    });

    void queueEntityForIndexing('ci', ciId);

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Failed to remove document association from CI' }); }
});

// ─── Alert Engine — legacy shim (delegates to /api/alerts/run-now) ───────────

/**
 * POST /api/admin/test-email
 * @deprecated — use POST /api/alerts/run-now instead.
 * Kept for backward compatibility with existing integrations.
 */
app.post('/api/admin/test-email', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  log.info(`[POST /api/admin/test-email] Manual trigger by ${req.user?.email}`);
  try {
    const result = await runAlertsPipeline(prisma, 'MANUAL', true);
    res.json({
      message:    `Pipeline status: ${result.status}`,
      totalAlerts: result.totalAlerts,
      breakdown:   result.breakdown,
      status:      result.status,
      messageId:   result.messageId ?? null,
      runId:       result.runId,
    });
  } catch (error) {
    console.error('[POST /api/admin/test-email] Error:', error instanceof Error ? error.message : error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── App Settings — Theme & Branding ─────────────────────────────────────────

// ─── v3.0.0 — Crons de sistema migrados a workflows n8n ──────────────────────
// Los siguientes crons se han migrado a /api/internal/maintenance/* (T3 / T3.5):
//
//   startAlertScheduler     → workflow n8n "Alertas CMDB"
//                             (GET /api/internal/alerts/scan + POST /alerts/record)
//   AuditPurgeCron 03:00    → n8n Schedule + POST /api/internal/maintenance/purge-audit-logs
//   TrustedDeviceCron 02:00 → n8n Schedule + POST /api/internal/maintenance/cleanup-trusted-devices
//   DcimPowerCron 04:00     → n8n Schedule + POST /api/internal/maintenance/dcim-power-scan
//   BulkCleanupCron hourly  → n8n Schedule + POST /api/internal/maintenance/cleanup-bulk-staging
//
// node-cron se conserva en el Plugin Engine para los cron-jobs de plugins de usuario.

startAlertScheduler(prisma); // no-op desde v3.0.0; log de delegación a n8n
log.info('[v3.0.0] Crons de sistema delegados a n8n workflows. Ver /api/internal/maintenance/*');

// ─── RAG Document Indexing Queue (v3.0.0 — delegado a n8n) ──────────────────
// El cron */30s se eliminó en T4. El workflow n8n "RAG Indexing" despacha
// POST /api/internal/rag/process-batch cada 30 s.
// createBulkQueueProcessor(prisma) se instancia inline al montar el router
// interno (ver app.use('/api/internal') más arriba).
if (process.env.RAG_ENABLED === 'true') {
  console.log('[RAG] v3.0.0 — indexing queue delegada a n8n workflow "RAG Indexing".');
} else {
  console.log('[RAG] RAG_ENABLED is not "true" — indexing queue disabled.');
}


// ─── Server ───────────────────────────────────────────────────────────────────
// TLS is terminated by the nginx gateway; the backend always starts as plain
// HTTP on PORT (default 3000) and is NOT exposed to the host.

(async () => {
  // Mount plugin router and re-activate ACTIVE plugins before accepting traffic.
  await initializePluginEngine(app, prisma, authenticateToken);

  // Recover vuln-import batches orphaned by a restart mid-async-import (Task
  // 4 made Red Hat Lightspeed pulls run as a background job — see
  // recoverOrphanedRunningBatches's comment in modules/vuln-import/queries.ts).
  // Single UPDATE statement, fast — awaited before app.listen so recovery is
  // guaranteed to have run before any new import request can be accepted,
  // rather than raced fire-and-forget like provisionOnBoot below.
  const recoveredBatches = await recoverOrphanedRunningBatches(prisma);
  if (recoveredBatches > 0) {
    console.log(`[vuln-import] Recovered ${recoveredBatches} orphaned RUNNING batch(es) as FAILED on startup.`);
  }

  app.listen(PORT, () => {
    console.log(`🚀 CMDB API running at http://localhost:${PORT} (internal — TLS via nginx)`);
    console.log(`   Allowed CORS origins: ${ALLOWED_ORIGINS.join(', ')}`);
    provisionOnBoot(); // fire-and-forget; no-op si N8N_API_KEY no está configurada
  });

  process.on('SIGTERM', async () => {
    console.log('SIGTERM received. Closing Prisma connection...');
    await prisma.$disconnect();
    process.exit(0);
  });
})();
