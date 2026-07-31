import type { Vulnerability } from '../types.js';

describe('Vulnerability type — Red Hat Lightspeed fields', () => {
  it('accepts a Lightspeed-sourced vulnerability shape', () => {
    const v: Vulnerability = {
      cve: 'CVE-2024-1234',
      severity: 'HIGH',
      description: 'Test',
      source: 'redhat-lightspeed',
      status: 'NUEVO',
      importedAt: new Date().toISOString(),
      key: 'CVE-2024-1234',
      redhatImpact: 'Important',
      knownExploit: true,
      publicDate: '2024-01-15T00:00:00Z',
    };
    expect(v.redhatImpact).toBe('Important');
  });
});
