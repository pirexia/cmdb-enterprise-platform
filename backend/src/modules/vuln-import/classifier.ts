// Pure classification logic for incoming (freshly-parsed) Greenbone
// vulnerabilities against the set of vulnerabilities already stored on the
// matched CI. No Prisma, no I/O — see spec
// docs/internal/specs/2026-07-29-v3.6.0-greenbone-real-format-staging.md
// sections D1/D1b (identity), D5 (classification outcomes), D7 (default
// premarking threshold).

import type { Vulnerability, VulnSeverity, VulnStatus } from '../integrations/types.js';
// Type-only import — queries.ts never imports from this file, so this stays
// a one-way dependency (no cycle). NewEntryInput is the shape uploadReport()
// (vuln-import/service.ts) and runImportBackground() (Red Hat Lightspeed
// connector service.ts) both push onto their `newEntries` array before
// writeBatchEntries persists it — computeAbsentClosures below needs to
// produce entries in that exact shape so its output can be pushed onto the
// same array with no adapter step at the call site.
import type { NewEntryInput } from './queries.js';

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

// RESUELTA_AUSENTE added (task 14, v3.7.0 prep) — a fourth classification for
// a stored, still-open vulnerability that a fresh scan no longer reports at
// all (i.e. absent from the incoming set, not matched/reopened). The type is
// added here, along with its direct style/label consumers, ahead of the
// actual classification logic that decides when to use it (task 15) —
// `classifyVulnerability` below never returns this value yet.
export type VulnClassification = 'NUEVA' | 'EXISTENTE_PENDIENTE' | 'REAPARECIDA' | 'RESUELTA_AUSENTE';
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

// ─── computeAbsentClosures (task 15, v3.7.0 prep) ───────────────────────────
//
// Deliberately a SEPARATE list from `OPEN_STATUSES` above (do not merge
// them). `OPEN_STATUSES` above answers a different question — "is a
// STORED entry that an INCOMING key just matched still pending" (used by
// `classifyVulnerability` to decide EXISTENTE_PENDIENTE vs. re-treating it as
// new) — and it deliberately excludes `REABIERTA` (spec D5's classification
// outcomes only ever reference RESUELTO/OPEN_STATUSES/"anything else" for
// that decision, and REABIERTA already falls into the "anything else ->
// EXISTENTE_PENDIENTE" branch a few lines up).
//
// `computeAbsentClosures` answers a different question — "is a stored
// vulnerability still open enough that its absence from a complete, current
// report should count as a resolution". That is exactly the question
// `sweepLightspeedClosures` (service.ts, currently only wired for
// batch.source === 'redhat-lightspeed', run at ACCEPT time) already answers
// today, and its inline literal there
// (`['NUEVO', 'ASIGNADO', 'EN_CURSO', 'PARADO', 'REABIERTA']`) DOES include
// REABIERTA — a reopened vulnerability is still an open one, and a report
// that no longer sees it is exactly the "reopened, then actually fixed"
// case this whole mechanism exists to catch. This function replicates that
// list verbatim so the new upload-time staging path (this task) and the
// existing accept-time sweep (Lightspeed only, until task 16 generalizes it)
// never disagree about what "still open" means for the same status value.
//
// NOTE ON A NAMING COLLISION IN THIS CODEBASE: `REAPARECIDA` (a
// `VulnClassification` value, "reappeared" — a transient upload-time
// classification of an INCOMING key) and `REABIERTA` (a `VulnStatus` value,
// "reopened" — a persisted status on a STORED entry, set by acceptBatch when
// a REAPARECIDA-classified entry is accepted) are two different enums that
// happen to be near-homonyms in Spanish. `REAPARECIDA` is NOT a valid
// `VulnStatus` at all (see `../integrations/types.ts`: `VulnStatus =
// 'NUEVO' | 'ASIGNADO' | 'EN_CURSO' | 'PARADO' | 'RESUELTO' | 'REABIERTA'`),
// so a status list built around it would never match anything reopened.
// The list below uses `REABIERTA`, matching both the actual source at
// service.ts's `sweepLightspeedClosures` and the original task-15 design
// brief (`.superpowers/sdd/task-15-brief.md` line 19) — verified directly
// against both before writing this function; see task-15-report.md for the
// full verification trail.
const ABSENT_CLOSURE_OPEN_STATUSES: readonly VulnStatus[] = ['NUEVO', 'ASIGNADO', 'EN_CURSO', 'PARADO', 'REABIERTA'];

