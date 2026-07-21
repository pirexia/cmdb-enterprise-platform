import express from 'express';
import request from 'supertest';
import { createAlertsRouter } from '../router';

// Issue #172 — a business mutation and its audit insert must be atomic: if the
// audit insert fails, the mutation must NOT persist. This test proves that by
// mounting the real router over a mock Prisma whose $transaction only "commits"
// the staged writes when the callback resolves — mirroring Postgres rollback
// semantics. If the audit throws inside the callback, nothing is committed.

interface Committed {
  config: Record<string, unknown> | null;
  audits: number;
}

function makeMockPrisma(opts: { failAudit: boolean }) {
  const committed: Committed = { config: null, audits: 0 };

  const prisma = {
    // Interactive transaction: runs the callback against a staging client and
    // only applies the staged writes to `committed` if the callback resolves.
    // A throw (e.g. the simulated audit failure) short-circuits before commit.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      let stagedConfig: Record<string, unknown> | null = committed.config
        ? { ...committed.config }
        : null;
      let stagedAudits = 0;

      const tx = {
        alertConfig: {
          upsert: async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
            stagedConfig = stagedConfig ? { ...stagedConfig, ...update } : { id: 'default', ...create };
            return stagedConfig;
          },
          findUnique: async () => stagedConfig,
        },
        // Used both by upsertConfig()'s optional channel UPDATE and by
        // insertAlertAudit() — our test body carries no teams/slack fields, so
        // the only $executeRaw hit in this flow is the audit insert.
        $executeRaw: async () => {
          if (opts.failAudit) throw new Error('audit insert failed (simulated)');
          stagedAudits += 1;
          return 1;
        },
      };

      const result = await fn(tx); // may throw -> staged is discarded (rollback)
      committed.config = stagedConfig;
      committed.audits += stagedAudits;
      return result;
    },
  };

  return { prisma, committed };
}

function buildApp(prisma: unknown) {
  const app = express();
  app.use(express.json());
  // Inject an ADMIN user so the router's local requireAdmin passes.
  app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: 'admin-1', email: 'admin@test.local', role: 'ADMIN' };
    next();
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use('/api/alerts', createAlertsRouter(prisma as any));
  return app;
}

const validConfigBody = {
  enabled: true,
  recipients: ['ops@example.com'],
};

describe('alerts transactional audit (issue #172)', () => {
  it('commits the config update AND its audit record when the audit succeeds', async () => {
    const { prisma, committed } = makeMockPrisma({ failAudit: false });
    const res = await request(buildApp(prisma)).put('/api/alerts/config').send(validConfigBody);

    expect(res.status).toBe(200);
    expect(committed.config).not.toBeNull();
    expect(committed.config?.['enabled']).toBe(true);
    expect(committed.audits).toBe(1);
  });

  it('does NOT persist the config update when the audit insert fails (rollback)', async () => {
    const { prisma, committed } = makeMockPrisma({ failAudit: true });
    const res = await request(buildApp(prisma)).put('/api/alerts/config').send(validConfigBody);

    // Handler surfaces the failure...
    expect(res.status).toBe(500);
    // ...and crucially the mutation did NOT commit — no unlogged write.
    expect(committed.config).toBeNull();
    expect(committed.audits).toBe(0);
  });
});
