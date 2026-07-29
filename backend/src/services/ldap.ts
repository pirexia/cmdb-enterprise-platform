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
 *      Service account binds first, searches for the user by the given
 *      attribute (sAMAccountName / userPrincipalName / mail), then re-binds
 *      as the found user to verify the password.
 *      This is the standard enterprise AD pattern.
 *
 *   2. Direct user bind (fallback when LDAP_BIND_DN is absent):
 *      Binds directly with the email as userPrincipalName (AD UPN format) or
 *      builds a uid= DN for OpenLDAP / 389-ds, then self-searches for the
 *      caller's own attributes.
 *
 * Fail-safe: all LDAP calls are wrapped in a 5-second timeout. If the server
 * is unreachable, the promise rejects immediately so the local bcrypt path
 * can take over without noticeable delay.
 */

// ldap-authentication is TypeScript-native (no @types needed)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { authenticate } = require('ldap-authentication') as {
  authenticate: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

const LDAP_TIMEOUT_MS = 5_000;

const env = {
  url:                  () => process.env.LDAP_URL                      ?? 'ldap://localhost:389',
  bindDn:               () => process.env.LDAP_BIND_DN                  ?? '',
  bindPassword:         () => process.env.LDAP_BIND_PASSWORD            ?? '',
  // `||`, no `??`: una variable declarada y vacía debe caer al respaldo. El
  // compose declara las opcionales como `${VAR:-}`, de modo que el contenedor
  // las recibe como cadena vacía, nunca como undefined — con `??` la cadena
  // vacía se propagaría y el bind buscaría contra un base DN vacío, rompiendo
  // todo login LDAP. Ver `resolveSearchBase` en `ldapDirectory.ts`.
  searchBase:           () => process.env.LDAP_SEARCH_BASE || process.env.LDAP_BASE_DN || 'dc=example,dc=com',
  rejectUnauthorized:   ()  => process.env.LDAP_TLS_REJECT_UNAUTHORIZED !== '0',
};

/** LDAP attribute used to look up the account before re-binding as it. */
export type LdapUsernameAttribute = 'sAMAccountName' | 'userPrincipalName' | 'mail';

/** Identity attributes as returned by the directory after a successful bind. */
export interface LdapUserIdentity {
  sAMAccountName?: string;
  userPrincipalName?: string;
  mail?: string;
  displayName?: string;
  dn?: string;
}

const IDENTITY_ATTRIBUTES = ['sAMAccountName', 'userPrincipalName', 'mail', 'displayName'];

/** ldapts returns a plain string for single-valued attributes, an array for multi-valued. */
function firstValue(v: unknown): string | undefined {
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined;
  return typeof v === 'string' ? v : undefined;
}

function toIdentity(user: Record<string, unknown> | null | undefined): LdapUserIdentity {
  if (!user) return {};
  return {
    sAMAccountName:    firstValue(user.sAMAccountName),
    userPrincipalName: firstValue(user.userPrincipalName),
    mail:              firstValue(user.mail),
    displayName:       firstValue(user.displayName),
    dn:                firstValue(user.dn),
  };
}

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
 * Resolves with the directory's own identity attributes on success (the
 * authoritative source of truth — callers must key the local user record off
 * this, not off the string the caller typed); throws a descriptive Error on
 * failure.
 *
 * @param username - Identifier supplied at login (sAMAccountName, UPN, or email)
 * @param password - Clear-text password (sent over TLS/StartTLS in production)
 * @param usernameAttribute - LDAP attribute to search by. Defaults to 'mail'
 *   when the identifier contains '@', otherwise 'sAMAccountName'.
 */
export async function authenticateLDAP(
  username: string,
  password: string,
  usernameAttribute?: LdapUsernameAttribute
): Promise<LdapUserIdentity> {
  if (!username || !password) {
    throw new Error('Username and password are required for LDAP authentication');
  }

  const attr = usernameAttribute ?? (username.includes('@') ? 'mail' : 'sAMAccountName');
  const tlsOptions = { rejectUnauthorized: env.rejectUnauthorized() };
  const ldapOpts   = { url: env.url(), tlsOptions };

  try {
    const bindDn = env.bindDn();

    if (bindDn) {
      // ── Strategy 1: Admin bind + search (recommended for AD) ──────────────
      // The service account binds first, then searches for the user by the
      // requested attribute. The library then re-binds as the found user to
      // verify their password.
      const user = await withTimeout(
        authenticate({
          ldapOpts,
          adminDn:           bindDn,
          adminPassword:     env.bindPassword(),
          userSearchBase:    env.searchBase(),
          usernameAttribute: attr,
          username:          escapeLdap(username),
          userPassword:      password,
          attributes:        IDENTITY_ATTRIBUTES,
        }),
        LDAP_TIMEOUT_MS,
        'admin-bind'
      );
      return toIdentity(user);
    } else {
      // ── Strategy 2: Direct user bind (fallback) ────────────────────────────
      // AD accepts email UPN directly; OpenLDAP needs uid=<user>,<base> format.
      const userDn = username.includes('@')
        ? escapeLdap(username)
        : `uid=${escapeLdap(username)},${env.searchBase()}`;

      const user = await withTimeout(
        authenticate({
          ldapOpts,
          userDn,
          userPassword:      password,
          // Self-search after bind so the caller still gets an authoritative identity.
          usernameAttribute: attr,
          username:          escapeLdap(username),
          userSearchBase:    env.searchBase(),
          attributes:        IDENTITY_ATTRIBUTES,
        }),
        LDAP_TIMEOUT_MS,
        'direct-bind'
      );
      return toIdentity(user);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Do NOT expose raw LDAP internals to the caller / client
    throw new Error(`LDAP authentication failed for "${username}": ${detail}`);
  }
}
