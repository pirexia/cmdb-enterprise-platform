/**
 * T2 vendors module — integration tests (mocked Prisma, no real DB).
 * Covers: happy-path CRUD, 401/403 RBAC, 400 validation, 404, 409 FK conflict, audit log insert.
 */

const mockFindMany   = jest.fn();
const mockQueryRaw   = jest.fn();
const mockExecuteRaw = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    vendor:      { findMany: mockFindMany },
    $queryRaw:   mockQueryRaw,
    $executeRaw: mockExecuteRaw,
  })),
}));

process.env.JWT_SECRET = 'test-secret-32-chars-minimum-len!!';

import express        from 'express';
import supertest      from 'supertest';
import jwt            from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { createVendorsRouter } from '../router.js';

const TEST_SECRET = 'test-secret-32-chars-minimum-len!!';
const prisma = new PrismaClient() as any;

function makeToken(role: 'ADMIN' | 'AUDITOR' | 'VIEWER'): string {
  return jwt.sign(
    { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', username: 'tester', email: `${role.toLowerCase()}@test.local`, role },
    TEST_SECRET,
    { expiresIn: '1h' },
  );
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/vendors', createVendorsRouter(prisma));
  return supertest(app);
}

const VENDOR_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

beforeEach(() => {
  jest.clearAllMocks();
  // authenticateToken active-user check
  mockQueryRaw.mockResolvedValue([{ active: true }]);
  mockFindMany.mockResolvedValue([]);
  mockExecuteRaw.mockResolvedValue(1);
});

// ── GET /api/vendors ──────────────────────────────────────────────────────────

describe('GET /api/vendors', () => {
  it('returns 401 without token', async () => {
    const res = await buildApp().get('/api/vendors');
    expect(res.status).toBe(401);
  });

  it('returns empty array when no vendors', async () => {
    mockFindMany.mockResolvedValue([]);
    const res = await buildApp()
      .get('/api/vendors')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns vendors sorted by name for AUDITOR', async () => {
    mockFindMany.mockResolvedValue([
      { id: '1', name: 'Acme' },
      { id: '2', name: 'Zeta Corp' },
    ]);
    const res = await buildApp()
      .get('/api/vendors')
      .set('Authorization', `Bearer ${makeToken('AUDITOR')}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].name).toBe('Acme');
  });
});

// ── POST /api/vendors ─────────────────────────────────────────────────────────

describe('POST /api/vendors', () => {
  it('returns 401 without token', async () => {
    const res = await buildApp().post('/api/vendors').send({ name: 'Acme' });
    expect(res.status).toBe(401);
  });

  it('returns 403 for AUDITOR', async () => {
    const res = await buildApp()
      .post('/api/vendors')
      .set('Authorization', `Bearer ${makeToken('AUDITOR')}`)
      .send({ name: 'Acme' });
    expect(res.status).toBe(403);
  });

  it('returns 400 when name is missing', async () => {
    const res = await buildApp()
      .post('/api/vendors')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('name required');
  });

  it('returns 400 when name is blank', async () => {
    const res = await buildApp()
      .post('/api/vendors')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ name: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('name required');
  });

  it('creates vendor and inserts audit log for ADMIN', async () => {
    // First mockQueryRaw call → active-user check (returns [{active:true}])
    // Second call → INSERT vendor RETURNING
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])
      .mockResolvedValueOnce([{ id: VENDOR_ID, name: 'Acme' }]);

    const res = await buildApp()
      .post('/api/vendors')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ name: 'Acme' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: VENDOR_ID, name: 'Acme' });
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1); // audit log
  });
});

// ── PATCH /api/vendors/:id ────────────────────────────────────────────────────

describe('PATCH /api/vendors/:id', () => {
  it('returns 401 without token', async () => {
    const res = await buildApp().patch(`/api/vendors/${VENDOR_ID}`).send({ name: 'New' });
    expect(res.status).toBe(401);
  });

  it('returns 403 for VIEWER', async () => {
    const res = await buildApp()
      .patch(`/api/vendors/${VENDOR_ID}`)
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`)
      .send({ name: 'New' });
    expect(res.status).toBe(403);
  });

  it('returns 400 for missing name', async () => {
    const res = await buildApp()
      .patch(`/api/vendors/${VENDOR_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('name required');
  });

  it('returns 404 when vendor not found', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])
      .mockResolvedValueOnce([]); // UPDATE RETURNING empty
    const res = await buildApp()
      .patch(`/api/vendors/${VENDOR_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ name: 'New' });
    expect(res.status).toBe(404);
  });

  it('updates vendor and inserts audit log', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }])
      .mockResolvedValueOnce([{ id: VENDOR_ID, name: 'New Name' }]);
    const res = await buildApp()
      .patch(`/api/vendors/${VENDOR_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ name: 'New Name' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New Name');
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1); // audit log
  });
});

// ── DELETE /api/vendors/:id ───────────────────────────────────────────────────

describe('DELETE /api/vendors/:id', () => {
  it('returns 401 without token', async () => {
    const res = await buildApp().delete(`/api/vendors/${VENDOR_ID}`);
    expect(res.status).toBe(401);
  });

  it('returns 403 for AUDITOR', async () => {
    const res = await buildApp()
      .delete(`/api/vendors/${VENDOR_ID}`)
      .set('Authorization', `Bearer ${makeToken('AUDITOR')}`);
    expect(res.status).toBe(403);
  });

  it('deletes vendor and inserts audit log for ADMIN', async () => {
    mockExecuteRaw.mockResolvedValue(1);
    const res = await buildApp()
      .delete(`/api/vendors/${VENDOR_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(2); // audit log + DELETE
  });

  it('returns 409 on FK constraint violation (P2003)', async () => {
    mockExecuteRaw
      .mockResolvedValueOnce(1)        // audit log succeeds
      .mockRejectedValueOnce(Object.assign(new Error('FK'), { code: 'P2003' }));
    const res = await buildApp()
      .delete(`/api/vendors/${VENDOR_ID}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Cannot delete vendor/);
  });
});
