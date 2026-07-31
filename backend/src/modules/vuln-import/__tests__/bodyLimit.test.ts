/**
 * B5 fix verification — POST /api/vuln-import/upload body-size limit.
 *
 * The original implementation added a route-local
 * `express.json({limit:'20mb'})` inside router.ts, ahead of the /upload
 * handler *within the router*. That does nothing in the real app: index.ts
 * registers a GLOBAL `app.use(express.json({limit:'2mb'}))` (line ~172)
 * BEFORE any router — including this one — is mounted (line ~283). Express
 * dispatches path-matching middleware in registration order, so requests
 * with a body between 2MB and 20MB were rejected with 413 by the global
 * parser before ever reaching the router.
 *
 * The isolated-router test harness in router.test.ts builds its own bare
 * `express()` app with only this router mounted (default express.json(),
 * no global 2MB parser in front of it) — it structurally cannot reproduce
 * this bug. This file instead builds a small app that reproduces the real
 * index.ts *ordering*: a path-scoped 20MB parser on
 * '/api/vuln-import/upload', registered ahead of a blanket 2MB parser that
 * covers every other route — exactly as index.ts now does it.
 */

const mockQueryRaw = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    $queryRaw: mockQueryRaw,
    $executeRaw: jest.fn().mockResolvedValue(1),
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
    vulnImportBatch: { create: jest.fn(), findMany: jest.fn(), count: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    vulnImportEntry: { groupBy: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  })),
  Prisma: { JsonNull: null },
}));

process.env.JWT_SECRET = 'test-secret-32-chars-minimum-len!!';

import express from 'express';
import supertest from 'supertest';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { createVulnImportRouter } from '../router.js';
import { createIntegrationsRouter } from '../../integrations/router.js';

const TEST_SECRET = 'test-secret-32-chars-minimum-len!!';
const prisma = new PrismaClient() as any; // eslint-disable-line @typescript-eslint/no-explicit-any

const ADMIN_TOKEN = jwt.sign(
  { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', username: 'admin', email: 'admin@test.local', role: 'ADMIN' },
  TEST_SECRET,
  { expiresIn: '1h' },
);

/**
 * Mirrors index.ts's real middleware ordering (index.ts lines ~172-283):
 *   1. path-scoped 20MB parser on '/api/vuln-import/upload'
 *   2. blanket 2MB parser for everything else (including every other
 *      vuln-import route, and any other route in the app)
 *   3. router mounted last
 * Also includes a throwaway '/api/other' echo route, standing in for "some
 * other existing route in the app", to prove the global 2MB ceiling is
 * still enforced unchanged elsewhere.
 */
function buildAppMirroringIndexTs() {
  const app = express();
  app.use('/api/vuln-import/upload', express.json({ limit: '20mb' }));
  app.use('/api/integrations/crowdstrike', express.json({ limit: '20mb' }));
  app.use(express.json({ limit: '2mb' }));
  app.post('/api/other', (req, res) => res.status(200).json({ ok: true, size: JSON.stringify(req.body).length }));
  app.use('/api/vuln-import', createVulnImportRouter(prisma));
  app.use('/api/integrations', createIntegrationsRouter(prisma, () => {}));
  return supertest(app);
}

// A large-but-parseable Greenbone-shaped payload: > 2MB, < 20MB. Content
// doesn't need to pass full domain validation — we're only proving the
// body-size ceiling, not upload correctness (it's fine if this 404s/400s
// downstream on shape; what must NOT happen is a 413 from the JSON parser).
function buildOversizedPayload(approxBytes: number) {
  const padding = 'A'.repeat(approxBytes);
  return { allHostSubreportEntries: [], taskName: 'padding', _padding: padding };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQueryRaw.mockResolvedValue([{ active: true }]); // authenticateToken active-user check
});

