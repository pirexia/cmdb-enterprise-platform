/**
 * n8n-provisioning · credential builders — tests.
 */
import { CRED_NAMES, buildHeaderAuthCredential, buildSmtpCredential, buildLdapCredential } from '../credentials.js';
import type { N8nProvisioningConfig } from '../config.js';

function cfg(over: Partial<N8nProvisioningConfig>): N8nProvisioningConfig {
  return {
    apiBaseUrl: 'http://n8n-main:5678', apiKey: 'k', serviceToken: 'service-token-123',
    smtp: null, ldap: null, vcenter: null, ...over,
  };
}

describe('buildHeaderAuthCredential', () => {
  it('mapea el service token al header X-CMDB-Service-Token', () => {
    const c = buildHeaderAuthCredential(cfg({}));
    expect(c.name).toBe(CRED_NAMES.headerAuth);
    expect(c.type).toBe('httpHeaderAuth');
    expect(c.data).toEqual({ name: 'X-CMDB-Service-Token', value: 'service-token-123' });
  });
});

describe('buildSmtpCredential', () => {
  it('null cuando no hay smtp', () => {
    expect(buildSmtpCredential(cfg({ smtp: null }))).toBeNull();
  });

  it('puerto 25 (relay sin auth) → secure false, user/password vacíos', () => {
    const c = buildSmtpCredential(cfg({ smtp: { host: 'mailscan.x', port: 25, secure: true, from: 'a@x' } }))!;
    expect(c.name).toBe(CRED_NAMES.smtp);
    expect(c.type).toBe('smtp');
    expect(c.data.host).toBe('mailscan.x');
    expect(c.data.port).toBe(25);
    expect(c.data.secure).toBe(false);   // 25 fuerza STARTTLS aunque SMTP_SECURE=true
    expect(c.data.user).toBe('');
    expect(c.data.password).toBe('');
  });

  it('puerto 465 → secure true, con credenciales', () => {
    const c = buildSmtpCredential(cfg({ smtp: { host: 's', port: 465, secure: true, user: 'u', pass: 'p', from: 'a@x' } }))!;
    expect(c.data.secure).toBe(true);
    expect(c.data.user).toBe('u');
    expect(c.data.password).toBe('p');
  });

  it('puerto 587 → secure false (STARTTLS)', () => {
    const c = buildSmtpCredential(cfg({ smtp: { host: 's', port: 587, secure: true, from: 'a@x' } }))!;
    expect(c.data.secure).toBe(false);
  });
});

describe('buildLdapCredential', () => {
  it('null cuando useLdap=false', () => {
    expect(buildLdapCredential(cfg({ ldap: { useLdap: false, url: 'ldap://x:389' } }))).toBeNull();
  });

  it('ldap:// → connectionSecurity none, port 389, baseDn/bindDN mapeados', () => {
    const c = buildLdapCredential(cfg({ ldap: {
      useLdap: true, url: 'ldap://dc.example.com:389', baseDN: 'DC=example,DC=com',
      bindDN: 'CN=svc,DC=example,DC=com', bindPassword: 'secret',
    } }))!;
    expect(c.name).toBe(CRED_NAMES.ldap);
    expect(c.type).toBe('ldap');
    expect(c.data.hostname).toBe('dc.example.com');
    expect(c.data.port).toBe(389);
    expect(c.data.connectionSecurity).toBe('none');
    expect(c.data.baseDn).toBe('DC=example,DC=com');
    expect(c.data.bindDN).toBe('CN=svc,DC=example,DC=com');
    expect(c.data.bindPassword).toBe('secret');
  });

  it('ldaps:// → connectionSecurity tls, port 636', () => {
    const c = buildLdapCredential(cfg({ ldap: {
      useLdap: true, url: 'ldaps://dc.example.com:636', baseDN: 'DC=example,DC=com',
    } }))!;
    expect(c.data.connectionSecurity).toBe('tls');
    expect(c.data.port).toBe(636);
  });
});
