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
const VMWARE_HYPERVISOR = { id: 'hyp-vmware-fixture-id', code: 'VMWARE', name: 'VMware vSphere / vCenter', isSystem: true };

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
    hypervisor: {
      findUnique: jest.fn().mockResolvedValue(VMWARE_HYPERVISOR),
    },
    cIRelation: {
      upsert: jest.fn().mockResolvedValue({}),
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
    // Defaults to null (not 'esxi-1') deliberately: most existing tests in this file
    // sequence cI.findMany() mocks by call order (adoption-candidates, then retire-query).
    // The Task H2 HOSTS-relation lookup is a THIRD cI.findMany() call site that only fires
    // when esxiHost is truthy — keeping the shared default null preserves every pre-existing
    // test's call-order assumptions untouched. Tests exercising the HOSTS-relation step
    // explicitly opt in via vm({ esxiHost: '...' }).
    esxiHost: null,
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
    expect(createArgs.data.hypervisorId).toBe(VMWARE_HYPERVISOR.id);
    expect(createArgs.data.powerState).toBe('POWERED_ON');

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
    expect(updateArgs.data).not.toHaveProperty('hypervisorId');
    expect(updateArgs.data).toMatchObject({
      vCpus: 4,
      ram: '8 GB',
      adminIp: '10.0.0.1',
      hostName: 'test-vm.local',
      clusterName: 'cluster-a',
    });
    expect(updateArgs.data).toHaveProperty('powerState', 'POWERED_OFF');
  });
});

