# OWASP Top 10 (2021) — Differential Review v2.5.3

**Scope:** `git diff main...develop` for release v2.5.3
**Reviewer:** Claude (automated differential-review skill)
**Date:** 2026-06-04
**Diff size:** 18 files changed, +1242/-115 (backend +284/-, frontend ~+184/-)
**Codebase size:** LARGE (200+ files) → SURGICAL strategy on critical paths only

---

## Files reviewed

| File | LOC Δ | Risk |
|------|-------|------|
| `backend/src/index.ts` | +284/- | HIGH (auth, raw SQL, validation) |
| `backend/prisma/migrations/20260604110000_device_models_eol_eos/migration.sql` | +7 | LOW (idempotent ALTER TABLE) |
| `backend/prisma/schema.prisma` | +4 | LOW (two nullable DateTime columns) |
| `frontend/components/CIDetailModal.tsx` | +129/-15 | MEDIUM (inline write surface) |
| `frontend/app/admin/masters/page.tsx` | +21/-5 | LOW (date inputs only) |
| `frontend/app/inventory/bulk/[batchId]/page.tsx` | +25/-4 | LOW (display flags only) |
| `frontend/locales/*.json` × 6 | +78/-6 | LOW (i18n keys only) |
| docs / plans | — | N/A |

---

## A01 — Broken Access Control

| Check | Verdict | Evidence |
|-------|---------|----------|
| All new/modified write endpoints require auth | ✅ | `authenticateToken` on every PATCH/POST/DELETE |
| All admin operations gated by `requireAdmin` | ✅ | `backend/src/index.ts` PATCH/POST/DELETE `/api/cis/*`, `/api/masters/device-models*` |
| Frontend defense in depth (UI gate) | ✅ | `CIDetailModal.tsx` renders Save button only when `isAdmin`; backend still enforces |
| New defensive guard `requireUuidParam` on `:id` routes | ✅ | Applied to PATCH/DELETE `/api/cis/:id` — closes the v2.5.2 route-ordering vector |

**Verdict: PASS**

---

## A02 — Cryptographic Failures

No cryptographic primitives changed. JWT, bcrypt, TLS, MFA paths untouched.

**Verdict: N/A**

---

## A03 — Injection

| Check | Verdict | Evidence |
|-------|---------|----------|
| Raw SQL parameterised via tagged template | ✅ | All new `$queryRaw`/`$executeRaw` use `${var}` interpolation. No `$queryRawUnsafe` introduced |
| New IP-conflict query | ✅ | `WHERE console_ip = ${ipAddr}` — exact match, no LIKE, no escape needed |
| Device-models EOL/EOS persistence | ✅ | `INSERT/UPDATE ... eol_date=${eol}, eos_date=${eos}` — Date objects, parameterised |
| sync-eol COALESCE | ✅ | `COALESCE(${eolInfo.eolDate ?? null}::timestamp, eol_date)` — parameterised |
| Date string validation | ✅ | `isoDateOrNull` enforces strict `/^\d{4}-\d{2}-\d{2}$/` before `new Date()` |
| FK UUID validation in PATCH `/api/cis/:id` | ✅ | New loop rejects non-UUID string in `ciTypeId`, `branchId`, `ciModelId`, etc. — prevents P2023 leak |

**Verdict: PASS**

---

## A04 — Insecure Design

| Concern | Severity | Status |
|---------|----------|--------|
| `requireUuidParam` applied only to `/api/cis/:id` route family — other `:id` routes (`/api/contracts/:id`, `/api/documents/:id`, `/api/licenses/:id`) lack the same defensive guard | LOW | **F-02** — backlog v2.6.x. No literal route declared after them, so no active vector |
| `isWellFormedCIRow` bypasses LLM normalisation but raw fields are still validated downstream by Zod (`BulkItemDecisionBase`) at commit time | INFO | No change needed |
| `/api/users` returns full user list for owner/lead selectors with no pagination | LOW | **F-03** — backlog v2.6.x. Internal CMDB, <100 users |

**Verdict: PASS (3 LOWs deferred)**

---

## A05 — Security Misconfiguration

No changes to nginx, helmet, CSP, or Express middleware order. **N/A**

---

## A06 — Vulnerable & Outdated Components

No new dependencies introduced. `npm audit` baseline unchanged. **N/A**

---

## A07 — Identification & Authentication Failures

No changes to login, MFA, SSO, JWT, password policy. **N/A**

---

## A08 — Software & Data Integrity Failures

| Check | Verdict | Evidence |
|-------|---------|----------|
| Bulk import skip-AI does not bypass commit-time validation | ✅ | Skip-AI only affects the *analyze* phase. Commit phase still runs `BulkItemDecisionBase` Zod schema |
| EOL/EOS dates strictly validated | ✅ | `isoDateOrNull` regex check before parsing |
| Migration idempotency | ✅ | `ADD COLUMN IF NOT EXISTS` — safe to redeploy |

**Verdict: PASS**

---

## A09 — Security Logging & Monitoring Failures

| Check | Verdict | Evidence |
|-------|---------|----------|
| `UPDATE_CI` audit log on PATCH `/api/cis/:id` | ✅ | Line ~209 of new code, preserved |
| `UPDATE_MASTER` audit on PATCH device-models | ✅ | Preserved in new code |
| `CREATE_MASTER` audit on POST device-models | ✅ | Preserved in new code |
| Bulk-update per-CI audit records | ✅ | Preserved |
| **`sync-eol` writes to `device_models` but does NOT emit `UPDATE_MASTER`** | ❌ | **F-01 — fix before release** |

**Verdict: 1 LOW finding to fix in this branch**

---

## A10 — Server-Side Request Forgery

`sync-eol` calls `lookupEolWithFallbacks(endoflife.date)`. Pre-existing code, not modified. Allowlisted host. **N/A**

---

## Findings summary

| ID | Severity | OWASP | Issue | Action |
|----|----------|-------|-------|--------|
| **F-01** | LOW | A09 | `sync-eol` UPDATE on `device_models` is not audited | **Fix in this branch (3 lines)** |
| F-02 | LOW | A04 | `requireUuidParam` not applied to `/api/contracts/:id`, `/api/documents/:id`, `/api/licenses/:id` | Backlog v2.6.x |
| F-03 | LOW | A04 | `/api/users` selector has no pagination | Backlog v2.6.x |

No Critical, High, or Medium findings.

**Release v2.5.3 release recommendation: PROCEED after F-01 is fixed.**
