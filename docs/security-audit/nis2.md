# NIS2 Directive (EU 2022/2555) Compliance Audit — CMDB Enterprise Platform v2.0.1

**Audit date:** 2026-04-17
**Standard:** NIS2 Directive (EU) 2022/2555, Article 21
**Scope:** CMDB Enterprise Platform v2.0.1
**Auditor:** Compliance Review — DevSecOps

---

## Executive Summary

The CMDB Enterprise Platform demonstrates a strong baseline security posture relative to NIS2 Article 21 requirements, with well-implemented cryptographic controls, multi-factor authentication, structured audit logging, and network segmentation via Docker. The platform's most significant NIS2 gap lies in the absence of a formal, documented incident response plan (Article 21(2)(b)) — alerting via email is implemented but there is no structured playbook for classification, escalation, or 24-hour regulatory notification. Supply chain security (Article 21(2)(d)) is partially addressed through `npm audit`, but lacks a formal Software Bill of Materials (SBOM), third-party risk assessments for external API integrations (endoflife.date, CrowdStrike, Greenbone), and a vendor security assessment process. Governance gaps across risk analysis documentation, training programmes, and cryptographic key lifecycle management reduce the overall compliance level from operational to partial.

---

## Compliance Summary

| Article 21 Measure | Topic | Status | Risk |
|---|---|---|---|
| 21(2)(a) | Risk analysis and information system security policies | Partial | Medium |
| 21(2)(b) | Incident handling | Partial | High |
| 21(2)(c) | Business continuity, backups, DR, crisis management | Partial | Medium |
| 21(2)(d) | Supply chain security | Partial | High |
| 21(2)(e) | Security in acquisition, development, and maintenance | Compliant | Low |
| 21(2)(f) | Effectiveness of cybersecurity measures | Partial | Medium |
| 21(2)(g) | Cyber hygiene practices and training | Partial | Medium |
| 21(2)(h) | Cryptography and encryption policies | Partial | Medium |
| 21(2)(i) | Human resources security, access control, asset management | Compliant | Low |
| 21(2)(j) | MFA, continuous authentication, secured communications | Compliant | Low |

---

## Detailed Findings

---

### Article 21(2)(a) — Policies on Risk Analysis and Information System Security

#### Current State

The platform implements several technical controls that implicitly reflect risk-based decisions: Zod schema validation on all inputs, Helmet security headers (X-Content-Type-Options, X-Frame-Options, HSTS, Referrer-Policy), strict CORS origin allow-listing, rate limiting (10 login attempts / 15 min; 300 API requests / min), bcrypt password hashing at cost factor 12, JWT algorithm pinning to HS256, and RBAC with three roles (ADMIN, AUDITOR, VIEWER). The existing `SECURITY_AUDIT.md` maps controls to ISO 27001:2022 Annex A and documents vulnerability remediation history across versions up to v1.7.1. CIs in the data model carry `dataClassification` (PUBLIC/INTERNAL/CONFIDENTIAL/RESTRICTED), `businessImpact`, `recoveryPriority`, `spofRisk`, and `containsPii` fields, indicating risk metadata is captured at the asset level.

#### Gap

No formal Information Security Risk Assessment document (per ISO 27005 or equivalent methodology) is present in the repository. The `SECURITY_AUDIT.md` is an implementation record rather than a risk register. NIS2 Article 21(2)(a) requires a documented, periodically reviewed policy on risk analysis — there is no evidence of a threat model, risk appetite statement, or risk treatment plan external to the code. The existing document is also versioned inconsistently (v1.0.0 through v1.4.0 with different dates for the same `1.2.0` label).

#### Risk Level

**Medium** — Technical controls are sound, but lack of a formal risk management policy creates audit and regulatory exposure.

#### Recommendation

