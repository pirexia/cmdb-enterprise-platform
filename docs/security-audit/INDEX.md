# Security & Compliance Audit Index — v2.0.2

**Audit date:** 2026-04-17 (original) / 2026-04-18 (remediation update)
**Platform version:** v2.0.2 (develop)
**Scope:** CMDB Enterprise Platform — backend API, frontend, nginx gateway, PostgreSQL, Docker infrastructure

## Reports

| Standard | File | Status |
|----------|------|--------|
| OWASP Top 10 (2021) | [owasp-top10.md](./owasp-top10.md) | ✅ Complete |
| ISO/IEC 27001:2022 | [iso27001.md](./iso27001.md) | ✅ Complete |
| NIS2 Directive (EU 2022/2555) | [nis2.md](./nis2.md) | ✅ Complete |
| ISO 22301:2019 (BCMS) | [iso22301.md](./iso22301.md) | ✅ Complete |
| GDPR / RGPD | [gdpr.md](./gdpr.md) | ✅ Complete |
| General Security Findings | [general-security.md](./general-security.md) | ✅ Complete |

## Top Findings (Cross-Report)

| Severity | Finding | Report | Status |
|----------|---------|--------|--------|
| ✅ Fixed | OS command injection in `POST /api/admin/certificates/csr` — OpenSSL Subject fields interpolated into `execAsync` shell call | owasp-top10, general-security | **Patched** in commit `613be53` (execFile replacement — closes #68) |
| ✅ Fixed | No user account deletion endpoint (`DELETE /api/admin/users/:id` missing) — GDPR Art. 17 erasure cannot be fulfilled | gdpr | **Patched** in commit `3ae7df1` (closes #70, #73) |
| ✅ Fixed | JWT stored in `localStorage` — XSS exposure risk | owasp-top10, general-security | **Patched** in commit `023328f` (HttpOnly cookie — closes #71) |
| ✅ Fixed | No ISO 27001 organizational layer (Information Security Policy, Risk Assessment, SoA, Incident Response Plan) | iso27001 | **Patched** in commit `9c8d76a` (closes #72) |
| ✅ Fixed | Deprecated `speakeasy` library (unmaintained, no security releases) | general-security | **Patched** in commit `2682216` (replaced with otplib — closes #74) |
| ✅ Fixed | No Content-Security-Policy header | owasp-top10, general-security | **Patched** in commit `0798208` (closes #76, #83) |
| ✅ Fixed | No GDPR Art. 13/14 privacy notice in application | gdpr | **Patched** in commit `50d622d` (closes #77) |
| ✅ Fixed | LDAP auth fallback behaviour undocumented; no policy control | general-security | **Patched** in commit `6a90aa7` (LDAP_STRICT_MODE — closes #78) |
| ✅ Fixed | IRP lacks NIS2 Art. 23 notification timelines | nis2 | **Patched** in commit `c975f1b` (closes #79) |
| ✅ Fixed | No DPIA conducted (GDPR Art. 35) | gdpr | **Patched** in commit `c975f1b` (closes #80) |
| ✅ Fixed | No formal RTO/RPO targets or BCP document (ISO 22301) | iso22301 | **Patched** in commit `6e6300c` (closes #81) |
| ✅ Fixed | nodemailer SMTP CRLF injection (GHSA-c7w3-x93f-qmm8) | general-security | Patched in commit `90aa3df` |
| ✅ Fixed | path-to-regexp ReDoS via Express (GHSA-j3q9-mxjg-w52f) | general-security | Patched in commit `90aa3df` |
| ✅ Fixed | Next.js HTTP request smuggling + CSRF bypass (16.1.6→16.2.4) | general-security | Patched in commit `90aa3df` |
| ✅ Fixed | xlsx prototype pollution + ReDoS (CVE-2023-30533) | general-security | Replaced with exceljs in commit `90aa3df` |
| 🟡 Open | Backend service port exposed on host in `docker-compose.prod.yml`, bypassing nginx TLS gateway | iso27001, general-security | **Under review** — verify with `docker ps` |
| 🟡 Open | DNI/national ID field in `license_users` lacks documented legal basis | gdpr | **Open** — decision required before production (see DPIA §3.2) |
| 🟡 Open | Backup files stored only on live host (no off-site replication) | iso22301 | **Open** — add rclone/S3 step (documented in BCP §4) |

## Audit Scope Notes

- Source reviewed: `backend/src/index.ts`, `frontend/`, `nginx/`, `docker-compose*.yml`, `backend/prisma/schema.prisma`
- Codebase commit at time of audit: `6cb8338`
- Remediation commits applied through: `6e6300c` (develop branch)
- Auth flows: local (bcrypt), LDAP/AD, Microsoft 365 SSO (PKCE + JWKS)
- Data classification: CMDB asset data, contracts, licenses, documents, user PII
- Infrastructure: Docker Compose (dev + prod), nginx TLS gateway, PostgreSQL 15/16
- Post-audit security patches applied in commit `90aa3df` (npm vulnerabilities: nodemailer, path-to-regexp, Next.js, xlsx removal)
- Security hardening applied in commits `613be53` through `6e6300c` (issues #68–#81, #83)
