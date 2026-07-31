import { listSystems, listSystemCves } from '../vulnClient.js';

describe('vulnClient', () => {
  const baseUrl = 'https://console.redhat.com';
  const token = 'tok-123';

  afterEach(() => { jest.restoreAllMocks(); });

  it('listSystems calls /api/vulnerability/v1/systems with the Bearer token and paginates until a short page', async () => {
    const page1 = { data: [{ inventory_id: 'a', display_name: 'srv-a', os: 'RHEL 9.4', cve_count: 3 }] };
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => page1 });
    global.fetch = fetchMock as unknown as typeof fetch;

    const systems = await listSystems(baseUrl, token);

    expect(systems).toHaveLength(1);
    expect(systems[0].inventory_id).toBe('a');
    const [url, opts] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/vulnerability/v1/systems');
    expect((opts as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok-123' });
  });

  it('listSystemCves calls /systems/{id}/cves and returns the cve list', async () => {
    const page = { data: [{ synopsis: 'CVE-2024-1234', cvss3_score: '7.5', impact: 'Important', known_exploit: true, public_date: '2024-01-15T00:00:00Z', description: 'desc' }] };
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => page }) as unknown as typeof fetch;

    const cves = await listSystemCves(baseUrl, token, 'a');

    expect(cves).toHaveLength(1);
    expect(cves[0].synopsis).toBe('CVE-2024-1234');
  });

  it('throws when the API returns a non-OK response', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch;
    await expect(listSystems(baseUrl, token)).rejects.toThrow('Red Hat Insights Vulnerability API request failed: 500');
  });
});
