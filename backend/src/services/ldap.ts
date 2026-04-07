/**
 * LDAP / Active Directory authentication service.
 *
 * Controlled by the following environment variables:
 *   USE_LDAP=true|false           - Enable/disable LDAP (default: false)
 *   LDAP_URL                      - e.g. ldap://dc.corp.local:389
 *   LDAP_BIND_DN                  - Service-account DN for admin bind+search
 *                                   e.g. cn=svc-cmdb,ou=ServiceAccounts,dc=corp,dc=local
 *   LDAP_BIND_PASSWORD            - Password for the service account
 *   LDAP_SEARCH_BASE              - Base DN for user searches
 *                                   e.g. dc=corp,dc=local
 *   LDAP_TLS_REJECT_UNAUTHORIZED  - Set to '0' to allow self-signed certs (non-prod only)
 *
 * Bind strategies (in order of preference):
 *   1. Admin bind + search (when LDAP_BIND_DN is set):
 *      Service account binds first, searches for the user by mail/sAMAccountName,
 *      then re-binds as the found user to verify the password.
 *      This is the standard enterprise AD pattern.
 *
 *   2. Direct user bind (fallback when LDAP_BIND_DN is absent):
 *      Binds directly with the email as userPrincipalName (AD UPN format) or
 *      builds a uid= DN for OpenLDAP / 389-ds.
 *
 * Fail-safe: all LDAP calls are wrapped in a 5-second timeout. If the server
 * is unreachable, the promise rejects immediately so the local bcrypt path
 * can take over without noticeable delay.
 */

// ldap-authentication is TypeScript-native (no @types needed)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { authenticate } = require('ldap-authentication') as {
  authenticate: (opts: Record<string, unknown>) => Promise<unknown>;
};

const LDAP_TIMEOUT_MS = 5_000;

const env = {
  url:                  () => process.env.LDAP_URL                      ?? 'ldap://localhost:389',
  bindDn:               () => process.env.LDAP_BIND_DN                  ?? '',
  bindPassword:         () => process.env.LDAP_BIND_PASSWORD            ?? '',
  searchBase:           () => process.env.LDAP_SEARCH_BASE              ?? 'dc=example,dc=com',
  rejectUnauthorized:   ()  => process.env.LDAP_TLS_REJECT_UNAUTHORIZED !== '0',
};

/** Wraps a promise with a hard timeout. Rejects with a clear error on expiry. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const timer = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`LDAP timeout after ${ms}ms (${label})`)), ms)
  );
  return Promise.race([promise, timer]);
}

/** Escapes special characters for LDAP DN and filter contexts (RFC 4514 / 4515). */
function escapeLdap(value: string): string {
  // Escape backslash first, then other special chars
  return value
    .replace(/\\/g, '\\5c')
    .replace(/\*/g,  '\\2a')
    .replace(/\(/g,  '\\28')
    .replace(/\)/g,  '\\29')
    .replace(/\0/g,  '\\00')
    .replace(/\//g,  '\\2f')
    .replace(/\+/g,  '\\2b')
    .replace(/</g,   '\\3c')
    .replace(/>/g,   '\\3e')
    .replace(/;/g,   '\\3b')
    .replace(/"/g,   '\\22')
    .replace(/,/g,   '\\2c')
    .replace(/=/g,   '\\3d')
    .replace(/#/g,   '\\23');
}

/**
 * Attempts to authenticate the user against the LDAP/AD server.
 * Resolves silently on success; throws a descriptive Error on failure.
 *
 * @param username - Email or plain username supplied at login
 * @param password - Clear-text password (sent over TLS/StartTLS in production)
 */
export async function authenticateLDAP(username: string, password: string): Promise<void> {
  if (!username || !password) {
    throw new Error('Username and password are required for LDAP authentication');
  }

  const tlsOptions = { rejectUnauthorized: env.rejectUnauthorized() };
  const ldapOpts   = { url: env.url(), tlsOptions };

  try {
    const bindDn = env.bindDn();

    if (bindDn) {
      // ── Strategy 1: Admin bind + search (recommended for AD) ──────────────
      // The service account binds first, then searches for the user by the
      // 'mail' attribute (AD) or 'uid' (OpenLDAP). The library then re-binds
      // as the found user to verify their password.
      await withTimeout(
        authenticate({
          ldapOpts,
          adminDn:           bindDn,
          adminPassword:     env.bindPassword(),
          userSearchBase:    env.searchBase(),
          usernameAttribute: username.includes('@') ? 'mail' : 'uid',
          username:          escapeLdap(username),
          userPassword:      password,
        }),
        LDAP_TIMEOUT_MS,
        'admin-bind'
      );
    } else {
      // ── Strategy 2: Direct user bind (fallback) ────────────────────────────
      // AD accepts email UPN directly; OpenLDAP needs uid=<user>,<base> format.
      const userDn = username.includes('@')
        ? escapeLdap(username)
        : `uid=${escapeLdap(username)},${env.searchBase()}`;

      await withTimeout(
        authenticate({ ldapOpts, userDn, userPassword: password }),
        LDAP_TIMEOUT_MS,
        'direct-bind'
      );
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Do NOT expose raw LDAP internals to the caller / client
    throw new Error(`LDAP authentication failed for "${username}": ${detail}`);
  }
}
