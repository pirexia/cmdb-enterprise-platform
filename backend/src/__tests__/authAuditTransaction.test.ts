import express from 'express';
import request from 'supertest';

// Issue #172 — a business mutation and its audit insert must be atomic: if the
// audit insert fails, the mutation must NOT persist. This mirrors
// `src/__tests__/ciAuditTransaction.test.ts` / `relationsAuditTransaction.test.ts` /
// `userAdminAuditTransaction.test.ts`'s staged-commit mock-`$transaction` shape
// (writes buffered during the callback, only merged into a "committed" record
// if the callback resolves — i.e. real Postgres rollback semantics, not a
// mock-of-a-mock).
//
// NOTE ON SCOPE: `backend/src/index.ts` is the legacy monolith and cannot be
// `require`d or mounted directly in a unit test (see prior test files' notes
// for the full explanation). These tests exercise route handlers built from
// the EXACT transaction bodies now present in the SSO callback's trusted
// device grant, `POST /api/auth/mfa/setup`, and `POST /api/auth/mfa/enable`
// (index.ts).
//
// Task 5 scope note (documented per the task brief): `POST /api/auth/logout`
// and the primary `POST /api/auth/login` success audit (`'LOGIN'`, index.ts
// ~1039) were read and found to be audit-only at those exact insert sites —
// no mutation immediately precedes either audit insert, so there is nothing
// to roll back against and no transaction was added there. (The `login`
// handler does contain other mutation+audit pairs inside its LDAP
// auto-heal/auto-provision branches, but those are pre-existing and out of
// scope for the 4 target sites named in this task.)

describe('SSO callback trusted-device + login audit (issue #172)', () => {
  interface Committed {
    deviceInserted: boolean;
    audits: number;
  }

  function makeMockPrisma(opts: { failAudit: boolean }) {
    const committed: Committed = { deviceInserted: false, audits: 0 };

    const prisma = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const staged: Committed = { deviceInserted: false, audits: 0 };
        let call = 0;
        const tx = {
          $executeRaw: async () => {
            call += 1;
            if (call === 1) {
              // INSERT INTO "trusted_devices" ...
              staged.deviceInserted = true;
              return 1;
            }
            // INSERT INTO "audit_logs" ... 'LOGIN_SSO'
            if (opts.failAudit) throw new Error('audit insert failed (simulated)');
            staged.audits += 1;
            return 1;
          },
        };

        const result = await fn(tx); // may throw -> staged is discarded (rollback)
        committed.deviceInserted = staged.deviceInserted;
        committed.audits += staged.audits;
        return result;
      },
    };

    return { prisma, committed };
  }

  // Minimal handler mirroring the transaction body in the SSO callback (index.ts).
  function buildApp(prisma: ReturnType<typeof makeMockPrisma>['prisma']) {
    const app = express();
    app.use(express.json());

    app.get('/api/auth/sso/microsoft/callback', async (_req, res) => {
      try {
        await prisma.$transaction(async (tx: { $executeRaw: (...args: unknown[]) => Promise<number> }) => {
          await tx.$executeRaw`INSERT INTO "trusted_devices" (...) VALUES (...) ON CONFLICT DO NOTHING`;
          await tx.$executeRaw`
            INSERT INTO "audit_logs" (id, action, entity, entity_id, user_email, details, created_at)
            VALUES (gen_random_uuid(), 'LOGIN_SSO', 'User', ${'u-1'}, ${'sso@cmdb.local'}, 'Microsoft SSO login', now())
          `;
        });
        res.redirect(302, '/auth/sso-callback?code=abc');
      } catch {
        res.redirect(302, '/login?error=sso_failed');
      }
    });

    return app;
  }

  it('commits the trusted-device grant AND its audit record when the audit succeeds', async () => {
    const { prisma, committed } = makeMockPrisma({ failAudit: false });
    const res = await request(buildApp(prisma)).get('/api/auth/sso/microsoft/callback');

    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/auth/sso-callback');
    expect(committed.deviceInserted).toBe(true);
    expect(committed.audits).toBe(1);
  });

  it('does NOT persist the trusted-device grant when the audit insert fails (rollback)', async () => {
    const { prisma, committed } = makeMockPrisma({ failAudit: true });
    const res = await request(buildApp(prisma)).get('/api/auth/sso/microsoft/callback');

    // Handler falls back to the error redirect...
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('sso_failed');
    // ...and crucially the trusted-device grant did NOT commit — no unlogged session write.
    expect(committed.deviceInserted).toBe(false);
    expect(committed.audits).toBe(0);
  });
});

