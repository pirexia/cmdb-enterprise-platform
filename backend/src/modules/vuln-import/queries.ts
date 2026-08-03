import { Prisma, PrismaClient } from '@prisma/client';
import type { VulnImportBatch } from '@prisma/client';
import type { Vulnerability } from '../integrations/types.js';
import { vulnImportAudit } from './audit.js';
// Reused rather than replicated — `modules/plugins/engine.ts` already
// imports from `../reports/registry.js`, so a cross-module import inside
// `modules/` is an established pattern in this repo, not a new precedent.
// `asArray` normalises both `?severity=A` (string) and `?severity=A&severity=B`
// (array) to a string[] so `{ in: asArray(v) }` is always a valid Prisma
// filter — see its doc comment in filterUtils.ts for the P2 root cause this
// avoids (`{ in: 'A' }` throws).
import { asArray } from '../reports/filterUtils.js';

// DB access layer for the vuln-import staging module. Business logic
// (parsing/matching/classification orchestration, the accept transaction)
// lives in service.ts — this file only shapes queries against
// VulnImportBatch/VulnImportEntry (real Prisma models, see
// backend/prisma/schema.prisma) and the CI `vulnerabilities` JSON column
// (still raw SQL — no Prisma model backs it, same pattern as
// modules/integrations/router.ts).

export type PrismaOrTx = PrismaClient | Prisma.TransactionClient;

// ─── VulnImportEntry input shape (upload-time) ─────────────────────────────

export interface NewEntryInput {
  hostAddress: string;
  ciId: string | null;
  matchConfidence: string | null;
  matchCandidates: unknown | null;
  vulnKey: string;
  /** Greenbone-specific (OpenVAS plugin id); null for CrowdStrike-sourced entries. */
  oid: string | null;
  port: string | null;
  cves: string[];
  severityScore: number;
  severity: string;
  name: string;
  summary: string | null;
  solution: string | null;
  family: string | null;
  thread: string | null;
  qod: number | null;
  epssScore: number | null;
  raw: unknown;
  existingStatus: string | null;
  classification: string;
  decision: string;
  // CrowdStrike Spotlight fields (v3.6.1) — null/false/[] for Greenbone
  // entries, which never set these. Mirrors VulnImportEntry's columns.
  products: string[];
  exprtRating: string | null;
  cisaKev: boolean;
  cisaDueDate: Date | null;
  exploitStatus: string | null;
  daysOpen: number | null;
  externalStatus: string | null;
  cvssVersion: string | null;
  redhatImpact: string | null;
  knownExploit: boolean | null;
  publicDate: Date | null;
}

export interface NewBatchInput {
  source: string;
  filename: string;
  taskName?: string | null;
  greenboneTaskId?: string | null;
  scanStart?: Date | null;
  scanEnd?: Date | null;
  uploadedBy: string;
  rawMeta?: unknown;
  entries: NewEntryInput[];
}

/** Batch metadata without the entries — what `createBatchShell` needs. Split
 *  out so callers building a large `entries` array don't have to thread it
 *  through the batch-creation step; see `writeBatchEntries` below, which
 *  takes entries separately and outside any transaction. */
export type NewBatchMeta = Omit<NewBatchInput, 'entries'>;

// Chunk size for the entries createMany calls below. Live verification with
// a real Red Hat Lightspeed pull (13,868 entries in one batch) hit
// `RangeError: Invalid string length` when the original implementation
// nested all entries under a single `vulnImportBatch.create({data:{entries:
// {create:[...]}}})` — Prisma serializes that whole nested write as one
// JSON payload for the query engine, and it exceeded V8's max string
// length. 500 per chunk keeps each createMany call's payload comfortably
// small regardless of how large `raw` happens to be per entry.
const ENTRY_CHUNK_SIZE = 500;

