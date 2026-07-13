/**
 * Timeline module — integration tests (mocked Prisma, no real DB).
 * Covers: 401 for unauthenticated, VIEWER access to /items + /filters,
 * /legacy/:ciId valid UUID, /legacy/:ciId invalid UUID → 400.
 */

const mockCiFindMany      = jest.fn();
const mockContractFindMany = jest.fn();
const mockLicenseFindMany  = jest.fn();
const mockCITypeFindMany   = jest.fn();
const mockDateTypeFindMany = jest.fn();
const mockCIFindUnique     = jest.fn();
const mockQueryRaw         = jest.fn();
const mockUserFindUnique   = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    cI: {
      findMany:   mockCiFindMany,
      findUnique: mockCIFindUnique,
    },
    contract: { findMany: mockContractFindMany },
    license:  { findMany: mockLicenseFindMany  },
    cIType:   { findMany: mockCITypeFindMany   },
    dateType: { findMany: mockDateTypeFindMany  },
    user:     { findUnique: mockUserFindUnique  },
    operatingSystem: { findMany: jest.fn().mockResolvedValue([]) },
    baseSoftware:    { findMany: jest.fn().mockResolvedValue([]) },
    deviceModel:     { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: mockQueryRaw,
  })),
  Prisma: { raw: (v: string) => ({ sql: v, values: [] }) },
}));

process.env.JWT_SECRET = 'test-secret-32-chars-minimum-len!!';

import express        from 'express';
import supertest      from 'supertest';
import jwt            from 'jsonwebtoken';
import cookieParser   from 'cookie-parser';
import { PrismaClient } from '@prisma/client';
import { createTimelineRouter }        from '../router.js';
import { createAuthenticateToken }     from '../../../shared/middleware/authenticate.js';

const SECRET  = 'test-secret-32-chars-minimum-len!!';
const USER_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const CI_ID   = 'bbbbbbbb-1111-2222-3333-444444444444';

const prisma = new PrismaClient() as any;

function makeToken(role: 'ADMIN' | 'AUDITOR' | 'VIEWER'): string {
  return jwt.sign(
    { id: USER_ID, username: 'tester', email: `${role.toLowerCase()}@test.local`, role },
    SECRET,
    { expiresIn: '1h' },
  );
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  const authenticateToken = createAuthenticateToken(prisma);
  app.use('/api/timeline', authenticateToken, createTimelineRouter(prisma));
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();

  // Default: user lookup returns an active user
  mockUserFindUnique.mockResolvedValue({
    id: USER_ID, email: 'viewer@test.local', role: 'VIEWER', active: true, mfaEnabled: false,
  });

  // Default empty responses
  mockCiFindMany.mockResolvedValue([]);
  mockContractFindMany.mockResolvedValue([]);
  mockLicenseFindMany.mockResolvedValue([]);
  mockCITypeFindMany.mockResolvedValue([]);
  mockDateTypeFindMany.mockResolvedValue([]);
  // authenticateToken's active-user check runs prisma.$queryRaw directly (not
  // prisma.user.findUnique) — an empty result here reads as "deactivated" and the
  // middleware 403s every request before it ever reaches the timeline router.
  // This mock is timeline-router-agnostic (the router itself never calls $queryRaw),
  // so a blanket "active" default is safe for every test in this file.
  mockQueryRaw.mockResolvedValue([{ active: true }]);
  mockCIFindUnique.mockResolvedValue(null);
});

// ─── Auth guard ───────────────────────────────────────────────────────────────

describe('GET /api/timeline/items — auth', () => {
  it('returns 401 when no token is provided', async () => {
    const res = await supertest(buildApp()).get('/api/timeline/items');
    expect(res.status).toBe(401);
  });

  it('returns 403 with a bad token', async () => {
    // authenticateToken's 401/403 split is intentional: 401 = no credentials
    // presented at all, 403 = credentials presented but invalid/expired
    // (jwt.verify failure) — see shared/middleware/authenticate.ts.
    const res = await supertest(buildApp())
      .get('/api/timeline/items')
      .set('Authorization', 'Bearer bad.token.here');
    expect(res.status).toBe(403);
  });

  it('allows VIEWER role', async () => {
    const res = await supertest(buildApp())
      .get('/api/timeline/items')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);
    expect(res.status).toBe(200);
  });

  it('allows AUDITOR role', async () => {
    const res = await supertest(buildApp())
      .get('/api/timeline/items')
      .set('Authorization', `Bearer ${makeToken('AUDITOR')}`);
    expect(res.status).toBe(200);
  });

  it('allows ADMIN role', async () => {
    const res = await supertest(buildApp())
      .get('/api/timeline/items')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).toBe(200);
  });
});

// ─── /items response shape ────────────────────────────────────────────────────

