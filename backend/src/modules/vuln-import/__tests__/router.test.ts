/**
 * B5 — vuln-import router/service integration tests (mocked Prisma, no real DB).
 *
 * Covers: RBAC (401/403) across the 7 endpoints, upload happy/error paths
 * (matched/ambiguous host, legacy-format rejection, Zod rejection), list/get
 * batches, PATCH entry correction, bulk-decision, accept (happy + blocking
 * ambiguity + not-PENDING), discard (happy + not-PENDING). Transactional
 * atomicity of `acceptBatch` (issue #172 pattern — audit failure rolls back
 * the CI vulnerabilities write) is covered separately at the bottom via a
 * hand-built staging/commit mock, mirroring
 * backend/src/modules/dcim/__tests__/auditTransaction.test.ts.
 */

const mockQueryRaw   = jest.fn();
const mockExecuteRaw = jest.fn();

const mockBatchCreate     = jest.fn();
const mockBatchFindMany   = jest.fn();
const mockBatchCount      = jest.fn();
const mockBatchFindUnique = jest.fn();
const mockBatchUpdate     = jest.fn();

const mockEntryGroupBy    = jest.fn();
const mockEntryFindMany   = jest.fn();
const mockEntryFindFirst  = jest.fn();
const mockEntryUpdate     = jest.fn();
const mockEntryUpdateMany = jest.fn();
const mockEntryCreateMany = jest.fn().mockResolvedValue({ count: 0 });

const mockTransaction = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => {
    const instance: Record<string, unknown> = {
      $queryRaw: mockQueryRaw,
      $executeRaw: mockExecuteRaw,
      $transaction: mockTransaction,
      vulnImportBatch: {
        create: mockBatchCreate, findMany: mockBatchFindMany, count: mockBatchCount,
        findUnique: mockBatchFindUnique, update: mockBatchUpdate,
      },
      vulnImportEntry: {
        groupBy: mockEntryGroupBy, findMany: mockEntryFindMany, findFirst: mockEntryFindFirst,
        update: mockEntryUpdate, updateMany: mockEntryUpdateMany, createMany: mockEntryCreateMany,
      },
    };
    // The real Prisma runs $transaction(fn) against an interactive tx client;
    // here tx === the same mocked instance, since every model/raw call the
    // service makes is already routed through these shared jest.fn()s.
    mockTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(instance));
    return instance;
  }),
  Prisma: { JsonNull: null },
}));

process.env.JWT_SECRET = 'test-secret-32-chars-minimum-len!!';

import express from 'express';
import supertest from 'supertest';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { createVulnImportRouter } from '../router.js';
import { acceptBatch } from '../service.js';

const TEST_SECRET = 'test-secret-32-chars-minimum-len!!';
const prisma = new PrismaClient() as any; // eslint-disable-line @typescript-eslint/no-explicit-any

const USER_ID  = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CI_ID    = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const BATCH_ID = 'cccccccc-dddd-eeee-ffff-000000000000';
const ENTRY_ID = 'dddddddd-eeee-ffff-0000-111111111111';

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
  app.use('/api/vuln-import', createVulnImportRouter(prisma));
  return supertest(app);
}

function buildVuln(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Test Vuln', severity: 7.5, qod: 80, host: '10.0.0.5', port: '443/tcp',
    summary: 'A test vulnerability', description: ['line1'], solution: 'Patch it',
    solutionType: 'VendorFix', affected: 'affected', insight: 'insight',
    cve: ['CVE-2024-0001'], thread: 'high', oid: '1.3.6.1.4.1.25623.1.0.100001',
    family: 'Web application abuses', nvtName: 'Test Vuln', impact: 'impact',
    ...overrides,
  };
}

function buildReport(overrides: Record<string, unknown> = {}) {
  return {
    allHostSubreportEntries: [{ host: '10.0.0.5', vulnerabilities: [buildVuln()] }],
    taskName: 'Weekly scan',
    greenboneTaskId: 'task-1',
    scanStart: '2026-07-01T00:00:00Z',
    scanEnd: '2026-07-01T01:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockExecuteRaw.mockResolvedValue(1);
});

// ── RBAC across the 7 endpoints ──────────────────────────────────────────────

