/**
 * T5 contracts module — integration tests (mocked Prisma, no real DB).
 * Covers: 401/403 RBAC, CRUD happy-paths + validation, doc/CI associations,
 * addendum pre-check (409), P2002 duplicate (409), plugin hook cancel, audit log.
 */

const mockContractFindMany  = jest.fn();
const mockContractFindUnique = jest.fn();
const mockContractCreate    = jest.fn();
const mockContractUpdate    = jest.fn();
const mockContractDelete    = jest.fn();
const mockQueryRaw          = jest.fn();
const mockExecuteRaw        = jest.fn();
const mockTransaction       = jest.fn();
const mockGetContractRoot   = jest.fn().mockResolvedValue('root-contract-id-aaaa-000000000000');
const mockEmitHook          = jest.fn().mockResolvedValue(null);

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    contract: {
      findMany:   mockContractFindMany,
      findUnique: mockContractFindUnique,
      create:     mockContractCreate,
      update:     mockContractUpdate,
      delete:     mockContractDelete,
    },
    $queryRaw:   mockQueryRaw,
    $executeRaw: mockExecuteRaw,
    $transaction: mockTransaction,
  })),
  Prisma: { raw: (v: string) => ({ sql: v, values: [] }) },
}));

jest.mock('../../../services/entitySerializer', () => ({
  getContractRoot: mockGetContractRoot,
}));

jest.mock('../../../modules/plugins/index', () => ({
  emitHook: mockEmitHook,
}));

process.env.JWT_SECRET = 'test-secret-32-chars-minimum-len!!';

import express        from 'express';
import supertest      from 'supertest';
import jwt            from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { createContractsRouter } from '../router.js';

const TEST_SECRET   = 'test-secret-32-chars-minimum-len!!';
const prisma        = new PrismaClient() as any;
const mockQueue     = jest.fn();

const CONTRACT_ID  = 'aaaaaaaa-1111-2222-3333-444444444444';
const CI_ID        = 'bbbbbbbb-1111-2222-3333-444444444444';
const DOC_ID       = 'cccccccc-1111-2222-3333-444444444444';
const USER_ID      = 'dddddddd-1111-2222-3333-444444444444';

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
  app.use('/api/contracts', createContractsRouter(prisma, mockQueue));
  return supertest(app);
}

const VALID_CONTRACT = {
  contractNumber: 'CON-001',
  startDate: '2024-01-01',
  vendorId: 'eeeeeeee-1111-2222-3333-444444444444',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockQueryRaw.mockResolvedValue([{ active: true }]);
  mockExecuteRaw.mockResolvedValue(1);
  mockEmitHook.mockResolvedValue(null);
  mockGetContractRoot.mockResolvedValue('root-contract-id-aaaa-000000000000');
  // $transaction passes same prisma as tx
  mockTransaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma));
});

// ── GET /api/contracts ────────────────────────────────────────────────────────

describe('GET /api/contracts', () => {
  it('returns 401 without token', async () => {
    const res = await buildApp().get('/api/contracts');
    expect(res.status).toBe(401);
  });

  it('returns contracts list for VIEWER', async () => {
    const fakeContract = { id: CONTRACT_ID, contractNumber: 'CON-001', vendor: { id: 'v1', name: 'Acme' }, cis: [], addendums: [], parentContract: null };
    mockContractFindMany.mockResolvedValue([fakeContract]);

    const res = await buildApp()
      .get('/api/contracts')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].contractNumber).toBe('CON-001');
  });
});

// ── POST /api/contracts ───────────────────────────────────────────────────────

