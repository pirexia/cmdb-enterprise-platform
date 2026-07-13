// ─── vCenter connector types (Task E — frontend card) ──────────────────────
// Mirrors backend/src/modules/integrations/router.ts response shapes verbatim.

export interface SyncResult {
  status:        "SUCCESS" | "PARTIAL" | "ERROR";
  created:       number;
  updated:       number;
  retired:       number;
  errors:        number;
  durationMs:    number;
  errorDetails?: Array<{ moref?: string; message: string }>;
}

export interface VCenterStatus {
  configured:     boolean;
  host:           string | null;
  sslVerify:      boolean;
  syncEnabled:    boolean;
  lastSyncAt:     string | null;
  lastSyncResult: SyncResult | null;
}

export interface SyncLogEntry extends SyncResult {
  date: string;
}

export interface TestResult {
  ok:      boolean;
  message: string;
}

export interface ApiErrorBody {
  error: string;
}
