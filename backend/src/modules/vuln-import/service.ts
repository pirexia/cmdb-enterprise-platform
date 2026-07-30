import { Prisma, PrismaClient } from '@prisma/client';
import type { Vulnerability, VulnSeverity } from '../integrations/types.js';
import { parseGreenboneReport, type ParsedGreenboneScan } from './parser.js';
import { parseCrowdStrikeReport } from './crowdstrikeParser.js';
import { matchHost, type MatchResult } from './matcher.js';
import { classifyVulnerability } from './classifier.js';
import { vulnImportAudit } from './audit.js';
import {
  createBatchWithEntries, listBatches as queryListBatches, getBatchWithEntries,
  getBatch, getEntry, getAllEntriesForBatch, updateEntry, bulkUpdateDecision,
  markBatchStatus, ciExists, getCiVulnerabilities, updateCiVulnerabilities,
  type NewBatchInput, type NewEntryInput, type EntryFilter,
} from './queries.js';
import type { UploadRequestBody, PatchEntryBody, BulkDecisionBody } from './schemas.js';

// Business-logic orchestration for the Greenbone staging/review workflow.
// Spec: docs/internal/specs/2026-07-29-v3.6.0-greenbone-real-format-staging.md
// §D4 (staging persistence), §D5 (classification), §D6 (REABIERTA + alert
// surfacing — B6), §D7 (default premarking), §D8 (accept is transactional),
// §D9 (module boundaries).

// ─── Typed errors — router maps these to HTTP status codes ─────────────────

export class BatchNotFoundError extends Error {
  constructor(batchId: string) { super(`VulnImportBatch not found: ${batchId}`); this.name = 'BatchNotFoundError'; }
}
export class EntryNotFoundError extends Error {
  constructor(entryId: string) { super(`VulnImportEntry not found: ${entryId}`); this.name = 'EntryNotFoundError'; }
}
export class BatchNotPendingError extends Error {
  constructor(public status: string) { super(`Batch is not PENDING (current status: ${status}).`); this.name = 'BatchNotPendingError'; }
}
export class CiNotFoundError extends Error {
  constructor(ciId: string) { super(`CI not found: ${ciId}`); this.name = 'CiNotFoundError'; }
}
export interface BlockingEntry { id: string; hostAddress: string; vulnKey: string; matchConfidence: string | null }
export class BlockingAmbiguityError extends Error {
  constructor(public entries: BlockingEntry[]) {
    super('Cannot accept: batch has INCLUDEd entries with an unresolved CI match (AMBIGUOUS/UNMATCHED). Reassign or exclude them first.');
    this.name = 'BlockingAmbiguityError';
  }
}

// ─── Upload ─────────────────────────────────────────────────────────────────

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

export interface UploadResult {
  batchId: string;
  summary: UploadSummary;
}

function safeDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The two report sources this module can stage. */
export type VulnImportSource = 'greenbone' | 'crowdstrike';

/**
 * Structural auto-detection used by the generic `/api/vuln-import/upload`
 * endpoint, which accepts either format without the caller saying which:
 * CrowdStrike Spotlight's real export is always a flat top-level array;
 * Greenbone's is always a top-level object (`{allHostSubreportEntries: […]}`).
 * Callers that have ALREADY determined the source structurally (e.g.
 * `/api/integrations/crowdstrike`'s format-branching, see integrations
 * router.ts) should pass `source` explicitly instead of relying on this.
 */
function detectSource(report: unknown): VulnImportSource {
  return Array.isArray(report) ? 'crowdstrike' : 'greenbone';
}

/**
 * Parses, matches, and classifies a raw vulnerability report (Greenbone or
 * CrowdStrike Spotlight), then persists the resulting batch + entries as
 * PENDING in one transaction (+ audit row).
 *
 * `source` selects the parser explicitly. When omitted, it is
 * structurally auto-detected from `body.report` (see `detectSource`) — this
 * is what lets `POST /api/vuln-import/upload` accept either format without
 * the caller declaring it.
 *
 * Throws `UnsupportedGreenboneFormatError`/`UnsupportedCrowdStrikeFormatError`
 * or a Zod `ZodError` on a structurally invalid report — router maps all of
 * these to 400.
 */