describe('POST /api/contracts', () => {
  it('returns 401 without token', async () => {
    const res = await buildApp().post('/api/contracts').send(VALID_CONTRACT);
    expect(res.status).toBe(401);
  });

  it('returns 403 for AUDITOR', async () => {
    const res = await buildApp()
      .post('/api/contracts')
      .set('Authorization', `Bearer ${makeToken('AUDITOR')}`)
      .send(VALID_CONTRACT);
    expect(res.status).toBe(403);
  });

  it('returns 400 for missing contractNumber', async () => {
    const res = await buildApp()
      .post('/api/contracts')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ startDate: '2024-01-01', vendorId: 'eeeeeeee-1111-2222-3333-444444444444' });
    expect(res.status).toBe(400);
  });

  it('creates contract, inserts audit log, queues for RAG', async () => {
    const created = { id: CONTRACT_ID, ...VALID_CONTRACT, cis: [], addendums: [], parentContract: null, vendor: null };
    mockContractCreate.mockResolvedValue(created);

    const res = await buildApp()
      .post('/api/contracts')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send(VALID_CONTRACT);

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(CONTRACT_ID);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);  // audit log
    expect(mockQueue).toHaveBeenCalledWith('contract', 'root-contract-id-aaaa-000000000000');
    expect(mockEmitHook).toHaveBeenCalledWith('preCreateContract', expect.any(Object), 'pre');
    expect(mockEmitHook).toHaveBeenCalledWith('postCreateContract', expect.any(Object));
  });

  it('returns 409 when plugin pre-hook cancels', async () => {
    mockEmitHook.mockResolvedValueOnce({ cancel: true, reason: 'Duplicate detected' });

    const res = await buildApp()
      .post('/api/contracts')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send(VALID_CONTRACT);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Duplicate detected');
    expect(mockContractCreate).not.toHaveBeenCalled();
  });

  it('returns 409 on P2002 duplicate contract number', async () => {
    mockContractCreate.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));

    const res = await buildApp()
      .post('/api/contracts')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send(VALID_CONTRACT);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/);
  });
});

// ── DELETE /api/contracts/:id ─────────────────────────────────────────────────

describe('DELETE /api/contracts/:id', () => {
  it('returns 404 when contract not found', async () => {
    mockContractFindUnique.mockResolvedValue(null);
    const res = await buildApp()
      .delete(`/api/contracts/${CONTRACT_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(404);
  });

  it('returns 409 when contract has active addendums', async () => {
    mockContractFindUnique.mockResolvedValue({ id: CONTRACT_ID, contractNumber: 'CON-001', parentContractId: null });
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])  // auth
      .mockResolvedValueOnce([{ c: BigInt(2) }]); // addendum count

    const res = await buildApp()
      .delete(`/api/contracts/${CONTRACT_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);

    expect(res.status).toBe(409);
    expect(res.body.addendumCount).toBe(2);
  });

  it('deletes root contract and does NOT re-queue (rootId === contractId)', async () => {
    mockContractFindUnique.mockResolvedValue({ id: CONTRACT_ID, contractNumber: 'CON-001', parentContractId: null });
    mockGetContractRoot.mockResolvedValue(CONTRACT_ID); // IS the root
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }]) // auth
      .mockResolvedValueOnce([{ c: BigInt(0) }]); // no addendums

    const res = await buildApp()
      .delete(`/api/contracts/${CONTRACT_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockQueue).not.toHaveBeenCalled(); // root deleted — no re-queue
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it('re-queues root when deleting an addendum', async () => {
    const ROOT_ID = 'root-0000-0000-0000-000000000000';
    mockContractFindUnique.mockResolvedValue({ id: CONTRACT_ID, contractNumber: 'CON-002', parentContractId: ROOT_ID });
    mockGetContractRoot.mockResolvedValue(ROOT_ID);
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])
      .mockResolvedValueOnce([{ c: BigInt(0) }]);

    const res = await buildApp()
      .delete(`/api/contracts/${CONTRACT_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);

    expect(res.status).toBe(200);
    expect(mockQueue).toHaveBeenCalledWith('contract', ROOT_ID);
  });
});

// ── PATCH /api/contracts/:id ──────────────────────────────────────────────────

