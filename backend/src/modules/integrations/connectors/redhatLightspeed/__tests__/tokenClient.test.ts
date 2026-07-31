import { fetchAccessToken, TokenFetchError } from '../tokenClient.js';

describe('fetchAccessToken', () => {
  const cfg = { clientId: 'id', clientSecret: 'secret', baseUrl: 'https://console.redhat.com' };

  afterEach(() => { jest.restoreAllMocks(); });

  it('POSTs client_credentials to the Red Hat SSO token endpoint and returns the access token', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'tok-123', expires_in: 300 }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const token = await fetchAccessToken(cfg);

    expect(token).toBe('tok-123');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://sso.redhat.com/auth/realms/redhat-external/protocol/openid-connect/token',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = String(fetchMock.mock.calls[0][1].body);
    expect(body).toContain('grant_type=client_credentials');
    expect(body).toContain('client_id=id');
    expect(body).toContain('client_secret=secret');
  });

  it('throws TokenFetchError on a non-OK response, without leaking the client secret', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'invalid_client' }) as unknown as typeof fetch;
    await expect(fetchAccessToken(cfg)).rejects.toThrow(TokenFetchError);
    try {
      await fetchAccessToken(cfg);
    } catch (err) {
      expect(String((err as Error).message)).not.toContain('secret');
    }
  });
});
