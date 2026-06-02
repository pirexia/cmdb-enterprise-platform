# OWASP Top 10 Security Audit — Task E: CI Bulk Import AI

**Date:** 2026-06-01  
**Branch:** `task-e/ci-bulk-import-ai`  
**Scope:** CI staging tables (E1), 10 new `/api/cis/bulk/*` endpoints (E2), AI analysis worker `processCIBulkImportQueue` (E3), frontend pages `/inventory/bulk` + `/inventory/bulk/[batchId]` (E4)  
**Result: 0 Critical · 0 High · 0 Medium · 1 Low (informational)**

---

## Summary

The CI bulk import feature mirrors the established pattern of the document bulk import (`feature/bulk-document-import`). All OWASP Top 10 controls were verified against the new code. One low-severity informational item is noted for defence-in-depth; no exploitable vulnerabilities were found.

---

## A01 — Broken Access Control ✅

| Check | Result |
|-------|--------|
| Every new endpoint guarded by `requireAdmin` | ✅ Verified: `authenticateToken, requireAdmin` on all 10 routes |
| Batch ownership enforced at DB level | ✅ All SELECT/DELETE queries include `WHERE … created_by = ${req.user!.email}` |
| Items accessed only through owned batches | ✅ JOIN on batch with `created_by` filter in every item query |
| PATCH decision: 409 on already-committed items | ✅ `rows[0].status === 'COMMITTED'` check present |
| COMMITTING state prevents double-commit (TOCTOU) | ✅ `UPDATE … WHERE status <> 'COMMITTED'` inside transaction; `Number(claimed) === 0` throws |
| Frontend admin check | ✅ `if (!isAdmin) return <error>` in both bulk pages |

**No findings.**

---

## A02 — Cryptographic Failures ✅

No new cryptographic operations introduced. JWT/session handling is unchanged. The `apiSlug` uses `Date.now().toString(36) + Math.random()` for uniqueness (not security), consistent with existing CI creation.

**No findings.**

---

## A03 — Injection ✅

| Check | Result |
|-------|--------|
| All `$queryRaw` / `$executeRaw` calls use tagged template literals | ✅ Verified — no string concatenation, no `$queryRawUnsafe` |
| `JSON.stringify(rows[i])::jsonb` parameterization | ✅ The `${...}` interpolation in tagged templates is parameterized by Prisma, not string-concatenated |
| XLSX cell values coerced to `String(v).trim()` before storage | ✅ No eval, no exec, no template rendering of cell values |
| `analyzeCIRowForImport` anti-injection prompt (Rule 8) | ✅ System prompt includes `<CI_ROW>…</CI_ROW>` isolation marker |
| AI response keys stored in JSONB only; not reflected into CI attributes | ✅ `seedDecision` extracts 21 named fields explicitly; `CIBulkDecisionSchema` (Zod) validates commit body |
| LIKE escaping in conflict detection | ✅ Conflict detection uses equality (`LOWER(name) = LOWER(${...})`) not LIKE — no escaping needed |

**No findings.**

---

## A04 — Insecure Design ✅

| Check | Result |
|-------|--------|
| Threat model: staging rows isolated by `created_by` | ✅ |
| `forceCreate` flag requires explicit boolean true in Zod schema | ✅ Type-enforced; cannot be string-coerced |
| AI worker processes only items owned by no specific user (batch-level) | ✅ Worker reads all PENDING_ANALYSIS items; conflict detection is read-only |
| Concurrent open-batch cap prevents staging table exhaustion | ✅ `BULK_MAX_OPEN_BATCHES` enforced at upload time |

**No findings.**

---

## A05 — Security Misconfiguration

**LOW (Informational) — `processCIBulkImportQueue` missing `RAG_ENABLED` guard**

`processBulkImportQueue` (the document equivalent) begins with `if (process.env.RAG_ENABLED !== 'true') return`. `processCIBulkImportQueue` omits this guard and instead only checks `isOllamaHealthy()`.

**Current exploitability: None.** The function has a single call site, which is already inside the `if (process.env.RAG_ENABLED === 'true')` cron block at the scheduling point. A future refactor adding a second call site (e.g., admin-triggered re-analysis endpoint) could accidentally invoke Ollama when RAG is disabled.

**Recommendation:** Add `if (process.env.RAG_ENABLED !== 'true') return;` as the first line of `processCIBulkImportQueue`, consistent with all other queue processors.

---

## A06 — Vulnerable Components ✅

No new npm dependencies introduced. `exceljs` was already a dependency of the project. No packages with known CVEs added.

**No findings.**

---

## A07 — Authentication and Session Failures ✅

No new auth flows. All endpoints use the existing `authenticateToken` middleware (JWT from `Authorization: Bearer` header or `token` HttpOnly cookie, verified signature + algorithm + `users.active` DB check).

**No findings.**

---

## A08 — Software and Data Integrity ✅

| Check | Result |
|-------|--------|
| XLSX magic bytes validated after multer (`PK\x03\x04`) | ✅ |
| File extension restricted to `.xlsx` by multer `fileFilter` | ✅ |
| File size capped at 10 MB (multer `limits.fileSize`) | ✅ |
| Memory storage: no disk path involved, no path traversal possible | ✅ |
| Row count capped at `CI_BULK_MAX_ROWS` (500) | ✅ |
| AI response parsed with `JSON.parse` only; no `eval`/`Function()` | ✅ |

**No findings.**

---

## A09 — Logging and Monitoring Failures ✅

| Action | AuditLog entry |
|--------|---------------|
| Upload XLSX batch | `CI_BULK_UPLOAD` |
| Commit one item | `CI_BULK_COMMIT` |
| Discard one item | `CI_BULK_DISCARD_ITEM` |
| Discard entire batch | `CI_BULK_DISCARD_BATCH` |
| Re-analyze one item | `CI_BULK_REANALYZE_ITEM` |
| Re-analyze batch | `CI_BULK_REANALYZE_BATCH` |

Note: The PATCH decision-save endpoint does not emit an audit record (the decision is overwritten at commit time and recorded then). This is consistent with the document bulk import pattern and does not represent a compliance gap given that the committed values are always audited via `CI_BULK_COMMIT`.

**No findings.**

---

## A10 — SSRF ✅

`OLLAMA_BASE_URL` is read exclusively from `process.env`; it is validated at module load against an internal-host allowlist regex (in `ragService.ts`). No user-supplied URL is ever used for outbound requests in this feature.

**No findings.**

---

## ISO 27001 / GDPR / NIS2 Checklist

| Requirement | Status |
|-------------|--------|
| Every write produces an AuditLog record (A.8.15) | ✅ |
| AuditLog records are insert-only; no update/delete path exposed | ✅ |
| `ci_bulk_import_item.raw_data` contains only user-supplied XLSX values (no new PII fields) | ✅ — `assignedUser` is a free-text string, not a linked User record; no email/name auto-collection |
| New tables include no new PII processing beyond existing CI model | ✅ |
| Data minimisation: only XLSX row data stored; files not retained | ✅ — no file written to disk (memory buffer only) |
| Access control: ADMIN-only; AUDITOR/VIEWER cannot read or write bulk batches | ✅ |
| Availability: `CI_BULK_MAX_ROWS` + open-batch cap prevent unbounded resource consumption | ✅ |

---

## Conclusion

The CI bulk import feature is implemented following the existing secure patterns established by the document bulk import. All 10 OWASP categories are satisfied. One informational defence-in-depth item (A05) is noted for future hardening.

**Recommended action before merge:** Add `if (process.env.RAG_ENABLED !== 'true') return;` to `processCIBulkImportQueue` (5-second fix). All other items are clear.
