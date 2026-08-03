import {
  classifyVulnerability,
  computeAbsentClosures,
  isSeverityAtLeast,
  isActivelyExploited,
  ACTIVE_EXPLOITATION_LABELS,
  IncomingVulnerability,
} from '../classifier.js';
import type { Vulnerability, VulnSeverity, VulnStatus } from '../../integrations/types.js';

function incoming(key: string, severity: VulnSeverity, extra: Partial<IncomingVulnerability> = {}): IncomingVulnerability {
  return { key, severity, ...extra };
}

function stored(overrides: Partial<Vulnerability> & { status: VulnStatus }): Pick<Vulnerability, 'key' | 'cve' | 'status'> {
  return {
    cve: overrides.cve ?? 'CVE-0000-0000',
    key: overrides.key,
    status: overrides.status,
  };
}

describe('classifyVulnerability', () => {
  test('unmatched key, severity HIGH -> NUEVA / INCLUDE', () => {
    const result = classifyVulnerability(incoming('1.3.6.1.4.1.25623.1.0.1@22/tcp', 'HIGH'), []);
    expect(result).toEqual({ classification: 'NUEVA', decision: 'INCLUDE', existingStatus: null });
  });

  test('unmatched key, severity LOW -> NUEVA / EXCLUDE', () => {
    const result = classifyVulnerability(incoming('1.3.6.1.4.1.25623.1.0.2@22/tcp', 'LOW'), []);
    expect(result).toEqual({ classification: 'NUEVA', decision: 'EXCLUDE', existingStatus: null });
  });

  test('unmatched key, severity INFO -> NUEVA / EXCLUDE', () => {
    const result = classifyVulnerability(incoming('1.3.6.1.4.1.25623.1.0.3@22/tcp', 'INFO'), []);
    expect(result).toEqual({ classification: 'NUEVA', decision: 'EXCLUDE', existingStatus: null });
  });

  test('unmatched key, severity exactly MEDIUM -> NUEVA / INCLUDE (boundary)', () => {
    const result = classifyVulnerability(incoming('1.3.6.1.4.1.25623.1.0.4@22/tcp', 'MEDIUM'), []);
    expect(result).toEqual({ classification: 'NUEVA', decision: 'INCLUDE', existingStatus: null });
  });

  test('matched, status NUEVO -> EXISTENTE_PENDIENTE / EXCLUDE', () => {
    const key = '1.3.6.1.4.1.25623.1.0.5@22/tcp';
    const result = classifyVulnerability(incoming(key, 'HIGH'), [stored({ key, status: 'NUEVO' })]);
    expect(result).toEqual({ classification: 'EXISTENTE_PENDIENTE', decision: 'EXCLUDE', existingStatus: 'NUEVO' });
  });

  test.each<VulnStatus>(['ASIGNADO', 'EN_CURSO', 'PARADO'])(
    'matched, status %s -> EXISTENTE_PENDIENTE / EXCLUDE',
    (status) => {
      const key = `1.3.6.1.4.1.25623.1.0.6@22/tcp#${status}`;
      const result = classifyVulnerability(incoming(key, 'CRITICAL'), [stored({ key, status })]);
      expect(result).toEqual({ classification: 'EXISTENTE_PENDIENTE', decision: 'EXCLUDE', existingStatus: status });
    },
  );

  test('matched, status RESUELTO, incoming severity LOW -> REAPARECIDA / INCLUDE (override)', () => {
    const key = '1.3.6.1.4.1.25623.1.0.7@22/tcp';
    const result = classifyVulnerability(incoming(key, 'LOW'), [stored({ key, status: 'RESUELTO' })]);
    expect(result).toEqual({ classification: 'REAPARECIDA', decision: 'INCLUDE', existingStatus: 'RESUELTO' });
  });

  test('empty stored list -> NUEVA for any incoming key', () => {
    const result = classifyVulnerability(incoming('anything@0/tcp', 'CRITICAL'), []);
    expect(result.classification).toBe('NUEVA');
  });

  test('null stored list -> NUEVA for any incoming key', () => {
    const result = classifyVulnerability(incoming('anything@0/tcp', 'CRITICAL'), null);
    expect(result.classification).toBe('NUEVA');
  });

  test('undefined stored list -> NUEVA for any incoming key', () => {
    const result = classifyVulnerability(incoming('anything@0/tcp', 'CRITICAL'), undefined);
    expect(result.classification).toBe('NUEVA');
  });

  test('legacy stored entry with no key, matched by cve fallback (D1b)', () => {
    const legacyCve = 'CVE-2019-0001';
    const legacyEntry: Pick<Vulnerability, 'key' | 'cve' | 'status'> = {
      cve: legacyCve,
      status: 'NUEVO',
      // key intentionally omitted (pre-migration row)
    };
    const result = classifyVulnerability(incoming(legacyCve, 'HIGH'), [legacyEntry]);
    expect(result).toEqual({ classification: 'EXISTENTE_PENDIENTE', decision: 'EXCLUDE', existingStatus: 'NUEVO' });
  });

  test('stored entry with neither key nor cve never matches (defensive edge case)', () => {
    // Cast needed: `cve` is required on Vulnerability, but stored data can
    // in principle be malformed/legacy. The classifier must not crash.
    const unidentifiable = { status: 'NUEVO' as VulnStatus } as Pick<Vulnerability, 'key' | 'cve' | 'status'>;
    const result = classifyVulnerability(incoming('1.3.6.1.4.1.25623.1.0.9@22/tcp', 'HIGH'), [unidentifiable]);
    expect(result).toEqual({ classification: 'NUEVA', decision: 'INCLUDE', existingStatus: null });
  });
});

