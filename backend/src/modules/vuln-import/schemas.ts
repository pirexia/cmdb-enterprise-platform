import { z } from 'zod';

// Greenbone real-format (v3.6.0, spec §1/§3-D1) — schemas for the actual
// OpenVAS report shape, NOT the invented `results[]` mock this module
// replaces. See parser.ts for the "old mock format" rejection.
//
// `severity` / `qod` / `epss_score` arrive from Greenbone as either a JSON
// number or a JSON string depending on export version (verified against the
// real fixture: this particular export serializes them as JSON numbers).
// We validate the union here and convert explicitly in parser.ts via
// `toNumber()`, which throws on a genuinely malformed value — Zod never
// silently coerces these (house rule: validate what we use, tolerate the
// rest; never hide a malformed value behind an implicit coercion).
const NumericField = z.union([z.string(), z.number()]);

export const GreenboneVulnerabilitySchema = z.object({
  name: z.string(),
  severity: NumericField,
  qod: NumericField,
  host: z.string(),
  port: z.string(),
  summary: z.string(),
  // Real format: array of strings (almost always length 1), NOT a plain
  // string — joined with "\n" by the parser when a flat description is
  // needed.
  description: z.array(z.string()),
  solution: z.string(),
  solutionType: z.string(),
  affected: z.string(),
  insight: z.string(),
  // Almost always empty in the real file; occasionally 1+ CVE ids.
  cve: z.array(z.string()),
  bid: z.array(z.unknown()).optional(),
  cert: z.array(z.unknown()).optional(),
  xref: z.array(z.unknown()).optional(),
  thread: z.string(),
  oid: z.string(),
  family: z.string(),
  nvtName: z.string(),
  impact: z.string(),
  qodType: z.string().optional(),
  hostname: z.string().optional(),
  operatingSystem: z.string().optional(),
  // Optional — not present on every entry in the real fixture.
  epss_score: NumericField.optional(),
}).passthrough();

export const GreenboneHostSubreportEntrySchema = z.object({
  host: z.string(),
  vulnerabilities: z.array(GreenboneVulnerabilitySchema),
}).passthrough();

// Top-level Greenbone report. `allHostSubreportEntries` is the only field we
// require; scan metadata is optional; every aggregate/reporting field
// (severityDistribution, top10*, hostDetail, hostMaxSeverity, ...) is
// tolerated via `.passthrough()` without validating its internal shape —
// we never read those fields, so we must not fail validation because of
// them.
export const GreenboneReportSchema = z.object({
  allHostSubreportEntries: z.array(GreenboneHostSubreportEntrySchema),
  taskName: z.string().optional(),
  greenboneTaskId: z.string().optional(),
  scanStart: z.string().optional(),
  scanEnd: z.string().optional(),
  scanDurationInSeconds: NumericField.optional(),
  progress: NumericField.optional(),
}).passthrough();

export type GreenboneVulnerability = z.infer<typeof GreenboneVulnerabilitySchema>;
export type GreenboneHostSubreportEntry = z.infer<typeof GreenboneHostSubreportEntrySchema>;
export type GreenboneReport = z.infer<typeof GreenboneReportSchema>;

// ─── B5 — request-body schemas for the staging review API ─────────────────
// Zod validation on every write endpoint's body (house convention). `.strict()`
// so an unexpected extra field is rejected rather than silently ignored — an
// operator-facing correction endpoint must not accept fields it doesn't
// document (A04/A08).

/** Wrapper for POST /upload — the raw Greenbone report plus an optional
 *  display filename. `report` itself is validated by `GreenboneReportSchema`
 *  (via the parser), not here — we only shape the envelope. */
export const UploadRequestSchema = z.object({
  filename: z.string().min(1).max(500).optional(),
  report: z.unknown(),
}).strict();
export type UploadRequestBody = z.infer<typeof UploadRequestSchema>;

const SeverityEnum = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']);
const DecisionEnum = z.enum(['INCLUDE', 'EXCLUDE']);
const ClassificationEnum = z.enum(['NUEVA', 'EXISTENTE_PENDIENTE', 'REAPARECIDA']);
const UuidSchema = z.string().uuid();

/** PATCH /batches/:id/entries/:entryId — operator correction of one entry.
 *  Every field optional (partial patch), but at least one must be present. */
export const PatchEntrySchema = z.object({
  ciId: UuidSchema.optional(),
  severity: SeverityEnum.optional(),
  decision: DecisionEnum.optional(),
}).strict().refine((body) => body.ciId !== undefined || body.severity !== undefined || body.decision !== undefined, {
  message: 'At least one of ciId, severity, decision must be provided.',
});
export type PatchEntryBody = z.infer<typeof PatchEntrySchema>;

/** POST /batches/:id/entries/bulk-decision — include/exclude in bulk over a filter. */
export const BulkDecisionSchema = z.object({
  filter: z.object({
    classification: ClassificationEnum.optional(),
    severity: SeverityEnum.optional(),
    decision: DecisionEnum.optional(),
  }).strict().default({}),
  decision: DecisionEnum,
}).strict();
export type BulkDecisionBody = z.infer<typeof BulkDecisionSchema>;

