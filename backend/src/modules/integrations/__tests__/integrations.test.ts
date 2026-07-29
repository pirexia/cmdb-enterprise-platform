/**
 * T3 integrations module — integration tests (mocked Prisma, no real DB).
 * Covers: 401/403 RBAC, happy-path matched/unmatched for Greenbone and CrowdStrike,
 * Greenbone merge (preserves analyst-set vuln status), audit log insert.
 */

const mockQueryRaw   = jest.fn();
const mockExecuteRaw = jest.fn();
const mockVulnUuid   = jest.fn().mockReturnValue('aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee');
const mockBatchCreate = jest.fn();
const mockTransaction = jest.fn();

// POST /api/integrations/greenbone (v3.6.0 B6) now delegates to the
// vuln-import staging module's `uploadReport()` — the mocked Prisma client
// must therefore also support the calls that flow makes ($transaction +
// vulnImportBatch.create), mirroring
// modules/vuln-import/__tests__/router.test.ts's mock shape.
jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => {
    const instance: Record<string, unknown> = {
      $queryRaw:   mockQueryRaw,
      $executeRaw: mockExecuteRaw,
      $transaction: mockTransaction,
      vulnImportBatch: { create: mockBatchCreate },
    };
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(instance));
    return instance;
  }),
  Prisma: { JsonNull: null },
}));

// entitySerializer creates a PrismaClient at module level — mock the whole module
jest.mock('../../../services/entitySerializer', () => ({
  vulnUuid: mockVulnUuid,
}));

process.env.JWT_SECRET = 'test-secret-32-chars-minimum-len!!';

import express        from 'express';
import supertest      from 'supertest';
import jwt            from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { createIntegrationsRouter } from '../router.js';

const TEST_SECRET = 'test-secret-32-chars-minimum-len!!';
const prisma = new PrismaClient() as any;
const mockQueue = jest.fn();

const CI_ID  = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeToken(role: 'ADMIN' | 'AUDITOR' | 'VIEWER'): string {
  return jwt.sign(
    { id: USER_ID, username: 'tester', email: `${role.toLowerCase()}@test.local`, role },
    TEST_SECRET,
    { expiresIn: '1h' },
  );
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/integrations', createIntegrationsRouter(prisma, mockQueue));
  return supertest(app);
}

// Real Greenbone export shape (v3.6.0) — the legacy `/api/integrations/greenbone`
// endpoint now delegates to modules/vuln-import/service.ts's uploadReport(),
// so its request body is a raw Greenbone report (or an {filename?, report}
// envelope), not the old invented `results[]` mock shape (see LEGACY_MOCK_BODY
// below for that regression case).
const GB_BODY = {
  allHostSubreportEntries: [{
    host: '10.0.0.5',
    vulnerabilities: [{
      name: 'Test Vuln', severity: 7.5, qod: 80, host: '10.0.0.5', port: '443/tcp',
      summary: 'A test vulnerability', description: ['line1'], solution: 'Patch it',
      solutionType: 'VendorFix', affected: 'affected', insight: 'insight',
      cve: ['CVE-2024-0001'], thread: 'high', oid: '1.3.6.1.4.1.25623.1.0.100001',
      family: 'Web application abuses', nvtName: 'Test Vuln', impact: 'impact',
    }],
  }],
};

// The old, invented mock shape this endpoint used to (silently) accept —
// `POST /api/integrations/greenbone` must now reject this with 400, not
// succeed with 0 processed entries (the exact regression B6 fixes).
const LEGACY_MOCK_BODY = {
  results: [{
    host: { hostname: 'server01' },
    vulnerabilities: [{ cve: 'CVE-2024-0001', severity: 'high', name: 'Test Vuln', description: 'A test vuln', cvss_score: 7.5 }],
  }],
};

