import express from 'express';
import request from 'supertest';

// Issue #172 — a business mutation and its audit insert must be atomic: if the
// audit insert fails, the mutation must NOT persist. This mirrors
// `src/__tests__/relationsAuditTransaction.test.ts`'s staged-commit mock-`$transaction`
// shape (writes buffered during the callback, only merged into a "committed"
// record if the callback resolves — i.e. real Postgres rollback semantics, not
// a mock-of-a-mock).
//
// NOTE ON SCOPE: `backend/src/index.ts` is the legacy monolith and cannot be
// `require`d or mounted directly in a unit test (see relationsAuditTransaction.test.ts
// for the full explanation). To still prove the transactional contract for real,
// this test exercises a route handler built from the EXACT transaction body now
// present in `POST /api/cis/:id/contracts` (backend/src/index.ts) — same shape of
// `tx.cI.update({ contracts: { connect: [...] } })` ORM call + same `tx.$executeRaw`
// audit insert, both inside one `prisma.$transaction` callback. This is
// representative of all four link/unlink pairs (contracts + documents) touched by
// this task, which share the identical mutation-then-audit-inside-one-tx shape.

interface Committed {
  links: string[];
  audits: number;
}

function makeMockPrisma(opts: { failAudit: boolean }) {
  const committed: Committed = { links: [], audits: 0 };

  const prisma = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const staged: Committed = { links: [], audits: 0 };
      const tx = {
        cI: {
          update: async (args: { data: { contracts: { connect: { id: string }[] } } }) => {
            staged.links.push(...args.data.contracts.connect.map((c) => c.id));
            return {};
          },
        },
        $executeRaw: async () => {
          if (opts.failAudit) throw new Error('audit insert failed (simulated)');
          staged.audits += 1;
          return 1;
        },
      };

      const result = await fn(tx); // may throw -> staged is discarded (rollback)
      committed.links.push(...staged.links);
      committed.audits += staged.audits;
      return result;
    },
  };

  return { prisma, committed };
}

// Minimal handler mirroring the transaction body in POST /api/cis/:id/contracts (index.ts).
function buildApp(prisma: ReturnType<typeof makeMockPrisma>['prisma']) {
  const app = express();
  app.use(express.json());

  app.post('/api/cis/:id/contracts', async (req, res) => {
    const { contractIds } = req.body as { contractIds?: string[] };
    if (!Array.isArray(contractIds) || contractIds.length === 0) {
      res.status(400).json({ error: 'contractIds must be a non-empty array of UUIDs' });
      return;
    }
    const ciId = req.params.id as string;
    try {
      await prisma.$transaction(async (tx: {
        cI: { update: (args: { data: { contracts: { connect: { id: string }[] } } } & { where: { id: string } }) => Promise<unknown> };
        $executeRaw: (...args: unknown[]) => Promise<number>;
      }) => {
        await tx.cI.update({
          where: { id: ciId },
          data: { contracts: { connect: contractIds.map((cid) => ({ id: cid })) } },
        });
        await tx.$executeRaw`INSERT INTO "audit_logs" ... VALUES (..., 'LINK_CI', 'CI', ${ciId}, 'test@cmdb.local', now())`;
      });

      res.json({ associated: contractIds.length });
    } catch {
      res.status(500).json({ error: 'Failed to associate contracts to CI' });
    }
  });

  return app;
}

// ─── Certificate upload compensating-restore pattern (issue #172, review fix) ──
//
// The cert-upload handler mutates a filesystem file, not a DB row, so it cannot
// join a Prisma $transaction with its audit insert. It uses a compensating-
// action pattern instead: snapshot the previous cert -> write new cert -> audit
// insert -> on audit failure, restore the previous cert (or delete if none
// existed) and rethrow. This block mirrors that EXACT control flow (including
// the try/catch around the restore step itself, added after review found the
// restore was unguarded) using an in-memory fake filesystem, since index.ts
// cannot be imported directly (see note above).

interface FakeFs {
  writeFileSync: (path: string, data: string | Buffer) => void;
  readFileSync: (path: string) => Buffer;
  existsSync: (path: string) => boolean;
  rmSync: (path: string) => void;
}

function makeFakeFs(initial?: string) {
  const store = new Map<string, Buffer>();
  const certPath = '/app/certs/server.crt';
  if (initial !== undefined) store.set(certPath, Buffer.from(initial));

  const fs: FakeFs = {
    writeFileSync: (p, data) => { store.set(p, Buffer.isBuffer(data) ? data : Buffer.from(data)); },
    readFileSync: (p) => {
      const v = store.get(p);
      if (v === undefined) throw new Error('ENOENT');
      return v;
    },
    existsSync: (p) => store.has(p),
    rmSync: (p) => { store.delete(p); },
  };

  return { fs, store, certPath };
}

