import { Prisma, PrismaClient } from '@prisma/client';
import {
  createBatchShell,
  writeBatchEntries,
  finalizeBatch,
  type NewBatchMeta,
  type NewEntryInput,
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
