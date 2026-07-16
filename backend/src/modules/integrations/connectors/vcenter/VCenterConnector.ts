// Orchestrates VCenterClient calls into normalized DiscoveredVM[]. This is the
// glue layer only — field mapping to CI shapes is VCenterMapper's job (Task C),
// not this connector's.

import { BaseConnector } from '../base/BaseConnector.js';
import type { DiscoveredVM, PowerState, SyncDefaults } from '../types.js';
import type { VCenterClient, VCenterGuestIdentity, VCenterVmDetail } from './VCenterClient.js';

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

  /**
   * Builds a VM-MoRef → ESXi-host-name map. This vCenter version does not expose the
   * running host on the VM summary/detail, so we resolve it in reverse: list all hosts
   * (GET /api/vcenter/host), then list the VMs on each host (GET /api/vcenter/vm?hosts=).
   * Fully best-effort — any failure (a host that errors, or the whole host listing
   * failing) degrades to a partial/empty map so those VMs get `esxiHost: null`, and it
   * NEVER aborts discovery.
   */
  private async buildEsxiHostMap(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    let hosts;
    try {
      hosts = await this.client.listHosts();
    } catch (e) {
      console.warn('[VCenterConnector] could not list ESXi hosts; skipping host relations for this run:', e);
      return map;
    }
    for (const h of hosts) {
      if (!h.host || !h.name) continue;
      try {
        const vmIds = await this.client.listVmIdsOnHost(h.host);
        for (const vmId of vmIds) map.set(vmId, h.name);
      } catch (e) {
        console.warn(`[VCenterConnector] could not list VMs on host ${h.host} (${h.name}); those VMs get no host relation this run:`, e);
      }
    }
    return map;
  }

  async discover(): Promise<DiscoveredVM[]> {
    const summaries = await this.client.listVMs();
    // Resolve the ESXi host of each VM up front (reverse mapping — best-effort).
    const esxiHostMap = await this.buildEsxiHostMap();
    const results: DiscoveredVM[] = [];

    for (const summary of summaries) {
      // Per-VM enrichment (guest identity + hardware detail) is best-effort: a single
      // VM's failure must NEVER abort discovery of the rest of the list. Each call
      // degrades independently to a safe default (null identity / empty detail) so we
      // still sync that VM from its summary fields. vmGuestIdentity already treats the
      // common tools-not-running 404/503 as a silent null; this catch covers any other
      // unexpected per-VM failure (transient 5xx on detail, network blip, etc.).
      const identity: VCenterGuestIdentity | null = await this.client
        .vmGuestIdentity(summary.vm)
        .catch((e) => {
          console.warn(`[VCenterConnector] guest identity fetch failed for VM moref=${summary.vm}; continuing with summary-only fields:`, e);
          return null;
        });
      const detail: VCenterVmDetail = await this.client
        .vmDetail(summary.vm)
        .catch((e) => {
          console.warn(`[VCenterConnector] vm detail fetch failed for VM moref=${summary.vm}; continuing with summary-only fields:`, e);
          return {} as VCenterVmDetail;
        });

      // ESXi host from the reverse map built above (null if unresolved / VM not placed).
      const esxiHost: string | null = esxiHostMap.get(summary.vm) ?? null;

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
        // cluster resolution is explicitly out of scope for this task (Task H2) — it
        // would require an additional /api/vcenter/cluster cross-reference call.
        // Left null, same as before.
        cluster: null,
        esxiHost,
      });
    }

    return results;
  }

  async close(): Promise<void> {
    await this.client.logout();
  }
}