describe('isSeverityAtLeast', () => {
  test.each<[VulnSeverity, boolean]>([
    ['INFO', false],
    ['LOW', false],
    ['MEDIUM', true],
    ['HIGH', true],
    ['CRITICAL', true],
  ])('%s >= MEDIUM (default threshold) -> %s', (severity, expected) => {
    expect(isSeverityAtLeast(severity)).toBe(expected);
  });

  test('explicit threshold: HIGH >= CRITICAL is false', () => {
    expect(isSeverityAtLeast('HIGH', 'CRITICAL')).toBe(false);
  });

  test('explicit threshold: CRITICAL >= CRITICAL is true', () => {
    expect(isSeverityAtLeast('CRITICAL', 'CRITICAL')).toBe(true);
  });

  test('explicit threshold: INFO >= INFO is true', () => {
    expect(isSeverityAtLeast('INFO', 'INFO')).toBe(true);
  });
});

// CrowdStrike Spotlight extensions (v3.6.1, spec D4/D5). Greenbone-era tests
// above are untouched; everything below is additive.
describe('classifyVulnerability — CrowdStrike externalStatus (D5)', () => {
  test('externalStatus Reopened, no CMDB match at all -> REAPARECIDA, not NUEVA', () => {
    const result = classifyVulnerability(
      incoming('cs-key-reopened-no-match', 'HIGH', { externalStatus: 'Reopened' }),
      [],
    );
    expect(result).toEqual({ classification: 'REAPARECIDA', decision: 'INCLUDE', existingStatus: null });
  });

  test('externalStatus Reopened, CMDB has it as NUEVO (still open) -> REAPARECIDA (overrides EXISTENTE_PENDIENTE)', () => {
    const key = 'cs-key-reopened-nuevo';
    const result = classifyVulnerability(
      incoming(key, 'HIGH', { externalStatus: 'Reopened' }),
      [stored({ key, status: 'NUEVO' })],
    );
    expect(result).toEqual({ classification: 'REAPARECIDA', decision: 'INCLUDE', existingStatus: 'NUEVO' });
  });

  test('externalStatus Reopened, CMDB has it as RESUELTO -> REAPARECIDA (same outcome, reachable via either path)', () => {
    const key = 'cs-key-reopened-resuelto';
    const result = classifyVulnerability(
      incoming(key, 'HIGH', { externalStatus: 'Reopened' }),
      [stored({ key, status: 'RESUELTO' })],
    );
    expect(result).toEqual({ classification: 'REAPARECIDA', decision: 'INCLUDE', existingStatus: 'RESUELTO' });
  });

  test('externalStatus Open behaves exactly as before (no regression), matched NUEVO -> EXISTENTE_PENDIENTE', () => {
    const key = 'cs-key-open-nuevo';
    const result = classifyVulnerability(
      incoming(key, 'HIGH', { externalStatus: 'Open' }),
      [stored({ key, status: 'NUEVO' })],
    );
    expect(result).toEqual({ classification: 'EXISTENTE_PENDIENTE', decision: 'EXCLUDE', existingStatus: 'NUEVO' });
  });

  test('externalStatus absent/undefined (Greenbone-style) behaves exactly as before, unmatched HIGH -> NUEVA / INCLUDE', () => {
    const result = classifyVulnerability(incoming('cs-key-no-external-status', 'HIGH'), []);
    expect(result).toEqual({ classification: 'NUEVA', decision: 'INCLUDE', existingStatus: null });
  });
});