describe('runVCenterSync — H1 adoption of pre-existing manually-entered CIs', () => {
  it('no apiSlug match, no name-match candidates (0) — creates a new CI (regression, unaffected)', async () => {
    const fakePrisma = makeFakePrisma({
      cI: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'ci-new-1' }),
        update: jest.fn().mockResolvedValue({}),
        // First call: name-match candidate query (0 results). Second call: retire query.
        findMany: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]),
      },
    });

    const result = await runVCenterSync({
      prisma: fakePrisma,
      connector: makeFakeConnector([vm()]),
      defaults: DEFAULTS,
      queueForIndexing: jest.fn(),
      userEmail: 'admin@test.local',
    });

    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);
    expect(fakePrisma.cI.create).toHaveBeenCalledTimes(1);
    expect(fakePrisma.cI.update).not.toHaveBeenCalled();
  });

  it('no apiSlug match, exactly ONE name-match candidate with hypervisorId=null — adopts it', async () => {
    const fakePrisma = makeFakePrisma({
      cI: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'ci-new-1' }),
        update: jest.fn().mockResolvedValue({ id: 'ci-manual-adopt-1' }),
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ id: 'ci-manual-adopt-1' }]) // name-match candidates
          .mockResolvedValueOnce([]), // retire query
      },
    });

    const result = await runVCenterSync({
      prisma: fakePrisma,
      connector: makeFakeConnector([vm()]),
      defaults: DEFAULTS,
      queueForIndexing: jest.fn(),
      userEmail: 'admin@test.local',
    });

    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);
    expect(fakePrisma.cI.create).not.toHaveBeenCalled();
    expect(fakePrisma.cI.update).toHaveBeenCalledTimes(1);

    const updateArgs = fakePrisma.cI.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 'ci-manual-adopt-1' });
    expect(updateArgs.data).toMatchObject({
      apiSlug: 'vm-vm-1',
      hypervisorId: VMWARE_HYPERVISOR.id,
      vCpus: 4,
      ram: '8 GB',
      adminIp: '10.0.0.1',
      hostName: 'test-vm.local',
    });

    // Assert the candidate query itself was built correctly (case-insensitive name match,
    // fenced to unclassified CIs of the right CI type, excluding RETIRADO).
    const candidateQueryArgs = fakePrisma.cI.findMany.mock.calls[0][0];
    expect(candidateQueryArgs).toMatchObject({
      where: {
        ciTypeDef: { code: 'VIRTUAL_SERVER' },
        hypervisorId: null,
        status: { not: 'RETIRADO' },
        name: { equals: 'test-vm', mode: 'insensitive' },
      },
    });

    const auditCall = fakePrisma.$executeRaw.mock.calls.find((args: any[]) =>
      args.some((a: any) => typeof a === 'string' && a === 'CI_UPDATE'),
    );
    expect(auditCall).toBeDefined();
    const auditDetails = auditCall.find((a: any) => {
      if (typeof a !== 'string') return false;
      try {
        return JSON.parse(a).adopted === true;
      } catch {
        return false;
      }
    });
    expect(auditDetails).toBeDefined();
  });

  it('SAFETY-CRITICAL: a name-matching CI already owned by a different hypervisor is never adopted or touched (DB-level hypervisorId:null filter excludes it — mock returns empty)', async () => {
    // A real Postgres query with `hypervisorId: null` in the WHERE clause would never
    // return a row already owned by another hypervisor (e.g. a future OLVM connector's
    // CI) — so the candidate mock reflects that by returning an empty array, proving the
    // VM correctly falls through to CREATE rather than touching the OLVM-owned CI at all.
    const fakePrisma = makeFakePrisma({
      cI: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'ci-new-1' }),
        update: jest.fn().mockResolvedValue({}),
        findMany: jest
          .fn()
          .mockResolvedValueOnce([]) // name-match candidates: excluded at DB level by hypervisorId:null
          .mockResolvedValueOnce([]), // retire query
      },
    });

    const result = await runVCenterSync({
      prisma: fakePrisma,
      connector: makeFakeConnector([vm()]),
      defaults: DEFAULTS,
      queueForIndexing: jest.fn(),
      userEmail: 'admin@test.local',
    });

    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);
    expect(fakePrisma.cI.create).toHaveBeenCalledTimes(1);
    const updateCallsForOlvmCi = fakePrisma.cI.update.mock.calls.filter(
      (args: any[]) => args[0]?.where?.id === 'ci-olvm-owned-1',
    );
    expect(updateCallsForOlvmCi).toHaveLength(0);
    expect(fakePrisma.cI.update).not.toHaveBeenCalled();

    // Confirm the query that would run against a real DB does filter hypervisorId: null,
    // which is the actual mechanism guaranteeing the OLVM-owned CI can never come back.
    const candidateQueryArgs = fakePrisma.cI.findMany.mock.calls[0][0];
    expect(candidateQueryArgs.where.hypervisorId).toBeNull();
  });

  it('ambiguous match — 2+ name-match candidates — falls through to create new CI', async () => {
    const fakePrisma = makeFakePrisma({
      cI: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'ci-new-1' }),
        update: jest.fn().mockResolvedValue({}),
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ id: 'ci-manual-a' }, { id: 'ci-manual-b' }]) // ambiguous
          .mockResolvedValueOnce([]), // retire query
      },
    });

    const result = await runVCenterSync({
      prisma: fakePrisma,
      connector: makeFakeConnector([vm()]),
      defaults: DEFAULTS,
      queueForIndexing: jest.fn(),
      userEmail: 'admin@test.local',
    });

    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);
    expect(fakePrisma.cI.create).toHaveBeenCalledTimes(1);
    expect(fakePrisma.cI.update).not.toHaveBeenCalled();
  });
});

