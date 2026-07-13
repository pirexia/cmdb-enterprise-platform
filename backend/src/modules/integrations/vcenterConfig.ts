// vCenter integration configuration — reads process.env, applies defaults, and
// exposes a "public" (secret-free) view suitable for surfacing in the settings UI.
// Never log or return `password`/`username` from toPublicConfig().

export interface VCenterConfig {
  url: string;
  username: string;
  password: string;
  sslVerify: boolean;
  caCertPath?: string;
  syncEnabled: boolean;
  ciTypeCode: string;
  defaultEnvironment: string;
  defaultCriticality: string;
}

export function loadVCenterConfig(): VCenterConfig {
  return {
    url: process.env.VCENTER_URL || '',
    username: process.env.VCENTER_USER || '',
    password: process.env.VCENTER_PASSWORD || '',
    sslVerify: process.env.VCENTER_SSL_VERIFY === 'true',
    caCertPath: process.env.VCENTER_CA_CERT || undefined,
    syncEnabled: process.env.VCENTER_SYNC_ENABLED === 'true',
    ciTypeCode: process.env.VCENTER_CI_TYPE || 'VIRTUAL_SERVER',
    defaultEnvironment: process.env.VCENTER_DEFAULT_ENVIRONMENT || 'PRODUCTION',
    defaultCriticality: process.env.VCENTER_DEFAULT_CRITICALITY || 'MEDIUM',
  };
}

export function isConfigured(cfg: VCenterConfig): boolean {
  return Boolean(cfg.url && cfg.username && cfg.password);
}

export function toPublicConfig(cfg: VCenterConfig): {
  configured: boolean;
  host: string | null;
  sslVerify: boolean;
  syncEnabled: boolean;
} {
  let host: string | null = null;
  if (cfg.url) {
    try {
      host = new URL(cfg.url).host;
    } catch {
      host = null;
    }
  }

  return {
    configured: isConfigured(cfg),
    host,
    sslVerify: cfg.sslVerify,
    syncEnabled: cfg.syncEnabled,
  };
}
