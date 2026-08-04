import { mapSystemToEntries } from '../mapper.js';
import type { LightspeedSystem, LightspeedCve } from '../vulnClient.js';
import type { HostIdentity } from '../inventoryClient.js';

describe('mapSystemToEntries', () => {
  const system: LightspeedSystem = { inventory_id: 'inv-1', display_name: 'srv-a', os: 'RHEL 9.4', cve_count: 1 };
  const identity: HostIdentity = { ip: '10.1.2.3', hostname: 'srv-a.example.com', displayName: 'srv-a', osName: 'RHEL', osMajor: 9, osMinor: 4 };

  it('maps a CVE with cvss3_score to a ParsedVulnEntry keyed by the CVE id', () => {
    const cves: LightspeedCve[] = [{
      synopsis: 'CVE-2024-1234', cvss3_score: '7.5', impact: 'Important',
      known_exploit: true, public_date: '2024-01-15T00:00:00Z', description: 'A test CVE',
    }];

    const entries = mapSystemToEntries(system, cves, identity);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      key: 'CVE-2024-1234',
      cves: ['CVE-2024-1234'],
      severityScore: 7.5,
      severity: 'HIGH',
      name: 'CVE-2024-1234',
      hostAddress: '10.1.2.3',
      redhatImpact: 'Important',
      knownExploit: true,
      publicDate: '2024-01-15T00:00:00Z',
    });
  });

  it('falls back to cvss2_score when cvss3_score is absent', () => {
    const cves: LightspeedCve[] = [{ synopsis: 'CVE-2020-0001', cvss2_score: '5.0', impact: 'Moderate', known_exploit: false }];
    const entries = mapSystemToEntries(system, cves, identity);
    expect(entries[0].severityScore).toBe(5.0);
    expect(entries[0].severity).toBe('MEDIUM');
  });

  it('falls back to the display name for hostAddress when the host has no IP', () => {
    const noIpIdentity: HostIdentity = { ...identity, ip: null };
    const cves: LightspeedCve[] = [{ synopsis: 'CVE-2020-0002', cvss3_score: '2.0', impact: 'Low', known_exploit: false }];
    const entries = mapSystemToEntries(system, cves, noIpIdentity);
    expect(entries[0].hostAddress).toBe('srv-a.example.com');
  });

  it('skips a CVE with neither cvss3_score nor cvss2_score, without aborting the rest of the pull', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const cves: LightspeedCve[] = [
      { synopsis: 'CVE-2020-0003', impact: 'Low', known_exploit: false },
      { synopsis: 'CVE-2020-0004', cvss3_score: '4.0', impact: 'Moderate', known_exploit: false },
    ];
    const entries = mapSystemToEntries(system, cves, identity);
    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe('CVE-2020-0004');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('CVE-2020-0003'));
    warnSpy.mockRestore();
  });
});
