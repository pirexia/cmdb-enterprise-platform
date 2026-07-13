/**
 * T6 masters module — integration tests (mocked Prisma, no real DB).
 * Covers: 401/403 RBAC, CRUD happy-paths + validation, audit log inserts,
 * in-use 409 guards (device-models, ci-types, license-metrics, license-types),
 * sync-catalog actions, device-models/:id/sync-eol.
 */

const mockQueryRaw    = jest.fn();
const mockExecuteRaw  = jest.fn();
const mockTransaction = jest.fn();

// CI Type models
const mockCITypeCategoryFindMany = jest.fn();
const mockCITypeFindMany         = jest.fn();
const mockCITypeCreate           = jest.fn();
const mockCITypeFindUnique       = jest.fn();
const mockCITypeUpdate           = jest.fn();
const mockCITypeDelete           = jest.fn();
const mockCICount                = jest.fn();

// Hypervisor model
const mockHypervisorFindMany   = jest.fn();
const mockHypervisorCreate     = jest.fn();
const mockHypervisorFindUnique = jest.fn();
const mockHypervisorUpdate     = jest.fn();
const mockHypervisorDelete     = jest.fn();

// EOL service
const mockLookupEolWithFallbacks = jest.fn();
const mockFetchProductCycles     = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    $queryRaw:    mockQueryRaw,
    $executeRaw:  mockExecuteRaw,
    $transaction: mockTransaction,
    cITypeCategory: { findMany: mockCITypeCategoryFindMany },
    cIType: {
      findMany:   mockCITypeFindMany,
      create:     mockCITypeCreate,
      findUnique: mockCITypeFindUnique,
      update:     mockCITypeUpdate,
      delete:     mockCITypeDelete,
    },
    cI: { count: mockCICount },
    hypervisor: {
      findMany:   mockHypervisorFindMany,
      create:     mockHypervisorCreate,
      findUnique: mockHypervisorFindUnique,
      update:     mockHypervisorUpdate,
      delete:     mockHypervisorDelete,
    },
  })),
}));

jest.mock('../../../services/eolService', () => ({
  lookupEolWithFallbacks: mockLookupEolWithFallbacks,
  fetchProductCycles:     mockFetchProductCycles,
}));

process.env.JWT_SECRET = 'test-secret-32-chars-minimum-len!!';

import express        from 'express';
import supertest      from 'supertest';
import jwt            from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { createMastersRouter } from '../router.js';

const TEST_SECRET = 'test-secret-32-chars-minimum-len!!';
const prisma      = new PrismaClient() as any;

const SA_ID    = 'aaaaaaaa-1111-2222-3333-444444444444';
const MFG_ID   = 'bbbbbbbb-1111-2222-3333-444444444444';
const MODEL_ID = 'cccccccc-1111-2222-3333-444444444444';
const CITYPE_ID= 'dddddddd-1111-2222-3333-444444444444';
const METRIC_ID= 'eeeeeeee-1111-2222-3333-444444444444';
const TYPE_ID  = 'ffffffff-1111-2222-3333-444444444444';
const USER_ID  = '11111111-2222-3333-4444-555555555555';
const HYPER_ID = '99999999-1111-2222-3333-444444444444';
const VMWARE_ID= '88888888-1111-2222-3333-444444444444';

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
  app.use('/api/masters', createMastersRouter(prisma));
  return supertest(app);
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: auth check passes (active user)
  mockQueryRaw.mockResolvedValue([{ active: true }]);
  mockExecuteRaw.mockResolvedValue(1);
  mockTransaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma));
  mockLookupEolWithFallbacks.mockResolvedValue(null);
  mockFetchProductCycles.mockResolvedValue(null);
});

// ── RBAC guards ───────────────────────────────────────────────────────────────

