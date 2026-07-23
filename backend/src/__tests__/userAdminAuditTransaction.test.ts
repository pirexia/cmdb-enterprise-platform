import express from 'express';
import request from 'supertest';

// Issue #172 — a business mutation and its audit insert must be atomic: if the
// audit insert fails, the mutation must NOT persist. This mirrors
// `src/__tests__/ciAuditTransaction.test.ts` / `relationsAuditTransaction.test.ts`'s
// staged-commit mock-`$transaction` shape (writes buffered during the callback,
// only merged into a "committed" record if the callback resolves — i.e. real
// Postgres rollback semantics, not a mock-of-a-mock).
//
// NOTE ON SCOPE: `backend/src/index.ts` is the legacy monolith. It does not
// export an injectable-prisma app — it instantiates its own `PrismaClient` at
// module scope and unconditionally calls `app.listen(...)` in a top-level IIFE
// on import (no NODE_ENV guard), so it cannot be `require`d or mounted directly
// in a unit test without opening a real DB connection and binding a port. To
// still prove the transactional contract for real, these tests exercise route
// handlers built from the EXACT transaction bodies now present in
// `PATCH /api/users/:id/role` and `DELETE /api/admin/users/:id` (index.ts).
//
// This file covers the two highest-severity sites from Task 4 (role change,
// GDPR erasure). Status/change-password/reset-password apply the identical
// transform and are covered by TypeScript + the manual verification in the
// task report.
//
// NOTE ON MOCK LIMITATIONS (issue #191): the mock `$executeRaw` below never
// touches real Postgres, so it cannot catch parameter-binding/type-cast
// errors — e.g. the `SET role = ${role}` bug where Prisma bound the enum
// column `users.role` (`"UserRole"`) as a `text` parameter, which Postgres
// rejects with 42804 ("column is of type UserRole but expression is of type
// text") since it has no implicit text->enum cast. That bug caused every
// PATCH /api/users/:id/role call to 500. The fix (`${role}::"UserRole"`,
// mirrored below) was verified against a real Postgres instance, not via
// this suite — no jest test in this codebase currently exercises a real DB
// connection (every module test mocks @prisma/client), so this file
// intentionally does not claim to catch that class of bug.

