import { Prisma, PrismaClient } from '@prisma/client';
import type { Vulnerability } from '../integrations/types.js';

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

/** Creates a VulnImportBatch + all its VulnImportEntry rows in one nested
 *  Prisma write. Must be called with a transaction client so the caller can
 *  add the audit insert to the same `$transaction`. */
export async function createBatchWithEntries(tx: Prisma.TransactionClient, input: NewBatchInput) {
  return tx.vulnImportBatch.create({
    data: {
      source: input.source,
      filename: input.filename,
      taskName: input.taskName ?? null,
      greenboneTaskId: input.greenboneTaskId ?? null,
      scanStart: input.scanStart ?? null,
      scanEnd: input.scanEnd ?? null,
      status: 'PENDING',
      uploadedBy: input.uploadedBy,
      rawMeta: input.rawMeta === undefined ? Prisma.JsonNull : (input.rawMeta as Prisma.InputJsonValue),
      entries: {
        create: input.entries.map((e) => ({
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
        })),
      },
    },
    include: { entries: true },
  });
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
  classification?: string;
  severity?: string;
  decision?: string;
}

export async function getBatchWithEntries(prisma: PrismaOrTx, batchId: string, filter: EntryFilter) {
  const batch = await prisma.vulnImportBatch.findUnique({ where: { id: batchId } });
  if (!batch) return null;

  const where: Prisma.VulnImportEntryWhereInput = { batchId };
  if (filter.classification) where.classification = filter.classification;
  if (filter.severity) where.severity = filter.severity;
  if (filter.decision) where.decision = filter.decision;

  const entries = await prisma.vulnImportEntry.findMany({ where, orderBy: { name: 'asc' } });
  return { batch, entries };
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

export async function bulkUpdateDecision(
  tx: Prisma.TransactionClient,
  batchId: string,
  filter: EntryFilter,
  decision: string,
) {
  const where: Prisma.VulnImportEntryWhereInput = { batchId };
  if (filter.classification) where.classification = filter.classification;
  if (filter.severity) where.severity = filter.severity;
  if (filter.decision) where.decision = filter.decision;

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
