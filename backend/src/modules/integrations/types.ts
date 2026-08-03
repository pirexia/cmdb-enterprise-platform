export type VulnSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
export type VulnStatus   = 'NUEVO' | 'ASIGNADO' | 'EN_CURSO' | 'PARADO' | 'RESUELTO' | 'REABIERTA';

export interface Vulnerability {
  cve:         string;
  severity:    VulnSeverity;
  description: string;
  source?:     string;
  cvss_score?: number | null;
  status:      VulnStatus;
  importedAt:  string;
  // Greenbone real-format fields (v3.6.0, spec D1/D1b) — all optional so
  // existing stored entries (cve/severity/description/source/cvss_score/
  // status/importedAt only) remain valid against this type unmodified.
  key?:         string;
  oid?:         string;
  port?:        string;
  cves?:        string[];
  lastSeenAt?:  string;
  resolvedAt?:  string;
  reopenedAt?:  string;
  qod?:         number;
  family?:      string;
  solution?:    string;
  epssScore?:   number;
  // CrowdStrike Spotlight fields (v3.6.1, spec §1 B1) — all optional, mirror
  // the same-named VulnImportEntry columns in JSON-storage shape (camelCase,
  // no DB-specific types). Absent for Greenbone-sourced entries.
  products?:      string[];
  exprtRating?:   string;
  cisaKev?:       boolean;
  cisaDueDate?:   string;
  exploitStatus?: string;
  daysOpen?:      number;
  externalStatus?: string;
  cvssVersion?:   string;
  // Red Hat Lightspeed fields (v3.7.0) — all optional, mirror the
  // same-named VulnImportEntry columns. Absent for Greenbone/CrowdStrike.
  redhatImpact?: string;
  knownExploit?: boolean;
  publicDate?: string;
  // Vulnerability owner assignment (v3.7.0 responsable phase) — all optional,
  // so any previously stored vulnerability (no assignment yet) remains valid
  // against this type unmodified. No schema migration: still JSON-in-CI.
  assignedTo?: string;   // user id
  assignedAt?: string;   // ISO date
  assignedBy?: string;   // user id of whoever made the assignment
}
