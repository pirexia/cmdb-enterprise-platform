# OWASP Top 10 Security Audit — Task F: Remove CSV Import + CI Batch View

**Date:** 2026-06-02  
**Branch:** `task-f/remove-csv-ci-batch-view`  
**Scope:** F1 — remove legacy `POST /api/cis/bulk`; F2 — remove CSV import UI; F3 — add `?tab=list` navigation to CI bulk page  
**Result: 0 Critical · 0 High · 0 Medium · 0 Low**

---

## Summary

Task F is primarily a **surface reduction** task: two endpoints and their associated frontend code are removed, and a client-side navigation tab is added. The overall security posture improves because:

- The legacy `POST /api/cis/bulk` endpoint (synchronous, no AuditLog, no AI validation) is gone — replaced by the audited XLSX staging workflow from Task E.
- The CSV file input and Papa.parse path are gone — one less client-side file-parsing surface.
- No new server-side code processes untrusted user input.

---

## A01 — Broken Access Control ✅

F1 removes an endpoint that was `requireAdmin`-protected. No new endpoints added. F3 adds client-side tab navigation only — all data fetching continues to go through the existing `requireAdmin` backend endpoints.

**No findings.**

---

## A02 — Cryptographic Failures ✅

No cryptographic operations added or modified.

**No findings.**

---

## A03 — Injection ✅

| Change | Assessment |
|--------|-----------|
| F1: remove `POST /api/cis/bulk` | Removes a Prisma ORM-based bulk create — no injection risk was present, and it is now gone |
| F2: remove Papa.parse + `/api/cis/bulk` call | Removes client-side CSV parsing; the POST call it made is also gone (F1) |
| F3: `searchParams.get("tab") === "list"` | Simple string equality comparison; value is never reflected into SQL, HTML or system calls |

**No findings.**

---

## A04 — Insecure Design ✅

The removal of the legacy synchronous import in favour of the staged AI workflow (Task E) **improves** the design: every CI import now goes through conflict detection, AI validation, human review, and AuditLog.

**No findings.**

---

## A05 — Security Misconfiguration ✅

No server configuration changes. No new environment variables. No new Docker/nginx config.

**No findings.**

---

## A06 — Vulnerable Components ✅

`papaparse` import removed from the frontend bundle. No new dependencies added.

**No findings.**

---

## A07 — Authentication and Session Failures ✅

No auth flow changes. The removed `POST /api/cis/bulk` was already `requireAdmin`-protected; its removal does not weaken session management.

**No findings.**

---

## A08 — Software and Data Integrity ✅

F2 removes client-side CSV file parsing (Papa.parse). The remaining file upload path (XLSX bulk) retains its magic-byte validation (`PK\x03\x04`) from Task E.

**No findings.**

---

## A09 — Logging and Monitoring Failures ✅

The legacy `POST /api/cis/bulk` emitted **no** AuditLog records — its removal is therefore a net improvement: all CI bulk creation now goes through the Task E pipeline which emits `CI_BULK_UPLOAD` and `CI_BULK_COMMIT`.

**No findings.**

---

## A10 — SSRF ✅

No outbound HTTP calls added.

**No findings.**

---

## ISO 27001 / GDPR / NIS2

| Requirement | Status |
|-------------|--------|
| Audit trail complete for CI imports (A.8.15) | ✅ Improved — legacy no-audit path removed |
| No new PII fields | ✅ |
| Data minimisation (GDPR art. 5) | ✅ Removing CSV path reduces data entry surface |
| Availability: no new single points of failure | ✅ |

---

## Conclusion

Task F reduces attack surface and improves audit completeness. No security findings.
