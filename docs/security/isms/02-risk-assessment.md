# Risk Assessment and Risk Treatment Plan
**Document ID:** ISMS-RISK-001  
**Version:** 1.0  
**Status:** Draft  
**Owner:** [REPLACE: CISO]  
**Last reviewed:** [REPLACE: YYYY-MM-DD]  
**Methodology:** ISO/IEC 27005:2022 — qualitative likelihood × impact matrix (1–5 scale)

---

## Risk Rating Matrix

| Likelihood \ Impact | 1 Negligible | 2 Minor | 3 Moderate | 4 Major | 5 Critical |
|---------------------|-------------|---------|-----------|---------|-----------|
| 5 Almost certain    | Medium | High | High | Critical | Critical |
| 4 Likely            | Low | Medium | High | High | Critical |
| 3 Possible          | Low | Medium | Medium | High | High |
| 2 Unlikely          | Low | Low | Medium | Medium | High |
| 1 Rare              | Low | Low | Low | Medium | Medium |

---

## Risk Register

| ID | Asset | Threat | Vulnerability | Likelihood | Impact | Rating | Treatment | Owner | Status |
|----|-------|--------|--------------|-----------|--------|--------|-----------|-------|--------|
| R-001 | JWT session tokens | XSS theft | Tokens in localStorage (pre-v2.0.2) | 3 | 4 | High | **Mitigated**: HttpOnly cookies implemented in v2.0.2 | [REPLACE] | Closed |
| R-002 | Admin accounts | Brute force | Weak password policy | 2 | 5 | High | **Mitigated**: ADMIN min 16-char policy + mandatory MFA | [REPLACE] | Closed |
| R-003 | File uploads | Malicious file execution | Extension filter only | 2 | 4 | High | **Mitigated**: Magic-byte validation + UUID filenames | [REPLACE] | Closed |
| R-004 | User PII in audit logs | GDPR erasure request | No pseudonymisation (pre-v2.0.2) | 3 | 3 | Medium | **Mitigated**: Pseudonymisation on erasure, RLS blocks DELETE | [REPLACE] | Closed |
| R-005 | PostgreSQL data | Ransomware / data loss | Single-region deployment | 2 | 5 | High | **Accept / Transfer**: [REPLACE: backup strategy, frequency, offsite storage] | [REPLACE] | Open |
| R-006 | Azure AD SSO dependency | Third-party outage | No local auth fallback for SSO-only admins | 2 | 3 | Medium | **Accept**: At least one local ADMIN account must exist at all times | [REPLACE] | Open |
| R-007 | Docker host | Privilege escalation | Container breakout via misconfiguration | 1 | 5 | Medium | **Mitigate**: no-new-privileges, non-root user, regular host patching | [REPLACE] | Open |
| R-008 | [REPLACE: add org-specific risks] | | | | | | | | |

---

## Risk Treatment Plan

Residual risks rated **High** or **Critical** with status **Open** require formal acceptance sign-off by [REPLACE: CISO/CTO] before go-live in production.

**Next risk review date:** [REPLACE: YYYY-MM-DD]
