// ─── Greenbone staging/review workflow — frontend types (v3.6.0, task F1) ───
//
// Single source of truth for F2 (batch-list page), F3 (batch-review page) and
// F4 (/vulnerabilities page updates). Every type here is derived field-for-
// field from the ACTUAL backend response-producing code, not from a prose
// description — see the file+line references in each comment below. Do not
// hand-edit a shape without re-checking the cited backend source first.
//
// Backend sources checked (do not re-guess, re-verify against these if the
// backend module changes):
//   - backend/src/modules/vuln-import/router.ts        (7 route handlers)
//   - backend/src/modules/vuln-import/service.ts        (UploadResult/Summary, AcceptResult/Summary, BlockingEntry)
//   - backend/src/modules/vuln-import/queries.ts         (listBatches/getBatchWithEntries shapes)
//   - backend/src/modules/vuln-import/schemas.ts         (Zod request-body schemas + enum literals)
//   - backend/src/modules/vuln-import/matcher.ts          (MatchConfidence, CICandidate)
//   - backend/src/modules/vuln-import/classifier.ts       (VulnClassification, VulnDecision)
//   - backend/prisma/schema.prisma                         (model VulnImportBatch / VulnImportEntry, ~line 1084)
//   - backend/src/modules/integrations/types.ts             (Vulnerability, VulnSeverity, VulnStatus)

// ─── Severity / status — authoritative sets, for F4 to replace its stale ────
// local copies (frontend/app/vulnerabilities/page.tsx currently defines its
// own VulnSeverity without 'INFO' and VulnStatus without 'REABIERTA' — that
// is out of scope for THIS task; F4 replaces those imports later). Mirrors
// backend/src/modules/integrations/types.ts exactly (lines 1-2).
export type VulnSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
export type VulnStatus =
  | 'NUEVO'
  | 'ASIGNADO'
  | 'EN_CURSO'
  | 'PARADO'
  | 'RESUELTO'
  | 'REABIERTA';

// ─── Core staging-workflow enums ────────────────────────────────────────────

/** VulnImportBatch.status (schema.prisma ~line 1092: plain VarChar, business
 *  values assigned by service.ts: 'PENDING' on create, 'ACCEPTED'/'DISCARDED'
 *  via markBatchStatus in acceptBatch/discardBatch). */
export type VulnImportBatchStatus = 'PENDING' | 'ACCEPTED' | 'DISCARDED';

/** VulnImportEntry.matchConfidence (schema.prisma ~line 1110: nullable
 *  VarChar(30)). The 5-level cascade labels (matcher.ts `MatchConfidence`,
 *  lines 40-45) plus the two non-cascade labels service.ts assigns directly
 *  during upload ('AMBIGUOUS' / 'UNMATCHED', service.ts lines 108/112) plus
 *  the one patchEntry sets on manual CI reassignment ('MANUAL', service.ts
 *  line 240 comment: "'MANUAL' is not one of the matcher's cascade labels").
 *  Never null in practice once an entry exists (upload always assigns one of
 *  these), but the DB column is nullable so callers should treat it as
 *  possibly null defensively. */
export type MatchConfidence =
  | 'EXACT_IP'
  | 'EXACT_NAME'
  | 'EXACT_HOSTNAME'
  | 'EXACT_DNS'
  | 'FUZZY'
  | 'AMBIGUOUS'
  | 'UNMATCHED'
  | 'MANUAL';

/** matcher.ts `CICandidate` (lines 47-50) — the shape of one row inside
 *  VulnImportEntry.matchCandidates when matchConfidence === 'AMBIGUOUS'. */
export interface VulnImportCiCandidate {
  id: string;
  name: string;
}

/** classifier.ts `VulnClassification` (line 16). */
export type VulnImportClassification = 'NUEVA' | 'EXISTENTE_PENDIENTE' | 'REAPARECIDA';

/** classifier.ts `VulnDecision` (line 17); also schemas.ts `DecisionEnum` (line 89). */
export type VulnImportDecision = 'INCLUDE' | 'EXCLUDE';

/** schemas.ts `SeverityEnum` (line 88) — the *incoming Greenbone finding's*
 *  severity as validated on PATCH .../entries/:entryId. Identical value set
 *  to `VulnSeverity` above; kept as a distinct alias so a future divergence
 *  between "severity of a staged finding" and "severity of an accepted,
 *  stored Vulnerability" doesn't silently merge two different concepts. */