/**
 * Computes `RESUELTA_AUSENTE` closure entries for one CI, per the v3.7.0
 * design's four non-negotiable rules (see task-15-brief.md):
 *
 * 1. Only ever called for a CI known to be present in the current batch —
 *    enforced by the CALLER (both call sites iterate `storedVulnsByCi`,
 *    which by construction only ever contains CIs matched from an entry in
 *    THIS batch — see `uploadReport`'s and `runImportBackground`'s doc
 *    comments at their call sites). This function itself has no way to
 *    detect "CI absent from the batch" — it only ever sees the CI it's
 *    told to look at.
 * 2. `source` must match EXACTLY — a Greenbone-only stored vulnerability is
 *    never closed by a CrowdStrike or Lightspeed batch simply not
 *    mentioning it, and vice versa.
 * 3. Only vulnerabilities in `ABSENT_CLOSURE_OPEN_STATUSES` are eligible —
 *    an already-`RESUELTO` entry is not "closed again", and an entry with
 *    an unidentifiable stored key (neither `key` nor `cve` set — see
 *    `resolveStoredIdentity`'s doc comment) can never be reasoned about, so
 *    it is skipped rather than guessed at.
 * 4. Every eligible entry not present in `reportedKeys` (this batch's
 *    identity set for this CI, `key ?? cve` — same criterion as
 *    `resolveStoredIdentity`) becomes one `RESUELTA_AUSENTE` /
 *    `decision: 'INCLUDE'` entry, `null` (default) rather than `EXCLUDE` —
 *    reappearing/absence detection is deliberately noisy-by-default (D7's
 *    mirror image): the operator reviews and can uncheck it, but the
 *    default position is "surface it", not "silently ignore it".
 *
 * Field-population notes for the synthetic `NewEntryInput` this returns —
 * there is no incoming report row backing it, only the CI's own stored
 * `Vulnerability` record, so several `VulnImportEntry` columns that
 * normally come from a scanner payload have no natural source value:
 * - `hostAddress`: `Vulnerability` carries no host-address field at all
 *   (see `../integrations/types.ts`) — an empty string is used rather than
 *   a synthetic placeholder string, matching how the review UI already
 *   treats a falsy `hostAddress` (`frontend/app/vulnerabilities/imports/
 *   [id]/page.tsx` line 384: `entry.hostAddress ? ... : ""`).
 * - `matchConfidence: 'MANUAL'` — not literally an operator edit, but the
 *   existing convention this codebase already uses for "this entry's CI
 *   assignment is not the result of the matcher cascade, and is not
 *   ambiguous/unmatched either" (see `patchEntry`'s doc comment in
 *   service.ts); `ciId` here is the CI this stored vulnerability already
 *   lives on, which is as undisputed as a CI assignment gets.
 * - `raw: {}` — the `raw` column is NOT NULL; there is no scanner payload to
 *   preserve, so an empty object is stored rather than fabricating one.
 * - `existingStatus`: the stored entry's status BEFORE this closure is
 *   applied (its current open status) — mirrors what `existingStatus`
 *   already records elsewhere in this module (the matched stored entry's
 *   status at classification time), not the `RESUELTO` it is about to
 *   become on accept.
 * - All other CrowdStrike/Lightspeed-only fields (`products`, `exprtRating`,
 *   `cisaKev`, etc.) are carried over from the stored entry's own values
 *   when present, `null`/`false`/`[]` otherwise — same fallback pattern
 *   `uploadReport` and `runImportBackground` already use when normalizing a
 *   real parsed entry.
 */
export function computeAbsentClosures(
  ciId: string,
  source: string,
  storedVulns: Vulnerability[],
  reportedKeys: Set<string>,
): NewEntryInput[] {
  const closures: NewEntryInput[] = [];

  for (const v of storedVulns) {
    if (v.source !== source) continue;

    const identity = resolveStoredIdentity(v);
    if (!identity) continue; // unidentifiable stored entry — see resolveStoredIdentity's doc comment

    if (!ABSENT_CLOSURE_OPEN_STATUSES.includes(v.status)) continue; // not "open" — nothing to close
    if (reportedKeys.has(identity)) continue; // still reported this batch — not absent

    closures.push({
      hostAddress: '',
      ciId,
      matchConfidence: 'MANUAL',
      matchCandidates: null,
      vulnKey: identity,
      oid: v.oid ?? null,
      port: v.port ?? null,
      cves: v.cves ?? (v.cve ? [v.cve] : []),
      severityScore: v.cvss_score ?? 0,
      severity: v.severity,
      name: v.description,
      summary: null,
      solution: v.solution ?? null,
      family: v.family ?? null,
      thread: null,
      qod: v.qod ?? null,
      epssScore: v.epssScore ?? null,
      raw: {},
      existingStatus: v.status,
      classification: 'RESUELTA_AUSENTE',
      decision: 'INCLUDE',
      products: v.products ?? [],
      exprtRating: v.exprtRating ?? null,
      cisaKev: v.cisaKev ?? false,
      cisaDueDate: v.cisaDueDate ? new Date(v.cisaDueDate) : null,
      exploitStatus: v.exploitStatus ?? null,
      daysOpen: v.daysOpen ?? null,
      externalStatus: v.externalStatus ?? null,
      cvssVersion: v.cvssVersion ?? null,
      redhatImpact: v.redhatImpact ?? null,
      knownExploit: v.knownExploit ?? null,
      publicDate: v.publicDate ? new Date(v.publicDate) : null,
    });
  }

  return closures;
}
