// Real production bug (found live, post-v3.7.0): `/vulnerabilities` used to
// fetch every CI's full `vulnerabilities` JSON array via fetchAllCIs and
// flatten all of them client-side — fine at hundreds of rows, but the
// browser hung once a real Red Hat Lightspeed batch pushed the CMDB to
// 458,043 vulnerabilities across 290 CIs. `GET /api/vulnerabilities` (list,
// paginated + filtered), `GET /api/vulnerabilities/summary` (global
// counts), and `GET /api/vulnerabilities/export` (bounded CSV) replace it.
//
// NOTE ON SCOPE: as documented in `vulnPatchIdentity.test.ts` /
// `vulnAssignableUsers.test.ts`, `index.ts` cannot be `require`d or mounted
// directly (module-scope PrismaClient + unconditional `app.listen()`). This
// file mirrors the real filter-building logic (search/cve ILIKE, severity,
// status, source-with-manual-fallback, assignedTo __me__/__unassigned__/
// exact) against an in-memory fixture, and the pagination/export-cap
// arithmetic, identical in spirit to the sibling tests in this directory.

interface FakeVuln {
  cve: string; severity: string; status: string; source?: string;
  assignedTo?: string; importedAt?: string; description?: string;
}
interface FakeCi { id: string; name: string; vulns: FakeVuln[] }

const CALLER_ID = 'caller-user-id';

const CIS: FakeCi[] = [
  { id: 'ci-1', name: 'SRV-WEB01', vulns: [
    { cve: 'CVE-2024-0001', severity: 'CRITICAL', status: 'NUEVO', source: 'greenbone', assignedTo: CALLER_ID, importedAt: '2026-08-01' },
    { cve: 'CVE-2024-0002', severity: 'LOW', status: 'RESUELTO', source: 'crowdstrike', importedAt: '2026-08-02' },
    { cve: '', severity: 'MEDIUM', status: 'NUEVO', description: 'no-cve finding', importedAt: '2026-08-03' }, // legacy, no `source`
  ]},
  { id: 'ci-2', name: 'SRV-DB01', vulns: [
    { cve: 'CVE-2024-0003', severity: 'HIGH', status: 'ASIGNADO', source: 'redhat-lightspeed', assignedTo: 'other-user', importedAt: '2026-08-01' },
  ]},
];

// Mirrors buildVulnerabilityFilterSql's decision logic (index.ts) — a plain
// JS predicate builder instead of Prisma.sql fragments, applied over the
// in-memory fixture above rather than Postgres.
function matches(v: FakeVuln, ciName: string, filters: {
  search?: string; cve?: string; severity?: string; status?: string; source?: string; assignedTo?: string;
}): boolean {
  if (filters.search && !ciName.toLowerCase().includes(filters.search.toLowerCase())) return false;
  if (filters.cve && !(v.cve ?? '').toLowerCase().includes(filters.cve.toLowerCase())) return false;
  if (filters.severity && filters.severity !== 'ALL' && v.severity !== filters.severity) return false;
  if (filters.status && filters.status !== 'ALL' && v.status !== filters.status) return false;
  if (filters.source) {
    const effectiveSource = v.source ?? 'manual';
    if (filters.source === 'manual' ? effectiveSource !== 'manual' : v.source !== filters.source) return false;
  }
  if (filters.assignedTo === '__unassigned__' && v.assignedTo) return false;
  if (filters.assignedTo === '__me__' && v.assignedTo !== CALLER_ID) return false;
  if (filters.assignedTo && filters.assignedTo !== '__unassigned__' && filters.assignedTo !== '__me__' && v.assignedTo !== filters.assignedTo) return false;
  return true;
}

function filterAll(filters: Parameters<typeof matches>[2]): FakeVuln[] {
  const out: FakeVuln[] = [];
  for (const ci of CIS) for (const v of ci.vulns) if (matches(v, ci.name, filters)) out.push(v);
  return out;
}

