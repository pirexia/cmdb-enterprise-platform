# Security Audit & ISO 27001 Compliance Report

**Platform:** CMDB Enterprise Platform  
**Last Updated:** 2026-06-27 (v3.3.0 audit — see section below)
**Previous audit:** 2026-04-07 (v1.3.0)
**Status:** ✅ Active Controls Implemented

---

## v3.3.0 Security Audit (2026-06-27)

**Auditor:** Claude Sonnet 4.6 (autónomo)
**Rama auditada:** `develop` desde tag `v3.2.0`
**Metodología:** SAST (análisis estático) + revisión de superficie de ataque (OWASP Top 10)

### Resumen de findings

| ID | Severidad | Estado | Descripción |
|----|-----------|--------|-------------|
| BUG-001 | High | ✅ Corregido | LDAP TLS: `allowUnauthorizedCerts` con lógica invertida (CWE-295, OWASP A02) |
| BUG-002 | Medium | ✅ Corregido | RBAC manual en `/api/admin/n8n/resync` fuera del patrón canónico (CWE-284, OWASP A01) |
| BUG-003 | Low | ✅ Corregido | Dev compose sin purga de ejecuciones n8n → crecimiento ilimitado de BD |
| BUG-004 | Medium | ✅ Corregido | `N8N_API_KEY`/`N8N_INTERNAL_URL` no pasadas al contenedor backend → aprovisionamiento silencioso |

**Riesgo residual post-corrección:** Bajo. 0 críticos, 0 altos pendientes.

### Módulo n8n-provisioning — análisis detallado

Nuevo en v3.2.0. Superficie de ataque auditada:

| Archivo | Checks | Resultado |
|---------|--------|-----------|
| `apiClient.ts` | SSRF, injection en URLs, información sensible en logs | ✅ Limpio — `encodeURIComponent` en IDs; URL base desde env, no input de usuario; errors logean solo status HTTP |
| `config.ts` | Secrets en código, efectos secundarios | ✅ Limpio — env-only, sin efectos secundarios; secrets (SMTP_PASS, LDAP_BIND_PASSWORD) nunca logeados |
| `onBoot.ts` | DoS (unbounded retries), resource leak, throws | ✅ Limpio — retries acotados (10×6s); fire-and-forget; PrismaClient local dentro del scope |
| `provisioner.ts` | SQL injection, SSRF, credential leak | ✅ Limpio — `$queryRaw` con tagged template literal; fail-soft por ítem; credentials no se loguean |
| `credentials.ts` | TLS bypass, secrets | ✅ Corregido (BUG-001) — `allowUnauthorizedCerts` ahora opt-in explícito vía `LDAP_ALLOW_UNAUTHORIZED_CERTS=true` |
| `router.ts` | RBAC | ✅ Corregido (BUG-002) — RBAC delegado al mount (`requireAdmin` en `index.ts:314`) |

### Checklist OWASP Top 10 (cambios v3.2.0 → v3.3.0)

| # | Risk | Resultado |
|---|------|-----------|
| A01 | Broken Access Control | ✅ BUG-002 corregido; `requireAdmin` en mount |
| A02 | Cryptographic Failures | ✅ BUG-001 corregido; LDAP TLS verificado por defecto |
| A03 | Injection | ✅ `$queryRaw` tagged literal en `provisioner.ts:67`; `encodeURIComponent` en apiClient |
| A04 | Insecure Design | ✅ Provisioner idempotente; onBoot fail-safe; n8n API key como secreto de entorno |
| A05 | Security Misconfiguration | ✅ BUG-003 corregido; BUG-004 corregido; EXECUTIONS_DATA_PRUNE en dev compose |
| A06 | Vulnerable Components | ℹ️ Ver nota npm audit abajo |
| A07 | Auth & Session Failures | ✅ Sin cambios — HttpOnly JWT, ADMIN MFA obligatorio |
| A08 | Software & Data Integrity | ✅ Sin cambios en esta superficie |
| A09 | Logging & Monitoring | ✅ `onBoot` loguea todos los outcomes; errors internos, no expuestos |
| A10 | SSRF | ✅ `N8N_INTERNAL_URL` fija desde env; no se acepta URL de usuario para llamadas outbound |