describe('user role change transactional audit (issue #172)', () => {
  interface Committed {
    role: string | null;
    audits: number;
  }

  function makeMockPrisma(opts: { failAudit: boolean }) {
    const committed: Committed = { role: null, audits: 0 };

    const prisma = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const staged: Committed = { role: null, audits: 0 };
        let call = 0;
        const tx = {
          $executeRaw: async () => {
            call += 1;
            if (call === 1) {
              // UPDATE "users" SET role = ...
              staged.role = 'ADMIN';
              return 1;
            }
            // audit insert
            if (opts.failAudit) throw new Error('audit insert failed (simulated)');
            staged.audits += 1;
            return 1;
          },
        };

        const result = await fn(tx); // may throw -> staged is discarded (rollback)
        committed.role = staged.role;
        committed.audits += staged.audits;
        return result;
      },
    };

    return { prisma, committed };
  }

  // Minimal handler mirroring the transaction body in PATCH /api/users/:id/role (index.ts).
  function buildApp(prisma: ReturnType<typeof makeMockPrisma>['prisma']) {
    const app = express();
    app.use(express.json());

    app.patch('/api/users/:id/role', async (req, res) => {
      const id = req.params.id as string;
      const { role } = req.body as { role?: string };
      if (!role || !(['ADMIN', 'AUDITOR', 'VIEWER'] as string[]).includes(role)) {
        res.status(400).json({ error: 'role must be "ADMIN", "AUDITOR" or "VIEWER"' });
        return;
      }
      try {
        await prisma.$transaction(async (tx: { $executeRaw: (...args: unknown[]) => Promise<number> }) => {
          await tx.$executeRaw`UPDATE "users" SET role = ${role}::"UserRole", updated_at = now() WHERE id = ${id}::uuid`;
          await tx.$executeRaw`
            INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
            VALUES(gen_random_uuid(), ${'SET_ROLE:' + role}, 'USER', ${id}, ${'admin@cmdb.local'}, now())
          `;
        });
        res.json({ id, role, message: `Role updated to ${role}` });
      } catch {
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    return app;
  }

  it('commits the role update AND its audit record when the audit succeeds', async () => {
    const { prisma, committed } = makeMockPrisma({ failAudit: false });
    const res = await request(buildApp(prisma)).patch('/api/users/u-1/role').send({ role: 'ADMIN' });

    expect(res.status).toBe(200);
    expect(committed.role).toBe('ADMIN');
    expect(committed.audits).toBe(1);
  });

  it('does NOT persist the role change when the audit insert fails (rollback)', async () => {
    const { prisma, committed } = makeMockPrisma({ failAudit: true });
    const res = await request(buildApp(prisma)).patch('/api/users/u-1/role').send({ role: 'ADMIN' });

    // Handler surfaces the failure...
    expect(res.status).toBe(500);
    // ...and crucially the role change did NOT commit — no unlogged privilege change.
    expect(committed.role).toBeNull();
    expect(committed.audits).toBe(0);
  });
});

describe('GDPR erasure transactional audit (issue #172)', () => {
  // This is the highest-severity site in the whole issue: previously, if the
  // erasure audit insert (step 4) failed AFTER the hard DELETE (step 3) had
  // already committed, the user would be permanently erased with zero
  // compliance record of who erased them or when. This test proves that gap
  // is closed: when the final audit insert throws, the user row must NOT be
  // deleted (the whole transaction rolls back together).

  interface Committed {
    pseudonymised: number;
    deleted: boolean;
    erasureAudits: number;
  }

  function makeMockPrisma(opts: { failAudit: boolean; noUser?: boolean }) {
    const committed: Committed = { pseudonymised: 0, deleted: false, erasureAudits: 0 };

    const prisma = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const staged: Committed = { pseudonymised: 0, deleted: false, erasureAudits: 0 };
        let executeCall = 0;
        const tx = {
          $queryRaw: async () => {
            if (opts.noUser) return [];
            return [{ id: 'u-1', email: 'target@cmdb.local', username: 'target' }];
          },
          $executeRaw: async () => {
            executeCall += 1;
            if (executeCall === 1) {
              // UPDATE audit_logs SET user_email = pseudoToken ... (pseudonymise)
              staged.pseudonymised += 1;
              return 1;
            }
            if (executeCall === 2) {
              // DELETE FROM users
              staged.deleted = true;
              return 1;
            }
            // INSERT INTO audit_logs (GDPR_ERASURE record)
            if (opts.failAudit) throw new Error('erasure audit insert failed (simulated)');
            staged.erasureAudits += 1;
            return 1;
          },
        };

        const result = await fn(tx); // may throw -> staged is discarded (rollback)
        committed.pseudonymised += staged.pseudonymised;
        committed.deleted = committed.deleted || staged.deleted;
        committed.erasureAudits += staged.erasureAudits;
        return result;
      },
    };

    return { prisma, committed };
  }

  // Minimal handler mirroring the transaction body in DELETE /api/admin/users/:id (index.ts).
  function buildApp(prisma: ReturnType<typeof makeMockPrisma>['prisma']) {
    const app = express();
    app.use(express.json());

    app.delete('/api/admin/users/:id', async (req, res) => {
      const targetId = req.params.id as string;
      try {
        const pseudoToken = await prisma.$transaction(async (tx: {
          $queryRaw: (...args: unknown[]) => Promise<{ id: string; email: string; username: string }[]>;
          $executeRaw: (...args: unknown[]) => Promise<number>;
        }) => {
          const rows = await tx.$queryRaw`SELECT id::text AS id, email, username FROM "users" WHERE id = ${targetId}::uuid LIMIT 1`;
          if (!rows.length) return null;
          const { email } = rows[0];

          const token = '[deleted-' + email + ']';
          await tx.$executeRaw`UPDATE "audit_logs" SET user_email = ${token} WHERE user_email = ${email}`;
          await tx.$executeRaw`DELETE FROM "users" WHERE id = ${targetId}::uuid`;
          await tx.$executeRaw`
            INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
            VALUES(gen_random_uuid(), 'GDPR_ERASURE', 'USER', ${targetId}::uuid, ${'admin@cmdb.local'}, now())
          `;
          return token;
        });

        if (pseudoToken === null) {
          res.status(404).json({ error: 'User not found.' });
          return;
        }

        res.json({ message: 'User erased. Audit log entries pseudonymised.' });
      } catch {
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    return app;
  }

  it('commits pseudonymisation, deletion AND the erasure audit record when the audit succeeds', async () => {
    const { prisma, committed } = makeMockPrisma({ failAudit: false });
    const res = await request(buildApp(prisma)).delete('/api/admin/users/u-1');

    expect(res.status).toBe(200);
    expect(committed.pseudonymised).toBe(1);
    expect(committed.deleted).toBe(true);
    expect(committed.erasureAudits).toBe(1);
  });

  it('does NOT delete the user when the final erasure audit insert fails (rollback)', async () => {
    const { prisma, committed } = makeMockPrisma({ failAudit: true });
    const res = await request(buildApp(prisma)).delete('/api/admin/users/u-1');

    // Handler surfaces the failure...
    expect(res.status).toBe(500);
    // ...and crucially: the user was NOT deleted, and audit_logs were NOT
    // pseudonymised, when the erasure audit record could not be written.
    // This is the assertion that directly proves the compliance gap
    // described in the task brief is closed — no more "erased with zero
    // trail of who did it or when."
    expect(committed.deleted).toBe(false);
    expect(committed.pseudonymised).toBe(0);
    expect(committed.erasureAudits).toBe(0);
  });

  it('commits a safe no-op (no mutation, no audit) when the target user does not exist', async () => {
    const { prisma, committed } = makeMockPrisma({ failAudit: false, noUser: true });
    const res = await request(buildApp(prisma)).delete('/api/admin/users/u-404');

    expect(res.status).toBe(404);
    expect(committed.deleted).toBe(false);
    expect(committed.pseudonymised).toBe(0);
    expect(committed.erasureAudits).toBe(0);
  });
});
