import { getHostIdentity } from '../inventoryClient.js';

describe('inventoryClient.getHostIdentity', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it('fetches host details and the system_profile OS fields, returning a flat identity', async () => {
    const hostRes = { results: [{ fqdn: 'srv-a.example.com', ip_addresses: ['10.1.2.3'], display_name: 'srv-a' }] };
    const profileRes = { results: [{ system_profile: { operating_system: { name: 'RHEL', major: 9, minor: 4 } } }] };
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => hostRes })
      .mockResolvedValueOnce({ ok: true, json: async () => profileRes });
    global.fetch = fetchMock as unknown as typeof fetch;

    const identity = await getHostIdentity('https://console.redhat.com', 'tok', 'inv-1');

    expect(identity).toEqual({
      ip: '10.1.2.3',
      hostname: 'srv-a.example.com',
      displayName: 'srv-a',
      osName: 'RHEL',
      osMajor: 9,
      osMinor: 4,
    });
  });

  it('returns null OS fields when system_profile has no operating_system block', async () => {
    const hostRes = { results: [{ fqdn: 'srv-b', ip_addresses: [], display_name: 'srv-b' }] };
    const profileRes = { results: [{ system_profile: {} }] };
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => hostRes })
      .mockResolvedValueOnce({ ok: true, json: async () => profileRes }) as unknown as typeof fetch;

    const identity = await getHostIdentity('https://console.redhat.com', 'tok', 'inv-2');

    expect(identity.osName).toBeNull();
    expect(identity.ip).toBeNull();
  });

  it('throws when the inventory API returns no results', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [] }) }) as unknown as typeof fetch;
    await expect(getHostIdentity('https://console.redhat.com', 'tok', 'inv-3')).rejects.toThrow('no results');
  });
});