### npm audit (2026-06-27)

```bash
# Ejecutar dentro del contenedor backend para resultados definitivos:
podman exec cmdb-backend sh -c "cd /app && npm audit --production"
```

> Pendiente de ejecución en el contenedor (sin acceso directo al entorno npm del host durante esta sesión).
> Los packages del host pueden diferir de los del contenedor. Ver audit anterior (v1.3.0) sin vulnerabilidades.

### Cambios de infraestructura auditados

- **nginx resolver** (`d04b9f8`): cambiado de `10.89.1.1` a `10.89.0.1` (dev). Impacto de seguridad: ninguno — corrección operacional para DNS interno de Podman. El resolver es interno y no accesible desde internet.
- **GIT_TAG en frontend** (`0c7abc4`): inyectado como `ARG` en Dockerfile en build-time. No es user-controlled en runtime. Sin impacto de seguridad.
- **EXECUTIONS_DATA_PRUNE** (`0c7abc4`): limita almacenamiento de ejecuciones en n8n. Mejora A09 (logging apropiado sin acumulación infinita).

---

---

## Executive Summary

This document describes the security controls implemented in the CMDB Enterprise Platform and maps them to ISO/IEC 27001:2022 Annex A controls. The platform has undergone security hardening as part of Misión 13, introducing TLS/HTTPS support, HTTP security headers via Helmet, strict CORS policies, and JWT secret management improvements.

**npm audit results (2026-03-15):**
- `backend/` → **0 vulnerabilities found**
- `frontend/` → **0 vulnerabilities found**

---

## ISO 27001 Control Mapping

### A.9.2 — User Access Management

**Control objective:** Ensure authorized user access and prevent unauthorized access to systems and services.

