# Statement of Applicability (SoA)
**Document ID:** ISMS-SOA-001  
**Version:** 1.0  
**Status:** Draft  
**Owner:** [REPLACE: CISO]  
**Standard:** ISO/IEC 27001:2022 Annex A

---

Key: ✅ Applicable & Implemented | ⚠️ Applicable — Partial | ❌ Excluded (with justification)

| Control | Title | Status | Notes |
|---------|-------|--------|-------|
| A.5.1 | Policies for information security | ⚠️ Partial | ISP document created (this repo); pending management approval |
| A.5.2 | Information security roles and responsibilities | ⚠️ Partial | RBAC implemented; org chart and formal RACI pending |
| A.5.3 | Segregation of duties | ✅ | ADMIN/AUDITOR/VIEWER RBAC enforced in code |
| A.5.5 | Contact with authorities | ⚠️ Partial | [REPLACE: designate contact for CERT/law enforcement] |
| A.5.7 | Threat intelligence | ❌ Excluded | Out of scope for current platform size |
| A.5.9 | Inventory of information assets | ✅ | The platform IS the asset inventory (CMDB) |
| A.5.12 | Classification of information | ⚠️ Partial | `data_classification` field on CI records; formal policy pending |
| A.5.14 | Information transfer | ✅ | TLS 1.2+ enforced by nginx; no unencrypted data transfer |
| A.5.15 | Access control | ✅ | Role-based access, JWT auth, MFA for admins |
| A.5.17 | Authentication information | ✅ | bcrypt passwords, MFA, password history/policy |
| A.5.18 | Access rights | ✅ | Provisioning/deprovisioning via admin UI; GDPR erasure endpoint |
| A.5.19 | Information security in supplier relationships | ⚠️ Partial | Supplier agreement template created; pending execution |
| A.5.23 | Information security for use of cloud services | ⚠️ Partial | Azure AD (SSO) used; Microsoft DPA covers compliance |
| A.5.24 | Information security incident management planning | ⚠️ Partial | IRP document created (this repo); drills not yet conducted |
| A.5.25 | Assessment and decision on information security events | ⚠️ Partial | Audit log + alert engine; SIEM integration pending |
| A.5.26 | Response to information security incidents | ⚠️ Partial | IRP defines response steps; tabletop exercise pending |
| A.5.28 | Collection of evidence | ✅ | Immutable audit_logs (RLS), insert-only by design |
| A.5.29 | Information security during disruption | ⚠️ Partial | Restart policies in Docker Compose; DR plan pending |
| A.5.33 | Protection of records | ✅ | audit_logs RLS blocks deletion; backups policy pending |
| A.5.35 | Independent review | ❌ Excluded | Security audit conducted internally (v2.0.1); external audit pending |
| A.6.1 | Screening | ⚠️ Partial | [REPLACE: background check policy for admin staff] |
| A.6.2 | Terms of employment | ⚠️ Partial | [REPLACE: NDA / AUP in employment contracts] |
| A.6.3 | Information security awareness | ⚠️ Partial | [REPLACE: training programme; track annual completion] |
| A.6.4 | Disciplinary process | ⚠️ Partial | [REPLACE: reference HR disciplinary policy] |
| A.6.7 | Remote working | ✅ | TLS-only access; no VPN requirement due to HTTPS gateway |
| A.6.8 | Information security event reporting | ⚠️ Partial | IRP defines reporting channel; tested annually |
| A.7.1 | Physical security perimeters | ❌ Excluded | Cloud / co-lo hosting — defer to hosting provider controls |
| A.8.2 | Privileged access rights | ✅ | ADMIN role restricted; mandatory MFA; audit log on all writes |
| A.8.3 | Information access restriction | ✅ | RBAC: VIEWER read-only, AUDITOR read+audit, ADMIN full write |
| A.8.5 | Secure authentication | ✅ | HttpOnly JWT cookie, MFA, bcrypt, password policy |
| A.8.7 | Protection against malware | ✅ | No deprecated dependencies (speakeasy removed); npm audit gate |
| A.8.9 | Configuration management | ✅ | Docker Compose + env vars; infrastructure as code |
| A.8.12 | Data leakage prevention | ⚠️ Partial | CORS, RBAC, no stack traces in API responses; DLP tooling pending |
| A.8.15 | Logging | ✅ | Immutable audit_logs; RLS enforced; retention configurable |
| A.8.20 | Network security | ✅ | nginx TLS gateway; cmdb-internal network isolates DB |
| A.8.24 | Use of cryptography | ✅ | TLS 1.2+, HS256 JWT, bcrypt passwords, SHA-256 pseudonymisation |
| A.8.25 | Secure development lifecycle | ⚠️ Partial | Security audit conducted; SAST/DAST tools not yet integrated |
| A.8.26 | Application security requirements | ✅ | OWASP Top 10 reviewed; GDPR, NIS2, ISO 27001 audits complete |
| A.8.28 | Secure coding | ✅ | Parameterised queries, Zod validation, magic-byte upload checks |
| A.8.29 | Security testing in development | ⚠️ Partial | Manual audit; automated security testing pipeline pending |
| A.8.33 | Test information | ⚠️ Partial | [REPLACE: confirm no production PII used in test environments] |
| A.8.34 | Protection of information systems during audit | ✅ | Audit log INSERT-only; RLS prevents tampering |

*Controls A.7.x (physical) excluded — hosted infrastructure; defer to hosting provider.*  
*Full 93-control SoA to be expanded by [REPLACE: CISO] before certification audit.*
