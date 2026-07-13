import { VCenterConnector } from '../VCenterConnector.js';
import type { VCenterClient, VCenterVmSummary } from '../VCenterClient.js';
import type { SyncDefaults } from '../../types.js';

const defaults: SyncDefaults = {
  ciTypeCode: 'VIRTUAL_SERVER',
  environment: 'PRODUCTION',
  criticality: 'MEDIUM',
};

function baseSummary(overrides: Partial<VCenterVmSummary> = {}): VCenterVmSummary {
  return {
    vm: 'vm-1234',
    name: 'app-server-01',
    power_state: 'POWERED_ON',
    cpu_count: 4,
    memory_size_MiB: 8192,
    ...overrides,
  };
}

describe('VCenterConnector.discover()', () => {
  it('degrades gracefully instead of throwing when vmDetail() resolves an empty object (empty HTTP body)', async () => {
    // Mirrors what VCenterClient.vmDetail() now returns for a 2xx response with no
    // body (parseJson's `undefined` guarded by `|| {}`) — discover() must not throw
    // when `.hardware` is entirely absent from the detail object.
    const fakeClient = {
      session: jest.fn().mockResolvedValue(undefined),
      listVMs: jest.fn().mockResolvedValue([baseSummary()]),
      vmGuestIdentity: jest.fn().mockResolvedValue(null),
      vmDetail: jest.fn().mockResolvedValue({}),
      logout: jest.fn().mockResolvedValue(undefined),
    } as unknown as VCenterClient;

    const connector = new VCenterConnector(fakeClient, defaults);

    let result;
    await expect((async () => {
      result = await connector.discover();
    })()).resolves.not.toThrow();

    expect(result).toEqual([
      {
        moref: 'vm-1234',
        name: 'app-server-01',
        powerState: 'POWERED_ON',
        cpuCount: 4, // falls back to summary.cpu_count since detail.hardware is absent
        memoryMiB: 8192, // falls back to summary.memory_size_MiB
        guestOS: null,
        guestFamily: null,
        ipAddress: null,
        hostName: null,
        cluster: null,
        esxiHost: null,
      },
    ]);
  });

  it('produces null cpuCount/memoryMiB when both detail.hardware and the summary fallback are absent', async () => {
    const fakeClient = {
      session: jest.fn().mockResolvedValue(undefined),
      listVMs: jest.fn().mockResolvedValue([
        baseSummary({ cpu_count: undefined, memory_size_MiB: undefined }),
      ]),
      vmGuestIdentity: jest.fn().mockResolvedValue(null),
      vmDetail: jest.fn().mockResolvedValue({}),
      logout: jest.fn().mockResolvedValue(undefined),
    } as unknown as VCenterClient;

    const connector = new VCenterConnector(fakeClient, defaults);
    const result = await connector.discover();

    expect(result[0].cpuCount).toBeNull();
    expect(result[0].memoryMiB).toBeNull();
  });
});

// ── Task H2 — best-effort ESXi host resolution ───────────────────────────────
//
// IMPORTANT: `summary.host` (a MoRef) and Host.Info's `name` field are NOT
// independently verified against a live vCenter in this session (see VCenterClient.ts
// and the task report). These tests only verify OUR defensive handling degrades
// safely — they do not and cannot verify the real vSphere API shape.

describe('VCenterConnector.discover() — ESXi host resolution (Task H2, defensive)', () => {
  it('resolves esxiHost from hostSummary().name when summary.host is present', async () => {
    const fakeClient = {
      session: jest.fn().mockResolvedValue(undefined),
      listVMs: jest.fn().mockResolvedValue([baseSummary({ host: 'host-21' })]),
      vmGuestIdentity: jest.fn().mockResolvedValue(null),
      vmDetail: jest.fn().mockResolvedValue({}),
      hostSummary: jest.fn().mockResolvedValue({ name: 'esxi01.midominio.local' }),
      logout: jest.fn().mockResolvedValue(undefined),
    } as unknown as VCenterClient;

    const connector = new VCenterConnector(fakeClient, defaults);
    const result = await connector.discover();

    expect(fakeClient.hostSummary).toHaveBeenCalledWith('host-21');
    expect(result[0].esxiHost).toBe('esxi01.midominio.local');
    expect(result[0].cluster).toBeNull();
  });

  it('falls back to esxiHost: null when summary.host is absent (hostSummary never called)', async () => {
    const fakeClient = {
      session: jest.fn().mockResolvedValue(undefined),
      listVMs: jest.fn().mockResolvedValue([baseSummary()]), // no `host` field
      vmGuestIdentity: jest.fn().mockResolvedValue(null),
      vmDetail: jest.fn().mockResolvedValue({}),
      hostSummary: jest.fn(),
      logout: jest.fn().mockResolvedValue(undefined),
    } as unknown as VCenterClient;

    const connector = new VCenterConnector(fakeClient, defaults);
    const result = await connector.discover();

    expect(fakeClient.hostSummary).not.toHaveBeenCalled();
    expect(result[0].esxiHost).toBeNull();
  });

  it('falls back to esxiHost: null when hostSummary() resolves null (e.g. 404)', async () => {
    const fakeClient = {
      session: jest.fn().mockResolvedValue(undefined),
      listVMs: jest.fn().mockResolvedValue([baseSummary({ host: 'host-99' })]),
      vmGuestIdentity: jest.fn().mockResolvedValue(null),
      vmDetail: jest.fn().mockResolvedValue({}),
      hostSummary: jest.fn().mockResolvedValue(null),
      logout: jest.fn().mockResolvedValue(undefined),
    } as unknown as VCenterClient;

    const connector = new VCenterConnector(fakeClient, defaults);
    const result = await connector.discover();

    expect(result[0].esxiHost).toBeNull();
  });

  it('falls back to esxiHost: null when hostSummary() resolves an object with no name', async () => {
    const fakeClient = {
      session: jest.fn().mockResolvedValue(undefined),
      listVMs: jest.fn().mockResolvedValue([baseSummary({ host: 'host-99' })]),
      vmGuestIdentity: jest.fn().mockResolvedValue(null),
      vmDetail: jest.fn().mockResolvedValue({}),
      hostSummary: jest.fn().mockResolvedValue({}),
      logout: jest.fn().mockResolvedValue(undefined),
    } as unknown as VCenterClient;

    const connector = new VCenterConnector(fakeClient, defaults);
    const result = await connector.discover();

    expect(result[0].esxiHost).toBeNull();
  });

  it('degrades gracefully to esxiHost: null (never throws, never aborts discover()) when hostSummary() rejects', async () => {
    const fakeClient = {
      session: jest.fn().mockResolvedValue(undefined),
      listVMs: jest.fn().mockResolvedValue([baseSummary({ host: 'host-21' })]),
      vmGuestIdentity: jest.fn().mockResolvedValue(null),
      vmDetail: jest.fn().mockResolvedValue({}),
      hostSummary: jest.fn().mockRejectedValue(new Error('vCenter hostSummary failed with status 500')),
      logout: jest.fn().mockResolvedValue(undefined),
    } as unknown as VCenterClient;

    const connector = new VCenterConnector(fakeClient, defaults);

    let result;
    await expect((async () => {
      result = await connector.discover();
    })()).resolves.not.toThrow();

    expect(result![0].esxiHost).toBeNull();
    expect(result![0].name).toBe('app-server-01'); // rest of the VM's fields unaffected
  });
});