describe('PATCH /api/contracts/:id', () => {
  it('returns 403 for VIEWER', async () => {
    const res = await buildApp()
      .patch(`/api/contracts/${CONTRACT_ID}`)
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`)
      .send(VALID_CONTRACT);
    expect(res.status).toBe(403);
  });

  it('returns 400 for missing vendorId', async () => {
    const res = await buildApp()
      .patch(`/api/contracts/${CONTRACT_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ contractNumber: 'CON-001', startDate: '2024-01-01' });
    expect(res.status).toBe(400);
  });

  it('updates contract and inserts audit log', async () => {
    const updated = { id: CONTRACT_ID, contractNumber: 'CON-001-UPD', cis: [], addendums: [], parentContract: null, vendor: null };
    mockContractUpdate.mockResolvedValue(updated);

    const res = await buildApp()
      .patch(`/api/contracts/${CONTRACT_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ ...VALID_CONTRACT, contractNumber: 'CON-001-UPD' });

    expect(res.status).toBe(200);
    expect(res.body.contractNumber).toBe('CON-001-UPD');
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1); // audit log
    expect(mockQueue).toHaveBeenCalledWith('contract', expect.any(String));
  });

  it('returns 409 on P2002 duplicate', async () => {
    mockContractUpdate.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    const res = await buildApp()
      .patch(`/api/contracts/${CONTRACT_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send(VALID_CONTRACT);
    expect(res.status).toBe(409);
  });
});

// ── Document associations ─────────────────────────────────────────────────────

describe('GET /api/contracts/:id/documents', () => {
  it('returns document list', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])
      .mockResolvedValueOnce([]);
    const res = await buildApp()
      .get(`/api/contracts/${CONTRACT_ID}/documents`)
      .set('Authorization', `Bearer ${makeToken('AUDITOR')}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('DELETE /api/contracts/:id/documents/:docId', () => {
  it('returns 400 for non-UUID docId', async () => {
    const res = await buildApp()
      .delete(`/api/contracts/${CONTRACT_ID}/documents/not-a-uuid`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(400);
  });

  it('unlinks document and inserts audit log', async () => {
    const res = await buildApp()
      .delete(`/api/contracts/${CONTRACT_ID}/documents/${DOC_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(2); // DELETE + audit log
    expect(mockQueue).toHaveBeenCalledWith('contract', expect.any(String));
  });
});

// ── CI associations ───────────────────────────────────────────────────────────

describe('GET /api/contracts/:id/cis', () => {
  it('returns CI list', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])
      .mockResolvedValueOnce([{ id: CI_ID, name: 'srv01', apiSlug: 'srv01', environment: 'PROD', criticality: 'HIGH' }]);
    const res = await buildApp()
      .get(`/api/contracts/${CONTRACT_ID}/cis`)
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});

describe('POST /api/contracts/:id/cis', () => {
  it('returns 400 for empty ciIds', async () => {
    const res = await buildApp()
      .post(`/api/contracts/${CONTRACT_ID}/cis`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ ciIds: [] });
    expect(res.status).toBe(400);
  });

  it('associates CIs and inserts audit log', async () => {
    mockContractUpdate.mockResolvedValue({ id: CONTRACT_ID });
    const res = await buildApp()
      .post(`/api/contracts/${CONTRACT_ID}/cis`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ ciIds: [CI_ID] });
    expect(res.status).toBe(200);
    expect(res.body.associated).toBe(1);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1); // audit log
    expect(mockQueue).toHaveBeenCalledWith('ci', CI_ID);
  });
});

describe('DELETE /api/contracts/:id/cis/:ciId', () => {
  it('disassociates CI and inserts audit log', async () => {
    mockContractUpdate.mockResolvedValue({ id: CONTRACT_ID });
    const res = await buildApp()
      .delete(`/api/contracts/${CONTRACT_ID}/cis/${CI_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockQueue).toHaveBeenCalledWith('ci', CI_ID);
    expect(mockQueue).toHaveBeenCalledWith('contract', expect.any(String));
  });
});