export type VulnImportSeverity = VulnSeverity;

// ─── VulnImportBatch (schema.prisma model VulnImportBatch, ~line 1084) ─────
//
// Field names below are the Prisma *client* field names (camelCase, as
// declared in the model — NOT the @map() snake_case DB column names), which
// is what actually crosses res.json(). DateTime fields serialize to ISO
// strings over JSON, never Date objects. Nullable Prisma fields are `| null`.
//
// `entryCount` / `byClassification` are added ONLY by queries.ts
// `listBatches()` (lines 137-141, via a groupBy query) — they do NOT appear
// on the batch returned by `getBatchWithEntries()` (queries.ts line 153,
// `prisma.vulnImportBatch.findUnique`, no augmentation). Rather than split
// this into two near-identical types that F2/F3 would have to remember to
// pick correctly, both fields are modeled here as optional: present (and
// should be used) from GET /batches, absent from GET /batches/:id.
export interface VulnImportBatch {
  id: string;
  source: string;
  filename: string;
  taskName: string | null;
  greenboneTaskId: string | null;
  scanStart: string | null;
  scanEnd: string | null;
  status: VulnImportBatchStatus;
  uploadedBy: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  rawMeta: unknown | null;
  /** Only present on batches returned by GET /api/vuln-import/batches (list). */
  entryCount?: number;
  /** Only present on batches returned by GET /api/vuln-import/batches (list).
   *  Keys are `VulnImportClassification` values; a classification with 0
   *  entries in this batch is simply absent from the map (groupBy semantics,
   *  queries.ts lines 129-134) — do not assume all three keys are present. */
  byClassification?: Partial<Record<VulnImportClassification, number>>;
}

// ─── VulnImportEntry (schema.prisma model VulnImportEntry, ~line 1105) ─────
export interface VulnImportEntry {
  id: string;
  batchId: string;
  hostAddress: string;
  ciId: string | null;
  matchConfidence: MatchConfidence | null;
  /** Populated (as `VulnImportCiCandidate[]`) only when matchConfidence ===
   *  'AMBIGUOUS' (service.ts line 109: `matchCandidates = match.candidates`);
   *  null in every other case, including after a manual reassignment
   *  (service.ts line 241: `data.matchCandidates = null`). */
  matchCandidates: VulnImportCiCandidate[] | null;
  vulnKey: string;
  oid: string;
  port: string | null;
  cves: string[];
  severityScore: number;
  severity: VulnImportSeverity;
  name: string;
  summary: string | null;
  solution: string | null;
  family: string | null;
  thread: string | null;
  qod: number | null;
  epssScore: number | null;
  /** Raw per-vulnerability Greenbone JSON as originally parsed — shape not
   *  contractually fixed here (parser.ts owns it); treat as opaque. */
  raw: unknown;
  existingStatus: VulnStatus | null;
  classification: VulnImportClassification;
  decision: VulnImportDecision;
  edited: boolean;
}

// ─── Request bodies (schemas.ts Zod schemas — mirror field-for-field) ──────

/** POST /api/vuln-import/upload body (schemas.ts `UploadRequestSchema`,
 *  lines 82-85). `report` is validated downstream by `GreenboneReportSchema`
 *  in the parser, not by the envelope schema — kept as `unknown` here too. */
export interface UploadRequestBody {
  filename?: string;
  report: unknown;
}

/** PATCH /api/vuln-import/batches/:id/entries/:entryId body (schemas.ts
 *  `PatchEntrySchema`, lines 95-102). All fields optional, but the backend
 *  rejects a body with none of the three present (`.refine`, line 99). */
export interface PatchEntryBody {
  ciId?: string;
  severity?: VulnImportSeverity;
  decision?: VulnImportDecision;
}

/** POST /api/vuln-import/batches/:id/entries/bulk-decision body (schemas.ts
 *  `BulkDecisionSchema`, lines 105-112). `filter` defaults to `{}` server-side
 *  if omitted (`.default({})`), but is required as a key on the body object
 *  per `.strict()` — pass `{}` explicitly rather than omitting the key. */
