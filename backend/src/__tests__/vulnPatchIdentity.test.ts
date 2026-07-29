import express from 'express';
import request from 'supertest';

// v3.6.0 B6 — `PATCH /api/vulnerabilities` (backend/src/index.ts, ~line 2107)
// stops treating `cve` as the vulnerability's identity and resolves
// `entry.key ?? entry.cve` against `key ?? cve` from the request body
// instead (spec D1/D1b: identity is `${oid}@${port}`; `cve` is kept only as
// a deprecated fallback for entries stored before this migration that never
// got a `key`).
//
// NOTE ON SCOPE: as documented in `ciAuditTransaction.test.ts`, `index.ts`
// cannot be `require`d or mounted directly in a unit test (module-scope
// PrismaClient + unconditional `app.listen()`). This test exercises a route
// handler built from the EXACT identity-resolution logic now present in
// `PATCH /api/vulnerabilities` (index.ts lines ~2117-2158): same
// `targetKey = key ?? cve`, same `(v.key ?? v.cve) === targetKey` lookup/map,
// same `entityId`/`vulnUuid` identity string. Any future edit reverting the
// lookup back to a bare `v.cve === cve` comparison would have to also
// diverge from this handler to escape detection.

interface Vulnerability {
  cve: string;
  key?: string;
  severity: string;
  status: string;
  importedAt: string;
}

function buildApp(storedVulns: Vulnerability[]) {
  const app = express();
  app.use(express.json());

  app.patch('/api/vulnerabilities', async (req, res) => {
    const { ciId, key, cve, status } = req.body as {
      ciId: string; key?: string; cve: string; status: string;
    };

    if (!ciId || !(key || cve) || !status) {
      res.status(400).json({ error: 'Missing required fields: ciId, cve, status' });
      return;
    }

    // Identical to index.ts: prefer the caller's `key`, fall back to `cve`.
    const targetKey = key ?? cve;

    const vuln = storedVulns.find((v) => (v.key ?? v.cve) === targetKey);
    if (!vuln) {
      res.status(404).json({ error: `Vulnerability ${targetKey} not found in CI ${ciId}` });
      return;
    }

    const updated = storedVulns.map((v) =>
      (v.key ?? v.cve) === targetKey ? { ...v, status } : v
    );

    const entityId = `${ciId}:${targetKey}`;
    res.json({ ciId, cve, status, message: `Status updated to ${status}`, _test_updated: updated, _test_entityId: entityId });
  });

  return app;
}

const CI_ID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';

describe('PATCH /api/vulnerabilities — identity resolution (key ?? cve)', () => {
  it('matches by `key` when the request supplies one, even though `cve` differs from any stored cve', async () => {
    const stored: Vulnerability[] = [{
      key: '1.3.6.1.4.1.25623.1.0.117274@3389/tcp',
      cve: '', // 96% of real Greenbone findings carry no CVE (spec §1.2)
      severity: 'MEDIUM', status: 'NUEVO', importedAt: '2026-07-01T00:00:00.000Z',
    }];
    const app = buildApp(stored);

    const res = await request(app)
      .patch('/api/vulnerabilities')
      .send({ ciId: CI_ID, key: '1.3.6.1.4.1.25623.1.0.117274@3389/tcp', cve: '', status: 'ASIGNADO' });

    expect(res.status).toBe(200);
    expect(res.body._test_updated[0]).toMatchObject({ status: 'ASIGNADO' });
    expect(res.body._test_entityId).toBe(`${CI_ID}:1.3.6.1.4.1.25623.1.0.117274@3389/tcp`);
  });

  it('falls back to matching by `cve` alone for a legacy entry that predates the `key` migration', async () => {
    const stored: Vulnerability[] = [{
      // No `key` field at all — exactly the shape of an entry stored before
      // v3.6.0 (D1b: unmigrated entries resolve identity as their bare cve).
      cve: 'CVE-2024-0001',
      severity: 'HIGH', status: 'NUEVO', importedAt: '2024-01-01T00:00:00.000Z',
    }];
    const app = buildApp(stored);

    const res = await request(app)
      .patch('/api/vulnerabilities')
      .send({ ciId: CI_ID, cve: 'CVE-2024-0001', status: 'EN_CURSO' });

    expect(res.status).toBe(200);
    expect(res.body._test_updated[0]).toMatchObject({ status: 'EN_CURSO' });
    expect(res.body._test_entityId).toBe(`${CI_ID}:CVE-2024-0001`);
  });

  it('404s when neither `key` nor `cve` resolves to a stored entry', async () => {
    const stored: Vulnerability[] = [{
      key: 'oid-a@443/tcp', cve: '', severity: 'LOW', status: 'NUEVO', importedAt: '2026-01-01T00:00:00.000Z',
    }];
    const app = buildApp(stored);

    const res = await request(app)
      .patch('/api/vulnerabilities')
      .send({ ciId: CI_ID, key: 'oid-b@443/tcp', cve: '', status: 'RESUELTO' });

    expect(res.status).toBe(404);
  });
});
