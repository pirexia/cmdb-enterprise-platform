import { getRhelLifecycleDates } from '../lifecycleClient.js';

describe('lifecycleClient.getRhelLifecycleDates', () => {
  afterEach(() => { jest.restoreAllMocks(); });

  it('maps "Full support" end to eosDate and "Maintenance support" end to eolDate for the matching major version', async () => {
    const body = {
      data: [{
        name: 'Red Hat Enterprise Linux',
        versions: [
          {
            name: '9',
            phases: [
              { name: 'Full support', start_date: '2022-05-18', end_date: '2027-05-31' },
              { name: 'Maintenance support', start_date: '2027-05-31', end_date: '2032-05-31' },
            ],
          },
          {
            name: '8',
            phases: [
              { name: 'Full support', start_date: '2019-05-07', end_date: '2024-05-31' },
              { name: 'Maintenance support', start_date: '2024-05-31', end_date: '2029-05-31' },
            ],
          },
        ],
      }],
    };
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => body }) as unknown as typeof fetch;

    const dates = await getRhelLifecycleDates(9);

    expect(dates.eosDate?.toISOString().slice(0, 10)).toBe('2027-05-31');
    expect(dates.eolDate?.toISOString().slice(0, 10)).toBe('2032-05-31');
  });

  it('returns nulls when the major version is not found', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ name: 'Red Hat Enterprise Linux', versions: [] }] }) }) as unknown as typeof fetch;
    const dates = await getRhelLifecycleDates(99);
    expect(dates.eosDate).toBeNull();
    expect(dates.eolDate).toBeNull();
  });

  it('throws when the API returns a non-OK response', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch;
    await expect(getRhelLifecycleDates(9)).rejects.toThrow('Red Hat Product Life Cycle API request failed: 503');
  });
});
