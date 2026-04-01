# 🔐 Security Audit & ISO 27001 Compliance Report

**Platform:** CMDB Enterprise Platform  
**Audit Date:** 2026-04-01 (updated)
**Auditor:** DevSecOps Team
**Version:** v1.4.0  
**Status:** ✅ Active Controls Implemented

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
| A.9.2.6 Removal/adjustment of access rights | User deletion via admin API immediately revokes access. JWT tokens expire after **8 hours**. | ✅ |

**Multi-Factor Authentication (MFA) — Enhanced Enforcement:**
- TOTP-based MFA implemented using `speakeasy` (RFC 6238 compliant).
- QR code provisioning via `POST /api/auth/mfa/setup` (authenticated endpoint).
- **Admin users (mandatory):** On first login without MFA configured, the server issues a *limited JWT* (`mfaSetupRequired: true`, 15 min TTL). This token is only accepted by MFA setup endpoints. The frontend forces the user through the setup wizard before granting full application access. Admin cannot skip or bypass this step.
- **AUDITOR / VIEWER users (recommended):** On first login without MFA configured, the server records `mfa_prompted_at = now()` and returns the full JWT with `requireAction: 'MFA_SETUP_SUGGESTED'`. The frontend shows a one-time suggestion screen; the user may configure MFA or skip. On subsequent logins, no suggestion is shown.
- **Trusted devices:** After successful MFA verification, the user can mark the device as trusted. The server generates a 32-byte cryptographically random token (`crypto.randomBytes`), stores it in the `trusted_devices` table with an expiry of `TRUSTED_DEVICE_TTL_DAYS` days (default 30), and returns it to the client (stored in `localStorage`). On future logins, if the client presents a valid, non-expired device token, the MFA step is bypassed. Expired device records are automatically purged by a daily cron job (02:00 AM).
- **Limited JWT scope enforcement:** The `authenticateToken` middleware rejects requests from `mfaSetupRequired` tokens to any path other than `/api/auth/mfa/setup` and `/api/auth/mfa/enable`, returning `403 MFA_SETUP_REQUIRED`.

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

---

*This document must be reviewed and updated at least annually or after any significant infrastructure change.*
