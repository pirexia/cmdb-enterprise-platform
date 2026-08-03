import { Prisma, PrismaClient } from '@prisma/client';
import {
  createBatchShell,
  writeBatchEntries,
  finalizeBatch,
  recoverOrphanedRunningBatches,
  getBatchWithEntries,
  bulkUpdateDecision,
  listBatches,
  MAX_ENTRY_PAGE_SIZE,
  NO_MATCH_CONFIDENCE_KEY,
  type NewBatchMeta,
  type NewEntryInput,
  type PrismaOrTx,
} from '../queries.js';

// Real bug caught during live verification (Red Hat Lightspeed connector,
// v3.7.0): a real pull of 13,868 entries hit `RangeError: Invalid string
// length` inside Prisma when the original single-function implementation
// (`createBatchWithEntries`) nested every entry under one
// `vulnImportBatch.create({data:{entries:{create:[...]}}})` call — Prisma
// serializes that whole nested write as one JSON payload, and it exceeded
// V8's max string length. Even after that was fixed with chunked
// `createMany` calls, wrapping thousands of sequential chunk writes inside
// one interactive `$transaction` still risked hitting Prisma's interactive
// transaction timeout. This split — `createBatchShell` (short tx) +
// `writeBatchEntries` (no tx, chunked) + `finalizeBatch` (short tx) — is
// the fix: only the entry-writing loop can grow with the batch size, and it
// never holds an interactive transaction open.

function buildEntry(i: number): NewEntryInput {
  return {
    hostAddress: `10.0.0.${i % 255}`, ciId: null, matchConfidence: 'UNMATCHED', matchCandidates: null,
    vulnKey: `CVE-2024-${i}`, oid: null, port: null, cves: [`CVE-2024-${i}`],
    severityScore: 5.0, severity: 'MEDIUM', name: `CVE-2024-${i}`, summary: null, solution: null,
    family: null, thread: null, qod: null, epssScore: null, raw: { synopsis: `CVE-2024-${i}` },
    existingStatus: null, classification: 'NUEVA', decision: 'EXCLUDE',
    products: [], exprtRating: null, cisaKev: false, cisaDueDate: null, exploitStatus: null,
    daysOpen: null, externalStatus: null, cvssVersion: null,
    redhatImpact: null, knownExploit: null, publicDate: null,
  };
}

describe('createBatchShell', () => {
  it('creates the batch row alone (no nested entries in the payload) with status RUNNING', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'batch-1', uploadedBy: 'tester@cmdb.local' });
    const tx = { vulnImportBatch: { create } } as unknown as Prisma.TransactionClient;

    const meta: NewBatchMeta = {
      source: 'redhat-lightspeed', filename: 'x.json', uploadedBy: 'tester@cmdb.local',
    };

    await createBatchShell(tx, meta);

    expect(create).toHaveBeenCalledTimes(1);
    const createArg = create.mock.calls[0][0];
    expect(createArg.data.entries).toBeUndefined();
    expect(createArg.data.source).toBe('redhat-lightspeed');
    expect(createArg.data.status).toBe('RUNNING');
  });
});