describe('runVCenterSync — retire', () => {
  it('retires a CI that vanished from the vCenter VM list (fenced: ciType + hypervisorId === vmwareHypervisor.id)', async () => {
    const fakePrisma = makeFakePrisma({
      cI: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'ci-new-1' }),
        update: jest.fn().mockResolvedValue({ id: 'ci-vanished-1' }),
        // First call: H1 name-match candidate query for the current VM (empty — no adoption
        // candidate here). Second call: the retire query, returning the vanished CI.
        findMany: jest
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            { id: 'ci-vanished-1', apiSlug: 'vm-vm-999', hypervisorId: VMWARE_HYPERVISOR.id },
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

  it('does NOT retire a manually-entered CI with hypervisorId=null even if absent from discover() (safety fence)', async () => {
    const fakePrisma = makeFakePrisma({
      cI: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'ci-new-1' }),
        update: jest.fn().mockResolvedValue({}),
        // First call: H1 name-match candidate query for the current VM (empty — a real DB
        // query wouldn't match this fixture by name anyway). Second call: the retire query,
        // returning the manually-entered, unclassified CI that must NOT be retired.
        findMany: jest
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            { id: 'ci-manual-1', apiSlug: 'vm-does-not-match-anything', hypervisorId: null },
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

  it('never retires a CI owned by a different hypervisor (e.g. a future OLVM connector)', async () => {
    // Simulates the exact scenario the user asked about: an OLVM VM using the same
    // ciType (VIRTUAL_SERVER) as vCenter VMs, but classified under a DIFFERENT
    // hypervisor row. A null-check alone would not protect this CI once a second
    // hypervisor exists — only exact-id equality against THIS connector's hypervisor does.
    const OLVM_HYPERVISOR_ID = 'hyp-olvm-fixture-id';
    const fakePrisma = makeFakePrisma({
      cI: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'ci-new-1' }),
        update: jest.fn().mockResolvedValue({}),
        // First call: H1 name-match candidate query for the current VM (empty). Second call:
        // the retire query, returning the OLVM-owned CI that must NOT be retired.
        findMany: jest
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            { id: 'ci-olvm-owned-1', apiSlug: 'vm-does-not-match-anything-either', hypervisorId: OLVM_HYPERVISOR_ID },
          ]),
      },
      // hypervisor.findUnique still resolves the VMware row this connector owns —
      // only the candidate CI belongs to a different hypervisor.
      hypervisor: {
        findUnique: jest.fn().mockResolvedValue(VMWARE_HYPERVISOR),
      },
    });

    const result = await runVCenterSync({
      prisma: fakePrisma,
      connector: makeFakeConnector([vm()]), // vm-1 only — the OLVM VM is (correctly) absent
      defaults: DEFAULTS,
      queueForIndexing: jest.fn(),
      userEmail: 'admin@test.local',
    });

    expect(result.retired).toBe(0);
    const updateCallsForOlvmCi = fakePrisma.cI.update.mock.calls.filter(
      (args: any[]) => args[0]?.where?.id === 'ci-olvm-owned-1',
    );
    expect(updateCallsForOlvmCi).toHaveLength(0);
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

describe('runVCenterSync — error sanitization (per-VM failure)', () => {
  it('records a generic message in errorDetails, never the raw thrown error message', async () => {
    const rawMessage = 'P2002 Unique constraint failed on the fields: (`api_slug`)';
    const fakePrisma = makeFakePrisma({
      cI: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockRejectedValue(new Error(rawMessage)),
        update: jest.fn().mockResolvedValue({ id: 'ci-updated-1' }),
        findMany: jest.fn().mockResolvedValue([]),
      },
    });

    const result = await runVCenterSync({
      prisma: fakePrisma,
      connector: makeFakeConnector([vm()]),
      defaults: DEFAULTS,
      queueForIndexing: jest.fn(),
      userEmail: 'admin@test.local',
    });

    expect(result.errors).toBe(1);
    expect(result.errorDetails).toBeDefined();
    expect(result.errorDetails![0].moref).toBe('vm-1');
    expect(result.errorDetails![0].message).not.toContain('P2002');
    expect(result.errorDetails![0].message).not.toContain(rawMessage);
    expect(result.errorDetails![0].message).toBe('Failed to sync this VM — see server logs for details');
  });
});

describe('runVCenterSync — catastrophic failure still produces an audit row', () => {
  it('inserts a SYNC_VCENTER audit row and re-throws the original error when discover() rejects', async () => {
    const originalError = new Error('vCenter unreachable: ECONNREFUSED');
    const failingConnector: IHypervisorConnector = {
      connect: jest.fn().mockResolvedValue(undefined),
      discover: jest.fn().mockRejectedValue(originalError),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const fakePrisma = makeFakePrisma();

    await expect(
      runVCenterSync({
        prisma: fakePrisma,
        connector: failingConnector,
        defaults: DEFAULTS,
        queueForIndexing: jest.fn(),
        userEmail: 'admin@test.local',
      }),
    ).rejects.toBe(originalError);

    const syncAuditCall = fakePrisma.$executeRaw.mock.calls.find((args: any[]) =>
      args.some((a: any) => typeof a === 'string' && a === 'SYNC_VCENTER'),
    );
    expect(syncAuditCall).toBeDefined();

    const detailsArg = syncAuditCall.find((a: any) => {
      if (typeof a !== 'string') return false;
      try {
        const parsed = JSON.parse(a);
        return typeof parsed === 'object' && 'status' in parsed;
      } catch {
        return false;
      }
    });
    expect(detailsArg).toBeDefined();
    const details = JSON.parse(detailsArg);
    expect(details.status).toBe('ERROR');
    expect(details.errorDetails.some((d: any) =>
      typeof d.message === 'string' && d.message.includes('Sync run failed before completion'),
    )).toBe(true);
    // never leaks the raw connection error message into the audited details
    expect(JSON.stringify(details)).not.toContain('ECONNREFUSED');

    // the connector's close() must still be called (finally block runs regardless)
    expect(failingConnector.close).toHaveBeenCalledTimes(1);
  });

  it('inserts a SYNC_VCENTER ERROR audit row and rejects when the VMWARE hypervisor row is missing', async () => {
    const fakePrisma = makeFakePrisma({
      hypervisor: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    });
    const connector = makeFakeConnector([vm()]);

    await expect(
      runVCenterSync({
        prisma: fakePrisma,
        connector,
        defaults: DEFAULTS,
        queueForIndexing: jest.fn(),
        userEmail: 'admin@test.local',
      }),
    ).rejects.toThrow(/Hypervisor/);

    // connect()/discover() must never even be attempted — the hypervisor lookup happens first
    expect(connector.connect).not.toHaveBeenCalled();
    expect(connector.discover).not.toHaveBeenCalled();

    const syncAuditCall = fakePrisma.$executeRaw.mock.calls.find((args: any[]) =>
      args.some((a: any) => typeof a === 'string' && a === 'SYNC_VCENTER'),
    );
    expect(syncAuditCall).toBeDefined();
    const detailsArg = syncAuditCall.find((a: any) => {
      if (typeof a !== 'string') return false;
      try {
        const parsed = JSON.parse(a);
        return typeof parsed === 'object' && 'status' in parsed;
      } catch {
        return false;
      }
    });
    const details = JSON.parse(detailsArg);
    expect(details.status).toBe('ERROR');
  });
});

// ── Task H2 — best-effort HOSTS relation to the ESXi host's physical-server CI ──

describe('runVCenterSync — HOSTS relation (Task H2)', () => {
  it('esxiHost set, exactly one matching PHYSICAL_SERVER CI found — creates the HOSTS relation', async () => {
    const fakePrisma = makeFakePrisma({
      cI: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'ci-new-1' }),
        update: jest.fn(),
        findMany: jest
          .fn()
          .mockResolvedValueOnce([]) // H1 adoption-candidates query (no match)
          .mockResolvedValueOnce([{ id: 'ci-physical-host-1' }]) // H2 host-CI lookup (exactly one)
          .mockResolvedValueOnce([]), // G4 retire query
      },
    });

    const result = await runVCenterSync({
      prisma: fakePrisma,
      connector: makeFakeConnector([vm({ esxiHost: 'esxi01.midominio.local' })]),
      defaults: DEFAULTS,
      queueForIndexing: jest.fn(),
      userEmail: 'admin@test.local',
    });

    expect(result.created).toBe(1);
    expect(result.errors).toBe(0);
    expect(fakePrisma.cI.findMany).toHaveBeenCalledTimes(3);

    const hostLookupArgs = fakePrisma.cI.findMany.mock.calls[1][0];
    expect(hostLookupArgs).toMatchObject({
      where: {
        ciTypeDef: { code: 'PHYSICAL_SERVER' },
        status: { not: 'RETIRADO' },
        OR: [
          { name: { equals: 'esxi01.midominio.local', mode: 'insensitive' } },
          { hostName: { equals: 'esxi01.midominio.local', mode: 'insensitive' } },
        ],
      },
    });

    expect(fakePrisma.cIRelation.upsert).toHaveBeenCalledTimes(1);
    const upsertArgs = fakePrisma.cIRelation.upsert.mock.calls[0][0];
    expect(upsertArgs.create).toMatchObject({
      sourceCiId: 'ci-physical-host-1',
      targetCiId: 'ci-new-1',
      relationType: 'HOSTS',
      createdBy: 'admin@test.local',
    });
    expect(upsertArgs.where).toEqual({
      sourceCiId_targetCiId_relationType: {
        sourceCiId: 'ci-physical-host-1',
        targetCiId: 'ci-new-1',
        relationType: 'HOSTS',
      },
    });
  });

  it('esxiHost set, zero matching physical-server CIs — no relation created, CI sync still succeeds', async () => {
    const fakePrisma = makeFakePrisma({
      cI: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'ci-new-1' }),
        update: jest.fn(),
        findMany: jest
          .fn()
          .mockResolvedValueOnce([]) // adoption-candidates
          .mockResolvedValueOnce([]) // host-CI lookup: no match
          .mockResolvedValueOnce([]), // retire
      },
    });

    const result = await runVCenterSync({
      prisma: fakePrisma,
      connector: makeFakeConnector([vm({ esxiHost: 'esxi-nowhere' })]),
      defaults: DEFAULTS,
      queueForIndexing: jest.fn(),
      userEmail: 'admin@test.local',
    });

    expect(result.created).toBe(1);
    expect(result.errors).toBe(0);
    expect(fakePrisma.cIRelation.upsert).not.toHaveBeenCalled();
  });

  it('esxiHost set, TWO+ matching physical-server CIs (ambiguous) — no relation created, CI sync still succeeds', async () => {
    const fakePrisma = makeFakePrisma({
      cI: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'ci-new-1' }),
        update: jest.fn(),
        findMany: jest
          .fn()
          .mockResolvedValueOnce([]) // adoption-candidates
          .mockResolvedValueOnce([{ id: 'host-a' }, { id: 'host-b' }]) // host-CI lookup: ambiguous
          .mockResolvedValueOnce([]), // retire
      },
    });

    const result = await runVCenterSync({
      prisma: fakePrisma,
      connector: makeFakeConnector([vm({ esxiHost: 'esxi-dup' })]),
      defaults: DEFAULTS,
      queueForIndexing: jest.fn(),
      userEmail: 'admin@test.local',
    });

    expect(result.created).toBe(1);
    expect(result.errors).toBe(0);
    expect(fakePrisma.cIRelation.upsert).not.toHaveBeenCalled();
  });

  it('esxiHost === null — the host-relation step is skipped entirely (no extra findMany call)', async () => {
    const fakePrisma = makeFakePrisma({
      cI: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'ci-new-1' }),
        update: jest.fn(),
        findMany: jest
          .fn()
          .mockResolvedValueOnce([]) // adoption-candidates
          .mockResolvedValueOnce([]), // retire — only 2 calls total, no host lookup
      },
    });

    const result = await runVCenterSync({
      prisma: fakePrisma,
      connector: makeFakeConnector([vm({ esxiHost: null })]),
      defaults: DEFAULTS,
      queueForIndexing: jest.fn(),
      userEmail: 'admin@test.local',
    });

    expect(result.created).toBe(1);
    expect(fakePrisma.cI.findMany).toHaveBeenCalledTimes(2);
    expect(fakePrisma.cIRelation.upsert).not.toHaveBeenCalled();
  });

  it('the relation step throwing an error does NOT affect the VM own sync result (isolated by its own try/catch)', async () => {
    const fakePrisma = makeFakePrisma({
      cI: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'ci-new-1' }),
        update: jest.fn(),
        findMany: jest
          .fn()
          .mockResolvedValueOnce([]) // adoption-candidates
          .mockRejectedValueOnce(new Error('boom: host lookup DB error')) // host-CI lookup throws
          .mockResolvedValueOnce([]), // retire
      },
    });

    const result = await runVCenterSync({
      prisma: fakePrisma,
      connector: makeFakeConnector([vm({ esxiHost: 'esxi-broken' })]),
      defaults: DEFAULTS,
      queueForIndexing: jest.fn(),
      userEmail: 'admin@test.local',
    });

    // The VM's own CI create must still succeed — the host-relation failure must never be
    // counted against errors/errorDetails.
    expect(result.created).toBe(1);
    expect(result.errors).toBe(0);
    expect(result.errorDetails).toBeUndefined();
    expect(fakePrisma.cIRelation.upsert).not.toHaveBeenCalled();
  });
});