describe('classifyVulnerability — CrowdStrike KEV / active exploitation premarking (D4)', () => {
  test('cisaKev true, severity LOW, no CMDB match -> NUEVA / INCLUDE (pre-selected, not the default EXCLUDE a plain LOW would get)', () => {
    const result = classifyVulnerability(
      incoming('cs-kev-low', 'LOW', { cisaKev: true }),
      [],
    );
    expect(result).toEqual({ classification: 'NUEVA', decision: 'INCLUDE', existingStatus: null });
  });

  test('exploitStatus "Actively used (critical)", severity LOW -> pre-selected INCLUDE', () => {
    const result = classifyVulnerability(
      incoming('cs-exploit-active-critical', 'LOW', { exploitStatus: 'Actively used (critical)' }),
      [],
    );
    expect(result).toEqual({ classification: 'NUEVA', decision: 'INCLUDE', existingStatus: null });
  });

  test('exploitStatus "Available (medium)", severity LOW -> NOT pre-selected (available != active)', () => {
    const result = classifyVulnerability(
      incoming('cs-exploit-available-medium', 'LOW', { exploitStatus: 'Available (medium)' }),
      [],
    );
    expect(result).toEqual({ classification: 'NUEVA', decision: 'EXCLUDE', existingStatus: null });
  });

  test('exploitStatus "Unproven", severity LOW -> NOT pre-selected', () => {
    const result = classifyVulnerability(
      incoming('cs-exploit-unproven', 'LOW', { exploitStatus: 'Unproven' }),
      [],
    );
    expect(result).toEqual({ classification: 'NUEVA', decision: 'EXCLUDE', existingStatus: null });
  });

  test('exploitStatus "Easily Accessible (high)", severity INFO -> pre-selected INCLUDE', () => {
    const result = classifyVulnerability(
      incoming('cs-exploit-easily-accessible', 'INFO', { exploitStatus: 'Easily Accessible (high)' }),
      [],
    );
    expect(result).toEqual({ classification: 'NUEVA', decision: 'INCLUDE', existingStatus: null });
  });

  test('EXISTENTE_PENDIENTE default-EXCLUDE is unaffected by cisaKev (already-tracked-and-pending stays EXCLUDE)', () => {
    const key = 'cs-existente-pendiente-kev';
    const result = classifyVulnerability(
      incoming(key, 'LOW', { cisaKev: true }),
      [stored({ key, status: 'NUEVO' })],
    );
    expect(result).toEqual({ classification: 'EXISTENTE_PENDIENTE', decision: 'EXCLUDE', existingStatus: 'NUEVO' });
  });

  test('EXISTENTE_PENDIENTE default-EXCLUDE is unaffected by an actively-exploited exploitStatus', () => {
    const key = 'cs-existente-pendiente-exploit';
    const result = classifyVulnerability(
      incoming(key, 'LOW', { exploitStatus: 'Actively used (critical)' }),
      [stored({ key, status: 'ASIGNADO' })],
    );
    expect(result).toEqual({ classification: 'EXISTENTE_PENDIENTE', decision: 'EXCLUDE', existingStatus: 'ASIGNADO' });
  });
});

describe('isActivelyExploited', () => {
  test.each<[string, boolean]>([
    ['Unproven', false],
    ['Available (medium)', false],
    ['Actively used (critical)', true],
    ['Easily Accessible (high)', true],
  ])('%s -> %s', (label, expected) => {
    expect(isActivelyExploited(label)).toBe(expected);
  });

  test('undefined -> false', () => {
    expect(isActivelyExploited(undefined)).toBe(false);
  });

  test('null -> false', () => {
    expect(isActivelyExploited(null)).toBe(false);
  });

  test('empty string -> false', () => {
    expect(isActivelyExploited('')).toBe(false);
  });

  test('unrecognized label -> false', () => {
    expect(isActivelyExploited('Some Future Label')).toBe(false);
  });

  test('ACTIVE_EXPLOITATION_LABELS contains exactly the two active labels', () => {
    expect(Array.from(ACTIVE_EXPLOITATION_LABELS).sort()).toEqual(
      ['Actively used (critical)', 'Easily Accessible (high)'].sort(),
    );
  });
});