export interface BulkDecisionBody {
  filter: {
    classification?: VulnImportClassification;
    severity?: VulnImportSeverity;
    decision?: VulnImportDecision;
  };
  decision: VulnImportDecision;
}

// ─── Response types — one per endpoint, named after the endpoint ──────────

/** POST /upload → 201, res.json(result) where result: UploadResult
 *  (service.ts lines 56-59: { batchId, summary: UploadSummary }). */
export interface UploadSummary {
  totalEntries: number;
  matched: number;
  ambiguous: number;
  unmatched: number;
  nueva: number;
  existentePendiente: number;
  reaparecida: number;
  preselectedInclude: number;
}
export interface UploadResponse {
  batchId: string;
  summary: UploadSummary;
}

/** GET /batches → 200, res.json(result) where result = listBatches() return
 *  (service.ts lines 199-204: { batches, total, page, pageSize }). */
export interface ListBatchesResponse {
  batches: VulnImportBatch[];
  total: number;
  page: number;
  pageSize: number;
}

/** GET /batches/:id → 200, res.json(result) where result = getBatchDetail()
 *  return = getBatchWithEntries() return (queries.ts line 162:
 *  { batch, entries }). `batch` here will NOT have entryCount/byClassification
 *  populated (see VulnImportBatch's comment above) — they are `undefined`. */
export interface GetBatchDetailResponse {
  batch: VulnImportBatch;
  entries: VulnImportEntry[];
}

/** PATCH .../entries/:entryId → 200, res.json(updated) where updated is the
 *  raw Prisma-updated VulnImportEntry row (service.ts line 247 → queries.ts
 *  `updateEntry`, a plain `tx.vulnImportEntry.update(...)` — same shape as
 *  VulnImportEntry above, no wrapper). */
export type PatchEntryResponse = VulnImportEntry;

/** POST .../bulk-decision → 200, res.json({ updated: result.count })
 *  (router.ts line 113 — NOT the raw Prisma `updateMany` result, just the count). */
export interface BulkDecisionResponse {
  updated: number;
}

/** POST .../accept → 200, res.json(result.summary) — the router sends ONLY
 *  `.summary` (router.ts line 136), never the full AcceptResult (which also
 *  has `.touched`, used server-side only for RAG reindexing side effects and
 *  never serialized to the client). service.ts lines 288-293. */
export interface AcceptResponse {
  ciCount: number;
  newCount: number;
  reopenedCount: number;
  refreshedCount: number;
}

/** POST .../discard → 200, res.json(updated) — raw Prisma-updated
 *  VulnImportBatch row (service.ts line 280 → queries.ts `markBatchStatus`,
 *  a plain `tx.vulnImportBatch.update(...)`; same shape as VulnImportBatch
 *  above, without entryCount/byClassification). */
export type DiscardResponse = VulnImportBatch;

// ─── Error responses ────────────────────────────────────────────────────────
//
// Every route's catch block is enumerated in router.ts; shapes below cover
// every distinct error body the 7 endpoints can send. Callers should check
// `res.status` first, then narrow on shape only where it varies (422).

/** Generic `{error}` or `{error, details}` shape — used for: 400 invalid
 *  Greenbone report / invalid request body (`details` is a ZodIssue[] when
 *  present), 404 BATCH_NOT_FOUND / VulnImportEntry-not-found message, 409
 *  BATCH_NOT_PENDING, 422 CI_NOT_FOUND, 500 Internal server error. */
export interface VulnImportErrorResponse {
  error: string;
  details?: unknown;
}

/** service.ts `BlockingEntry` (line 35) — the shape of each item in the
 *  `entries` array on the 422 UNRESOLVED_MATCHES response from POST
 *  .../accept (router.ts line 141: `res.status(422).json({ error:
 *  'UNRESOLVED_MATCHES', entries: err.entries })`). Distinct from
 *  `VulnImportErrorResponse` because it carries a typed `entries` array, not
 *  a `details: unknown`. */
export interface VulnImportBlockingEntry {
  id: string;
  hostAddress: string;
  vulnKey: string;
  matchConfidence: string | null;
}
export interface UnresolvedMatchesErrorResponse {
  error: 'UNRESOLVED_MATCHES';
  entries: VulnImportBlockingEntry[];
}