| Sub-control | Implementation | Status |
|-------------|---------------|--------|
| A.9.2.1 User registration & de-registration | Users are created/deleted via `POST /api/users` by ADMIN role only. | ✅ |
| A.9.2.2 User access provisioning | Role-based access control (RBAC): three roles — `ADMIN`, `AUDITOR`, `VIEWER` — enforced on every protected endpoint via `authenticateToken` + `requireAdmin` / `requireAudit` middleware. | ✅ |
| A.9.2.3 Management of privileged access | Write operations (`POST`, `PATCH`, `DELETE`, `PUT`) require `ADMIN` role. `AUDITOR` has read-only access + exclusive access to audit logs. `VIEWER` has read-only access to inventory, vulnerabilities, contracts and reports. | ✅ |
| A.9.2.4 Authentication credentials | Passwords hashed with **bcrypt** (salt rounds ≥ 10). Passwords never returned in API responses. **Password policy** enforced for local users: minimum length by role (ADMIN: 16 chars, VIEWER/AUDITOR: 12 chars, both configurable), complexity requirements (upper, lower, digit, special char), dictionary blocklist (~100 common passwords), and password history (last 20 entries, configurable). LDAP/AD users are excluded from local password policy. | ✅ |
| A.9.2.5 Review of user access rights | Audit log (`audit_logs` table) records every CREATE_CI, UPDATE_VULN_STATUS, UPDATE_VERIFICATION, and admin action with timestamp and user email. | ✅ |
| A.9.2.6 Removal/adjustment of access rights | User deletion via admin API immediately revokes access. JWT tokens expire after **8 hours**. Deactivated accounts are checked on every authenticated request — existing JWTs are rejected immediately without waiting for expiry (v1.1.0, fixes issue #9). | ✅ |

**Multi-Factor Authentication (MFA) — Enhanced Enforcement:**
- TOTP-based MFA implemented using `speakeasy` (RFC 6238 compliant).
- QR code provisioning via `POST /api/auth/mfa/setup` (authenticated endpoint).
- **Admin users (mandatory):** On first login without MFA configured, the server issues a *limited JWT* (`mfaSetupRequired: true`, 15 min TTL). This token is only accepted by MFA setup endpoints. The frontend forces the user through the setup wizard before granting full application access. Admin cannot skip or bypass this step.
- **AUDITOR / VIEWER users (recommended):** On first login without MFA configured, the server records `mfa_prompted_at = now()` and returns the full JWT with `requireAction: 'MFA_SETUP_SUGGESTED'`. The frontend shows a one-time suggestion screen; the user may configure MFA or skip. On subsequent logins, no suggestion is shown.
- **Trusted devices:** After successful MFA verification, the user can mark the device as trusted. The server generates a 32-byte cryptographically random token (`crypto.randomBytes`), stores it in the `trusted_devices` table with an expiry of `TRUSTED_DEVICE_TTL_DAYS` days (default 30), and returns it to the client (stored in `localStorage`). On future logins, if the client presents a valid, non-expired device token, the MFA step is bypassed. Expired device records are automatically purged by a daily cron job (02:00 AM).
- **Limited JWT scope enforcement:** The `authenticateToken` middleware rejects requests from `mfaSetupRequired` tokens to any path other than `/api/auth/mfa/setup` and `/api/auth/mfa/enable`, returning `403 MFA_SETUP_REQUIRED`.
- **Server-side TOTP secret during enrollment (v1.1.0):** `POST /api/auth/mfa/setup` persists the generated secret to `users.mfa_pending_secret`. `POST /api/auth/mfa/enable` reads the secret exclusively from this field — any client-supplied `secret` field is ignored — preventing bypass via a client-controlled TOTP seed. The pending secret is cleared on successful verification (fixes issue #8).

**LDAP / Active Directory Integration:**
- Optional LDAP authentication via `USE_LDAP=true` environment variable.
- LDAP users are auto-provisioned on first login with `VIEWER` role.
- Configured via `LDAP_URL`, `LDAP_BASE_DN`, `LDAP_BIND_DN`, `LDAP_BIND_PASSWORD`.

**Password Policy (local users only — ISO 27001 A.9.3 / A.9.4):**

| Rule | ADMIN | AUDITOR / VIEWER | Configurable |
|------|:-----:|:----------------:|:------------:|
| Minimum length | 16 chars | 12 chars | `PASSWORD_MIN_LENGTH_ADMIN` / `PASSWORD_MIN_LENGTH_VIEWER` |
| Uppercase letters | ✅ | ✅ | — |
| Lowercase letters | ✅ | ✅ | — |
| Digits | ✅ | ✅ | — |
| Special characters | ✅ | ✅ | — |
| Common password blocklist | ✅ (~100 entries) | ✅ | — |
| Password history | Last 20 | Last 20 | `PASSWORD_HISTORY_COUNT` |

- Policy is enforced server-side via `validatePasswordPolicy()` on `POST /api/profile/change-password` and `POST /api/users/:id/reset-password`.
- Password history stored in `password_history` table as bcrypt hashes; entries beyond the configured limit are pruned automatically.
- LDAP/AD users (`sso_external_id IS NOT NULL`) are explicitly excluded — password managed by the domain controller.
- Frontend provides real-time strength indicator (5-bar colour-coded checklist) derived from the same rules.
- `CHANGE_PASSWORD` and `RESET_PASSWORD` actions are logged in `audit_logs`.

---

### A.10.1 — Cryptographic Controls

**Control objective:** Ensure proper and effective use of cryptography to protect information confidentiality, authenticity and/or integrity.

| Sub-control | Implementation | Status |
|-------------|---------------|--------|
| A.10.1.1 Policy on cryptographic controls | JWT signed with HS256 algorithm. bcrypt used for password hashing. TLS 1.2+ for transport encryption. | ✅ |
| A.10.1.2 Key management | `JWT_SECRET` must be set via environment variable. Server refuses to start in production if `JWT_SECRET` is unset. Key rotation possible by updating the env variable. | ✅ |

**HTTPS / TLS:**
- Self-signed certificate generation script provided: `backend/scripts/generate-certs.sh` (Linux/Mac) and `backend/scripts/generate-certs.ps1` (Windows).
- Backend uses Node.js `https` module when `HTTPS_ENABLED=true` and `backend/certs/server.key` + `server.crt` exist.
- Graceful HTTP fallback for local development when certs are not present.
- Certificate: RSA 2048-bit, SHA-256, SAN for `localhost` and `127.0.0.1`.

**JWT Token Security:**
```
Algorithm:  HS256
Expiry:     8 hours
Secret:     Read from JWT_SECRET env var (min 32 chars recommended)
Production: Server exits if JWT_SECRET is unset
```

**Password Hashing:**
```
Algorithm:  bcrypt
Cost factor: 10 salt rounds (≥ 2^10 iterations)
Storage:    Hash only — plaintext never persisted
```

**HTTP Security Headers (via Helmet + Next.js):**

| Header | Value | Mitigates |
|--------|-------|-----------|
| `X-Content-Type-Options` | `nosniff` | MIME-type sniffing attacks |
| `X-Frame-Options` | `SAMEORIGIN` | Clickjacking (ISO A.8.24) |
| `X-XSS-Protection` | `1; mode=block` | Reflected XSS (legacy browsers) |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Information leakage via Referer header |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | Browser feature abuse |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | HTTPS downgrade attacks (activate with TLS) |

---

### A.12.4 — Logging and Monitoring

**Control objective:** Record events and generate evidence to support information security incident investigation and access control monitoring.

| Sub-control | Implementation | Status |
|-------------|---------------|--------|
| A.12.4.1 Event logging | Audit log table `audit_logs` captures: action, entity, entity_id, user_email, timestamp. | ✅ |
| A.12.4.2 Protection of log information | Logs stored in PostgreSQL with timestamps. Append-only via raw SQL inserts. Admin read access via `GET /api/audit-logs`. | ✅ |
| A.12.4.3 Administrator and operator logs | All CREATE/UPDATE/DELETE operations on CIs, vulnerabilities, and verification updates are logged. | ✅ |
| A.12.4.4 Clock synchronisation | Server uses `now()` (PostgreSQL) for all log timestamps, ensuring consistent clock source. | ✅ |

**Audit Log Schema:**
```sql
CREATE TABLE "audit_logs" (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action     TEXT NOT NULL,         -- e.g. CREATE_CI, UPDATE_VULN_STATUS:RESUELTO
  entity     TEXT NOT NULL,         -- e.g. CI, VULNERABILITY, CONTRACT
  entity_id  TEXT NOT NULL,         -- UUID or composite key
  user_email TEXT NOT NULL,         -- Actor
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
```

**Logged actions include:**
- `CREATE_CI` — new configuration item created
- `UPDATE_VULN_STATUS:{status}` — vulnerability lifecycle transition
- `UPDATE_VERIFICATION:{source}` — EOL/EOS verification updated
- All PATCH/DELETE admin operations

---

## Additional Security Controls

### A.13.1 — Network Security Management

- **CORS:** Strict allow-list via `CORS_ORIGINS` environment variable. Backend logs and rejects requests from unlisted origins.
- **Request Size Limit:** `express.json({ limit: '2mb' })` prevents large-payload DoS attacks.
- **Docker Network Isolation:** Backend, frontend, and database run in isolated Docker network (`cmdb-network`). PostgreSQL is not exposed to host by default.

### A.14.2 — Security in Development and Support Processes

- Secrets management: `.env` files excluded from Git via `.gitignore`. `.env.example` provided with safe placeholder values.
- Dependency scanning: `npm audit` run in both `backend/` and `frontend/` — **0 vulnerabilities found** (2026-03-15).
- All sensitive operations require authentication token in `Authorization: Bearer <token>` header.
- **Document download (v1.1.0):** `GET /api/documents/:id/download` now requires the `Authorization: Bearer` header exclusively. The former `?token=` query parameter has been removed — JWT tokens in URLs leak into server access logs, browser history, and HTTP Referer headers (fixes issue #11).
- **LIKE wildcard injection (v1.1.0):** Greenbone and CrowdStrike CI-matching queries escape `%`, `_`, and `\` in external hostnames before use in LIKE patterns, preventing wildcard injection that could match unintended configuration items (fixes issue #12).

### A.18.1 — Compliance with Legal and Contractual Requirements

- Passwords hashed (GDPR Art. 25 — privacy by design).
- No sensitive data (passwords, MFA secrets) returned in API responses.
- JWT tokens have limited lifetime (8h) to reduce exposure window.

---

## Vulnerability Scan Results

**Date:** 2026-03-15  
**Tool:** `npm audit` (npm v10+)

| Package | Severity | Status |
|---------|----------|--------|
| `backend/` — all packages | — | ✅ 0 vulnerabilities |
| `frontend/` — all packages | — | ✅ 0 vulnerabilities |

**Hardcoded Secret Check:**

| Location | Finding | Status |
|----------|---------|--------|
| `backend/src/index.ts` | `JWT_SECRET` read from `process.env.JWT_SECRET` — dev fallback present with explicit warning | ✅ |
| `backend/.env` | Not committed to Git (listed in `.gitignore`) | ✅ |
| `backend/.env.example` | Contains only placeholder values | ✅ |
| `docker-compose.yml` | Reads secrets from `.env` file, no hardcoded values | ✅ |

---

## HIGH-Severity Fixes — v1.2.0 (2026-04-07)

| Issue | Control | Implementation |
|-------|---------|----------------|
| #18 LDAP injection | `escapeLdap()` per RFC 4514/4515 | All usernames are escaped before DN construction and search-filter use in `ldap.ts` |
| #17 Command injection (install.sh) | Replace `eval` with `printf -v` | User input is never passed through the shell parser during prompt variable assignment |
| #16 Greenbone data loss | Merge-on-import instead of replace | Existing vuln lifecycle status is preserved; only new CVEs appended with status NUEVO |
| #15 Stored XSS via SVG | MIME-type allowlist on inline view | Only PDF, PNG, JPEG, GIF, WEBP, text/plain served inline; all others forced to `application/octet-stream` + `attachment` |
| #14 DoS via unbounded lists | Pagination on `/api/cis`, `/api/documents`, `/api/licenses` | Default 200 records/page, hard cap 500; query params `?page=&limit=`; parallel COUNT for totals |
| #13 Weak bcrypt | Cost factor raised 10 → 12 | Configurable via `BCRYPT_ROUNDS` env var; applied to all hash operations |

---

## MEDIUM/LOW-Severity Fixes — v1.6.4 (2026-04-07)

| Issue | Severity | Control | Implementation |
|-------|----------|---------|----------------|
| #27 JWT algorithm unspecified | MEDIUM | A.10.1.1 | Confirmed: all `jwt.sign()` calls use `{ algorithm: 'HS256' as const }` and all `jwt.verify()` calls use `{ algorithms: ['HS256'] }` allowlist — rejects `alg:none` tokens at library level |
| #25 Device token IP/UA bypass | MEDIUM | A.9.4.2 | `trusted_devices` now stores non-null IP and UA strings at creation; validation query uses strict equality (`ip_address = $ip AND user_agent = $ua`) — removed the `IS NULL OR` bypass that allowed stolen tokens to match from any origin |
| #22 SQL errors leaked in API | MEDIUM | A.12.2 | 50+ `catch` blocks replaced: raw `String(e)` / `e.message` no longer returned to clients; all 500 responses return `{ error: 'Internal server error' }`; full error logged server-side via `console.error` |
| #24 Hardcoded credential hint | LOW | A.9.4.3 | Removed `placeholder="admin@cmdb.local"` from login email field — internal admin username and domain were exposed to unauthenticated visitors |
| #20 JWT expiry not checked client-side | LOW | A.9.4.2 | `AuthContext.tsx`: `isJwtExpired()` decodes the `exp` claim (pure base64, no library) with 30 s clock-skew buffer; expired tokens discarded on mount + periodic 60 s check + `visibilitychange` listener; `apiFetch` validates expiry before every request |

---

## Pending / Recommended Actions

| Priority | Action | Responsible |
|----------|--------|-------------|
| 🔴 HIGH | Run `bash backend/scripts/generate-certs.sh` and set `HTTPS_ENABLED=true` for production | DevOps |
| 🔴 HIGH | Replace default `JWT_SECRET` with `openssl rand -base64 48` output in production `.env` | DevSecOps |
| 🟠 MEDIUM | Rotate database password (`POSTGRES_PASSWORD`) from the default placeholder | DevOps |
| 🟠 MEDIUM | Enable HSTS header in `frontend/next.config.ts` once HTTPS is active (uncomment the commented line) | Frontend |
| 🟡 LOW | Implement certificate auto-renewal (Let's Encrypt via Certbot) for production deployments | DevOps |
| ✅ DONE | Rate limiting on `POST /api/auth/login` — `express-rate-limit`: 10 failed attempts / 15 min per IP (`skipSuccessfulRequests: true`) | Backend |
| 🟡 LOW | Implement log rotation and archival for `audit_logs` table | DBA |

---

## Revision History

| Date | Version | Author | Changes |
|------|---------|--------|---------|
| 2026-03-15 | 1.0.0 | DevSecOps (Misión 13) | Initial security audit — SSL, Helmet, CORS, ISO 27001 mapping |
| 2026-03-31 | 1.2.0 | DevSecOps | MFA mandatory enforcement for admins; trusted device mechanism; limited JWT scope; rate limiting confirmed implemented |
| 2026-04-01 | 1.3.0 | DevSecOps | Added AUDITOR role (RBAC three-tier); `requireAudit` middleware; AUDITOR has exclusive audit log read access; seed user `auditor@cmdb.local` migrated from VIEWER to AUDITOR |
| 2026-04-01 | 1.4.0 | DevSecOps | Password policy for local users: role-aware min length (ADMIN 16 / others 12), complexity rules, ~100-entry common-password blocklist, 20-entry history (all configurable via .env); `password_history` table; `CHANGE_PASSWORD` and `RESET_PASSWORD` audit events; frontend real-time strength indicator |
| 2026-04-07 | 1.1.0 | DevSecOps | 5 critical security fixes: LIKE wildcard injection (#12), JWT in download URL (#11), stack trace exposure (#10), deactivated user JWT bypass (#9), MFA client-secret bypass (#8). New DB migration: `mfa_pending_secret`. |
| 2026-04-07 | 1.2.0 | DevSecOps | 6 HIGH security fixes: LDAP injection (#18), command injection in install.sh (#17), Greenbone vuln data loss on re-import (#16), stored XSS via SVG inline view (#15), DoS via unbounded list endpoints — pagination added (#14), bcrypt cost factor raised 10→12 (#13). |
| 2026-04-07 | 1.3.0 | DevSecOps | Frontend hotfix v1.6.3: adapted 4 callsites to paginated API response shape (`{ total, page, limit, data }`) introduced in v1.6.2. Affected: `licenses/page.tsx`, `documents/page.tsx`, `documents/[id]/page.tsx`, `CIDetailModal.tsx` (closes #34). |
| 2026-04-07 | 1.4.0 | DevSecOps | 5 MEDIUM/LOW security fixes: JWT algorithm confirmed HS256 (#27), trusted device IP/UA strict binding (#25), SQL/internal error masking in 50+ API catch blocks (#22), hardcoded credential hint removed from login (#24), client-side JWT expiry validation with periodic check (#20). |

---

*This document must be reviewed and updated at least annually or after any significant infrastructure change.*
