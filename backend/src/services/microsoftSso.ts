/**
 * Microsoft SSO Service
 *
 * Implements OAuth 2.0 Authorization Code Flow with PKCE for Azure AD / Entra ID.
 * Handles:
 *  - Authorization URL generation (single-tenant, PKCE, state, nonce)
 *  - Code → token exchange with Azure AD
 *  - ID token validation (JWKS signature, iss, aud, tid, nonce, domain)
 *  - JWKS key caching (24h TTL)
 *
 * Security:
 *  - Single-tenant endpoint locks auth to AZURE_TENANT_ID only
 *  - tid claim validated against AZURE_TENANT_ID (defense in depth)
 *  - Email domain validated against AZURE_ALLOWED_DOMAIN
 *  - nonce prevents ID token replay attacks
 *  - PKCE (S256) protects code exchange even without client_secret
 */

import crypto from 'crypto';
import https from 'https';
import jwt from 'jsonwebtoken';

// ─── Config ──────────────────────────────────────────────────────────────────

export const SSO_ENABLED        = process.env.USE_MICROSOFT_SSO === 'true';
const TENANT_ID                 = process.env.AZURE_TENANT_ID   ?? '';
const CLIENT_ID                 = process.env.AZURE_CLIENT_ID   ?? '';
const CLIENT_SECRET             = process.env.AZURE_CLIENT_SECRET ?? '';
const REDIRECT_URI              = process.env.AZURE_REDIRECT_URI ?? '';
export const ALLOWED_DOMAIN     = process.env.AZURE_ALLOWED_DOMAIN ?? '';
export const AUTO_PROVISION     = process.env.AZURE_AUTO_PROVISION !== 'false'; // default true
export const FRONTEND_URL       = process.env.FRONTEND_URL ?? 'http://localhost:3001';

const AUTHORITY_BASE    = `https://login.microsoftonline.com/${TENANT_ID}`;
const AUTHORIZE_URL     = `${AUTHORITY_BASE}/oauth2/v2.0/authorize`;
const TOKEN_URL         = `${AUTHORITY_BASE}/oauth2/v2.0/token`;
const JWKS_URL          = `${AUTHORITY_BASE}/discovery/v2.0/keys`;

// Token issuer — Azure AD v2.0 uses this format
const EXPECTED_ISSUER   = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;

// ─── JWKS cache ──────────────────────────────────────────────────────────────

interface JwksKey {
  kid: string;
  kty: string;
  use: string;
  n: string;
  e: string;
  x5c?: string[];
}

