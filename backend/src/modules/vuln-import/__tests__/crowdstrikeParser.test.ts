/**
 * B2 — crowdstrikeParser.ts / schemas.ts (CrowdStrike section) tests. Pure
 * parsing logic, no Prisma/DB involved. Loads the REAL CrowdStrike
 * Spotlight fixture (docs/mocks/crowdstrike_SRV-MYGESTR01D.json, 841
 * records, 1 host) and asserts exact facts verified by direct inspection
 * of that file (see the B2 task report for the verification commands).
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  parseCrowdStrikeReport,
  UnsupportedCrowdStrikeFormatError,
} from '../crowdstrikeParser';

const FIXTURE_PATH = path.join(__dirname, '../../../../../docs/mocks/crowdstrike_SRV-MYGESTR01D.json');
const LEGACY_MOCK_PATH = path.join(__dirname, '../../../../../docs/mocks/crowdstrike_sample.json');

function loadFixture(): unknown {
  const raw = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  return JSON.parse(raw);
}

describe('parseCrowdStrikeReport — real fixture (crowdstrike_SRV-MYGESTR01D.json)', () => {
  const fixture = loadFixture();
  const result = parseCrowdStrikeReport(fixture);

  it('merges 841 raw records into exactly 635 distinct vulnerability_id entries', () => {
    expect(result.entries).toHaveLength(635);
  });

  it('has 635 distinct key values (no collisions, key === vulnerability_id)', () => {
    const keys = new Set(result.entries.map((e) => e.key));
    expect(keys.size).toBe(635);
  });

  it('merges CVE-2025-30749 (3 raw records, one per affected product) into a single entry with all 3 products', () => {
    const entry = result.entries.find((e) => e.key === 'CVE-2025-30749');
    expect(entry).toBeDefined();
    expect(entry!.cves).toEqual(['CVE-2025-30749']);
    expect(entry!.products).toHaveLength(3);
    expect(new Set(entry!.products)).toEqual(new Set(['JRE 1.8.0', 'JDK 1.8.0', 'JDK 11']));
  });

  it('keeps CS-V26-A757135 (no cve_id in the raw record) with cves: [] — never synthesizes a fake CVE', () => {
    const entry = result.entries.find((e) => e.key === 'CS-V26-A757135');
    expect(entry).toBeDefined();
    expect(entry!.cves).toEqual([]);
  });

  it('has exactly 3 merged entries with cisaKev === true (4 raw KEV records collapse to 3 distinct vulnerability_ids — CVE-2023-41993 has 2 KEV records)', () => {
    const kevEntries = result.entries.filter((e) => e.cisaKev === true);
    expect(kevEntries).toHaveLength(3);
    expect(new Set(kevEntries.map((e) => e.key))).toEqual(
      new Set(['CVE-2025-41244', 'CVE-2023-41993', 'CVE-2026-56155']),
    );
  });

  it('has exactly 28 distinct vulnerability_id entries with externalStatus "Reopened" (61 raw Reopened records span 28 distinct vulnerability_ids)', () => {
    const reopened = result.entries.filter((e) => e.externalStatus === 'Reopened');
    expect(reopened).toHaveLength(28);
  });

  it('parses base_score "7.8 v3.x" into severityScore 7.8, cvssVersion "v3.x", severity HIGH', () => {
    const entry = result.entries.find((e) => e.key === 'CVE-2026-58613');
    expect(entry).toBeDefined();
    expect(entry!.severityScore).toBeCloseTo(7.8);
    expect(entry!.cvssVersion).toBe('v3.x');
    expect(entry!.severity).toBe('HIGH');
  });

  it('coerces cisa_info.due_date: "" on a non-KEV record to undefined, never the literal empty string', () => {
    const nonKev = result.entries.filter((e) => e.cisaKev === false);
    expect(nonKev.length).toBeGreaterThan(0);
    for (const entry of nonKev) {
      expect(entry.cisaDueDate).toBeUndefined();
    }
  });

  it('sets a real cisaDueDate on a KEV entry', () => {
    const entry = result.entries.find((e) => e.key === 'CVE-2023-41993');
    expect(entry).toBeDefined();
    expect(entry!.cisaDueDate).toBe('2023-10-16T00:00:00Z');
  });

  it('extracts exploit_status.label (object -> string), not the raw object', () => {
    const entry = result.entries.find((e) => e.key === 'CVE-2026-58613');
    expect(entry).toBeDefined();
    expect(entry!.exploitStatus).toBe('Available (medium)');
  });

  it('sets hostAddress from local_ip (matching Greenbone convention)', () => {
    for (const entry of result.entries) {
      expect(entry.hostAddress).toBe('10.100.12.61');
    }
  });

  it('exprtRating is a distinct signal from CVSS-derived severity (both present, not conflated)', () => {
    const entry = result.entries.find((e) => e.key === 'CVE-2026-58613');
    expect(entry).toBeDefined();
    expect(entry!.exprtRating).toBe('Critical');
    expect(entry!.severity).toBe('HIGH');
    expect(entry!.exprtRating).not.toBe(entry!.severity);
  });

  it('flattens products of a group with an empty products array (Reopened records) without throwing', () => {
    const reopenedOnly = result.entries.find((e) => e.externalStatus === 'Reopened' && e.key === 'CS-V26-A757135');
    expect(reopenedOnly).toBeDefined();
    expect(reopenedOnly!.products).toEqual([]);
  });
});

describe('parseCrowdStrikeReport — old/unsupported mock format', () => {
  it('throws UnsupportedCrowdStrikeFormatError for the old {platform, devices: []} agent/EDR shape, not a silent empty result', () => {
    let legacyMock: unknown;
    if (fs.existsSync(LEGACY_MOCK_PATH)) {
      legacyMock = JSON.parse(fs.readFileSync(LEGACY_MOCK_PATH, 'utf-8'));
    } else {
      legacyMock = {
        platform: 'CrowdStrike Falcon',
        export_date: '2026-03-13T19:00:00Z',
        organization: 'CMDB Corp',
        devices: [{ hostname: 'PROD-SRV-01', agent_id: 'abc123', status: 'normal', detections: [] }],
      };
    }

    expect(() => parseCrowdStrikeReport(legacyMock)).toThrow(UnsupportedCrowdStrikeFormatError);
    expect(() => parseCrowdStrikeReport(legacyMock)).toThrow(/devices/);
  });

  it('throws UnsupportedCrowdStrikeFormatError for a non-array, non-devices object', () => {
    expect(() => parseCrowdStrikeReport({ foo: 'bar' })).toThrow(UnsupportedCrowdStrikeFormatError);
  });

  it('throws UnsupportedCrowdStrikeFormatError for null', () => {
    expect(() => parseCrowdStrikeReport(null)).toThrow(UnsupportedCrowdStrikeFormatError);
  });

  it('does not throw for an empty array (structurally valid, just 0 entries)', () => {
    expect(() => parseCrowdStrikeReport([])).not.toThrow();
    expect(parseCrowdStrikeReport([]).entries).toEqual([]);
  });
});

describe('parseCrowdStrikeReport — Reopened-wins merge rule (synthetic, spec §1 B2)', () => {
  it('merges two raw records sharing a vulnerability_id where one is Open and the other Reopened into a single entry with externalStatus "Reopened"', () => {
    const synthetic = [
      {
        hostname: 'SRV-TEST', local_ip: '10.0.0.5', vulnerability_id: 'CVE-2099-00001', cve_id: 'CVE-2099-00001',
        base_score: '5.5 v3.x', exprt_rating: 'Medium', severity: 'Medium',
        exploit_status: { value: 0, label: 'Unproven' },
        cisa_info: { is_cisa_kev: false, due_date: '' },
        recommended_remediations: [{ detail: 'Update product A.' }],
        products: [{ product_name: 'A', product_name_version: 'A 1.0' }],
        status: 'Open', days_open: 10,
      },
      {
        hostname: 'SRV-TEST', local_ip: '10.0.0.5', vulnerability_id: 'CVE-2099-00001', cve_id: 'CVE-2099-00001',
        base_score: '5.5 v3.x', exprt_rating: 'Medium', severity: 'Medium',
        exploit_status: { value: 0, label: 'Unproven' },
        cisa_info: { is_cisa_kev: false, due_date: '' },
        recommended_remediations: [{ detail: 'Update product B.' }],
        products: [{ product_name: 'B', product_name_version: 'B 2.0' }],
        status: 'Reopened', days_open: 3,
      },
    ];

    const result = parseCrowdStrikeReport(synthetic);
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0];
    expect(entry.externalStatus).toBe('Reopened');
    expect(entry.products).toEqual(expect.arrayContaining(['A 1.0', 'B 2.0']));
    expect(entry.products).toHaveLength(2);
    expect(entry.daysOpen).toBe(10);
    expect(entry.solution).toContain('Update product A.');
    expect(entry.solution).toContain('Update product B.');
  });

  it('merges when the FIRST record is Reopened and a later one is Open — order must not matter', () => {
    const synthetic = [
      {
        hostname: 'SRV-TEST', local_ip: '10.0.0.5', vulnerability_id: 'CVE-2099-00002', cve_id: 'CVE-2099-00002',
        base_score: '4.0 v3.x', status: 'Reopened',
        recommended_remediations: [], products: [],
      },
      {
        hostname: 'SRV-TEST', local_ip: '10.0.0.5', vulnerability_id: 'CVE-2099-00002', cve_id: 'CVE-2099-00002',
        base_score: '4.0 v3.x', status: 'Open',
        recommended_remediations: [], products: [],
      },
    ];
    const result = parseCrowdStrikeReport(synthetic);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].externalStatus).toBe('Reopened');
  });
});
