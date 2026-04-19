# Information Security Policy (ISP)
**Document ID:** ISMS-POL-001  
**Version:** 1.0  
**Status:** Draft — requires management approval  
**Owner:** [REPLACE: Name and title of CISO or equivalent]  
**Approved by:** [REPLACE: CEO/CTO/Board name]  
**Approval date:** [REPLACE: YYYY-MM-DD]  
**Next review:** [REPLACE: YYYY-MM-DD — review annually]  
**Scope:** CMDB Enterprise Platform — all users, administrators, and systems

---

## 1. Purpose

This policy establishes the organisation's commitment to protecting the confidentiality, integrity, and availability of information assets processed by the CMDB Enterprise Platform in accordance with ISO/IEC 27001:2022.

## 2. Scope

This policy applies to:
- All employees, contractors, and third parties who access the platform
- All systems that store, transmit, or process platform data (Docker hosts, PostgreSQL databases, nginx gateways, backup media)
- All geographic locations from which the platform is operated

## 3. Information Security Objectives

1. Protect the confidentiality of CMDB asset data, contracts, licenses, and user PII
2. Ensure 99.5 % monthly availability of the platform for operational staff
3. Detect and respond to security incidents within 4 hours of discovery
4. Comply with GDPR (EU 2016/679), NIS2 Directive (EU 2022/2555), and ISO/IEC 27001:2022

## 4. Roles and Responsibilities

| Role | Responsibility |
|------|---------------|
| [REPLACE: CISO] | Own and maintain the ISMS; approve risk treatment decisions |
| Platform Administrators | Enforce access controls; apply security patches within SLA |
| All Users | Complete annual security awareness training; report incidents promptly |
| [REPLACE: DPO] | Oversee GDPR compliance; handle data subject requests |

## 5. Security Principles

- **Least privilege**: users are granted the minimum access required (VIEWER / AUDITOR / ADMIN RBAC)
- **Defence in depth**: TLS termination at nginx, JWT authentication, bcrypt/MFA for credentials, RLS on audit tables
- **Secure by default**: production containers run with `no-new-privileges`, non-root UIDs, and read-only root filesystems where applicable

## 6. Compliance Obligations

The platform is subject to: GDPR Art. 5, 17, 32; NIS2 Art. 21; ISO/IEC 27001:2022 Annex A.

## 7. Violations

Violations of this policy may result in disciplinary action up to and including termination and legal prosecution.

## 8. Review

This policy is reviewed annually or after any significant security incident or material change to the platform architecture.