export async function uploadReport(
  prisma: PrismaClient,
  body: UploadRequestBody,
  userEmail: string,
  source: VulnImportSource = detectSource(body.report),
): Promise<UploadResult> {
  const parsed = source === 'crowdstrike'
    ? parseCrowdStrikeReport(body.report)
    : parseGreenboneReport(body.report);

  // Group entries by host so the matching cascade runs once per distinct
  // host, not once per vulnerability (per spec — matching is a host-level
  // concern; classification is per-vulnerability).
  const hostAddresses = [...new Set(parsed.entries.map((e) => e.hostAddress))];
  const matchByHost = new Map<string, MatchResult>();
  for (const host of hostAddresses) {
    matchByHost.set(host, await matchHost(prisma, { ip: host }));
  }

  // Cache the matched CI's stored vulnerabilities so a host with many
  // vulnerabilities doesn't re-fetch the same CI row per entry.
  const storedVulnsByCi = new Map<string, Vulnerability[]>();

  const newEntries: NewEntryInput[] = [];
  const summary: UploadSummary = {
    totalEntries: 0, matched: 0, ambiguous: 0, unmatched: 0,
    nueva: 0, existentePendiente: 0, reaparecida: 0, preselectedInclude: 0,
  };

  for (const entry of parsed.entries) {
    const match = matchByHost.get(entry.hostAddress)!;

    let ciId: string | null = null;
    let matchConfidence: string;
    let matchCandidates: unknown | null = null;

    if (match.confidence === 'AMBIGUOUS') {
      matchConfidence = 'AMBIGUOUS';
      matchCandidates = match.candidates;
      summary.ambiguous++;
    } else if (match.confidence === 'UNMATCHED') {
      matchConfidence = 'UNMATCHED';
      summary.unmatched++;
    } else {
      ciId = match.ci.id;
      matchConfidence = match.confidence;
      summary.matched++;
    }

    let storedVulns: Vulnerability[] | null = null;
    if (ciId) {
      if (!storedVulnsByCi.has(ciId)) {
        storedVulnsByCi.set(ciId, await getCiVulnerabilities(prisma, ciId));
      }
      storedVulns = storedVulnsByCi.get(ciId)!;
    }

    // externalStatus/cisaKev/exploitStatus are only ever set on
    // CrowdStrike-sourced entries — Greenbone entries simply leave them
    // undefined, so passing them through unconditionally for both sources
    // is safe and avoids branching on `source` here.
    const classification = classifyVulnerability({
      key: entry.key,
      severity: entry.severity,
      externalStatus: entry.externalStatus,
      cisaKev: entry.cisaKev,
      exploitStatus: entry.exploitStatus,
    }, storedVulns);

    switch (classification.classification) {
      case 'NUEVA': summary.nueva++; break;
      case 'EXISTENTE_PENDIENTE': summary.existentePendiente++; break;
      case 'REAPARECIDA': summary.reaparecida++; break;
    }
    if (classification.decision === 'INCLUDE') summary.preselectedInclude++;

    newEntries.push({
      hostAddress: entry.hostAddress,
      ciId,
      matchConfidence,
      matchCandidates,
      vulnKey: entry.key,
      oid: entry.oid ?? null,
      port: entry.port || null,
      cves: entry.cves,
      severityScore: entry.severityScore,
      severity: entry.severity,
      name: entry.name,
      summary: entry.summary || null,
      solution: entry.solution || null,
      family: entry.family || null,
      thread: entry.thread || null,
      qod: entry.qod ?? null,
      epssScore: entry.epssScore ?? null,
      raw: entry.raw,
      existingStatus: classification.existingStatus,
      classification: classification.classification,
      decision: classification.decision,
      // CrowdStrike Spotlight fields (v3.6.1) — undefined/absent on
      // Greenbone-sourced entries, normalized to their column defaults here
      // exactly like the Greenbone-specific fields above.
      products: entry.products ?? [],
      exprtRating: entry.exprtRating ?? null,
      cisaKev: entry.cisaKev ?? false,
      cisaDueDate: safeDate(entry.cisaDueDate),
      exploitStatus: entry.exploitStatus ?? null,
      daysOpen: entry.daysOpen ?? null,
      externalStatus: entry.externalStatus ?? null,
      cvssVersion: entry.cvssVersion ?? null,
    });
  }
  summary.totalEntries = newEntries.length;

  const filename = body.filename?.trim() || `${source}-import-${Date.now()}.json`;

  // rawMeta preserves top-level scan metadata for later display, minus the
  // (potentially large) per-host vulnerability payload already normalized
  // into entries. Greenbone-only: CrowdStrike's flat export carries no
  // scan-level metadata (see crowdstrikeParser.ts's `ParsedCrowdStrikeScan`
  // doc comment), and `body.report` there is the flat array itself — naively
  // spreading it as `rawMeta` would produce a numeric-keyed object mirroring
  // the entire (potentially huge) entry list, which is exactly what rawMeta
  // is meant to exclude.
  let rawMeta: Record<string, unknown> | undefined;
  if (source === 'greenbone') {
    const rawInput = body.report as Record<string, unknown>;
    const { allHostSubreportEntries: _omit, ...meta } = rawInput ?? {};
    void _omit;
    rawMeta = meta;
  }

  // Scan-level metadata (taskName/greenboneTaskId/scanStart/scanEnd) only
  // exists on the Greenbone side of the `parsed` union — CrowdStrike's flat
  // export carries none of it (see `ParsedCrowdStrikeScan`'s doc comment).
  const greenboneMeta = source === 'greenbone' ? (parsed as ParsedGreenboneScan) : null;
  const taskName = greenboneMeta?.taskName ?? null;
  const greenboneTaskId = greenboneMeta?.greenboneTaskId ?? null;
  const scanStart = greenboneMeta ? safeDate(greenboneMeta.scanStart) : null;
  const scanEnd = greenboneMeta ? safeDate(greenboneMeta.scanEnd) : null;

  const batchInput: NewBatchInput = {
    source,
    filename,
    taskName,
    greenboneTaskId,
    scanStart,
    scanEnd,
    uploadedBy: userEmail,
    rawMeta,
    entries: newEntries,
  };

  const batch = await prisma.$transaction(async (tx) => {
    const created = await createBatchWithEntries(tx, batchInput);
    await vulnImportAudit(tx, 'VULN_IMPORT_UPLOAD', 'VulnImportBatch', created.id, userEmail, {
      filename, hostCount: hostAddresses.length, ...summary,
    });
    return created;
  });

  return { batchId: batch.id, summary };
}

