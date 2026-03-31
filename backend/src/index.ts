import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
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
import { PrismaClient, Criticality, Environment } from '@prisma/client';
import { runAndSendAlerts } from './services/emailService';
import { authenticateLDAP } from './services/ldap';
import { lookupEolWithFallbacks, fetchProductCycles } from './services/eolService';
import * as speakeasy from 'speakeasy';
import QRCode from 'qrcode';

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

// ─── Types ────────────────────────────────────────────────────────────────────

type UserRole = 'ADMIN' | 'VIEWER';

interface JwtPayload {
  id:       string;
  username: string;
  email:    string;
  role:     UserRole;
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
  email:    z.string().email('Email inválido').max(254),
  password: z.string().min(1, 'La contraseña es obligatoria').max(128),
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

  try {
    const payload = jwt.verify(token, JWT_SECRET_VALUE) as JwtPayload;
    req.user = payload;
    next();
  } catch {
    res.status(403).json({ error: 'Invalid or expired token. Please login again.' });
  }
}

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user || req.user.role !== 'ADMIN') {
    res.status(403).json({ error: 'Admin role required for this operation.' });
    return;
  }
  next();
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
 */
app.post('/api/auth/login', loginLimiter, async (req: Request, res: Response) => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Datos de acceso inválidos' });
    return;
  }
  const { email, password } = parsed.data;
  const { mfaCode } = req.body as { mfaCode?: string };

  try {
    // Extended user row — includes MFA fields (added via add_mfa_fields migration)
    type UserRow = { id: string; username: string; email: string; password: string | null; role: string; mfa_enabled: boolean; mfa_secret: string | null };

    let user: UserRow | null = null;
    let ldapSuccess = false;

    // ── Domain Pre-Check: Skip LDAP for local accounts (@cmdb.local) ─────────
    const isLocalAccount = email.endsWith('@cmdb.local') || email.endsWith('@cmdb.internal');

    if (process.env.USE_LDAP === 'true' && !isLocalAccount) {
      // ── LDAP / Active Directory path with fail-soft fallback ────────────────
      try {
        await authenticateLDAP(email, password);
        ldapSuccess = true;
        log.info(`[POST /api/auth/login] LDAP authentication successful for ${email}`);
      } catch (ldapErr) {
        log.warn('[POST /api/auth/login] LDAP authentication failed, attempting local fallback:', ldapErr);
        // Do NOT return — fall through to local bcrypt validation
      }

      if (ldapSuccess) {
        // User authenticated via LDAP — check if exists in DB or auto-provision
        let rows = await prisma.$queryRaw<UserRow[]>`
          SELECT id, username, email, password, role, mfa_enabled, mfa_secret FROM "users" WHERE email = ${email} LIMIT 1
        `;

        if (rows.length === 0) {
          const username  = email.split('@')[0];
          const dummyHash = await bcrypt.hash(`ldap-provisioned-${Date.now()}`, 10);
          // sso_external_id stores the LDAP identity so the user can be
          // identified as LDAP-sourced (vs. locally created) at any point.
          await prisma.$executeRaw`
            INSERT INTO "users" (id, username, email, password, role, sso_external_id, created_at, updated_at)
            VALUES (gen_random_uuid(), ${username}, ${email}, ${dummyHash}, 'VIEWER', ${email}, now(), now())
          `;
          rows = await prisma.$queryRaw<UserRow[]>`
            SELECT id, username, email, password, role, mfa_enabled, mfa_secret FROM "users" WHERE email = ${email} LIMIT 1
          `;
          log.info(`[POST /api/auth/login] Auto-provisioned LDAP shadow user: ${email}`);
        }
        user = rows[0];
      }
    }

    // ── Local bcrypt path (if LDAP disabled, local account, or LDAP failed) ──
    if (!ldapSuccess) {
      const rows = await prisma.$queryRaw<UserRow[]>`
        SELECT id, username, email, password, role, mfa_enabled, mfa_secret FROM "users" WHERE email = ${email} LIMIT 1
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

    // ── Null check for user variable ─────────────────────────────────────────
    if (!user) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    // ── MFA check (common to both paths) ──────────────────────────────────────
    if (user.mfa_enabled && user.mfa_secret) {
      if (!mfaCode) {
        res.status(401).json({ error: 'MFA_REQUIRED' });
        return;
      }
      const mfaValid = speakeasy.totp.verify({ secret: user.mfa_secret, encoding: 'base32', token: mfaCode, window: 1 });
      if (!mfaValid) {
        res.status(401).json({ error: 'Invalid MFA code' });
        return;
      }
    }

    const payload: JwtPayload = { id: user.id, username: user.username, email: user.email, role: user.role as UserRole };
    const token = jwt.sign(payload, JWT_SECRET_VALUE, { expiresIn: '8h' });
    res.json({ token, user: { id: user.id, username: user.username, email: user.email, role: user.role } });

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
  if (!role || !['ADMIN', 'VIEWER'].includes(role)) {
    res.status(400).json({ error: 'role must be "ADMIN" or "VIEWER"' });
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

app.get('/api/cis', authenticateToken, async (_req: Request, res: Response) => {
  try {
    const cis = await prisma.cI.findMany({
      include: CI_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });
    res.json({ total: cis.length, data: cis.map(flattenCI) });
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
 * Returns the last 50 audit log entries ordered by date descending.
 * ADMIN only.
 */
app.get('/api/audit-logs', authenticateToken, requireAdmin, async (_req: Request, res: Response) => {
  try {
    type AuditRow = { id: string; action: string; entity: string; entity_id: string; user_email: string; created_at: Date };
    const logs = await prisma.$queryRaw<AuditRow[]>`
      SELECT id, action, entity, entity_id, user_email, created_at
      FROM "audit_logs"
      ORDER BY created_at DESC
      LIMIT 50
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
 * The secret is NOT stored yet — client must verify with /mfa/enable first.
 */
app.post('/api/auth/mfa/setup', authenticateToken, async (req: Request, res: Response) => {
  try {
    const secretObj = speakeasy.generateSecret({ name: `CMDB Enterprise (${req.user!.email})`, length: 20 });
    const secret    = secretObj.base32;
    const otpauth   = secretObj.otpauth_url ?? speakeasy.otpauthURL({ secret, label: req.user!.email, issuer: 'CMDB Enterprise', encoding: 'base32' });
    const qrDataUrl = await QRCode.toDataURL(otpauth);
    res.json({ secret, qrDataUrl });
  } catch (error) {
    console.error('[POST /api/auth/mfa/setup] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/auth/mfa/enable
 * Verifies the first TOTP code and persists the secret in the database.
 * Body: { code: string, secret: string }
 */
app.post('/api/auth/mfa/enable', authenticateToken, async (req: Request, res: Response) => {
  const { code, secret } = req.body as { code?: string; secret?: string };
  if (!code || !secret) {
    res.status(400).json({ error: 'code and secret are required' });
    return;
  }
  const valid = speakeasy.totp.verify({ secret, encoding: 'base32', token: code, window: 1 });
  if (!valid) {
    res.status(400).json({ error: 'Invalid TOTP code. Please try again.' });
    return;
  }
  try {
    await prisma.$executeRaw`
      UPDATE "users" SET mfa_secret = ${secret}, mfa_enabled = true WHERE id = ${req.user!.id}::uuid
    `;
    res.json({ message: 'MFA enabled successfully' });
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
  } catch (e) { res.status(500).json({ error: String(e), stack: e instanceof Error ? e.stack : undefined }); }
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
  try {
    const row = await prisma.cIType.update({
      where: { id: req.params.id },
      data: { name: name.trim(), ...(categoryCode && { categoryCode }), ...(sortOrder !== undefined && { sortOrder }) },
      select: { id: true, code: true, name: true, categoryCode: true, sortOrder: true, isSystem: true },
    });
    res.json(row);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.delete('/api/masters/ci-types/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const row = await prisma.cIType.findUnique({ where: { id: req.params.id }, select: { isSystem: true, code: true } });
    if (!row) { res.status(404).json({ error: 'Tipo no encontrado' }); return; }
    if (row.isSystem) { res.status(403).json({ error: `El tipo "${row.code}" es un tipo de sistema y no puede eliminarse` }); return; }
    await prisma.cIType.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // FK violation = CIs with this type exist
    if (msg.includes('foreign key') || msg.includes('P2003') || msg.includes('violates')) {
      res.status(409).json({ error: 'No se puede eliminar: existen CIs con este tipo asignado' }); return;
    }
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
      type CIRow = { id: string; name: string };
      const rows = await prisma.$queryRaw<CIRow[]>`
        SELECT id, name FROM "configuration_items"
        WHERE LOWER(name) LIKE LOWER(${'%' + hostname + '%'})
        ORDER BY LENGTH(name) ASC
        LIMIT 1
      `;

      if (rows.length === 0) {
        processed.push({ ci: hostname, matched: false, vulnCount: 0 });
        continue;
      }

      const ci = rows[0];

      // Normalise vulnerabilities to our standard format (with lifecycle status)
      const importedAt = new Date().toISOString();
      const vulns = (result.vulnerabilities ?? []).map((v) => ({
        cve:         v.cve,
        severity:    v.severity?.toUpperCase() as VulnSeverity,
        description: v.description ?? v.name ?? '',
        source:      'greenbone',
        cvss_score:  v.cvss_score ?? null,
        status:      'NUEVO' as VulnStatus,
        importedAt,
      }));

      await prisma.$executeRaw`
        UPDATE "configuration_items"
        SET "vulnerabilities" = ${JSON.stringify(vulns)}::jsonb
        WHERE "id" = ${ci.id}::uuid
      `;

      processed.push({ ci: ci.name, matched: true, vulnCount: vulns.length });
      log.info(`  ✓ ${ci.name} → ${vulns.length} vulnerability/ies`);
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

      type CIRow = { id: string; name: string };
      const rows = await prisma.$queryRaw<CIRow[]>`
        SELECT id, name FROM "configuration_items"
        WHERE LOWER(name) LIKE LOWER(${'%' + hostname + '%'})
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
