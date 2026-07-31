import type { VulnSeverity } from '../integrations/types.js';
import {
  GreenboneReportSchema,
  type GreenboneReport,
  type GreenboneVulnerability,
} from './schemas.js';

// ─── B2 — Real Greenbone format parser (spec §1, §3 D1/D2) ────────────────
//
// Pure, side-effect-free ingestion layer: raw Greenbone JSON report →
// normalized in-memory vulnerability records. No DB access here — the
// output shape mirrors (a subset of) the `VulnImportEntry` Prisma model so
// a later task can persist it without reshaping.

/** Thrown when the input looks like the old, invented mock format
 *  (`results[]`) instead of the real Greenbone export
 *  (`allHostSubreportEntries[]`). This is a named regression the project is
 *  fixing: the current importer reads a field that doesn't exist in real
 *  exports and silently succeeds with 0 processed entries. We refuse to
 *  repeat that — an unrecognized/old-format input must fail loudly. */
export class UnsupportedGreenboneFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedGreenboneFormatError';
  }
}

/** One normalized vulnerability entry extracted from a Greenbone report.
 *  Field names/shape line up with `VulnImportEntry` (backend/prisma/schema.prisma)
 *  minus the DB-only bookkeeping columns (batchId, ciId, matchConfidence, ...)
 *  that a later task (matcher/service) is responsible for adding. */
export interface ParsedVulnEntry {
  /** Identity per spec D1: `${oid}@${port}` for Greenbone — stable across
   *  re-scans. A CrowdStrike-sourced entry (B2, parallel task) will use a
   *  different scheme built from its own identity field. */
  key: string;
  /** Greenbone-specific (OpenVAS plugin id). No CrowdStrike equivalent. */
  oid?: string;
  /** Greenbone-specific. No CrowdStrike equivalent. */
  port?: string;
  /** Parsed `cve` array — `[]` if the report reports none. Never synthesized. */
  cves: string[];
  severityScore: number;
  severity: VulnSeverity;
  name: string;
  summary: string;
  /** `description` array joined with "\n" into a flat string. */
  description: string;
  solution: string;
  /** Greenbone-specific (NVT family). No CrowdStrike equivalent. */
  family?: string;
  /** Greenbone-specific (Alarm/Log). No CrowdStrike equivalent. */
  thread?: string;
  /** Greenbone-specific (Quality of Detection). No CrowdStrike equivalent. */
  qod?: number;
  epssScore: number | undefined;
  /** IP address of the host this vulnerability was reported against
   *  (`allHostSubreportEntries[].host`). */
  hostAddress: string;
  /** Original, untouched vulnerability object — for audit/debug storage
   *  (`VulnImportEntry.raw`). */
  raw: GreenboneVulnerability | Record<string, unknown>;

  // CrowdStrike Spotlight fields (v3.6.1, spec §1 B1) — all optional, added
  // by B2's crowdstrikeParser.ts. Never set by parseGreenboneReport below.
  /** Affected product/version strings, e.g. `["JRE 1.8.0", "JDK 11"]`. */
  products?: string[];
  /** CrowdStrike's own AI-driven severity rating (Low/Medium/High/Critical),
   *  a separate signal from `severity` — never conflated with it. */
  exprtRating?: string;
  /** CISA Known Exploited Vulnerabilities flag. */
  cisaKev?: boolean;
  /** CISA KEV remediation deadline (ISO date string), set when `cisaKev`. */
  cisaDueDate?: string;
  /** Human-readable exploit status label, e.g. "Actively used (critical)". */
  exploitStatus?: string;
  daysOpen?: number;
  /** The SOURCE SYSTEM's own status word (e.g. CrowdStrike's "Open"/
   *  "Reopened") — distinct from this app's own classification/decision. */
  externalStatus?: string;
  /** CVSS version, e.g. "v3.x" — parsed out of CrowdStrike's glued
   *  `base_score` string. The numeric part goes in `severityScore`. */
  cvssVersion?: string;

  // Red Hat Lightspeed fields (v3.7.0) — all optional, added by
  // redhatLightspeed/mapper.ts. Never set by parseGreenboneReport or
  // parseCrowdStrikeReport.
  /** Red Hat's own severity rating (Low/Moderate/Important/Critical) — a
   *  separate signal from `severity`, never conflated with it (same
   *  principle as CrowdStrike's exprtRating). */
  redhatImpact?: string;
  /** Red Hat's own "known exploit" flag. */
  knownExploit?: boolean;
  /** CVE disclosure date (ISO string), informational. */
  publicDate?: string;
}