describe('RBAC', () => {
  const writeRoutes: [string, string][] = [
    ['post', '/api/vuln-import/upload'],
    ['patch', `/api/vuln-import/batches/${BATCH_ID}/entries/${ENTRY_ID}`],
    ['post', `/api/vuln-import/batches/${BATCH_ID}/entries/bulk-decision`],
    ['post', `/api/vuln-import/batches/${BATCH_ID}/accept`],
    ['post', `/api/vuln-import/batches/${BATCH_ID}/discard`],
  ];
  const readRoutes: [string, string][] = [
    ['get', '/api/vuln-import/batches'],
    ['get', `/api/vuln-import/batches/${BATCH_ID}`],
  ];

  it.each(writeRoutes)('%s %s → 401 without token', async (method, path) => {
    const res = await (buildApp() as any)[method](path).send({});
    expect(res.status).toBe(401);
  });

  it.each(writeRoutes)('%s %s → 403 for AUDITOR (ADMIN-only)', async (method, path) => {
    mockQueryRaw.mockResolvedValueOnce([{ active: true }]);
    const res = await (buildApp() as any)[method](path).set('Authorization', `Bearer ${makeToken('AUDITOR')}`).send({});
    expect(res.status).toBe(403);
  });

  it.each(writeRoutes)('%s %s → 403 for VIEWER', async (method, path) => {
    mockQueryRaw.mockResolvedValueOnce([{ active: true }]);
    const res = await (buildApp() as any)[method](path).set('Authorization', `Bearer ${makeToken('VIEWER')}`).send({});
    expect(res.status).toBe(403);
  });

  it.each(readRoutes)('%s %s → 401 without token', async (method, path) => {
    const res = await (buildApp() as any)[method](path);
    expect(res.status).toBe(401);
  });

  it.each(readRoutes)('%s %s → 403 for VIEWER (AUDITOR-or-above)', async (method, path) => {
    mockQueryRaw.mockResolvedValueOnce([{ active: true }]);
    const res = await (buildApp() as any)[method](path).set('Authorization', `Bearer ${makeToken('VIEWER')}`);
    expect(res.status).toBe(403);
  });
});

// ── POST /upload ─────────────────────────────────────────────────────────────

describe('POST /api/vuln-import/upload', () => {
  it('400 for the legacy mock format (results[] without allHostSubreportEntries)', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ active: true }]);
    const res = await buildApp()
      .post('/api/vuln-import/upload')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ report: { results: [] } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unsupported Greenbone report format/);
  });

  it('400 for a structurally invalid report (Zod)', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ active: true }]);
    const res = await buildApp()
      .post('/api/vuln-import/upload')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ report: { allHostSubreportEntries: [{ host: '1.2.3.4', vulnerabilities: [{}] }] } });
    expect(res.status).toBe(400);
  });

  it('201 happy path: matched CI (EXACT_IP), new HIGH vuln pre-included', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])
      .mockResolvedValueOnce([{ level: 1, id: CI_ID, name: 'server01' }]) // matchHost
      .mockResolvedValueOnce([{ vulnerabilities: [] }]);                  // getCiVulnerabilities
    mockBatchCreate.mockResolvedValueOnce({ id: BATCH_ID, entries: [] });

    const res = await buildApp()
      .post('/api/vuln-import/upload')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ report: buildReport() });

    expect(res.status).toBe(201);
    expect(res.body.batchId).toBe(BATCH_ID);
    expect(res.body.summary).toMatchObject({
      totalEntries: 1, matched: 1, ambiguous: 0, unmatched: 0,
      nueva: 1, existentePendiente: 0, reaparecida: 0, preselectedInclude: 1,
    });

    const entriesArg = mockEntryCreateMany.mock.calls[0][0];
    expect(entriesArg.data[0]).toMatchObject({
      ciId: CI_ID, matchConfidence: 'EXACT_IP', classification: 'NUEVA', decision: 'INCLUDE',
    });
    expect(mockExecuteRaw).toHaveBeenCalledWith(
      expect.anything(), 'VULN_IMPORT_UPLOAD', 'VulnImportBatch', BATCH_ID, 'admin@test.local', expect.anything(),
    );
  });

  it('201 with an AMBIGUOUS host: ciId null, batch still created', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])
      .mockResolvedValueOnce([
        { level: 2, id: 'ci-a', name: 'dup' },
        { level: 2, id: 'ci-b', name: 'dup' },
      ]); // matchHost → AMBIGUOUS, no getCiVulnerabilities call follows
    mockBatchCreate.mockResolvedValueOnce({ id: BATCH_ID, entries: [] });

    const res = await buildApp()
      .post('/api/vuln-import/upload')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ report: buildReport() });

    expect(res.status).toBe(201);
    expect(res.body.summary.ambiguous).toBe(1);
    expect(res.body.summary.matched).toBe(0);
    const entriesArg = mockEntryCreateMany.mock.calls[0][0];
    expect(entriesArg.data[0].ciId).toBeNull();
    expect(entriesArg.data[0].matchConfidence).toBe('AMBIGUOUS');
    expect(entriesArg.data[0].matchCandidates).toEqual([
      { id: 'ci-a', name: 'dup' }, { id: 'ci-b', name: 'dup' },
    ]);
  });

  it('201 with an UNMATCHED host: ciId null, classified NUEVA against no stored vulns', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])
      .mockResolvedValueOnce([]); // matchHost → UNMATCHED
    mockBatchCreate.mockResolvedValueOnce({ id: BATCH_ID, entries: [] });

    const res = await buildApp()
      .post('/api/vuln-import/upload')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ report: buildReport() });

    expect(res.status).toBe(201);
    expect(res.body.summary.unmatched).toBe(1);
    expect(res.body.summary.matched).toBe(0);
  });
});

