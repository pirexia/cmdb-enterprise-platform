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

      // Best-effort ESXi host resolution. `summary.host` (a MoRef) and the shape of
      // GET /api/vcenter/host/{host} (Host.Info's `name` field) come from general
      // knowledge of the vSphere Automation REST API and are NOT independently
      // verified against a live vCenter in this session (no live vCenter/API
      // reference available here — see task report). ANY failure here — missing
      // `summary.host`, a thrown error, a null result, or a missing `.name` — must
      // fall back to today's behavior (`esxiHost: null`) and must NEVER abort
      // discovery of this VM's other fields or the rest of the VM list.
      let esxiHost: string | null = null;
      if (summary.host) {
        try {
          const hostSummary = await this.client.hostSummary(summary.host);
          if (hostSummary?.name) {
            esxiHost = hostSummary.name;
          }
        } catch (e) {
          console.warn(
            `[VCenterConnector] Could not resolve ESXi host name for VM moref=${summary.vm}, host=${summary.host}:`,
            e,
          );
        }
      }

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