1. Produce a formal Information Security Risk Assessment using ISO 27005 or NIST SP 800-30, covering the CMDB platform as a critical IT infrastructure asset.
2. Maintain a risk register (threats, likelihood, impact, treatment) reviewed at least annually or after major changes.
3. Define and publish an Information Security Policy document that references the risk register and is approved by management.
4. Consolidate the `SECURITY_AUDIT.md` revisions with consistent version numbering.

---

### Article 21(2)(b) — Incident Handling (Detection, Response, Notification)

#### Current State

The email alerting engine (`emailService.ts`) provides proactive daily detection of EoL/EoS asset expiry, contract expiry, and critical/high-severity unresolved vulnerabilities, dispatched at 08:30 AM daily via nodemailer SMTP. Alert categories include `expired`, `critical`, and `warning` severity tiers. The `audit_logs` table provides an append-only record of all authenticated actions (`CREATE_CI`, `LOGIN_SSO`, `UPDATE_VULN_STATUS`, `DELETE`, etc.) which constitutes forensic evidence for incident investigation. The backend logs all errors to stderr (`console.error`), and deactivated user tokens are rejected immediately without waiting for JWT expiry.

#### Gap

The platform provides alerting infrastructure but no formal incident response plan (IRP). There is no documented:
- Incident classification taxonomy (e.g., P1–P4 severity tiers for the platform itself)
- Escalation chain or named incident manager roles
- 24-hour initial notification procedure required by NIS2 Article 23 for significant incidents
- 72-hour detailed report procedure
- Post-incident review / lessons-learned process

The alert engine covers asset-level events (EOL, vulnerabilities), but there is no monitoring or alerting for platform-level security incidents such as authentication anomalies (e.g., repeated login failures per user, impossible travel), privilege escalation, or unusual API access patterns. The `audit_logs` default retention of 365 days (configurable via `AUDIT_RETENTION_DAYS`) and the purge cron at 03:00 AM means logs could be deleted before a long-running incident investigation concludes if the default is not overridden.

#### Risk Level

**High** — Absence of a documented IRP with NIS2-compliant notification timelines is a direct regulatory non-conformity for entities in scope.

#### Recommendation

1. Draft and approve an Incident Response Plan that includes: incident scope definition, classification criteria, roles and responsibilities, NIS2 Article 23 notification timelines (24 h early warning, 72 h full report, 1 month final report), and communication templates.
2. Integrate authentication anomaly detection: correlate repeated `LOGIN` failures in `audit_logs` and alert on thresholds (e.g., >5 failures for the same email within 10 minutes).
3. Set `AUDIT_RETENTION_DAYS` to a minimum of 730 days (2 years) in production to support incident investigations and legal hold requirements.
4. Establish a Security Operations contact point (named CISO or equivalent) as required by NIS2 Article 20(1).

---

### Article 21(2)(c) — Business Continuity, Backups, Disaster Recovery, Crisis Management

#### Current State

The platform ships `scripts/db-backup.sh`: a `set -euo pipefail`-hardened bash script that performs `pg_dump | gzip -9` into timestamped files under `BACKUP_DIR` (default `/opt/cmdb/backups`), with configurable retention (default 30 days). The sysadmin manual documents cron configuration for daily 02:00 AM backups. Docker Compose production configuration uses `restart: unless-stopped` on all services and PostgreSQL has a health check (`pg_isready`) with 5 retries. The `update.sh` script creates `rollback/<timestamp>` git tags before any change and performs automatic rollback if Docker build or health check fails within 120 seconds. Named Docker volumes (`cmdb-postgres-data-prod`, `cmdb-tls-certs`) persist data across container lifecycle events.

#### Gap