const CS_BODY = {
  devices: [{
    hostname: 'workstation01', agent_id: 'ag-123', agent_version: '7.0',
    status: 'online', prevention_policy: 'protect', last_seen: '2024-01-01T00:00:00Z',
    detections: [],
  }],
};

beforeEach(() => {
  jest.clearAllMocks();
  // Default: auth check succeeds, all writes succeed
  mockQueryRaw.mockResolvedValue([{ active: true }]);
  mockExecuteRaw.mockResolvedValue(1);
});

// ── Greenbone RBAC ────────────────────────────────────────────────────────────

describe('POST /api/integrations/greenbone — RBAC', () => {
  it('returns 401 without token', async () => {
    const res = await buildApp().post('/api/integrations/greenbone').send(GB_BODY);
    expect(res.status).toBe(401);
  });

  it('returns 403 for AUDITOR', async () => {
    const res = await buildApp()
      .post('/api/integrations/greenbone')
      .set('Authorization', `Bearer ${makeToken('AUDITOR')}`)
      .send(GB_BODY);
    expect(res.status).toBe(403);
  });

  it('returns 403 for VIEWER', async () => {
    const res = await buildApp()
      .post('/api/integrations/greenbone')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`)
      .send(GB_BODY);
    expect(res.status).toBe(403);
  });
});

// ── Greenbone happy path ──────────────────────────────────────────────────────

describe('POST /api/integrations/greenbone — processing (delegates to vuln-import staging, v3.6.0 B6)', () => {
  it('happy path: matched CI creates a PENDING staging batch via uploadReport()', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])                       // auth
      .mockResolvedValueOnce([{ level: 1, id: CI_ID, name: 'server01' }]) // matchHost (EXACT_IP)
      .mockResolvedValueOnce([{ vulnerabilities: [] }]);                // getCiVulnerabilities
    mockBatchCreate.mockResolvedValueOnce({ id: 'cccccccc-dddd-eeee-ffff-000000000000', entries: [] });

    const res = await buildApp()
      .post('/api/integrations/greenbone')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send(GB_BODY);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Greenbone report processed via staging');
    expect(res.body.batchId).toBe('cccccccc-dddd-eeee-ffff-000000000000');
    expect(res.body.summary).toMatchObject({ totalEntries: 1, matched: 1, unmatched: 0, nueva: 1 });
    // The batch is created via the SAME code path as /api/vuln-import/upload
    // — no direct CI mutation from this legacy route (A04 — staging first).
    expect(mockBatchCreate).toHaveBeenCalledTimes(1);
    // Audit insert for the upload (VULN_IMPORT_UPLOAD), inside the transaction.
    expect(mockExecuteRaw).toHaveBeenCalledWith(
      expect.anything(), 'VULN_IMPORT_UPLOAD', 'VulnImportBatch', expect.anything(), 'admin@test.local', expect.anything(),
    );
  });

  it('unmatched host still creates a batch (entry left for manual resolution)', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }]) // auth
      .mockResolvedValueOnce([]);                // matchHost → UNMATCHED, no CI vuln lookup follows
    mockBatchCreate.mockResolvedValueOnce({ id: 'cccccccc-dddd-eeee-ffff-000000000000', entries: [] });

    const res = await buildApp()
      .post('/api/integrations/greenbone')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send(GB_BODY);

    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ totalEntries: 1, matched: 0, unmatched: 1 });
    expect(mockBatchCreate).toHaveBeenCalledTimes(1);
  });

  // Regression fix (spec §1/D9, v3.6.0 B6): the OLD importer read
  // `req.body.results`, a field that does not exist in a real Greenbone
  // export — it silently matched 0 hosts and returned 200. Posting that
  // same old mock shape today must be REJECTED with 400, not silently
  // succeed, and it must NOT create a staging batch.
  it('400s on the legacy invented results[] mock shape — does not silently succeed, no batch created', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ active: true }]); // auth only — parsing fails before any CI lookup

    const res = await buildApp()
      .post('/api/integrations/greenbone')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send(LEGACY_MOCK_BODY);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/real Greenbone export format/);
    expect(mockBatchCreate).not.toHaveBeenCalled();
  });

  it('400s on a structurally invalid report body (Zod)', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ active: true }]);

    const res = await buildApp()
      .post('/api/integrations/greenbone')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ allHostSubreportEntries: [{ host: '1.2.3.4', vulnerabilities: [{}] }] });

    expect(res.status).toBe(400);
    expect(mockBatchCreate).not.toHaveBeenCalled();
  });
});

// ── CrowdStrike RBAC ──────────────────────────────────────────────────────────

describe('POST /api/integrations/crowdstrike — RBAC', () => {
  it('returns 401 without token', async () => {
    const res = await buildApp().post('/api/integrations/crowdstrike').send(CS_BODY);
    expect(res.status).toBe(401);
  });

  it('returns 403 for AUDITOR', async () => {
    const res = await buildApp()
      .post('/api/integrations/crowdstrike')
      .set('Authorization', `Bearer ${makeToken('AUDITOR')}`)
      .send(CS_BODY);
    expect(res.status).toBe(403);
  });
});

// ── CrowdStrike happy path ────────────────────────────────────────────────────

describe('POST /api/integrations/crowdstrike — processing', () => {
  it('matches CI, updates agent_status, inserts audit log', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])
      .mockResolvedValueOnce([{ id: CI_ID, name: 'workstation01' }]);

    const res = await buildApp()
      .post('/api/integrations/crowdstrike')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send(CS_BODY);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('CrowdStrike report processed');
    expect(res.body.totalMatched).toBe(1);
    expect(res.body.totalUnmatched).toBe(0);
    expect(res.body.processed[0]).toMatchObject({ ci: 'workstation01', matched: true, status: 'online' });
    // UPDATE agent_status + INSERT audit = 2 execute calls
    expect(mockExecuteRaw).toHaveBeenCalledTimes(2);
  });

  it('returns matched:false when no CI found, still inserts audit log', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])
      .mockResolvedValueOnce([]); // no CI match

    const res = await buildApp()
      .post('/api/integrations/crowdstrike')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send(CS_BODY);

    expect(res.status).toBe(200);
    expect(res.body.totalMatched).toBe(0);
    expect(res.body.totalUnmatched).toBe(1);
    expect(res.body.processed[0]).toMatchObject({ ci: 'workstation01', matched: false, status: 'unmatched' });
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1); // only audit log
  });

  it('handles empty devices array gracefully', async () => {
    const res = await buildApp()
      .post('/api/integrations/crowdstrike')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ devices: [] });

    expect(res.status).toBe(200);
    expect(res.body.totalMatched).toBe(0);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1); // only audit log
  });
});

// ── GET /status — integration state ────────────────────────────────────────────

describe('GET /api/integrations/status', () => {
  const OLD_ENV = { ...process.env };
  afterEach(() => {
    process.env.USE_LDAP  = OLD_ENV.USE_LDAP;
    process.env.SMTP_HOST = OLD_ENV.SMTP_HOST;
  });

  it('returns 401 without token', async () => {
    const res = await buildApp().get('/api/integrations/status');
    expect(res.status).toBe(401);
  });

  it('allows any authenticated role (AUDITOR) and reflects env flags', async () => {
    process.env.USE_LDAP  = 'true';
    process.env.SMTP_HOST = 'smtp.corp.local';
    const res = await buildApp()
      .get('/api/integrations/status')
      .set('Authorization', `Bearer ${makeToken('AUDITOR')}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ldap: true, smtp: true });
  });

  it('reports disabled integrations when env is unset', async () => {
    delete process.env.USE_LDAP;
    delete process.env.SMTP_HOST;
    const res = await buildApp()
      .get('/api/integrations/status')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ldap: false, smtp: false });
  });
});
