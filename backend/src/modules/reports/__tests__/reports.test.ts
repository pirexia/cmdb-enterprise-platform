/**
 * Reports module — unit + integration tests (mocked Prisma, no real DB).
 * Covers: registry RBAC logic, GET /api/reports listing, /:id/data 401/403/200,
 * /:id/export CSV/XLSX, plugin report proxy, audit log fire-and-forget.
 */

// ── Prisma mock ───────────────────────────────────────────────────────────────
const mockAuditCreate  = jest.fn().mockResolvedValue({});
const mockCICount      = jest.fn().mockResolvedValue(3);
const mockCIGroupBy    = jest.fn().mockResolvedValue([
  { status: 'ACTIVO',   _count: { id: 2 } },
  { status: 'INACTIVO', _count: { id: 1 } },
]);
const mockCIFindMany   = jest.fn().mockResolvedValue([
  { id: 'ci-1', name: 'Server A', ciTypeDef: { name: 'Server' }, status: 'ACTIVO', criticality: 'HIGH', location: null, costCenter: null, branch: null, createdAt: new Date('2024-01-01') },
  { id: 'ci-2', name: 'Switch B', ciTypeDef: { name: 'Network' }, status: 'ACTIVO', criticality: 'MEDIUM', location: null, costCenter: null, branch: null, createdAt: new Date('2024-02-01') },
  { id: 'ci-3', name: 'VM C',     ciTypeDef: { name: 'Virtual' }, status: 'INACTIVO', criticality: 'LOW', location: null, costCenter: null, branch: null, createdAt: new Date('2024-03-01') },
]);

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    auditLog: { create: mockAuditCreate },
    cI: { count: mockCICount, findMany: mockCIFindMany, groupBy: mockCIGroupBy },
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    $queryRaw: jest.fn().mockResolvedValue([]),
  })),
  Prisma: { raw: (v: string) => ({ sql: v, values: [] }) },
}));

// ── Export functions mock (exceljs has complex deps, test at integration level) ──
jest.mock('../export', () => ({
  toCSV: jest.fn((_cols: unknown[], rows: unknown[]) =>
    `"name"\n${rows.map(() => '"Test"').join('\n')}`
  ),
  toXLSX: jest.fn(() => Promise.resolve(Buffer.from('PK\x03\x04xlsx-stub'))),
}));

// ── Plugin engine mock ────────────────────────────────────────────────────────
const mockRunRoute    = jest.fn().mockResolvedValue({ data: [{ id: 'p-1', value: 'test' }], total: 1 });
const mockRouteMatch  = jest.fn().mockReturnValue({
  handlerCode: 'async function handler(req){return {data:[],total:0};}',
  permissions: [], allowedHosts: [], config: {},
});

jest.mock('../../plugins/engine', () => ({
  pluginRuntime: { runRoute: mockRunRoute },
  routeRegistry: { match: mockRouteMatch },
}));

process.env.JWT_SECRET = 'test-secret-32-chars-minimum-len!!';

import express        from 'express';
import supertest      from 'supertest';
import jwt            from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

// ── Helpers ───────────────────────────────────────────────────────────────────
const TEST_SECRET = 'test-secret-32-chars-minimum-len!!';
const prisma      = new PrismaClient() as any;

function makeToken(role: 'ADMIN' | 'AUDITOR' | 'VIEWER', email = 'test@cmdb.local'): string {
  return jwt.sign({ email, role, active: true }, TEST_SECRET, { expiresIn: '1h' });
}