describe('RBAC', () => {
  it('returns 401 without token on read endpoint', async () => {
    const res = await buildApp().get('/api/masters/support-areas');
    expect(res.status).toBe(401);
  });

  it('returns 403 for VIEWER on write endpoint', async () => {
    const res = await buildApp()
      .post('/api/masters/support-areas')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`)
      .send({ name: 'Test' });
    expect(res.status).toBe(403);
  });

  it('returns 403 for AUDITOR on POST manufacturers/all delete', async () => {
    const res = await buildApp()
      .delete('/api/masters/manufacturers/all')
      .set('Authorization', `Bearer ${makeToken('AUDITOR')}`);
    expect(res.status).toBe(403);
  });
});

// ── Support Areas ─────────────────────────────────────────────────────────────

describe('GET /api/masters/support-areas', () => {
  it('returns list for VIEWER', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])
      .mockResolvedValueOnce([{ id: SA_ID, name: 'IT Support' }]);
    const res = await buildApp()
      .get('/api/masters/support-areas')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);
    expect(res.status).toBe(200);
    expect(res.body[0].name).toBe('IT Support');
  });
});

describe('POST /api/masters/support-areas', () => {
  it('returns 400 when name is missing', async () => {
    const res = await buildApp()
      .post('/api/masters/support-areas')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('creates support area and inserts audit log', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])
      .mockResolvedValueOnce([{ id: SA_ID, name: 'IT Support' }]);
    const res = await buildApp()
      .post('/api/masters/support-areas')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ name: 'IT Support' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('IT Support');
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1); // audit log
  });
});

describe('DELETE /api/masters/support-areas/:id', () => {
  it('deletes and returns ok', async () => {
    const res = await buildApp()
      .delete(`/api/masters/support-areas/${SA_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(2); // audit + delete
  });
});

// ── Manufacturers ─────────────────────────────────────────────────────────────

describe('GET /api/masters/manufacturers', () => {
  it('returns list', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])
      .mockResolvedValueOnce([{ id: MFG_ID, name: 'Dell' }]);
    const res = await buildApp()
      .get('/api/masters/manufacturers')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);
    expect(res.status).toBe(200);
    expect(res.body[0].name).toBe('Dell');
  });
});

describe('POST /api/masters/manufacturers', () => {
  it('creates manufacturer and inserts audit log', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])
      .mockResolvedValueOnce([{ id: MFG_ID, name: 'Dell' }]);
    const res = await buildApp()
      .post('/api/masters/manufacturers')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ name: 'Dell' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Dell');
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
  });
});

describe('DELETE /api/masters/manufacturers/all', () => {
  it('bulk deletes all and runs in transaction', async () => {
    const res = await buildApp()
      .delete('/api/masters/manufacturers/all')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBeDefined();
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });
});

// ── Branches ──────────────────────────────────────────────────────────────────

describe('GET /api/masters/branches', () => {
  it('returns list with support area name', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])
      .mockResolvedValueOnce([{ id: SA_ID, name: 'Madrid', branch_code: 'MAD', physical_address: null, support_area_id: SA_ID, support_area_name: 'IT' }]);
    const res = await buildApp()
      .get('/api/masters/branches')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);
    expect(res.status).toBe(200);
    expect(res.body[0].branch_code).toBe('MAD');
  });
});

describe('POST /api/masters/branches', () => {
  it('returns 400 when supportAreaId is missing', async () => {
    const res = await buildApp()
      .post('/api/masters/branches')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ name: 'Madrid', branchCode: 'MAD' });
    expect(res.status).toBe(400);
  });

  it('creates branch and inserts audit log', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])
      .mockResolvedValueOnce([{ id: SA_ID, name: 'Madrid' }]);
    const res = await buildApp()
      .post('/api/masters/branches')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ name: 'Madrid', branchCode: 'MAD', supportAreaId: SA_ID });
    expect(res.status).toBe(201);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
  });
});

// ── Device Models ─────────────────────────────────────────────────────────────

describe('GET /api/masters/device-models', () => {
  it('returns list with eolDate/eosDate', async () => {
    const eolDate = new Date('2025-01-01T00:00:00Z');
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])
      .mockResolvedValueOnce([{ id: MODEL_ID, name: 'PowerEdge R740', manufacturer_id: MFG_ID, manufacturer_name: 'Dell', eol_date: eolDate, eos_date: null }]);
    const res = await buildApp()
      .get('/api/masters/device-models')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);
    expect(res.status).toBe(200);
    expect(res.body[0].eolDate).toBe('2025-01-01');
    expect(res.body[0].eosDate).toBeNull();
  });
});

