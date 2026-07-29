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
}