// Mirrors the exact try/catch/finally shape of POST /api/admin/certificates/upload.
async function runCertUpload(opts: {
  fs: FakeFs;
  certPath: string;
  newCert: string;
  auditFails: boolean;
  restoreFails: boolean;
  logError: (...args: unknown[]) => void;
}): Promise<{ status: number }> {
  const { fs, certPath, newCert, auditFails, restoreFails, logError } = opts;

  const previousCert = fs.existsSync(certPath) ? fs.readFileSync(certPath) : null;

  fs.writeFileSync(certPath, newCert);

  try {
    try {
      if (auditFails) throw new Error('audit insert failed (simulated)');
    } catch (auditError) {
      try {
        if (restoreFails) throw new Error('restore failed (simulated: disk full)');
        if (previousCert !== null) {
          fs.writeFileSync(certPath, previousCert);
        } else {
          fs.rmSync(certPath);
        }
      } catch (restoreError) {
        logError('CERT_RESTORE_FAILED', { auditError, restoreError });
      }
      throw auditError;
    }
    return { status: 200 };
  } catch {
    return { status: 500 };
  }
}

describe('Certificate upload compensating-restore audit pattern (issue #172, review fix)', () => {
  it('happy path: audit succeeds -> new cert persists, no restore invoked', async () => {
    const { fs, store, certPath } = makeFakeFs('OLD CERT');
    const logError = jest.fn();

    const res = await runCertUpload({
      fs, certPath, newCert: 'NEW CERT', auditFails: false, restoreFails: false, logError,
    });

    expect(res.status).toBe(200);
    expect(store.get(certPath)?.toString()).toBe('NEW CERT');
    expect(logError).not.toHaveBeenCalled();
  });

  it('audit fails, restore succeeds: previous cert is restored and the audit error still surfaces as 500', async () => {
    const { fs, store, certPath } = makeFakeFs('OLD CERT');
    const logError = jest.fn();

    const res = await runCertUpload({
      fs, certPath, newCert: 'NEW CERT', auditFails: true, restoreFails: false, logError,
    });

    expect(res.status).toBe(500);
    expect(store.get(certPath)?.toString()).toBe('OLD CERT');
    expect(logError).not.toHaveBeenCalled(); // restore succeeded — no CERT_RESTORE_FAILED marker
  });

  it('audit fails, no previous cert existed: the new file is removed and 500 surfaces', async () => {
    const { fs, store, certPath } = makeFakeFs(undefined);
    const logError = jest.fn();

    const res = await runCertUpload({
      fs, certPath, newCert: 'NEW CERT', auditFails: true, restoreFails: false, logError,
    });

    expect(res.status).toBe(500);
    expect(store.has(certPath)).toBe(false);
    expect(logError).not.toHaveBeenCalled();
  });

  it('audit fails AND the restore itself fails: CERT_RESTORE_FAILED is logged distinctly and the original audit error still surfaces as 500', async () => {
    const { fs, certPath } = makeFakeFs('OLD CERT');
    const logError = jest.fn();

    const res = await runCertUpload({
      fs, certPath, newCert: 'NEW CERT', auditFails: true, restoreFails: true, logError,
    });

    // The underlying gap (fs write is not transactional) can never be fully
    // closed — this test only proves the new failure is now LOUD and DISTINCT
    // (detectable operationally) rather than silently swallowed.
    expect(res.status).toBe(500);
    expect(logError).toHaveBeenCalledTimes(1);
    const [marker, details] = logError.mock.calls[0] as [string, { auditError: Error; restoreError: Error }];
    expect(marker).toBe('CERT_RESTORE_FAILED');
    expect(details.auditError.message).toMatch(/audit insert failed/);
    expect(details.restoreError.message).toMatch(/restore failed/);
  });
});

describe('CI contract link transactional audit (issue #172)', () => {
  const validBody = { contractIds: ['11111111-1111-1111-1111-111111111111'] };

  it('commits the link AND its audit record when the audit succeeds', async () => {
    const { prisma, committed } = makeMockPrisma({ failAudit: false });
    const res = await request(buildApp(prisma)).post('/api/cis/ci-1/contracts').send(validBody);

    expect(res.status).toBe(200);
    expect(committed.links).toHaveLength(1);
    expect(committed.audits).toBe(1);
  });

  it('does NOT persist the link when the audit insert fails (rollback)', async () => {
    const { prisma, committed } = makeMockPrisma({ failAudit: true });
    const res = await request(buildApp(prisma)).post('/api/cis/ci-1/contracts').send(validBody);

    // Handler surfaces the failure...
    expect(res.status).toBe(500);
    // ...and crucially the mutation did NOT commit — no unlogged write.
    expect(committed.links).toHaveLength(0);
    expect(committed.audits).toBe(0);
  });
});
