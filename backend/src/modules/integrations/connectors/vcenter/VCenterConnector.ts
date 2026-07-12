// Orchestrates VCenterClient calls into normalized DiscoveredVM[]. This is the
// glue layer only — field mapping to CI shapes is VCenterMapper's job (Task C),
// not this connector's.

import { BaseConnector } from '../base/BaseConnector.js';
import type { DiscoveredVM, PowerState, SyncDefaults } from '../types.js';
import type { VCenterClient } from './VCenterClient.js';

function normalizePowerState(raw: string): PowerState {
  if (raw === 'POWERED_ON' || raw === 'POWERED_OFF' || raw === 'SUSPENDED') {
    return raw;
  }
  // Unrecognized value from the API — fail safe rather than throw.
  return 'POWERED_OFF';
}

export class VCenterConnector extends BaseConnector {
  private readonly client: VCenterClient;
  // Retained for parity with other connectors that need defaults during discover();
  // vCenter's discover() itself does not currently need them (mapping happens in
  // VCenterMapper), but keeping the constructor shape stable for Task C's DI.
  private readonly defaults: SyncDefaults;

  constructor(client: VCenterClient, defaults: SyncDefaults) {
    super();
    this.client = client;
    this.defaults = defaults;
  }

  async connect(): Promise<void> {
    await this.client.session();
  }

  async discover(): Promise<DiscoveredVM[]> {
    const summaries = await this.client.listVMs();
    const results: DiscoveredVM[] = [];

    for (const summary of summaries) {
      const [identity, detail] = await Promise.all([
        this.client.vmGuestIdentity(summary.vm),
        this.client.vmDetail(summary.vm),
      ]);

      results.push({
        moref: summary.vm,
        name: summary.name,
        powerState: normalizePowerState(summary.power_state),
        cpuCount: detail.hardware?.cpu?.count ?? summary.cpu_count ?? null,
        memoryMiB: detail.hardware?.memory?.size_MiB ?? summary.memory_size_MiB ?? null,
        guestOS: detail.guest_OS ?? null,
        guestFamily: identity?.family ?? null,
        ipAddress: identity?.ip_address ?? null,
        hostName: identity?.host_name ?? null,
        // Not directly exposed by /api/vcenter/vm/{vm} or the guest identity endpoint
        // in the vSphere Automation REST API — resolving these requires additional
        // calls (e.g. /api/vcenter/vm/{vm} host summary + /api/vcenter/cluster
        // cross-reference) that are out of scope for this connector-core task.
        // Left null; flagged in the task report as best-effort per the plan.
        cluster: null,
        esxiHost: null,
      });
    }

    return results;
  }

  async close(): Promise<void> {
    await this.client.logout();
  }
}
