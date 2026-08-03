import express from 'express';
import request from 'supertest';
import { requireSecurityWrite } from '../shared/middleware/requireSecurity';

// Task 20 — `PATCH /api/vulnerabilities` (backend/src/index.ts, ~line 2127):
// (1) closes an A01 gap — the endpoint previously had only `authenticateToken`,
//     so ANY authenticated user (VIEWER included) could change a vulnerability's
//     status; it now requires `requireSecurityWrite` (ADMIN/SOC), gating BOTH
//     the pre-existing status-change path and the new assignment path;
// (2) adds `assignedTo` (assign/unassign) support with server-side validation
//     of the assignee (must be an active ADMIN/SOC user) and transactional
//     audit (`VULN_ASSIGNED`/`VULN_UNASSIGNED`).
//
// NOTE ON SCOPE: as documented in `vulnPatchIdentity.test.ts` /
// `ciAuditTransaction.test.ts`, `index.ts` cannot be `require`d or mounted
// directly in a unit test (module-scope PrismaClient + unconditional
// `app.listen()`). `requireSecurityWrite` IS imported for real (a standalone
// middleware module) so the role gate is exercised as written. The handler
// body below mirrors the EXACT logic now in index.ts: same `targetKey = key
// ?? cve` identity resolution, same assignee DB-validation shape, same
// effective-status resolution (explicit `status` wins; assigning
// auto-transitions to ASIGNADO unless already RESUELTO; unassigning never
// touches status), same transactional mutation+audit via `prisma.$transaction`,
// same `entity_id` (bare ciId, varchar(36)-safe) / `details` (jsonb) split
// from the v3.6.0 live-verification fix this endpoint already carries.

interface Vulnerability {
  cve: string;
  key?: string;
  severity: string;
  status: string;
  importedAt: string;
  assignedTo?: string;
  assignedAt?: string;
  assignedBy?: string;
}

interface FakeUser {
  id: string;
  role: string;
  active: boolean;
}

const USERS: FakeUser[] = [
  { id: 'u-admin-active',   role: 'ADMIN', active: true  },
  { id: 'u-soc-active',     role: 'SOC',   active: true  },
  { id: 'u-admin-inactive', role: 'ADMIN', active: false },
  { id: 'u-viewer-active',  role: 'VIEWER', active: true },
];

function makeMockPrisma(storedVulns: Vulnerability[]) {
  const committed = { ciWrites: [] as unknown[], audits: [] as { action: string; details: unknown }[] };
  let currentVulns = storedVulns;

  const prisma = {
    user: {
      findFirst: async ({ where }: { where: { id: string; active: boolean; role: { in: string[] } } }) => {
        const u = USERS.find(
          (u) => u.id === where.id && u.active === where.active && where.role.in.includes(u.role)
        );
        return u ? { id: u.id } : null;
      },
    },
    $queryRaw: async () => [{ id: 'ci-1', vulnerabilities: currentVulns }],
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const staged = { ciWrite: null as unknown, audit: null as { action: string; details: unknown } | null };
      const tx = {
        $executeRaw: (async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const text = strings.join('');
          if (text.includes('UPDATE "configuration_items"')) {
            staged.ciWrite = values[0]; // JSON.stringify(updated)
          } else if (text.includes('INSERT INTO "audit_logs"')) {
            // values order per index.ts: action, ciId(entity_id), email, details
            staged.audit = { action: values[0] as string, details: JSON.parse(values[3] as string) };
          }
          return 1;
        }) as unknown as (...args: unknown[]) => Promise<number>,
      };

      const result = await fn(tx); // may throw -> staged discarded (rollback)
      if (staged.ciWrite) {
        currentVulns = JSON.parse(staged.ciWrite as string);
        committed.ciWrites.push(staged.ciWrite);
      }
      if (staged.audit) committed.audits.push(staged.audit);
      return result;
    },
  };

  return { prisma, committed, getCurrentVulns: () => currentVulns };
}