// ─── B2 — CrowdStrike Spotlight real-format schemas (v3.6.1, spec §1 B1/B2) ─
//
// Shapes verified directly against the real fixture
// (docs/mocks/crowdstrike_SRV-MYGESTR01D.json, 841 records, 1 host). The
// top level is a FLAT ARRAY, unlike Greenbone's object-with-key shape — the
// old/invented mock (crowdstrike_sample.json) is a `{platform, export_date,
// devices: [...]}` object describing agent/EDR status, a different domain
// entirely; see crowdstrikeParser.ts's `UnsupportedCrowdStrikeFormatError`
// for the rejection of that shape.

/** `products[]` entry — verified as an array of objects (NOT strings) in
 *  the real export. `product_name_version` is the more specific field
 *  (e.g. "JRE 1.8.0"); `product_name` alone (e.g. "JRE") is the fallback
 *  when the version field happens to be empty. */
export const CrowdStrikeProductSchema = z.object({
  product_name: z.string(),
  product_name_version: z.string(),
  sub_status: z.string().optional(),
}).passthrough();

/** `recommended_remediations[]` entry — only `detail` is reliably populated
 *  free text in the real fixture; the other string fields are frequently
 *  `""`. `extra_steps` is `null` on every record observed. */
export const CrowdStrikeRemediationSchema = z.object({
  remediation: z.string().optional(),
  detail: z.string(),
  link: z.string().optional(),
  vendor_advisory_url: z.string().optional(),
  extra_steps: z.string().nullable().optional(),
}).passthrough();

/** `exploit_status` — an OBJECT in the real export (`{value, label}`), not
 *  a plain string. `ParsedVulnEntry.exploitStatus` extracts `.label` only. */
export const CrowdStrikeExploitStatusSchema = z.object({
  value: z.number().optional(),
  label: z.string(),
}).passthrough();

/** `cisa_info` — verified `due_date` is `""` (empty string), never
 *  null/absent, on non-KEV records. The parser coerces `""` to `undefined`
 *  rather than storing it as if it were a real date. */
export const CrowdStrikeCisaInfoSchema = z.object({
  is_cisa_kev: z.boolean(),
  due_date: z.string().optional().default(''),
}).passthrough();

/** One raw CrowdStrike Spotlight record. CrowdStrike emits ONE RECORD PER
 *  AFFECTED PRODUCT for the same vulnerability — `crowdstrikeParser.ts`
 *  merges records sharing the same `vulnerability_id` into a single
 *  `ParsedVulnEntry` (spec D2: identity = `vulnerability_id` alone).
 *
 *  `products` and `cve_id` are optional: verified in the real fixture that
 *  `Reopened`-status records omit `products` entirely (not `[]`), and
 *  exactly 1/841 records (`CS-V26-A757135`) has no `cve_id` at all — never
 *  synthesize a fake CVE for that case. */
export const CrowdStrikeVulnerabilitySchema = z.object({
  hostname: z.string(),
  local_ip: z.string(),
  os_version: z.string().optional(),
  os_build: z.string().optional(),
  vulnerability_id: z.string(),
  cve_id: z.string().optional(),
  /** Rare (3/841 in the real fixture) — a common name, e.g. "Terrapin". */
  cve_name: z.string().optional(),
  cve_published_date: z.string().optional(),
  // Glued CVSS score + spec version, e.g. "7.8 v3.x" — verified as this
  // exact "N.N vN.x" shape across all 841 real records. Split by the
  // parser into `severityScore` (number) and `cvssVersion` (string).
  base_score: z.string(),
  /** CrowdStrike's own AI-driven severity rating — a separate signal from
   *  CVSS-derived `severity`, never conflated with it (spec D-note). */
  exprt_rating: z.string().optional(),
  // CVSS-derived severity band. Present in the data but NOT used directly
  // by the parser — severity is derived from `base_score` via the shared
  // `scoreToSeverity()` so both sources' severity bands mean the same
  // thing, matching Greenbone's convention.
  severity: z.string().optional(),
  exploit_status: CrowdStrikeExploitStatusSchema.optional(),
  cisa_info: CrowdStrikeCisaInfoSchema.optional(),
  recommended_remediations: z.array(CrowdStrikeRemediationSchema).optional().default([]),
  products: z.array(CrowdStrikeProductSchema).optional().default([]),
  // "Open" | "Reopened" in the real fixture, tolerated as a free string —
  // this is the SOURCE SYSTEM's own status word, distinct from this app's
  // classification (maps to `ParsedVulnEntry.externalStatus`).
  status: z.string().optional(),
  days_open: z.number().optional(),
  vulnerability_confidence: z.string().optional(),
}).passthrough();

// Top-level shape: a flat array at the root (NOT an object with a
// `devices`/`results` key — that's the old/invented mock's shape).
export const CrowdStrikeReportSchema = z.array(CrowdStrikeVulnerabilitySchema);

export type CrowdStrikeProduct = z.infer<typeof CrowdStrikeProductSchema>;
export type CrowdStrikeRemediation = z.infer<typeof CrowdStrikeRemediationSchema>;
export type CrowdStrikeVulnerability = z.infer<typeof CrowdStrikeVulnerabilitySchema>;
export type CrowdStrikeReport = z.infer<typeof CrowdStrikeReportSchema>;