/** Scan-level metadata plus the flattened list of parsed vulnerability
 *  entries across every host in the report (this fixture has exactly one
 *  host, but the shape supports more). */
export interface ParsedGreenboneScan {
  entries: ParsedVulnEntry[];
  taskName?: string;
  greenboneTaskId?: string;
  scanStart?: string;
  scanEnd?: string;
}

/**
 * CVSS v3.1 severity bands (spec §3 D2), with `INFO` for a 0.0 score:
 *
 *   0.0        → INFO
 *   0.1 – 3.9  → LOW
 *   4.0 – 6.9  → MEDIUM
 *   7.0 – 8.9  → HIGH
 *   9.0 – 10.0 → CRITICAL
 *
 * Pure function — no I/O, easy to unit test at every boundary.
 */
export function scoreToSeverity(score: number): VulnSeverity {
  if (score <= 0) return 'INFO';
  if (score < 4.0) return 'LOW';
  if (score < 7.0) return 'MEDIUM';
  if (score < 9.0) return 'HIGH';
  return 'CRITICAL';
}

/** Converts a Greenbone numeric field (JSON number or JSON string,
 *  depending on export version) to a `number`, throwing on a genuinely
 *  malformed value rather than silently coercing it (e.g. to NaN or 0). */
function toNumber(value: string | number, fieldName: string, context: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(n)) {
    throw new Error(
      `Greenbone parser: field "${fieldName}" on ${context} is not a valid number (got ${JSON.stringify(value)})`,
    );
  }
  return n;
}

/** Detects the old, invented mock shape (`results[]`, no
 *  `allHostSubreportEntries`) and throws a clear, actionable error instead
 *  of letting it fall through to "0 entries processed". */
function assertNotLegacyMockFormat(input: unknown): void {
  if (
    input !== null &&
    typeof input === 'object' &&
    'results' in (input as Record<string, unknown>) &&
    !('allHostSubreportEntries' in (input as Record<string, unknown>))
  ) {
    throw new UnsupportedGreenboneFormatError(
      'Unsupported Greenbone report format: found a top-level "results" key without ' +
      '"allHostSubreportEntries". This looks like the old/invented mock format ' +
      '(greenbone_sample.json), not a real Greenbone OpenVAS export. Re-export the ' +
      'report from Greenbone — the real format uses "allHostSubreportEntries[].vulnerabilities[]".',
    );
  }
}

/**
 * Validates and parses a raw Greenbone report into normalized vulnerability
 * entries plus scan-level metadata.
 *
 * Throws `UnsupportedGreenboneFormatError` for the old/invented mock shape,
 * and a Zod `ZodError` (via `.parse`) for any other structurally invalid
 * input — both are explicit failures, never a silent empty result.
 */
export function parseGreenboneReport(input: unknown): ParsedGreenboneScan {
  assertNotLegacyMockFormat(input);

  const report: GreenboneReport = GreenboneReportSchema.parse(input);

  const entries: ParsedVulnEntry[] = [];
  for (const hostEntry of report.allHostSubreportEntries) {
    for (const vuln of hostEntry.vulnerabilities) {
      const context = `oid=${vuln.oid} port=${vuln.port}`;
      const severityScore = toNumber(vuln.severity, 'severity', context);
      const qod = toNumber(vuln.qod, 'qod', context);
      const epssScore =
        vuln.epss_score === undefined ? undefined : toNumber(vuln.epss_score, 'epss_score', context);

      entries.push({
        key: `${vuln.oid}@${vuln.port}`,
        oid: vuln.oid,
        port: vuln.port,
        cves: vuln.cve ?? [],
        severityScore,
        severity: scoreToSeverity(severityScore),
        name: vuln.name,
        summary: vuln.summary,
        description: vuln.description.join('\n'),
        solution: vuln.solution,
        family: vuln.family,
        thread: vuln.thread,
        qod,
        epssScore,
        hostAddress: hostEntry.host,
        raw: vuln,
      });
    }
  }

  return {
    entries,
    taskName: report.taskName,
    greenboneTaskId: report.greenboneTaskId,
    scanStart: report.scanStart,
    scanEnd: report.scanEnd,
  };
}
