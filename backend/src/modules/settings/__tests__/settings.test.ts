/**
 * T1 settings module — integration tests (mocked Prisma, no real DB).
 * Covers: happy-path GET/PUT/POST/DELETE, 401/403 RBAC, 400 validation, audit_logs insert.
 */

const mockFindMany   = jest.fn();
const mockUpsert     = jest.fn();
const mockTransaction = jest.fn();
const mockExecuteRaw = jest.fn();
const mockQueryRaw   = jest.fn(); // used by authenticateToken active-user check

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    appSettings: { findMany: mockFindMany, upsert: mockUpsert },
    $transaction: mockTransaction,
    $executeRaw:  mockExecuteRaw,
    $queryRaw:    mockQueryRaw,
  })),
}));

// Ensure JWT_SECRET is set before importing authenticate middleware
process.env.JWT_SECRET = 'test-secret-32-chars-minimum-len!!';

import express        from 'express';
import supertest      from 'supertest';
import jwt            from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { createSettingsRouter } from '../router.js';

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
  app.use('/api/settings', createSettingsRouter(prisma));
  return supertest(app);
}

// Minimal PNG magic bytes (89 50 4E 47 + padding to 12 bytes)
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

beforeEach(() => {
  jest.clearAllMocks();
  // authenticateToken active-user check — user is active by default
  mockQueryRaw.mockResolvedValue([{ active: true }]);
  // Default mocks — override per test where needed
  mockFindMany.mockResolvedValue([]);
  mockUpsert.mockResolvedValue({});
  mockTransaction.mockResolvedValue([]);
  mockExecuteRaw.mockResolvedValue(1);
});

// ── GET /api/settings/theme ───────────────────────────────────────────────────

describe('GET /api/settings/theme', () => {
  it('returns defaults when no settings stored (no auth required)', async () => {
    mockFindMany.mockResolvedValue([]);
    const res = await buildApp().get('/api/settings/theme');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      sidebarBg: '#0f172a',
      accentColor: '#3b82f6',
      companyName: 'CMDB Platform',
      hasLogo: false,
    });
  });

  it('returns stored values', async () => {
    mockFindMany.mockResolvedValue([
      { key: 'sidebar_bg', value: '#1e293b' },
      { key: 'company_name', value: 'Acme Corp' },
    ]);
    const res = await buildApp().get('/api/settings/theme');
    expect(res.status).toBe(200);
    expect(res.body.sidebarBg).toBe('#1e293b');
    expect(res.body.companyName).toBe('Acme Corp');
  });

  it('sets hasLogo=true when logo_data is present', async () => {
    mockFindMany.mockResolvedValue([{ key: 'logo_data', value: 'abc123' }]);
    const res = await buildApp().get('/api/settings/theme');
    expect(res.body.hasLogo).toBe(true);
  });
});

// ── GET /api/settings/logo ────────────────────────────────────────────────────

describe('GET /api/settings/logo', () => {
  it('returns 404 when no logo is configured (no auth required)', async () => {
    mockFindMany.mockResolvedValue([]);
    const res = await buildApp().get('/api/settings/logo');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/No logo/);
  });

  it('returns binary image with correct Content-Type when logo exists', async () => {
    const b64 = PNG_BYTES.toString('base64');
    mockFindMany.mockResolvedValue([
      { key: 'logo_data', value: b64 },
      { key: 'logo_mime', value: 'image/png' },
    ]);
    const res = await buildApp().get('/api/settings/logo');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
  });
});

// ── PUT /api/settings/theme ───────────────────────────────────────────────────

describe('PUT /api/settings/theme', () => {
  it('returns 401 without token', async () => {
    const res = await buildApp().put('/api/settings/theme').send({ sidebarBg: '#123456' });
    expect(res.status).toBe(401);
  });

  it('returns 403 for AUDITOR', async () => {
    const res = await buildApp()
      .put('/api/settings/theme')
      .set('Authorization', `Bearer ${makeToken('AUDITOR')}`)
      .send({ sidebarBg: '#123456' });
    expect(res.status).toBe(403);
  });

  it('returns 400 for invalid hex color', async () => {
    const res = await buildApp()
      .put('/api/settings/theme')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ sidebarBg: 'notacolor' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when no fields provided', async () => {
    const res = await buildApp()
      .put('/api/settings/theme')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No fields to update/);
  });

  it('updates theme and inserts audit log for ADMIN', async () => {
    const res = await buildApp()
      .put('/api/settings/theme')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .send({ sidebarBg: '#1e293b', accentColor: '#6366f1' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockUpsert).toHaveBeenCalledTimes(2);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1); // audit log
  });

  it('allows VIEWER role — theme is public write... wait, requireAdmin blocks VIEWER', async () => {
    const res = await buildApp()
      .put('/api/settings/theme')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`)
      .send({ sidebarBg: '#123456' });
    expect(res.status).toBe(403);
  });
});

// ── POST /api/settings/logo ───────────────────────────────────────────────────

describe('POST /api/settings/logo', () => {
  it('returns 401 without token', async () => {
    const res = await buildApp()
      .post('/api/settings/logo')
      .attach('logo', PNG_BYTES, { filename: 'logo.png', contentType: 'image/png' });
    expect(res.status).toBe(401);
  });

  it('returns 403 for AUDITOR', async () => {
    const res = await buildApp()
      .post('/api/settings/logo')
      .set('Authorization', `Bearer ${makeToken('AUDITOR')}`)
      .attach('logo', PNG_BYTES, { filename: 'logo.png', contentType: 'image/png' });
    expect(res.status).toBe(403);
  });

  it('returns 400 for wrong MIME type', async () => {
    const res = await buildApp()
      .post('/api/settings/logo')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .attach('logo', Buffer.from('not-an-image'), { filename: 'file.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when invalid magic bytes despite correct MIME', async () => {
    const badBuf = Buffer.alloc(12, 0x00); // all zeros — no magic bytes
    const res = await buildApp()
      .post('/api/settings/logo')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .attach('logo', badBuf, { filename: 'fake.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/imagen válida/);
  });

  it('stores logo and inserts audit log for valid PNG', async () => {
    mockTransaction.mockResolvedValue([{}, {}]);
    const res = await buildApp()
      .post('/api/settings/logo')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`)
      .attach('logo', PNG_BYTES, { filename: 'logo.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1); // audit log
  });
});

// ── DELETE /api/settings/logo ─────────────────────────────────────────────────

describe('DELETE /api/settings/logo', () => {
  it('returns 401 without token', async () => {
    const res = await buildApp().delete('/api/settings/logo');
    expect(res.status).toBe(401);
  });

  it('returns 403 for VIEWER', async () => {
    const res = await buildApp()
      .delete('/api/settings/logo')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);
    expect(res.status).toBe(403);
  });

  it('clears logo and inserts audit log for ADMIN', async () => {
    mockTransaction.mockResolvedValue([{}, {}]);
    const res = await buildApp()
      .delete('/api/settings/logo')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1); // audit log
  });
});