describe('POST /api/masters/device-models', () => {
  it('returns 400 when manufacturerId is missing', async () => {
    const res = await buildApp()
      .post('/api/masters/device-models')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ name: 'PowerEdge R740' });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/masters/device-models/:id', () => {
  it('returns 409 when model is in use by CIs', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])
      .mockResolvedValueOnce([{ count: 3 }]); // 3 CIs in use
    const res = await buildApp()
      .delete(`/api/masters/device-models/${MODEL_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/in use/);
  });

  it('deletes when not in use', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])
      .mockResolvedValueOnce([{ count: 0 }]);
    const res = await buildApp()
      .delete(`/api/masters/device-models/${MODEL_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('POST /api/masters/device-models/:id/sync-eol', () => {
  it('returns 404 when model not found', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])
      .mockResolvedValueOnce([]); // model not found
    const res = await buildApp()
      .post(`/api/masters/device-models/${MODEL_ID}/sync-eol`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(404);
  });

  it('returns no-data message when EOL service finds nothing', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])
      .mockResolvedValueOnce([{ id: MODEL_ID, name: 'PowerEdge R740', manufacturer_name: 'Dell' }]);
    mockLookupEolWithFallbacks.mockResolvedValue(null);
    const res = await buildApp()
      .post(`/api/masters/device-models/${MODEL_ID}/sync-eol`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(0);
    expect(res.body.message).toMatch(/No EOL data/);
  });

  it('updates device model and CIs when EOL data found', async () => {
    const eolDate = new Date('2026-01-01');
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])
      .mockResolvedValueOnce([{ id: MODEL_ID, name: 'PowerEdge R740', manufacturer_name: 'Dell' }]);
    mockLookupEolWithFallbacks.mockResolvedValue({ eolDate, supportDate: null });
    mockExecuteRaw
      .mockResolvedValueOnce(1)  // UPDATE device_models
      .mockResolvedValueOnce(1)  // INSERT audit_logs
      .mockResolvedValueOnce(2); // UPDATE configuration_items
    const res = await buildApp()
      .post(`/api/masters/device-models/${MODEL_ID}/sync-eol`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(3);
  });
});

// ── CI Type Categories + CI Types ─────────────────────────────────────────────

describe('GET /api/masters/ci-type-categories', () => {
  it('returns categories with nested ci-types', async () => {
    mockCITypeCategoryFindMany.mockResolvedValue([{ id: '1', code: 'HW', name: 'Hardware', sortOrder: 1, ciTypes: [] }]);
    const res = await buildApp()
      .get('/api/masters/ci-type-categories')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);
    expect(res.status).toBe(200);
    expect(res.body[0].code).toBe('HW');
  });
});

describe('POST /api/masters/ci-types', () => {
  it('returns 400 when categoryCode missing', async () => {
    const res = await buildApp()
      .post('/api/masters/ci-types')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ name: 'Server' });
    expect(res.status).toBe(400);
  });

  it('creates ci-type (code provided) and inserts audit log', async () => {
    const created = { id: CITYPE_ID, code: 'SRV', name: 'Server', categoryCode: 'HW', sortOrder: 50, isSystem: false };
    mockCITypeCreate.mockResolvedValue(created);
    const res = await buildApp()
      .post('/api/masters/ci-types')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ code: 'SRV', name: 'Server', categoryCode: 'HW' });
    expect(res.status).toBe(201);
    expect(res.body.code).toBe('SRV');
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
  });

  it('auto-generates code when not provided', async () => {
    const created = { id: CITYPE_ID, code: 'SERVER', name: 'Server', categoryCode: 'HW', sortOrder: 50, isSystem: false };
    mockCITypeFindMany.mockResolvedValue([]);
    mockCITypeCreate.mockResolvedValue(created);
    const res = await buildApp()
      .post('/api/masters/ci-types')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ name: 'Server', categoryCode: 'HW' });
    expect(res.status).toBe(201);
    expect(res.body.code).toBe('SERVER');
  });
});