function toEntryCreateInput(batchId: string, e: NewEntryInput) {
  return {
    batchId,
    hostAddress: e.hostAddress,
    ciId: e.ciId,
    matchConfidence: e.matchConfidence,
    matchCandidates: e.matchCandidates === null ? Prisma.JsonNull : (e.matchCandidates as Prisma.InputJsonValue),
    vulnKey: e.vulnKey,
    oid: e.oid,
    port: e.port,
    cves: e.cves,
    severityScore: e.severityScore,
    severity: e.severity,
    name: e.name,
    summary: e.summary,
    solution: e.solution,
    family: e.family,
    thread: e.thread,
    qod: e.qod,
    epssScore: e.epssScore,
    raw: e.raw as Prisma.InputJsonValue,
    existingStatus: e.existingStatus,
    classification: e.classification,
    decision: e.decision,
    products: e.products,
    exprtRating: e.exprtRating,
    cisaKev: e.cisaKev,
    cisaDueDate: e.cisaDueDate,
    exploitStatus: e.exploitStatus,
    daysOpen: e.daysOpen,
    externalStatus: e.externalStatus,
    cvssVersion: e.cvssVersion,
    redhatImpact: e.redhatImpact,
    knownExploit: e.knownExploit,
    publicDate: e.publicDate,
  };
}

/** Creates only the VulnImportBatch row, in a short transaction the caller
 *  provides. Status starts as `RUNNING` (not `PENDING`) — the batch isn't
 *  ready for operator review until `finalizeBatch` moves it to `PENDING`
 *  once every entry has actually been written. This is deliberately split
 *  from entry-writing (see `writeBatchEntries`) so a batch with thousands
 *  of entries never holds a single interactive transaction open for the
 *  whole write — that was the root cause of the timeout this refactor
 *  fixes (see `writeBatchEntries`'s comment for the concrete failure). */
export async function createBatchShell(
  tx: Prisma.TransactionClient,
  meta: NewBatchMeta,
): Promise<VulnImportBatch> {
  return tx.vulnImportBatch.create({
    data: {
      source: meta.source,
      filename: meta.filename,
      taskName: meta.taskName ?? null,
      greenboneTaskId: meta.greenboneTaskId ?? null,
      scanStart: meta.scanStart ?? null,
      scanEnd: meta.scanEnd ?? null,
      status: 'RUNNING',
      uploadedBy: meta.uploadedBy,
      rawMeta: meta.rawMeta === undefined ? Prisma.JsonNull : (meta.rawMeta as Prisma.InputJsonValue),
    },
  });
}

/** Writes VulnImportEntry rows for a batch via chunked `createMany` calls,
 *  deliberately run directly on the base `PrismaClient` — NOT inside any
 *  `$transaction`. Live verification with a real Red Hat Lightspeed pull
 *  (13,868 entries in one batch) hit two failures from the original
 *  single-transaction design: (1) `RangeError: Invalid string length` when
 *  every entry was nested under one `vulnImportBatch.create({data:{entries:
 *  {create:[...]}}})` call — Prisma serializes that whole nested write as
 *  one JSON payload for the query engine, and it exceeded V8's max string
 *  length; and (2) even after chunking, wrapping thousands of sequential
 *  `createMany` calls inside a single interactive transaction held a DB
 *  connection + row locks open long enough to hit Prisma's interactive
 *  transaction timeout. Running the chunk loop outside any transaction
 *  avoids both: each `createMany` call commits independently, and no call's
 *  payload grows with the total entry count regardless of how large `raw`
 *  happens to be per entry. */
export async function writeBatchEntries(
  prisma: PrismaClient,
  batchId: string,
  entries: NewEntryInput[],
  onProgress?: (written: number, total: number) => void,
): Promise<void> {
  const total = entries.length;
  let written = 0;
  for (let i = 0; i < entries.length; i += ENTRY_CHUNK_SIZE) {
    const chunk = entries.slice(i, i + ENTRY_CHUNK_SIZE);
    await prisma.vulnImportEntry.createMany({
      data: chunk.map((e) => toEntryCreateInput(batchId, e)),
    });
    written += chunk.length;
    onProgress?.(written, total);
  }
}

/** Moves a batch out of `RUNNING` into its terminal upload-time state — a
 *  short transaction the caller provides, so the status update and its
 *  audit record commit atomically (ISO 27001 A.8.15 — see `vulnImportAudit`'s
 *  comment). `PENDING` means the batch is ready for operator review, exactly
 *  what the old `createBatchWithEntries` used to set unconditionally on
 *  success; `FAILED` records `errorMessage` for a batch whose entry-write
 *  loop (`writeBatchEntries`, run outside this transaction) didn't complete.
 *  The audited `userEmail` is read back off the batch row itself
 *  (`uploadedBy`, set by `createBatchShell`) rather than threaded through
 *  as a parameter — the caller already committed to that value when it
 *  created the batch. */
