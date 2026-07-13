/**
 * n8n-provisioning · config loader — tests (pura lectura de process.env).
 */
import { loadN8nProvisioningConfig } from '../config.js';

const PROV_KEYS = [
  'N8N_INTERNAL_URL', 'N8N_API_KEY', 'CMDB_SERVICE_TOKEN',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'ALERT_FROM_EMAIL',
  'USE_LDAP', 'LDAP_URL', 'LDAP_BASE_DN', 'LDAP_BIND_DN', 'LDAP_BIND_PASSWORD',
  'LDAP_SYNC_GROUP_DN', 'LDAP_SYNC_DOMAIN',
  'VCENTER_SYNC_ENABLED', 'VCENTER_SYNC_CRON',
];

const SAVED: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of PROV_KEYS) { SAVED[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of PROV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

describe('loadN8nProvisioningConfig', () => {
  it('apiBaseUrl: default cuando N8N_INTERNAL_URL ausente', () => {
    expect(loadN8nProvisioningConfig().apiBaseUrl).toBe('http://n8n-main:5678');
  });

  it('apiBaseUrl: respeta N8N_INTERNAL_URL', () => {
    process.env.N8N_INTERNAL_URL = 'http://cmdb-n8n-main:5678';
    expect(loadN8nProvisioningConfig().apiBaseUrl).toBe('http://cmdb-n8n-main:5678');
  });

  it('apiKey: null cuando N8N_API_KEY ausente o vacío', () => {
    expect(loadN8nProvisioningConfig().apiKey).toBeNull();
    process.env.N8N_API_KEY = '';
    expect(loadN8nProvisioningConfig().apiKey).toBeNull();
  });

  it('apiKey: el valor cuando está definido', () => {
    process.env.N8N_API_KEY = 'eyJhbGc.token';
    expect(loadN8nProvisioningConfig().apiKey).toBe('eyJhbGc.token');
  });

  it('smtp: null cuando no hay SMTP_HOST', () => {
    expect(loadN8nProvisioningConfig().smtp).toBeNull();
  });

  it('smtp: relay sin auth (SMTP_USER vacío) → host set, user/pass undefined, from de ALERT_FROM_EMAIL', () => {
    process.env.SMTP_HOST = 'mailscan.example.com';
    process.env.SMTP_PORT = '25';
    process.env.SMTP_USER = '';
    process.env.ALERT_FROM_EMAIL = 'cmdb-alerts@example.com';
    const smtp = loadN8nProvisioningConfig().smtp!;
    expect(smtp.host).toBe('mailscan.example.com');
    expect(smtp.port).toBe(25);
    expect(smtp.user).toBeUndefined();
    expect(smtp.pass).toBeUndefined();
    expect(smtp.secure).toBe(false);
    expect(smtp.from).toBe('cmdb-alerts@example.com');
  });

  it('smtp: port default 587 y secure derivado de SMTP_SECURE', () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_SECURE = 'true';
    const smtp = loadN8nProvisioningConfig().smtp!;
    expect(smtp.port).toBe(587);
    expect(smtp.secure).toBe(true);
  });

  it('ldap: null cuando USE_LDAP!=true y sin LDAP_URL', () => {
    expect(loadN8nProvisioningConfig().ldap).toBeNull();
  });

  it('ldap: objeto con useLdap + campos cuando USE_LDAP=true', () => {
    process.env.USE_LDAP = 'true';
    process.env.LDAP_URL = 'ldap://dc.example.com:389';
    process.env.LDAP_BASE_DN = 'DC=example,DC=com';
    process.env.LDAP_BIND_DN = 'CN=svc,DC=example,DC=com';
    process.env.LDAP_BIND_PASSWORD = 'secret';
    process.env.LDAP_SYNC_GROUP_DN = 'CN=CMDB-Users,DC=example,DC=com';
    process.env.LDAP_SYNC_DOMAIN = 'example.com';
    const ldap = loadN8nProvisioningConfig().ldap!;
    expect(ldap.useLdap).toBe(true);
    expect(ldap.url).toBe('ldap://dc.example.com:389');
    expect(ldap.baseDN).toBe('DC=example,DC=com');
    expect(ldap.bindDN).toBe('CN=svc,DC=example,DC=com');
    expect(ldap.bindPassword).toBe('secret');
    expect(ldap.groupDN).toBe('CN=CMDB-Users,DC=example,DC=com');
    expect(ldap.syncDomain).toBe('example.com');
  });

  it('serviceToken: refleja CMDB_SERVICE_TOKEN', () => {
    process.env.CMDB_SERVICE_TOKEN = 'a'.repeat(32);
    expect(loadN8nProvisioningConfig().serviceToken).toBe('a'.repeat(32));
  });

  it('vcenter: null cuando VCENTER_SYNC_ENABLED ausente o != "true"', () => {
    expect(loadN8nProvisioningConfig().vcenter).toBeNull();
    process.env.VCENTER_SYNC_ENABLED = 'false';
    expect(loadN8nProvisioningConfig().vcenter).toBeNull();
  });

  it('vcenter: objeto con cron por defecto cuando VCENTER_SYNC_ENABLED=true y sin VCENTER_SYNC_CRON', () => {
    process.env.VCENTER_SYNC_ENABLED = 'true';
    const vcenter = loadN8nProvisioningConfig().vcenter!;
    expect(vcenter.enabled).toBe(true);
    expect(vcenter.cron).toBe('0 */6 * * *');
  });

  it('vcenter: respeta VCENTER_SYNC_CRON cuando está definido', () => {
    process.env.VCENTER_SYNC_ENABLED = 'true';
    process.env.VCENTER_SYNC_CRON = '0 2 * * *';
    const vcenter = loadN8nProvisioningConfig().vcenter!;
    expect(vcenter.cron).toBe('0 2 * * *');
  });
});
