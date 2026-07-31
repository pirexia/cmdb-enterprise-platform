import { Prisma } from '@prisma/client';
import { createBatchWithEntries, type NewBatchInput, type NewEntryInput } from '../queries.js';

// Real bug caught during live verification (Red Hat Lightspeed connector,
// v3.7.0): a real pull of 13,868 entries hit `RangeError: Invalid string
// length` inside Prisma when the original implementation nested every
// entry under a single `vulnImportBatch.create({data:{entries:{create:
// [...]}}})` — Prisma serializes that whole nested write as one JSON
// payload, and it exceeded V8's max string length. createBatchWithEntries
// now creates the batch alone, then writes entries via chunked
// `createMany` calls, so no single call's payload grows unbounded with
// the number of entries.

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

describe('createBatchWithEntries — chunked entry creation', () => {
  function buildTx(batchId: string) {
    const createMany = jest.fn().mockResolvedValue({ count: 0 });
    const create = jest.fn().mockResolvedValue({ id: batchId });
    const tx = {
      vulnImportBatch: { create },
      vulnImportEntry: { createMany },
    } as unknown as Prisma.TransactionClient;
    return { tx, create, createMany };
  }

  it('creates the batch via a single call with no nested entries in its payload', async () => {
    const { tx, create } = buildTx('batch-1');
    const input: NewBatchInput = {
      source: 'redhat-lightspeed', filename: 'x.json', uploadedBy: 'tester@cmdb.local',
      entries: [buildEntry(1)],
    };

    await createBatchWithEntries(tx, input);

    expect(create).toHaveBeenCalledTimes(1);
    const createArg = create.mock.calls[0][0];
    expect(createArg.data.entries).toBeUndefined();
    expect(createArg.data.source).toBe('redhat-lightspeed');
  });

  it('splits a large entry set into multiple createMany chunks, none of which grows with the total count', async () => {
    const { tx, createMany } = buildTx('batch-2');
    const entries = Array.from({ length: 1250 }, (_, i) => buildEntry(i));
    const input: NewBatchInput = {
      source: 'redhat-lightspeed', filename: 'x.json', uploadedBy: 'tester@cmdb.local', entries,
    };

    await createBatchWithEntries(tx, input);

    // 1250 entries at 500/chunk = 3 calls (500 + 500 + 250), never one call
    // carrying all 1250.
    expect(createMany).toHaveBeenCalledTimes(3);
    expect(createMany.mock.calls[0][0].data).toHaveLength(500);
    expect(createMany.mock.calls[1][0].data).toHaveLength(500);
    expect(createMany.mock.calls[2][0].data).toHaveLength(250);
    // Every entry carries the batch id returned by the batch create call.
    expect(createMany.mock.calls[0][0].data[0].batchId).toBe('batch-2');
  });

  it('makes no createMany call at all for an empty entry list', async () => {
    const { tx, createMany } = buildTx('batch-3');
    const input: NewBatchInput = {
      source: 'crowdstrike', filename: 'x.json', uploadedBy: 'tester@cmdb.local', entries: [],
    };

    await createBatchWithEntries(tx, input);

    expect(createMany).not.toHaveBeenCalled();
  });
});