// ─── List / get ─────────────────────────────────────────────────────────────

export interface ListBatchesParams { status?: string; page?: number; pageSize?: number }

export async function listBatches(prisma: PrismaClient, params: ListBatchesParams) {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));
  const { batches, total } = await queryListBatches(prisma, { status: params.status, page, pageSize });
  return { batches, total, page, pageSize };
}

export async function getBatchDetail(prisma: PrismaClient, batchId: string, filter: EntryFilter) {
  const result = await getBatchWithEntries(prisma, batchId, filter);
  if (!result) throw new BatchNotFoundError(batchId);
  return result;
}

// ─── Edit / bulk-decision ───────────────────────────────────────────────────

export async function patchEntry(
  prisma: PrismaClient,
  batchId: string,
  entryId: string,
  body: PatchEntryBody,
  userEmail: string,
) {
  const batch = await getBatch(prisma, batchId);
  if (!batch) throw new BatchNotFoundError(batchId);
  if (batch.status !== 'PENDING') throw new BatchNotPendingError(batch.status);

  const entry = await getEntry(prisma, batchId, entryId);
  if (!entry) throw new EntryNotFoundError(entryId);

  if (body.ciId !== undefined) {
    const exists = await ciExists(prisma, body.ciId);
    if (!exists) throw new CiNotFoundError(body.ciId);
  }

  const data: { ciId?: string; matchConfidence?: string; matchCandidates?: null; severity?: string; decision?: string } = {};
  if (body.ciId !== undefined) {
    data.ciId = body.ciId;
    // A manual reassignment resolves ambiguity/no-match by definition —
    // 'MANUAL' is not one of the matcher's cascade labels, it flags this
    // entry as operator-corrected and (crucially) is neither 'AMBIGUOUS' nor
    // 'UNMATCHED', so it no longer blocks accept (see acceptBatch).
    data.matchConfidence = 'MANUAL';
    data.matchCandidates = null;
  }
  if (body.severity !== undefined) data.severity = body.severity;
  if (body.decision !== undefined) data.decision = body.decision;

  return prisma.$transaction(async (tx) => {
    const updated = await updateEntry(tx, entryId, data);
    await vulnImportAudit(tx, 'VULN_IMPORT_EDIT', 'VulnImportBatch', batchId, userEmail, { entryId, changes: body });
    return updated;
  });
}