// ── POST /upload — CrowdStrike Spotlight (B4, v3.6.1: source auto-detection) ─
//
// The generic /upload endpoint accepts EITHER format without the caller
// declaring which — `uploadReport()` structurally auto-detects a flat
// top-level array as CrowdStrike Spotlight (service.ts's `detectSource`).

function buildCrowdStrikeRecord(overrides: Record<string, unknown> = {}) {
  return {
    hostname: 'workstation01', local_ip: '10.0.0.9', vulnerability_id: 'CVE-2024-9999',
    cve_id: 'CVE-2024-9999', base_score: '7.8 v3.x', exploit_status: { label: 'Unproven' },
    cisa_info: { is_cisa_kev: false, due_date: '' }, status: 'Open', days_open: 5,
    products: [{ product_name: 'JRE', product_name_version: 'JRE 1.8.0' }],
    recommended_remediations: [{ detail: 'Patch it' }],
    ...overrides,
  };
}

describe('POST /api/vuln-import/upload — CrowdStrike Spotlight auto-detection', () => {
  it('201: a flat-array body is auto-detected as CrowdStrike, persists source "crowdstrike" with the 8 CrowdStrike-specific fields threaded through', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])
      .mockResolvedValueOnce([{ level: 1, id: CI_ID, name: 'workstation01' }]) // matchHost
      .mockResolvedValueOnce([{ vulnerabilities: [] }]);                       // getCiVulnerabilities
    mockBatchCreate.mockResolvedValueOnce({ id: BATCH_ID, entries: [] });

    const res = await buildApp()
      .post('/api/vuln-import/upload')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ report: [buildCrowdStrikeRecord()] });

    expect(res.status).toBe(201);
    expect(res.body.summary).toMatchObject({ totalEntries: 1, matched: 1, nueva: 1 });

    const createArg = mockBatchCreate.mock.calls[0][0];
    expect(createArg.data.source).toBe('crowdstrike');
    const entriesArg = mockEntryCreateMany.mock.calls[0][0];
    expect(entriesArg.data[0]).toMatchObject({
      vulnKey: 'CVE-2024-9999',
      products: ['JRE 1.8.0'],
      exprtRating: null,
      cisaKev: false,
      exploitStatus: 'Unproven',
      daysOpen: 5,
      externalStatus: 'Open',
      cvssVersion: 'v3.x',
    });
  });

  it('400: the old/invented device mock ({devices: [...]}, not a flat array) fails validation rather than silently succeeding', async () => {
    // detectSource() distinguishes solely on "is the report a flat array" —
    // this object-shaped body is attempted as Greenbone (like any other
    // non-array report) and rejected by Greenbone's own Zod schema, since
    // it has neither `allHostSubreportEntries` nor a recognizable Greenbone
    // shape. It must NOT be silently accepted with 0 entries either way.
    mockQueryRaw.mockResolvedValueOnce([{ active: true }]);

    const res = await buildApp()
      .post('/api/vuln-import/upload')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ report: { platform: 'falcon', devices: [] } });

    expect(res.status).toBe(400);
    expect(mockBatchCreate).not.toHaveBeenCalled();
  });

  it('201: an empty flat array is a structurally valid (if empty) CrowdStrike export, not rejected', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ active: true }]);
    mockBatchCreate.mockResolvedValueOnce({ id: BATCH_ID, entries: [] });

    const res = await buildApp()
      .post('/api/vuln-import/upload')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ report: [] });

    expect(res.status).toBe(201);
    expect(res.body.summary.totalEntries).toBe(0);
    expect(mockBatchCreate).toHaveBeenCalledTimes(1);
    expect(mockBatchCreate.mock.calls[0][0].data.source).toBe('crowdstrike');
  });
});

// ── GET /batches ─────────────────────────────────────────────────────────────

