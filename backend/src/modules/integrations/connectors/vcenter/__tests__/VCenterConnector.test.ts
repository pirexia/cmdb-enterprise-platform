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
