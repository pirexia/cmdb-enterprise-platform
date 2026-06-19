/**
 * T4 licenses module — integration tests (mocked Prisma, no real DB).
 * Covers: 401/403 RBAC, CRUD happy-paths + validation, CI/doc/user associations,
 * audit log insert, RAG queue/purge calls.
 */

const mockLicenseFindUnique   = jest.fn();
const mockLicenseCreate       = jest.fn();
const mockLicenseUpdate       = jest.fn();
const mockLicenseDelete       = jest.fn();
const mockLicenseUserFindMany = jest.fn();
const mockLicenseUserCreate   = jest.fn();
const mockLicenseUserDelete   = jest.fn();
const mockQueryRaw            = jest.fn();
const mockExecuteRaw          = jest.fn();
const mockGetLicenseRoot      = jest.fn().mockResolvedValue('root-license-id-aaaa-bbbbbbbbbbbb');
const mockEmitHook            = jest.fn().mockResolvedValue(null);

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    license:     {
      findUnique: mockLicenseFindUnique,
      create:     mockLicenseCreate,
      update:     mockLicenseUpdate,
      delete:     mockLicenseDelete,
    },
    licenseUser: {
      findMany: mockLicenseUserFindMany,
      create:   mockLicenseUserCreate,
      delete:   mockLicenseUserDelete,
    },
    $queryRaw:   mockQueryRaw,
    $executeRaw: mockExecuteRaw,
  })),
  Prisma: { raw: (v: string) => ({ sql: v, values: [] }) },
}));

// entitySerializer creates a PrismaClient at module level — mock the whole module
jest.mock('../../../services/entitySerializer', () => ({
  getLicenseRoot: mockGetLicenseRoot,
}));

jest.mock('../../../modules/plugins/index', () => ({
  emitHook: mockEmitHook,
}));

process.env.JWT_SECRET = 'test-secret-32-chars-minimum-len!!';

import express        from 'express';
import supertest      from 'supertest';
import jwt            from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { createLicensesRouter } from '../router.js';

const TEST_SECRET  = 'test-secret-32-chars-minimum-len!!';
const prisma       = new PrismaClient() as any;
const mockQueue    = jest.fn();
const mockPurge    = jest.fn().mockResolvedValue(undefined);

const LICENSE_ID  = 'aaaaaaaa-1111-2222-3333-444444444444';
const CI_ID       = 'bbbbbbbb-1111-2222-3333-444444444444';
const DOC_ID      = 'cccccccc-1111-2222-3333-444444444444';
const USER_ID     = 'dddddddd-1111-2222-3333-444444444444';
const LU_ID       = 'eeeeeeee-1111-2222-3333-444444444444';

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
  app.use('/api/licenses', createLicensesRouter(prisma, mockQueue, mockPurge));
  return supertest(app);
}

const VALID_LICENSE = {
  name: 'Office 365', licenseNumber: 'LIC-001', startDate: '2024-01-01',
  currency: 'EUR', status: 'ACTIVO',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockQueryRaw.mockResolvedValue([{ active: true }]);
  mockExecuteRaw.mockResolvedValue(1);
  mockEmitHook.mockResolvedValue(null);
  mockGetLicenseRoot.mockResolvedValue('root-license-id-aaaa-bbbbbbbbbbbb');
  mockPurge.mockResolvedValue(undefined);
});

// ── GET /api/licenses ─────────────────────────────────────────────────────────

describe('GET /api/licenses', () => {
  it('returns 401 without token', async () => {
    const res = await buildApp().get('/api/licenses');
    expect(res.status).toBe(401);
  });

  it('returns paginated list with counts', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])           // auth
      .mockResolvedValueOnce([{ c: BigInt(2) }])           // count
      .mockResolvedValueOnce([
        { id: LICENSE_ID, name: 'Test', licenseNumber: 'L1', startDate: new Date(), endDate: null,
          status: 'ACTIVO', currency: 'EUR', cost: '500.00', vendorName: 'Acme',
          licenseTypeName: 'OEM', licenseMetricName: 'Seats', ciCount: BigInt(3), addendumCount: BigInt(1) },
      ]);
    const res = await buildApp()
      .get('/api/licenses')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.data[0].ciCount).toBe(3);
    expect(res.body.data[0].addendumCount).toBe(1);
    expect(res.body.data[0].cost).toBe(500);
  });
});

// ── GET /api/licenses/:id ─────────────────────────────────────────────────────