// Mirrors the exact handler body now in index.ts's PATCH /api/vulnerabilities.
function buildApp(prisma: ReturnType<typeof makeMockPrisma>['prisma'], actingRole: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { id: 'caller-id', role: actingRole, email: 'caller@cmdb.local' };
    next();
  });

  app.patch('/api/vulnerabilities', requireSecurityWrite, async (req, res) => {
    const { ciId, key, cve, status, assignedTo } = req.body as {
      ciId: string; key?: string; cve: string; status?: string; assignedTo?: string | null;
    };
    const hasAssignmentChange = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'assignedTo');

    if (!ciId || !(key || cve) || (!status && !hasAssignmentChange)) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }

    const targetKey = key ?? cve;
    const validStatuses = ['NUEVO', 'ASIGNADO', 'EN_CURSO', 'PARADO', 'RESUELTO'];
    if (status && !validStatuses.includes(status)) {
      res.status(400).json({ error: `Invalid status: ${status}` });
      return;
    }

    try {
      if (hasAssignmentChange && typeof assignedTo === 'string' && assignedTo.length > 0) {
        const check = await prisma.user.findFirst({
          where: { id: assignedTo, active: true, role: { in: ['ADMIN', 'SOC'] } },
        });
        if (!check) {
          res.status(422).json({ error: 'Invalid assignee: must be an active ADMIN or SOC user' });
          return;
        }
      }

      const rows = await prisma.$queryRaw();
      const currentVulns = (rows[0].vulnerabilities ?? []) as Vulnerability[];
      const vuln = currentVulns.find((v) => (v.key ?? v.cve) === targetKey);
      if (!vuln) {
        res.status(404).json({ error: `Vulnerability ${targetKey} not found` });
        return;
      }

      const nowIso = new Date().toISOString();
      const isUnassigning = hasAssignmentChange && assignedTo === null;
      const isAssigning = hasAssignmentChange && typeof assignedTo === 'string' && assignedTo.length > 0;

      let effectiveStatus = vuln.status;
      if (status) {
        effectiveStatus = status;
      } else if (isAssigning && vuln.status !== 'RESUELTO') {
        effectiveStatus = 'ASIGNADO';
      }

      const updated = currentVulns.map((v) => {
        if ((v.key ?? v.cve) !== targetKey) return v;
        const next: Vulnerability = { ...v, status: effectiveStatus };
        if (isAssigning) {
          next.assignedTo = assignedTo as string;
          next.assignedAt = nowIso;
          next.assignedBy = (req as any).user.id;
        } else if (isUnassigning) {
          delete next.assignedTo;
          delete next.assignedAt;
          delete next.assignedBy;
        }
        return next;
      });

      const action = isAssigning ? 'VULN_ASSIGNED' : isUnassigning ? 'VULN_UNASSIGNED' : `UPDATE_VULN_STATUS:${effectiveStatus}`;
      const details: Record<string, unknown> = { vulnKey: targetKey };
      if (isAssigning) details.assignedTo = assignedTo;
      if (status) details.status = status;

      await prisma.$transaction(async (tx: any) => {
        await tx.$executeRaw`UPDATE "configuration_items" SET "vulnerabilities" = ${JSON.stringify(updated)}::jsonb WHERE id = ${ciId}::uuid`;
        await tx.$executeRaw`INSERT INTO "audit_logs" (...) VALUES (${action}, ${ciId}, ${'caller@cmdb.local'}, ${JSON.stringify(details)})`;
      });

      res.json({ ciId, status: effectiveStatus, assignedTo: isUnassigning ? null : isAssigning ? assignedTo : vuln.assignedTo ?? null });
    } catch {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return app;
}

const CI_ID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';

