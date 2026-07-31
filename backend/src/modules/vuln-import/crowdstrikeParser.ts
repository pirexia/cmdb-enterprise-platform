import { scoreToSeverity, type ParsedVulnEntry } from './parser.js';
import {
  CrowdStrikeReportSchema,
  type CrowdStrikeVulnerability,
} from './schemas.js';

// ─── B2 — Real CrowdStrike Spotlight format parser (v3.6.1, spec §1 B2) ────
//
// Pure, side-effect-free ingestion layer mirroring `parser.ts`'s
// `parseGreenboneReport`: raw CrowdStrike Spotlight JSON export →
// normalized `ParsedVulnEntry[]` (the same shared shape Greenbone produces,
// so the rest of the pipeline — matcher/classifier/service/router — treats
// both sources identically). No DB access here.

/** Thrown when the input looks like the old, invented mock format
 *  (`{platform, export_date, devices: [...]}` — CrowdStrike agent/EDR
 *  status, a completely different domain) instead of a real CrowdStrike
 *  Spotlight vulnerability export (a flat array of vulnerability records).
 *  Mirrors Greenbone's `UnsupportedGreenboneFormatError` precedent: an
 *  unrecognized/old-format input must fail loudly, never silently succeed
 *  with 0 processed entries. */
export class UnsupportedCrowdStrikeFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedCrowdStrikeFormatError';
  }
}

/** Scan-level wrapper mirroring `ParsedGreenboneScan`'s shape so
 *  `service.ts`'s `uploadReport` (a later task, B4) can consume either
 *  source through the same `{ entries: ParsedVulnEntry[] }` contract.
 *  CrowdStrike's flat export carries no scan-level metadata (no task name,
 *  no scan date range) — those fields are already optional on the
 *  Greenbone side and are simply absent here. */
export interface ParsedCrowdStrikeScan {
  entries: ParsedVulnEntry[];
}

/** Detects the old, invented mock shape (`{platform, export_date,
 *  devices: [...]}`) and throws a clear, actionable error instead of
 *  letting it fall through to Zod's array-parse failure (which would be a
 *  much less actionable message) or, worse, a silent 0-entries result. */
function assertNotLegacyMockFormat(input: unknown): void {
  if (Array.isArray(input)) return;

  if (input !== null && typeof input === 'object' && 'devices' in (input as Record<string, unknown>)) {
    throw new UnsupportedCrowdStrikeFormatError(
      'Unsupported CrowdStrike report format: found a top-level "devices" key. This looks ' +
      'like the old/invented mock format (crowdstrike_sample.json) describing agent/EDR ' +
      'status, not a real CrowdStrike Spotlight vulnerability export. Re-export the report ' +
      'from CrowdStrike Spotlight — the real format is a flat JSON array of vulnerability ' +
      'records at the top level.',
    );
  }

  throw new UnsupportedCrowdStrikeFormatError(
    'Unsupported CrowdStrike report format: expected a top-level JSON array of vulnerability ' +
    'records (the real CrowdStrike Spotlight export shape), got ' +
    `${input === null ? 'null' : typeof input}.`,
  );
}

/** Parses CrowdStrike's glued `base_score` field, e.g. `"7.8 v3.x"`, into
 *  its numeric score and CVSS spec-version parts. Verified across all 841
 *  real fixture records: always this exact `"N.N vN.x"` shape. Throws on a
 *  genuinely malformed value rather than silently coercing it, mirroring
 *  Greenbone's `toNumber()`. */
function parseBaseScore(
  value: string,
  context: string,
): { severityScore: number; cvssVersion: string } {
  const match = /^(\d+(?:\.\d+)?)\s+(v\d+(?:\.\w+)?)$/.exec(value.trim());
  if (!match) {
    throw new Error(
      `CrowdStrike parser: field "base_score" on ${context} is not in the expected ` +
      `"N.N vN.x" shape (got ${JSON.stringify(value)})`,
    );
  }
  const severityScore = Number(match[1]);
  if (Number.isNaN(severityScore)) {
    throw new Error(
      `CrowdStrike parser: field "base_score" on ${context} has a non-numeric score part ` +
      `(got ${JSON.stringify(value)})`,
    );
  }
  return { severityScore, cvssVersion: match[2] };
}

/** Flattens one `products[]` entry to a single normalized string (landmine
 *  #1, spec §1 B2): `product_name_version` is the more specific / more
 *  informative field (e.g. "JRE 1.8.0" vs. just "JRE") and is preferred;
 *  falls back to `product_name` on the defensive path where the version
 *  string happens to be empty (not observed in the real fixture, but the
 *  schema doesn't guarantee it). */
function normalizeProduct(product: { product_name: string; product_name_version: string }): string {
  return product.product_name_version.trim() !== ''
    ? product.product_name_version
    : product.product_name;
}