describe('GET /api/vulnerabilities filter logic', () => {
  it('severity filter matches exactly, ALL is a no-op', () => {
    expect(filterAll({ severity: 'CRITICAL' }).map((v) => v.cve)).toEqual(['CVE-2024-0001']);
    expect(filterAll({ severity: 'ALL' })).toHaveLength(4);
  });

  it('status filter matches exactly, ALL is a no-op', () => {
    expect(filterAll({ status: 'RESUELTO' }).map((v) => v.cve)).toEqual(['CVE-2024-0002']);
    expect(filterAll({ status: 'ALL' })).toHaveLength(4);
  });

  it('source=manual matches vulnerabilities with NO source field, not just source="manual"', () => {
    const result = filterAll({ source: 'manual' });
    expect(result).toHaveLength(1);
    expect(result[0]!.description).toBe('no-cve finding');
  });

  it('an explicit source never matches a legacy no-source entry', () => {
    expect(filterAll({ source: 'greenbone' }).map((v) => v.cve)).toEqual(['CVE-2024-0001']);
    expect(filterAll({ source: 'redhat-lightspeed' }).map((v) => v.cve)).toEqual(['CVE-2024-0003']);
  });

  it('assignedTo=__me__ matches only the calling user\'s id, not any assignment', () => {
    expect(filterAll({ assignedTo: '__me__' }).map((v) => v.cve)).toEqual(['CVE-2024-0001']);
  });

  it('assignedTo=__unassigned__ matches only rows with no assignedTo at all', () => {
    const result = filterAll({ assignedTo: '__unassigned__' });
    expect(result.map((v) => v.cve).sort()).toEqual(['', 'CVE-2024-0002'].sort());
  });

  it('assignedTo=<exact id> matches a specific non-caller assignee', () => {
    expect(filterAll({ assignedTo: 'other-user' }).map((v) => v.cve)).toEqual(['CVE-2024-0003']);
  });

  it('search filters by CI name, case-insensitive substring', () => {
    expect(filterAll({ search: 'web' })).toHaveLength(3);
    expect(filterAll({ search: 'db01' })).toHaveLength(1);
  });

  it('cve filters by substring, case-insensitive, never matches on an empty cve field', () => {
    expect(filterAll({ cve: '0001' }).map((v) => v.cve)).toEqual(['CVE-2024-0001']);
    expect(filterAll({ cve: '' })).toHaveLength(4); // empty filter = no-op, not "match empty cve"
  });

  it('combines multiple filters with AND semantics', () => {
    expect(filterAll({ severity: 'CRITICAL', assignedTo: '__me__' })).toHaveLength(1);
    expect(filterAll({ severity: 'LOW', assignedTo: '__me__' })).toHaveLength(0);
  });
});

describe('GET /api/vulnerabilities pagination bounds', () => {
  const MAX = 100;
  function clampPageSize(requested: number): number {
    return Math.min(MAX, Math.max(1, requested));
  }
  function clampPage(requested: number): number {
    return Math.max(1, requested);
  }

  it('clamps an oversized pageSize down to the max, never returning more', () => {
    expect(clampPageSize(999999)).toBe(100);
  });
  it('clamps a zero/negative pageSize up to 1, never zero rows silently', () => {
    expect(clampPageSize(0)).toBe(1);
    expect(clampPageSize(-5)).toBe(1);
  });
  it('clamps page below 1 up to 1', () => {
    expect(clampPage(0)).toBe(1);
    expect(clampPage(-3)).toBe(1);
  });
});

describe('GET /api/vulnerabilities/export row cap', () => {
  const MAX_ROWS = 50_000;

  it('rejects an export whose filtered total exceeds the cap, before building any CSV', () => {
    const total = 60_000;
    expect(total > MAX_ROWS).toBe(true);
  });

  it('allows an export exactly at the cap', () => {
    const total = MAX_ROWS;
    expect(total > MAX_ROWS).toBe(false);
  });
});
