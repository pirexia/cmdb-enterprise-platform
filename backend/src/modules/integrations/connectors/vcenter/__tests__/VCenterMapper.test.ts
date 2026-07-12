import { toCI } from '../VCenterMapper.js';
import type { DiscoveredVM, SyncDefaults } from '../../types.js';

const defaults: SyncDefaults = {
  ciTypeCode: 'VIRTUAL_SERVER',
  environment: 'PRODUCTION',
  criticality: 'MEDIUM',
};

function baseVM(overrides: Partial<DiscoveredVM> = {}): DiscoveredVM {
  return {
    moref: 'vm-1234',
    name: 'app-server-01',
    powerState: 'POWERED_ON',
    cpuCount: 4,
    memoryMiB: 8192,
    guestOS: 'RHEL_9_64',
    guestFamily: 'LINUX',
    ipAddress: '10.0.0.5',
    hostName: 'app-server-01.example.com',
    cluster: 'Cluster-A',
    esxiHost: 'esxi-01.example.com',
    ...overrides,
  };
}

describe('VCenterMapper.toCI', () => {
  it('1. maps a powered-on VM with full guest identity to a full MappedVM', () => {
    const vm = baseVM();
    const result = toCI(vm, defaults);

    expect(result.createFields).toEqual({
      apiSlug: 'vm-vm-1234',
      name: 'app-server-01',
      status: 'ACTIVO',
      criticality: 'MEDIUM',
      environment: 'PRODUCTION',
      ciTypeCode: 'VIRTUAL_SERVER',
    });

    expect(result.physicalFields.vCpus).toBe(4);
    expect(result.physicalFields.ram).toBe('8 GB');
    expect(result.physicalFields.adminIp).toBe('10.0.0.5');
    expect(result.physicalFields.hostName).toBe('app-server-01.example.com');
    expect(result.physicalFields.clusterName).toBe('Cluster-A');
    expect(result.physicalFields.vcenterSync.moref).toBe('vm-1234');
    expect(result.physicalFields.vcenterSync.powerState).toBe('POWERED_ON');
    expect(result.physicalFields.vcenterSync.esxiHost).toBe('esxi-01.example.com');
    expect(result.physicalFields.vcenterSync.cluster).toBe('Cluster-A');
    expect(typeof result.physicalFields.vcenterSync.lastSyncAt).toBe('string');
    expect(() => new Date(result.physicalFields.vcenterSync.lastSyncAt).toISOString()).not.toThrow();

    expect(result.osHint).toEqual({
      code: 'RHEL_9_64',
      name: 'Rhel 9 64',
      family: 'LINUX',
    });
  });

  it('2. powered-off VM: vcenterSync reflects it, but createFields.status is still ACTIVO (D2)', () => {
    const vm = baseVM({ powerState: 'POWERED_OFF' });
    const result = toCI(vm, defaults);

    expect(result.physicalFields.vcenterSync.powerState).toBe('POWERED_OFF');
    expect(result.createFields.status).toBe('ACTIVO');
  });

  it('3. missing guest identity (VMware Tools not running) → null fields, no throw', () => {
    const vm = baseVM({ ipAddress: null, hostName: null });
    expect(() => toCI(vm, defaults)).not.toThrow();
    const result = toCI(vm, defaults);
    expect(result.physicalFields.adminIp).toBeNull();
    expect(result.physicalFields.hostName).toBeNull();
  });

  it('4. guestOS null and guestFamily null → osHint is null', () => {
    const vm = baseVM({ guestOS: null, guestFamily: null });
    const result = toCI(vm, defaults);
    expect(result.osHint).toBeNull();
  });

  it('5. guestOS null, guestFamily WINDOWS → osHint falls back to family', () => {
    const vm = baseVM({ guestOS: null, guestFamily: 'WINDOWS' });
    const result = toCI(vm, defaults);
    expect(result.osHint).toEqual({
      code: 'WINDOWS',
      name: 'WINDOWS',
      family: 'WINDOWS',
    });
  });

  it('6. memoryMiB null → ram is null (no division-by-null crash)', () => {
    const vm = baseVM({ memoryMiB: null });
    expect(() => toCI(vm, defaults)).not.toThrow();
    const result = toCI(vm, defaults);
    expect(result.physicalFields.ram).toBeNull();
  });

  it('7. memoryMiB 8192 → ram is "8 GB"', () => {
    const vm = baseVM({ memoryMiB: 8192 });
    const result = toCI(vm, defaults);
    expect(result.physicalFields.ram).toBe('8 GB');
  });
});