describe('GET /api/vuln-import/batches', () => {
  it('200 lists batches with per-classification breakdown', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ active: true }]);
    mockBatchFindMany.mockResolvedValueOnce([
      { id: BATCH_ID, status: 'PENDING', filename: 'x.json', createdAt: new Date(), _count: { entries: 3 } },
    ]);
    mockBatchCount.mockResolvedValueOnce(1);
    mockEntryGroupBy.mockResolvedValueOnce([
      { batchId: BATCH_ID, classification: 'NUEVA', _count: { _all: 2 } },
      { batchId: BATCH_ID, classification: 'REAPARECIDA', _count: { _all: 1 } },
    ]);

    const res = await buildApp().get('/api/vuln-import/batches').set('Authorization', `Bearer ${makeToken('AUDITOR')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.batches[0]).toMatchObject({
      id: BATCH_ID, entryCount: 3, byClassification: { NUEVA: 2, REAPARECIDA: 1 },
    });
  });
});

// ── GET /batches/:id ─────────────────────────────────────────────────────────

describe('GET /api/vuln-import/batches/:id', () => {
  it('404 when the batch does not exist', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ active: true }]);
    mockBatchFindUnique.mockResolvedValueOnce(null);

    const res = await buildApp().get(`/api/vuln-import/batches/${BATCH_ID}`).set('Authorization', `Bearer ${makeToken('AUDITOR')}`);
    expect(res.status).toBe(404);
  });

  it('200 returns the batch and its entries', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ active: true }]);
    mockBatchFindUnique.mockResolvedValueOnce({ id: BATCH_ID, status: 'PENDING' });
    mockEntryFindMany.mockResolvedValueOnce([{ id: ENTRY_ID, batchId: BATCH_ID, classification: 'NUEVA' }]);

    const res = await buildApp().get(`/api/vuln-import/batches/${BATCH_ID}`).set('Authorization', `Bearer ${makeToken('AUDITOR')}`);
    expect(res.status).toBe(200);
    expect(res.body.batch.id).toBe(BATCH_ID);
    expect(res.body.entries).toHaveLength(1);
  });
});

// ── PATCH /batches/:id/entries/:entryId ──────────────────────────────────────

describe('PATCH /api/vuln-import/batches/:id/entries/:entryId', () => {
  it('409 when the batch is not PENDING', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ active: true }]);
    mockBatchFindUnique.mockResolvedValueOnce({ id: BATCH_ID, status: 'ACCEPTED' });

    const res = await buildApp()
      .patch(`/api/vuln-import/batches/${BATCH_ID}/entries/${ENTRY_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ decision: 'INCLUDE' });
    expect(res.status).toBe(409);
  });

  it('422 when the reassigned ciId does not exist', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])
      .mockResolvedValueOnce([]); // ciExists → false
    mockBatchFindUnique.mockResolvedValueOnce({ id: BATCH_ID, status: 'PENDING' });
    mockEntryFindFirst.mockResolvedValueOnce({ id: ENTRY_ID, batchId: BATCH_ID });

    const res = await buildApp()
      .patch(`/api/vuln-import/batches/${BATCH_ID}/entries/${ENTRY_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ ciId: CI_ID });
    expect(res.status).toBe(422);
  });

  it('200 happy path: reassigns ciId, clears ambiguity, marks edited', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])
      .mockResolvedValueOnce([{ id: CI_ID }]); // ciExists → true
    mockBatchFindUnique.mockResolvedValueOnce({ id: BATCH_ID, status: 'PENDING' });
    mockEntryFindFirst.mockResolvedValueOnce({ id: ENTRY_ID, batchId: BATCH_ID, matchConfidence: 'AMBIGUOUS' });
    mockEntryUpdate.mockResolvedValueOnce({ id: ENTRY_ID, ciId: CI_ID, matchConfidence: 'MANUAL', edited: true });

    const res = await buildApp()
      .patch(`/api/vuln-import/batches/${BATCH_ID}/entries/${ENTRY_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ ciId: CI_ID });

    expect(res.status).toBe(200);
    const updateArg = mockEntryUpdate.mock.calls[0][0];
    expect(updateArg.data).toMatchObject({ ciId: CI_ID, matchConfidence: 'MANUAL', matchCandidates: null, edited: true });
    expect(mockExecuteRaw).toHaveBeenCalledWith(
      expect.anything(), 'VULN_IMPORT_EDIT', 'VulnImportBatch', BATCH_ID, 'admin@test.local', expect.anything(),
    );
  });
});

// ── POST /batches/:id/entries/bulk-decision ─────────────────────────────────

describe('POST /api/vuln-import/batches/:id/entries/bulk-decision', () => {
  it('409 when the batch is not PENDING', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ active: true }]);
    mockBatchFindUnique.mockResolvedValueOnce({ id: BATCH_ID, status: 'DISCARDED' });

    const res = await buildApp()
      .post(`/api/vuln-import/batches/${BATCH_ID}/entries/bulk-decision`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ filter: { severity: 'LOW' }, decision: 'EXCLUDE' });
    expect(res.status).toBe(409);
  });

  it('200 applies the decision to all entries matching the filter', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ active: true }]);
    mockBatchFindUnique.mockResolvedValueOnce({ id: BATCH_ID, status: 'PENDING' });
    mockEntryUpdateMany.mockResolvedValueOnce({ count: 4 });

    const res = await buildApp()
      .post(`/api/vuln-import/batches/${BATCH_ID}/entries/bulk-decision`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ filter: { classification: 'EXISTENTE_PENDIENTE' }, decision: 'EXCLUDE' });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(4);
    const whereArg = mockEntryUpdateMany.mock.calls[0][0].where;
    expect(whereArg).toMatchObject({ batchId: BATCH_ID, classification: 'EXISTENTE_PENDIENTE' });
  });
});

