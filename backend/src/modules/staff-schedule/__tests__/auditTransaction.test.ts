import express from 'express';
import request from 'supertest';
import { createStaffScheduleRouter } from '../router';

// Issue #172 — a business mutation and its audit insert must be atomic: if the
// audit insert fails, the mutation must NOT persist. These tests prove that by
// mounting the real router over a mock Prisma whose $transaction only "commits"
// the staged writes when the callback resolves — mirroring Postgres rollback
// semantics. If the audit throws inside the callback, nothing is committed.

interface Committed {
  departments: unknown[];
  configs: unknown[];
  audits: number;
}

function makeMockPrisma(opts: { failAudit: boolean }) {
  const committed: Committed = { departments: [], configs: [], audits: 0 };

  const prisma = {
    // Interactive transaction: runs the callback against a staging client and
    // only applies the staged writes to `committed` if the callback resolves.
    // A throw (e.g. the simulated audit failure) short-circuits before commit.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const staged: Committed = { departments: [], configs: [], audits: 0 };
      const tx = {
        department: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            const dept = { id: 'dept-1', ...data };
            staged.departments.push(dept);
            return dept;
          },
        },
        departmentScheduleConfig: {
          create: async ({ data }: { data: unknown }) => {
            staged.configs.push(data);
            return data;
          },
        },
        // auditStaffSchedule() calls db.$executeRaw
        $executeRaw: async () => {
          if (opts.failAudit) throw new Error('audit insert failed (simulated)');
          staged.audits += 1;
          return 1;
        },
      };

      const result = await fn(tx); // may throw -> staged is discarded (rollback)
      committed.departments.push(...staged.departments);
      committed.configs.push(...staged.configs);
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
  app.use('/api/staff-schedule', createStaffScheduleRouter(prisma as any));
  return app;
}

const validDeptBody = {
  name: 'Test Dept',
  code: 'TEST_TX',
  serviceStart: '09:00',
  serviceEnd: '19:00',
  presenceStart: '10:00',
  presenceEnd: '14:00',
  minPresencePct: 50,
};

describe('staff-schedule transactional audit (issue #172)', () => {
  it('commits the department AND its audit record when the audit succeeds', async () => {
    const { prisma, committed } = makeMockPrisma({ failAudit: false });
    const res = await request(buildApp(prisma)).post('/api/staff-schedule/departments').send(validDeptBody);

    expect(res.status).toBe(201);
    expect(committed.departments).toHaveLength(1);
    expect(committed.configs).toHaveLength(1);
    expect(committed.audits).toBe(1);
  });

  it('does NOT persist the department when the audit insert fails (rollback)', async () => {
    const { prisma, committed } = makeMockPrisma({ failAudit: true });
    const res = await request(buildApp(prisma)).post('/api/staff-schedule/departments').send(validDeptBody);

    // Handler surfaces the failure...
    expect(res.status).toBe(500);
    // ...and crucially the mutation did NOT commit — no unlogged write.
    expect(committed.departments).toHaveLength(0);
    expect(committed.configs).toHaveLength(0);
    expect(committed.audits).toBe(0);
  });
});
