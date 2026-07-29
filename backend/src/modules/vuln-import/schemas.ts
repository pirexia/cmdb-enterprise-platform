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
