import { loadRedHatLightspeedConfig, isConfigured, toPublicConfig } from '../config.js';

describe('redhatLightspeed config', () => {
  const ORIGINAL_ENV = process.env;
  beforeEach(() => { process.env = { ...ORIGINAL_ENV }; });
  afterAll(() => { process.env = ORIGINAL_ENV; });

  it('defaults baseUrl and reports unconfigured when credentials are blank', () => {
    delete process.env.REDHAT_LIGHTSPEED_CLIENT_ID;
    delete process.env.REDHAT_LIGHTSPEED_CLIENT_SECRET;
    delete process.env.REDHAT_LIGHTSPEED_BASE_URL;
    const cfg = loadRedHatLightspeedConfig();
    expect(cfg.baseUrl).toBe('https://console.redhat.com');
    expect(isConfigured(cfg)).toBe(false);
  });

  it('reports configured when both credentials are set', () => {
    process.env.REDHAT_LIGHTSPEED_CLIENT_ID = 'abc';
    process.env.REDHAT_LIGHTSPEED_CLIENT_SECRET = 'secret';
    const cfg = loadRedHatLightspeedConfig();
    expect(isConfigured(cfg)).toBe(true);
  });

  it('toPublicConfig never leaks the client secret', () => {
    process.env.REDHAT_LIGHTSPEED_CLIENT_ID = 'abc';
    process.env.REDHAT_LIGHTSPEED_CLIENT_SECRET = 'super-secret';
    const cfg = loadRedHatLightspeedConfig();
    const pub = toPublicConfig(cfg);
    expect(JSON.stringify(pub)).not.toContain('super-secret');
    expect(pub).toEqual({ configured: true, baseUrl: 'https://console.redhat.com' });
  });
});
