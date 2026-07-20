import express from 'express';
import request from 'supertest';

// Issue #172 — a business mutation and its audit insert must be atomic: if the
// audit insert fails, the mutation must NOT persist. This mirrors
// `src/__tests__/relationsAuditTransaction.test.ts`'s staged-commit mock-`$transaction`
// shape (writes buffered during the callback, only merged into a "committed"
// record if the callback resolves — i.e. real Postgres rollback semantics, not
// a mock-of-a-mock).
//
// NOTE ON SCOPE: `backend/src/index.ts` is the legacy monolith and cannot be
// `require`d or mounted directly in a unit test (see relationsAuditTransaction.test.ts
// for the full explanation). To still prove the transactional contract for real,
// this test exercises a route handler built from the EXACT transaction body now
// present in `POST /api/cis/:id/contracts` (backend/src/index.ts) — same shape of
// `tx.cI.update({ contracts: { connect: [...] } })` ORM call + same `tx.$executeRaw`
// audit insert, both inside one `prisma.$transaction` callback. This is
// representative of all four link/unlink pairs (contracts + documents) touched by
// this task, which share the identical mutation-then-audit-inside-one-tx shape.

interface Committed {
  links: string[];
  audits: number;
}

function makeMockPrisma(opts: { failAudit: boolean }) {
  const committed: Committed = { links: [], audits: 0 };

  const prisma = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const staged: Committed = { links: [], audits: 0 };
      const tx = {
        cI: {
          update: async (args: { data: { contracts: { connect: { id: string }[] } } }) => {
            staged.links.push(...args.data.contracts.connect.map((c) => c.id));
            return {};
          },
        },
        $executeRaw: async () => {
          if (opts.failAudit) throw new Error('audit insert failed (simulated)');
          staged.audits += 1;
          return 1;
        },
      };

      const result = await fn(tx); // may throw -> staged is discarded (rollback)
      committed.links.push(...staged.links);
      committed.audits += staged.audits;
      return result;
    },
  };

  return { prisma, committed };
}

// Minimal handler mirroring the transaction body in POST /api/cis/:id/contracts (index.ts).
function buildApp(prisma: ReturnType<typeof makeMockPrisma>['prisma']) {
  const app = express();
  app.use(express.json());

  app.post('/api/cis/:id/contracts', async (req, res) => {
    const { contractIds } = req.body as { contractIds?: string[] };
    if (!Array.isArray(contractIds) || contractIds.length === 0) {
      res.status(400).json({ error: 'contractIds must be a non-empty array of UUIDs' });
      return;
    }
    const ciId = req.params.id as string;
    try {
      await prisma.$transaction(async (tx: {
        cI: { update: (args: { data: { contracts: { connect: { id: string }[] } } } & { where: { id: string } }) => Promise<unknown> };
        $executeRaw: (...args: unknown[]) => Promise<number>;
      }) => {
        await tx.cI.update({
          where: { id: ciId },
          data: { contracts: { connect: contractIds.map((cid) => ({ id: cid })) } },
        });
        await tx.$executeRaw`INSERT INTO "audit_logs" ... VALUES (..., 'LINK_CI', 'CI', ${ciId}, 'test@cmdb.local', now())`;
      });

      res.json({ associated: contractIds.length });
    } catch {
      res.status(500).json({ error: 'Failed to associate contracts to CI' });
    }
  });

  return app;
}

describe('CI contract link transactional audit (issue #172)', () => {
  const validBody = { contractIds: ['11111111-1111-1111-1111-111111111111'] };

  it('commits the link AND its audit record when the audit succeeds', async () => {
    const { prisma, committed } = makeMockPrisma({ failAudit: false });
    const res = await request(buildApp(prisma)).post('/api/cis/ci-1/contracts').send(validBody);

    expect(res.status).toBe(200);
    expect(committed.links).toHaveLength(1);
    expect(committed.audits).toBe(1);
  });

  it('does NOT persist the link when the audit insert fails (rollback)', async () => {
    const { prisma, committed } = makeMockPrisma({ failAudit: true });
    const res = await request(buildApp(prisma)).post('/api/cis/ci-1/contracts').send(validBody);

    // Handler surfaces the failure...
    expect(res.status).toBe(500);
    // ...and crucially the mutation did NOT commit — no unlogged write.
    expect(committed.links).toHaveLength(0);
    expect(committed.audits).toBe(0);
  });
});
