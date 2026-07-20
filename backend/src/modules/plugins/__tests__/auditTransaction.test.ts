/**
 * Issue #172 (ISO 27001 A.8.15) rollback test — the highest-risk plugin
 * write: one-click marketplace install (PLUGIN_INSTALLED, router.ts
 * POST /marketplace/install, the v2.8.5 one-click path).
 *
 * Mirrors the catalog/staff-schedule reference tests: mounts the REAL router
 * over a mock Prisma whose $transaction only "commits" staged writes when the
 * callback resolves — mirroring Postgres rollback semantics. If the final
 * audit insert (PLUGIN_INSTALLED) throws inside the callback, nothing in
 * that transaction is committed: not the hook/cron/route resync, not the
 * status flip to INSTALLED.
 *
 * A real (tiny, valid) ZIP fixture is built with the system `zip` CLI so the
 * router's internal `unzip`-based extraction/manifest-parsing helpers (not
 * separately mockable — they are private to router.ts) run against real
 * files instead of being stubbed out.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import express from 'express';
import supertest from 'supertest';

const STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-tx-storage-'));
const FIXTURE_SRC = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-tx-fixture-'));
const FIXTURE_ZIP = path.join(os.tmpdir(), `plugin-tx-fixture-${Date.now()}.zip`);

const MANIFEST = {
  id: 'tx-test-plugin',
  name: 'Tx Test Plugin',
  version: '1.0.0',
  author: 'Test',
  license: 'MIT',
};

// Build a minimal, real, valid plugin ZIP containing only manifest.json (no
// hooks/cron/routes declared) — keeps parseBundleArtifacts's filesystem
// reads at zero (it only issues deleteMany() calls when there is nothing to
// recreate) while still exercising the real unzip-based extraction path.
fs.writeFileSync(path.join(FIXTURE_SRC, 'manifest.json'), JSON.stringify(MANIFEST));
execFileSync('zip', ['-j', FIXTURE_ZIP, path.join(FIXTURE_SRC, 'manifest.json')]);
const FIXTURE_ZIP_BYTES = fs.readFileSync(FIXTURE_ZIP);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createPluginRouter: (prisma: any) => express.Router;

// PLUGIN_STORAGE_PATH etc. are read into module-level consts at import time,
// so they must be set BEFORE the module is first required — resetModules +
// a plain require() inside beforeAll (not a static import) guarantees that.
beforeAll(() => {
  process.env.PLUGIN_STORAGE_PATH = STORAGE_DIR;
  process.env.PLUGIN_ENABLE_MARKETPLACE = 'true';
  process.env.PLUGIN_MARKETPLACE_URL = 'https://marketplace.example.com';
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ({ createPluginRouter } = require('../router.js'));
});

afterAll(() => {
  fs.rmSync(STORAGE_DIR, { recursive: true, force: true });
  fs.rmSync(FIXTURE_SRC, { recursive: true, force: true });
  fs.rmSync(FIXTURE_ZIP, { force: true });
});

// Mocks global fetch by URL (not call order) so it works regardless of
// whether the router's 5-min in-process marketplace cache is warm from a
// previous test in this file.
function mockFetch() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return jest.fn(async (url: any) => {
    const u = String(url);
    if (u.endsWith('/api/plugins')) {
      return {
        ok: true,
        json: async () => ({
          plugins: [
            {
              id: 'tx-test-plugin',
              name: 'Tx Test Plugin',
              version: '1.0.0',
              downloadUrl: 'https://marketplace.example.com/tx-test-plugin.zip',
            },
          ],
        }),
      };
    }
    return {
      ok: true,
      arrayBuffer: async () =>
        FIXTURE_ZIP_BYTES.buffer.slice(
          FIXTURE_ZIP_BYTES.byteOffset,
          FIXTURE_ZIP_BYTES.byteOffset + FIXTURE_ZIP_BYTES.byteLength,
        ),
    };
  });
}

// Stateful mock Prisma: tracks the plugin's committed status + audit history
// across the THREE sequential $transaction calls the marketplace-install
// handler makes (create+STARTED, VALIDATED, artifact-resync+INSTALLED).
// Each $transaction call only merges its staged writes into `committed` if
// the callback resolves — a throw (the simulated audit failure) discards the
// staged writes for THAT transaction only, exactly like a Postgres ROLLBACK.
function makeMockPrisma(opts: { failInstallAudit: boolean }) {
  const committed = { status: null as string | null, audits: [] as string[], hookDeletes: 0 };
  const dbId = 'db-plugin-1';

  function makeTx(staged: { status: string | null; audits: string[]; hookDeletes: number }) {
    return {
      pluginRegistry: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        create: async ({ data }: any) => {
          staged.status = data.status;
          return { id: dbId, pluginId: data.pluginId, ...data };
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        update: async ({ data }: any) => {
          if (data.status) staged.status = data.status;
          return { id: dbId };
        },
        findUnique: async () => ({ status: staged.status ?? committed.status }),
      },
      pluginHook: {
        deleteMany: async () => {
          staged.hookDeletes += 1;
          return { count: 0 };
        },
      },
      pluginCronJob: { deleteMany: async () => ({ count: 0 }) },
      pluginRoute: { deleteMany: async () => ({ count: 0 }) },
      // pluginAudit() calls db.$executeRaw`...VALUES (gen_random_uuid(), ${action}, ...)`
      // — the tag function receives (strings, action, ...rest), so values[0] is the action.
      $executeRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        const action = values[0] as string;
        if (opts.failInstallAudit && action === 'PLUGIN_INSTALLED') {
          throw new Error('audit insert failed (simulated)');
        }
        staged.audits.push(action);
        return 1;
      },
    };
  }

  const prisma = {
    pluginRegistry: {
      // Duplicate check in the handler (by pluginId) — never a duplicate here.
      findUnique: async () => null,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $transaction: async (fn: (tx: any) => Promise<unknown>) => {
      const staged = { status: committed.status, audits: [] as string[], hookDeletes: 0 };
      const tx = makeTx(staged);
      const result = await fn(tx); // may throw -> staged discarded (rollback)
      committed.status = staged.status;
      committed.audits.push(...staged.audits);
      committed.hookDeletes += staged.hookDeletes;
      return result;
    },
  };

  return { prisma, committed };
}

function buildApp(prisma: unknown) {
  const app = express();
  app.use(express.json());
  // Inject an ADMIN user so requireAdmin (applied to the whole router) passes.
  app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { id: 'admin-1', email: 'admin@test.local', role: 'ADMIN' };
    next();
  });
  app.use('/api/plugins', createPluginRouter(prisma));
  return app;
}

describe('plugins transactional audit (issue #172) — marketplace install / PLUGIN_INSTALLED', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('commits the hook/cron/route resync, status=INSTALLED, and all 3 audit records when everything succeeds', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    global.fetch = mockFetch() as any;
    const { prisma, committed } = makeMockPrisma({ failInstallAudit: false });

    const res = await supertest(buildApp(prisma))
      .post('/api/plugins/marketplace/install')
      .send({ pluginId: 'tx-test-plugin' });

    expect(res.status).toBe(201);
    expect(committed.status).toBe('INSTALLED');
    expect(committed.audits).toEqual([
      'PLUGIN_MARKETPLACE_INSTALL_STARTED',
      'PLUGIN_VALIDATED',
      'PLUGIN_INSTALLED',
    ]);
    expect(committed.hookDeletes).toBe(1);
  });

  it('does NOT persist the INSTALLED status or the artifact resync when the PLUGIN_INSTALLED audit insert fails (rollback)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    global.fetch = mockFetch() as any;
    const { prisma, committed } = makeMockPrisma({ failInstallAudit: true });

    const res = await supertest(buildApp(prisma))
      .post('/api/plugins/marketplace/install')
      .send({ pluginId: 'tx-test-plugin' });

    // The handler's outer catch surfaces the failure...
    expect(res.status).toBe(500);
    // ...the two EARLIER transactions (STARTED, VALIDATED) already committed
    // — they are independent units of work, correctly unaffected by a later,
    // separate transaction rolling back...
    expect(committed.audits).toEqual([
      'PLUGIN_MARKETPLACE_INSTALL_STARTED',
      'PLUGIN_VALIDATED',
    ]);
    // ...but crucially the final transaction's mutation did NOT commit: the
    // status is still VALIDATED (never reached INSTALLED), and the
    // hook/cron/route resync inside that same transaction never landed
    // either. No unlogged write.
    expect(committed.status).toBe('VALIDATED');
    expect(committed.hookDeletes).toBe(0);
  });
});
