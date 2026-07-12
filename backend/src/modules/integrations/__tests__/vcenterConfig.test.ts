import { loadVCenterConfig, isConfigured, toPublicConfig } from '../vcenterConfig.js';

const VCENTER_ENV_KEYS = [
  'VCENTER_URL',
  'VCENTER_USER',
  'VCENTER_PASSWORD',
  'VCENTER_SSL_VERIFY',
  'VCENTER_CA_CERT',
  'VCENTER_SYNC_ENABLED',
  'VCENTER_CI_TYPE',
  'VCENTER_DEFAULT_ENVIRONMENT',
  'VCENTER_DEFAULT_CRITICALITY',
];

describe('vcenterConfig', () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of VCENTER_ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of VCENTER_ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  it('all env vars unset → defaults applied and not configured', () => {
    const cfg = loadVCenterConfig();
    expect(cfg).toEqual({
      url: '',
      username: '',
      password: '',
      sslVerify: false,
      caCertPath: undefined,
      syncEnabled: false,
      ciTypeCode: 'VIRTUAL_SERVER',
      defaultEnvironment: 'PRODUCTION',
      defaultCriticality: 'MEDIUM',
    });
    expect(isConfigured(cfg)).toBe(false);
  });

  it('fully set env vars → configured, values reflected', () => {
    process.env.VCENTER_URL = 'https://vcenter.local';
    process.env.VCENTER_USER = 'svc-cmdb';
    process.env.VCENTER_PASSWORD = 'super-secret';
    process.env.VCENTER_SSL_VERIFY = 'true';
    process.env.VCENTER_CA_CERT = '/certs/vcenter-ca.pem';
    process.env.VCENTER_SYNC_ENABLED = 'true';
    process.env.VCENTER_CI_TYPE = 'VIRTUAL_SERVER';
    process.env.VCENTER_DEFAULT_ENVIRONMENT = 'PRODUCTION';
    process.env.VCENTER_DEFAULT_CRITICALITY = 'HIGH';

    const cfg = loadVCenterConfig();
    expect(cfg.url).toBe('https://vcenter.local');
    expect(cfg.username).toBe('svc-cmdb');
    expect(cfg.password).toBe('super-secret');
    expect(cfg.sslVerify).toBe(true);
    expect(cfg.caCertPath).toBe('/certs/vcenter-ca.pem');
    expect(cfg.syncEnabled).toBe(true);
    expect(cfg.defaultCriticality).toBe('HIGH');
    expect(isConfigured(cfg)).toBe(true);
  });

  it('toPublicConfig() never exposes username/password keys', () => {
    process.env.VCENTER_URL = 'https://vcenter.local:9443';
    process.env.VCENTER_USER = 'svc-cmdb';
    process.env.VCENTER_PASSWORD = 'super-secret';

    const cfg = loadVCenterConfig();
    const pub = toPublicConfig(cfg);

    expect(Object.keys(pub).sort()).toEqual(['configured', 'host', 'sslVerify', 'syncEnabled']);
    expect(pub).not.toHaveProperty('username');
    expect(pub).not.toHaveProperty('password');
    expect(pub.host).toBe('vcenter.local:9443');
    expect(pub.configured).toBe(true);
  });

  it('toPublicConfig() handles empty/malformed url without throwing', () => {
    const cfgEmpty = loadVCenterConfig();
    expect(() => toPublicConfig(cfgEmpty)).not.toThrow();
    expect(toPublicConfig(cfgEmpty).host).toBeNull();

    const malformed = { ...loadVCenterConfig(), url: 'not-a-url' };
    expect(() => toPublicConfig(malformed)).not.toThrow();
    expect(toPublicConfig(malformed).host).toBeNull();
  });
});