let jwksCache: { keys: JwksKey[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Fetches JWKS keys from Microsoft (cached 24h).
 * Returns raw key objects — callers use findJwksKey() to get a specific key.
 */
async function getJwksKeys(): Promise<JwksKey[]> {
  const now = Date.now();
  if (jwksCache && now - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }

  const body = await httpsGet(JWKS_URL);
  const parsed = JSON.parse(body) as { keys: JwksKey[] };
  jwksCache = { keys: parsed.keys, fetchedAt: now };
  return parsed.keys;
}

/**
 * Returns the RSA public key PEM for a given kid.
 * Throws if key not found (forces re-fetch once on cache miss).
 */
async function getPublicKeyForKid(kid: string, retry = true): Promise<string> {
  let keys = await getJwksKeys();
  let key  = keys.find((k) => k.kid === kid);

  // Key not in cache — force refresh once (Azure rotates keys)
  if (!key && retry) {
    jwksCache = null;
    keys = await getJwksKeys();
    key  = keys.find((k) => k.kid === kid);
  }

  if (!key) throw new Error(`JWKS key not found for kid=${kid}`);

  // RFC 7517 §4.2: only keys designated for signing may verify signatures
  if (key.use !== 'sig') {
    throw new Error(`JWKS key kid=${kid} is not a signing key (use=${key.use})`);
  }

  // Build PEM from n/e (RSA public key) or x5c (certificate chain)
  if (key.x5c && key.x5c.length > 0) {
    const cert = key.x5c[0];
    return `-----BEGIN CERTIFICATE-----\n${cert.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----`;
  }

  // Fallback: reconstruct RSA key from n and e
  const keyObj = crypto.createPublicKey({
    key: { kty: 'RSA', n: key.n, e: key.e },
    format: 'jwk',
  });
  return keyObj.export({ format: 'pem', type: 'spki' }) as string;
}

// ─── PKCE helpers ─────────────────────────────────────────────────────────────

export function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// ─── Auth URL ─────────────────────────────────────────────────────────────────

/**
 * Builds the Azure AD authorization URL.
 * Uses single-tenant endpoint to restrict access to the configured tenant.
 *
 * @param state   CSRF token (UUID v4 stored server-side)
 * @param nonce   Replay-protection token stored server-side
 * @param codeChallenge  PKCE S256 challenge
 */
export function buildAuthorizationUrl(state: string, nonce: string, codeChallenge: string): string {
  const params = new URLSearchParams({
    client_id:             CLIENT_ID,
    response_type:         'code',
    redirect_uri:          REDIRECT_URI,
    response_mode:         'query',
    scope:                 'openid profile email User.Read',
    state,
    nonce,
    code_challenge:        codeChallenge,
    code_challenge_method: 'S256',
    // Hint the tenant — prevents cross-tenant login UI confusion
    domain_hint:           ALLOWED_DOMAIN || '',
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

// ─── Token exchange ───────────────────────────────────────────────────────────

interface TokenResponse {
  access_token:  string;
  id_token:      string;
  token_type:    string;
  expires_in:    number;
  scope:         string;
}

/**
 * Exchanges an authorization code for tokens.
 * Includes PKCE code_verifier to complete the PKCE flow.
 */
export async function exchangeCodeForTokens(code: string, codeVerifier: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    redirect_uri:  REDIRECT_URI,
    grant_type:    'authorization_code',
    code_verifier: codeVerifier,
  });

  const responseText = await httpsPost(TOKEN_URL, body.toString(), 'application/x-www-form-urlencoded');
  const data = JSON.parse(responseText) as TokenResponse & { error?: string; error_description?: string };

  if ('error' in data) {
    throw new Error(`Token exchange failed: ${data.error} — ${data.error_description ?? ''}`);
  }

  return data;
}

// ─── ID token validation ──────────────────────────────────────────────────────

export interface MicrosoftClaims {
  oid:                  string;  // Azure AD Object ID — unique, immutable
  email?:               string;
  preferred_username?:  string;
  upn?:                 string;  // User Principal Name (email in many tenants)
  name?:                string;
  tid:                  string;  // Tenant ID — must match AZURE_TENANT_ID
  iss:                  string;
  aud:                  string;
  nonce:                string;
  exp:                  number;
  iat:                  number;
}

/**
 * Validates an Azure AD v2.0 ID token:
 * 1. Decodes header to get `kid`
 * 2. Fetches the matching public key from JWKS
 * 3. Verifies JWT signature, exp, iss, aud
 * 4. Validates tid, nonce, and email domain
 *
 * Throws on any validation failure — callers must treat all errors as auth failures.
 */
export async function validateIdToken(idToken: string, expectedNonce: string): Promise<MicrosoftClaims> {
  // Decode header without verification to get kid
  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded || typeof decoded === 'string' || !decoded.header.kid) {
    throw new Error('Invalid ID token structure');
  }

  const kid = decoded.header.kid as string;
  const publicKey = await getPublicKeyForKid(kid);

  // Verify signature + standard claims
  let claims: MicrosoftClaims;
  try {
    claims = jwt.verify(idToken, publicKey, {
      algorithms: ['RS256'],
      issuer:     EXPECTED_ISSUER,
      audience:   CLIENT_ID,
    }) as MicrosoftClaims;
  } catch (err) {
    throw new Error(`ID token verification failed: ${(err as Error).message}`);
  }

  // Validate tenant ID (defense in depth — prevents cross-tenant even if issuer matches)
  if (claims.tid !== TENANT_ID) {
    throw new Error(`ID token tid mismatch: expected ${TENANT_ID}, got ${claims.tid}`);
  }

  // Validate nonce (replay protection)
  if (claims.nonce !== expectedNonce) {
    throw new Error('ID token nonce mismatch — possible replay attack');
  }

  // Resolve email: Azure AD may send it in different claims depending on tenant config
  const resolvedEmail = claims.email ?? claims.preferred_username ?? claims.upn ?? '';

  // Validate email domain (corporate tenant restriction — defense in depth)
  if (ALLOWED_DOMAIN) {
    const domain = resolvedEmail.split('@')[1]?.toLowerCase() ?? '';
    if (domain !== ALLOWED_DOMAIN.toLowerCase()) {
      throw new Error(`Email domain '${domain}' not allowed. Expected '${ALLOWED_DOMAIN}'`);
    }
  }

  // Normalize email into standard claim for downstream use
  claims.email = resolvedEmail.toLowerCase();

  return claims;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function httpsGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => resolve(body));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function httpsPost(url: string, body: string, contentType: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method:   'POST',
      headers:  {
        'Content-Type':   contentType,
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk: Buffer) => { responseBody += chunk.toString(); });
      res.on('end', () => resolve(responseBody));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
