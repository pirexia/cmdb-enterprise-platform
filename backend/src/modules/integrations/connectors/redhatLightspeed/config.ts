// Red Hat Lightspeed connector configuration — reads process.env, applies
// defaults, exposes a secret-free public view. Mirrors vcenterConfig.ts's
// pattern (D1: env vars only, no DB config table, no crypto module).
// Never log or return client_secret from toPublicConfig().

export interface RedHatLightspeedConfig {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
}

export function loadRedHatLightspeedConfig(): RedHatLightspeedConfig {
  return {
    clientId: process.env.REDHAT_LIGHTSPEED_CLIENT_ID || '',
    clientSecret: process.env.REDHAT_LIGHTSPEED_CLIENT_SECRET || '',
    baseUrl: process.env.REDHAT_LIGHTSPEED_BASE_URL || 'https://console.redhat.com',
  };
}

export function isConfigured(cfg: RedHatLightspeedConfig): boolean {
  return Boolean(cfg.clientId && cfg.clientSecret);
}

export function toPublicConfig(cfg: RedHatLightspeedConfig): { configured: boolean; baseUrl: string } {
  return { configured: isConfigured(cfg), baseUrl: cfg.baseUrl };
}
