import type { RedHatLightspeedConfig } from './config.js';

// Red Hat SSO service-account token endpoint is fixed and NOT derived from
// REDHAT_LIGHTSPEED_BASE_URL — sso.redhat.com is a separate, single, public
// host across all Red Hat Hybrid Cloud Console regions (never caller-
// supplied, per A10 SSRF constraint).
const TOKEN_URL = 'https://sso.redhat.com/auth/realms/redhat-external/protocol/openid-connect/token';

// Every outbound Red Hat call in this connector gets a hard timeout — an
// unauthenticated live-pull hitting a third-party host must never be able to
// hang the in-process import lock indefinitely (finding from the final
// branch review: without this, one stalled connection pins the lock until a
// backend restart).
const FETCH_TIMEOUT_MS = 15_000;

export class TokenFetchError extends Error {
  constructor(status: number) {
    super(`Red Hat SSO token request failed with status ${status}`);
    this.name = 'TokenFetchError';
  }
}

/** Fetches a short-lived Bearer token via OAuth2 client_credentials. Never
 *  caches to disk; callers hold it in-process for the duration of one
 *  import run only (see redhatLightspeedService.ts, Task 9). */
export async function fetchAccessToken(cfg: RedHatLightspeedConfig): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    scope: 'api.console',
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new TokenFetchError(res.status);
  }

  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}
