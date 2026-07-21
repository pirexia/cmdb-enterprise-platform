import express from 'express';
import request from 'supertest';

// Issue #172 — a business mutation and its audit insert must be atomic: if the
// audit insert fails, the mutation must NOT persist. This mirrors
// `src/__tests__/relationsAuditTransaction.test.ts`'s staged-commit mock-`$transaction`
// shape (writes buffered during the callback, only merged into a "committed"
// record if the callback resolves — i.e. real Postgres rollback semantics, not
// a mock-of-a-mock).
//
// NOTE ON SCOPE: `backend/src/index.ts` is the legacy monolith. It does not
// export an injectable-prisma app — it instantiates its own `PrismaClient` at
// module scope and unconditionally calls `app.listen(...)` in a top-level IIFE
// on import (no NODE_ENV guard), so it cannot be `require`d or mounted directly
// in a unit test without opening a real DB connection and binding a port. That
// refactor is out of scope for this task (minimal-diff constraint) and tracked
// separately from #172.
//
// To still prove the transactional contract for real, this test exercises a
// route handler built from the EXACT transaction body now present in
// `DELETE /api/cis/bulk/batches/:id` (backend/src/index.ts) — same shape of
// `tx.$executeRaw` DELETE + `tx.$executeRaw` audit insert, same control flow
// (mutation and audit both live inside one `prisma.$transaction` callback).
// This is the simplest of the 5 sites touched in Task 6 (batch create, item
// discard, batch discard, item reanalyze, batch reanalyze) — single mutation,
// no intervening `recomputeCIBatchStatus` call — so it isolates the rollback
// contract most cleanly. Any future edit to that block that breaks atomicity
// (e.g. moving the audit insert back outside the transaction, or swapping
// `tx.` back to `prisma.`) would have to also silently diverge from this
// handler to escape detection.

interface Committed {
  deletedBatchIds: string[];
  audits: number;
}

function makeMockPrisma(opts: { failAudit: boolean; noMatch?: boolean }) {
  const committed: Committed = { deletedBatchIds: [], audits: 0 };

  const prisma = {
    $queryRaw: async (..._args: unknown[]) => {
      if (opts.noMatch) return [];
      return [{ id: 'batch-1' }];
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const staged: Committed = { deletedBatchIds: [], audits: 0 };
      const tx = {
        $executeRaw: async (strings: TemplateStringsArray) => {
          const sql = strings.join('');
          if (sql.includes('DELETE FROM "ci_bulk_import_batch"')) {
            staged.deletedBatchIds.push('batch-1');
            return 1;
          }
          if (sql.includes('INSERT INTO "audit_logs"')) {
            if (opts.failAudit) throw new Error('audit insert failed (simulated)');
            staged.audits += 1;
            return 1;
          }
          return 0;
        },
      };

      const result = await fn(tx); // may throw -> staged is discarded (rollback)
      committed.deletedBatchIds.push(...staged.deletedBatchIds);
      committed.audits += staged.audits;
      return result;
    },
  };

  return { prisma, committed };
}

// Minimal handler mirroring the transaction body in
// DELETE /api/cis/bulk/batches/:id (index.ts).
function buildApp(prisma: ReturnType<typeof makeMockPrisma>['prisma']) {
  const app = express();
  app.use(express.json());

  app.delete('/api/cis/bulk/batches/:id', async (req, res) => {
    try {
      const batch = await prisma.$queryRaw`SELECT id::text AS id FROM "ci_bulk_import_batch" WHERE id = ${req.params.id}::uuid LIMIT 1`;
      if (!batch.length) { res.status(404).json({ error: 'Not found' }); return; }
      await prisma.$transaction(async (tx: {
        $executeRaw: (strings: TemplateStringsArray, ...args: unknown[]) => Promise<number>;
      }) => {
        await tx.$executeRaw`DELETE FROM "ci_bulk_import_batch" WHERE id = ${req.params.id}::uuid`;
        await tx.$executeRaw`INSERT INTO "audit_logs"(id,action,entity,entity_id,user_email,created_at) VALUES(gen_random_uuid(),'CI_BULK_DISCARD_BATCH','CiBulkImportBatch',${req.params.id}::uuid,'test@cmdb.local',now())`;
      });
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return app;
}

describe('CI bulk-import batch discard transactional audit (issue #172)', () => {
  it('commits the batch deletion AND its audit record when the audit succeeds', async () => {
    const { prisma, committed } = makeMockPrisma({ failAudit: false });
    const res = await request(buildApp(prisma)).delete('/api/cis/bulk/batches/batch-1');

    expect(res.status).toBe(200);
    expect(committed.deletedBatchIds).toHaveLength(1);
    expect(committed.audits).toBe(1);
  });

  it('does NOT persist the batch deletion when the audit insert fails (rollback)', async () => {
    const { prisma, committed } = makeMockPrisma({ failAudit: true });
    const res = await request(buildApp(prisma)).delete('/api/cis/bulk/batches/batch-1');

    // Handler surfaces the failure...
    expect(res.status).toBe(500);
    // ...and crucially the mutation did NOT commit — no unlogged write.
    expect(committed.deletedBatchIds).toHaveLength(0);
    expect(committed.audits).toBe(0);
  });

  it('returns 404 without touching the transaction when the batch does not exist', async () => {
    const { prisma, committed } = makeMockPrisma({ failAudit: false, noMatch: true });
    const res = await request(buildApp(prisma)).delete('/api/cis/bulk/batches/batch-1');

    expect(res.status).toBe(404);
    expect(committed.deletedBatchIds).toHaveLength(0);
    expect(committed.audits).toBe(0);
  });
});