// ─── computeAbsentClosures (task 15, v3.7.0 prep) ───────────────────────────
//
// Note: case "3" from the design (a CI that never appears in the current
// batch at all never gets a closure) is NOT expressable as a unit test of
// this pure function — it is enforced entirely by the CALLER only ever
// invoking computeAbsentClosures for CIs present in `storedVulnsByCi`, which
// by construction only contains batch-matched CIs (see uploadReport's and
// runImportBackground's doc comments at their call sites). That case is
// covered at the integration level in router.test.ts instead.
function fullStored(overrides: Partial<Vulnerability> & { status: VulnStatus }): Vulnerability {
  return {
    cve: overrides.cve ?? 'CVE-0000-0000',
    key: overrides.key,
    severity: overrides.severity ?? 'HIGH',
    description: overrides.description ?? 'stored vuln',
    source: overrides.source ?? 'greenbone',
    status: overrides.status,
    importedAt: overrides.importedAt ?? '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('computeAbsentClosures', () => {
  const CI_ID = 'ci-1';

  test('same source, open status, absent from reportedKeys -> closure generated', () => {
    const v = fullStored({ key: 'oid-1@22/tcp', source: 'greenbone', status: 'NUEVO' });
    const result = computeAbsentClosures(CI_ID, 'greenbone', [v], new Set());
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      ciId: CI_ID,
      vulnKey: 'oid-1@22/tcp',
      classification: 'RESUELTA_AUSENTE',
      decision: 'INCLUDE',
      existingStatus: 'NUEVO',
    });
  });

  test('different source than the current batch -> NOT closed', () => {
    const v = fullStored({ key: 'oid-2@22/tcp', source: 'crowdstrike', status: 'NUEVO' });
    const result = computeAbsentClosures(CI_ID, 'greenbone', [v], new Set());
    expect(result).toHaveLength(0);
  });

  test('already RESUELTO -> not re-closed', () => {
    const v = fullStored({ key: 'oid-3@22/tcp', source: 'greenbone', status: 'RESUELTO' });
    const result = computeAbsentClosures(CI_ID, 'greenbone', [v], new Set());
    expect(result).toHaveLength(0);
  });

  test('REABIERTA counts as open -> closes if absent (confirms the REABIERTA-inclusive list, not classifier.ts\'s OPEN_STATUSES)', () => {
    const v = fullStored({ key: 'oid-4@22/tcp', source: 'greenbone', status: 'REABIERTA' });
    const result = computeAbsentClosures(CI_ID, 'greenbone', [v], new Set());
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ vulnKey: 'oid-4@22/tcp', classification: 'RESUELTA_AUSENTE', existingStatus: 'REABIERTA' });
  });

  test('still present in reportedKeys -> not closed', () => {
    const v = fullStored({ key: 'oid-5@22/tcp', source: 'greenbone', status: 'NUEVO' });
    const result = computeAbsentClosures(CI_ID, 'greenbone', [v], new Set(['oid-5@22/tcp']));
    expect(result).toHaveLength(0);
  });

  test('unidentifiable stored entry (no key, no cve) is skipped rather than guessed at', () => {
    const v = { status: 'NUEVO' as VulnStatus, source: 'greenbone' } as Vulnerability;
    const result = computeAbsentClosures(CI_ID, 'greenbone', [v], new Set());
    expect(result).toHaveLength(0);
  });
});

describe('classifyVulnerability — Red Hat Lightspeed knownExploit premarking', () => {
  it('force-premarks a NUEVA, low-severity entry when knownExploit is true (Red Hat Lightspeed signal)', () => {
    const result = classifyVulnerability(
      { key: 'CVE-2024-9999', severity: 'LOW', knownExploit: true },
      null,
    );
    expect(result.classification).toBe('NUEVA');
    expect(result.decision).toBe('INCLUDE');
  });

  it('does not force-premark a NUEVA, low-severity entry when knownExploit is false/absent', () => {
    const result = classifyVulnerability(
      { key: 'CVE-2024-9998', severity: 'LOW', knownExploit: false },
      null,
    );
    expect(result.classification).toBe('NUEVA');
    expect(result.decision).toBe('EXCLUDE');
  });
});