describe('PATCH /api/vulnerabilities — role gate (Task 20 A01 fix)', () => {
  it('rejects a VIEWER with 403 for a status-only change (the gap this closes)', async () => {
    const { prisma } = makeMockPrisma([{ key: 'oid@443/tcp', cve: '', severity: 'HIGH', status: 'NUEVO', importedAt: '2026-01-01T00:00:00.000Z' }]);
    const app = buildApp(prisma, 'VIEWER');

    const res = await request(app).patch('/api/vulnerabilities').send({ ciId: CI_ID, key: 'oid@443/tcp', cve: '', status: 'EN_CURSO' });

    expect(res.status).toBe(403);
  });

  it('rejects an AUDITOR with 403', async () => {
    const { prisma } = makeMockPrisma([{ key: 'oid@443/tcp', cve: '', severity: 'HIGH', status: 'NUEVO', importedAt: '2026-01-01T00:00:00.000Z' }]);
    const app = buildApp(prisma, 'AUDITOR');

    const res = await request(app).patch('/api/vulnerabilities').send({ ciId: CI_ID, key: 'oid@443/tcp', cve: '', status: 'EN_CURSO' });

    expect(res.status).toBe(403);
  });

  it('allows ADMIN through', async () => {
    const { prisma } = makeMockPrisma([{ key: 'oid@443/tcp', cve: '', severity: 'HIGH', status: 'NUEVO', importedAt: '2026-01-01T00:00:00.000Z' }]);
    const app = buildApp(prisma, 'ADMIN');

    const res = await request(app).patch('/api/vulnerabilities').send({ ciId: CI_ID, key: 'oid@443/tcp', cve: '', status: 'EN_CURSO' });

    expect(res.status).toBe(200);
  });

  it('allows SOC through', async () => {
    const { prisma } = makeMockPrisma([{ key: 'oid@443/tcp', cve: '', severity: 'HIGH', status: 'NUEVO', importedAt: '2026-01-01T00:00:00.000Z' }]);
    const app = buildApp(prisma, 'SOC');

    const res = await request(app).patch('/api/vulnerabilities').send({ ciId: CI_ID, key: 'oid@443/tcp', cve: '', status: 'EN_CURSO' });

    expect(res.status).toBe(200);
  });
});

