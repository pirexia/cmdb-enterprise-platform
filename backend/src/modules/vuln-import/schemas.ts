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