export async function finalizeBatch(
  tx: Prisma.TransactionClient,
  batchId: string,
  status: 'PENDING' | 'FAILED',
  errorMessage?: string | null,
): Promise<void> {
  const batch = await tx.vulnImportBatch.update({
    where: { id: batchId },
    data: {
      status,
      errorMessage: status === 'FAILED' ? (errorMessage ?? null) : null,
    },
  });

  const action = status === 'FAILED' ? 'VULN_IMPORT_FAILED' : 'VULN_IMPORT_UPLOAD';
  await vulnImportAudit(tx, action, 'VulnImportBatch', batch.id, batch.uploadedBy, {
    status,
    ...(status === 'FAILED' && errorMessage ? { errorMessage } : {}),
  });
}

/** Recovers batches orphaned by a backend restart mid-import (Task 4 made
 *  Red Hat Lightspeed pulls run as a background async job — see
 *  `writeBatchEntries`'s comment for why the entry-write loop deliberately
 *  runs outside a transaction and can take a while for a large pull). If the
 *  process dies (crash, redeploy, `SIGTERM` before an in-flight import
 *  finishes) while a batch's status is still `RUNNING`, no code path is ever
 *  going to move it to `PENDING`/`FAILED` again — the request that would
 *  have called `finalizeBatch` is gone. Only one backend process writes
 *  these rows today, so any `RUNNING` batch found here, at the moment the
 *  process is starting up, is necessarily such an orphan, not a
 *  concurrently-running import from another process.
 *
 *  Single `$executeRaw` UPDATE, no transaction needed (one statement), no
 *  per-row `AuditLog` entry — unlike `finalizeBatch`, which audits
 *  operator-triggered transitions, this is a startup-recovery sweep with no
 *  responsible user to attribute it to; the batch's own `status`/
 *  `errorMessage` already records what happened. */
export async function recoverOrphanedRunningBatches(prisma: PrismaClient): Promise<number> {
  const affected = await prisma.$executeRaw`
    UPDATE "vuln_import_batches"
    SET "status" = 'FAILED', "error_message" = 'Interrumpido por reinicio del servidor'
    WHERE "status" = 'RUNNING'
  `;
  return affected;
}

export interface BatchListFilter {
  status?: string;
  page: number;
  pageSize: number;
}

export async function listBatches(prisma: PrismaOrTx, filter: BatchListFilter) {
  const where = filter.status ? { status: filter.status } : {};
  const [batches, total] = await Promise.all([
    prisma.vulnImportBatch.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (filter.page - 1) * filter.pageSize,
      take: filter.pageSize,
      include: {
        _count: { select: { entries: true } },
      },
    }),
    prisma.vulnImportBatch.count({ where }),
  ]);

  // Per-batch classification breakdown — one groupBy query rather than
  // fetching every entry row just to count them.
  const batchIds = batches.map((b) => b.id);
  const byClassification = batchIds.length
    ? await prisma.vulnImportEntry.groupBy({
        by: ['batchId', 'classification'],
        where: { batchId: { in: batchIds } },
        _count: { _all: true },
      })
    : [];

  const classificationMap = new Map<string, Record<string, number>>();
  for (const row of byClassification) {
    const existing = classificationMap.get(row.batchId) ?? {};
    existing[row.classification] = row._count._all;
    classificationMap.set(row.batchId, existing);
  }

  return {
    batches: batches.map((b) => ({
      ...b,
      entryCount: b._count.entries,
      byClassification: classificationMap.get(b.id) ?? {},
    })),
    total,
  };
}

export interface EntryFilter {
  // classification/severity/matchConfidence accept either a single value
  // (unchanged behaviour) or an array — the review screen's tabs are unions
  // of several values (e.g. "Accionables" = severity MEDIUM+HIGH+CRITICAL)
  // and need "page N of the union" in one query (task-8c brief). `decision`
  // stays single-value on purpose: no tab is a union of decisions.
  classification?: string | string[];
  severity?: string | string[];
  decision?: string;
  matchConfidence?: string | string[];
  page?: number;
  pageSize?: number;
}

