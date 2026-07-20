import express from 'express';
import request from 'supertest';
import { createDcimRouter } from '../router';

// Issue #172 — a business mutation and its audit insert must be atomic: if the
// audit insert fails, the mutation must NOT persist. These tests prove that by
// mounting the real router over a mock Prisma whose $transaction only "commits"
// the staged writes when the callback resolves — mirroring Postgres rollback
// semantics. If the audit throws inside the callback, nothing is committed.

interface Committed { buildings: unknown[]; audits: number; }

function makeMockPrisma(opts: { failAudit: boolean }) {
  const committed: Committed = { buildings: [], audits: 0 };

  const prisma = {
    // Interactive transaction: runs the callback against a staging client and
    // only applies the staged writes to `committed` if the callback resolves.
    // A throw (e.g. the simulated audit failure) short-circuits before commit.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const staged: Committed = { buildings: [], audits: 0 };
      const tx = {
        dcimBuilding: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            const record = { id: 'bld-1', ...data };
            staged.buildings.push(record);
            return record;
          },
        },
        // dcimAudit() calls db.$executeRaw
        $executeRaw: async () => {
          if (opts.failAudit) throw new Error('audit insert failed (simulated)');
          staged.audits += 1;
          return 1;
        },
      };

      const result = await fn(tx); // may throw -> staged is discarded (rollback)
      committed.buildings.push(...staged.buildings);
      committed.audits += staged.audits;
      return result;
    },
  };

  return { prisma, committed };
}

function buildApp(prisma: unknown) {
  const app = express();
  app.use(express.json());
  // Inject an ADMIN user so requireAdmin passes.
  app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: 'admin-1', email: 'admin@test.local', role: 'ADMIN' };
    next();
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use('/api/dcim', createDcimRouter(prisma as any));
  return app;
}

const validBody = { branchId: '11111111-1111-1111-1111-111111111111', name: 'Test Building' };

describe('dcim transactional audit (issue #172)', () => {
  it('commits the DcimBuilding AND its audit record when the audit succeeds', async () => {
    const { prisma, committed } = makeMockPrisma({ failAudit: false });
    const res = await request(buildApp(prisma)).post('/api/dcim/buildings').send(validBody);

    expect(res.status).toBe(201);
    expect(committed.buildings).toHaveLength(1);
    expect(committed.audits).toBe(1);
  });

  it('does NOT persist the DcimBuilding when the audit insert fails (rollback)', async () => {
    const { prisma, committed } = makeMockPrisma({ failAudit: true });
    const res = await request(buildApp(prisma)).post('/api/dcim/buildings').send(validBody);

    // Handler surfaces the failure...
    expect(res.status).toBe(500);
    // ...and crucially the mutation did NOT commit — no unlogged write.
    expect(committed.buildings).toHaveLength(0);
    expect(committed.audits).toBe(0);
  });
});
