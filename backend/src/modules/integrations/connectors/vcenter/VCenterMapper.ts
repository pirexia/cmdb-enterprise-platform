// Pure mapping function: DiscoveredVM (raw vCenter facts) -> MappedVM (CI field shapes).
// No I/O, no DB access, no side effects. Task C's service consumes this output to
// create/update CI rows; the OS upsert itself is out of scope here (see OsHint doc).

import type { DiscoveredVM, MappedVM, OsHint, SyncDefaults } from '../types.js';

function humanize(code: string): string {
  return code
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function normalizeFamily(value: string | null): 'LINUX' | 'WINDOWS' | 'OTHER' {
  if (!value) return 'OTHER';
  const lower = value.toLowerCase();
  if (lower.includes('linux')) return 'LINUX';
  if (lower.includes('windows')) return 'WINDOWS';
  return 'OTHER';
}

function familyFromGuestOS(guestOS: string, guestFamily: string | null): 'LINUX' | 'WINDOWS' | 'OTHER' {
  // Prefer the explicit guestFamily signal when present; fall back to sniffing the code itself.
  if (guestFamily) return normalizeFamily(guestFamily);
  return normalizeFamily(guestOS);
}

function resolveOsHint(vm: DiscoveredVM): OsHint | null {
  if (vm.guestOS) {
    return {
      code: vm.guestOS,
      name: humanize(vm.guestOS),
      family: familyFromGuestOS(vm.guestOS, vm.guestFamily),
    };
  }
  if (vm.guestFamily) {
    return {
      code: vm.guestFamily,
      name: vm.guestFamily,
      family: normalizeFamily(vm.guestFamily),
    };
  }
  return null;
}

export function toCI(vm: DiscoveredVM, defaults: SyncDefaults): MappedVM {
  const ram = vm.memoryMiB === null ? null : `${Math.round(vm.memoryMiB / 1024)} GB`;

  return {
    createFields: {
      apiSlug: `vm-${vm.moref}`,
      name: vm.name,
      status: 'ACTIVO',
      criticality: defaults.criticality,
      environment: defaults.environment,
      ciTypeCode: defaults.ciTypeCode,
    },
    physicalFields: {
      vCpus: vm.cpuCount,
      ram,
      adminIp: vm.ipAddress,
      hostName: vm.hostName,
      clusterName: vm.cluster,
      powerState: vm.powerState,
    },
    osHint: resolveOsHint(vm),
  };
}
