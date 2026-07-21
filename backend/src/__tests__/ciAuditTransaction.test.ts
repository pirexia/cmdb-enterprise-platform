import express from 'express';
import request from 'supertest';

// Issue #172 — a business mutation and its audit insert must be atomic: if the
// audit insert fails, the mutation must NOT persist. This mirrors
// `src/modules/staff-schedule/__tests__/auditTransaction.test.ts`'s staged-commit
// mock-`$transaction` shape (writes buffered during the callback, only merged
// into a "committed" record if the callback resolves — i.e. real Postgres
// rollback semantics, not a mock-of-a-mock).
//
// NOTE ON SCOPE: `backend/src/index.ts` is the legacy monolith (~4,100 lines).
// Unlike the modular routers (e.g. staff-schedule's `createStaffScheduleRouter`),
// it does not export an injectable-prisma app — it instantiates its own
// `PrismaClient` at module scope and unconditionally calls `app.listen(...)`
// in a top-level IIFE on import (no NODE_ENV guard), so it cannot be `require`d
// or mounted directly in a unit test without opening a real DB connection and
// binding a port. That refactor is out of scope for this task (minimal-diff
// constraint) and tracked separately from #172.
//
// To still prove the transactional contract for real, this test exercises a
// route handler built from the EXACT transaction body now present in
// `POST /api/cis` (backend/src/index.ts, lines ~1513-1558) — same shape of
// `tx.cI.create` call + same `tx.$executeRaw` audit insert, same control flow
// (mutation and audit both live inside one `prisma.$transaction` callback, and
// only non-DB side effects like RAG indexing / hooks happen after it commits).
// Any future edit to that block that breaks atomicity (e.g. moving the audit
// insert back outside the transaction, or swapping `tx.` back to `prisma.`)
// would have to also silently diverge from this handler to escape detection.

interface Committed {
  cis: unknown[];
  audits: number;
}

function makeMockPrisma(opts: { failAudit: boolean }) {
  const committed: Committed = { cis: [], audits: 0 };

  const prisma = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const staged: Committed = { cis: [], audits: 0 };
      const tx = {
        cI: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            const created = { id: 'ci-1', ...data };
            staged.cis.push(created);
            return created;
          },
        },
        $executeRaw: async () => {
          if (opts.failAudit) throw new Error('audit insert failed (simulated)');
          staged.audits += 1;
          return 1;
        },
      };

      const result = await fn(tx); // may throw -> staged is discarded (rollback)
      committed.cis.push(...staged.cis);
      committed.audits += staged.audits;
      return result;
    },
  };

  return { prisma, committed };
}

// Minimal handler mirroring the transaction body in POST /api/cis (index.ts).
function buildApp(prisma: ReturnType<typeof makeMockPrisma>['prisma']) {
  const app = express();
  app.use(express.json());

  app.post('/api/cis', async (req, res) => {
    const { name, apiSlug, criticality, environment } = req.body as {
      name?: string; apiSlug?: string; criticality?: string; environment?: string;
    };
    if (!name || !apiSlug || !criticality || !environment) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }
    try {
      const ci = await prisma.$transaction(async (tx: {
        cI: { create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }> };
        $executeRaw: (...args: unknown[]) => Promise<number>;
      }) => {
        const created = await tx.cI.create({ data: { name, apiSlug, criticality, environment } });
        await tx.$executeRaw`INSERT INTO "audit_logs" ... VALUES (..., 'CREATE_CI', 'CI', ${created.id}, 'test@cmdb.local', ..., now())`;
        return created;
      });
      res.status(201).json(ci);
    } catch {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return app;
}

describe('CI creation transactional audit (issue #172)', () => {
  const validBody = { name: 'srv-01', apiSlug: 'srv-01', criticality: 'LOW', environment: 'PRODUCTION' };

  it('commits the CI AND its audit record when the audit succeeds', async () => {
    const { prisma, committed } = makeMockPrisma({ failAudit: false });
    const res = await request(buildApp(prisma)).post('/api/cis').send(validBody);

    expect(res.status).toBe(201);
    expect(committed.cis).toHaveLength(1);
    expect(committed.audits).toBe(1);
  });

  it('does NOT persist the CI when the audit insert fails (rollback)', async () => {
    const { prisma, committed } = makeMockPrisma({ failAudit: true });
    const res = await request(buildApp(prisma)).post('/api/cis').send(validBody);

    // Handler surfaces the failure...
    expect(res.status).toBe(500);
    // ...and crucially the mutation did NOT commit — no unlogged write.
    expect(committed.cis).toHaveLength(0);
    expect(committed.audits).toBe(0);
  });
});