describe('DELETE /api/masters/ci-types/:id', () => {
  it('returns 404 when ci-type not found', async () => {
    mockCITypeFindUnique.mockResolvedValue(null);
    const res = await buildApp()
      .delete(`/api/masters/ci-types/${CITYPE_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(404);
  });

  it('returns 409 when CIs reference this type', async () => {
    mockCITypeFindUnique.mockResolvedValue({ code: 'SRV' });
    mockCICount.mockResolvedValue(5);
    const res = await buildApp()
      .delete(`/api/masters/ci-types/${CITYPE_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/5/);
  });

  it('deletes when no CIs reference type', async () => {
    mockCITypeFindUnique.mockResolvedValue({ code: 'SRV' });
    mockCICount.mockResolvedValue(0);
    mockCITypeDelete.mockResolvedValue({ id: CITYPE_ID });
    const res = await buildApp()
      .delete(`/api/masters/ci-types/${CITYPE_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1); // audit log
  });
});

// ── Hypervisors ───────────────────────────────────────────────────────────────

describe('GET /api/masters/hypervisors', () => {
  it('returns list including seeded VMWARE row', async () => {
    mockHypervisorFindMany.mockResolvedValue([
      { id: VMWARE_ID, code: 'VMWARE', name: 'VMware vSphere / vCenter', isSystem: true },
    ]);
    const res = await buildApp()
      .get('/api/masters/hypervisors')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);
    expect(res.status).toBe(200);
    expect(res.body[0].code).toBe('VMWARE');
    expect(res.body[0].isSystem).toBe(true);
  });
});

describe('POST /api/masters/hypervisors', () => {
  it('returns 400 when name is missing', async () => {
    const res = await buildApp()
      .post('/api/masters/hypervisors')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 403 for VIEWER', async () => {
    const res = await buildApp()
      .post('/api/masters/hypervisors')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`)
      .send({ name: 'Proxmox VE' });
    expect(res.status).toBe(403);
  });

  it('returns 401 without token', async () => {
    const res = await buildApp()
      .post('/api/masters/hypervisors')
      .send({ name: 'Proxmox VE' });
    expect(res.status).toBe(401);
  });

  it('creates a non-system hypervisor with a derived code and inserts audit log', async () => {
    mockHypervisorFindMany.mockResolvedValue([]);
    mockHypervisorCreate.mockResolvedValue({ id: HYPER_ID, code: 'PROXMOX_VE', name: 'Proxmox VE', isSystem: false });
    const res = await buildApp()
      .post('/api/masters/hypervisors')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ name: 'Proxmox VE' });
    expect(res.status).toBe(201);
    expect(res.body.code).toBe('PROXMOX_VE');
    expect(res.body.isSystem).toBe(false);
    expect(mockHypervisorCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ isSystem: false }),
    }));
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
  });
});

describe('PATCH /api/masters/hypervisors/:id', () => {
  it('updates a non-system hypervisor', async () => {
    mockHypervisorFindUnique.mockResolvedValue({ isSystem: false });
    mockHypervisorUpdate.mockResolvedValue({ id: HYPER_ID, code: 'PROXMOX_VE', name: 'Proxmox VE Updated', isSystem: false });
    const res = await buildApp()
      .patch(`/api/masters/hypervisors/${HYPER_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ name: 'Proxmox VE Updated' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Proxmox VE Updated');
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
  });

  it('returns 409 when hypervisor is isSystem (VMWARE seed row)', async () => {
    mockHypervisorFindUnique.mockResolvedValue({ isSystem: true });
    const res = await buildApp()
      .patch(`/api/masters/hypervisors/${VMWARE_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ name: 'Hacked name' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/gestionado por el sistema/);
    expect(mockHypervisorUpdate).not.toHaveBeenCalled();
  });

  it('returns 404 when hypervisor not found', async () => {
    mockHypervisorFindUnique.mockResolvedValue(null);
    const res = await buildApp()
      .patch(`/api/masters/hypervisors/${HYPER_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ name: 'X' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/masters/hypervisors/:id', () => {
  it('deletes a non-system, unused hypervisor', async () => {
    mockHypervisorFindUnique.mockResolvedValue({ isSystem: false });
    mockCICount.mockResolvedValue(0);
    mockHypervisorDelete.mockResolvedValue({ id: HYPER_ID });
    const res = await buildApp()
      .delete(`/api/masters/hypervisors/${HYPER_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1); // audit log
  });

  it('returns 409 when hypervisor is isSystem (VMWARE seed row)', async () => {
    mockHypervisorFindUnique.mockResolvedValue({ isSystem: true });
    const res = await buildApp()
      .delete(`/api/masters/hypervisors/${VMWARE_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/gestionado por el sistema/);
    expect(mockHypervisorDelete).not.toHaveBeenCalled();
  });

  it('returns 409 when CIs are assigned to this hypervisor', async () => {
    mockHypervisorFindUnique.mockResolvedValue({ isSystem: false });
    mockCICount.mockResolvedValue(4);
    const res = await buildApp()
      .delete(`/api/masters/hypervisors/${HYPER_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/4 CIs/);
    expect(mockHypervisorDelete).not.toHaveBeenCalled();
  });

  it('returns 404 when hypervisor not found', async () => {
    mockHypervisorFindUnique.mockResolvedValue(null);
    const res = await buildApp()
      .delete(`/api/masters/hypervisors/${HYPER_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(404);
  });
});

// ── Document Types ────────────────────────────────────────────────────────────

describe('GET /api/masters/document-types', () => {
  it('returns list', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])
      .mockResolvedValueOnce([{ id: SA_ID, code: 'CONTRACT', name: 'Contract', isSystem: true }]);
    const res = await buildApp()
      .get('/api/masters/document-types')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);
    expect(res.status).toBe(200);
    expect(res.body[0].code).toBe('CONTRACT');
  });
});

describe('DELETE /api/masters/document-types/:id', () => {
  it('returns 404 for system type (affected rows = 0)', async () => {
    mockExecuteRaw.mockResolvedValueOnce(0); // DELETE WHERE is_system=false → 0 rows
    const res = await buildApp()
      .delete(`/api/masters/document-types/${SA_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(404);
  });
});

// ── Cost Centers ──────────────────────────────────────────────────────────────

describe('POST /api/masters/cost-centers', () => {
  it('returns 409 on duplicate code', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])
      .mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
    const res = await buildApp()
      .post('/api/masters/cost-centers')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ code: 'IT-001', name: 'IT' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/código/);
  });
});

// ── License Metrics ───────────────────────────────────────────────────────────

describe('GET /api/masters/license-metrics', () => {
  it('returns flat list', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])
      .mockResolvedValueOnce([{ id: METRIC_ID, code: 'USER', name: 'Per User', categoryCode: 'NAMED', description: null, isSystem: true }]);
    const res = await buildApp()
      .get('/api/masters/license-metrics')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);
    expect(res.status).toBe(200);
    expect(res.body[0].code).toBe('USER');
  });
});