/** Coerces CrowdStrike's `cisa_info.due_date` — verified `""` (empty
 *  string), never null/absent, on non-KEV records in the real fixture —
 *  to `undefined`. Storing `""` as if it were a real date would be wrong. */
function normalizeDueDate(dueDate: string | undefined): string | undefined {
  return dueDate && dueDate.trim() !== '' ? dueDate : undefined;
}

/**
 * Merges every raw record sharing one `vulnerability_id` into a single
 * `ParsedVulnEntry` (spec D2: identity = `vulnerability_id` alone, never
 * `vulnerability_id + product`). CrowdStrike emits one record per affected
 * product for the same vulnerability, so a group is typically 1..N records.
 *
 * Merge rules (spec §1 B2):
 *  - `products`: union across the group, flattened + deduplicated.
 *  - `solution`: union of distinct `recommended_remediations[].detail`
 *    text across the group, deduplicated, joined with "\n".
 *  - `externalStatus`: "Reopened" wins over "Open" if ANY record in the
 *    group has `status: "Reopened"` — the more conservative/informative
 *    signal takes precedence when they disagree.
 *  - `cves`: union of distinct non-empty `cve_id` values across the group
 *    (verified consistent per group in the real fixture; unioned instead
 *    of "take first" purely as a defensive measure against a group that
 *    happens to disagree).
 *  - `daysOpen`: the max across the group (verified: 7/635 groups in the
 *    real fixture disagree on `days_open` — the same vulnerability was
 *    open longer on one affected product than another — so the max is the
 *    conservative/most-informative choice, consistent with the
 *    Reopened-wins rule above).
 *  - all other scalar fields (severity/base_score, exprt_rating,
 *    cisa_info, exploit_status, cve_published_date): verified consistent
 *    across every multi-record group in the real fixture (0 mismatches on
 *    severity/exprt_rating/cisa_info/base_score) — the first record's
 *    value is used.
 */
function mergeGroup(vulnerabilityId: string, records: CrowdStrikeVulnerability[]): ParsedVulnEntry {
  const first = records[0];
  const context = `vulnerability_id=${vulnerabilityId}`;

  const { severityScore, cvssVersion } = parseBaseScore(first.base_score, context);

  const cves = [...new Set(records.map((r) => r.cve_id).filter((v): v is string => !!v && v.trim() !== ''))];

  const products = [
    ...new Set(records.flatMap((r) => (r.products ?? []).map(normalizeProduct))),
  ];

  const remediationDetails = [
    ...new Set(
      records.flatMap((r) => r.recommended_remediations ?? [])
        .map((rem) => rem.detail)
        .filter((detail) => detail.trim() !== ''),
    ),
  ];

  const externalStatus = records.some((r) => r.status === 'Reopened') ? 'Reopened' : first.status;

  const daysOpenValues = records.map((r) => r.days_open).filter((v): v is number => v !== undefined);
  const daysOpen = daysOpenValues.length > 0 ? Math.max(...daysOpenValues) : undefined;

  const cveName = records.find((r) => r.cve_name)?.cve_name;
  const name = first.cve_id ?? vulnerabilityId;

  return {
    key: vulnerabilityId,
    cves,
    severityScore,
    severity: scoreToSeverity(severityScore),
    name,
    summary: cveName ?? '',
    description: cveName ? `${cveName} (${vulnerabilityId})` : vulnerabilityId,
    solution: remediationDetails.join('\n'),
    epssScore: undefined,
    hostAddress: first.local_ip,
    raw: records.length === 1 ? first : { vulnerability_id: vulnerabilityId, records },

    products,
    exprtRating: first.exprt_rating,
    cisaKev: first.cisa_info?.is_cisa_kev ?? false,
    cisaDueDate: normalizeDueDate(first.cisa_info?.due_date),
    exploitStatus: first.exploit_status?.label,
    daysOpen,
    externalStatus,
    cvssVersion,
  };
}

/**
 * Validates and parses a raw CrowdStrike Spotlight export into normalized,
 * per-`vulnerability_id`-merged vulnerability entries.
 *
 * Throws `UnsupportedCrowdStrikeFormatError` for the old/invented device
 * mock shape (or any non-array top level), and a Zod `ZodError` (via
 * `.parse`) for any other structurally invalid input — both are explicit
 * failures, never a silent empty result.
 */
export function parseCrowdStrikeReport(input: unknown): ParsedCrowdStrikeScan {
  assertNotLegacyMockFormat(input);

  const records: CrowdStrikeVulnerability[] = CrowdStrikeReportSchema.parse(input);

  const groups = new Map<string, CrowdStrikeVulnerability[]>();
  for (const record of records) {
    const group = groups.get(record.vulnerability_id);
    if (group) {
      group.push(record);
    } else {
      groups.set(record.vulnerability_id, [record]);
    }
  }

  const entries: ParsedVulnEntry[] = [];
  for (const [vulnerabilityId, group] of groups) {
    entries.push(mergeGroup(vulnerabilityId, group));
  }

  return { entries };
}
