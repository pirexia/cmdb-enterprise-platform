/**
 * Plugin API integration tests (lightweight — no real DB or server).
 * Uses a mini Express app that mounts only the plugin router with a mocked Prisma client.
 */

// Mock the audit module before any imports that use it
jest.mock('../audit.js', () => ({
  pluginAudit: jest.fn().mockResolvedValue(undefined),
}));

// Mock the queries module
jest.mock('../queries.js', () => ({
  createBackupRecord: jest.fn().mockResolvedValue(undefined),
}));

// Mock the middleware to avoid filesystem / rate-limiter side effects
jest.mock('../middleware.js', () => {
  const rateLimit = jest.fn(() => (_req: any, _res: any, next: any) => next());
  return {
    pluginRateLimiter: (_req: any, _res: any, next: any) => next(),
    requirePluginExists: (prisma: any) => async (req: any, res: any, next: any) => {
      const { id } = req.params;
      const plugin = await prisma.pluginRegistry.findUnique({ where: { id } });
      if (!plugin) {
        res.status(404).json({ error: 'Plugin not found' });
        return;
      }
      req.plugin = plugin;
      next();
    },
    validateUploadedFile: (_req: any, _res: any, next: any) => next(),
  };
});

import express from 'express';
import supertest from 'supertest';
import jwt from 'jsonwebtoken';
import { createPluginRouter } from '../router.js';

const TEST_JWT_SECRET = 'test-secret-32-chars-minimum-len!!';

// Build a JWT for the given role
function makeToken(role: 'ADMIN' | 'AUDITOR' | 'VIEWER'): string {
  return jwt.sign(
    { id: 'user-uuid-1', email: `${role.toLowerCase()}@test.local`, role },
    TEST_JWT_SECRET,
    { expiresIn: '1h' },
  );
}

// Middleware that decodes JWT and sets req.user (replaces authenticateToken)
function fakeAuth(req: any, _res: any, next: any): void {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    req.user = null;
    next();
    return;
  }
  const token = authHeader.replace('Bearer ', '');
  try {
    req.user = jwt.verify(token, TEST_JWT_SECRET);
  } catch {
    req.user = null;
  }
  next();
}

// Middleware that rejects unauthenticated requests
function requireAuth(req: any, res: any, next: any): void {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// Build a minimal Prisma mock
function makePrismaMock(overrides: Record<string, any> = {}) {
  return {
    pluginRegistry: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
}

// Build the test app
function buildApp(prisma: any) {
  const app = express();
  app.use(express.json());
  app.use(fakeAuth);
  app.use(requireAuth);
  app.use('/api/plugins', createPluginRouter(prisma as any));
  return app;
}

describe('Plugin API endpoints', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    prisma = makePrismaMock();
    app = buildApp(prisma);
    // Suppress console output during tests
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('GET /api/plugins requires authentication — 401 without token', async () => {
    // Build an app without fakeAuth injecting a user
    const bareApp = express();
    bareApp.use(express.json());
    // No auth middleware — so requireAuth should reject
    bareApp.use(requireAuth);
    bareApp.use('/api/plugins', createPluginRouter(prisma as any));

    const res = await supertest(bareApp).get('/api/plugins');
    expect(res.status).toBe(401);
  });

  it('GET /api/plugins requires ADMIN — 403 with AUDITOR token', async () => {
    const token = makeToken('AUDITOR');
    const res = await supertest(app)
      .get('/api/plugins')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty('error', 'Forbidden');
  });

  it('POST /api/plugins/upload requires ADMIN — 403 with AUDITOR token', async () => {
    const token = makeToken('AUDITOR');
    const res = await supertest(app)
      .post('/api/plugins/upload')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty('error', 'Forbidden');
  });

  it('GET /api/plugins returns empty array when no plugins', async () => {
    const token = makeToken('ADMIN');
    prisma.pluginRegistry.findMany.mockResolvedValue([]);

    const res = await supertest(app)
      .get('/api/plugins')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('plugins');
    expect(Array.isArray(res.body.plugins)).toBe(true);
    expect(res.body.plugins).toHaveLength(0);
  });

  it('POST /api/plugins/:id/validate with invalid UUID returns 400', async () => {
    const token = makeToken('ADMIN');
    const res = await supertest(app)
      .post('/api/plugins/not-a-uuid/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid.*uuid/i);
  });

  it('POST /api/plugins/:id/validate with non-existent plugin returns 404', async () => {
    const token = makeToken('ADMIN');
    prisma.pluginRegistry.findUnique.mockResolvedValue(null);

    const res = await supertest(app)
      .post('/api/plugins/00000000-0000-0000-0000-000000000001/validate')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error', 'Plugin not found');
  });

  it('GET /api/plugins returns plugin list for ADMIN', async () => {
    const token = makeToken('ADMIN');
    const fakePlugins = [
      {
        id: '00000000-0000-0000-0000-000000000001',
        pluginId: 'test-plugin',
        name: 'Test Plugin',
        version: '1.0.0',
        status: 'ACTIVE',
        author: 'Tester',
        license: 'MIT',
        lastError: null,
        approvedBy: null,
        approvedAt: null,
        installedAt: new Date(),
        updatedAt: new Date(),
        permissions: ['db:read'],
      },
    ];
    prisma.pluginRegistry.findMany.mockResolvedValue(fakePlugins);

    const res = await supertest(app)
      .get('/api/plugins')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.plugins).toHaveLength(1);
    expect(res.body.plugins[0].pluginId).toBe('test-plugin');
  });
});