- Backup files are stored on the **same host** as the running containers (default `/opt/cmdb/backups`). A host-level failure, ransomware attack, or disk failure would destroy both the live database and all backups simultaneously. NIS2 requires resilience against such scenarios.
- No documented Recovery Time Objective (RTO) or Recovery Point Objective (RPO) targets exist.
- The document storage directory (`DOCUMENTS_STORAGE_PATH`) is explicitly called out in the sysadmin manual as requiring inclusion in backups, but `db-backup.sh` covers only PostgreSQL — no script backs up the document binary store.
- No Disaster Recovery runbook exists for the scenario where the host is unavailable (e.g., provisioning a replacement host, restoring from off-site backup, re-issuing TLS certificates).
- No crisis management procedure or Business Continuity Plan (BCP) document is present.
- The backup script does not verify the integrity of completed archives (e.g., `gunzip -t` test after write).

#### Risk Level

**Medium** — Core backup mechanics are in place but off-site replication, document backup, and a tested DR runbook are absent.

#### Recommendation

1. Configure off-site backup replication: use `rsync`, `rclone`, or S3-compatible object storage to copy compressed database archives to a geographically separated location immediately after each successful backup.
2. Extend `db-backup.sh` (or create a companion script) to archive the `DOCUMENTS_STORAGE_PATH` directory, either via `tar -czf` or NFS snapshot.
3. Add post-write integrity verification to `db-backup.sh`: `gunzip -t "${BACKUP_FILE}" || { echo "Backup integrity check FAILED"; exit 1; }`.
4. Define and document RTO and RPO targets (suggested: RPO ≤ 24 h, RTO ≤ 4 h for production).
5. Produce a DR runbook covering: host provisioning, Docker environment restore, volume/data restore sequence, TLS certificate re-issue, and smoke-test checklist.
6. Test the DR procedure at least once annually and document the test result.

---

### Article 21(2)(d) — Supply Chain Security

#### Current State

The `SECURITY_AUDIT.md` records `npm audit` results for both `backend/` and `frontend/` packages as 0 vulnerabilities (as of 2026-03-15). The backend integrates three external data-source APIs: `endoflife.date` (EoL/EoS data via `eolService.ts`), CrowdStrike Falcon (vulnerability import), and Greenbone OpenVAS (vulnerability import). External LDAP/AD directories and Microsoft Azure AD (via JWKS) are also external dependencies. The Microsoft SSO integration validates `tid`, `iss`, `aud`, `nonce`, and email domain in ID tokens, and uses a 24-hour JWKS cache. LDAP input is escaped per RFC 4514/4515 via `escapeLdap()`.

#### Gap

- No formal Software Bill of Materials (SBOM) exists (e.g., CycloneDX or SPDX format). NIS2 Recital 58 and the linked CRA (Cyber Resilience Act) expect supply chain transparency.
- No third-party risk assessment or contractual security requirements are documented for the three external API integrations. If endoflife.date, CrowdStrike, or Greenbone return malformed or adversarial data, the only mitigation in the codebase is LIKE-pattern escaping (for CI matching). There is no input size limit, schema validation, or circuit-breaker pattern for external API responses.
- `npm audit` is run manually and its last recorded date (2026-03-15) is over a month before this audit. There is no automated dependency scanning integrated into a CI/CD pipeline.
- The base images (`postgres:16-alpine`, Node.js Alpine in Dockerfiles) are not pinned to digest hashes — a supply chain compromise of the upstream image tag would be pulled on the next `--no-cache` build.
- `LDAP_TLS_REJECT_UNAUTHORIZED=0` is documented as a valid configuration option in the sysadmin manual, which disables certificate verification for LDAP connections. This creates a man-in-the-middle risk in the supply chain of authentication data.

#### Risk Level

**High** — External data integrations lack formal risk assessment; no SBOM; image digests not pinned.

#### Recommendation

1. Generate and publish an SBOM in CycloneDX JSON format using `cdxgen` or `npm sbom`, and refresh it on every release.
2. Conduct a third-party risk assessment for each external integration (endoflife.date, CrowdStrike, Greenbone), documenting: data flows, trust boundaries, authentication, and fallback behaviour when the service is unavailable.
3. Add schema validation and maximum response size limits for all external API responses in `eolService.ts` and integration import handlers.
4. Pin Docker base image references to SHA256 digests in all Dockerfiles.
5. Integrate `npm audit --audit-level=high` and a container image scanning step (e.g., Trivy) into the CI/CD pipeline to catch vulnerabilities before deployment.
6. Prohibit `LDAP_TLS_REJECT_UNAUTHORIZED=0` in production by failing startup if this variable is set alongside `USE_LDAP=true` and `NODE_ENV=production`.

