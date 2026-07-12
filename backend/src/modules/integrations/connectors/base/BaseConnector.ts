// Common base for hypervisor connectors (vCenter today; OLVM / Solaris zones future
// candidates). Scaffold only — no shared logic yet, so no speculative behavior is
// baked in before a second connector exists to prove it out.

import type { IHypervisorConnector, DiscoveredVM } from '../types.js';

export abstract class BaseConnector implements IHypervisorConnector {
  abstract connect(): Promise<void>;
  abstract discover(): Promise<DiscoveredVM[]>;
  abstract close(): Promise<void>;
}