// ── POST /batches/:id/accept ─────────────────────────────────────────────────

describe('POST /api/vuln-import/batches/:id/accept', () => {
  it('409 when the batch is not PENDING', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ active: true }]);
    mockBatchFindUnique.mockResolvedValueOnce({ id: BATCH_ID, status: 'ACCEPTED' });

    const res = await buildApp().post(`/api/vuln-import/batches/${BATCH_ID}/accept`).set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(409);
  });

  it('422 when an INCLUDEd entry has an unresolved (AMBIGUOUS/UNMATCHED) match', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ active: true }]);
    mockBatchFindUnique.mockResolvedValueOnce({ id: BATCH_ID, status: 'PENDING' });
    mockEntryFindMany.mockResolvedValueOnce([
      { id: ENTRY_ID, ciId: null, matchConfidence: 'UNMATCHED', decision: 'INCLUDE', hostAddress: '10.0.0.9', vulnKey: 'oid@80' },
    ]);

    const res = await buildApp().post(`/api/vuln-import/batches/${BATCH_ID}/accept`).set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('UNRESOLVED_MATCHES');
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('200 happy path: NUEVA entry appended to the CI\'s vulnerabilities', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])          // auth
      .mockResolvedValueOnce([{ vulnerabilities: [] }]);   // getCiVulnerabilities (inside tx)
    mockBatchFindUnique.mockResolvedValueOnce({ id: BATCH_ID, status: 'PENDING' });
    mockEntryFindMany.mockResolvedValueOnce([{
      id: ENTRY_ID, batchId: BATCH_ID, ciId: CI_ID, matchConfidence: 'EXACT_IP', decision: 'INCLUDE',
      classification: 'NUEVA', vulnKey: 'oid1@443', cves: ['CVE-2024-0001'], oid: 'oid1', port: '443',
      severity: 'HIGH', severityScore: 7.5, name: 'Test Vuln', summary: 'A test vulnerability',
      solution: 'Patch it', family: 'Web application abuses', qod: 80, epssScore: null,
    }]);
    mockBatchUpdate.mockResolvedValueOnce({ id: BATCH_ID, status: 'ACCEPTED' });

    const res = await buildApp().post(`/api/vuln-import/batches/${BATCH_ID}/accept`).set('Authorization', `Bearer ${makeToken('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ciCount: 1, newCount: 1, reopenedCount: 0, refreshedCount: 0 });

    const updateCiCall = mockExecuteRaw.mock.calls.find((c: any[]) => String(c[0]).includes('configuration_items') || (Array.isArray(c[0]) && c[0].join('').includes('configuration_items')));
    expect(updateCiCall).toBeDefined();
    const writtenVulns = JSON.parse(updateCiCall![1] as string);
    expect(writtenVulns).toHaveLength(1);
    expect(writtenVulns[0]).toMatchObject({ key: 'oid1@443', cve: 'CVE-2024-0001', status: 'NUEVO', severity: 'HIGH' });

    expect(mockExecuteRaw).toHaveBeenCalledWith(
      expect.anything(), 'VULN_IMPORT_ACCEPT', 'VulnImportBatch', BATCH_ID, 'admin@test.local', expect.anything(),
    );
  });
});

// ── POST /batches/:id/discard ─────────────────────────────────────────────────

describe('POST /api/vuln-import/batches/:id/discard', () => {
  it('409 when the batch is not PENDING', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ active: true }]);
    mockBatchFindUnique.mockResolvedValueOnce({ id: BATCH_ID, status: 'DISCARDED' });

    const res = await buildApp().post(`/api/vuln-import/batches/${BATCH_ID}/discard`).set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(409);
  });

  it('200 happy path: marks DISCARDED, touches nothing else', async () => {
    mockQueryRaw.mockResolvedValueOnce([{ active: true }]);
    mockBatchFindUnique.mockResolvedValueOnce({ id: BATCH_ID, status: 'PENDING' });
    mockBatchUpdate.mockResolvedValueOnce({ id: BATCH_ID, status: 'DISCARDED' });

    const res = await buildApp().post(`/api/vuln-import/batches/${BATCH_ID}/discard`).set('Authorization', `Bearer ${makeToken('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('DISCARDED');
    expect(mockExecuteRaw).toHaveBeenCalledWith(
      expect.anything(), 'VULN_IMPORT_DISCARD', 'VulnImportBatch', BATCH_ID, 'admin@test.local', null,
    );
  });
});