---

### Article 21(2)(e) — Security in Network and Information Systems Acquisition, Development, and Maintenance

#### Current State

The backend uses Zod for input validation on all user-facing schemas (`LoginSchema`, `CICreateSchema`, `ContractCreateSchema`, `LicenseSchema`). All database queries use Prisma tagged-template literals (`$queryRaw` / `$executeRaw`) with parameterized inputs — string concatenation and `$queryRawUnsafe` are prohibited by project policy. LIKE-pattern metacharacters (`%`, `_`, `\`) are escaped before interpolation. File uploads use multer with magic-byte validation and UUID-only filenames. HTTP security headers are applied via Helmet. Stack traces and raw Prisma error objects are never returned in API responses (remediated in v1.6.4 across 50+ catch blocks). The `SECURITY_AUDIT.md` documents a structured remediation history across 20+ named vulnerabilities from v1.1.0 through v1.7.1.

#### Gap

- No formal Secure Development Lifecycle (SDL) or Security Development Policy document exists. The controls are implemented correctly but informally.
- Content Security Policy (CSP) is explicitly disabled in the Helmet configuration (`contentSecurityPolicy: false`) with the comment "Relax CSP for API-only server." The backend does not serve HTML, making this low risk for the backend itself, but the frontend's CSP posture is not verified in this audit.
- TypeScript strict mode is used, but there is no evidence of static analysis tooling (e.g., ESLint security plugins, Semgrep, CodeQL) in the pipeline beyond `tsc`.
- There is no documented security code review process or penetration testing schedule.

#### Risk Level

**Low** — Technical controls are well-implemented; gaps are governance and documentation in nature.

#### Recommendation

1. Formalise a Secure Development Lifecycle policy referencing the existing control standards and requiring security review for PRs that touch authentication, authorization, or data handling code.
2. Schedule annual penetration testing against the running platform by an independent party.
3. Add ESLint security plugins (`eslint-plugin-security`, `eslint-plugin-node`) to the CI pipeline.
4. Enable CSP headers on the frontend (Next.js `Content-Security-Policy` header) to restrict script sources.

---

### Article 21(2)(f) — Policies and Procedures for Assessing Effectiveness of Cybersecurity Measures

#### Current State

The platform has a `GET /health` endpoint returning `{"status":"ok","timestamp":"..."}` and the sysadmin manual documents a basic monitoring table (response time, memory, error rate, certificate expiry, disk usage). The `db-backup.sh` script logs success/failure to `/var/log/cmdb-backup.log`. The `update.sh` script performs a 120-second health check after deployment. The `SECURITY_AUDIT.md` documents that `npm audit` was run with 0 findings.

#### Gap

- The `/health` endpoint only confirms the process is alive — it does not check database connectivity, SMTP reachability, or disk space. A deeper health check (liveness vs. readiness) would provide more meaningful signal.
- No metrics collection (Prometheus, Datadog, etc.) or alerting on security-relevant metrics (authentication failure rates, 4xx/5xx error rates, rate-limit trigger frequency) is implemented.
- No formal cybersecurity effectiveness review process (KPIs, quarterly review cadence) is documented.
- `npm audit` is run on an ad-hoc basis; no automated scan is triggered on PR merge or weekly schedule.

#### Risk Level

**Medium** — Basic health checking exists but lacks depth for a security-effectiveness measurement programme.

#### Recommendation

1. Enhance `/health` to perform and report on: DB query round-trip, SMTP connectivity, disk space on `DOCUMENTS_STORAGE_PATH` and backup volume.
2. Instrument key security metrics: authentication failure rate per IP/user, rate-limit trigger count, 4xx/5xx rates — expose via a `/api/admin/metrics` endpoint (admin-only) or ship to an external monitoring system.
3. Define and track monthly KPIs: mean time to patch critical CVEs, backup success rate, MFA adoption rate, audit log completeness.
4. Conduct a formal cybersecurity effectiveness review at least semi-annually.

---

### Article 21(2)(g) — Basic Cyber Hygiene Practices and Cybersecurity Training

#### Current State

Strong password hygiene is enforced server-side: minimum 16 characters for ADMIN, 12 for VIEWER/AUDITOR; mandatory uppercase, lowercase, digit, and special character; a ~100-entry common-password blocklist; and a 20-entry password history (all configurable). A real-time strength indicator is shown in the frontend. Default credentials (`admin@cmdb.local` / `Admin1234!`) are documented in the sysadmin manual with an explicit warning to change them immediately. The system auto-provisions LDAP and SSO users with the `VIEWER` role (least privilege). Deactivated users cannot authenticate even with a valid JWT.

#### Gap

- No cybersecurity training programme or awareness records are documented. NIS2 Article 21(2)(g) explicitly requires training for employees with access to network and information systems.
- No account lockout mechanism exists: the rate limiter (10 attempts / 15 min per IP) is IP-based. A distributed brute-force attack from multiple IPs, or an attack on a specific user account from a single IP that uses valid credentials for other accounts to stay under the threshold, is not mitigated by per-account lockout.
- No session management policy documents maximum concurrent sessions, session inactivity timeout, or geographic anomaly detection.
- The sysadmin manual documents the default password in plain text which, while intended as a reminder to change it, represents a minor information disclosure risk if the manual is shared broadly.

#### Risk Level

**Medium** — Technical password hygiene is strong; governance and training programme are absent.

#### Recommendation

1. Establish a cybersecurity awareness training programme for all users of the CMDB platform and document completion records.
2. Implement per-user account lockout (e.g., 10 consecutive failures → 30-minute lockout stored in the `users` table) in addition to the existing IP-based rate limiting.
3. Define and document a Session Management Policy covering maximum session duration, inactivity timeout, and concurrent session limits.
4. Remove the plain-text default password from the sysadmin manual; replace with a reference to the install script's first-run credential generation flow.

---

### Article 21(2)(h) — Policies and Procedures for Cryptography and Encryption

#### Current State

The platform uses: HS256 JWT signing with a configurable secret (minimum recommended 48 characters, enforced at startup in production); bcrypt password hashing at cost factor 12 (NIST SP 800-63B compliant, configurable via `BCRYPT_ROUNDS`); TOTP-based MFA per RFC 6238 via `speakeasy`; RSA 2048-bit TLS certificates (SHA-256, SAN) for HTTPS; HSTS enabled when `HTTPS_ENABLED=true` (maxAge 31536000, includeSubDomains, preload). TLS certificate generation is provided via `scripts/generate-certs.sh`. The `SECURITY_AUDIT.md` references ISO 27001 A.10.1 for the cryptographic controls mapping.

#### Gap

- **No formal cryptographic policy document exists.** The controls are implemented but not governed by a documented policy covering algorithm selection, key lifetimes, rotation schedules, and procedures.
- **JWT uses HS256 (symmetric HMAC)**, which means the same secret is used to both sign and verify tokens. If the secret is compromised, all active sessions can be forged without detection. Asymmetric signing (RS256 or ES256) would allow public-key verification in distributed components without exposing the signing key.
- **JWT key rotation** has no documented procedure. Rotating `JWT_SECRET` invalidates all active sessions simultaneously — there is no graceful key rotation with overlapping validity windows.
- **TLS certificates default to self-signed (RSA 2048-bit, 365-day validity).** While this is appropriate for intranet deployments, there is no automated renewal mechanism (e.g., Let's Encrypt / Certbot), and certificate expiry monitoring is manual (noted in the sysadmin monitoring table but not automated as an alert).
- The SMTP transport uses TLS `rejectUnauthorized: process.env.NODE_ENV === 'production'` — this is correct for production but means email alerts in development mode may traverse unencrypted or unverified connections, potentially leaking asset inventory data.
- `LDAP_TLS_REJECT_UNAUTHORIZED=0` disables certificate verification for LDAP, which undermines transport-layer encryption guarantees.

#### Risk Level

**Medium** — Implementation is technically sound but lacks governing policy, key rotation procedures, and automated certificate lifecycle management.

#### Recommendation

1. Produce a Cryptographic Controls Policy (aligned with ISO 27001 A.10.1) specifying: approved algorithms (AES-256 for at-rest, TLS 1.2+ for in-transit, HS256 minimum or RS256 preferred for tokens), key lifetimes, rotation schedules, and key storage requirements.
2. Migrate JWT signing from HS256 to RS256 to enable asymmetric verification and safer key distribution.
3. Document and automate a JWT secret rotation procedure that maintains a brief dual-validity window.
4. Integrate Let's Encrypt / Certbot for automatic TLS certificate renewal and add certificate-expiry monitoring to the email alert engine.
5. Enforce LDAP TLS certificate validation in production; reject startup if `LDAP_TLS_REJECT_UNAUTHORIZED=0` with `USE_LDAP=true` and `NODE_ENV=production`.

---

### Article 21(2)(i) — Human Resources Security, Access Control Policies, Asset Management

#### Current State

RBAC is enforced on every protected endpoint via the `authenticateToken` + `requireAdmin` / `requireAudit` middleware chain. Three roles are defined: `ADMIN` (full write), `AUDITOR` (read + audit log access), `VIEWER` (read-only). All write operations require ADMIN role. Deactivated users are rejected on every request (DB check, not just JWT expiry). User creation and role changes are logged in `audit_logs`. LDAP and SSO users are auto-provisioned with the minimum `VIEWER` role. The CI schema includes `businessOwner`, `technicalLead`, `containsPii`, and `dataClassification` fields to support asset ownership and data classification workflows. The sysadmin manual documents a procedure for promoting LDAP users to ADMIN via the web UI.

#### Gap

- No formal Access Control Policy document exists. The technical enforcement is strong, but NIS2 requires documented policies.
- No periodic access review process is documented (e.g., quarterly review of all users with ADMIN role).
- No separation of duties control prevents a single ADMIN from creating a user, granting ADMIN rights, and performing sensitive operations without a second approver.
- No offboarding procedure is documented: when an employee leaves, the manual steps to deactivate their account are not captured in a runbook.
- Asset management relies on manual data entry; there is no automated discovery integration to detect unregistered CIs.

#### Risk Level

**Low** — Technical controls are compliant; documentation and process gaps are the primary residual risk.

#### Recommendation

1. Formalise an Access Control Policy covering: role definitions, provisioning and deprovisioning procedures, periodic access review schedule (at minimum annual), and separation of duties requirements.
2. Implement a user account review report: `GET /api/admin/access-review` listing all ADMIN users, last login date, and MFA status, to support periodic reviews.
3. Document an employee offboarding checklist that includes CMDB account deactivation as a required step.
4. Consider adding a two-person rule for ADMIN role assignment (require a second ADMIN to confirm role elevation).

---

### Article 21(2)(j) — Use of MFA, Continuous Authentication, Secured Communications, Emergency Communications

#### Current State

This is the strongest area of compliance. Mandatory TOTP-based MFA (RFC 6238, `speakeasy`) is enforced for all ADMIN users: on first login without MFA configured, a limited JWT (`mfaSetupRequired: true`, 15-minute TTL) is issued; this token is accepted only by `/api/auth/mfa/setup` and `/api/auth/mfa/enable`. MFA setup cannot be bypassed. Non-admin users receive a one-time MFA setup suggestion. Trusted device tokens (32-byte cryptographically random, bound to IP + User-Agent, 30-day TTL) bypass TOTP on subsequent logins. Microsoft SSO (OAuth2 + PKCE, JWKS signature validation, `tid`/`aud`/`iss`/`nonce`/domain validation) and LDAP/AD authentication are supported. SSO logins automatically receive a trusted device. JWT tokens expire after 8 hours and are checked for revocation on every request. The backend-to-backend communication is on an internal Docker network (`cmdb-internal`) not exposed to the host. TLS termination is available with HSTS support.

#### Gap

- MFA is mandatory only for ADMIN users. NIS2 Article 21(2)(j) requires MFA or continuous authentication "where appropriate" — for a CMDB managing critical IT infrastructure, AUDITOR and VIEWER users who can read sensitive asset and vulnerability data should also be required to use MFA.
- Emergency communications: no out-of-band communication channel or emergency access procedure is documented. If the CMDB itself is unavailable, there is no offline backup of the incident contact list or emergency procedures.
- The trusted device mechanism binds to IP and User-Agent, but both are trivially spoofable; they provide a friction increase rather than a strong second factor.
- JWT tokens are stored in `localStorage` on the frontend, which is accessible to JavaScript (XSS risk). A hardened deployment should consider `httpOnly` cookies.

#### Risk Level

**Low** — MFA enforcement for ADMINs is exemplary; gaps are in scope (non-admin MFA) and secondary controls.

#### Recommendation

1. Extend mandatory MFA to AUDITOR role, given that AUDITOR users have exclusive access to sensitive audit log data.
2. Implement configurable MFA enforcement by role via an environment variable (e.g., `MFA_REQUIRED_ROLES=ADMIN,AUDITOR`).
3. Document an emergency access procedure: offline printed copy of the CMDB admin credentials (sealed, in a physically secured location), and a break-glass account process.
4. Evaluate migrating JWT storage from `localStorage` to `httpOnly` Secure cookies to reduce XSS token-theft risk.

---

## Annex A — Evidence Reference

| Evidence Item | Location |
|---|---|
| JWT algorithm pinning (HS256) | `backend/src/index.ts` lines 247, 639, 791, 856 |
| MFA mandatory enforcement for ADMIN | `backend/src/index.ts` lines 852–857 |
| Trusted device IP/UA binding (Issue #25) | `backend/src/index.ts` lines 799–829 |
| Rate limiting configuration | `backend/src/index.ts` lines 129–188 |
| bcrypt cost factor 12 | `backend/src/index.ts` line 65 |
| Password policy enforcement | `backend/src/index.ts` lines 357–387 |
| Helmet security headers | `backend/src/index.ts` lines 90–102 |
| Audit log schema and cron purge | `backend/src/index.ts` lines 3532–3562 |
| Daily alert cron (08:30 AM) | `backend/src/index.ts` lines 3514–3528 |
| SMTP TLS enforcement in production | `backend/src/services/emailService.ts` line 376 |
| Docker network isolation | `docker-compose.prod.yml` lines 144–152 |
| `restart: unless-stopped` on all services | `docker-compose.prod.yml` lines 9, 33, 53, 107 |
| PostgreSQL health check | `docker-compose.prod.yml` lines 38–43 |
| Database backup script | `scripts/db-backup.sh` |
| npm audit results (0 vulnerabilities) | `SECURITY_AUDIT.md` lines 171–177 |
| SSO PKCE + JWKS validation | `backend/src/services/microsoftSso.ts` |
| LDAP RFC 4514/4515 escaping (Issue #18) | `backend/src/services/ldap.ts` |

---

## Revision History

| Date | Version | Author | Notes |
|---|---|---|---|
| 2026-04-17 | 1.0.0 | Compliance Review — DevSecOps | Initial NIS2 audit against v2.0.1 |
