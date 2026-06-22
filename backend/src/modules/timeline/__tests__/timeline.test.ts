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
  mockQueryRaw.mockResolvedValue([]);
  mockCIFindUnique.mockResolvedValue(null);
});

// ─── Auth guard ───────────────────────────────────────────────────────────────

describe('GET /api/timeline/items — auth', () => {
  it('returns 401 when no token is provided', async () => {
    const res = await supertest(buildApp()).get('/api/timeline/items');
    expect(res.status).toBe(401);
  });

  it('returns 401 with a bad token', async () => {
    const res = await supertest(buildApp())
      .get('/api/timeline/items')
      .set('Authorization', 'Bearer bad.token.here');
    expect(res.status).toBe(401);
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

  it('returns empty milestones for unknown CI', async () => {
    mockCIFindUnique.mockResolvedValue(null);
    const res = await supertest(buildApp())
      .get(`/api/timeline/legacy/${CI_ID}`)
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);
    expect(res.status).toBe(200);
    expect(res.body.milestones).toEqual([]);
  });

  it('aggregates inherited dates from OS and DeviceModel', async () => {
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
    });

    const res = await supertest(buildApp())
      .get(`/api/timeline/legacy/${CI_ID}`)
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);

    expect(res.status).toBe(200);
    expect(res.body.milestones).toHaveLength(2);
    expect(res.body.milestones.every((m: any) => m.inherited === true)).toBe(true);

    const osMilestone = res.body.milestones.find((m: any) => m.inheritedFrom === 'os');
    expect(osMilestone?.date).toBe('2030-06-30');

    const modelMilestone = res.body.milestones.find((m: any) => m.inheritedFrom === 'model');
    expect(modelMilestone?.type).toBe('eol');
    expect(modelMilestone?.date).toBe('2028-01-01');
  });
});