describe('GET /api/licenses/:id', () => {
  it('returns 404 when license not found', async () => {
    mockLicenseFindUnique.mockResolvedValue(null);
    const res = await buildApp()
      .get(`/api/licenses/${LICENSE_ID}`)
      .set('Authorization', `Bearer ${makeToken('AUDITOR')}`);
    expect(res.status).toBe(404);
  });

  it('returns license with documents', async () => {
    const fakeLicense = { id: LICENSE_ID, name: 'Test', cis: [], licenseUsers: [], addendums: [], parentLicense: null };
    mockLicenseFindUnique.mockResolvedValue(fakeLicense);
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }]) // auth
      .mockResolvedValueOnce([]);                // documents query

    const res = await buildApp()
      .get(`/api/licenses/${LICENSE_ID}`)
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(LICENSE_ID);
    expect(res.body.documents).toEqual([]);
  });
});

// ── POST /api/licenses ────────────────────────────────────────────────────────

describe('POST /api/licenses', () => {
  it('returns 401 without token', async () => {
    const res = await buildApp().post('/api/licenses').send(VALID_LICENSE);
    expect(res.status).toBe(401);
  });

  it('returns 403 for AUDITOR', async () => {
    const res = await buildApp()
      .post('/api/licenses')
      .set('Authorization', `Bearer ${makeToken('AUDITOR')}`)
      .send(VALID_LICENSE);
    expect(res.status).toBe(403);
  });

  it('returns 400 for invalid body (missing name)', async () => {
    const res = await buildApp()
      .post('/api/licenses')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ licenseNumber: 'LIC-001', startDate: '2024-01-01' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid license data');
  });

  it('creates license, inserts audit log, queues for RAG', async () => {
    const created = { id: LICENSE_ID, ...VALID_LICENSE };
    mockLicenseCreate.mockResolvedValue(created);

    const res = await buildApp()
      .post('/api/licenses')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send(VALID_LICENSE);

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(LICENSE_ID);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);  // audit log
    expect(mockQueue).toHaveBeenCalledWith('license', 'root-license-id-aaaa-bbbbbbbbbbbb');
    expect(mockEmitHook).toHaveBeenCalledWith('preCreateLicense', expect.any(Object), 'pre');
    expect(mockEmitHook).toHaveBeenCalledWith('postCreateLicense', expect.any(Object));
  });

  it('returns 409 when pre-hook cancels', async () => {
    mockEmitHook.mockResolvedValueOnce({ cancel: true, reason: 'Duplicate license' });

    const res = await buildApp()
      .post('/api/licenses')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send(VALID_LICENSE);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Duplicate license');
    expect(mockLicenseCreate).not.toHaveBeenCalled();
  });
});

// ── PATCH /api/licenses/:id ───────────────────────────────────────────────────

describe('PATCH /api/licenses/:id', () => {
  it('returns 403 for VIEWER', async () => {
    const res = await buildApp()
      .patch(`/api/licenses/${LICENSE_ID}`)
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`)
      .send({ name: 'New' });
    expect(res.status).toBe(403);
  });

  it('updates license and inserts audit log', async () => {
    const updated = { id: LICENSE_ID, name: 'Updated' };
    mockLicenseUpdate.mockResolvedValue(updated);

    const res = await buildApp()
      .patch(`/api/licenses/${LICENSE_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ name: 'Updated' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated');
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1); // audit log
    expect(mockQueue).toHaveBeenCalledWith('license', expect.any(String));
  });
});

// ── DELETE /api/licenses/:id ──────────────────────────────────────────────────

