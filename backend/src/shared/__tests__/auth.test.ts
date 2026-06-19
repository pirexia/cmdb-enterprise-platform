/**
 * T0 shared foundation — smoke tests.
 * Verifies that authenticateToken, requireAdmin, requireAudit and requireUuidParam
 * behave identically to the original index.ts definitions after extraction.
 * Uses a mocked PrismaClient — no real DB connection needed.
 */

import express, { Request, Response } from 'express';
import supertest from 'supertest';
import jwt from 'jsonwebtoken';

const TEST_SECRET = 'test-secret-32-chars-minimum-len!!';

// ── Mock PrismaClient ────────────────────────────────────────────────────────

const mockQueryRaw = jest.fn();
jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    $queryRaw: mockQueryRaw,
  })),
}));

// ── Patch JWT_SECRET before importing shared middleware ────────────────────

process.env.JWT_SECRET = TEST_SECRET;

import { createAuthenticateToken } from '../middleware/authenticate.js';
import { requireAdmin }           from '../middleware/requireAdmin.js';
import { requireAudit }           from '../middleware/requireAudit.js';
import { requireUuidParam }       from '../middleware/requireUuidParam.js';
import { PrismaClient }           from '@prisma/client';

// ── Helpers ──────────────────────────────────────────────────────────────────

const prisma = new PrismaClient() as any;

function makeToken(
  role: 'ADMIN' | 'AUDITOR' | 'VIEWER',
  extra: Record<string, unknown> = {},
): string {
  return jwt.sign(
    { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', username: 'tester', email: 'tester@test.local', role, ...extra },
    TEST_SECRET,
    { expiresIn: '1h' },
  );
}

function buildApp() {
  const app = express();
  app.use(express.json());
  const authenticateToken = createAuthenticateToken(prisma);

  app.get('/api/protected', authenticateToken, (_req: Request, res: Response) => {
    res.json({ ok: true, role: _req.user?.role });
  });
  app.get('/api/admin-only', authenticateToken, requireAdmin, (_req: Request, res: Response) => {
    res.json({ ok: true });
  });
  app.get('/api/audit-only', authenticateToken, requireAudit, (_req: Request, res: Response) => {
    res.json({ ok: true });
  });
  app.get('/api/items/:id', authenticateToken, requireUuidParam('id'), (_req: Request, res: Response) => {
    res.json({ id: _req.params.id });
  });
  app.get('/api/auth/mfa/setup', authenticateToken, (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  return supertest(app);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('authenticateToken', () => {
  beforeEach(() => {
    mockQueryRaw.mockResolvedValue([{ active: true }]);
  });

  it('returns 401 when no token is provided', async () => {
    const res = await buildApp().get('/api/protected');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Authentication required/);
  });

  it('returns 403 for an invalid token', async () => {
    const res = await buildApp()
      .get('/api/protected')
      .set('Authorization', 'Bearer not-a-valid-jwt');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Invalid or expired token/);
  });

  it('returns 200 for a valid ADMIN token', async () => {
    const res = await buildApp()
      .get('/api/protected')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('ADMIN');
  });

  it('returns 403 for a deactivated user', async () => {
    mockQueryRaw.mockResolvedValue([{ active: false }]);
    const res = await buildApp()
      .get('/api/protected')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/deactivated/);
  });

  it('returns 403 for non-existent user', async () => {
    mockQueryRaw.mockResolvedValue([]);
    const res = await buildApp()
      .get('/api/protected')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(403);
  });

  it('blocks MFA-limited token from non-MFA paths', async () => {
    const token = makeToken('ADMIN', { mfaSetupRequired: true });
    const res = await buildApp()
      .get('/api/protected')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('MFA_SETUP_REQUIRED');
  });

  it('allows MFA-limited token on /api/auth/mfa/setup', async () => {
    const token = makeToken('ADMIN', { mfaSetupRequired: true });
    const res = await buildApp()
      .get('/api/auth/mfa/setup')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

describe('requireAdmin', () => {
  beforeEach(() => {
    mockQueryRaw.mockResolvedValue([{ active: true }]);
  });

  it('allows ADMIN', async () => {
    const res = await buildApp()
      .get('/api/admin-only')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(200);
  });

  it('blocks AUDITOR with 403', async () => {
    const res = await buildApp()
      .get('/api/admin-only')
      .set('Authorization', `Bearer ${makeToken('AUDITOR')}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Admin role required/);
  });

  it('blocks VIEWER with 403', async () => {
    const res = await buildApp()
      .get('/api/admin-only')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);
    expect(res.status).toBe(403);
  });
});

describe('requireAudit', () => {
  beforeEach(() => {
    mockQueryRaw.mockResolvedValue([{ active: true }]);
  });

  it('allows ADMIN', async () => {
    const res = await buildApp()
      .get('/api/audit-only')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(200);
  });

  it('allows AUDITOR', async () => {
    const res = await buildApp()
      .get('/api/audit-only')
      .set('Authorization', `Bearer ${makeToken('AUDITOR')}`);
    expect(res.status).toBe(200);
  });

  it('blocks VIEWER with 403', async () => {
    const res = await buildApp()
      .get('/api/audit-only')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/ADMIN or AUDITOR/);
  });
});

describe('requireUuidParam', () => {
  beforeEach(() => {
    mockQueryRaw.mockResolvedValue([{ active: true }]);
  });

  it('allows a valid UUID', async () => {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const res = await buildApp()
      .get(`/api/items/${id}`)
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
  });

  it('rejects a non-UUID param with 400', async () => {
    const res = await buildApp()
      .get('/api/items/bulk-update')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/expected UUID/);
  });

  it('rejects a plain integer with 400', async () => {
    const res = await buildApp()
      .get('/api/items/12345')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(400);
  });
});
