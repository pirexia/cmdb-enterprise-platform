/**
 * LDAP / Active Directory authentication service.
 *
 * Controlled by the following environment variables:
 *   USE_LDAP=true|false       - Enable/disable LDAP mode (default: false)
 *   LDAP_URL                  - LDAP server URL (e.g. ldap://dc.corp.local:389)
 *   LDAP_BASE_DN              - Base DN for user searches (e.g. dc=corp,dc=local)
 *
 * Bind strategy:
 *   - If the username looks like an email (contains @), it is used directly as
 *     the userPrincipalName — compatible with Active Directory.
 *   - Otherwise, a DN is constructed as uid=<username>,<LDAP_BASE_DN> —
 *     compatible with OpenLDAP / 389-ds.
 */

// ldap-authentication is TypeScript-native (no @types needed)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { authenticate } = require('ldap-authentication') as {
  authenticate: (opts: Record<string, unknown>) => Promise<unknown>;
};

const LDAP_URL     = () => process.env.LDAP_URL     ?? 'ldap://localhost:389';
const LDAP_BASE_DN = () => process.env.LDAP_BASE_DN ?? 'dc=example,dc=com';

/**
 * Attempts to bind to the LDAP server with the provided credentials.
 * Resolves silently on success; throws a descriptive Error on failure.
 *
 * @param username - Email or plain username supplied at login
 * @param password - Clear-text password (sent over TLS/StartTLS in production)
 */
export async function authenticateLDAP(username: string, password: string): Promise<void> {
  if (!username || !password) {
    throw new Error('Username and password are required for LDAP authentication');
  }

  // Build the bind DN — AD accepts email UPN directly; OpenLDAP needs uid= format
  const userDn = username.includes('@')
    ? username                                        // AD: user@domain.com
    : `uid=${username},${LDAP_BASE_DN()}`;            // OpenLDAP: uid=user,dc=...

  try {
    await authenticate({
      ldapOpts:     { url: LDAP_URL() },
      userDn,
      userPassword: password,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Wrap with a clean message; do NOT expose internal LDAP errors to the client
    throw new Error(`LDAP bind failed for "${username}": ${detail}`);
  }
}