describe('writeBatchEntries', () => {
  function buildPrisma() {
    const createMany = jest.fn().mockResolvedValue({ count: 0 });
    const prisma = { vulnImportEntry: { createMany } } as unknown as PrismaClient;
    return { prisma, createMany };
  }

  it('splits a large entry set into multiple createMany chunks, none of which grows with the total count', async () => {
    const { prisma, createMany } = buildPrisma();
    const entries = Array.from({ length: 1250 }, (_, i) => buildEntry(i));

    await writeBatchEntries(prisma, 'batch-2', entries);

    // 1250 entries at 500/chunk = 3 calls (500 + 500 + 250), never one call
    // carrying all 1250.
    expect(createMany).toHaveBeenCalledTimes(3);
    expect(createMany.mock.calls[0][0].data).toHaveLength(500);
    expect(createMany.mock.calls[1][0].data).toHaveLength(500);
    expect(createMany.mock.calls[2][0].data).toHaveLength(250);
    // Every entry carries the batch id passed in.
    expect(createMany.mock.calls[0][0].data[0].batchId).toBe('batch-2');
  });

  it('makes no createMany call at all for an empty entry list', async () => {
    const { prisma, createMany } = buildPrisma();

    await writeBatchEntries(prisma, 'batch-3', []);

    expect(createMany).not.toHaveBeenCalled();
  });

  it('calls onProgress after each chunk with strictly increasing written counts and the fixed total', async () => {
    const { prisma } = buildPrisma();
    const entries = Array.from({ length: 1250 }, (_, i) => buildEntry(i));
    const onProgress = jest.fn();

    await writeBatchEntries(prisma, 'batch-4', entries, onProgress);

    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenNthCalledWith(1, 500, 1250);
    expect(onProgress).toHaveBeenNthCalledWith(2, 1000, 1250);
    expect(onProgress).toHaveBeenNthCalledWith(3, 1250, 1250);
  });

  it('never calls onProgress for an empty entry list', async () => {
    const { prisma } = buildPrisma();
    const onProgress = jest.fn();

    await writeBatchEntries(prisma, 'batch-5', [], onProgress);

    expect(onProgress).not.toHaveBeenCalled();
  });
});

describe('finalizeBatch', () => {
  function buildTx(batchRow: { id: string; uploadedBy: string }) {
    const update = jest.fn().mockResolvedValue(batchRow);
    const executeRaw = jest.fn().mockResolvedValue(undefined);
    const tx = {
      vulnImportBatch: { update },
      $executeRaw: executeRaw,
    } as unknown as Prisma.TransactionClient;
    return { tx, update, executeRaw };
  }

  it('sets status=PENDING and writes a VULN_IMPORT_UPLOAD audit record', async () => {
    const { tx, update, executeRaw } = buildTx({ id: 'batch-6', uploadedBy: 'tester@cmdb.local' });

    await finalizeBatch(tx, 'batch-6', 'PENDING');

    expect(update).toHaveBeenCalledWith({
      where: { id: 'batch-6' },
      data: { status: 'PENDING', errorMessage: null },
    });
    expect(executeRaw).toHaveBeenCalledTimes(1);
    // vulnImportAudit builds a tagged-template $executeRaw call; assert the
    // action/entity/user values were interpolated into it.
    const [strings, ...values] = executeRaw.mock.calls[0];
    expect(strings.join('')).toContain('INSERT INTO "audit_logs"');
    expect(values).toContain('VULN_IMPORT_UPLOAD');
    expect(values).toContain('VulnImportBatch');
    expect(values).toContain('tester@cmdb.local');
  });

  it('sets status=FAILED with error_message populated and writes a VULN_IMPORT_FAILED audit record', async () => {
    const { tx, update, executeRaw } = buildTx({ id: 'batch-7', uploadedBy: 'tester@cmdb.local' });

    await finalizeBatch(tx, 'batch-7', 'FAILED', 'RangeError: Invalid string length');

    expect(update).toHaveBeenCalledWith({
      where: { id: 'batch-7' },
      data: { status: 'FAILED', errorMessage: 'RangeError: Invalid string length' },
    });
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const [, ...values] = executeRaw.mock.calls[0];
    expect(values).toContain('VULN_IMPORT_FAILED');
    expect(values).toContain('VulnImportBatch');
  });
});