describe('PATCH /api/vulnerabilities — assignment', () => {
  const baseVuln = (status: string): Vulnerability => ({
    key: 'oid@443/tcp', cve: '', severity: 'HIGH', status, importedAt: '2026-01-01T00:00:00.000Z',
  });

  it('assigns to a valid active ADMIN/SOC user, sets status ASIGNADO, and audits VULN_ASSIGNED', async () => {
    const { prisma, committed, getCurrentVulns } = makeMockPrisma([baseVuln('NUEVO')]);
    const app = buildApp(prisma, 'ADMIN');

    const res = await request(app).patch('/api/vulnerabilities').send({ ciId: CI_ID, key: 'oid@443/tcp', cve: '', assignedTo: 'u-soc-active' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ASIGNADO');
    expect(res.body.assignedTo).toBe('u-soc-active');
    expect(getCurrentVulns()[0]).toMatchObject({ status: 'ASIGNADO', assignedTo: 'u-soc-active', assignedBy: 'caller-id' });
    expect(getCurrentVulns()[0].assignedAt).toBeTruthy();
    expect(committed.audits).toHaveLength(1);
    expect(committed.audits[0].action).toBe('VULN_ASSIGNED');
    expect(committed.audits[0].details).toMatchObject({ assignedTo: 'u-soc-active' });
  });

  it('rejects assignment to a nonexistent user with 422 and writes nothing', async () => {
    const { prisma, committed, getCurrentVulns } = makeMockPrisma([baseVuln('NUEVO')]);
    const app = buildApp(prisma, 'ADMIN');

    const res = await request(app).patch('/api/vulnerabilities').send({ ciId: CI_ID, key: 'oid@443/tcp', cve: '', assignedTo: 'nonexistent-user-id' });

    expect(res.status).toBe(422);
    expect(committed.ciWrites).toHaveLength(0);
    expect(committed.audits).toHaveLength(0);
    expect(getCurrentVulns()[0].assignedTo).toBeUndefined();
  });

  it('rejects assignment to an inactive ADMIN with 422 and writes nothing', async () => {
    const { prisma, committed } = makeMockPrisma([baseVuln('NUEVO')]);
    const app = buildApp(prisma, 'ADMIN');

    const res = await request(app).patch('/api/vulnerabilities').send({ ciId: CI_ID, key: 'oid@443/tcp', cve: '', assignedTo: 'u-admin-inactive' });

    expect(res.status).toBe(422);
    expect(committed.ciWrites).toHaveLength(0);
    expect(committed.audits).toHaveLength(0);
  });

  it('rejects assignment to an active VIEWER (wrong role) with 422 and writes nothing', async () => {
    const { prisma, committed } = makeMockPrisma([baseVuln('NUEVO')]);
    const app = buildApp(prisma, 'ADMIN');

    const res = await request(app).patch('/api/vulnerabilities').send({ ciId: CI_ID, key: 'oid@443/tcp', cve: '', assignedTo: 'u-viewer-active' });

    expect(res.status).toBe(422);
    expect(committed.ciWrites).toHaveLength(0);
    expect(committed.audits).toHaveLength(0);
  });

  it('preserves assignedTo/assignedAt/assignedBy when a later status-only PATCH moves ASIGNADO -> EN_CURSO', async () => {
    const assigned: Vulnerability = { ...baseVuln('ASIGNADO'), assignedTo: 'u-admin-active', assignedAt: '2026-01-02T00:00:00.000Z', assignedBy: 'u-admin-active' };
    const { prisma, getCurrentVulns } = makeMockPrisma([assigned]);
    const app = buildApp(prisma, 'ADMIN');

    const res = await request(app).patch('/api/vulnerabilities').send({ ciId: CI_ID, key: 'oid@443/tcp', cve: '', status: 'EN_CURSO' });

    expect(res.status).toBe(200);
    expect(getCurrentVulns()[0]).toMatchObject({
      status: 'EN_CURSO',
      assignedTo: 'u-admin-active',
      assignedAt: '2026-01-02T00:00:00.000Z',
      assignedBy: 'u-admin-active',
    });
  });

  it('unassigns (assignedTo: null): clears all 3 fields, audits VULN_UNASSIGNED, does not force a status change', async () => {
    const assigned: Vulnerability = { ...baseVuln('ASIGNADO'), assignedTo: 'u-admin-active', assignedAt: '2026-01-02T00:00:00.000Z', assignedBy: 'u-admin-active' };
    const { prisma, committed, getCurrentVulns } = makeMockPrisma([assigned]);
    const app = buildApp(prisma, 'ADMIN');

    const res = await request(app).patch('/api/vulnerabilities').send({ ciId: CI_ID, key: 'oid@443/tcp', cve: '', assignedTo: null });

    expect(res.status).toBe(200);
    const stored = getCurrentVulns()[0];
    expect(stored.assignedTo).toBeUndefined();
    expect(stored.assignedAt).toBeUndefined();
    expect(stored.assignedBy).toBeUndefined();
    expect(stored.status).toBe('ASIGNADO'); // left as-is per documented decision
    expect(committed.audits[0].action).toBe('VULN_UNASSIGNED');
  });

  it('an explicit status in the same request wins over the automatic ASIGNADO transition', async () => {
    const { prisma, getCurrentVulns } = makeMockPrisma([baseVuln('NUEVO')]);
    const app = buildApp(prisma, 'ADMIN');

    const res = await request(app).patch('/api/vulnerabilities').send({ ciId: CI_ID, key: 'oid@443/tcp', cve: '', assignedTo: 'u-soc-active', status: 'EN_CURSO' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('EN_CURSO');
    expect(getCurrentVulns()[0]).toMatchObject({ status: 'EN_CURSO', assignedTo: 'u-soc-active' });
  });

  it('assigning an already-RESUELTO vulnerability does NOT reopen it to ASIGNADO', async () => {
    const { prisma, getCurrentVulns } = makeMockPrisma([baseVuln('RESUELTO')]);
    const app = buildApp(prisma, 'ADMIN');

    const res = await request(app).patch('/api/vulnerabilities').send({ ciId: CI_ID, key: 'oid@443/tcp', cve: '', assignedTo: 'u-soc-active' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('RESUELTO');
    expect(getCurrentVulns()[0]).toMatchObject({ status: 'RESUELTO', assignedTo: 'u-soc-active' });
  });
});