describe('DELETE /api/masters/license-metrics/:id', () => {
  it('returns 409 when licenses reference this metric', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])
      .mockResolvedValueOnce([{ count: BigInt(2) }]); // 2 licenses in use
    const res = await buildApp()
      .delete(`/api/masters/license-metrics/${METRIC_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/métrica/);
  });

  it('deletes when not referenced', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])
      .mockResolvedValueOnce([{ count: BigInt(0) }]);
    mockExecuteRaw
      .mockResolvedValueOnce(1)  // DELETE
      .mockResolvedValueOnce(1); // audit
    const res = await buildApp()
      .delete(`/api/masters/license-metrics/${METRIC_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ── License Types ─────────────────────────────────────────────────────────────

describe('POST /api/masters/license-types', () => {
  it('creates license type and inserts audit log', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])
      .mockResolvedValueOnce([{ id: TYPE_ID, code: 'PERPETUAL', name: 'Perpetual' }]);
    const res = await buildApp()
      .post('/api/masters/license-types')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ code: 'PERPETUAL', name: 'Perpetual', categoryCode: 'STANDARD' });
    expect(res.status).toBe(201);
    expect(res.body.code).toBe('PERPETUAL');
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
  });
});

describe('DELETE /api/masters/license-types/:id', () => {
  it('returns 409 when licenses reference this type', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])
      .mockResolvedValueOnce([{ count: BigInt(1) }]);
    const res = await buildApp()
      .delete(`/api/masters/license-types/${TYPE_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/tipo/);
  });
});

// ── Sync Catalog ──────────────────────────────────────────────────────────────

describe('POST /api/masters/sync-catalog', () => {
  it('returns 400 for unknown action', async () => {
    const res = await buildApp()
      .post('/api/masters/sync-catalog')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ action: 'unknown' });
    expect(res.status).toBe(400);
  });

  it('sync-manufacturers: inserts popular manufacturers and returns counts', async () => {
    mockExecuteRaw.mockResolvedValue(1); // each ON CONFLICT returns 1
    const res = await buildApp()
      .post('/api/masters/sync-catalog')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ action: 'sync-manufacturers' });
    expect(res.status).toBe(200);
    expect(res.body.created).toBeGreaterThan(0);
    expect(typeof res.body.skipped).toBe('number');
  });

  it('search: returns found=false when EOL service returns null', async () => {
    mockFetchProductCycles.mockResolvedValue(null);
    const res = await buildApp()
      .post('/api/masters/sync-catalog')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ action: 'search', query: 'windows-server' });
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(false);
  });

  it('search: returns cycles when found', async () => {
    mockFetchProductCycles.mockResolvedValue([{ cycle: '2022', eol: '2026-01-12' }]);
    const res = await buildApp()
      .post('/api/masters/sync-catalog')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ action: 'search', query: 'windows-server' });
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.cycles).toHaveLength(1);
  });

  it('search: returns 400 when query is empty', async () => {
    const res = await buildApp()
      .post('/api/masters/sync-catalog')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ action: 'search', query: '' });
    expect(res.status).toBe(400);
  });
});
