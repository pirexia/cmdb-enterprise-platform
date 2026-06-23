/**
 * n8n-provisioning · construcción de credenciales de n8n desde la config (env).
 *
 * Nombres estables (`CRED_NAMES`) → la idempotencia casa por nombre (ver provisioner).
 * Devuelven el payload `{ name, type, data }` que consume `POST /api/v1/credentials`.
 */
import type { N8nProvisioningConfig } from './config.js';

export const CRED_NAMES = {
  headerAuth: 'CMDB Service Token',
  smtp:       'CMDB SMTP',
  ldap:       'CMDB LDAP',
} as const;

export interface HeaderAuthCredential {
  name: string; type: 'httpHeaderAuth'; data: { name: string; value: string };
}
export interface SmtpCredential {
  name: string; type: 'smtp'; data: Record<string, unknown>;
}
export interface LdapCredential {
  name: string; type: 'ldap'; data: Record<string, unknown>;
}

export function buildHeaderAuthCredential(cfg: N8nProvisioningConfig): HeaderAuthCredential {
  return {
    name: CRED_NAMES.headerAuth,
    type: 'httpHeaderAuth',
    data: { name: 'X-CMDB-Service-Token', value: cfg.serviceToken },
  };
}

export function buildSmtpCredential(cfg: N8nProvisioningConfig): SmtpCredential | null {
  if (!cfg.smtp) return null;
  const { host, port, secure, user, pass } = cfg.smtp;
  // Puertos conocidos mandan sobre SMTP_SECURE: 465 = TLS implícito; 25/587 = STARTTLS.
  const effectiveSecure = port === 465 ? true : (port === 25 || port === 587 ? false : secure);
  return {
    name: CRED_NAMES.smtp,
    type: 'smtp',
    data: {
      host,
      port,
      secure: effectiveSecure,
      user: user ?? '',
      password: pass ?? '',
      disableStartTls: false,
    },
  };
}

export function buildLdapCredential(cfg: N8nProvisioningConfig): LdapCredential | null {
  if (!cfg.ldap || !cfg.ldap.useLdap || !cfg.ldap.url) return null;
  const { url, baseDN, bindDN, bindPassword } = cfg.ldap;
  let hostname = '', port = 389, connectionSecurity: 'none' | 'tls' | 'startTls' = 'none';
  try {
    const u = new URL(url);
    hostname = u.hostname;
    const isLdaps = u.protocol === 'ldaps:';
    port = u.port ? Number(u.port) : (isLdaps ? 636 : 389);
    connectionSecurity = isLdaps ? 'tls' : 'none';
  } catch {
    hostname = url;
  }
  return {
    name: CRED_NAMES.ldap,
    type: 'ldap',
    data: {
      hostname,
      port,
      bindDN: bindDN ?? '',
      bindPassword: bindPassword ?? '',
      baseDn: baseDN ?? '',
      connectionSecurity,
      allowUnauthorizedCerts: connectionSecurity !== 'none',
    },
  };
}
