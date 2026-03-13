import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { PrismaClient, Criticality, Environment } from '@prisma/client';

// ─── App setup ────────────────────────────────────────────────────────────────

const app    = express();
const prisma = new PrismaClient();
const PORT   = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET ?? 'cmdb-dev-secret-change-in-production';

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

app.use(cors({
  origin: ['http://localhost:3001', 'http://localhost:3000'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());

// ── Auth middleware ────────────────────────────────────────────────────────────

function authenticateToken(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    res.status(401).json({ error: 'Authentication required. Please login.' });
    return;
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET) as JwtPayload;
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

// ─── Vulnerability mock catalog ───────────────────────────────────────────────

type VulnSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

interface Vulnerability {
  cve:         string;
  severity:    VulnSeverity;
  description: string;
}

const VULN_CATALOG: Vulnerability[] = [
  { cve: 'CVE-2024-21413', severity: 'CRITICAL', description: 'Microsoft Outlook Remote Code Execution via MIME link parsing' },
  { cve: 'CVE-2024-1709',  severity: 'CRITICAL', description: 'Authentication bypass in ConnectWise ScreenConnect' },
  { cve: 'CVE-2023-34048', severity: 'CRITICAL', description: 'VMware vCenter Server DCERPC heap overflow — unauthenticated RCE' },
  { cve: 'CVE-2024-27198', severity: 'CRITICAL', description: 'JetBrains TeamCity authentication bypass allows admin takeover' },
  { cve: 'CVE-2024-0519',  severity: 'HIGH',     description: 'Out-of-bounds memory read in Google Chrome V8' },
  { cve: 'CVE-2023-44487', severity: 'HIGH',     description: 'HTTP/2 Rapid Reset — amplified DDoS attack vector' },
  { cve: 'CVE-2024-3094',  severity: 'HIGH',     description: 'Backdoor in XZ Utils 5.6.0/5.6.1 — SSH daemon compromise' },
  { cve: 'CVE-2024-21338', severity: 'HIGH',     description: 'Windows kernel null pointer — local privilege escalation' },
  { cve: 'CVE-2023-23376', severity: 'MEDIUM',   description: 'Windows CLFS Driver elevation of privilege' },
  { cve: 'CVE-2023-36661', severity: 'MEDIUM',   description: 'OpenSSH server version banner exposed' },
  { cve: 'CVE-2024-22024', severity: 'MEDIUM',   description: 'Ivanti ICS SAML authentication bypass' },
  { cve: 'CVE-2023-48795', severity: 'MEDIUM',   description: 'Terrapin attack on SSH — prefix truncation' },
  { cve: 'CVE-2024-26197', severity: 'LOW',      description: 'Windows Storage Management Service — DoS only' },
  { cve: 'CVE-2023-20198', severity: 'LOW',      description: 'Cisco IOS XE — default credential exposure' },
];

function generateScanResults(): Vulnerability[] {
  const count    = Math.floor(Math.random() * 6);
  const shuffled = [...VULN_CATALOG].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
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
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password) {
    res.status(400).json({ error: 'email and password are required' });
    return;
  }

  try {
    // Use raw SQL — Prisma TS types don't yet expose password/role until DLL restarts
    type UserRow = { id: string; username: string; email: string; password: string | null; role: string };
    const rows = await prisma.$queryRaw<UserRow[]>`
      SELECT id, username, email, password, role FROM "users" WHERE email = ${email} LIMIT 1
    `;
    const user = rows[0];

    if (!user || !user.password) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    const payload: JwtPayload = {
      id:       user.id,
      username: user.username,
      email:    user.email,
      role:     user.role as UserRole,
    };

    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' });

    res.json({
      token,
      user: { id: user.id, username: user.username, email: user.email, role: user.role },
    });
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
      businessOwnerId, technicalLeadId, hardware, software,
    } = req.body as {
      name: string; apiSlug: string;
      criticality: Criticality; environment: Environment;
      businessOwnerId?: string; technicalLeadId?: string;
      hardware?: { serialNumber: string; model: string; manufacturer: string };
      software?: { version: string; licenseType: string };
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

    const ci = await prisma.cI.create({
      data: {
        name, apiSlug, criticality, environment,
        businessOwnerId: businessOwnerId || null,
        technicalLeadId: technicalLeadId || null,
        ...(hardware && { hardware: { create: { serialNumber: hardware.serialNumber, model: hardware.model, manufacturer: hardware.manufacturer } } }),
        ...(software && { software: { create: { version: software.version, licenseType: software.licenseType } } }),
      },
      include: CI_INCLUDE,
    });

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

// ── Scan ──────────────────────────────────────────────────────────────────────

app.post('/api/cis/:id/scan', authenticateToken, requireAdmin, async (req: Request<{ id: string }>, res: Response) => {
  const { id } = req.params;
  console.log(`[POST /api/cis/${id}/scan] Starting mock scan…`);

  try {
    const existing = await prisma.cI.findUnique({ where: { id } });
    if (!existing) { res.status(404).json({ error: `CI with id ${id} not found` }); return; }

    const vulnerabilities = generateScanResults();
    console.log(`[POST /api/cis/${id}/scan] Found ${vulnerabilities.length} vulnerabilities`);

    await prisma.$executeRaw`
      UPDATE "configuration_items"
      SET "vulnerabilities" = ${JSON.stringify(vulnerabilities)}::jsonb
      WHERE "id" = ${id}::uuid
    `;

    const ci = await prisma.cI.findUnique({ where: { id }, include: CI_INCLUDE });
    res.json({ ci, vulnerabilities, scannedAt: new Date().toISOString() });
  } catch (error) {
    console.error(`[POST /api/cis/${id}/scan] Error:`, error);
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

      // Normalise vulnerabilities to our standard format
      const vulns = (result.vulnerabilities ?? []).map((v) => ({
        cve:         v.cve,
        severity:    v.severity?.toUpperCase() as 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW',
        description: v.description ?? v.name ?? '',
        source:      'greenbone',
        cvss_score:  v.cvss_score ?? null,
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

// ─── Server ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🚀 CMDB API running at http://localhost:${PORT}`);
  console.log(`   → POST /api/auth/login       (public)`);
  console.log(`   → GET  /api/users            (any role)`);
  console.log(`   → GET  /api/vendors          (any role)`);
  console.log(`   → GET  /api/cis              (any role)`);
  console.log(`   → POST /api/cis              (ADMIN only)`);
  console.log(`   → POST /api/cis/:id/scan     (ADMIN only)`);
  console.log(`   → GET  /api/contracts        (any role)`);
  console.log(`   → POST /api/contracts        (ADMIN only)`);
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Closing Prisma connection...');
  await prisma.$disconnect();
  process.exit(0);
});
