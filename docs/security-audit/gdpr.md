# GDPR / RGPD Compliance Audit — CMDB Enterprise Platform v2.0.1

**Audit date:** 2026-04-17
**Regulation:** Regulation (EU) 2016/679 (GDPR)
**Scope:** CMDB Enterprise Platform v2.0.1 — user data, audit logs, license user records
**Auditor:** Internal compliance review
**Classification:** CONFIDENTIAL — INTERNAL USE ONLY

---

## Remediation Update — 2026-04-18 (develop branch, v2.0.2)

| Finding | Status | Commit |
|---------|--------|--------|
| No user account deletion / Art. 17 erasure impossible | ✅ **Fixed** | `3ae7df1` — `DELETE /api/admin/users/:id` + audit log pseudonymisation (closes #70, #73) |
| JWT in `localStorage` — XSS theft risk (Art. 32) | ✅ **Fixed** | `023328f` — HttpOnly cookie migration (closes #71) |
| No privacy notice / Arts. 13/14 notice absent | ✅ **Fixed** | `50d622d` — `/privacy` page + login link + all 6 locales (closes #77) |
| No DPIA despite high-risk processing (Art. 35) | ✅ **Fixed** | `c975f1b` — ISMS-DPIA-001 created in `docs/security/isms/06-dpia.md` (closes #80) |
| Audit log immutability vs. erasure conflict unresolved | ✅ **Fixed** | `3ae7df1` — pseudonymisation (SHA-256 hash) as Art. 17(3)(b) exception; RLS enforced |
| DNI/national ID lacks documented legal basis | 🟡 **Open** | Documented in DPIA §3.2 — decision required before production deployment |
| No data portability mechanism (Art. 20) | 🟡 **Open** | Not in scope for current release |

---

## Executive Summary

The CMDB Enterprise Platform processes three categories of personal data: platform user accounts (email, hashed credentials, MFA secrets, SSO identifiers), audit log entries (user email linked to actions and timestamps), and license user records (full name, DNI/national ID number, email). The platform demonstrates strong technical security controls — including RBAC, MFA enforcement for administrators, bcrypt-hashed passwords (cost factor 12), parameterised SQL throughout, Helmet security headers, and rate-limited endpoints — which positively address Art. 32 integrity and confidentiality obligations. However, several significant GDPR gaps exist: there is no user-account deletion endpoint (making Art. 17 erasure impossible without direct database intervention), no documented lawful basis for processing LicenseUser DNI/national ID numbers, no privacy notice or data subject information system (Arts. 13/14), no data portability mechanism (Art. 20), and no formal Data Protection Impact Assessment despite processing national identity numbers at scale. The audit classifies the overall compliance posture as **Partial — Requires Remediation**, with two High-risk gaps requiring immediate attention.

---

## Personal Data Inventory

| Data Category | Table/Field | Lawful Basis | Retention | Risk |
|---|---|---|---|---|
| User email address | `users.email` | Art. 6(1)(b) — performance of employment contract / Art. 6(1)(f) — legitimate interest (system access control) | Duration of employment + statutory period | Low |
| Username | `users.username` | Art. 6(1)(b) | Duration of employment | Low |
| Hashed password | `users.password` | Art. 6(1)(b) — necessary for authentication | Duration of account | Low |
| Password history hashes | `password_history.hash` | Art. 6(1)(f) — legitimate interest (security policy enforcement) | Last N entries (configurable, default 20) — **no time-based limit** | Medium |
| MFA TOTP secret | `users.mfa_secret`, `users.mfa_pending_secret` | Art. 6(1)(b) | Duration of account | Medium |
| SSO external identifier (Azure OID / LDAP email) | `users.sso_external_id`, `users.sso_provider` | Art. 6(1)(b) | Duration of account | Medium |
| Trusted device IP address and User-Agent | `trusted_devices.ip_address`, `trusted_devices.user_agent` | Art. 6(1)(f) — legitimate interest (device binding, anti-session-hijacking) | Up to 30 days (configurable `TRUSTED_DEVICE_TTL_DAYS`) | Medium |
| Audit log — user email + action + timestamp | `audit_logs.user_email`, `audit_logs.created_at`, `audit_logs.action` | Art. 6(1)(c) — legal obligation (ISO 27001 / NIS2 compliance) | **No retention limit defined in application** | High |
| License user full name | `license_users.name` | Art. 6(1)(b) — contractual necessity (license compliance management) | Duration of license + post-expiry compliance period — **not defined** | High |
| License user DNI / national ID number | `license_users.dni` | **No documented lawful basis** | **No retention limit** | **High** |
| License user email | `license_users.email` | Art. 6(1)(b) | **No retention limit** | Medium |
| CI assigned user (free text name) | `configuration_items.assigned_user` | Art. 6(1)(b) — asset tracking | Duration of CI lifecycle | Medium |
| CI user DNI (free text) | `configuration_items.user_dni` | **No documented lawful basis** | Duration of CI lifecycle | High |
| Document uploaded-by email | `documents.uploaded_by`, `document_notes.created_by` | Art. 6(1)(b) — accountability/audit trail | Duration of document | Low |

---

## Compliance Assessment by Article

---

### Art. 5 — Data Processing Principles

#### 5(1)(a) — Lawfulness, fairness, transparency

**Current state:** No in-application privacy notice, consent mechanism, or data processing notice is presented to users at registration or first login. The User Manual documents operational procedures but contains no information on data processing purposes, legal bases, or data subject rights. Platform terms and conditions are absent from the codebase.

**Gap:** Users are not informed what personal data is collected, for what purpose, on what legal basis, or for how long it is retained. This applies to all data categories above.

**Risk:** High

**Recommendation:** Add a data processing notice (displayed at first login or during account creation) covering all processed categories, legal bases, and contact details for the data controller. Document the legal bases in a formal Records of Processing Activities (RoPA) register.

#### 5(1)(b) — Purpose limitation

**Current state:** User data is collected for authentication and access control. Audit logs are collected for security monitoring and ISO 27001 compliance. LicenseUser data is collected for software license compliance management. These purposes are distinct and narrowly scoped in the code.

**Gap:** The `license_users` table collects DNI (national identity number) which appears disproportionate for software license management. A license compliance check does not ordinarily require a government-issued identity number.

**Risk:** Medium

**Recommendation:** Review whether DNI collection in `license_users` is strictly necessary for the stated purpose of license compliance. If not necessary, make the field deprecated and remove it from the UI.

#### 5(1)(c) — Data minimisation

**Current state:** The `CI` model stores `assigned_user` (free text) and `user_dni` (free text, 20 chars) directly on asset records. `LicenseUser` stores `name`, optional `dni`, and optional `email`. The `TrustedDevice` model records IP address and User-Agent string for device binding (security justification exists in code: `// Bind token to client IP and User-Agent at creation time (Issue #25)`).

**Gap:** `configuration_items.user_dni` has no documented processing justification. Storing a national ID number on an IT asset record is difficult to justify under data minimisation principles. The `TrustedDevice` IP/UA collection has a security justification but is not documented in a privacy notice.

**Risk:** High (for `user_dni`), Low (for TrustedDevice IP/UA)

**Recommendation:** Remove `user_dni` from the CI model or restrict it to a pseudonymised employee reference number. Document the TrustedDevice security justification in the privacy notice.

#### 5(1)(d) — Accuracy

**Current state:** Users can update their own password via `POST /api/profile/change-password`. Admins can change role and activation status. However, there is no endpoint allowing a user to correct their own email address or username.

**Gap:** No self-service mechanism exists for data subjects to correct their own email or display name. Only admin-level database intervention can correct these fields.

**Risk:** Medium

**Recommendation:** Add `PATCH /api/profile` endpoint allowing authenticated users to update email and username, subject to uniqueness constraints and re-authentication.

#### 5(1)(e) — Storage limitation

**Current state:** No automated data retention policy exists in the application code. Backup retention is configurable via `RETENTION_DAYS` (default 30 days for DB backups) but this covers backup files, not the live database content. The `password_history` table is pruned by count (last N), not by time. The `trusted_devices` table is cleaned by a cron job (`node-cron`) based on `expires_at`. The `audit_logs` table has no purge mechanism.

**Gap:** No retention schedule is defined for: `audit_logs`, `license_users`, `users` (deactivated accounts), `password_history` (accumulates indefinitely for count-limited history). There is no automated archival or deletion process.

**Risk:** High

**Recommendation:** Define and implement a data retention schedule:
- `audit_logs`: retain for the legally required minimum (e.g., 12–36 months per applicable law), then archive or pseudonymise the `user_email` field.
- `password_history`: add a time-based limit (e.g., retain for max 2 years) in addition to the count limit.
- Deactivated `users`: define a deletion schedule (e.g., soft-delete at deactivation, hard-delete after 12 months of inactivity).
- `license_users`: delete records when the associated license expires or within a defined period after expiry.

#### 5(1)(f) — Integrity and confidentiality

**Current state:** Strong controls are in place. Passwords are bcrypt-hashed with cost factor 12 (NIST SP 800-63B compliant, configurable via `BCRYPT_ROUNDS`). MFA is mandatory for ADMIN users. JWT uses HS256 with a configurable secret (production startup fails if `JWT_SECRET` is unset). Helmet sets `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and optionally HSTS. CORS is restricted to an allowlist. Rate limiting protects login (10 attempts/15 min) and all API endpoints (300 req/min). All SQL uses tagged template literals — no string concatenation. TLS is supported via nginx or direct backend HTTPS.

**Gap:** JWT tokens are stored in `localStorage` on the frontend (evidenced by `lib/apiFetch.ts` pattern described in CLAUDE.md). `localStorage` is accessible to any JavaScript running on the page, making tokens vulnerable to XSS attacks. This is a known security vs. GDPR Art. 32 tension.

**Risk:** Medium

**Recommendation:** Migrate JWT storage to `HttpOnly` secure cookies to eliminate XSS-based token theft. If migration is not feasible short-term, ensure Content-Security-Policy headers are tightened to minimise XSS attack surface.

---

### Art. 6 — Lawful Basis for Processing

**Current state:** No formal lawful basis has been documented anywhere in the codebase, documentation, or configuration. The following analysis is based on inferred operational context (B2B enterprise tool used by employees to manage IT assets):

| Processing activity | Inferred lawful basis |
|---|---|
| User authentication data | Art. 6(1)(b) — necessary for employment contract / Art. 6(1)(f) — legitimate interest |
| Audit logs | Art. 6(1)(c) — legal obligation (ISO 27001, NIS2) |
| License user name and email | Art. 6(1)(b) — contractual necessity (software licence compliance) |
| License user DNI | **No clear basis** — Art. 6(1)(f) may apply but disproportionate |
| CI `assigned_user` and `user_dni` | Art. 6(1)(b) — asset management, but `user_dni` disproportionate |
| TrustedDevice IP/UA | Art. 6(1)(f) — legitimate interest (security) |

**Gap:** No formal, documented lawful basis exists. DNI collection in both `license_users` and `configuration_items` lacks a defensible lawful basis under Art. 6 and may constitute special category data adjacent processing (government-issued identifiers).

**Risk:** High

**Recommendation:** Formally document lawful bases in a RoPA register. Conduct a Legitimate Interests Assessment (LIA) for TrustedDevice data and MFA secrets. Seek legal advice on DNI collection.

---

### Art. 9 — Special Categories of Personal Data

**Current state:** No health, biometric, genetic, racial/ethnic origin, or religious data is collected. DNI/national identity numbers are government identifiers — not special categories under Art. 9 — but they are sensitive and their proportionality must be justified under Art. 6.

**Gap:** Not directly applicable, but DNI numbers warrant elevated scrutiny under Arts. 5(1)(c) and 6.

**Risk:** Low (Art. 9 not triggered), Medium (proportionality concern)

---

### Art. 13/14 — Information Obligations (Privacy Notice)

**Current state:** No privacy notice, cookie notice, or data processing disclosure exists in the application. The User Manual documents operational workflows but contains no GDPR-required information. The login page has no link to a privacy policy. Auto-provisioned SSO and LDAP users (created without any explicit registration flow) receive no notification that their data has been processed.

**Gap:** Complete absence of Art. 13 (direct collection) and Art. 14 (indirect collection for auto-provisioned users) information. This is a fundamental GDPR obligation.

**Risk:** High

**Recommendation:** Implement a privacy notice accessible from the login page and presented at first login. For auto-provisioned LDAP/SSO users, the organisation must ensure the notice is provided by another means (e.g., internal HR communication) since the application does not send welcome emails.

---

### Art. 15 — Right of Access

**Current state:** No `GET /api/profile/data-export` or equivalent endpoint exists. An authenticated user can retrieve their basic profile data by calling `GET /api/users` (available to all roles), which returns `id, username, email, role, active, sso_external_id, mfa_enabled, created_at`. However, this returns all users, not a scoped personal data report. There is no way for a data subject to obtain all data held about them (e.g., audit log entries for their own email, trusted devices, password history count).

**Gap:** No dedicated data subject access mechanism. A data subject cannot easily request all personal data held about them without admin assistance.

**Risk:** Medium

**Recommendation:** Implement `GET /api/profile/my-data` returning the authenticated user's complete personal data footprint: profile fields, trusted devices (count, last seen, expiry), audit log entries where `user_email = req.user.email`, and a summary of LicenseUser records if linked by email.

---

### Art. 16 — Right to Rectification

**Current state:** Users can change their own password (`POST /api/profile/change-password`). Admins can change role and activation status. No endpoint allows a user to correct their own email address or username.

**Gap:** Partial compliance. Core identity fields (email, username) cannot be self-corrected by data subjects.

**Risk:** Medium

**Recommendation:** Add `PATCH /api/profile` with authentication re-verification, allowing users to update email and username.

---

### Art. 17 — Right to Erasure ("Right to be Forgotten")

**Current state:** There is **no user account deletion endpoint** in the API. The available user management operations are limited to: `PATCH /api/users/:id/role`, `PATCH /api/users/:id/status` (deactivate/activate), and `POST /api/users/:id/reset-password`. There is no `DELETE /api/users/:id`. Deactivation (`active = false`) is the closest available action, but it leaves all personal data intact in the database.

For the `LicenseUser` entity, deletion is supported: `DELETE /api/licenses/:id/users/:userId` exists and performs a hard delete via `prisma.licenseUser.delete()`.

The audit log (`audit_logs`) is documented as insert-only (CLAUDE.md: "AuditLog — insert-only, never updated via UI (ISO 27001 immutability)") and has no deletion mechanism.

**Gap (Critical):** 

1. **No user account deletion.** A data subject's erasure request cannot be fulfilled without direct DBA intervention. This is a critical gap — there is no code path to remove a user's personal data from the `users`, `password_history`, and `trusted_devices` tables.

2. **Audit log erasure conflict.** The `audit_logs` table contains `user_email` (personal data) and is intentionally insert-only for ISO 27001 compliance. This creates a fundamental conflict between GDPR Art. 17 (erasure) and ISO 27001 audit trail immutability. The conflict is not acknowledged or resolved anywhere in the codebase or documentation.

**Risk:** High (no deletion endpoint), High (unresolved audit log conflict)

**Recommendation:**

1. Implement `DELETE /api/admin/users/:id` (ADMIN only) performing a structured erasure:
   - Hard-delete `trusted_devices` (cascade exists in schema: `onDelete: Cascade`)
   - Hard-delete `password_history` (cascade exists: `onDelete: Cascade`)
   - Hard-delete or pseudonymise the `users` record (set email to `deleted-{uuid}@redacted`, username to `[deleted]`, null all sensitive fields)
   - Retain the user `id` as a stub if FK references exist in `configuration_items` (businessOwner/technicalLead use `SetNull` — safe to delete)

2. **Audit log conflict resolution:** Adopt an accepted approach — pseudonymise rather than delete. When a user is erased, replace all `audit_logs.user_email` entries matching the deleted user's email with `[deleted-{uuid}]`. This preserves the audit trail's operational integrity (sequence, entity changes) while removing the identifying personal data. Document this approach in the privacy notice as the lawful balance between Art. 17 and the Art. 17(3)(b) exemption (compliance with a legal obligation requiring processing).

---

### Art. 18 — Right to Restriction of Processing

**Current state:** Account deactivation (`PATCH /api/users/:id/status`) provides a partial mechanism — a deactivated user cannot log in and their JWT is immediately rejected (the `authenticateToken` middleware checks `active = true` in the database on every request). However, this is an admin action, not a data-subject-initiated restriction.

**Gap:** No mechanism exists for a data subject to self-request restriction of processing. No "restriction flag" exists on user records.

**Risk:** Low (Art. 18 arises primarily in contested processing scenarios; in an employee context this is less common)

**Recommendation:** Document the administrative deactivation pathway as the operational procedure for processing restriction requests. Add a formal process in the privacy notice explaining how data subjects can request restriction.

---

### Art. 20 — Right to Data Portability

**Current state:** No data export endpoint exists for personal data. There is no `GET /api/profile/export` or equivalent. The application provides no machine-readable structured export (JSON, CSV) of a user's personal data.

**Gap:** Complete absence of portability mechanism. Portability applies where processing is based on consent or contract and carried out by automated means.

**Risk:** Medium

**Recommendation:** Implement `GET /api/profile/export` returning a JSON export of the authenticated user's personal data (profile, trusted devices summary, audit log entries). This fulfils Art. 20 for the contractual processing basis.

---

### Art. 25 — Data Protection by Design and by Default

**Current state:** Several positive by-design controls exist:
- `containsPii` flag on CI records (`configuration_items.contains_pii`) allows administrators to mark assets that hold personal data
- `dataClassification` enum (`PUBLIC | INTERNAL | CONFIDENTIAL | RESTRICTED`) on CIs supports data governance
- RBAC enforces minimum necessary access: VIEWERs can read but not write; audit logs are restricted to ADMIN/AUDITOR
- Passwords are never returned in API responses (the `CI_INCLUDE` select for user fields returns only `id, username, email`)
- MFA is mandatory by design for ADMIN accounts; non-admins are prompted once

**Gap:** 
- No by-default data minimisation for `LicenseUser` — DNI is an optional field but the schema and UI offer it without guidance on when it is necessary
- No privacy-by-default for `CI.user_dni` — the field exists in the schema with no documented data minimisation requirement
- No automated anonymisation of old records

**Risk:** Low–Medium

**Recommendation:** Add UI-level guidance (help text or tooltip) making clear that DNI collection in LicenseUser is optional and should only be used when legally required for license compliance. Consider removing `configuration_items.user_dni` from the data model.

---

### Art. 32 — Security of Processing

**Current state (positive controls evidenced in code):**

| Control | Implementation | Code reference |
|---|---|---|
| Password hashing | bcrypt, cost factor 12 | `index.ts:65`, `bcrypt.hash(pwd, BCRYPT_ROUNDS)` |
| MFA (TOTP) | speakeasy, mandatory for ADMIN | `index.ts:852–858` |
| JWT algorithm pinning | `{ algorithms: ['HS256'] }` | `index.ts:247` |
| Active-user check on every request | DB query in `authenticateToken` | `index.ts:264–276` |
| SQL injection prevention | Tagged template literals throughout | `index.ts` pattern |
| Rate limiting | 10/15min login, 300/min API | `index.ts:129–188` |
| Security headers | Helmet (X-Frame-Options, HSTS, etc.) | `index.ts:95–102` |
| CORS allowlist | Environment-configured | `index.ts:105–122` |
| TLS support | nginx TLS gateway, optional backend HTTPS | docker-compose.prod.yml |
| Trusted device binding | IP + User-Agent binding | `index.ts:795–807` |
| Password history | Last 20 hashes checked on change | `index.ts:375–411` |
| Common password dictionary | ~250 common passwords blocked | `index.ts:299–350` |
| SSO CSRF/nonce protection | Server-side state store, one-time use | `index.ts:544–552` |
| PKCE for SSO | `generateCodeVerifier`, `generateCodeChallenge` | `microsoftSso.ts` |

**Gaps:**
- JWT stored in `localStorage` is vulnerable to XSS token theft (should be `HttpOnly` cookie)
- No encryption at rest for the PostgreSQL database is documented (relies on OS/volume-level encryption if configured)
- No field-level encryption for `mfa_secret`, `mfa_pending_secret`, or `trusted_devices.token` (stored as plaintext in DB)
- LDAP can be configured with `LDAP_TLS_REJECT_UNAUTHORIZED=0` which disables certificate validation — credentials transmitted over unverified TLS

**Risk:** Medium (localStorage JWT), Low–Medium (at-rest encryption gap — depends on infrastructure), Low (field-level encryption — bcrypt mitigates password risk, TOTP secrets are low-sensitivity)

**Recommendation:**
1. Migrate frontend JWT storage to `HttpOnly; Secure; SameSite=Strict` cookies. This is the most impactful single security improvement for Art. 32.
2. Document and enforce OS/volume-level encryption at rest in the sysadmin manual as a deployment requirement.
3. Warn in documentation that `LDAP_TLS_REJECT_UNAUTHORIZED=0` should never be used outside of controlled internal CA environments.

---

### Art. 33/34 — Data Breach Notification

**Current state:** No breach detection, alerting, or notification workflow is built into the application. The application produces container logs (`docker logs`) and optional SMTP alerts for EOL/EOS conditions, but no security event alerting (e.g., multiple failed logins, anomalous data access). There is no documented incident response procedure in the sysadmin manual.

**Gap:** While Art. 33 obligations primarily fall on the organisation (data controller) rather than the software itself, the absence of any breach detection capability — no alerting on brute-force patterns beyond rate-limiting, no SIEM integration, no anomaly detection — makes the 72-hour notification window difficult to meet in practice. Failed login attempts are rate-limited but not logged to a queryable store.

**Risk:** Medium

**Recommendation:**
1. Log failed authentication attempts to a queryable store (e.g., a `security_events` table or structured log) for breach detection purposes.
2. Document an incident response procedure in `docs/SYSADMIN_MANUAL.md` covering: breach identification, 72-hour GDPR notification obligation to supervisory authority (Art. 33), and communication to affected data subjects (Art. 34).
3. Consider integrating with an external SIEM or monitoring tool (Prometheus alerts, Grafana Loki) for anomaly detection.

---

### Art. 35 — Data Protection Impact Assessment (DPIA)

See dedicated DPIA Assessment section below.

---

### Art. 44+ — International Data Transfers

**Current state:** Microsoft SSO integration (`GET /api/auth/sso/microsoft`) redirects users to Azure AD (Microsoft Entra ID). During this flow, the following data is transmitted to Microsoft's infrastructure: user credentials (handled entirely by Microsoft), the user's email address (returned in the ID token), the Microsoft OID (returned in the ID token), and the PKCE code exchange. Microsoft Azure services process data in Microsoft's global infrastructure, including US datacentres.

The application stores the Azure OID in `users.sso_external_id` after the SSO flow. The `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_CLIENT_SECRET` environment variables enable the integration.

**Gap:**
- No Data Processing Agreement (DPA) with Microsoft is referenced in the codebase or documentation. Microsoft's DPA for Microsoft 365 / Azure AD (available at microsoft.com/licensing/docs) should be formally executed.
- No Standard Contractual Clauses (SCCs) or adequacy decision reference exists in the documentation.
- The sysadmin manual does not alert operators to the international transfer implications of enabling SSO.

**Risk:** Medium (Microsoft has executed SCCs and holds Privacy Shield successor framework certification; the transfer is not unmitigated, but documentation of the DPA is required)

**Recommendation:**
1. Add a note in `docs/SYSADMIN_MANUAL.md` under the SSO configuration section stating that enabling Microsoft SSO constitutes a transfer of user authentication data to Microsoft (US) and requires a DPA under Art. 28 and SCCs or other transfer mechanism under Art. 46.
2. Reference Microsoft's Data Protection Addendum in the organisation's RoPA.
3. If LDAP with an external cloud provider is configured, apply the same analysis.

---

## Special Focus Areas

### 1. Audit Log Immutability vs. GDPR Erasure (Art. 17 conflict)

The `audit_logs` table is deliberately insert-only per ISO 27001 requirements (documented in CLAUDE.md: "AuditLog — insert-only, never updated via UI (ISO 27001 immutability)"). The schema confirms no UPDATE or DELETE operations are possible via the application layer. The table stores `user_email` as a personal data field directly identifying the actor.

This creates a direct conflict: ISO 27001 A.8.15 (logging) requires tamper-evident, complete audit trails, while GDPR Art. 17 requires erasure of personal data on request. Neither obligation can be fully satisfied simultaneously.

**Accepted resolution approach:** Pseudonymisation on erasure. When an account is deleted (under the recommended new `DELETE /api/admin/users/:id` endpoint), replace all `audit_logs.user_email` entries matching the deleted email with a pseudonymous token (e.g., `[deleted-{sha256(email+salt)}]`). This:
- Preserves the audit trail's chronological integrity, action sequence, and entity IDs (ISO 27001 requirement)
- Removes the direct identifier linking the trail to a natural person (GDPR requirement)
- Is defensible under Art. 17(3)(b): processing necessary for compliance with a legal obligation

**Implementation note:** The pseudonymisation token should be a salted hash of the original email (not the email itself, not a sequential ID), ensuring it cannot be reversed even by database administrators.

### 2. LicenseUser Personal Data

The `license_users` table stores: `name` (required), `dni` (optional, national ID number), `email` (optional). This data is used to track which employees are assigned named software licenses — a legitimate business purpose for license compliance management.

Key findings:
- A deletion endpoint exists: `DELETE /api/licenses/:id/users/:userId` performs hard delete via `prisma.licenseUser.delete()`
- Creation is ADMIN-only: `POST /api/licenses/:id/users` requires `requireAdmin`
- Reading is available to all authenticated roles: `GET /api/licenses/:id/users` uses only `authenticateToken`
- **No retention policy exists** — records persist indefinitely after license expiry
- **DNI collection lacks documented lawful basis** — it is optional in the schema but the UI offers it without guidance

**Recommendation:** Make DNI non-collectible by default (remove from schema or make it a separately-justified optional field with UI-level warning). Add a license expiry hook that automatically deletes associated `LicenseUser` records when a license status transitions to expired or is deleted.

### 3. Password History — Proportionality

The `password_history` table stores the last N (default 20, configurable via `PASSWORD_HISTORY_COUNT`) bcrypt hashes per user. This serves a legitimate security purpose: preventing password reuse, which is a NIST SP 800-63B requirement.

Assessment:
- The data stored is bcrypt hashes (cost factor 12), not plaintext passwords — these are cryptographically one-way
- Retaining 20 history entries is at the high end of industry practice (NIST recommends "last 8", many policies use 10–12)
- There is no time-based limit — a user who joined years ago and never changed their password still has all N hashes stored indefinitely
- `onDelete: Cascade` ensures history is deleted if the user record is deleted

**Recommendation:** The storage of bcrypt hashes is proportionate for security purposes and presents low re-identification risk. However, add a time-based limit: prune entries older than 2 years regardless of count. This reduces data retention while maintaining meaningful password history protection.

### 4. JWT in localStorage — Art. 32 Security Risk

The frontend stores JWT tokens in `localStorage` (documented in CLAUDE.md: "All paths issue a JWT (HS256, 8h) stored in localStorage"). `localStorage` is synchronously readable by any JavaScript executing on the page origin, making it a target for XSS attacks.

GDPR Art. 32 requires "appropriate technical measures" to ensure security of processing. Storing authentication tokens in a location vulnerable to script injection does not meet this standard when `HttpOnly` cookies are an available alternative.

**Risk:** Medium — XSS would require a content injection vulnerability, which is partially mitigated by Helmet headers, but no Content-Security-Policy is configured (explicitly disabled: `contentSecurityPolicy: false` in `index.ts:101`).

**Recommendation (priority):**
1. Enable and configure a Content-Security-Policy header (currently disabled)
2. Migrate to `HttpOnly; Secure; SameSite=Strict` cookies for JWT storage — this eliminates the XSS token theft vector entirely
3. These two changes together substantially improve Art. 32 compliance

### 5. Microsoft SSO — Data Processor Relationship

Microsoft acts as a data processor for the authentication flow. The PKCE-based token exchange transmits user identity claims to the backend. The backend stores the Azure OID (`oid` claim) permanently in `users.sso_external_id`.

**Key data flows:**
- Browser → Azure AD: user credentials (Microsoft processes, not accessible to CMDB)
- Azure AD → CMDB backend: `id_token` containing `oid`, `email`, `name`, `tid` claims
- CMDB backend stores: `email`, `oid` (as `sso_external_id`), derived `username`
- CMDB creates a `TrustedDevice` record automatically for SSO logins (IP, User-Agent)

**Art. 28 obligation:** A formal Data Processing Agreement with Microsoft for Azure AD / Entra ID is required. Microsoft's standard DPA covers this, but it must be actively executed (not merely available).

**Recommendation:** Confirm the organisation has executed Microsoft's Data Protection Addendum. Document the data flows in the RoPA. Review whether storing the Azure OID indefinitely (even after account deactivation) is necessary — this should be cleared on account deletion.

---

## DPIA Assessment

### Is a DPIA Required?

**Assessment: Yes — a DPIA is strongly recommended and likely required.**

Under Art. 35(1) GDPR, a DPIA is required where processing is "likely to result in a high risk to the rights and freedoms of natural persons." Article 35(3) lists specific triggers. The supervisory authority guidelines (WP29/EDPB) identify further criteria where two or more of the following apply:

| Criterion | Applicability |
|---|---|
| Evaluation/scoring of natural persons | No (primary purpose is IT asset management) |
| Automated decision-making with significant effects | No |
| Systematic monitoring | **Yes** — all user actions are logged with email + timestamp in `audit_logs` |
| Sensitive data (special categories) | Partial — DNI is a government identifier, not Art. 9 special category, but sensitive |
| Data processed at large scale | Depends on deployment size |
| Matching/combining datasets | Limited — LicenseUser email may match system user email |
| Data concerning vulnerable subjects | No |
| Innovative technology | **Yes** — MFA TOTP, SSO with Microsoft, LDAP auto-provisioning |
| Processing preventing data subjects from exercising rights | Potential — no deletion endpoint creates a practical barrier to Art. 17 |

**At minimum two criteria apply** (systematic monitoring + innovative technology), triggering the DPIA requirement under EDPB guidelines.

### High-Risk Processing Activities Requiring DPIA Scope

1. **Audit log collection with user email attribution** — systematic, comprehensive monitoring of all user actions; no retention limit; insert-only immutability creates erasure conflict
2. **National ID (DNI) collection in `license_users` and `configuration_items`** — disproportionate to stated purpose; no documented lawful basis
3. **Microsoft SSO integration** — international data transfer; automated user provisioning without explicit notice to data subjects
4. **LDAP auto-provisioning** — users are created in the system without direct interaction; no notification mechanism

### Recommended DPIA Scope

The DPIA should cover:
- All personal data categories in the Personal Data Inventory above
- The audit log immutability/erasure conflict and chosen resolution
- The Microsoft SSO data processor relationship and transfer mechanism
- The DNI collection justification or removal
- Retention periods for all categories
- The absence of user deletion and the remediation plan

---

## Priority Remediation Plan

Ordered by risk level and regulatory urgency:

### Priority 1 — Critical (address within 30 days)

| ID | Action | Article | Effort |
|---|---|---|---|
| R-01 | Implement user account deletion endpoint (`DELETE /api/admin/users/:id`) with cascaded erasure of `password_history`, `trusted_devices`, and pseudonymisation of `audit_logs.user_email` | Art. 17 | High |
| R-02 | Add an accessible privacy notice covering all data categories, legal bases, and data subject rights; present at first login | Arts. 13/14 | Medium |
| R-03 | Confirm and document Microsoft DPA execution; add transfer notice to sysadmin documentation | Arts. 28, 44+ | Low |

### Priority 2 — High (address within 60 days)

| ID | Action | Article | Effort |
|---|---|---|---|
| R-04 | Define and implement retention schedules for `audit_logs` (pseudonymise after N months), deactivated `users`, and `license_users` (delete on license expiry) | Art. 5(1)(e) | Medium |
| R-05 | Remove or restrict `configuration_items.user_dni` — document justification if retained | Arts. 5(1)(c), 6 | Low |
| R-06 | Formally document lawful bases for all processing activities in a RoPA register | Art. 6 | Low |
| R-07 | Commission and complete a DPIA covering the processing activities identified above | Art. 35 | High |

### Priority 3 — Medium (address within 90 days)

| ID | Action | Article | Effort |
|---|---|---|---|
| R-08 | Migrate JWT storage from `localStorage` to `HttpOnly; Secure; SameSite=Strict` cookies; enable Content-Security-Policy | Art. 32 | High |
| R-09 | Implement `GET /api/profile/my-data` (data subject access) and `GET /api/profile/export` (portability export) | Arts. 15, 20 | Medium |
| R-10 | Add `PATCH /api/profile` endpoint for self-service correction of email/username | Art. 16 | Low |
| R-11 | Add time-based retention limit to `password_history` (prune entries older than 24 months) | Art. 5(1)(e) | Low |
| R-12 | Log failed authentication events to a queryable store; document breach notification procedure in sysadmin manual | Arts. 33/34 | Medium |
| R-13 | Add UI guidance making clear that `license_users.dni` collection is optional and legally justified only when required | Arts. 5(1)(c), 25 | Low |

---

*End of GDPR Compliance Audit — CMDB Enterprise Platform v2.0.1*

*This document contains legally sensitive compliance findings. Distribution should be restricted to the Data Protection Officer, Legal team, and platform engineering leads.*

---

## Nuevos tratamientos — Subsistema RAG (v2.3)

Actualizacion: 2026-05-20. Esta seccion documenta la actividad de tratamiento introducida por el subsistema RAG / Asistente IA. La DPIA completa se encuentra en `docs/security/rag-dpia.md`.

### Actividad de tratamiento: Asistente IA con RAG

| Campo | Valor |
|---|---|
| Finalidad | Respuesta a consultas sobre documentos corporativos mediante recuperacion semantica con modelos de lenguaje y embeddings locales |
| Base juridica | Art. 6.1.f — interes legitimo (mejora de productividad interna); Art. 6.1.c — obligacion legal para el registro de auditoria ASK_RAG |
| Datos tratados | Chunks de texto de documentos (puede contener datos personales indirectos); historial de consultas del usuario identificado por email via JWT; identificadores de sesion (UUID) |
| Destinatarios | Sin transferencia a terceros. Procesamiento local mediante Ollama en contenedor Docker interno de la propia organizacion |
| Transferencias internacionales | Ninguna. Ollama se ejecuta en infraestructura local; los modelos se descargan del repositorio oficial en el momento del despliegue y no realizan llamadas externas en tiempo de ejecucion |
| Retension | Sesiones y mensajes de chat: 90 dias (cron diario). Chunks de documentos: vida del documento (cascade delete). AuditLog ASK_RAG: 1 año (cron existente configurable via `AUDIT_RETENTION_DAYS`) |
| Medidas tecnicas | ACL pre-kNN (`docVisibilitySqlCol`); hash SHA-256 de la query en AuditLog; `DELETE /api/chat/sessions/:id` para ejercicio del derecho de supresion; rate-limit 10 req/min/usuario; TLS 1.2+ en nginx; system prompt fijo anti-injection |
| DPIA realizada | Si — `docs/security/rag-dpia.md` (ISMS-DPIA-002, version 1.0, 2026-05-20) |
| Riesgo residual | Bajo |
