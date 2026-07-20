/**
 * Pure parser for login identifiers.
 *
 * Users may authenticate with one of several formats. This module decides,
 * from the typed string alone, which LDAP attribute to search by — it never
 * touches the network or the database. The value returned here is used ONLY
 * to authenticate against AD; the database row is always resolved from the
 * authoritative sAMAccountName that AD returns after a successful bind (see
 * the login handler), never from this parsed value directly.
 *
 * Supported formats:
 *   - Local CMDB account:  claude@cmdb.local / admin@cmdb.internal
 *   - NetBIOS:             AZKARAD\andres.matias
 *   - UPN:                 andres.matias@azkar.com  (LDAP_UPN_SUFFIX)
 *   - Email (retrocompat): andres.matias@dachser.com
 *   - Bare sAMAccountName: andres.matias
 */

export type LoginIdentifierForm = 'local' | 'upn' | 'mail' | 'sam';

export interface LoginIdentifier {
  form: LoginIdentifierForm;
  /** Value to use for authentication (local: full email; others: bare identifier). */
  value: string;
  /** LDAP attribute to search by. Absent for 'local' (no LDAP lookup). */
  ldapAttr?: 'sAMAccountName' | 'userPrincipalName' | 'mail';
}

const LOCAL_ACCOUNT_DOMAINS = ['cmdb.local', 'cmdb.internal'];

function getUpnSuffix(): string {
  return (process.env.LDAP_UPN_SUFFIX ?? '').toLowerCase();
}

function getNetbiosDomain(): string {
  return (process.env.LDAP_NETBIOS_DOMAIN ?? '').toLowerCase();
}

export function parseLoginIdentifier(raw: string): LoginIdentifier {
  const trimmed = raw.trim();
  const backslashIdx = trimmed.indexOf('\\');

  if (backslashIdx !== -1) {
    // NetBIOS form: DOMAIN\sam. Only the sam part is used to authenticate;
    // the domain prefix is informational (optionally validated by callers).
    const domain = trimmed.slice(0, backslashIdx);
    const sam = trimmed.slice(backslashIdx + 1);
    const netbiosDomain = getNetbiosDomain();
    if (netbiosDomain && domain.toLowerCase() !== netbiosDomain) {
      // Unknown domain prefix — still treat as sam, let LDAP search fail
      // naturally rather than rejecting here (keeps parser side-effect-free).
    }
    return { form: 'sam', value: sam, ldapAttr: 'sAMAccountName' };
  }

  const atIdx = trimmed.lastIndexOf('@');
  if (atIdx !== -1) {
    const domain = trimmed.slice(atIdx + 1).toLowerCase();

    if (LOCAL_ACCOUNT_DOMAINS.includes(domain)) {
      return { form: 'local', value: trimmed };
    }

    const upnSuffix = getUpnSuffix();
    if (upnSuffix && domain === upnSuffix) {
      return { form: 'upn', value: trimmed, ldapAttr: 'userPrincipalName' };
    }

    return { form: 'mail', value: trimmed, ldapAttr: 'mail' };
  }

  return { form: 'sam', value: trimmed, ldapAttr: 'sAMAccountName' };
}
