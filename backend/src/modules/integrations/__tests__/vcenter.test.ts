/**
 * Task C — vCenter sync service + routes.
 * Covers: RBAC (401/403/200) on /vcenter/* routes, SyncLockedError concurrency guard,
 * and runVCenterSync create/update/retire semantics (D2/D5/fencing) at the service level.
 */

const mockQueryRaw   = jest.fn();
const mockExecuteRaw = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    $queryRaw:   mockQueryRaw,
    $executeRaw: mockExecuteRaw,
  })),
  // Prisma namespace is referenced as a type only in vcenterService.ts (Prisma.InputJsonValue),
  // but jest.mock replaces the whole module — provide a harmless stand-in just in case any
  // runtime access slips through.
  Prisma: {},
}));

process.env.JWT_SECRET = 'test-secret-32-chars-minimum-len!!';

import express        from 'express';
import supertest      from 'supertest';
import jwt            from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { createIntegrationsRouter } from '../router.js';
import { runVCenterSync, SyncLockedError } from '../vcenterService.js';
import type { IHypervisorConnector, DiscoveredVM } from '../connectors/types.js';

const TEST_SECRET = 'test-secret-32-chars-minimum-len!!';
const prisma = new PrismaClient() as any;
const mockQueue = jest.fn();

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

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
  app.use('/api/integrations', createIntegrationsRouter(prisma, mockQueue));
  return supertest(app);
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: authenticateToken's active-user check succeeds
  mockQueryRaw.mockResolvedValue([{ active: true }]);
  mockExecuteRaw.mockResolvedValue(1);
  // Ensure env-based vCenter config is unset unless a test opts in
  delete process.env.VCENTER_URL;
  delete process.env.VCENTER_USER;
  delete process.env.VCENTER_PASSWORD;
  delete process.env.VCENTER_SYNC_ENABLED;
});

// ── RBAC matrix ───────────────────────────────────────────────────────────────

