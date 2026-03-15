import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
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
  contracts: {
    select: {
      id:             true,
      contractNumber: true,
      endDate:        true,
      vendor:         { select: { id: true, name: true } },
    },
  },
} as const;

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
app.post('/api/auth/login', async (req: Request, res: Response) => {
  const { email, password, mfaCode } = req.body as { email?: string; password?: string; mfaCode?: string };

  if (!email || !password) {
    res.status(400).json({ error: 'email and password are required' });
    return;
  }

  try {
    // Extended user row — includes MFA fields (added via add_mfa_fields migration)
    type UserRow = { id: string; username: string; email: string; password: string | null; role: string; mfa_enabled: boolean; mfa_secret: string | null };

    let user: UserRow;

    if (process.env.USE_LDAP === 'true') {
      // ── LDAP / Active Directory path ────────────────────────────────────────
      try {
        await authenticateLDAP(email, password);
      } catch (ldapErr) {
        console.error('[POST /api/auth/login] LDAP error:', ldapErr);
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }

      let rows = await prisma.$queryRaw<UserRow[]>`
        SELECT id, username, email, password, role, mfa_enabled, mfa_secret FROM "users" WHERE email = ${email} LIMIT 1
      `;

      if (rows.length === 0) {
        const username  = email.split('@')[0];
        const dummyHash = await bcrypt.hash(`ldap-provisioned-${Date.now()}`, 10);
        await prisma.$executeRaw`
          INSERT INTO "users" (id, username, email, password, role, created_at, updated_at)
          VALUES (gen_random_uuid(), ${username}, ${email}, ${dummyHash}, 'VIEWER', now(), now())
        `;
        rows = await prisma.$queryRaw<UserRow[]>`
          SELECT id, username, email, password, role, mfa_enabled, mfa_secret FROM "users" WHERE email = ${email} LIMIT 1
        `;
        console.log(`[POST /api/auth/login] Auto-provisioned LDAP user: ${email}`);
      }
      user = rows[0];

    } else {
      // ── Local bcrypt path ────────────────────────────────────────────────────
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
    // Raw SQL — role field not yet in Prisma TS types (DLL lock on Windows)
    type UserRow = { id: string; username: string; email: string; role: string };
    const users = await prisma.$queryRaw<UserRow[]>`
      SELECT id, username, email, role FROM "users" ORDER BY username ASC
    `;
    res.json(users);
  } catch (error) {
    console.error('[GET /api/users] Error:', error);
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
    res.json({ total: cis.length, data: cis });
  } catch (error) {
    console.error('[GET /api/cis] Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/cis', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  console.log('[POST /api/cis] Body received:', JSON.stringify(req.body, null, 2));
  try {
    const {
      name, apiSlug, criticality, environment,
      ciType, status, inventoryNumber,
      branchId, ciModelId,
      businessOwnerId, technicalLeadId, hardware, software,
      eolDate: eolDateRaw, eosDate: eosDateRaw,
    } = req.body as {
      name: string; apiSlug: string;
      criticality: Criticality; environment: Environment;
      ciType?: string; status?: string; inventoryNumber?: string;
      branchId?: string; ciModelId?: string;
      businessOwnerId?: string; technicalLeadId?: string;
      hardware?: { serialNumber: string; model: string; manufacturer: string };
      software?: { version: string; licenseType: string };
      eolDate?: string; eosDate?: string;
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
        ciType:          ciType          || "OTHER",
        status:          status          || "ACTIVO",
        inventoryNumber: inventoryNumber || null,
        branchId:        branchId        || null,
        ciModelId:       ciModelId       || null,
        eolDate:         resolvedEolDate     || null,
        eosDate:         resolvedSupportDate || null,
        businessOwnerId: businessOwnerId || null,
        technicalLeadId: technicalLeadId || null,
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

    res.status(201).json(ci);
  } catch (error: unknown) {
    console.error('[POST /api/cis] Error:', error);
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === 'P2002') {
      res.status(409).json({ error: 'A CI with this slug or serial number already exists' });
      return;
    }
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
  console.log('[POST /api/contracts] Body received:', JSON.stringify(req.body, null, 2));
  try {
    const { contractNumber, startDate, endDate, vendorId, parentContractId, ciIds } = req.body as {
      contractNumber: string; startDate: string; endDate?: string;
      vendorId: string; parentContractId?: string; ciIds?: string[];
    };

    if (!contractNumber || !startDate || !vendorId) {
      res.status(400).json({ error: 'Missing required fields: contractNumber, startDate, vendorId' });
      return;
    }

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
    console.log(`[sync-manufacturers] created=${created}, skipped=${skipped}, errors=${errors}`);
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

  const validCriticalities = ['LOW', 'MEDIUM', 'HIGH', 'MISSION_CRITICAL'];
  const validEnvironments  = ['DEVELOPMENT', 'TESTING', 'STAGING', 'PRODUCTION'];
  const hwTypes = [
    'HARDWARE','PHYSICAL_SERVER','VIRTUAL_SERVER','NETWORK','STORAGE',
    'DESKTOP','LAPTOP','PRINTER','SCANNER','MONITOR',
    'VIDEOCONFERENCE','SMART_DISPLAY','TIME_CLOCK','IP_PHONE',
    'SMARTPHONE','TABLET','PDA','BARCODE_SCANNER',
    'IP_CAMERA','UPS','WIFI_AP','CLOUD_INSTANCE','CLOUD_STORAGE',
  ];
  const swTypes = ['SOFTWARE','DATABASE','BACKUP','BASE_SOFTWARE'];

  const results: { name: string; status: 'created' | 'error'; id?: string; error?: string }[] = [];
  let successCount = 0;
  let errorCount   = 0;

  for (const row of rows) {
    const name = (row.name ?? '').trim();
    if (!name) {
      results.push({ name: '(vacío)', status: 'error', error: 'Missing required field: name' });
      errorCount++; continue;
    }

    const ciType  = (row.ciType ?? 'OTHER').trim().toUpperCase();
    const crit    = (row.criticality ?? '').trim().toUpperCase();
    const env     = (row.environment  ?? '').trim().toUpperCase();
    const criticality = (validCriticalities.includes(crit) ? crit : 'MEDIUM') as Criticality;
    const environment = (validEnvironments.includes(env)   ? env  : 'PRODUCTION') as Environment;

    // Unique slug: name-slug + random suffix
    const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 40);
    const apiSlug = `${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;

    const needsHw = hwTypes.includes(ciType);
    const needsSw = swTypes.includes(ciType);

    try {
      const ci = await prisma.cI.create({
        data: {
          name, apiSlug, criticality, environment, ciType,
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
    console.log(`[POST /api/admin/reset-vulnerabilities] Reset ${result} CI(s)`);
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
app.delete('/api/masters/branches/:id', authenticateToken, requireAdmin, async (req, res) => {
  try { await prisma.$executeRaw`DELETE FROM "branches" WHERE id=${req.params.id}::uuid`; res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

// Manufacturers
app.get('/api/masters/manufacturers', authenticateToken, async (_req, res) => {
  try {
    const rows = await prisma.$queryRaw<MasterRow[]>`SELECT id::text AS id, name FROM "manufacturers" ORDER BY name ASC`;
    console.log(`[GET /api/masters/manufacturers] rows=${rows.length}`);
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
app.delete('/api/masters/providers/:id', authenticateToken, requireAdmin, async (req, res) => {
  try { await prisma.$executeRaw`DELETE FROM "providers" WHERE id=${req.params.id}::uuid`; res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

/**
 * POST /api/masters/device-models/:id/sync-eol
 * Looks up EOL dates for the device model on endoflife.date and updates
 * all CIs linked to this model with the resolved dates.
 * ADMIN only.
 */
app.post('/api/masters/device-models/:id/sync-eol', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  const { id } = req.params;
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

/**
 * PATCH /api/cis/:id/verification
 * Updates the lastCheckDate and verificationSource fields for a CI.
 * Used by the frontend when an admin manually verifies EOL/EOS status from external sources.
 * Body: { lastCheckDate?: string (ISO), verificationSource?: string }
 */
app.patch('/api/cis/:id/verification', authenticateToken, requireAdmin, async (req: Request, res: Response) => {
  const { id } = req.params;
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
  console.log('[POST /api/integrations/greenbone] Processing report…');
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
      console.log(`  ✓ ${ci.name} → ${vulns.length} vulnerability/ies`);
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
  console.log('[POST /api/integrations/crowdstrike] Processing report…');
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
      console.log(`  ✓ ${ci.name} → agent ${device.status}, ${device.detections?.length ?? 0} detection(s)`);
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
  console.log(`[POST /api/admin/test-email] Manual trigger by ${req.user?.email}`);
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
  console.log(`[AlertCron] Triggered at ${new Date().toISOString()} (schedule: ${CRON_SCHEDULE})`);
  runAndSendAlerts()
    .then((r) => console.log(`[AlertCron] Done — sent=${r.sent}, alerts=${r.eolAlerts.length + r.contractAlerts.length + r.vulnAlerts.length}`))
    .catch((e) => console.error('[AlertCron] Error:', e));
}, {
  timezone: 'Europe/Madrid',
});

console.log(`[AlertCron] Scheduled — "${CRON_SCHEDULE}" (TZ: Europe/Madrid). Use POST /api/admin/test-email to trigger manually.`);

// ─── Server ───────────────────────────────────────────────────────────────────

// ─── Server startup — HTTP or HTTPS ──────────────────────────────────────────

const CERT_DIR  = path.join(__dirname, '../../certs');
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
