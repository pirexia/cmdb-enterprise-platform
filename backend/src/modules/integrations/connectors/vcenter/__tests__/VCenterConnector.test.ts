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

// Fake client with safe defaults for every method discover() touches. By default the
// ESXi-host reverse mapping resolves to nothing (no hosts) so esxiHost is null unless a
// test opts in via listHosts/listVmIdsOnHost overrides.
function makeFakeClient(overrides: Record<string, unknown> = {}): VCenterClient {
  return {
    session: jest.fn().mockResolvedValue(undefined),
    listVMs: jest.fn().mockResolvedValue([baseSummary()]),
    vmGuestIdentity: jest.fn().mockResolvedValue(null),
    vmDetail: jest.fn().mockResolvedValue({}),
    listHosts: jest.fn().mockResolvedValue([]),
    listVmIdsOnHost: jest.fn().mockResolvedValue([]),
    logout: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as VCenterClient;
}

describe('VCenterConnector.discover()', () => {
  it('degrades gracefully instead of throwing when vmDetail() resolves an empty object (empty HTTP body)', async () => {
    const fakeClient = makeFakeClient();
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
    const fakeClient = makeFakeClient({
      listVMs: jest.fn().mockResolvedValue([baseSummary({ cpu_count: undefined, memory_size_MiB: undefined })]),
    });
    const connector = new VCenterConnector(fakeClient, defaults);
    const result = await connector.discover();

    expect(result[0].cpuCount).toBeNull();
    expect(result[0].memoryMiB).toBeNull();
  });

  it('does NOT abort the whole run when one VM guest-identity/detail call rejects — that VM degrades to summary-only, the rest are still discovered', async () => {
    // Regression for the live 500: a single VM returning 503 on guest/identity was
    // rejecting Promise.all and aborting discover() entirely. Now each per-VM call
    // degrades independently and the batch completes.
    const vmGuestIdentity = jest.fn()
      .mockRejectedValueOnce(new Error('vCenter vmGuestIdentity failed with status 503')) // vm-1
      .mockResolvedValueOnce({ ip_address: '10.0.0.2', host_name: 'good.local', family: 'LINUX' }); // vm-2
    const fakeClient = makeFakeClient({
      listVMs: jest.fn().mockResolvedValue([
        baseSummary({ vm: 'vm-1', name: 'tools-less-vm' }),
        baseSummary({ vm: 'vm-2', name: 'healthy-vm' }),
      ]),
      vmGuestIdentity,
      vmDetail: jest.fn().mockResolvedValue({ hardware: { cpu: { count: 4 }, memory: { size_MiB: 8192 } } }),
    });

    const connector = new VCenterConnector(fakeClient, defaults);
    const result = await connector.discover();

    expect(result).toHaveLength(2);
    // vm-1: guest identity failed → degraded to null ip/hostname, but still discovered
    expect(result[0].moref).toBe('vm-1');
    expect(result[0].ipAddress).toBeNull();
    expect(result[0].hostName).toBeNull();
    expect(result[0].cpuCount).toBe(4); // detail still succeeded for vm-1
    // vm-2: fully enriched, unaffected by vm-1's failure
    expect(result[1].moref).toBe('vm-2');
    expect(result[1].ipAddress).toBe('10.0.0.2');
    expect(result[1].hostName).toBe('good.local');
  });
});

// ── Task H2 (reworked) — ESXi host resolution via reverse mapping ─────────────
//
// Verified against a live vCenter (8.x): the VM summary/detail does NOT expose the
// running host, so we resolve it in reverse — list hosts (GET /api/vcenter/host),
// then list the VMs on each host (GET /api/vcenter/vm?hosts={host}) — and attach the
// host name per VM. Fully best-effort: any failure degrades to esxiHost: null and
// never aborts discovery.

describe('VCenterConnector.discover() — ESXi host resolution (reverse mapping)', () => {
  it('resolves esxiHost from the host→VMs reverse map', async () => {
    const fakeClient = makeFakeClient({
      listVMs: jest.fn().mockResolvedValue([
        baseSummary({ vm: 'vm-1', name: 'on-host-a' }),
        baseSummary({ vm: 'vm-2', name: 'on-host-b' }),
        baseSummary({ vm: 'vm-3', name: 'unplaced' }),
      ]),
      listHosts: jest.fn().mockResolvedValue([
        { host: 'host-a', name: 'esx-01.dom.local' },
        { host: 'host-b', name: 'esx-02.dom.local' },
      ]),
      listVmIdsOnHost: jest.fn(async (hostId: string) =>
        hostId === 'host-a' ? ['vm-1'] : hostId === 'host-b' ? ['vm-2'] : [],
      ),
    });

    const connector = new VCenterConnector(fakeClient, defaults);
    const result = await connector.discover();

    expect(result.find((v) => v.moref === 'vm-1')!.esxiHost).toBe('esx-01.dom.local');
    expect(result.find((v) => v.moref === 'vm-2')!.esxiHost).toBe('esx-02.dom.local');
    // vm-3 isn't on any host's VM list → null
    expect(result.find((v) => v.moref === 'vm-3')!.esxiHost).toBeNull();
  });

  it('degrades to esxiHost: null for all VMs (never throws) when listHosts() rejects', async () => {
    const fakeClient = makeFakeClient({
      listVMs: jest.fn().mockResolvedValue([baseSummary({ vm: 'vm-1' })]),
      listHosts: jest.fn().mockRejectedValue(new Error('vCenter listHosts failed with status 500')),
    });

    const connector = new VCenterConnector(fakeClient, defaults);
    let result;
    await expect((async () => { result = await connector.discover(); })()).resolves.not.toThrow();
    expect(result![0].esxiHost).toBeNull();
    expect(result![0].name).toBe('app-server-01'); // rest of the VM unaffected
  });

  it('one host failing to list its VMs does not abort — its VMs get null, other hosts still resolve', async () => {
    const fakeClient = makeFakeClient({
      listVMs: jest.fn().mockResolvedValue([
        baseSummary({ vm: 'vm-good', name: 'on-good-host' }),
        baseSummary({ vm: 'vm-bad', name: 'on-bad-host' }),
      ]),
      listHosts: jest.fn().mockResolvedValue([
        { host: 'host-good', name: 'esx-good.local' },
        { host: 'host-bad', name: 'esx-bad.local' },
      ]),
      listVmIdsOnHost: jest.fn(async (hostId: string) => {
        if (hostId === 'host-bad') throw new Error('boom');
        return ['vm-good'];
      }),
    });

    const connector = new VCenterConnector(fakeClient, defaults);
    const result = await connector.discover();

    expect(result.find((v) => v.moref === 'vm-good')!.esxiHost).toBe('esx-good.local');
    expect(result.find((v) => v.moref === 'vm-bad')!.esxiHost).toBeNull();
  });

  it('skips host entries with no name', async () => {
    const fakeClient = makeFakeClient({
      listVMs: jest.fn().mockResolvedValue([baseSummary({ vm: 'vm-1' })]),
      listHosts: jest.fn().mockResolvedValue([{ host: 'host-x' }]), // no name
      listVmIdsOnHost: jest.fn().mockResolvedValue(['vm-1']),
    });

    const connector = new VCenterConnector(fakeClient, defaults);
    const result = await connector.discover();

    expect(result[0].esxiHost).toBeNull();
    expect(fakeClient.listVmIdsOnHost).not.toHaveBeenCalled(); // skipped before listing
  });
});