describe('recoverOrphanedRunningBatches', () => {
  // Task 6 (v3.7.0): Task 4 made Red Hat Lightspeed pulls run as a
  // background async job, so a backend restart mid-import can leave a
  // VulnImportBatch stuck in RUNNING forever — no request is ever coming
  // back to call finalizeBatch on it. This sweep runs once at startup and
  // fails those rows out explicitly.
  it('issues a single UPDATE that only targets RUNNING rows, setting FAILED + the restart message', async () => {
    const executeRaw = jest.fn().mockResolvedValue(1);
    const prisma = { $executeRaw: executeRaw } as unknown as PrismaClient;

    const affected = await recoverOrphanedRunningBatches(prisma);

    expect(executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = executeRaw.mock.calls[0];
    const sql = strings.join('');
    expect(sql).toContain('UPDATE "vuln_import_batches"');
    // Selective WHERE — a batch in any other status (PENDING, ACCEPTED,
    // DISCARDED, already-FAILED) is never matched by this statement, so it
    // is left untouched.
    expect(sql).toContain(`WHERE "status" = 'RUNNING'`);
    expect(sql).toContain("SET \"status\" = 'FAILED'");
    expect(sql).toContain("\"error_message\" = 'Interrumpido por reinicio del servidor'");
    // No interpolated values — the whole statement is a static literal, not
    // built from caller input, so there is nothing to bind.
    expect(values).toHaveLength(0);
    expect(affected).toBe(1);
  });

  it('returns 0 when no batch is RUNNING (nothing to recover)', async () => {
    const executeRaw = jest.fn().mockResolvedValue(0);
    const prisma = { $executeRaw: executeRaw } as unknown as PrismaClient;

    const affected = await recoverOrphanedRunningBatches(prisma);

    expect(affected).toBe(0);
  });
});

describe('getBatchWithEntries', () => {
  // Task 8 (v3.7.0): a real Red Hat Lightspeed pull lands ~13,868 entries in
  // one batch, each with its full `raw` jsonb blob — the original
  // unpaginated `findMany` returned all of them in a single response. This
  // builds an in-memory fake of 130 rows (>MAX_ENTRY_PAGE_SIZE) split across
  // two classifications, and drives fake `findMany`/`count`/`groupBy` calls
  // off it so the test exercises the same skip/take/where the real Prisma
  // client would see, without touching a real database.
  // Deliberately sized/split so the classification/severity/matchConfidence
  // splits don't line up with each other or with any single page boundary —
  // if `getBatchWithEntries` ever counted the loaded page instead of the
  // groupBy'd whole batch, at least one of these counts would come out
  // wrong for a 50-row page.
  const ROWS = Array.from({ length: 130 }, (_, i) => ({
    id: `entry-${i}`,
    name: `CVE-2024-${String(i).padStart(4, '0')}`,
    classification: i < 90 ? 'NUEVA' : 'EXISTENTE_PENDIENTE',
    severity: i < 40 ? 'CRITICAL' : i < 100 ? 'HIGH' : 'LOW',
    // 5 rows have a null matchConfidence (never happens post-upload in
    // practice, but the DB column is nullable — see NO_MATCH_CONFIDENCE_KEY).
    matchConfidence: i < 5 ? null : i < 70 ? 'EXACT_IP' : 'UNMATCHED',
    // Task 10 (ciCount): only the EXACT_IP rows (i in [5,70)) are matched to
    // a CI — 10 distinct CI ids, reused across those 65 rows (i % 10) so a
    // naive "count non-null ciId rows" implementation (65) is visibly wrong
    // against the correct "count DISTINCT ciId" answer (10). The null/UNMATCHED
    // rows deliberately have no CI, mirroring real matcher.ts semantics (an
    // UNMATCHED entry never gets a ciId).
    ciId: (i >= 5 && i < 70) ? `ci-${i % 10}` : null,
  }));

  type Row = (typeof ROWS)[number];
  // getBatchWithEntries now builds classification/severity/matchConfidence
  // as `{ in: string[] }` (task-8c, to support the review screen's union
  // tabs), never a bare string — mirror that shape here rather than the
  // plain-string one bulkUpdateDecision's fake below still uses.
  type FakeWhere = {
    classification?: { in: string[] };
    severity?: { in: string[] };
    matchConfidence?: { in: string[] };
    ciId?: { not: null };
  };

  function applyWhere(rows: Row[], where: FakeWhere) {
    return rows.filter((r) =>
      (where.classification === undefined || where.classification.in.includes(r.classification))
      && (where.severity === undefined || where.severity.in.includes(r.severity))
      && (where.matchConfidence === undefined || (r.matchConfidence !== null && where.matchConfidence.in.includes(r.matchConfidence)))
      && (where.ciId === undefined || r.ciId !== null));
  }

  function buildPrisma(rows: Row[]) {
    const findUnique = jest.fn().mockResolvedValue({ id: 'batch-1' });
    const findMany = jest.fn(async ({ where, skip = 0, take }: {
      where: FakeWhere; skip?: number; take?: number;
    }) => {
      const filtered = applyWhere(rows, where);
      const sorted = [...filtered].sort((a, b) => a.name.localeCompare(b.name));
      return sorted.slice(skip, take !== undefined ? skip + take : undefined);
    });
    const count = jest.fn(async ({ where }: { where: FakeWhere }) => applyWhere(rows, where).length);
    // Generic across the three distinct `by` fields getBatchWithEntries
    // groups on (classification/severity/matchConfidence) — mirrors real
    // Prisma groupBy: aggregates over the WHOLE where-filtered set, not any
    // page slice.
    const groupBy = jest.fn(async ({ by, where }: { by: (keyof Row)[]; where: FakeWhere }) => {
      const field = by[0];
      const filtered = applyWhere(rows, where);
      const counts = new Map<string | null, number>();
      for (const r of filtered) {
        const key = r[field] as string | null;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return [...counts.entries()].map(([value, count]) => ({ [field]: value, _count: { _all: count } }));
    });
    const prisma = {
      vulnImportBatch: { findUnique },
      vulnImportEntry: { findMany, count, groupBy },
    } as unknown as PrismaOrTx;
    return { prisma, findMany, count, groupBy };
  }

  it('returns exactly pageSize entries, the correct total, and classification counts over the WHOLE batch (not just the loaded page)', async () => {
    const { prisma } = buildPrisma(ROWS);

    const result = await getBatchWithEntries(prisma, 'batch-1', { page: 1, pageSize: 50 });

    expect(result).not.toBeNull();
    expect(result!.entries).toHaveLength(50);
    expect(result!.total).toBe(130);
    // If this were counting the loaded 50-row page instead of using
    // groupBy over the full 130-row where-clause, NUEVA would read <=50
    // instead of the true 90.
    expect(result!.byClassification).toEqual({ NUEVA: 90, EXISTENTE_PENDIENTE: 40 });
  });

  it('returns the second page with the remaining entries', async () => {
    const { prisma } = buildPrisma(ROWS);

    const result = await getBatchWithEntries(prisma, 'batch-1', { page: 3, pageSize: 50 });

    // 130 entries at 50/page = pages of 50, 50, 30.
    expect(result!.entries).toHaveLength(30);
    expect(result!.total).toBe(130);
  });

  it('clamps an oversized pageSize to MAX_ENTRY_PAGE_SIZE', async () => {
    const { prisma, findMany } = buildPrisma(ROWS);

    const result = await getBatchWithEntries(prisma, 'batch-1', { page: 1, pageSize: 999999 });

    expect(result!.entries).toHaveLength(MAX_ENTRY_PAGE_SIZE);
    expect(findMany.mock.calls[0][0].take).toBe(MAX_ENTRY_PAGE_SIZE);
  });

  it('defaults to page 1 / a sane pageSize when neither is supplied', async () => {
    const { prisma } = buildPrisma(ROWS);

    const result = await getBatchWithEntries(prisma, 'batch-1', {});

    expect(result!.page).toBe(1);
    expect(result!.pageSize).toBeGreaterThan(0);
    expect(result!.pageSize).toBeLessThanOrEqual(MAX_ENTRY_PAGE_SIZE);
  });

  it('returns null without querying entries when the batch does not exist', async () => {
    const findUnique = jest.fn().mockResolvedValue(null);
    const findMany = jest.fn();
    const count = jest.fn();
    const groupBy = jest.fn();
    const prisma = {
      vulnImportBatch: { findUnique },
      vulnImportEntry: { findMany, count, groupBy },
    } as unknown as PrismaOrTx;

    const result = await getBatchWithEntries(prisma, 'missing-batch', { page: 1, pageSize: 50 });

    expect(result).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
    expect(groupBy).not.toHaveBeenCalled();
  });

  it('applies the classification filter to entries, count, AND groupBy consistently', async () => {
    const { prisma } = buildPrisma(ROWS);

    const result = await getBatchWithEntries(prisma, 'batch-1', {
      classification: 'NUEVA', page: 1, pageSize: 50,
    });

    expect(result!.total).toBe(90);
    expect(result!.byClassification).toEqual({ NUEVA: 90 });
    expect(result!.entries.every((e) => e.classification === 'NUEVA')).toBe(true);
  });

  // Task 8b: bySeverity/byMatchConfidence power the review screen's
  // "Accionables"/"Informativas" (severity) and "Requieren atención"
  // (matchConfidence) tabs. Loading a 50-row page (< the 130-row batch, and
  // in particular < the 120 non-null-matchConfidence rows) must not change
  // these totals — if the implementation ever counted the loaded page array
  // instead of using groupBy, CRITICAL/EXACT_IP/etc. counts here would come
  // out far smaller than asserted.
  it('returns severity and matchConfidence counts over the WHOLE batch, not just the loaded page', async () => {
    const { prisma } = buildPrisma(ROWS);

    const result = await getBatchWithEntries(prisma, 'batch-1', { page: 1, pageSize: 50 });

    expect(result!.entries).toHaveLength(50);
    expect(result!.total).toBe(130);
    expect(result!.bySeverity).toEqual({ CRITICAL: 40, HIGH: 60, LOW: 30 });
    // 5 rows have a null matchConfidence in the DB — folded into
    // NO_MATCH_CONFIDENCE_KEY rather than dropped or keyed as "null".
    expect(result!.byMatchConfidence).toEqual({
      [NO_MATCH_CONFIDENCE_KEY]: 5,
      EXACT_IP: 65,
      UNMATCHED: 60,
    });
  });

  it('applies the matchConfidence filter to entries, count, AND all three groupBy aggregates consistently', async () => {
    const { prisma } = buildPrisma(ROWS);

    const result = await getBatchWithEntries(prisma, 'batch-1', {
      matchConfidence: 'EXACT_IP', page: 1, pageSize: 50,
    });

    // Rows 5-69 are EXACT_IP (65 rows): classification NUEVA for i<90 (all
    // of 5-69), severity CRITICAL for i<40 (35 of them: 5-39) and HIGH for
    // 40<=i<70 (30 of them: 40-69).
    expect(result!.total).toBe(65);
    expect(result!.byMatchConfidence).toEqual({ EXACT_IP: 65 });
    expect(result!.byClassification).toEqual({ NUEVA: 65 });
    expect(result!.bySeverity).toEqual({ CRITICAL: 35, HIGH: 30 });
    expect(result!.entries.every((e) => e.matchConfidence === 'EXACT_IP')).toBe(true);
  });

  // Task 8c: the review screen's union tabs (e.g. "Accionables" = severity
  // MEDIUM+HIGH+CRITICAL) need "page N of the union of several values" in a
  // single query — a single-value filter can't express that.
  it('accepts an array of severities and returns entries matching ANY of them, across the whole paginated batch — not just the first value', async () => {
    const { prisma } = buildPrisma(ROWS);

    // CRITICAL (i<40, 40 rows) + LOW (i>=100, 30 rows) = 70 rows, deliberately
    // skipping the HIGH middle band so an implementation that collapsed the
    // array to its first element (`severity: 'CRITICAL'`) would under-count
    // to 40 rather than the true union of 70.
    const result = await getBatchWithEntries(prisma, 'batch-1', {
      severity: ['CRITICAL', 'LOW'], page: 1, pageSize: 50,
    });

    expect(result!.total).toBe(70);
    expect(result!.entries).toHaveLength(50);
    expect(result!.entries.every((e) => e.severity === 'CRITICAL' || e.severity === 'LOW')).toBe(true);
    expect(result!.bySeverity).toEqual({ CRITICAL: 40, LOW: 30 });

    // Page 2 must carry the remaining 20 of the same 70-row union, not
    // silently reset to a single-value filter's page 2.
    const page2 = await getBatchWithEntries(prisma, 'batch-1', {
      severity: ['CRITICAL', 'LOW'], page: 2, pageSize: 50,
    });
    expect(page2!.entries).toHaveLength(20);
    expect(page2!.total).toBe(70);
  });

  it('still applies a single string value exactly as before (regression) — matchConfidence and classification too', async () => {
    const { prisma } = buildPrisma(ROWS);

    const bySeverity = await getBatchWithEntries(prisma, 'batch-1', { severity: 'CRITICAL', page: 1, pageSize: 50 });
    expect(bySeverity!.total).toBe(40);
    expect(bySeverity!.entries.every((e) => e.severity === 'CRITICAL')).toBe(true);

    const byMatchConfidence = await getBatchWithEntries(prisma, 'batch-1', { matchConfidence: 'EXACT_IP', page: 1, pageSize: 50 });
    expect(byMatchConfidence!.total).toBe(65);

    const byClassification = await getBatchWithEntries(prisma, 'batch-1', { classification: 'NUEVA', page: 1, pageSize: 50 });
    expect(byClassification!.total).toBe(90);
  });

  it('accepts an array of matchConfidence values and unions them (UNMATCHED + AMBIGUOUS "Requiere atención" style)', async () => {
    const { prisma } = buildPrisma(ROWS);

    // EXACT_IP (i in [5,70), 65 rows) + UNMATCHED (i in [70,130), 60 rows) = 125.
    const result = await getBatchWithEntries(prisma, 'batch-1', {
      matchConfidence: ['EXACT_IP', 'UNMATCHED'], page: 1, pageSize: 50,
    });

    expect(result!.total).toBe(125);
    expect(result!.byMatchConfidence).toEqual({ EXACT_IP: 65, UNMATCHED: 60 });
  });

  it('accepts an array of classification values and unions them', async () => {
    const { prisma } = buildPrisma(ROWS);

    const result = await getBatchWithEntries(prisma, 'batch-1', {
      classification: ['NUEVA', 'EXISTENTE_PENDIENTE'], page: 1, pageSize: 50,
    });

    // The full batch — every row is one of these two classifications.
    expect(result!.total).toBe(130);
  });

  // Task 10 (v3.7.0): the "Aceptar" confirmation dialog's `ciCount` — number
  // of DISTINCT CIs the accept would touch, not the number of entries that
  // happen to carry a non-null ciId. Same pattern as byClassification/
  // bySeverity/byMatchConfidence above: aggregated via a fourth groupBy over
  // the WHOLE where-filtered batch, not the loaded page.
  it('returns ciCount as the number of DISTINCT non-null ciId values over the whole filtered batch', async () => {
    const { prisma } = buildPrisma(ROWS);

    const result = await getBatchWithEntries(prisma, 'batch-1', { page: 1, pageSize: 50 });

    // 65 rows (i in [5,70)) carry a non-null ciId, but only 10 distinct
    // values (`ci-${i % 10}`) among them — if the implementation counted
    // non-null rows instead of grouping, this would read 65, not 10.
    expect(result!.ciCount).toBe(10);
  });

  it('excludes null-ciId rows from ciCount entirely (an UNMATCHED entry has no CI)', async () => {
    const { prisma } = buildPrisma(ROWS);

    // Every LOW-severity row (i >= 100) is UNMATCHED with ciId: null.
    const result = await getBatchWithEntries(prisma, 'batch-1', {
      severity: 'LOW', page: 1, pageSize: 50,
    });

    expect(result!.total).toBe(30);
    expect(result!.ciCount).toBe(0);
  });

  it('scopes ciCount to the same filter as entries/total (accept-preview\'s ?decision=INCLUDE use case)', async () => {
    const { prisma } = buildPrisma(ROWS);

    // matchConfidence=EXACT_IP is exactly the 65 rows that carry a ciId —
    // ciCount should still read 10 (the distinct count), not 65, confirming
    // the aggregate isn't accidentally just `total` under a narrower filter.
    const result = await getBatchWithEntries(prisma, 'batch-1', {
      matchConfidence: 'EXACT_IP', page: 1, pageSize: 50,
    });

    expect(result!.total).toBe(65);
    expect(result!.ciCount).toBe(10);
  });
});

describe('bulkUpdateDecision', () => {
  // Task 9 (v3.7.0): the review screen now paginates (Task 8), but
  // bulk-decision must NOT inherit that page-scoping — "mark all CRITICAL as
  // included" has to hit every matching row in the batch regardless of what
  // page the operator has loaded in the browser. `bulkUpdateDecision` takes
  // no entry-id list at all; it builds a Prisma `where` from the batch id +
  // filter and calls `updateMany`, which Prisma/Postgres evaluates against
  // the whole table, not a client-supplied subset. This fake `updateMany`
  // mirrors that: it filters the FULL in-memory batch (>MAX_ENTRY_PAGE_SIZE
  // rows, i.e. more than one logical "page") the same way Postgres would,
  // proving the update isn't silently bounded to a page's worth of rows.
  const ROWS = Array.from({ length: 150 }, (_, i) => ({
    id: `entry-${i}`,
    batchId: 'batch-1',
    classification: 'NUEVA',
    severity: i < 120 ? 'CRITICAL' : 'LOW',
    decision: 'EXCLUDE',
    // 45 UNMATCHED (0-44), 105 EXACT_IP (45-149) — deliberately not aligned
    // with the severity split above, so a filter on one field can't
    // accidentally pass by coincidentally matching the other.
    matchConfidence: i < 45 ? 'UNMATCHED' : 'EXACT_IP',
  }));

  function buildTx(rows: typeof ROWS) {
    const updateMany = jest.fn(async ({ where, data }: {
      where: Prisma.VulnImportEntryWhereInput;
      data: { decision: string; edited: boolean };
    }) => {
      const matches = rows.filter((r) =>
        r.batchId === where.batchId
        && (where.classification === undefined || r.classification === where.classification)
        && (where.severity === undefined || r.severity === where.severity)
        && (where.decision === undefined || r.decision === where.decision)
        && (where.matchConfidence === undefined || r.matchConfidence === where.matchConfidence));
      for (const r of matches) { r.decision = data.decision; }
      return { count: matches.length };
    });
    const tx = { vulnImportEntry: { updateMany } } as unknown as Prisma.TransactionClient;
    return { tx, updateMany };
  }

  it('flips ALL 120 CRITICAL entries in a 150-row batch, not just the first page worth', async () => {
    const rows = ROWS.map((r) => ({ ...r })); // fresh copy per test
    const { tx, updateMany } = buildTx(rows);

    const result = await bulkUpdateDecision(tx, 'batch-1', { severity: 'CRITICAL' }, 'INCLUDE');

    // 120 > MAX_ENTRY_PAGE_SIZE-sized single page (Task 8 caps a page at
    // 100) — a page-scoped implementation could only ever have touched 100.
    expect(result.count).toBe(120);
    expect(rows.filter((r) => r.severity === 'CRITICAL' && r.decision === 'INCLUDE')).toHaveLength(120);
    // The 30 non-matching (LOW) rows are untouched.
    expect(rows.filter((r) => r.severity === 'LOW' && r.decision === 'INCLUDE')).toHaveLength(0);
    // No client-supplied id list is involved anywhere in the call.
    expect(updateMany.mock.calls[0][0]).not.toHaveProperty('where.id');
    expect(updateMany.mock.calls[0][0].where).toEqual({ batchId: 'batch-1', severity: 'CRITICAL' });
  });

  it('scopes strictly to the given batchId even when other batches share matching rows', async () => {
    const rows = [
      ...ROWS.map((r) => ({ ...r })),
      ...Array.from({ length: 20 }, (_, i) => ({
        id: `other-entry-${i}`, batchId: 'batch-2', classification: 'NUEVA', severity: 'CRITICAL', decision: 'EXCLUDE',
        matchConfidence: 'EXACT_IP',
      })),
    ];
    const { tx } = buildTx(rows);

    const result = await bulkUpdateDecision(tx, 'batch-1', { severity: 'CRITICAL' }, 'INCLUDE');

    expect(result.count).toBe(120);
    expect(rows.filter((r) => r.batchId === 'batch-2' && r.decision === 'INCLUDE')).toHaveLength(0);
  });

  it('applies no severity/classification/decision constraint when the filter is empty — every row in the batch flips', async () => {
    const rows = ROWS.map((r) => ({ ...r }));
    const { tx } = buildTx(rows);

    const result = await bulkUpdateDecision(tx, 'batch-1', {}, 'EXCLUDE');

    expect(result.count).toBe(150);
    expect(rows.every((r) => r.decision === 'EXCLUDE')).toBe(true);
  });

  // Task 8b: matchConfidence as a bulk-decision filter — e.g. "exclude all
  // UNMATCHED entries" on the "Requiere atención" tab. Must affect only the
  // 45 UNMATCHED rows across the WHOLE 150-row batch, not the 105 EXACT_IP
  // rows and not scoped to any single page.
  it('flips ALL 45 UNMATCHED entries in a 150-row batch when filtered by matchConfidence, leaving EXACT_IP rows untouched', async () => {
    const rows = ROWS.map((r) => ({ ...r }));
    const { tx, updateMany } = buildTx(rows);

    const result = await bulkUpdateDecision(tx, 'batch-1', { matchConfidence: 'UNMATCHED' }, 'INCLUDE');

    expect(result.count).toBe(45);
    expect(rows.filter((r) => r.matchConfidence === 'UNMATCHED' && r.decision === 'INCLUDE')).toHaveLength(45);
    expect(rows.filter((r) => r.matchConfidence === 'EXACT_IP' && r.decision === 'INCLUDE')).toHaveLength(0);
    expect(updateMany.mock.calls[0][0].where).toEqual({ batchId: 'batch-1', matchConfidence: 'UNMATCHED' });
  });
});

// Task 11 (v3.7.0): `source` added as a second, independent filter on
// GET /api/vuln-import/batches (frontend gained a source-filter tab
// alongside the pre-existing status-filter tabs, for the Red Hat Lightspeed
// connector's 'redhat-lightspeed' source value). Mirrors the pre-existing
// `status` filter's `where`-building — both are optional and must combine
// with AND, never override one another.
describe('listBatches', () => {
  const BATCHES = [
    { id: 'b1', status: 'PENDING', source: 'greenbone', createdAt: new Date('2026-01-01'), _count: { entries: 1 } },
    { id: 'b2', status: 'PENDING', source: 'redhat-lightspeed', createdAt: new Date('2026-01-02'), _count: { entries: 2 } },
    { id: 'b3', status: 'RUNNING', source: 'redhat-lightspeed', createdAt: new Date('2026-01-03'), _count: { entries: 0 } },
    { id: 'b4', status: 'ACCEPTED', source: 'crowdstrike', createdAt: new Date('2026-01-04'), _count: { entries: 5 } },
  ];

  function matches(b: (typeof BATCHES)[number], where: { status?: string; source?: string }) {
    return (where.status === undefined || b.status === where.status)
      && (where.source === undefined || b.source === where.source);
  }

  function buildPrisma() {
    const findMany = jest.fn(async ({ where }: { where: { status?: string; source?: string } }) =>
      BATCHES.filter((b) => matches(b, where)));
    const count = jest.fn(async ({ where }: { where: { status?: string; source?: string } }) =>
      BATCHES.filter((b) => matches(b, where)).length);
    const groupBy = jest.fn().mockResolvedValue([]);
    const prisma = {
      vulnImportBatch: { findMany, count },
      vulnImportEntry: { groupBy },
    } as unknown as PrismaOrTx;
    return { prisma, findMany, count };
  }

  it('filters by source alone, leaving other sources out regardless of status', async () => {
    const { prisma } = buildPrisma();

    const { batches, total } = await listBatches(prisma, { source: 'redhat-lightspeed', page: 1, pageSize: 20 });

    expect(total).toBe(2);
    expect(batches.map((b) => b.id).sort()).toEqual(['b2', 'b3']);
  });

  it('combines status and source filters with AND, not OR', async () => {
    const { prisma } = buildPrisma();

    const { batches, total } = await listBatches(prisma, { status: 'PENDING', source: 'redhat-lightspeed', page: 1, pageSize: 20 });

    expect(total).toBe(1);
    expect(batches[0].id).toBe('b2');
  });

  it('omits the source key entirely from `where` when no source filter is given (matches the pre-existing status behaviour)', async () => {
    const { prisma, findMany } = buildPrisma();

    await listBatches(prisma, { page: 1, pageSize: 20 });

    expect(findMany.mock.calls[0][0].where).toEqual({});
  });
});
