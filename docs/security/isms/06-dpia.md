# Data Protection Impact Assessment (DPIA)
**Document ID:** ISMS-DPIA-001  
**Version:** 1.0  
**Status:** Draft — requires DPO review and sign-off  
**Owner:** [REPLACE: DPO name]  
**Reviewed by:** [REPLACE: Legal counsel, CISO]  
**Approval date:** [REPLACE: YYYY-MM-DD]  
**Next review:** [REPLACE: YYYY-MM-DD — review annually or after significant change]  
**Legal basis:** GDPR Art. 35, EDPB Guidelines 09/2022

---

## 1. DPIA Trigger Assessment

A DPIA is required when processing is "likely to result in a high risk" (Art. 35). The EDPB guidelines require a DPIA when ≥ 2 criteria apply:

| Criterion | Present? | Evidence |
|-----------|----------|---------|
| Systematic monitoring | ✅ Yes | All user actions logged with email+timestamp in `audit_logs` (insert-only, append-only) |
| Innovative technology | ✅ Yes | MFA TOTP, Microsoft SSO auto-provisioning, LDAP auto-provisioning |
| Vulnerable subjects | ⚠️ Partial | Internal employees only — moderate risk |
| Large scale | ❌ No | Deployment typically < 500 users |
| Automated decision-making | ❌ No | No algorithmic decisions affecting individuals |

**Conclusion:** ≥ 2 criteria met → DPIA required.

---

## 2. Personal Data Inventory

| Data Category | Where Stored | Purpose | Legal Basis (GDPR Art. 6) | Retention | Risk Level |
|--------------|-------------|---------|--------------------------|-----------|------------|
| Email address | `users.email` | Authentication, audit attribution | 6(1)(b) — contract | Duration of employment + 30 days | Medium |
| Username | `users.username` | Authentication, display | 6(1)(b) — contract | Duration of employment + 30 days | Low |
| Password hash (bcrypt) | `users.password` | Authentication | 6(1)(b) — contract | Same as user account | Low |
| MFA secret (TOTP) | `users.mfa_secret` | 2FA authentication | 6(1)(b) — contract | Same as user account | Medium |
| Email in audit logs | `audit_logs.user_email` | Traceability, compliance | 6(1)(c) — legal obligation | Minimum 730 days (NIS2) | High |
| Trusted device token | `trusted_devices.token` | Device recognition | 6(1)(b) — contract | 30 days (configurable) | Low |
| IP address + User-Agent | `trusted_devices.ip_address/user_agent` | Device binding security | 6(1)(f) — legitimate interest | 30 days | Medium |
| Password history hashes | `password_history.hash` | Password reuse prevention | 6(1)(c) — legal obligation (security) | Last N passwords (configurable) | Low |
| DNI (national ID) | `license_users` and `configuration_items` (optional field) | Asset management | [REPLACE: 6(1)(b) or remove if not necessary] | Same as parent record | **High** |
| Azure OID | `users.sso_external_id` | SSO identity binding | 6(1)(b) — contract | Same as user account | Medium |

---

## 3. High-Risk Processing Activities

### 3.1 Systematic Monitoring via Audit Logs (HIGH RISK)

**Description:** Every write action by every user is recorded in `audit_logs` with their email, action type, entity, and timestamp. The table is insert-only (RLS blocks DELETE) and UPDATE is only allowed for GDPR pseudonymisation.

**Risk:** Comprehensive behavioral profile of all users. Retention minimum of 730 days creates a 2-year surveillance dataset.

**Mitigations:**
- Access restricted to AUDITOR and ADMIN roles
- RLS prevents deletion — only pseudonymisation on GDPR erasure request
- Pseudonymisation replaces email with `[deleted-{hash16}]` on erasure
- No automated profiling or decision-making based on audit data

**Residual risk after mitigations:** Medium — acceptable given legal obligation (NIS2 traceability).

### 3.2 DNI/National ID Collection (HIGH RISK — REQUIRES ACTION)

**Description:** The `license_users` and `configuration_items` tables contain optional fields that may store national identification numbers (DNI).