describe('GET /api/timeline/items — response shape', () => {
  it('returns { total, data } with empty arrays when no data', async () => {
    const res = await supertest(buildApp())
      .get('/api/timeline/items')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('total');
    expect(res.body).toHaveProperty('data');
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('maps CI rows to TimelineItem format', async () => {
    mockCiFindMany.mockResolvedValue([{
      id: CI_ID,
      name: 'Server-01',
      status: 'ACTIVO',
      eolDate: new Date('2025-12-31'),
      eosDate: null,
      lastCheckDate: null,
      ciTypeDef: { name: 'Servidor Físico' },
      lifecycleDates: [],
    }]);

    const res = await supertest(buildApp())
      .get('/api/timeline/items?types=ci')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const item = res.body.data[0];
    expect(item.kind).toBe('ci');
    expect(item.name).toBe('Server-01');
    expect(item.status).toBe('ACTIVO');
    expect(item.milestones).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'eol', date: '2025-12-31' })]),
    );
  });

  it('rejects invalid query param gracefully', async () => {
    // ciTypeId must be a UUID
    const res = await supertest(buildApp())
      .get('/api/timeline/items?ciTypeId=not-a-uuid')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);
    expect(res.status).toBe(400);
  });
});

// ─── /filters ─────────────────────────────────────────────────────────────────

describe('GET /api/timeline/filters', () => {
  it('returns ciTypes + dateTypes + statuses', async () => {
    mockCITypeFindMany.mockResolvedValue([{ id: 'type-1', name: 'Servidor Físico' }]);
    mockDateTypeFindMany.mockResolvedValue([{ id: 'dt-1', name: 'EOL', category: 'HARDWARE' }]);

    const res = await supertest(buildApp())
      .get('/api/timeline/filters')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ciTypes');
    expect(res.body).toHaveProperty('dateTypes');
    expect(res.body).toHaveProperty('statuses');
    expect(res.body).toHaveProperty('masterSubtypes');
    expect(res.body.ciTypes[0].name).toBe('Servidor Físico');
  });
});

// ─── /legacy/:ciId ────────────────────────────────────────────────────────────

describe('GET /api/timeline/legacy/:ciId', () => {
  it('returns 400 for non-UUID ciId', async () => {
    const res = await supertest(buildApp())
      .get('/api/timeline/legacy/not-a-uuid')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);
    expect(res.status).toBe(400);
  });

  it('returns empty children for unknown CI', async () => {
    mockCIFindUnique.mockResolvedValue(null);
    const res = await supertest(buildApp())
      .get(`/api/timeline/legacy/${CI_ID}`)
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);
    expect(res.status).toBe(200);
    expect(res.body.children).toEqual([]);
  });

  it('aggregates related entities (OS, model, contract, license) as children', async () => {
    mockCIFindUnique.mockResolvedValue({
      id: CI_ID,
      operatingSystemId: 'os-1',
      ciModelId: 'model-1',
      operatingSystem: {
        name: 'RHEL',
        version: '9',
        lifecycleDates: [
          { dateValue: new Date('2030-06-30'), dateType: { name: 'Full Support End' } },
        ],
      },
      ciModel: {
        name: 'PowerEdge R740',
        eolDate: new Date('2028-01-01'),
        eosDate: null,
        lifecycleDates: [],
      },
      baseSoftwares: [],
      contracts: [
        { contractNumber: 'SOPORTE-2025', startDate: new Date('2025-01-01'), endDate: new Date('2026-12-31') },
      ],
      licenses: [
        { name: 'vSphere', status: 'ACTIVO', startDate: new Date('2024-01-01'), endDate: new Date('2027-01-01') },
      ],
    });

    const res = await supertest(buildApp())
      .get(`/api/timeline/legacy/${CI_ID}`)
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);

    expect(res.status).toBe(200);
    // one child each: os, model, contract, license
    expect(res.body.children).toHaveLength(4);

    const os = res.body.children.find((c: any) => c.source === 'os');
    expect(os?.sourceName).toBe('RHEL 9');
    expect(os?.milestones[0].date).toBe('2030-06-30');

    const model = res.body.children.find((c: any) => c.source === 'model');
    expect(model?.milestones.find((m: any) => m.type === 'eol')?.date).toBe('2028-01-01');

    const contract = res.body.children.find((c: any) => c.source === 'contract');
    expect(contract?.sourceName).toBe('SOPORTE-2025');
    expect(contract?.startDate).toBe('2025-01-01');
    expect(contract?.endDate).toBe('2026-12-31');

    const license = res.body.children.find((c: any) => c.source === 'license');
    expect(license?.sourceName).toBe('vSphere');
    expect(license?.endDate).toBe('2027-01-01');
  });
});
