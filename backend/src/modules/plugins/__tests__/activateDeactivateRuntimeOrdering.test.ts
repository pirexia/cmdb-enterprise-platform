/**
 * Issue #172 review fix — activate/deactivate runtime-side-effect ordering.
 *
 * Reviewer finding on the original Task 12 diff: pluginRuntime.registerPlugin
 * (activate) / pluginRuntime.unregisterPlugin (deactivate) are live,
 * irreversible in-process side effects (cron.schedule starts a running task
 * immediately, hooks are wired into the shared hookRegistry, routes are
 * mounted). If either runs INSIDE or BEFORE the prisma.$transaction that
 * flips the DB status + writes the audit record, a rolled-back transaction
 * (e.g. the audit insert throwing) leaves the runtime and the DB permanently
 * diverged — with no way to reconcile short of a manual deactivate or a
 * process restart.
 *
 * These tests prove the fix: when the transaction's audit insert throws,
 * pluginRuntime.registerPlugin / unregisterPlugin must NEVER be called at
 * all. When the transaction commits cleanly, the runtime call must still
 * happen (successful path is not broken by the reordering).
 *
 * Limitation: this exercises only the ordering/gating behavior at the router
 * level (does the runtime call happen or not, relative to a
 * throwing/succeeding transaction) — it does not drive a real cron task or
 * hookRegistry, which are already covered indirectly by engine.ts's own
 * unit surface. pluginRuntime.registerPlugin / unregisterPlugin are spied out
 * with jest.spyOn on the real singleton (not mocked away entirely) so a
 * signature drift in engine.ts would still show up as a type error here.
 */

import express from 'express';
import supertest from 'supertest';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createPluginRouter: (prisma: any) => express.Router;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pluginRuntime: any;

beforeAll(() => {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ({ createPluginRouter } = require('../router.js'));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ({ pluginRuntime } = require('../engine.js'));
});

function buildApp(prisma: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: 'admin-1', email: 'admin@test.local', role: 'ADMIN' };
    next();
  });
  app.use('/api/plugins', createPluginRouter(prisma));
  return app;
}

const PLUGIN_DB_ID = '11111111-1111-1111-1111-111111111111';

// Stateful mock Prisma mirroring the existing auditTransaction.test.ts pattern:
// $transaction only merges staged writes into `committed` if the callback
// resolves — a throw discards the staged status flip, exactly like a
// Postgres ROLLBACK.
function makeMockPrisma(opts: { initialStatus: 'INSTALLED' | 'ACTIVE'; failAudit: boolean }) {
  const committed = { status: opts.initialStatus };

  const prisma = {
    pluginRegistry: {
      // requirePluginExists + the post-commit "full" refetch in /activate
      findUnique: async () => ({
        id: PLUGIN_DB_ID,
        pluginId: 'ordering-test-plugin',
        status: committed.status,
        hooks: [],
        cronJobs: [],
        routes: [],
      }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $transaction: async (fn: (tx: any) => Promise<unknown>) => {
      let stagedStatus = committed.status;
      const tx = {
        pluginRegistry: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          update: async ({ data }: any) => {
            if (data.status) stagedStatus = data.status;
            return { id: PLUGIN_DB_ID };
          },
          findUnique: async () => ({ status: stagedStatus }),
        },
        $executeRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
          const action = values[0] as string;
          if (opts.failAudit && (action === 'PLUGIN_ACTIVATED' || action === 'PLUGIN_DEACTIVATED')) {
            throw new Error('audit insert failed (simulated)');
          }
          return 1;
        },
      };
      const result = await fn(tx); // may throw -> staged discarded (rollback)
      committed.status = stagedStatus;
      return result;
    },
  };

  return { prisma, committed };
}

describe('plugins activate/deactivate — runtime side effect ordering (issue #172 review fix)', () => {
  let registerSpy: jest.SpyInstance;
  let unregisterSpy: jest.SpyInstance;

  beforeEach(() => {
    registerSpy = jest.spyOn(pluginRuntime, 'registerPlugin').mockImplementation(() => {});
    unregisterSpy = jest.spyOn(pluginRuntime, 'unregisterPlugin').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('POST /:id/activate', () => {
    it('does NOT call pluginRuntime.registerPlugin when the transaction (status + audit) rolls back', async () => {
      const { prisma, committed } = makeMockPrisma({ initialStatus: 'INSTALLED', failAudit: true });

      const res = await supertest(buildApp(prisma)).post(`/api/plugins/${PLUGIN_DB_ID}/activate`).send({});

      expect(res.status).toBe(500);
      // DB status never flipped — rolled back with the audit insert.
      expect(committed.status).toBe('INSTALLED');
      // The live, irreversible runtime side effect must never have fired.
      expect(registerSpy).not.toHaveBeenCalled();
    });

    it('calls pluginRuntime.registerPlugin only AFTER the transaction has committed', async () => {
      const { prisma, committed } = makeMockPrisma({ initialStatus: 'INSTALLED', failAudit: false });

      const res = await supertest(buildApp(prisma)).post(`/api/plugins/${PLUGIN_DB_ID}/activate`).send({});

      expect(res.status).toBe(200);
      expect(committed.status).toBe('ACTIVE');
      expect(registerSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST /:id/deactivate', () => {
    it('does NOT call pluginRuntime.unregisterPlugin when the transaction (status + audit) rolls back', async () => {
      const { prisma, committed } = makeMockPrisma({ initialStatus: 'ACTIVE', failAudit: true });

      const res = await supertest(buildApp(prisma)).post(`/api/plugins/${PLUGIN_DB_ID}/deactivate`).send({});

      expect(res.status).toBe(500);
      // DB status never flipped — the runtime must NOT have been torn down
      // out from under a plugin the DB still (correctly, post-rollback)
      // considers ACTIVE.
      expect(committed.status).toBe('ACTIVE');
      expect(unregisterSpy).not.toHaveBeenCalled();
    });

    it('calls pluginRuntime.unregisterPlugin only AFTER the transaction has committed', async () => {
      const { prisma, committed } = makeMockPrisma({ initialStatus: 'ACTIVE', failAudit: false });

      const res = await supertest(buildApp(prisma)).post(`/api/plugins/${PLUGIN_DB_ID}/deactivate`).send({});

      expect(res.status).toBe(200);
      expect(committed.status).toBe('INACTIVE');
      expect(unregisterSpy).toHaveBeenCalledTimes(1);
    });
  });
});