function authMiddleware(req: any, res: any, next: any) {
  const header = req.headers['authorization'] ?? '';
  if (!header.startsWith('Bearer ')) { res.status(401).json({ error: 'Unauthorized' }); return; }
  try {
    req.user = jwt.verify(header.slice(7), TEST_SECRET) as any;
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

// ── Registry unit tests ───────────────────────────────────────────────────────
describe('reports/registry', () => {
  // Import registry functions fresh (module is already loaded via side effects)
  let registerReport: Function;
  let getReport: Function;
  let getAvailableReports: Function;
  let hasRoleAccess: Function;
  let unregisterPluginReports: Function;

  beforeAll(async () => {
    const reg = await import('../registry.js');
    registerReport         = reg.registerReport;
    getReport              = reg.getReport;
    getAvailableReports    = reg.getAvailableReports;
    hasRoleAccess          = reg.hasRoleAccess;
    unregisterPluginReports = reg.unregisterPluginReports;
  });

  test('hasRoleAccess: VIEWER can access VIEWER reports', () => {
    expect(hasRoleAccess('VIEWER', 'VIEWER')).toBe(true);
  });

  test('hasRoleAccess: VIEWER cannot access AUDITOR reports', () => {
    expect(hasRoleAccess('VIEWER', 'AUDITOR')).toBe(false);
  });

  test('hasRoleAccess: VIEWER cannot access ADMIN reports', () => {
    expect(hasRoleAccess('VIEWER', 'ADMIN')).toBe(false);
  });

  // v3.5.10 — MANAGER comparte rango con AUDITOR, salvo los informes de
  // auditoría, que la denylist le veta explícitamente (D3).
  test('hasRoleAccess: MANAGER accede a los informes de rango AUDITOR', () => {
    expect(hasRoleAccess('MANAGER', 'AUDITOR', 'compliance')).toBe(true);
    expect(hasRoleAccess('MANAGER', 'VIEWER', 'inventory')).toBe(true);
  });

  test('hasRoleAccess: MANAGER NO accede al informe de auditoría pese a su rango', () => {
    expect(hasRoleAccess('MANAGER', 'AUDITOR', 'audit-trail')).toBe(false);
    expect(hasRoleAccess('AUDITOR', 'AUDITOR', 'audit-trail')).toBe(true);
    expect(hasRoleAccess('ADMIN', 'AUDITOR', 'audit-trail')).toBe(true);
  });

  test('hasRoleAccess: MANAGER sigue sin acceder a los informes ADMIN', () => {
    expect(hasRoleAccess('MANAGER', 'ADMIN', 'contracts')).toBe(false);
  });

  test('hasRoleAccess: AUDITOR can access AUDITOR + VIEWER reports', () => {
    expect(hasRoleAccess('AUDITOR', 'VIEWER')).toBe(true);
    expect(hasRoleAccess('AUDITOR', 'AUDITOR')).toBe(true);
    expect(hasRoleAccess('AUDITOR', 'ADMIN')).toBe(false);
  });

  test('hasRoleAccess: ADMIN can access all reports', () => {
    expect(hasRoleAccess('ADMIN', 'VIEWER')).toBe(true);
    expect(hasRoleAccess('ADMIN', 'AUDITOR')).toBe(true);
    expect(hasRoleAccess('ADMIN', 'ADMIN')).toBe(true);
  });

  test('registerReport adds a report; getReport retrieves it', () => {
    registerReport({
      id: '__test-reg__',
      nameKey: 'test.name', descriptionKey: 'test.desc',
      category: 'inventory', minRole: 'VIEWER', icon: 'BarChart2',
      tags: ['test'], exportFormats: ['csv'], columns: [], filters: [],
      source: 'core',
      query: async () => ({ data: [], total: 0 }),
    });
    const def = getReport('__test-reg__');
    expect(def).toBeDefined();
    expect(def!.id).toBe('__test-reg__');
  });

  test('getAvailableReports marks unavailable when role too low', () => {
    registerReport({
      id: '__test-admin__',
      nameKey: 'admin.name', descriptionKey: 'admin.desc',
      category: 'financial', minRole: 'ADMIN', icon: 'Lock',
      tags: [], exportFormats: ['csv'], columns: [], filters: [],
      source: 'core',
      query: async () => ({ data: [], total: 0 }),
    });
    const viewerReports = getAvailableReports('VIEWER');
    const adminReport = viewerReports.find((r: any) => r.id === '__test-admin__');
    expect(adminReport).toBeDefined();
    expect(adminReport!.available).toBe(false);

    const adminReports = getAvailableReports('ADMIN');
    const asAdmin = adminReports.find((r: any) => r.id === '__test-admin__');
    expect(asAdmin!.available).toBe(true);
  });

  test('unregisterPluginReports removes only plugin reports', () => {
    registerReport({
      id: '__plugin-report__',
      nameKey: 'p.name', descriptionKey: 'p.desc',
      category: 'audit', minRole: 'VIEWER', icon: 'BarChart2',
      tags: [], exportFormats: ['csv'], columns: [], filters: [],
      source: 'plugin', pluginId: 'my-test-plugin', routePath: '/data',
    });
    expect(getReport('__plugin-report__')).toBeDefined();
    unregisterPluginReports('my-test-plugin');
    expect(getReport('__plugin-report__')).toBeUndefined();
    // Core report must survive
    expect(getReport('__test-reg__')).toBeDefined();
  });
});

// ── Router integration tests ──────────────────────────────────────────────────
describe('GET /api/reports', () => {
  let app: express.Express;

  beforeAll(async () => {
    const { createReportsRouter } = await import('../index.js');
    app = express();
    app.use(express.json());
    app.use('/api/reports', authMiddleware, createReportsRouter(prisma));
  });

  test('401 without token', async () => {
    const res = await supertest(app).get('/api/reports');
    expect(res.status).toBe(401);
  });

  test('200 returns reports array with available flag', async () => {
    const res = await supertest(app)
      .get('/api/reports')
      .set('Authorization', `Bearer ${makeToken('AUDITOR')}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.reports)).toBe(true);
    expect(res.body.reports.length).toBeGreaterThan(0);
    for (const r of res.body.reports) {
      expect(typeof r.available).toBe('boolean');
      expect(r.id).toBeDefined();
      expect(r.category).toBeDefined();
    }
  });

  test('ADMIN reports are available=false for VIEWER', async () => {
    const res = await supertest(app)
      .get('/api/reports')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);
    const adminReports = res.body.reports.filter((r: any) => r.minRole === 'ADMIN');
    expect(adminReports.every((r: any) => r.available === false)).toBe(true);
  });
});

describe('GET /api/reports/:id/data', () => {
  let app: express.Express;

  beforeAll(async () => {
    const { createReportsRouter } = await import('../index.js');
    app = express();
    app.use(express.json());
    app.use('/api/reports', authMiddleware, createReportsRouter(prisma));
  });

  function resetMocks() {
    jest.clearAllMocks();
    mockCICount.mockResolvedValue(3);
    mockCIGroupBy.mockResolvedValue([
      { status: 'ACTIVO', _count: { id: 2 } },
      { status: 'INACTIVO', _count: { id: 1 } },
    ]);
    mockCIFindMany.mockResolvedValue([
      { id: 'ci-1', name: 'Server A', ciTypeDef: { name: 'Server' }, status: 'ACTIVO', criticality: 'HIGH', location: null, costCenter: null, branch: null, createdAt: new Date('2024-01-01') },
    ]);
    mockAuditCreate.mockResolvedValue({});
  }

  beforeEach(resetMocks);

  test('401 without token', async () => {
    const res = await supertest(app).get('/api/reports/inventory/data');
    expect(res.status).toBe(401);
  });

  test('404 for unknown report id', async () => {
    const res = await supertest(app)
      .get('/api/reports/does-not-exist-xyz/data')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(404);
  });

  test('403 VIEWER on ADMIN-only report (contracts)', async () => {
    const res = await supertest(app)
      .get('/api/reports/contracts/data?page=1&limit=10')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);
    expect(res.status).toBe(403);
    expect(res.body.required).toBe('ADMIN');
  });

  test('200 VIEWER on inventory report returns paginated data', async () => {
    const res = await supertest(app)
      .get('/api/reports/inventory/data?page=1&limit=10')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.total).toBe('number');
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(10);
  });

  test('200 returns kpis when present', async () => {
    const res = await supertest(app)
      .get('/api/reports/inventory/data?page=1&limit=10')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.kpis)).toBe(true);
    expect(res.body.kpis.length).toBeGreaterThan(0);
  });

  test('audit log is written on successful data fetch', async () => {
    await supertest(app)
      .get('/api/reports/inventory/data?page=1&limit=5')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);
    // Fire-and-forget: wait a tick
    await new Promise((r) => setTimeout(r, 50));
    expect(mockAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'VIEW_REPORT' }),
      }),
    );
  });

  test('400 for invalid pagination params', async () => {
    const res = await supertest(app)
      .get('/api/reports/inventory/data?page=0&limit=abc')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/reports/:id/export', () => {
  let app: express.Express;

  beforeAll(async () => {
    const { createReportsRouter } = await import('../index.js');
    app = express();
    app.use(express.json());
    app.use('/api/reports', authMiddleware, createReportsRouter(prisma));
  });

  function resetExportMocks() {
    jest.clearAllMocks();
    mockCICount.mockResolvedValue(3);
    mockCIGroupBy.mockResolvedValue([{ status: 'ACTIVO', _count: { id: 1 } }]);
    mockCIFindMany.mockResolvedValue([
      { id: 'ci-1', name: 'Server A', ciTypeDef: { name: 'Server' }, status: 'ACTIVO', criticality: 'HIGH', location: null, costCenter: null, branch: null, createdAt: new Date('2024-01-01') },
    ]);
    mockAuditCreate.mockResolvedValue({});
  }

  beforeEach(resetExportMocks);

  test('200 CSV export returns text/csv with BOM', async () => {
    const res = await supertest(app)
      .get('/api/reports/inventory/export?format=csv&page=1&limit=50')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/inventory.*\.csv/);
    expect(res.text.startsWith('﻿')).toBe(true); // BOM
    expect(res.text).toContain('"name"'); // header row
  });

  test('200 XLSX export returns spreadsheet content-type', async () => {
    const res = await supertest(app)
      .get('/api/reports/inventory/export?format=xlsx&page=1&limit=50')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml/);
    expect(res.headers['content-disposition']).toMatch(/inventory.*\.xlsx/);
  });

  test('400 for unsupported export format', async () => {
    const res = await supertest(app)
      .get('/api/reports/inventory/export?format=pdf')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);
    expect(res.status).toBe(400);
  });

  test('403 AUDITOR on ADMIN-only report export', async () => {
    const res = await supertest(app)
      .get('/api/reports/contracts/export?format=csv')
      .set('Authorization', `Bearer ${makeToken('AUDITOR')}`);
    expect(res.status).toBe(403);
  });

  test('audit log written with EXPORT_REPORT action', async () => {
    await supertest(app)
      .get('/api/reports/inventory/export?format=csv&page=1&limit=10')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);
    await new Promise((r) => setTimeout(r, 50));
    expect(mockAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'EXPORT_REPORT' }),
      }),
    );
  });
});

describe('plugin report proxy', () => {
  let app: express.Express;
  let registerReport: Function;

  beforeAll(async () => {
    const reg = await import('../registry.js');
    registerReport = reg.registerReport;

    registerReport({
      id: '__plugin-proxy-test__',
      nameKey: 'p.name', descriptionKey: 'p.desc',
      category: 'inventory', minRole: 'VIEWER', icon: 'BarChart2',
      tags: [], exportFormats: ['csv'], columns: [
        { key: 'id', labelKey: 'col.id', type: 'string' },
        { key: 'value', labelKey: 'col.value', type: 'string' },
      ], filters: [],
      source: 'plugin', pluginId: 'test-plugin', routePath: '/proxy-data',
    });

    const { createReportsRouter } = await import('../index.js');
    app = express();
    app.use(express.json());
    app.use('/api/reports', authMiddleware, createReportsRouter(prisma));
  });

  test('data endpoint calls routeRegistry.match + pluginRuntime.runRoute', async () => {
    mockRouteMatch.mockReturnValue({
      handlerCode: '', permissions: [], allowedHosts: [], config: {},
    });
    mockRunRoute.mockResolvedValue({ data: [{ id: 'p-1', value: 'plugin-result' }], total: 1 });

    const res = await supertest(app)
      .get('/api/reports/__plugin-proxy-test__/data?page=1&limit=10')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);

    expect(res.status).toBe(200);
    expect(mockRouteMatch).toHaveBeenCalledWith('test-plugin', 'GET', '/proxy-data');
    expect(mockRunRoute).toHaveBeenCalled();
    expect(res.body.data[0].value).toBe('plugin-result');
  });

  test('503 when plugin route not registered', async () => {
    mockRouteMatch.mockReturnValue(null); // route removed

    const res = await supertest(app)
      .get('/api/reports/__plugin-proxy-test__/data?page=1&limit=10')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);

    expect(res.status).toBe(503);
  });
});
