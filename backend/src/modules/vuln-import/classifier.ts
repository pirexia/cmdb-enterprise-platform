// Pure classification logic for incoming (freshly-parsed) Greenbone
// vulnerabilities against the set of vulnerabilities already stored on the
// matched CI. No Prisma, no I/O — see spec
// docs/internal/specs/2026-07-29-v3.6.0-greenbone-real-format-staging.md
// sections D1/D1b (identity), D5 (classification outcomes), D7 (default
// premarking threshold).

import type { Vulnerability, VulnSeverity, VulnStatus } from '../integrations/types.js';

/** Minimal shape required of an incoming, freshly-parsed vulnerability. */
export interface IncomingVulnerability {
  key: string;
  severity: VulnSeverity;
}

export type VulnClassification = 'NUEVA' | 'EXISTENTE_PENDIENTE' | 'REAPARECIDA';
export type VulnDecision = 'INCLUDE' | 'EXCLUDE';

export interface ClassificationResult {
  classification: VulnClassification;
  decision: VulnDecision;
  /** Status of the matched stored entry, or null if no match was found. */
  existingStatus: VulnStatus | null;
}

/**
 * Severity band order, ascending. Imported/derived from the values of
 * `VulnSeverity` (backend/src/modules/integrations/types.ts) rather than
 * duplicated as a bare string list disconnected from that type.
 */
const SEVERITY_ORDER: readonly VulnSeverity[] = ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

/** Statuses that mean the stored vulnerability is still open / unresolved (D5). */
const OPEN_STATUSES: readonly VulnStatus[] = ['NUEVO', 'ASIGNADO', 'EN_CURSO', 'PARADO'];

/**
 * Default premarking threshold (D7): a newly-seen vulnerability is
 * pre-checked for inclusion only if its severity is MEDIUM or above.
 * This is a deliberate module constant, not configurable via env var.
 */
const DEFAULT_INCLUDE_MIN_SEVERITY: VulnSeverity = 'MEDIUM';

/**
 * Returns true when `severity` is at or above `threshold` in the
 * INFO < LOW < MEDIUM < HIGH < CRITICAL band order. Exported standalone so
 * it can be unit-tested and reused independently of the classification
 * function (e.g. by a later task or a reviewer verifying D7 in isolation).
 */
export function isSeverityAtLeast(severity: VulnSeverity, threshold: VulnSeverity = DEFAULT_INCLUDE_MIN_SEVERITY): boolean {
  return SEVERITY_ORDER.indexOf(severity) >= SEVERITY_ORDER.indexOf(threshold);
}

/**
 * Resolves the identity a *stored* vulnerability entry should be matched
 * against, per spec D1b: `entry.key ?? entry.cve`. Pre-migration stored
 * entries only ever had `cve`, never `key`.
 *
 * Edge case: a stored entry with neither `key` nor `cve` populated is
 * genuinely un-identifiable (should not occur in practice — `cve` is a
 * required field on `Vulnerability` — but defensively handled here in case
 * of malformed/legacy data slipping through). Such an entry can never be
 * matched against an incoming key; it is simply skipped by the caller.
 */
function resolveStoredIdentity(entry: Pick<Vulnerability, 'key' | 'cve'>): string | null {
  return entry.key ?? entry.cve ?? null;
}

/**
 * Classifies one incoming vulnerability against the vulnerabilities already
 * stored on the matched CI, per spec D5/D7.
 *
 * @param incoming        The freshly-parsed incoming vulnerability.
 * @param storedOnCI       The CI's existing `vulnerabilities`, or null/undefined
 *                          if the CI has none stored yet.
 */
export function classifyVulnerability(
  incoming: IncomingVulnerability,
  storedOnCI: Pick<Vulnerability, 'key' | 'cve' | 'status'>[] | null | undefined,
): ClassificationResult {
  const stored = storedOnCI ?? [];

  const match = stored.find((entry) => resolveStoredIdentity(entry) === incoming.key);

  if (!match) {
    return {
      classification: 'NUEVA',
      decision: isSeverityAtLeast(incoming.severity) ? 'INCLUDE' : 'EXCLUDE',
      existingStatus: null,
    };
  }

  if (match.status === 'RESUELTO') {
    return {
      classification: 'REAPARECIDA',
      decision: 'INCLUDE',
      existingStatus: match.status,
    };
  }

  if (OPEN_STATUSES.includes(match.status)) {
    return {
      classification: 'EXISTENTE_PENDIENTE',
      decision: 'EXCLUDE',
      existingStatus: match.status,
    };
  }

  // Any other stored status (e.g. REABIERTA, not explicitly covered by D5's
  // three named outcomes) is treated as still-open/pending, mirroring the
  // conservative default for OPEN_STATUSES — never silently re-import.
  return {
    classification: 'EXISTENTE_PENDIENTE',
    decision: 'EXCLUDE',
    existingStatus: match.status,
  };
}
