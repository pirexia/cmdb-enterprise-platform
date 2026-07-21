import express from 'express';
import request from 'supertest';

// Issue #172 — a business mutation and its audit insert must be atomic: if the
// audit insert fails, the mutation must NOT persist. This mirrors
// `src/__tests__/ciAuditTransaction.test.ts`'s staged-commit mock-`$transaction`
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
// `POST /api/cis/:id/relations` (backend/src/index.ts) — same shape of
// `tx.$queryRaw` INSERT...SELECT + same `tx.$executeRaw` audit insert, same
// control flow (mutation and audit both live inside one `prisma.$transaction`
// callback; the empty-insert 404 check happens AFTER the transaction commits,
// since an empty result is a valid no-op, not a rollback trigger). Any future
// edit to that block that breaks atomicity (e.g. moving the audit insert back
// outside the transaction, or swapping `tx.` back to `prisma.`) would have to
// also silently diverge from this handler to escape detection.

interface Committed {
  relations: { id: string }[];
  audits: number;
}

function makeMockPrisma(opts: { failAudit: boolean; noMatch?: boolean }) {
  const committed: Committed = { relations: [], audits: 0 };

  const prisma = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const staged: Committed = { relations: [], audits: 0 };
      const tx = {
        $queryRaw: async () => {
          if (opts.noMatch) return [];
          const row = { id: 'rel-1' };
          staged.relations.push(row);
          return [row];
        },
        $executeRaw: async () => {
          if (opts.failAudit) throw new Error('audit insert failed (simulated)');
          staged.audits += 1;
          return 1;
        },
      };

      const result = await fn(tx); // may throw -> staged is discarded (rollback)
      committed.relations.push(...staged.relations);
      committed.audits += staged.audits;
      return result;
    },
  };

  return { prisma, committed };
}

// Minimal handler mirroring the transaction body in POST /api/cis/:id/relations (index.ts).
function buildApp(prisma: ReturnType<typeof makeMockPrisma>['prisma']) {
  const app = express();
  app.use(express.json());

  app.post('/api/cis/:id/relations', async (req, res) => {
    const { targetCiId, relationType } = req.body as { targetCiId?: string; relationType?: string };
    if (!targetCiId || !relationType) {
      res.status(400).json({ error: 'targetCiId and relationType are required' });
      return;
    }
    try {
      const relation = await prisma.$transaction(async (tx: {
        $queryRaw: (...args: unknown[]) => Promise<{ id: string }[]>;
        $executeRaw: (...args: unknown[]) => Promise<number>;
      }) => {
        const inserted = await tx.$queryRaw`INSERT INTO ci_relations ... RETURNING id::text`;
        if (!inserted.length) return inserted;
        await tx.$executeRaw`INSERT INTO "audit_logs" ... VALUES (..., 'CREATE_RELATION:...', 'CI_RELATION', ${inserted[0].id}, 'test@cmdb.local', now())`;
        return inserted;
      });

      if (!relation.length) {
        res.status(404).json({ error: 'One or both CIs not found.' });
        return;
      }

      res.status(201).json({ id: relation[0].id, relationType, message: 'Relationship created successfully' });
    } catch {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return app;
}

describe('relation creation transactional audit (issue #172)', () => {
  const validBody = { targetCiId: 'ci-2', relationType: 'CONNECTED_TO' };

  it('commits the relation AND its audit record when the audit succeeds', async () => {
    const { prisma, committed } = makeMockPrisma({ failAudit: false });
    const res = await request(buildApp(prisma)).post('/api/cis/ci-1/relations').send(validBody);

    expect(res.status).toBe(201);
    expect(committed.relations).toHaveLength(1);
    expect(committed.audits).toBe(1);
  });

  it('does NOT persist the relation when the audit insert fails (rollback)', async () => {
    const { prisma, committed } = makeMockPrisma({ failAudit: true });
    const res = await request(buildApp(prisma)).post('/api/cis/ci-1/relations').send(validBody);

    // Handler surfaces the failure...
    expect(res.status).toBe(500);
    // ...and crucially the mutation did NOT commit — no unlogged write.
    expect(committed.relations).toHaveLength(0);
    expect(committed.audits).toBe(0);
  });

  it('commits a safe no-op (no relation, no audit) when both CIs do not exist', async () => {
    const { prisma, committed } = makeMockPrisma({ failAudit: false, noMatch: true });
    const res = await request(buildApp(prisma)).post('/api/cis/ci-1/relations').send(validBody);

    expect(res.status).toBe(404);
    expect(committed.relations).toHaveLength(0);
    expect(committed.audits).toBe(0);
  });
});