export async function bulkDecision(
  prisma: PrismaClient,
  batchId: string,
  body: BulkDecisionBody,
  userEmail: string,
) {
  const batch = await getBatch(prisma, batchId);
  if (!batch) throw new BatchNotFoundError(batchId);
  if (batch.status !== 'PENDING') throw new BatchNotPendingError(batch.status);

  return prisma.$transaction(async (tx) => {
    const result = await bulkUpdateDecision(tx, batchId, body.filter, body.decision);
    await vulnImportAudit(tx, 'VULN_IMPORT_EDIT', 'VulnImportBatch', batchId, userEmail, {
      bulk: true, filter: body.filter, decision: body.decision, count: result.count,
    });
    return result;
  });
}

// ─── Discard ────────────────────────────────────────────────────────────────

export async function discardBatch(prisma: PrismaClient, batchId: string, userEmail: string) {
  const batch = await getBatch(prisma, batchId);
  if (!batch) throw new BatchNotFoundError(batchId);
  if (batch.status !== 'PENDING') throw new BatchNotPendingError(batch.status);

  return prisma.$transaction(async (tx) => {
    const updated = await markBatchStatus(tx, batchId, 'DISCARDED', userEmail);
    await vulnImportAudit(tx, 'VULN_IMPORT_DISCARD', 'VulnImportBatch', batchId, userEmail);
    return updated;
  });
}

// ─── Accept — the core transactional operation (spec D8) ───────────────────

export interface AcceptSummary {
  ciCount: number;
  newCount: number;
  reopenedCount: number;
  refreshedCount: number;
}
export interface TouchedCi { ciId: string; vulnKeys: string[] }
export interface AcceptResult { summary: AcceptSummary; touched: TouchedCi[] }

/** Builds a brand-new stored `Vulnerability` from an included entry (used
 *  both for genuinely NUEVA entries and as the defensive REAPARECIDA
 *  fallback when the previously-matched stored entry can no longer be found
 *  — see the comment at its one call site below). */
function buildNewVulnerability(entry: {
  vulnKey: string; cves: string[]; oid: string | null; port: string | null; severity: string;
  summary: string | null; name: string; severityScore: number; family: string | null;
  solution: string | null; qod: number | null; epssScore: number | null;
  products: string[]; exprtRating: string | null; cisaKev: boolean; cisaDueDate: Date | null;
  exploitStatus: string | null; daysOpen: number | null; externalStatus: string | null;
  cvssVersion: string | null;
}, now: string, source: string): Vulnerability {
  return {
    key: entry.vulnKey,
    cve: entry.cves[0] ?? '',
    cves: entry.cves,
    oid: entry.oid ?? undefined,
    port: entry.port ?? undefined,
    severity: entry.severity as VulnSeverity,
    description: entry.summary || entry.name,
    source,
    cvss_score: entry.severityScore,
    status: 'NUEVO',
    importedAt: now,
    lastSeenAt: now,
    family: entry.family ?? undefined,
    solution: entry.solution ?? undefined,
    qod: entry.qod ?? undefined,
    epssScore: entry.epssScore ?? undefined,
    // CrowdStrike Spotlight fields (v3.6.1) — undefined/false/[] for
    // Greenbone-sourced entries, mirroring the qod/epssScore pattern above.
    products: entry.products,
    exprtRating: entry.exprtRating ?? undefined,
    cisaKev: entry.cisaKev,
    cisaDueDate: entry.cisaDueDate ? entry.cisaDueDate.toISOString() : undefined,
    exploitStatus: entry.exploitStatus ?? undefined,
    daysOpen: entry.daysOpen ?? undefined,
    externalStatus: entry.externalStatus ?? undefined,
    cvssVersion: entry.cvssVersion ?? undefined,
  };
}