describe('GET /api/integrations/vcenter/status — RBAC', () => {
  it('returns 401 without token', async () => {
    const res = await buildApp().get('/api/integrations/vcenter/status');
    expect(res.status).toBe(401);
  });

  it('returns 403 for VIEWER', async () => {
    const res = await buildApp()
      .get('/api/integrations/vcenter/status')
      .set('Authorization', `Bearer ${makeToken('VIEWER')}`);
    expect(res.status).toBe(403);
  });

  it('returns 200 for AUDITOR', async () => {
    mockQueryRaw
      .mockResolvedValueOnce([{ active: true }]) // auth check
      .mockResolvedValueOnce([]);                // lastSync lookup
    const res = await buildApp()
      .get('/api/integrations/vcenter/status')
      .set('Authorization', `Bearer ${makeToken('AUDITOR')}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('configured', false);
    expect(res.body).toHaveProperty('lastSyncAt', null);
  });
});

describe('POST /api/integrations/vcenter/sync — RBAC', () => {
  it('returns 403 for AUDITOR', async () => {
    const res = await buildApp()
      .post('/api/integrations/vcenter/sync')
      .set('Authorization', `Bearer ${makeToken('AUDITOR')}`);
    expect(res.status).toBe(403);
  });

  it('does not return 403 for ADMIN (proceeds to config check → 409 not configured)', async () => {
    const res = await buildApp()
      .post('/api/integrations/vcenter/sync')
      .set('Authorization', `Bearer ${makeToken('ADMIN')}`);
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'VCENTER_NOT_CONFIGURED' });
  });
});

// ── SyncLockedError concurrency guard (service-level unit test) ──────────────

describe('runVCenterSync — concurrency lock', () => {
  it('rejects a second concurrent call with SyncLockedError', async () => {
    let resolveDiscover!: (vms: DiscoveredVM[]) => void;
    const blockedConnector: IHypervisorConnector = {
      connect: jest.fn().mockResolvedValue(undefined),
      discover: jest.fn().mockReturnValue(new Promise((resolve) => { resolveDiscover = resolve; })),
      close: jest.fn().mockResolvedValue(undefined),
    };

    const fakePrisma = makeFakePrisma();

    const firstCall = runVCenterSync({
      prisma: fakePrisma,
      connector: blockedConnector,
      defaults: { ciTypeCode: 'VIRTUAL_SERVER', environment: 'PRODUCTION', criticality: 'MEDIUM' },
      queueForIndexing: jest.fn(),
      userEmail: 'tester@test.local',
    });

    const secondCallPromise = runVCenterSync({
      prisma: fakePrisma,
      connector: blockedConnector,
      defaults: { ciTypeCode: 'VIRTUAL_SERVER', environment: 'PRODUCTION', criticality: 'MEDIUM' },
      queueForIndexing: jest.fn(),
      userEmail: 'tester@test.local',
    });

    await expect(secondCallPromise).rejects.toBeInstanceOf(SyncLockedError);

    // Unblock the first call so the lock is released and future tests aren't polluted
    resolveDiscover([]);
    await firstCall;
  });
});

// ── runVCenterSync create/update/retire semantics ────────────────────────────

function makeFakeConnector(vms: DiscoveredVM[]): IHypervisorConnector {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    discover: jest.fn().mockResolvedValue(vms),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

function makeFakePrisma(overrides: Record<string, any> = {}) {
  return {
    operatingSystem: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'os-1' }),
    },
    cI: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'ci-new-1' }),
      update: jest.fn().mockResolvedValue({ id: 'ci-updated-1' }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    cIType: {
      findUnique: jest.fn().mockResolvedValue({ id: 'citype-1', code: 'VIRTUAL_SERVER' }),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
    ...overrides,
  } as any;
}

const DEFAULTS = { ciTypeCode: 'VIRTUAL_SERVER', environment: 'PRODUCTION', criticality: 'MEDIUM' };

function vm(overrides: Partial<DiscoveredVM> = {}): DiscoveredVM {
  return {
    moref: 'vm-1',
    name: 'test-vm',
    powerState: 'POWERED_ON',
    cpuCount: 4,
    memoryMiB: 8192,
    guestOS: null,
    guestFamily: null,
    ipAddress: '10.0.0.1',
    hostName: 'test-vm.local',
    cluster: 'cluster-a',
    esxiHost: 'esxi-1',
    ...overrides,
  };
}

describe('runVCenterSync — create', () => {
  it('creates a new CI with status ACTIVO and inserts a CI_CREATE audit row', async () => {
    const fakePrisma = makeFakePrisma();
    const queue = jest.fn();

    const result = await runVCenterSync({
      prisma: fakePrisma,
      connector: makeFakeConnector([vm()]),
      defaults: DEFAULTS,
      queueForIndexing: queue,
      userEmail: 'admin@test.local',
    });

    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.errors).toBe(0);
    expect(fakePrisma.cI.create).toHaveBeenCalledTimes(1);
    const createArgs = fakePrisma.cI.create.mock.calls[0][0];
    expect(createArgs.data.status).toBe('ACTIVO');
    expect(createArgs.data.apiSlug).toBe('vm-vm-1');
    expect(createArgs.data.vCpus).toBe(4);
    expect(createArgs.data.ram).toBe('8 GB');

    // one CI_CREATE audit row + one SYNC_VCENTER audit row = 2 $executeRaw calls
    expect(fakePrisma.$executeRaw).toHaveBeenCalledTimes(2);
    expect(queue).toHaveBeenCalledWith('ci', 'ci-new-1');
  });

  it('creates a powered-off VM with status ACTIVO too (D2: status never derived from powerState)', async () => {
    const fakePrisma = makeFakePrisma();

    await runVCenterSync({
      prisma: fakePrisma,
      connector: makeFakeConnector([vm({ powerState: 'POWERED_OFF' })]),
      defaults: DEFAULTS,
      queueForIndexing: jest.fn(),
      userEmail: 'admin@test.local',
    });

    const createArgs = fakePrisma.cI.create.mock.calls[0][0];
    expect(createArgs.data.status).toBe('ACTIVO');
  });
});

describe('runVCenterSync — update', () => {
  it('updates only D5-owned fields, never touching status/criticality/environment', async () => {
    const fakePrisma = makeFakePrisma({
      cI: {
        findUnique: jest.fn().mockResolvedValue({ id: 'ci-existing-1' }),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({ id: 'ci-existing-1' }),
        findMany: jest.fn().mockResolvedValue([]),
      },
    });

    const result = await runVCenterSync({
      prisma: fakePrisma,
      connector: makeFakeConnector([vm({ powerState: 'POWERED_OFF' })]),
      defaults: DEFAULTS,
      queueForIndexing: jest.fn(),
      userEmail: 'admin@test.local',
    });

    expect(result.updated).toBe(1);
    expect(result.created).toBe(0);
    expect(fakePrisma.cI.update).toHaveBeenCalledTimes(1);
    const updateArgs = fakePrisma.cI.update.mock.calls[0][0];
    expect(updateArgs.data).not.toHaveProperty('status');
    expect(updateArgs.data).not.toHaveProperty('criticality');
    expect(updateArgs.data).not.toHaveProperty('environment');
    expect(updateArgs.data).toMatchObject({
      vCpus: 4,
      ram: '8 GB',
      adminIp: '10.0.0.1',
      hostName: 'test-vm.local',
      clusterName: 'cluster-a',
    });
    expect(updateArgs.data).toHaveProperty('vcenterSync');
  });
});

describe('runVCenterSync — retire', () => {
  it('retires a CI that vanished from the vCenter VM list (fenced: ciType + vcenterSync not null)', async () => {
    const fakePrisma = makeFakePrisma({
      cI: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'ci-new-1' }),
        update: jest.fn().mockResolvedValue({ id: 'ci-vanished-1' }),
        findMany: jest.fn().mockResolvedValue([
          { id: 'ci-vanished-1', apiSlug: 'vm-vm-999', vcenterSync: { moref: 'vm-999' } },
        ]),
      },
    });

    const result = await runVCenterSync({
      prisma: fakePrisma,
      connector: makeFakeConnector([vm()]), // vm-1 only — vm-999 is gone
      defaults: DEFAULTS,
      queueForIndexing: jest.fn(),
      userEmail: 'admin@test.local',
    });

    expect(result.retired).toBe(1);
    expect(fakePrisma.cI.update).toHaveBeenCalledWith({
      where: { id: 'ci-vanished-1' },
      data: { status: 'RETIRADO' },
    });
  });

  it('does NOT retire a manually-entered CI with vcenterSync=null even if absent from discover() (safety fence)', async () => {
    const fakePrisma = makeFakePrisma({
      cI: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'ci-new-1' }),
        update: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([
          { id: 'ci-manual-1', apiSlug: 'vm-does-not-match-anything', vcenterSync: null },
        ]),
      },
    });

    const result = await runVCenterSync({
      prisma: fakePrisma,
      connector: makeFakeConnector([vm()]),
      defaults: DEFAULTS,
      queueForIndexing: jest.fn(),
      userEmail: 'admin@test.local',
    });

    expect(result.retired).toBe(0);
    // update() is called once for the created VM path is not applicable here (create path
    // doesn't call update) — assert update was never invoked with the manual CI's id.
    const updateCallsForManualCi = fakePrisma.cI.update.mock.calls.filter(
      (args: any[]) => args[0]?.where?.id === 'ci-manual-1',
    );
    expect(updateCallsForManualCi).toHaveLength(0);
  });
});

describe('runVCenterSync — audit summary', () => {
  it('inserts a final SYNC_VCENTER audit row with created/updated/retired/errors counts', async () => {
    const fakePrisma = makeFakePrisma();

    await runVCenterSync({
      prisma: fakePrisma,
      connector: makeFakeConnector([vm()]),
      defaults: DEFAULTS,
      queueForIndexing: jest.fn(),
      userEmail: 'admin@test.local',
    });

    const syncAuditCall = fakePrisma.$executeRaw.mock.calls.find((args: any[]) =>
      args.some((a: any) => typeof a === 'string' && a === 'SYNC_VCENTER'),
    );
    expect(syncAuditCall).toBeDefined();
    // The details payload is JSON.stringify'd and passed as one of the tagged-template values;
    // find it and parse it back.
    const detailsArg = syncAuditCall.find((a: any) => {
      if (typeof a !== 'string') return false;
      try {
        const parsed = JSON.parse(a);
        return typeof parsed === 'object' && 'created' in parsed;
      } catch {
        return false;
      }
    });
    expect(detailsArg).toBeDefined();
    const details = JSON.parse(detailsArg);
    expect(details).toMatchObject({ created: 1, updated: 0, retired: 0, errors: 0 });
  });
});
