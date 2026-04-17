# Security & Compliance Audit Index — v2.0.1

**Audit date:** 2026-04-17
**Platform version:** v2.0.1
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
| 🔴 Critical | OS command injection in `POST /api/admin/certificates/csr` — OpenSSL Subject fields interpolated into `execAsync` shell call | owasp-top10, general-security | **Open** |
| 🔴 Critical | Backend service port exposed on host in `docker-compose.prod.yml`, bypassing nginx TLS gateway | iso27001, general-security | **Open** |
| 🟠 High | No user account deletion endpoint (`DELETE /api/users/:id` missing) — GDPR Art. 17 erasure cannot be fulfilled | gdpr | **Open** |
| 🟠 High | JWT stored in `localStorage` — XSS exposure risk | owasp-top10, general-security | **Open** |
| 🟠 High | No ISO 27001 organizational layer (Information Security Policy, Risk Assessment, SoA, Incident Response Plan) | iso27001 | **Open** |
| ✅ Fixed | nodemailer SMTP CRLF injection (GHSA-c7w3-x93f-qmm8) | general-security | Patched in commit `90aa3df` |
| ✅ Fixed | path-to-regexp ReDoS via Express (GHSA-j3q9-mxjg-w52f) | general-security | Patched in commit `90aa3df` |
| ✅ Fixed | Next.js HTTP request smuggling + CSRF bypass (16.1.6→16.2.4) | general-security | Patched in commit `90aa3df` |
| ✅ Fixed | xlsx prototype pollution + ReDoS (CVE-2023-30533) | general-security | Replaced with exceljs in commit `90aa3df` |

## Audit Scope Notes

- Source reviewed: `backend/src/index.ts`, `frontend/`, `nginx/`, `docker-compose*.yml`, `backend/prisma/schema.prisma`
- Codebase commit at time of audit: `6cb8338`
- Auth flows: local (bcrypt), LDAP/AD, Microsoft 365 SSO (PKCE + JWKS)
- Data classification: CMDB asset data, contracts, licenses, documents, user PII
- Infrastructure: Docker Compose (dev + prod), nginx TLS gateway, PostgreSQL 15/16
- Post-audit security patches applied in commit `90aa3df` (npm vulnerabilities: nodemailer, path-to-regexp, Next.js, xlsx removal)
