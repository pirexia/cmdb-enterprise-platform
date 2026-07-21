/**
 * Issue #172 — a settings mutation and its audit insert must be atomic: if the
 * audit insert fails, the mutation must NOT persist. These tests prove that by
 * mounting the real router over a mock Prisma whose $transaction only "commits"
 * the staged writes when the callback resolves — mirroring Postgres rollback
 * semantics. If the audit throws inside the callback, nothing is committed.
 *
 * Covers UPDATE_THEME (simplest write site — no filesystem interaction).
 */

process.env.JWT_SECRET = 'test-secret-32-chars-minimum-len!!';
const TEST_SECRET = 'test-secret-32-chars-minimum-len!!';

interface Committed {
  upserts: unknown[];
  audits: number;
}

let committed: Committed;
let failAudit: boolean;

const mockQueryRaw = jest.fn(); // authenticateToken active-user check

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    appSettings: {
      // Only reached by the (public, unauthenticated) GET routes — not
      // exercised by these tests.
      findMany: async () => [],
    },
    $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
    // Interactive transaction: runs the callback against a staging client and
    // only applies the staged writes to `committed` if the callback resolves.
    // A throw (e.g. the simulated audit failure) short-circuits before commit.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const staged: Committed = { upserts: [], audits: 0 };
      const tx = {
        appSettings: {
          upsert: async (args: { where: { key: string }; update: { value: string } }) => {
            const row = { key: args.where.key, value: args.update.value };
            staged.upserts.push(row);
            return row;
          },
        },
        // settingsAudit() calls db.$executeRaw
        $executeRaw: async () => {
          if (failAudit) throw new Error('audit insert failed (simulated)');
          staged.audits += 1;
          return 1;
        },
      };

      const result = await fn(tx); // may throw -> staged is discarded (rollback)
      committed.upserts.push(...staged.upserts);
      committed.audits += staged.audits;
      return result;
    },
  })),
}));

import express        from 'express';
import request         from 'supertest';
import jwt              from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { createSettingsRouter } from '../router.js';

const prisma = new PrismaClient() as any;

function makeAdminToken(): string {
  return jwt.sign(
    { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', username: 'admin', email: 'admin@test.local', role: 'ADMIN' },
    TEST_SECRET,
    { expiresIn: '1h' },
  );
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/settings', createSettingsRouter(prisma));
  return request(app);
}

const validThemeBody = {
  sidebarBg: '#111111',
  accentColor: '#22ff22',
  companyName: 'Acme Test',
};

beforeEach(() => {
  committed = { upserts: [], audits: 0 };
  mockQueryRaw.mockReset();
  mockQueryRaw.mockResolvedValue([{ active: true }]);
});

describe('settings transactional audit (issue #172)', () => {
  it('commits the theme upserts AND the audit record when the audit succeeds', async () => {
    failAudit = false;
    const res = await buildApp()
      .put('/api/settings/theme')
      .set('Authorization', `Bearer ${makeAdminToken()}`)
      .send(validThemeBody);

    expect(res.status).toBe(200);
    expect(committed.upserts).toHaveLength(3);
    expect(committed.audits).toBe(1);
  });

  it('does NOT persist the theme upserts when the audit insert fails (rollback)', async () => {
    failAudit = true;
    const res = await buildApp()
      .put('/api/settings/theme')
      .set('Authorization', `Bearer ${makeAdminToken()}`)
      .send(validThemeBody);

    // Handler surfaces the failure...
    expect(res.status).toBe(500);
    // ...and crucially the mutation did NOT commit — no unlogged write.
    expect(committed.upserts).toHaveLength(0);
    expect(committed.audits).toBe(0);
  });
});