// ── Combined coverage: H1 adoption + H2 HOSTS relation in the SAME sync run ─────
// Every H2 test above mocks the H1 adoption-candidates query to resolve `[]` (no adoption
// happens), and every H1 adoption test has `esxiHost: null` (no host-relation step runs).
// The composition is correct by code inspection (vcenterService.ts sets `ciId` from either
// the create or the update branch before the H2 block runs, unconditionally on that same
// `ciId`), but nothing proves it end-to-end. This test exercises both in one call.

describe('runVCenterSync — H1 adoption + H2 host relation combined (regression)', () => {
  it('adopts a pre-existing CI by name AND creates the HOSTS relation against that SAME adopted CI', async () => {
    const fakePrisma = makeFakePrisma({
      cI: {
        findUnique: jest.fn().mockResolvedValue(null), // no apiSlug match
        create: jest.fn().mockResolvedValue({ id: 'ci-new-1' }), // must NOT be used — adoption wins
        update: jest.fn().mockResolvedValue({ id: 'ci-manual-adopt-1' }),
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ id: 'ci-manual-adopt-1' }]) // H1: exactly one name-match candidate
          .mockResolvedValueOnce([{ id: 'ci-physical-host-1' }]) // H2: exactly one matching PHYSICAL_SERVER
          .mockResolvedValueOnce([]), // G4: retire query
      },
    });

    const result = await runVCenterSync({
      prisma: fakePrisma,
      connector: makeFakeConnector([vm({ esxiHost: 'esxi01.midominio.local' })]),
      defaults: DEFAULTS,
      queueForIndexing: jest.fn(),
      userEmail: 'admin@test.local',
    });

    expect(result.created).toBe(0);
    expect(result.updated).toBe(1);
    expect(result.errors).toBe(0);
    expect(fakePrisma.cI.create).not.toHaveBeenCalled();
    expect(fakePrisma.cI.findMany).toHaveBeenCalledTimes(3);

    // 1) The adoption update targets the adopted CI's id and sets apiSlug + hypervisorId
    //    alongside the normal physical fields.
    expect(fakePrisma.cI.update).toHaveBeenCalledTimes(1);
    const updateArgs = fakePrisma.cI.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 'ci-manual-adopt-1' });
    expect(updateArgs.data).toMatchObject({
      apiSlug: 'vm-vm-1',
      hypervisorId: VMWARE_HYPERVISOR.id,
      vCpus: 4,
      ram: '8 GB',
      adminIp: '10.0.0.1',
      hostName: 'test-vm.local',
    });

    // 2) The HOSTS relation is created against the SAME adopted CI id (not a fresh/created one).
    expect(fakePrisma.cIRelation.upsert).toHaveBeenCalledTimes(1);
    const upsertArgs = fakePrisma.cIRelation.upsert.mock.calls[0][0];
    expect(upsertArgs.create).toMatchObject({
      sourceCiId: 'ci-physical-host-1',
      targetCiId: 'ci-manual-adopt-1',
      relationType: 'HOSTS',
      createdBy: 'admin@test.local',
    });
    expect(upsertArgs.where).toEqual({
      sourceCiId_targetCiId_relationType: {
        sourceCiId: 'ci-physical-host-1',
        targetCiId: 'ci-manual-adopt-1',
        relationType: 'HOSTS',
      },
    });
  });
});
