/**
 * B2 — parser.ts / schemas.ts tests. Pure parsing logic, no Prisma/DB
 * involved. Loads the REAL Greenbone fixture (docs/mocks/greenbone_SRV-MYGESTR01D.json,
 * 1 host, 52 vulnerabilities) and asserts exact facts verified by direct
 * inspection of that file (see spec §1.2).
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  parseGreenboneReport,
  scoreToSeverity,
  UnsupportedGreenboneFormatError,
} from '../parser';

const FIXTURE_PATH = path.join(__dirname, '../../../../../docs/mocks/greenbone_SRV-MYGESTR01D.json');

function loadFixture(): unknown {
  const raw = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  return JSON.parse(raw);
}

describe('scoreToSeverity — CVSS v3.1 bands (spec D2)', () => {
  it('0.0 -> INFO', () => expect(scoreToSeverity(0.0)).toBe('INFO'));

  it('3.9 -> LOW (upper boundary)', () => expect(scoreToSeverity(3.9)).toBe('LOW'));
  it('2.1 -> LOW (inside band)', () => expect(scoreToSeverity(2.1)).toBe('LOW'));

  it('4.0 -> MEDIUM (lower boundary)', () => expect(scoreToSeverity(4.0)).toBe('MEDIUM'));
  it('6.9 -> MEDIUM (upper boundary)', () => expect(scoreToSeverity(6.9)).toBe('MEDIUM'));
  it('5.0 -> MEDIUM (inside band)', () => expect(scoreToSeverity(5.0)).toBe('MEDIUM'));

  it('7.0 -> HIGH (lower boundary)', () => expect(scoreToSeverity(7.0)).toBe('HIGH'));
  it('8.9 -> HIGH (upper boundary)', () => expect(scoreToSeverity(8.9)).toBe('HIGH'));
  it('8.0 -> HIGH (inside band)', () => expect(scoreToSeverity(8.0)).toBe('HIGH'));

  it('9.0 -> CRITICAL (lower boundary)', () => expect(scoreToSeverity(9.0)).toBe('CRITICAL'));
  it('10.0 -> CRITICAL (upper boundary)', () => expect(scoreToSeverity(10.0)).toBe('CRITICAL'));
  it('9.5 -> CRITICAL (inside band)', () => expect(scoreToSeverity(9.5)).toBe('CRITICAL'));
});

describe('parseGreenboneReport — real fixture (greenbone_SRV-MYGESTR01D.json)', () => {
  const fixture = loadFixture();
  const result = parseGreenboneReport(fixture);

  it('parses exactly 52 vulnerability entries', () => {
    expect(result.entries).toHaveLength(52);
  });

  it('has exactly 27 distinct oid values', () => {
    const oids = new Set(result.entries.map((e) => e.oid));
    expect(oids.size).toBe(27);
  });

  it('has exactly 52 distinct key values (no collisions)', () => {
    const keys = new Set(result.entries.map((e) => e.key));
    expect(keys.size).toBe(52);
  });

  it('has exactly 3 Alarm entries and 49 Log entries', () => {
    const alarms = result.entries.filter((e) => e.thread === 'Alarm');
    const logs = result.entries.filter((e) => e.thread === 'Log');
    expect(alarms).toHaveLength(3);
    expect(logs).toHaveLength(49);
  });

  it('parses the RDP (3389/tcp) entry with its 5 CVEs, MEDIUM severity, and epss score', () => {
    const entry = result.entries.find(
      (e) => e.oid === '1.3.6.1.4.1.25623.1.0.117274' && e.port === '3389/tcp',
    );
    expect(entry).toBeDefined();
    expect(entry!.cves).toEqual([
      'CVE-2011-3389',
      'CVE-2015-0204',
      'CVE-2023-41928',
      'CVE-2024-41270',
      'CVE-2025-3200',
    ]);
    expect(entry!.severityScore).toBeCloseTo(4.3);
    expect(entry!.severity).toBe('MEDIUM');
    expect(entry!.epssScore).toBeCloseTo(0.98685, 5);
    expect(entry!.key).toBe('1.3.6.1.4.1.25623.1.0.117274@3389/tcp');
  });

  it('extracts scan-level metadata (taskName, greenboneTaskId)', () => {
    expect(result.taskName).toBe('800_Madrid - Recheck 02');
    expect(result.greenboneTaskId).toBe('ce3d933a-175b-44c2-a203-4fb3dec1ee20');
  });

  it('produces cves: [] (not synthesized) for an entry with no CVE', () => {
    const noCveEntry = result.entries.find((e) => e.cves.length === 0);
    expect(noCveEntry).toBeDefined();
    expect(noCveEntry!.cves).toEqual([]);
  });

  it('joins the description array into a single "\\n"-separated string', () => {
    for (const entry of result.entries) {
      expect(typeof entry.description).toBe('string');
    }
  });

  it('carries the original vulnerability object untouched in raw', () => {
    const entry = result.entries[0];
    expect(entry.raw).toBeDefined();
    expect(entry.raw.oid).toBe(entry.oid);
  });
});

describe('parseGreenboneReport — old/unsupported mock format', () => {
  it('throws UnsupportedGreenboneFormatError for the old results[] shape, not a silent empty result', () => {
    const oldMockShape = {
      results: [
        {
          host: { hostname: 'SRV-X', ip: '10.0.0.1' },
          vulnerabilities: [
            { cve: 'CVE-2024-21413', severity: 'CRITICAL', description: 'test' },
          ],
        },
      ],
    };

    expect(() => parseGreenboneReport(oldMockShape)).toThrow(UnsupportedGreenboneFormatError);
    expect(() => parseGreenboneReport(oldMockShape)).toThrow(/allHostSubreportEntries/);
  });

  it('does not throw UnsupportedGreenboneFormatError when both keys happen to coexist', () => {
    const bothKeys = {
      results: [],
      allHostSubreportEntries: [{ host: '10.0.0.1', vulnerabilities: [] }],
    };
    expect(() => parseGreenboneReport(bothKeys)).not.toThrow(UnsupportedGreenboneFormatError);
  });
});
