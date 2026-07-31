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
  // CrowdStrike Spotlight fields (v3.6.1, spec §D4/D5) — optional so
  // Greenbone-sourced incoming entries (which never set these) are
  // unaffected. Mirrors the same-named fields on `ParsedVulnEntry`/
  // `Vulnerability`.
  /**
   * CrowdStrike's own reopen tracking. When `'Reopened'`, the external
   * system is itself asserting "this vulnerability was previously closed
   * and has come back" — independent of what the CMDB's own stored copy
   * (if any) currently thinks. See D5.
   */
  externalStatus?: string;
  /** True when the incoming vulnerability is in the CISA Known Exploited
   * Vulnerabilities catalog. Forces pre-selected inclusion regardless of
   * severity band (D4). */
  cisaKev?: boolean;
  /** Human-readable exploitation-likelihood label from CrowdStrike Spotlight
   * (e.g. "Actively used (critical)", "Unproven"). Only specific values
   * count as "active exploitation" — see `isActivelyExploited`. */
  exploitStatus?: string;
  /** Red Hat Lightspeed's own "known exploit" flag — a third, independent
   *  forced-premarking signal alongside CISA KEV / active-exploitation. */
  knownExploit?: boolean;
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
 * CrowdStrike Spotlight `exploitStatus` label values that count as "active
 * exploitation" for premarking purposes (D4). Deliberately an explicit
 * allowlist, not a substring/heuristic match: "available" exploit code
 * (`'Available (medium)'`) is NOT the same claim as "actively used in the
 * wild" (`'Actively used (critical)'`) or "trivially exploitable"
 * (`'Easily Accessible (high)'`), and `'Unproven'` never counts. Verified
 * against the real fixture's full distinct label set (794 Unproven / 40
 * Available (medium) / 6 Actively used (critical) / 1 Easily Accessible
 * (high)).
 */
export const ACTIVE_EXPLOITATION_LABELS: ReadonlySet<string> = new Set([
  'Actively used (critical)',
  'Easily Accessible (high)',
]);

/**
 * Returns true when `exploitStatus` is one of the CrowdStrike Spotlight
 * labels that indicates active/easy exploitation (D4). Named and exported
 * standalone so the REASON a vulnerability gets premarked is legible and
 * independently unit-testable, rather than an inline string-contains check
 * buried inside the classification function.
 */
export function isActivelyExploited(exploitStatus: string | undefined | null): boolean {
  if (!exploitStatus) return false;
  return ACTIVE_EXPLOITATION_LABELS.has(exploitStatus);
}

/**
 * Whether an incoming vulnerability should be pre-selected for inclusion
 * regardless of its severity band (D4): CISA KEV membership or active/easy
 * exploitation per CrowdStrike Spotlight's own assessment. Both signals are
 * independent of, and in addition to, the severity≥MEDIUM default (D7) —
 * this function only decides the OR-condition that widens premarking; it
 * does not by itself decide `decision` (callers combine it with
 * `isSeverityAtLeast`).
 */
function isForcedPremarked(incoming: IncomingVulnerability): boolean {
  return incoming.cisaKev === true || isActivelyExploited(incoming.exploitStatus) || incoming.knownExploit === true;
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

  // D5 (CrowdStrike, v3.6.1): the external system's own reopen tracking is a
  // second, independent path to REAPARECIDA. CrowdStrike only ever reports
  // `'Reopened'` about something it has itself seen close, so this signal is
  // sufficient on its own — regardless of whether the CMDB has any stored
  // match at all, and regardless of what status a stored match currently
  // has (even a still-open NUEVO/ASIGNADO/EN_CURSO/PARADO status is
  // overridden). This is deliberately checked before the "no match" /
  // OPEN_STATUSES branches below, since it can override either of them.
  if (incoming.externalStatus === 'Reopened') {
    return {
      classification: 'REAPARECIDA',
      decision: 'INCLUDE',
      existingStatus: match?.status ?? null,
    };
  }

  if (!match) {
    // D4 (CrowdStrike, v3.6.1): CISA KEV membership or active/easy
    // exploitation forces pre-selected inclusion even below the severity≥
    // MEDIUM default (D7). Only widens the NUEVA path — EXISTENTE_PENDIENTE
    // below stays unconditionally EXCLUDE regardless of these signals,
    // since "already tracked and pending" is a different situation from
    // "newly discovered".
    const preselect = isSeverityAtLeast(incoming.severity) || isForcedPremarked(incoming);
    return {
      classification: 'NUEVA',
      decision: preselect ? 'INCLUDE' : 'EXCLUDE',
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