// ── acceptBatch transactional atomicity (issue #172 pattern) ────────────────
//
// Calls the service function directly against a hand-built Prisma double
// whose $transaction only "commits" staged writes if the callback resolves
// — mirroring Postgres rollback semantics, same approach as
// backend/src/modules/dcim/__tests__/auditTransaction.test.ts. This proves
// the CI vulnerabilities UPDATE and every audit insert (VULN_IMPORT_ACCEPT,
// and VULN_REOPENED where applicable) commit or roll back as one unit.

interface StagedState { vulns: unknown[]; auditActions: string[] }

function buildAcceptFixture(opts: {
  failAudit: boolean;
  initialVulns?: unknown[];
  entry?: Record<string, unknown>;
  batchSource?: string;
}) {
  const committed: StagedState = { vulns: opts.initialVulns ? [...opts.initialVulns] : [], auditActions: [] };
  const batchRow = { id: BATCH_ID, status: 'PENDING', source: opts.batchSource ?? 'greenbone' };
  // CrowdStrike Spotlight fields (v3.6.1) — real VulnImportEntry rows always
  // carry these (defaults products:[]/cisaKev:false/others null), so the
  // fixture mirrors that shape even for a Greenbone-classification entry.
  const CROWDSTRIKE_FIELD_DEFAULTS = {
    products: [], exprtRating: null, cisaKev: false, cisaDueDate: null,
    exploitStatus: null, daysOpen: null, externalStatus: null, cvssVersion: null,
  };
  const entryRow = opts.entry ? { ...CROWDSTRIKE_FIELD_DEFAULTS, ...opts.entry } : {
    id: ENTRY_ID, batchId: BATCH_ID, ciId: CI_ID, matchConfidence: 'EXACT_IP', decision: 'INCLUDE',
    classification: 'NUEVA', vulnKey: 'oid1@443', cves: ['CVE-2024-0001'], oid: 'oid1', port: '443',
    severity: 'HIGH', severityScore: 7.5, name: 'Test Vuln', summary: 'A test vulnerability',
    solution: null, family: null, qod: null, epssScore: null,
    ...CROWDSTRIKE_FIELD_DEFAULTS,
  };

  const prisma = {
    vulnImportBatch: { findUnique: async () => batchRow },
    vulnImportEntry: { findMany: async () => [entryRow] },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const staged: StagedState = { vulns: [...committed.vulns], auditActions: [] };
      const tx = {
        $queryRaw: async () => [{ vulnerabilities: staged.vulns }],
        $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const text = strings.join('');
          if (text.includes('audit_logs')) {
            if (opts.failAudit) throw new Error('audit insert failed (simulated)');
            staged.auditActions.push(values[0] as string);
            return 1;
          }
          if (text.includes('configuration_items')) {
            staged.vulns = JSON.parse(values[0] as string);
            return 1;
          }
          return 1;
        },
        vulnImportBatch: { update: async ({ data }: { data: Record<string, unknown> }) => ({ ...batchRow, ...data }) },
      };
      const result = await fn(tx);
      committed.vulns = staged.vulns;
      committed.auditActions.push(...staged.auditActions);
      return result;
    },
  };

  return { prisma, committed };
}