// Representation for VulnImportEntry.matchConfidence rows where the DB
// column is null (schema.prisma ~line 1115: `String? @db.VarChar(30)`) — in
// practice this never happens post-upload (service.ts always assigns one of
// the matcher cascade labels or 'AMBIGUOUS'/'UNMATCHED'/'MANUAL'), but the
// groupBy aggregate below must still give a defined key for any row that
// somehow has a null value, rather than silently dropping its count or
// producing an object key of the literal string "null". Chosen to read
// clearly in the "Requiere atención" tab's counts alongside the other
// match-confidence labels.
export const NO_MATCH_CONFIDENCE_KEY = 'NONE';

// A real Red Hat Lightspeed pull lands ~13,868 entries in a single batch,
// each carrying its full `raw` jsonb blob — an unpaginated `findMany` here
// is tens of MB in one response (see writeBatchEntries's comment for the
// same order-of-magnitude problem on the write side). 100 mirrors the same
// ceiling `listBatches`'s caller (service.ts's `listBatches`) already
// applies to batch listing, so both paginated endpoints in this module
// share one page-size cap instead of drifting apart.
export const MAX_ENTRY_PAGE_SIZE = 100;

export async function getBatchWithEntries(prisma: PrismaOrTx, batchId: string, filter: EntryFilter) {
  const batch = await prisma.vulnImportBatch.findUnique({ where: { id: batchId } });
  if (!batch) return null;

  const where: Prisma.VulnImportEntryWhereInput = { batchId };
  const classificationValues = asArray(filter.classification);
  if (classificationValues) where.classification = { in: classificationValues };
  const severityValues = asArray(filter.severity);
  if (severityValues) where.severity = { in: severityValues };
  if (filter.decision) where.decision = filter.decision;
  const matchConfidenceValues = asArray(filter.matchConfidence);
  if (matchConfidenceValues) where.matchConfidence = { in: matchConfidenceValues };

  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(MAX_ENTRY_PAGE_SIZE, Math.max(1, filter.pageSize ?? 50));

  const [entries, total, byClassificationRaw, bySeverityRaw, byMatchConfidenceRaw, ciGroups] = await Promise.all([
    prisma.vulnImportEntry.findMany({
      where,
      orderBy: { name: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.vulnImportEntry.count({ where }),
    // Classification/severity/matchConfidence counts for the review screen's
    // tabs ("Accionables"/"Informativas" by severity, "Requieren atención" by
    // matchConfidence, "Reaparecidas" by classification — task-8b brief) must
    // reflect the WHOLE batch (minus whatever filter narrowed `where` above),
    // not just the current page — aggregated via groupBy rather than
    // counting the loaded page in memory, same pattern as listBatches'
    // `byClassification` above. All three share the exact same `where` as
    // `findMany`/`count` so a filtered request's counts stay consistent with
    // its page.
    prisma.vulnImportEntry.groupBy({
      by: ['classification'],
      where,
      _count: { _all: true },
    }),
    prisma.vulnImportEntry.groupBy({
      by: ['severity'],
      where,
      _count: { _all: true },
    }),
    prisma.vulnImportEntry.groupBy({
      by: ['matchConfidence'],
      where,
      _count: { _all: true },
    }),
    // Distinct-CI count (task 10, v3.7.0): the "Aceptar" confirmation dialog
    // needs "how many distinct CIs will be touched", which none of the three
    // groupBys above can answer — they group on a column with a fixed small
    // set of values, not on ciId. One extra groupBy on ciId, same shared
    // `where` (so it respects whatever filter narrowed the request, e.g.
    // `?decision=INCLUDE` for the accept preview), excluding null ciId rows
    // (an UNMATCHED/AMBIGUOUS entry has no CI yet and must not count as one).
    // `ciGroups.length` = number of distinct non-null ciId values in the
    // filtered set — this is the whole point of grouping rather than
    // counting rows.
    prisma.vulnImportEntry.groupBy({
      by: ['ciId'],
      where: { ...where, ciId: { not: null } },
      _count: true,
    }),
  ]);

  const byClassification: Record<string, number> = {};
  for (const row of byClassificationRaw) {
    byClassification[row.classification] = row._count._all;
  }

  const bySeverity: Record<string, number> = {};
  for (const row of bySeverityRaw) {
    bySeverity[row.severity] = row._count._all;
  }

  // matchConfidence is nullable in the DB (see NO_MATCH_CONFIDENCE_KEY's
  // comment) — groupBy returns a row with matchConfidence: null for those,
  // which we fold into the NO_MATCH_CONFIDENCE_KEY bucket rather than a
  // key literally named "null".
  const byMatchConfidence: Record<string, number> = {};
  for (const row of byMatchConfidenceRaw) {
    const key = row.matchConfidence ?? NO_MATCH_CONFIDENCE_KEY;
    byMatchConfidence[key] = row._count._all;
  }

  const ciCount = ciGroups.length;

  return { batch, entries, total, page, pageSize, byClassification, bySeverity, byMatchConfidence, ciCount };
}

export async function getBatch(prisma: PrismaOrTx, batchId: string) {
  return prisma.vulnImportBatch.findUnique({ where: { id: batchId } });
}

export async function getEntry(prisma: PrismaOrTx, batchId: string, entryId: string) {
  return prisma.vulnImportEntry.findFirst({ where: { id: entryId, batchId } });
}

export async function getAllEntriesForBatch(prisma: PrismaOrTx, batchId: string) {
  return prisma.vulnImportEntry.findMany({ where: { batchId } });
}

export async function updateEntry(
  tx: Prisma.TransactionClient,
  entryId: string,
  data: { ciId?: string; matchConfidence?: string; severity?: string; decision?: string },
) {
  return tx.vulnImportEntry.update({
    where: { id: entryId },
    data: { ...data, edited: true },
  });
}

// bulkUpdateDecision intentionally does NOT accept the multi-value EntryFilter
// (task-8c brief — out of scope: the frontend already resolves severity
// unions here by calling once per value, the existing pattern for
// "Accionables"). Its only caller (service.ts's bulkDecision) passes
// BulkDecisionBody['filter'], whose fields are single Zod-enum strings, so
// this narrower type is exactly what already flows through in practice.
interface SingleValueEntryFilter {
  classification?: string;
  severity?: string;
  decision?: string;
  matchConfidence?: string;
}

export async function bulkUpdateDecision(
  tx: Prisma.TransactionClient,
  batchId: string,
  filter: SingleValueEntryFilter,
  decision: string,
) {
  const where: Prisma.VulnImportEntryWhereInput = { batchId };
  if (filter.classification) where.classification = filter.classification;
  if (filter.severity) where.severity = filter.severity;
  if (filter.decision) where.decision = filter.decision;
  if (filter.matchConfidence) where.matchConfidence = filter.matchConfidence;

  return tx.vulnImportEntry.updateMany({ where, data: { decision, edited: true } });
}

export async function markBatchStatus(
  tx: Prisma.TransactionClient,
  batchId: string,
  status: string,
  resolvedBy: string,
) {
  return tx.vulnImportBatch.update({
    where: { id: batchId },
    data: { status, resolvedAt: new Date(), resolvedBy },
  });
}

// ─── CI existence + `vulnerabilities` JSON column (raw SQL — no Prisma model) ──

export async function ciExists(client: PrismaOrTx, ciId: string): Promise<boolean> {
  const rows = await client.$queryRaw<{ id: string }[]>`
    SELECT id FROM "configuration_items" WHERE id = ${ciId}::uuid LIMIT 1
  `;
  return rows.length > 0;
}

export async function getCiVulnerabilities(client: PrismaOrTx, ciId: string): Promise<Vulnerability[]> {
  const rows = await client.$queryRaw<{ vulnerabilities: unknown }[]>`
    SELECT vulnerabilities FROM "configuration_items" WHERE id = ${ciId}::uuid LIMIT 1
  `;
  return (rows[0]?.vulnerabilities as Vulnerability[] | undefined) ?? [];
}

export async function updateCiVulnerabilities(
  tx: Prisma.TransactionClient,
  ciId: string,
  vulnerabilities: Vulnerability[],
): Promise<void> {
  await tx.$executeRaw`
    UPDATE "configuration_items"
    SET "vulnerabilities" = ${JSON.stringify(vulnerabilities)}::jsonb
    WHERE "id" = ${ciId}::uuid
  `;
}
