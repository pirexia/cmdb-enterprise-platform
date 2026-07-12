// Shared connector-core types for hypervisor sync connectors (vCenter, and future
// OLVM/Solaris connectors). Pure type definitions — no runtime logic here.

export type PowerState = 'POWERED_ON' | 'POWERED_OFF' | 'SUSPENDED';

export interface DiscoveredVM {
  moref: string; // vCenter VM id, e.g. "vm-1234"
  name: string;
  powerState: PowerState;
  cpuCount: number | null;
  memoryMiB: number | null;
  guestOS: string | null; // raw vCenter guest_OS code, e.g. "RHEL_9_64"
  guestFamily: string | null; // 'LINUX' | 'WINDOWS' | 'OTHER' | null
  ipAddress: string | null;
  hostName: string | null;
  cluster: string | null;
  esxiHost: string | null;
}

export interface SyncDefaults {
  ciTypeCode: string; // env VCENTER_CI_TYPE, e.g. 'VIRTUAL_SERVER'
  environment: string; // env VCENTER_DEFAULT_ENVIRONMENT, e.g. 'PRODUCTION' — matches Prisma Environment enum
  criticality: string; // env VCENTER_DEFAULT_CRITICALITY, e.g. 'MEDIUM' — matches Prisma Criticality enum
}

// OS resolution is a DB upsert (OperatingSystem model) — out of scope for this pure mapper.
// The mapper only describes what OS *should* exist; Task C's service does the actual upsert+link.
export interface OsHint {
  code: string; // derived normalized code, e.g. "RHEL_9_64" (reuse guestOS verbatim if present)
  name: string; // human name, e.g. "Red Hat Enterprise Linux 9 64-bit"
  family: 'LINUX' | 'WINDOWS' | 'OTHER';
}

// vcenter_sync JSON column shape (Task A's new CI.vcenterSync field)
export interface VCenterSyncMeta {
  moref: string;
  powerState: PowerState;
  esxiHost: string | null;
  cluster: string | null;
  lastSyncAt: string; // ISO timestamp
}

// Fields the mapper sets on CREATE only (never touched again — operator-owned afterwards per D5/D2)
export interface CICreateFields {
  apiSlug: string; // `vm-${moref}`
  name: string;
  status: 'ACTIVO';
  criticality: string;
  environment: string;
  ciTypeCode: string;
}

// Fields the mapper sets on CREATE **and** every UPDATE — vCenter owns these physical facts (D5).
// NEVER includes status/criticality/environment/businessOwner/technicalLead — Task C's service
// must not touch those after creation.
export interface CIPhysicalFields {
  vCpus: number | null;
  ram: string | null; // e.g. "8 GB" — round(memoryMiB/1024), formatted
  adminIp: string | null;
  hostName: string | null;
  clusterName: string | null;
  vcenterSync: VCenterSyncMeta;
}

export interface MappedVM {
  createFields: CICreateFields; // only meaningful when creating
  physicalFields: CIPhysicalFields; // always present, create AND update
  osHint: OsHint | null; // null when guestOS/guestFamily both absent
}

export interface SyncResult {
  status: 'SUCCESS' | 'PARTIAL' | 'ERROR';
  created: number;
  updated: number;
  retired: number;
  errors: number;
  durationMs: number;
  errorDetails?: Array<{ moref?: string; message: string }>;
}

export interface IHypervisorConnector {
  connect(): Promise<void>;
  discover(): Promise<DiscoveredVM[]>;
  close(): Promise<void>;
}
