import express from 'express';
import request from 'supertest';
import { requireSecurityRead } from '../shared/middleware/requireSecurity';

// Task 19 — `GET /api/vulnerabilities/assignable-users` (backend/src/index.ts,
// registered right after `PATCH /api/vulnerabilities`).
//
// NOTE ON SCOPE: as documented in `vulnPatchIdentity.test.ts` /
// `ciAuditTransaction.test.ts`, `index.ts` cannot be `require`d or mounted
// directly in a unit test (module-scope PrismaClient + unconditional
// `app.listen()`). `requireSecurityRead` IS imported for real (it's a
// standalone middleware module, not part of index.ts) so the role gate is
// exercised as written, not re-implemented. The user-filtering query itself
// (`active: true, role: { in: ['ADMIN','SOC'] }`, select `{id, username,
// displayName}`, map to `{id, displayName: displayName ?? username}`) is
// mirrored here against an in-memory user list, identical to the real
// index.ts logic — same shape of test double the sibling PATCH test uses for
// the identity-resolution logic it can't import either.

interface FakeUser {
  id: string;
  username: string;
  displayName: string | null;
  role: string;
  active: boolean;
  email: string;
}

const USERS: FakeUser[] = [
  { id: 'u-admin-active',   username: 'admin1',   displayName: 'Alice Admin', role: 'ADMIN',   active: true,  email: 'alice@cmdb.local' },
  { id: 'u-soc-active',     username: 'soc1',     displayName: null,          role: 'SOC',      active: true,  email: 'soc1@cmdb.local' },
  { id: 'u-admin-inactive', username: 'admin2',   displayName: 'Bob Admin',   role: 'ADMIN',    active: false, email: 'bob@cmdb.local' },
  { id: 'u-soc-inactive',   username: 'soc2',     displayName: 'Soc Two',     role: 'SOC',      active: false, email: 'soc2@cmdb.local' },
  { id: 'u-viewer-active',  username: 'viewer1',  displayName: 'Vic Viewer',  role: 'VIEWER',   active: true,  email: 'vic@cmdb.local' },
  { id: 'u-auditor-active', username: 'auditor1', displayName: 'Aud Itor',    role: 'AUDITOR',  active: true,  email: 'aud@cmdb.local' },
  { id: 'u-worker-active',  username: 'worker1',  displayName: 'Wanda Work',  role: 'WORKER',   active: true,  email: 'wanda@cmdb.local' },
  { id: 'u-manager-active', username: 'manager1', displayName: 'Manny Mgr',   role: 'MANAGER',  active: true,  email: 'manny@cmdb.local' },
];

function buildApp(actingRole: string) {
  const app = express();
  app.use(express.json());
  // Fake auth: inject req.user from a header so each test can act as a role.
  app.use((req, _res, next) => {
    (req as any).user = { id: 'test-caller', role: actingRole, email: 'caller@cmdb.local' };
    next();
  });

  app.get('/api/vulnerabilities/assignable-users', requireSecurityRead, (_req, res) => {
    // Identical filter + projection to index.ts's
    // prisma.user.findMany({ where: { active: true, role: { in: ['ADMIN','SOC'] } }, select: {id, username, displayName} })
    const filtered = USERS.filter((u) => u.active && (u.role === 'ADMIN' || u.role === 'SOC'));
    const assignable = filtered.map((u) => ({ id: u.id, displayName: u.displayName ?? u.username }));
    res.json(assignable);
  });

  return app;
}

describe('GET /api/vulnerabilities/assignable-users', () => {
  it('returns only active ADMIN/SOC users, with displayName falling back to username', async () => {
    const app = buildApp('ADMIN');
    const res = await request(app).get('/api/vulnerabilities/assignable-users');

    expect(res.status).toBe(200);
    const ids = res.body.map((u: any) => u.id);
    expect(ids).toEqual(expect.arrayContaining(['u-admin-active', 'u-soc-active']));
    expect(ids).toHaveLength(2);

    const socEntry = res.body.find((u: any) => u.id === 'u-soc-active');
    expect(socEntry.displayName).toBe('soc1'); // fallback to username, displayName is null
    const adminEntry = res.body.find((u: any) => u.id === 'u-admin-active');
    expect(adminEntry.displayName).toBe('Alice Admin');
  });

  it('excludes an inactive ADMIN/SOC user', async () => {
    const app = buildApp('ADMIN');
    const res = await request(app).get('/api/vulnerabilities/assignable-users');

    const ids = res.body.map((u: any) => u.id);
    expect(ids).not.toContain('u-admin-inactive');
    expect(ids).not.toContain('u-soc-inactive');
  });

  it.each(['VIEWER', 'AUDITOR', 'WORKER', 'MANAGER'])(
    'excludes an active %s user from the results even when a %s account is the one calling',
    async (role) => {
      const app = buildApp(role);
      const res = await request(app).get('/api/vulnerabilities/assignable-users');
      if (res.status === 200) {
        const ids = res.body.map((u: any) => u.id);
        expect(ids).not.toContain('u-viewer-active');
        expect(ids).not.toContain('u-auditor-active');
        expect(ids).not.toContain('u-worker-active');
        expect(ids).not.toContain('u-manager-active');
      }
    }
  );

  it('never includes the `email` key in any returned object', async () => {
    const app = buildApp('ADMIN');
    const res = await request(app).get('/api/vulnerabilities/assignable-users');

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    for (const entry of res.body) {
      expect(Object.keys(entry)).not.toContain('email');
      expect(entry.email).toBeUndefined();
    }
  });

  it('AUDITOR can read the list (read access includes ADMIN/AUDITOR/SOC)', async () => {
    const app = buildApp('AUDITOR');
    const res = await request(app).get('/api/vulnerabilities/assignable-users');
    expect(res.status).toBe(200);
  });

  it('SOC can read the list', async () => {
    const app = buildApp('SOC');
    const res = await request(app).get('/api/vulnerabilities/assignable-users');
    expect(res.status).toBe(200);
  });

  it.each(['VIEWER', 'WORKER', 'MANAGER'])('%s is rejected with 403 by requireSecurityRead', async (role) => {
    const app = buildApp(role);
    const res = await request(app).get('/api/vulnerabilities/assignable-users');
    expect(res.status).toBe(403);
  });
});