describe('POST /api/vuln-import/upload body-size limit (index.ts ordering)', () => {
  it('does NOT reject a body between 2MB and 20MB with 413 (proves the 20MB ceiling is live)', async () => {
    const payload = buildOversizedPayload(4 * 1024 * 1024); // ~4MB, > 2MB global default
    const res = await buildAppMirroringIndexTs()
      .post('/api/vuln-import/upload')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send(payload);

    // Must not be rejected by the body parser at all. It may still fail
    // validation further downstream (empty allHostSubreportEntries etc.) —
    // that's fine and expected; we're only proving the size ceiling.
    expect(res.status).not.toBe(413);
  });

  it('still rejects a body over the 20MB route ceiling with 413', async () => {
    const payload = buildOversizedPayload(21 * 1024 * 1024); // > 20MB
    const res = await buildAppMirroringIndexTs()
      .post('/api/vuln-import/upload')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send(payload);

    expect(res.status).toBe(413);
  });

  it('leaves the global 2MB limit intact for other routes (does not raise the app-wide ceiling)', async () => {
    const payload = buildOversizedPayload(3 * 1024 * 1024); // > 2MB, would pass under the 20MB ceiling
    const res = await buildAppMirroringIndexTs()
      .post('/api/other')
      .send(payload);

    expect(res.status).toBe(413);
  });

  it('still enforces the 2MB limit on the rest of the vuln-import router (e.g. bulk-decision)', async () => {
    const payload = { entryIds: ['x'], decision: 'INCLUDE', _padding: 'A'.repeat(3 * 1024 * 1024) };
    const res = await buildAppMirroringIndexTs()
      .post('/api/vuln-import/batches/cccccccc-dddd-eeee-ffff-000000000000/entries/bulk-decision')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send(payload);

    expect(res.status).toBe(413);
  });
});

/**
 * B4 (v3.6.1) — same ordering fix, same test approach, for
 * POST /api/integrations/crowdstrike: a real CrowdStrike Spotlight export
 * is ~686KB for a SINGLE host (docs/mocks/crowdstrike_SRV-MYGESTR01D.json);
 * a multi-host export easily exceeds the app-wide 2MB JSON limit. See
 * index.ts's path-scoped `express.json({limit:'20mb'})` on
 * '/api/integrations/crowdstrike', registered ahead of the blanket 2MB
 * parser exactly like the vuln-import upload route above.
 */
function buildOversizedSpotlightPayload(approxBytes: number) {
  return [{ vulnerability_id: 'padding', local_ip: '1.2.3.4', hostname: 'h', base_score: '7.8 v3.x', _padding: 'A'.repeat(approxBytes) }];
}

describe('POST /api/integrations/crowdstrike body-size limit (index.ts ordering)', () => {
  it('does NOT reject a body between 2MB and 20MB with 413 (proves the 20MB ceiling is live)', async () => {
    const payload = buildOversizedSpotlightPayload(4 * 1024 * 1024); // ~4MB, > 2MB global default
    const res = await buildAppMirroringIndexTs()
      .post('/api/integrations/crowdstrike')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send(payload);

    // May still fail downstream (matching/classification/schema) — that's
    // fine; we're only proving the body parser doesn't 413 it.
    expect(res.status).not.toBe(413);
  });

  it('still rejects a body over the 20MB route ceiling with 413', async () => {
    const payload = buildOversizedSpotlightPayload(21 * 1024 * 1024); // > 20MB
    const res = await buildAppMirroringIndexTs()
      .post('/api/integrations/crowdstrike')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send(payload);

    expect(res.status).toBe(413);
  });

  it('leaves the global 2MB limit intact for other routes (does not raise the app-wide ceiling)', async () => {
    const payload = buildOversizedPayload(3 * 1024 * 1024); // > 2MB
    const res = await buildAppMirroringIndexTs()
      .post('/api/other')
      .send(payload);

    expect(res.status).toBe(413);
  });

  it('still enforces the 2MB limit on the OTHER crowdstrike-adjacent route (/api/integrations/greenbone)', async () => {
    const payload = { allHostSubreportEntries: [], _padding: 'A'.repeat(3 * 1024 * 1024) };
    const res = await buildAppMirroringIndexTs()
      .post('/api/integrations/greenbone')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`)
      .send(payload);

    expect(res.status).toBe(413);
  });
});
