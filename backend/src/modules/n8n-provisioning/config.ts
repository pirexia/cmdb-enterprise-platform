/**
 * n8n-provisioning · config loader.
 *
 * Lee desde `process.env` (a call-time, para que un reinicio del backend con un
 * `.env` editado tome los nuevos valores) la configuración necesaria para
 * aprovisionar credenciales y workflows en n8n. `.env` es la única fuente de verdad.
 *
 * No tiene efectos secundarios ni dependencias de red/BD: solo transforma env → objeto.
 */

export interface N8nProvisioningSmtp {
  host?: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

export interface N8nProvisioningLdap {
  url?: string;
  baseDN?: string;
  bindDN?: string;
  bindPassword?: string;
  groupDN?: string;
  syncDomain?: string;
  useLdap: boolean;
}

export interface N8nProvisioningVCenter {
  enabled: boolean;
  cron:    string;
}

export interface N8nProvisioningConfig {
  /** Base URL interna de la API de n8n (red `cmdb-internal`). */
  apiBaseUrl: string;
  /** API key pública de n8n; `null` deshabilita el aprovisionamiento. */
  apiKey: string | null;
  /** Token M2M (`X-CMDB-Service-Token`) que comparten backend y workflows. */
  serviceToken: string;
  /** SMTP para la credencial del nodo Send Email; `null` si no hay SMTP_HOST. */
  smtp: N8nProvisioningSmtp | null;
  /** LDAP para la credencial del nodo LDAP Search; `null` si no aplica. */
  ldap: N8nProvisioningLdap | null;
  /** Workflow "vCenter Sync"; `null` cuando VCENTER_SYNC_ENABLED !== 'true'. */
  vcenter: N8nProvisioningVCenter | null;
}

/** Devuelve `undefined` si la variable está ausente o vacía; el valor en otro caso. */
function envOrUndef(key: string): string | undefined {
  const v = process.env[key];
  return v === undefined || v === '' ? undefined : v;
}

export function loadN8nProvisioningConfig(): N8nProvisioningConfig {
  const smtpHost = envOrUndef('SMTP_HOST');
  const smtp: N8nProvisioningSmtp | null = smtpHost
    ? {
        host:   smtpHost,
        port:   Number(process.env.SMTP_PORT ?? '587'),
        secure: process.env.SMTP_SECURE === 'true',
        user:   envOrUndef('SMTP_USER'),
        pass:   envOrUndef('SMTP_PASS'),
        from:   process.env.ALERT_FROM_EMAIL ?? 'cmdb-alerts@noreply.local',
      }
    : null;

  const useLdap  = process.env.USE_LDAP === 'true';
  const ldapUrl  = envOrUndef('LDAP_URL');
  const ldap: N8nProvisioningLdap | null = (useLdap || ldapUrl)
    ? {
        url:          ldapUrl,
        baseDN:       envOrUndef('LDAP_BASE_DN') ?? envOrUndef('LDAP_SEARCH_BASE'),
        bindDN:       envOrUndef('LDAP_BIND_DN'),
        bindPassword: envOrUndef('LDAP_BIND_PASSWORD'),
        groupDN:      envOrUndef('LDAP_SYNC_GROUP_DN'),
        syncDomain:   envOrUndef('LDAP_SYNC_DOMAIN'),
        useLdap,
      }
    : null;

  const vcenterEnabled = process.env.VCENTER_SYNC_ENABLED === 'true';
  const vcenter: N8nProvisioningVCenter | null = vcenterEnabled
    ? { enabled: true, cron: process.env.VCENTER_SYNC_CRON ?? '0 */6 * * *' }
    : null;

  return {
    apiBaseUrl:   process.env.N8N_INTERNAL_URL ?? 'http://n8n-main:5678',
    apiKey:       envOrUndef('N8N_API_KEY') ?? null,
    serviceToken: process.env.CMDB_SERVICE_TOKEN ?? '',
    smtp,
    ldap,
    vcenter,
  };
}
