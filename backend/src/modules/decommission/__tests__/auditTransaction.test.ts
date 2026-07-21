import express from 'express';
import request from 'supertest';
import { createDecommissionRouter } from '../router';

// Issue #172 — a business mutation and its audit insert must be atomic: if the
// audit insert fails, the mutation must NOT persist. These tests prove that by
// mounting the real router over a mock Prisma whose $transaction only "commits"
// the staged writes when the callback resolves — mirroring Postgres rollback
// semantics. If the audit throws inside the callback, nothing is committed.

interface Committed {
  plans: unknown[];
  audits: number;
}

function makeMockPrisma(opts: { failAudit: boolean }) {
  const committed: Committed = { plans: [], audits: 0 };

  const prisma = {
    // Non-transactional read used by the CREATE handler to verify the CI is
    // of type SISTEMA before opening the transaction.
    $queryRaw: async () => [{ id: 'ci-1', type_code: 'SISTEMA' }],

    // Interactive transaction: runs the callback against a staging client and
    // only applies the staged writes to `committed` if the callback resolves.
    // A throw (e.g. the simulated audit failure) short-circuits before commit.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const staged: Committed = { plans: [], audits: 0 };
      const tx = {
        // createPlan() runs prisma.$queryRaw`INSERT ... RETURNING *`
        $queryRaw: async () => {
          const plan = {
            id: 'plan-1',
            name: 'Test Plan',
            system_ci_id: 'ci-1',
            status: 'DRAFT',
            created_by: 'claude@cmdb.local',
            created_at: new Date(),
            updated_at: new Date(),
            completed_at: null,
          };
          staged.plans.push(plan);
          return [plan];
        },
        // decommissionAudit() calls tx.$executeRaw
        $executeRaw: async () => {
          if (opts.failAudit) throw new Error('audit insert failed (simulated)');
          staged.audits += 1;
          return 1;
        },
      };

      const result = await fn(tx); // may throw -> staged is discarded (rollback)
      committed.plans.push(...staged.plans);
      committed.audits += staged.audits;
      return result;
    },
  };

  return { prisma, committed };
}

function buildApp(prisma: unknown) {
  const app = express();
  app.use(express.json());
  // Inject an ADMIN user so requireAdminRole passes.
  app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: 'admin-1', email: 'admin@test.local', role: 'ADMIN' };
    next();
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use('/api/decommission', createDecommissionRouter(prisma as any));
  return app;
}

const validPlanBody = {
  name: 'Test Plan',
  systemCiId: '11111111-1111-1111-1111-111111111111',
};

describe('decommission transactional audit (issue #172)', () => {
  it('commits the plan AND its audit record when the audit succeeds', async () => {
    const { prisma, committed } = makeMockPrisma({ failAudit: false });
    const res = await request(buildApp(prisma)).post('/api/decommission/plans').send(validPlanBody);

    expect(res.status).toBe(201);
    expect(committed.plans).toHaveLength(1);
    expect(committed.audits).toBe(1);
  });

  it('does NOT persist the plan when the audit insert fails (rollback)', async () => {
    const { prisma, committed } = makeMockPrisma({ failAudit: true });
    const res = await request(buildApp(prisma)).post('/api/decommission/plans').send(validPlanBody);

    // Handler surfaces the failure...
    expect(res.status).toBe(500);
    // ...and crucially the mutation did NOT commit — no unlogged write.
    expect(committed.plans).toHaveLength(0);
    expect(committed.audits).toBe(0);
  });
});
