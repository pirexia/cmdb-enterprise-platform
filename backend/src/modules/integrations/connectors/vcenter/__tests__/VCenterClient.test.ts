import { VCenterClient } from '../VCenterClient.js';

describe('VCenterClient', () => {
  it('constructs without throwing given a config', () => {
    expect(
      () =>
        new VCenterClient({
          url: 'https://vcenter.local',
          username: 'svc-cmdb',
          password: 'super-secret',
          rejectUnauthorized: false,
        }),
    ).not.toThrow();
  });

  it('logout() swallows a failed request (no live server, connection refused)', async () => {
    // Point at a URL with nothing listening so the underlying https.request errors out.
    const client = new VCenterClient({
      url: 'https://127.0.0.1:1',
      username: 'svc-cmdb',
      password: 'super-secret',
      rejectUnauthorized: false,
    });

    await expect(client.logout()).resolves.toBeUndefined();
  });

  it('session() rejects when the connection fails (caller must handle, unlike logout)', async () => {
    const client = new VCenterClient({
      url: 'https://127.0.0.1:1',
      username: 'svc-cmdb',
      password: 'super-secret',
      rejectUnauthorized: false,
    });

    await expect(client.session()).rejects.toBeDefined();
  });
});