describe('acceptBatch — transactional atomicity', () => {
  it('commits the CI vulnerabilities update AND the audit row together on success', async () => {
    const { prisma, committed } = buildAcceptFixture({ failAudit: false });
    const result = await acceptBatch(prisma as any, BATCH_ID, 'admin@test.local'); // eslint-disable-line @typescript-eslint/no-explicit-any

    expect(result.summary.newCount).toBe(1);
    expect(committed.vulns).toHaveLength(1);
    expect(committed.auditActions).toEqual(['VULN_IMPORT_ACCEPT']);
  });

  it('rolls back the CI vulnerabilities update when the audit insert fails', async () => {
    const { prisma, committed } = buildAcceptFixture({ failAudit: true });
    await expect(acceptBatch(prisma as any, BATCH_ID, 'admin@test.local')).rejects.toThrow(); // eslint-disable-line @typescript-eslint/no-explicit-any

    expect(committed.vulns).toHaveLength(0);
    expect(committed.auditActions).toHaveLength(0);
  });

  it('REAPARECIDA: sets REABIERTA, preserves resolvedAt, sets reopenedAt, emits VULN_REOPENED', async () => {
    const existing = {
      key: 'oid1@443', cve: 'CVE-2024-0001', severity: 'HIGH', description: 'old', status: 'RESUELTO',
      importedAt: '2026-01-01T00:00:00.000Z', resolvedAt: '2026-02-01T00:00:00.000Z',
    };
    const entry = {
      id: ENTRY_ID, batchId: BATCH_ID, ciId: CI_ID, matchConfidence: 'EXACT_IP', decision: 'INCLUDE',
      classification: 'REAPARECIDA', vulnKey: 'oid1@443', cves: ['CVE-2024-0001'], oid: 'oid1', port: '443',
      severity: 'CRITICAL', severityScore: 9.5, name: 'Test Vuln', summary: 'reappeared',
      solution: null, family: null, qod: null, epssScore: null,
    };
    const { prisma, committed } = buildAcceptFixture({ failAudit: false, initialVulns: [existing], entry });

    const result = await acceptBatch(prisma as any, BATCH_ID, 'admin@test.local'); // eslint-disable-line @typescript-eslint/no-explicit-any

    expect(result.summary.reopenedCount).toBe(1);
    expect(committed.vulns).toHaveLength(1);
    const stored = committed.vulns[0] as Record<string, unknown>;
    expect(stored.status).toBe('REABIERTA');
    expect(stored.resolvedAt).toBe('2026-02-01T00:00:00.000Z'); // preserved
    expect(stored.reopenedAt).toBeTruthy();
    expect(typeof stored.reopenedAt).toBe('string');
    expect(committed.auditActions).toEqual(expect.arrayContaining(['VULN_REOPENED', 'VULN_IMPORT_ACCEPT']));
  });

  // ── B4 — CrowdStrike Spotlight fields carried through accept ─────────────

  it('NUEVA (CrowdStrike-sourced): carries products/exprtRating/cisaKev/cisaDueDate/exploitStatus/daysOpen/externalStatus/cvssVersion into the stored Vulnerability, with source "crowdstrike"', async () => {
    const entry = {
      id: ENTRY_ID, batchId: BATCH_ID, ciId: CI_ID, matchConfidence: 'EXACT_IP', decision: 'INCLUDE',
      classification: 'NUEVA', vulnKey: 'CVE-2024-9999', cves: ['CVE-2024-9999'], oid: null, port: null,
      severity: 'HIGH', severityScore: 7.8, name: 'Test Vuln', summary: 'A test vulnerability',
      solution: null, family: null, qod: null, epssScore: null,
      products: ['JRE 1.8.0', 'JDK 11'], exprtRating: 'High', cisaKev: true,
      cisaDueDate: new Date('2026-08-15T00:00:00.000Z'), exploitStatus: 'Actively used (critical)',
      daysOpen: 12, externalStatus: 'Open', cvssVersion: 'v3.x',
    };
    const { prisma, committed } = buildAcceptFixture({ failAudit: false, entry, batchSource: 'crowdstrike' });

    const result = await acceptBatch(prisma as any, BATCH_ID, 'admin@test.local'); // eslint-disable-line @typescript-eslint/no-explicit-any

    expect(result.summary.newCount).toBe(1);
    const stored = committed.vulns[0] as Record<string, unknown>;
    expect(stored.source).toBe('crowdstrike');
    expect(stored.products).toEqual(['JRE 1.8.0', 'JDK 11']);
    expect(stored.exprtRating).toBe('High');
    expect(stored.cisaKev).toBe(true);
    expect(stored.cisaDueDate).toBe('2026-08-15T00:00:00.000Z');
    expect(stored.exploitStatus).toBe('Actively used (critical)');
    expect(stored.daysOpen).toBe(12);
    expect(stored.externalStatus).toBe('Open');
    expect(stored.cvssVersion).toBe('v3.x');
  });

  it('REAPARECIDA (CrowdStrike-sourced, externalStatus "Reopened"): carries the 8 CrowdStrike fields into the reopened stored Vulnerability', async () => {
    const existing = {
      key: 'CVE-2024-9999', cve: 'CVE-2024-9999', severity: 'MEDIUM', description: 'old', status: 'RESUELTO',
      importedAt: '2026-01-01T00:00:00.000Z', resolvedAt: '2026-02-01T00:00:00.000Z',
      products: ['Old Product 1.0'], cisaKev: false,
    };
    const entry = {
      id: ENTRY_ID, batchId: BATCH_ID, ciId: CI_ID, matchConfidence: 'EXACT_IP', decision: 'INCLUDE',
      classification: 'REAPARECIDA', vulnKey: 'CVE-2024-9999', cves: ['CVE-2024-9999'], oid: null, port: null,
      severity: 'CRITICAL', severityScore: 9.1, name: 'Test Vuln', summary: 'reappeared',
      solution: null, family: null, qod: null, epssScore: null,
      products: ['New Product 2.0'], exprtRating: 'Critical', cisaKev: true,
      cisaDueDate: new Date('2026-09-01T00:00:00.000Z'), exploitStatus: 'Easily Accessible (high)',
      daysOpen: 3, externalStatus: 'Reopened', cvssVersion: 'v3.x',
    };
    const { prisma, committed } = buildAcceptFixture({
      failAudit: false, initialVulns: [existing], entry, batchSource: 'crowdstrike',
    });

    const result = await acceptBatch(prisma as any, BATCH_ID, 'admin@test.local'); // eslint-disable-line @typescript-eslint/no-explicit-any

    expect(result.summary.reopenedCount).toBe(1);
    const stored = committed.vulns[0] as Record<string, unknown>;
    expect(stored.status).toBe('REABIERTA');
    expect(stored.products).toEqual(['New Product 2.0']);
    expect(stored.exprtRating).toBe('Critical');
    expect(stored.cisaKev).toBe(true);
    expect(stored.cisaDueDate).toBe('2026-09-01T00:00:00.000Z');
    expect(stored.exploitStatus).toBe('Easily Accessible (high)');
    expect(stored.daysOpen).toBe(3);
    expect(stored.externalStatus).toBe('Reopened');
    expect(stored.cvssVersion).toBe('v3.x');
  });

  it('REAPARECIDA: preserves the previously-stored CrowdStrike fields when the reopening entry does not carry them (e.g. a Greenbone reimport)', async () => {
    const existing = {
      key: 'oid1@443', cve: 'CVE-2024-0001', severity: 'HIGH', description: 'old', status: 'RESUELTO',
      importedAt: '2026-01-01T00:00:00.000Z', resolvedAt: '2026-02-01T00:00:00.000Z',
      products: ['Preserved Product 1.0'], exprtRating: 'High', cisaDueDate: '2026-08-15T00:00:00.000Z',
      // cisaKev: true here, matched against buildAcceptFixture's default
      // entry.cisaKev of false below — proves the sticky-true merge (D
      // below is the load-bearing assertion: a KEV flag must never be
      // silently cleared just because the reopening source doesn't carry it).
      exploitStatus: 'Unproven', daysOpen: 20, externalStatus: 'Open', cvssVersion: 'v3.x', cisaKev: true,
    };
    const entry = {
      id: ENTRY_ID, batchId: BATCH_ID, ciId: CI_ID, matchConfidence: 'EXACT_IP', decision: 'INCLUDE',
      classification: 'REAPARECIDA', vulnKey: 'oid1@443', cves: ['CVE-2024-0001'], oid: 'oid1', port: '443',
      severity: 'CRITICAL', severityScore: 9.5, name: 'Test Vuln', summary: 'reappeared',
      solution: null, family: null, qod: null, epssScore: null,
      // cisaKev intentionally omitted — buildAcceptFixture defaults it to
      // false, i.e. this incoming entry does NOT carry a KEV flag.
    };
    const { prisma, committed } = buildAcceptFixture({ failAudit: false, initialVulns: [existing], entry });

    await acceptBatch(prisma as any, BATCH_ID, 'admin@test.local'); // eslint-disable-line @typescript-eslint/no-explicit-any

    const stored = committed.vulns[0] as Record<string, unknown>;
    expect(stored.products).toEqual(['Preserved Product 1.0']);
    expect(stored.exprtRating).toBe('High');
    expect(stored.cisaDueDate).toBe('2026-08-15T00:00:00.000Z');
    expect(stored.exploitStatus).toBe('Unproven');
    expect(stored.daysOpen).toBe(20);
    expect(stored.externalStatus).toBe('Open');
    expect(stored.cvssVersion).toBe('v3.x');
    // Load-bearing: existing.cisaKev=true, incoming entry.cisaKev=false
    // (defaulted) — merged result must stay true (sticky-true), not be
    // overwritten by the incoming false.
    expect(stored.cisaKev).toBe(true);
  });

  it.each([
    ['existing true, incoming true -> true', true, true, true],
    ['existing false, incoming false -> false', false, false, false],
    ['existing false, incoming true -> true', false, true, true],
  ])('REAPARECIDA cisaKev sticky-true merge: %s', async (_label, existingCisaKev, incomingCisaKev, expected) => {
    const existing = {
      key: 'oid1@443', cve: 'CVE-2024-0001', severity: 'HIGH', description: 'old', status: 'RESUELTO',
      importedAt: '2026-01-01T00:00:00.000Z', resolvedAt: '2026-02-01T00:00:00.000Z',
      cisaKev: existingCisaKev,
    };
    const entry = {
      id: ENTRY_ID, batchId: BATCH_ID, ciId: CI_ID, matchConfidence: 'EXACT_IP', decision: 'INCLUDE',
      classification: 'REAPARECIDA', vulnKey: 'oid1@443', cves: ['CVE-2024-0001'], oid: 'oid1', port: '443',
      severity: 'CRITICAL', severityScore: 9.5, name: 'Test Vuln', summary: 'reappeared',
      solution: null, family: null, qod: null, epssScore: null,
      cisaKev: incomingCisaKev,
    };
    const { prisma, committed } = buildAcceptFixture({ failAudit: false, initialVulns: [existing], entry });

    await acceptBatch(prisma as any, BATCH_ID, 'admin@test.local'); // eslint-disable-line @typescript-eslint/no-explicit-any

    const stored = committed.vulns[0] as Record<string, unknown>;
    expect(stored.cisaKev).toBe(expected);
  });
});
