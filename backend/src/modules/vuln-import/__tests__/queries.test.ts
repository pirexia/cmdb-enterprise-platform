import { Prisma, PrismaClient } from '@prisma/client';
import {
  createBatchShell,
  writeBatchEntries,
  finalizeBatch,
  recoverOrphanedRunningBatches,
  getBatchWithEntries,
  bulkUpdateDecision,
  MAX_ENTRY_PAGE_SIZE,
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
  const ROWS = Array.from({ length: 130 }, (_, i) => ({
    id: `entry-${i}`,
    name: `CVE-2024-${String(i).padStart(4, '0')}`,
    classification: i < 90 ? 'NUEVA' : 'EXISTENTE_PENDIENTE',
  }));

  function buildPrisma(rows: typeof ROWS) {
    const findUnique = jest.fn().mockResolvedValue({ id: 'batch-1' });
    const findMany = jest.fn(async ({ where, skip = 0, take }: {
      where: { classification?: string }; skip?: number; take?: number;
    }) => {
      const filtered = where.classification ? rows.filter((r) => r.classification === where.classification) : rows;
      const sorted = [...filtered].sort((a, b) => a.name.localeCompare(b.name));
      return sorted.slice(skip, take !== undefined ? skip + take : undefined);
    });
    const count = jest.fn(async ({ where }: { where: { classification?: string } }) => {
      const filtered = where.classification ? rows.filter((r) => r.classification === where.classification) : rows;
      return filtered.length;
    });
    const groupBy = jest.fn(async ({ where }: { where: { classification?: string } }) => {
      const filtered = where.classification ? rows.filter((r) => r.classification === where.classification) : rows;
      const counts = new Map<string, number>();
      for (const r of filtered) counts.set(r.classification, (counts.get(r.classification) ?? 0) + 1);
      return [...counts.entries()].map(([classification, count]) => ({ classification, _count: { _all: count } }));
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
        && (where.decision === undefined || r.decision === where.decision));
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
});
