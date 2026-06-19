/**
 * T3 integrations module — integration tests (mocked Prisma, no real DB).
 * Covers: 401/403 RBAC, happy-path matched/unmatched for Greenbone and CrowdStrike,
 * Greenbone merge (preserves analyst-set vuln status), audit log insert.
 */

const mockQueryRaw   = jest.fn();
const mockExecuteRaw = jest.fn();
const mockVulnUuid   = jest.fn().mockReturnValue('aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee');

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    $queryRaw:   mockQueryRaw,
    $executeRaw: mockExecuteRaw,
  })),
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

const GB_BODY = {
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

describe('POST /api/integrations/greenbone — processing', () => {
  it('matches CI, updates vulnerabilities, queues for RAG, inserts audit log', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])              // auth
      .mockResolvedValueOnce([{ id: CI_ID, name: 'server01' }]) // CI lookup
      .mockResolvedValueOnce([{ vulnerabilities: [] }]);      // existing vulns

    const res = await buildApp()
      .post('/api/integrations/greenbone')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send(GB_BODY);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Greenbone report processed');
    expect(res.body.totalMatched).toBe(1);
    expect(res.body.totalUnmatched).toBe(0);
    expect(res.body.processed[0]).toMatchObject({ ci: 'server01', matched: true, vulnCount: 1 });
    // UPDATE vulns + INSERT audit = 2 execute calls
    expect(mockExecuteRaw).toHaveBeenCalledTimes(2);
    // queueForIndexing called for each vuln + the CI itself
    expect(mockQueue).toHaveBeenCalledWith('vulnerability', expect.any(String));
    expect(mockQueue).toHaveBeenCalledWith('ci', CI_ID);
  });

  it('returns matched:false when no CI found, still inserts audit log', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }]) // auth
      .mockResolvedValueOnce([]);                // no CI match

    const res = await buildApp()
      .post('/api/integrations/greenbone')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send(GB_BODY);

    expect(res.status).toBe(200);
    expect(res.body.totalMatched).toBe(0);
    expect(res.body.totalUnmatched).toBe(1);
    expect(res.body.processed[0]).toMatchObject({ ci: 'server01', matched: false });
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1); // only audit log
    expect(mockQueue).not.toHaveBeenCalled();
  });

  it('preserves analyst-set vuln status on re-import (merge logic)', async () => {
    const existingVulns = [{
      cve: 'CVE-2024-0001', severity: 'HIGH', status: 'RESUELTO',
      description: 'Old desc', importedAt: '2024-01-01T00:00:00.000Z',
    }];
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])
      .mockResolvedValueOnce([{ id: CI_ID, name: 'server01' }])
      .mockResolvedValueOnce([{ vulnerabilities: existingVulns }]);

    const res = await buildApp()
      .post('/api/integrations/greenbone')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send(GB_BODY);

    expect(res.status).toBe(200);
    // 1 re-reported vuln — merged result keeps it (count stays 1, not 2)
    expect(res.body.processed[0].vulnCount).toBe(1);
    // UPDATE + audit
    expect(mockExecuteRaw).toHaveBeenCalledTimes(2);
    // vulnUuid called for the merged vuln
    expect(mockVulnUuid).toHaveBeenCalledWith(CI_ID, 'CVE-2024-0001');
  });

  it('handles empty results array gracefully', async () => {
    const res = await buildApp()
      .post('/api/integrations/greenbone')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ results: [] });

    expect(res.status).toBe(200);
    expect(res.body.totalMatched).toBe(0);
    expect(res.body.totalUnmatched).toBe(0);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1); // only audit log
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