describe('MFA setup pending-secret audit (issue #172)', () => {
  interface Committed {
    pendingSecretSet: boolean;
    audits: number;
  }

  function makeMockPrisma(opts: { failAudit: boolean }) {
    const committed: Committed = { pendingSecretSet: false, audits: 0 };

    const prisma = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const staged: Committed = { pendingSecretSet: false, audits: 0 };
        let call = 0;
        const tx = {
          $executeRaw: async () => {
            call += 1;
            if (call === 1) {
              // UPDATE "users" SET mfa_pending_secret = ...
              staged.pendingSecretSet = true;
              return 1;
            }
            // INSERT INTO "audit_logs" ... 'MFA_SETUP_INITIATED'
            if (opts.failAudit) throw new Error('audit insert failed (simulated)');
            staged.audits += 1;
            return 1;
          },
        };

        const result = await fn(tx); // may throw -> staged is discarded (rollback)
        committed.pendingSecretSet = staged.pendingSecretSet;
        committed.audits += staged.audits;
        return result;
      },
    };

    return { prisma, committed };
  }

  // Minimal handler mirroring the transaction body in POST /api/auth/mfa/setup (index.ts).
  function buildApp(prisma: ReturnType<typeof makeMockPrisma>['prisma']) {
    const app = express();
    app.use(express.json());

    app.post('/api/auth/mfa/setup', async (_req, res) => {
      try {
        await prisma.$transaction(async (tx: { $executeRaw: (...args: unknown[]) => Promise<number> }) => {
          await tx.$executeRaw`UPDATE "users" SET mfa_pending_secret = ${'SECRET'}, updated_at = now() WHERE id = ${'u-1'}::uuid`;
          await tx.$executeRaw`
            INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
            VALUES(gen_random_uuid(), 'MFA_SETUP_INITIATED', 'User', ${'u-1'}::uuid, ${'user@cmdb.local'}, now())`;
        });
        res.json({ secret: 'SECRET', qrDataUrl: 'data:image/png;base64,...' });
      } catch {
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    return app;
  }

  it('commits the pending-secret write AND its audit record when the audit succeeds', async () => {
    const { prisma, committed } = makeMockPrisma({ failAudit: false });
    const res = await request(buildApp(prisma)).post('/api/auth/mfa/setup');

    expect(res.status).toBe(200);
    expect(committed.pendingSecretSet).toBe(true);
    expect(committed.audits).toBe(1);
  });

  it('does NOT persist the pending-secret write when the audit insert fails (rollback)', async () => {
    const { prisma, committed } = makeMockPrisma({ failAudit: true });
    const res = await request(buildApp(prisma)).post('/api/auth/mfa/setup');

    expect(res.status).toBe(500);
    expect(committed.pendingSecretSet).toBe(false);
    expect(committed.audits).toBe(0);
  });
});

describe('MFA enable — mfa_secret write + audit (issue #172, highest-risk site)', () => {
  // This is the highest-risk site in this task: an unlogged mfa_secret /
  // mfa_enabled write would be a silent auth-bypass audit gap (a user could
  // become MFA-enrolled with zero compliance record of when/how). This test
  // proves that gap is closed: when the audit insert throws, the mfa_secret
  // UPDATE must NOT commit (the whole transaction rolls back together).

  interface Committed {
    mfaSecretSet: boolean;
    mfaEnabled: boolean;
    audits: number;
  }

  function makeMockPrisma(opts: { failAudit: boolean }) {
    const committed: Committed = { mfaSecretSet: false, mfaEnabled: false, audits: 0 };

    const prisma = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const staged: Committed = { mfaSecretSet: false, mfaEnabled: false, audits: 0 };
        let call = 0;
        const tx = {
          $executeRaw: async () => {
            call += 1;
            if (call === 1) {
              // UPDATE "users" SET mfa_secret = ..., mfa_enabled = true, mfa_pending_secret = NULL ...
              staged.mfaSecretSet = true;
              staged.mfaEnabled = true;
              return 1;
            }
            // INSERT INTO "audit_logs" ... 'MFA_ENABLED'
            if (opts.failAudit) throw new Error('audit insert failed (simulated)');
            staged.audits += 1;
            return 1;
          },
        };

        const result = await fn(tx); // may throw -> staged is discarded (rollback)
        committed.mfaSecretSet = staged.mfaSecretSet;
        committed.mfaEnabled = staged.mfaEnabled;
        committed.audits += staged.audits;
        return result;
      },
    };

    return { prisma, committed };
  }

  // Minimal handler mirroring the transaction body in POST /api/auth/mfa/enable (index.ts).
  // JWT signing / cookie-setting / res.json are deliberately OUTSIDE the mocked
  // transaction, matching the real handler (no rollback semantics for them).
  function buildApp(prisma: ReturnType<typeof makeMockPrisma>['prisma']) {
    const app = express();
    app.use(express.json());
    let cookieSetAfterCommit = false;

    app.post('/api/auth/mfa/enable', async (req, res) => {
      const { code } = req.body as { code?: string };
      if (!code) {
        res.status(400).json({ error: 'code is required' });
        return;
      }
      try {
        await prisma.$transaction(async (tx: { $executeRaw: (...args: unknown[]) => Promise<number> }) => {
          await tx.$executeRaw`
            UPDATE "users"
            SET mfa_secret = ${'SECRET'}, mfa_enabled = true, mfa_pending_secret = NULL, updated_at = now()
            WHERE id = ${'u-1'}::uuid
          `;
          await tx.$executeRaw`
            INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, created_at)
            VALUES(gen_random_uuid(), 'MFA_ENABLED', 'User', ${'u-1'}::uuid, ${'user@cmdb.local'}, now())
          `;
        });
        // Side effects only after the transaction commits.
        cookieSetAfterCommit = true;
        res.json({ message: 'MFA enabled successfully', token: 'fake.jwt.token' });
      } catch {
        res.status(500).json({ error: 'Internal server error' });
      }
    });

    return { app, wasCookieSet: () => cookieSetAfterCommit };
  }

  it('commits the mfa_secret update AND its audit record when the audit succeeds', async () => {
    const { prisma, committed } = makeMockPrisma({ failAudit: false });
    const { app, wasCookieSet } = buildApp(prisma);
    const res = await request(app).post('/api/auth/mfa/enable').send({ code: '123456' });

    expect(res.status).toBe(200);
    expect(committed.mfaSecretSet).toBe(true);
    expect(committed.mfaEnabled).toBe(true);
    expect(committed.audits).toBe(1);
    expect(wasCookieSet()).toBe(true);
  });

  it('does NOT persist the mfa_secret update when the audit insert fails (rollback)', async () => {
    const { prisma, committed } = makeMockPrisma({ failAudit: true });
    const { app, wasCookieSet } = buildApp(prisma);
    const res = await request(app).post('/api/auth/mfa/enable').send({ code: '123456' });

    // Handler surfaces the failure...
    expect(res.status).toBe(500);
    // ...and crucially the mfa_secret/mfa_enabled write did NOT commit — no
    // silent auth-bypass audit gap.
    expect(committed.mfaSecretSet).toBe(false);
    expect(committed.mfaEnabled).toBe(false);
    expect(committed.audits).toBe(0);
    // No token/cookie was ever issued for an uncommitted MFA enrollment.
    expect(wasCookieSet()).toBe(false);
  });
});