export async function acceptBatch(
  prisma: PrismaClient,
  batchId: string,
  userEmail: string,
): Promise<AcceptResult> {
  const batch = await getBatch(prisma, batchId);
  if (!batch) throw new BatchNotFoundError(batchId);
  if (batch.status !== 'PENDING') throw new BatchNotPendingError(batch.status);

  const allEntries = await getAllEntriesForBatch(prisma, batchId);
  const included = allEntries.filter((e) => e.decision === 'INCLUDE');

  const blocking = included.filter(
    (e) => !e.ciId || e.matchConfidence === 'AMBIGUOUS' || e.matchConfidence === 'UNMATCHED',
  );
  if (blocking.length > 0) {
    throw new BlockingAmbiguityError(
      blocking.map((e) => ({ id: e.id, hostAddress: e.hostAddress, vulnKey: e.vulnKey, matchConfidence: e.matchConfidence })),
    );
  }

  const byCi = new Map<string, typeof included>();
  for (const e of included) {
    const ciId = e.ciId as string;
    const arr = byCi.get(ciId) ?? [];
    arr.push(e);
    byCi.set(ciId, arr);
  }

  const touched: TouchedCi[] = [];
  let newCount = 0;
  let reopenedCount = 0;
  let refreshedCount = 0;

  await prisma.$transaction(async (tx) => {
    for (const [ciId, entries] of byCi) {
      const stored = await getCiVulnerabilities(tx, ciId);
      const now = new Date().toISOString();
      const vulnKeysTouched: string[] = [];

      const byIdentity = new Map<string, Vulnerability>();
      for (const v of stored) byIdentity.set(v.key ?? v.cve, v);

      for (const entry of entries) {
        vulnKeysTouched.push(entry.vulnKey);

        if (entry.classification === 'NUEVA') {
          byIdentity.set(entry.vulnKey, buildNewVulnerability(entry, now, batch.source));
          newCount++;
        } else if (entry.classification === 'REAPARECIDA') {
          const existing = byIdentity.get(entry.vulnKey);
          if (!existing) {
            // Defensive fallback: the classifier resolved REAPARECIDA at
            // upload time against a snapshot of the CI's stored
            // vulnerabilities; if that entry is gone by accept time (e.g. a
            // concurrent import/edit removed it), there's nothing to
            // "reopen" — treat it as a fresh finding rather than silently
            // dropping it.
            byIdentity.set(entry.vulnKey, buildNewVulnerability(entry, now, batch.source));
            newCount++;
            continue;
          }
          byIdentity.set(entry.vulnKey, {
            ...existing,
            status: 'REABIERTA',
            reopenedAt: now,
            resolvedAt: existing.resolvedAt, // preserved, never cleared
            description: entry.summary || entry.name,
            severity: entry.severity as VulnSeverity,
            cvss_score: entry.severityScore,
            lastSeenAt: now,
            cves: entry.cves,
            oid: entry.oid ?? existing.oid,
            port: entry.port ?? existing.port,
            family: entry.family ?? existing.family,
            solution: entry.solution ?? existing.solution,
            qod: entry.qod ?? existing.qod,
            epssScore: entry.epssScore ?? existing.epssScore,
            // CrowdStrike Spotlight fields (v3.6.1) — same fallback pattern
            // as oid/port/family/solution/qod/epssScore above: preserve the
            // previously-stored value when this entry's source doesn't
            // carry it (e.g. a Greenbone reimport reopening a vulnerability
            // that was last enriched by a CrowdStrike upload).
            products: entry.products.length > 0 ? entry.products : existing.products,
            exprtRating: entry.exprtRating ?? existing.exprtRating,
            cisaKev: entry.cisaKev,
            cisaDueDate: entry.cisaDueDate ? entry.cisaDueDate.toISOString() : existing.cisaDueDate,
            exploitStatus: entry.exploitStatus ?? existing.exploitStatus,
            daysOpen: entry.daysOpen ?? existing.daysOpen,
            externalStatus: entry.externalStatus ?? existing.externalStatus,
            cvssVersion: entry.cvssVersion ?? existing.cvssVersion,
          });
          reopenedCount++;
          await vulnImportAudit(tx, 'VULN_REOPENED', 'CI', ciId, userEmail, { vulnKey: entry.vulnKey });
        } else {
          // EXISTENTE_PENDIENTE, decision manually flipped to INCLUDE by an
          // operator: metadata refresh only, status is explicitly untouched.
          const existing = byIdentity.get(entry.vulnKey);
          if (existing) {
            byIdentity.set(entry.vulnKey, {
              ...existing,
              description: entry.summary || entry.name,
              severity: entry.severity as VulnSeverity,
              cvss_score: entry.severityScore,
              lastSeenAt: now,
            });
            refreshedCount++;
          } else {
            byIdentity.set(entry.vulnKey, buildNewVulnerability(entry, now, batch.source));
            newCount++;
          }
        }
      }

      await updateCiVulnerabilities(tx, ciId, [...byIdentity.values()]);
      touched.push({ ciId, vulnKeys: vulnKeysTouched });
    }

    await markBatchStatus(tx, batchId, 'ACCEPTED', userEmail);
    await vulnImportAudit(tx, 'VULN_IMPORT_ACCEPT', 'VulnImportBatch', batchId, userEmail, {
      ciCount: byCi.size, newCount, reopenedCount, refreshedCount,
    });
  });

  return { summary: { ciCount: byCi.size, newCount, reopenedCount, refreshedCount }, touched };
}