**Risk:** Processing of national IDs requires explicit legal basis in many jurisdictions. No documented legal basis exists.

**Required action (choose one):**
1. **Remove the field** if DNI is not essential for asset management — preferred (data minimisation, Art. 5(1)(c))
2. **Document legal basis** — explicit legal obligation (e.g., software asset auditing regulation) or explicit consent, documented in this DPIA before processing

**Status:** [REPLACE: Open — requires decision before production deployment]

### 3.3 Microsoft SSO — International Data Transfer (MEDIUM RISK)

**Description:** Azure AD processes email address and Object ID for identity assertion. Data flows to Microsoft servers (may be USA).

**Transfer mechanism:** Microsoft DPA + Standard Contractual Clauses (SCCs) — covered by Microsoft's EU Data Boundary commitments.

**Mitigations:**
- Only email and OID are transferred — no CMDB asset data
- Microsoft's ISO 27001 / SOC 2 Type II certification
- Transfer can be disabled by setting `USE_MICROSOFT_SSO=false`

**Residual risk:** Low — transfer mechanism documented and covered by Art. 46 SCCs.

### 3.4 OCR Processing of Scanned Documents (MEDIUM RISK)

**Description:** Scanned PDFs are now processed via OCR (Tesseract 5). The extracted text may contain personal data present in digitised physical documents (contracts, invoices, signed agreements).

**Risk:** OCR-extracted text from scanned documents may include names, signatures, addresses, or personal reference numbers. Unlike structured entity fields, OCR output is not passed through `scrubPII()` in the current implementation, so personal data may remain stored as plaintext in `rag_chunks`.

**Mitigations:**
- Processing is entirely local (Docker container) — no data leaves the system
- Temporary PNG files are deleted in the `finally` block of the processor, never persisted
- OCR chunks inherit the source document's ACL (`read_admin`, `read_auditor`, `read_viewer`)
- Retention follows the existing `rag_chunks` policy (cascade delete when the document is deleted)
- No transfer to external AI or OCR providers

**Action required:** Evaluate extending `scrubPII()` to cover OCR-extracted text before chunking (DPO decision pending).

**Residual risk:** Medium — acceptable given local confinement, but subject to review if the categories of scanned documents indexed are expanded.

---

### 3.5 LDAP Auto-Provisioning — Art. 14 Obligation (MEDIUM RISK)

**Description:** Users authenticated via LDAP/AD are automatically created in the platform without direct interaction. This triggers Art. 14 (information to data subject when data not collected directly).

**Mitigation:** Organisation must inform LDAP users via HR/corporate communication. Documented in SYSADMIN_MANUAL.md §18.

**Residual risk:** Low — mitigated by organisational process.

---

## 4. GDPR Art. 17 / Audit Log Immutability Conflict

**Conflict:** GDPR Art. 17 grants users the right to erasure. The audit log RLS policy makes DELETE impossible (ISO 27001 A.8.15 / NIS2 traceability requirement).

**Resolution:** Pseudonymisation as defined in Art. 4(5) GDPR. The `DELETE /api/admin/users/:id` endpoint:
1. Replaces `user_email` in all `audit_logs` entries with a stable SHA-256 hash (`[deleted-{hash16}]`)
2. Permanently deletes the user record and all PII

**Legal basis for retention after pseudonymisation:** Art. 17(3)(b) — retention necessary for compliance with a legal obligation (NIS2 traceability).

**This approach is documented and approved by:** [REPLACE: DPO signature and date]

---

## 5. DPO Consultation

This DPIA was [REPLACE: submitted to / reviewed by] the Data Protection Officer on [REPLACE: YYYY-MM-DD].

**DPO opinion:** [REPLACE: Approved / Approved with conditions / Objections raised]

**Conditions / Objections:** [REPLACE: if any]

---

## 6. Sign-off

| Role | Name | Date | Signature |
|------|------|------|-----------|
| DPO | [REPLACE] | [REPLACE] | [REPLACE] |
| CISO | [REPLACE] | [REPLACE] | [REPLACE] |
| Legal Counsel | [REPLACE] | [REPLACE] | [REPLACE] |