describe('DELETE /api/licenses/:id', () => {
  it('purges from RAG when deleting the root', async () => {
    mockGetLicenseRoot.mockResolvedValue(LICENSE_ID); // IS the root
    mockLicenseDelete.mockResolvedValue({ id: LICENSE_ID });

    const res = await buildApp()
      .delete(`/api/licenses/${LICENSE_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockPurge).toHaveBeenCalledWith('license', LICENSE_ID);
    expect(mockQueue).not.toHaveBeenCalled();
  });

  it('re-queues root when deleting an addendum', async () => {
    const ROOT_ID = 'root-0000-0000-0000-000000000000';
    mockGetLicenseRoot.mockResolvedValue(ROOT_ID); // different from LICENSE_ID
    mockLicenseDelete.mockResolvedValue({ id: LICENSE_ID });

    const res = await buildApp()
      .delete(`/api/licenses/${LICENSE_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(mockPurge).not.toHaveBeenCalled();
    expect(mockQueue).toHaveBeenCalledWith('license', ROOT_ID);
  });
});

// ── CI associations ───────────────────────────────────────────────────────────

describe('GET /api/licenses/:id/cis', () => {
  it('returns CI list', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])
      .mockResolvedValueOnce([{ id: CI_ID, name: 'server01', apiSlug: 'server01', environment: 'PROD', criticality: 'HIGH' }]);

    const res = await buildApp()
      .get(`/api/licenses/${LICENSE_ID}/cis`)
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});

describe('POST /api/licenses/:id/cis', () => {
  it('returns 400 for empty ciIds', async () => {
    const res = await buildApp()
      .post(`/api/licenses/${LICENSE_ID}/cis`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ ciIds: [] });
    expect(res.status).toBe(400);
  });

  it('associates CIs and inserts audit log', async () => {
    mockLicenseUpdate.mockResolvedValue({ id: LICENSE_ID });

    const res = await buildApp()
      .post(`/api/licenses/${LICENSE_ID}/cis`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ ciIds: [CI_ID] });

    expect(res.status).toBe(200);
    expect(res.body.associated).toBe(1);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1); // audit log
    expect(mockQueue).toHaveBeenCalledWith('license', expect.any(String));
    expect(mockQueue).toHaveBeenCalledWith('ci', CI_ID);
  });
});

describe('DELETE /api/licenses/:id/cis/:ciId', () => {
  it('disassociates CI and inserts audit log', async () => {
    mockLicenseUpdate.mockResolvedValue({ id: LICENSE_ID });

    const res = await buildApp()
      .delete(`/api/licenses/${LICENSE_ID}/cis/${CI_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockQueue).toHaveBeenCalledWith('ci', CI_ID);
  });
});

// ── Document associations ─────────────────────────────────────────────────────

describe('GET /api/licenses/:id/documents', () => {
  it('returns document list for AUDITOR', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])
      .mockResolvedValueOnce([]);

    const res = await buildApp()
      .get(`/api/licenses/${LICENSE_ID}/documents`)
      .set('Authorization', `Bearer ${makeToken('AUDITOR')}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('POST /api/licenses/:id/documents', () => {
  it('associates documents and inserts audit log', async () => {
    const res = await buildApp()
      .post(`/api/licenses/${LICENSE_ID}/documents`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ documentIds: [DOC_ID] });

    expect(res.status).toBe(200);
    expect(res.body.associated).toBe(1);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(2); // INSERT doc_licenses + audit log
  });
});

describe('DELETE /api/licenses/:id/documents/:docId', () => {
  it('removes document association and inserts audit log', async () => {
    const res = await buildApp()
      .delete(`/api/licenses/${LICENSE_ID}/documents/${DOC_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(2); // DELETE + audit log
  });
});

// ── LicenseUser CRUD ──────────────────────────────────────────────────────────

describe('GET /api/licenses/:id/users', () => {
  it('returns user list', async () => {
    mockLicenseUserFindMany.mockResolvedValue([{ id: LU_ID, name: 'Jane', dni: null, email: null }]);

    const res = await buildApp()
      .get(`/api/licenses/${LICENSE_ID}/users`)
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});

describe('POST /api/licenses/:id/users', () => {
  it('returns 400 for missing name', async () => {
    const res = await buildApp()
      .post(`/api/licenses/${LICENSE_ID}/users`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ dni: '12345678A' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid user data');
  });

  it('creates license user and inserts audit log', async () => {
    mockLicenseUserCreate.mockResolvedValue({ id: LU_ID, name: 'Jane', dni: null, email: null, licenseId: LICENSE_ID });

    const res = await buildApp()
      .post(`/api/licenses/${LICENSE_ID}/users`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ name: 'Jane' });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Jane');
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1); // audit log
    expect(mockQueue).toHaveBeenCalledWith('license', expect.any(String));
  });
});

describe('DELETE /api/licenses/:id/users/:userId', () => {
  it('deletes license user, audit log first', async () => {
    mockLicenseUserDelete.mockResolvedValue({ id: LU_ID });

    const res = await buildApp()
      .delete(`/api/licenses/${LICENSE_ID}/users/${LU_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1); // audit log
    // audit log fires BEFORE delete (preserves record before deletion)
    const executeOrder = mockExecuteRaw.mock.invocationCallOrder[0];
    const deleteOrder  = mockLicenseUserDelete.mock.invocationCallOrder[0];
    expect(executeOrder).toBeLessThan(deleteOrder);
  });
});
