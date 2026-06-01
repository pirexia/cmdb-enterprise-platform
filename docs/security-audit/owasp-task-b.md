# OWASP Top 10 (2021) Security Audit — Batch State Machine, Concurrent-Batch Limit & Cleanup Cron (Task B)

**Audit ID:** OWASP-TASK-B-001
**Audit date:** 2026-06-01
**Auditor:** Independent security review
**Classification:** CONFIDENTIAL — Internal security audit record
**Platform version:** v2.3.x (`main`, post-change)

---

## Scope

Targeted review of three related changes to the bulk import pipeline:

1. **`recomputeBatchStatus`** (`backend/src/index.ts:3631`) — new `ERROR` terminal branch (all items processed, none committed, some in ERROR); `REAPED` is now explicitly excluded from the state machine's update path by only calling the function from non-REAPED contexts.
2. **Concurrent-batch limit** (`backend/src/index.ts:3130`, `4409–4425`) — new `BULK_MAX_OPEN_BATCHES` constant (default 5); check added at `POST /api/documents/bulk/batches`; HTTP 429 returned when limit is reached.
3. **Cleanup cron** (`backend/src/index.ts:5556–5602`) — now performs `UPDATE status='REAPED'` instead of `DELETE`; staged files still deleted; `BULK_REAP_BATCH` audit row still written; only non-terminal batches are reaped.

**OWASP categories assessed:** A01, A04, A05, A09.

---

## Findings by Severity

| Severity | Count | IDs |
|----------|-------|-----|
| CRITICAL | 0 | — |
| HIGH     | 0 | — |
| MEDIUM   | 2 | TASK-B-A04-1, TASK-B-A04-2 |
| LOW      | 2 | TASK-B-A09-1, TASK-B-A05-1 |
| INFO     | 3 | A01 access control verified; A01 list-endpoint ownership verified; REAPED terminal-state exclusion verified |

**Overall verdict: Changes are directionally correct and improve availability resilience. Two MEDIUM findings (disk exhaustion despite batch cap; unbounded REAPED row accumulation), one LOW logging gap (429 rejections not audited), one LOW misconfiguration risk (`BULK_MAX_OPEN_BATCHES=0` blocks all uploads silently). No access-control bypass found.**

---

## A01: Broken Access Control

**Applicability:** HIGH — the concurrent-batch count query uses `req.user!.email` as the ownership predicate.
**Risk Level:** NONE (controls verified).

### Assessment

`req.user!.email` is populated exclusively by `authenticateToken` (`index.ts:313–356`), which:
1. Reads the JWT from the HttpOnly cookie or `Authorization: Bearer` header.
2. Verifies the signature with `jwt.verify(token, JWT_SECRET_VALUE, { algorithms: ['HS256'] })` — algorithm pinning prevents `alg:none` attacks.
3. Confirms the account is still `active=true` in the database.
4. Assigns the verified payload to `req.user` (`line 351`) only after all checks pass.

The email in `req.user!.email` therefore comes exclusively from the signed JWT and cannot be forged by the client. The open-batch count query (`index.ts:4412–4415`) uses `created_by = ${req.user!.email}` as a tagged-template Prisma parameter — no string interpolation, no SQL injection surface. **No access-control bypass is possible via the email field.**

**`GET /api/documents/bulk/batches`** (`index.ts:4481`) also filters `WHERE b.created_by = ${req.user!.email}`, so REAPED and non-REAPED batches belonging to other users are never returned. Ownership isolation is correct on both the list and detail endpoints.

---

## A04: Insecure Design (DoS / Resource Exhaustion)

**Applicability:** HIGH — staging disk and DB table growth are the primary unbounded resource risks.
**Risk Level:** MEDIUM (two findings).

### Controls Verified

- Per-file size cap: `MAX_DOCUMENT_SIZE_MB` (default 50 MB), enforced by multer at `fileSize: MAX_FILE_SIZE` (`index.ts:4062`).
- Per-batch file count: `BULK_MAX_FILES` (default 20), enforced by multer at `files: BULK_MAX_FILES` (`index.ts:4062`).
- Per-batch byte total: `BULK_MAX_TOTAL_BYTES` = `BULK_MAX_TOTAL_MB × 1024²` (default 200 MB) checked before processing (`index.ts:4404`).
- Concurrent open batch limit: `BULK_MAX_OPEN_BATCHES` (default 5) (`index.ts:4417`).
- TTL reap: cron at `0 * * * *` marks batches older than `BULK_BATCH_TTL_HOURS` (default 24) as REAPED and deletes their staged files (`index.ts:5556–5598`).

### Finding TASK-B-A04-1 — MEDIUM | CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:N/I:N/A:M (4.9)

**Location:** `index.ts:3130`, `index.ts:4409–4425` — `BULK_MAX_OPEN_BATCHES` default 5 vs. per-batch byte cap 200 MB.

**Description:** The concurrent-batch limit (`BULK_MAX_OPEN_BATCHES=5`) does not bound total staging disk usage. With defaults, a single ADMIN user can hold 5 × 200 MB = **1 GB** of staged files simultaneously (20 files × 50 MB each per batch). Over the TTL window of 24 hours (before the reap cron fires) a user who rapidly creates and discards batches (each under the limit) can cycle through many gigabytes. The staged files are held in `STAGING_DIR` (default: `DOCUMENTS_DIR/_staging`), which shares the filesystem with committed documents. A staging exhaustion attack requires ADMIN role but does not require any additional privilege escalation. Actual worst-case is bounded by TTL + cron latency (up to `BULK_BATCH_TTL_HOURS + 1` hours of disk hold), but the 1 GB floor is real with default settings.

**Note:** This is a design-level concern introduced by the combination of unchanged size defaults and the new 5-batch limit. The cron reaper mitigates it eventually but does not bound peak disk usage within the TTL window.

**Impact:** Availability. Filesystem full condition could prevent document uploads, RAG indexing, and committed document storage.

**Remediation:**
1. Add a per-user total-staging-bytes guard at `POST /api/documents/bulk/batches`: query `SUM(total_bytes)` of non-terminal batches for `req.user!.email` and reject if the new batch would push the user over a `BULK_MAX_STAGING_BYTES_PER_USER` limit (suggested default: 500 MB).
2. Document `BULK_MAX_OPEN_BATCHES`, `BULK_MAX_TOTAL_MB`, and `BULK_BATCH_TTL_HOURS` as a related trio in `install.conf`, with a note that `BULK_MAX_OPEN_BATCHES × BULK_MAX_TOTAL_MB` equals the worst-case single-user staging footprint.
3. Consider reducing `BULK_MAX_TOTAL_MB` default from 200 MB to 50 MB and raising `BULK_MAX_FILES` default from 20 to 20 (unchanged) — net reduction of per-batch ceiling without reducing file count.

---

### Finding TASK-B-A04-2 — MEDIUM | CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:N/I:N/A:M (4.3)

**Location:** `index.ts:5579–5581` — `UPDATE status='REAPED'` without a secondary cleanup path.

**Description:** The cleanup cron now marks batches `REAPED` instead of deleting them. This is intentional (preserving batch rows for the list view). However, **there is no secondary mechanism to ever delete REAPED rows from `bulk_import_batch` or their associated `bulk_import_item` rows**. The `GET /api/documents/bulk/batches` list query returns up to 50 rows per user (`LIMIT 50`) without filtering out REAPED batches, so old REAPED rows are returned to the UI. More critically, `bulk_import_item` rows linked to REAPED batches accumulate indefinitely: each REAPED batch can hold up to `BULK_MAX_FILES` (default 20) item rows with up to 500-byte `error_message` and full JSONB `analysis` blobs. Over time (e.g. a year of daily reaping by multiple ADMIN users) the table can accumulate tens of thousands of rows, creating a table-bloat condition that slows the `processBulkImportQueue` `SELECT … WHERE status = 'PENDING_ANALYSIS'` scan (no partial index on `status`) and the open-batch-count query.

**Impact:** Availability / performance degradation over time. Not an immediate exploit but a structural accumulation risk that violates ISO 22301 availability principles and the NIS2 "no unbounded resource consumption" requirement.

**Remediation:**
1. Add a secondary cleanup stage to the hourly cron: delete `bulk_import_batch` rows (and their items via CASCADE) where `status = 'REAPED'` and `updated_at < now() - interval '7 days'` (configurable via `BULK_REAPED_RETENTION_DAYS`, default 7).
2. Add a partial index on `bulk_import_item(status)` where `status = 'PENDING_ANALYSIS'` to keep queue scans O(pending) rather than O(total).

---

## A05: Security Misconfiguration

**Applicability:** Medium — `BULK_MAX_OPEN_BATCHES` is a new env var with no floor validation.
**Risk Level:** LOW.

### Controls Verified

- `BULK_MAX_OPEN_BATCHES` is read with `parseInt(…, 10)` at module load (`index.ts:3130`). `parseInt('0', 10)` = `0`; `parseInt('-1', 10)` = `-1`; `parseInt('abc', 10)` = `NaN`. The condition `open >= BULK_MAX_OPEN_BATCHES` with `NaN` evaluates to `false` (NaN comparisons are always false), so `NaN` effectively disables the limit — an operator misconfiguration silently removes the DoS guard.
- `open >= 0` is always true (counts are non-negative), so `BULK_MAX_OPEN_BATCHES=0` makes the condition `open >= 0` always true: **every upload attempt returns HTTP 429**, completely blocking the bulk import feature for all ADMIN users without any visible error distinguishing misconfiguration from a real limit. The HTTP 429 body contains `maxBatches: 0`, which would expose the misconfiguration to the client — a minor information disclosure, but the primary concern is the service disruption.

### Finding TASK-B-A05-1 — LOW | CVSS:3.1/AV:L/AC:H/PR:H/UI:N/S:U/C:N/I:N/A:L (1.9)

**Location:** `index.ts:3130` — `parseInt(process.env.BULK_MAX_OPEN_BATCHES ?? '5', 10)`.

**Description:** `BULK_MAX_OPEN_BATCHES` has no floor or NaN validation. Values ≤ 0 either disable all uploads (0) or the limit entirely (negative/NaN). Unlike `OCR_DOC_TIMEOUT_MS` (where 0 is silent), `BULK_MAX_OPEN_BATCHES=0` is immediately visible to all ADMIN users as a permanent 429 block — operator impact is high, though the security impact is low (requires operator-level access to set).

**Remediation:**

```typescript
const _rawMaxBatches = parseInt(process.env.BULK_MAX_OPEN_BATCHES ?? '5', 10);
const BULK_MAX_OPEN_BATCHES = Number.isFinite(_rawMaxBatches) && _rawMaxBatches >= 1
  ? _rawMaxBatches
  : 5;
```

Log a warning at startup if the configured value is out of range. Apply the same pattern to `BULK_BATCH_TTL_HOURS` and `BULK_ANALYZE_BUDGET` for consistency.

---

## A09: Logging & Monitoring

**Applicability:** HIGH — the HTTP 429 rejection is a security-relevant event (possible abuse probe or misconfiguration indicator).
**Risk Level:** LOW.

### Controls Verified

- Successful `POST /api/documents/bulk/batches` writes a `BULK_UPLOAD` audit log entry (`index.ts:4458–4461`). Correct.
- The cleanup cron writes a `BULK_REAP_BATCH` audit log entry per reaped batch with TTL, file count, committed, and non-committed counts (`index.ts:5584–5593`). Correct and well-attributed.
- The `recomputeBatchStatus` function does not write audit entries for state transitions — this is acceptable as it is an internal consistency function, not a user-initiated action.

### Finding TASK-B-A09-1 — LOW | CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:N/I:N/A:N (0.0 base, elevated by compliance impact)

**Location:** `index.ts:4417–4424` — HTTP 429 response block.

**Description:** When the concurrent-batch limit is reached the handler returns HTTP 429 with `{ error, openBatches, maxBatches }` and immediately `return`s — no audit log record is written and no structured application log entry is emitted (only the `catch` branch at `line 4425` logs errors in the limit-check query itself, not the 429 decision). A user repeatedly hitting the limit — whether due to abuse, a misconfigured client, or a compromised account — leaves **no trace in the audit log**. This is a gap under ISO 27001 A.8.15 (logging of security-relevant events) and NIS2 Art. 23 (incident detectability within 24/72 hours): a high volume of 429 responses targeting a single account would be invisible to a forensic review of `AuditLog`.

The current application-level `console.error` at `line 4425` only fires on query errors, not on the 429 decision path.

**Impact:** Monitoring blindspot. Cannot distinguish a legitimate "user forgot to commit batches" from a scripted batch-creation probe without access to nginx access logs.

**Remediation:**
1. Add a structured log line (not an audit record — 429 is not a write) on the rejection path:

```typescript
if (open >= BULK_MAX_OPEN_BATCHES) {
  log.warn(`[POST /api/documents/bulk/batches] Rate-limited: user=${req.user!.email} open=${open} max=${BULK_MAX_OPEN_BATCHES}`);
  res.status(429).json({ … });
  return;
}
```

2. Optionally, write an `AuditLog` entry with action `BULK_LIMIT_REACHED` (not a write operation but a security event). This is consistent with how similar rate-limit events are tracked in other parts of the codebase (e.g. failed MFA attempts). Weigh the benefit against AuditLog table growth given finding TASK-B-A04-2.

---

## Summary Risk Matrix

| OWASP Category | Risk | Finding |
|----------------|------|---------|
| A01: Broken Access Control | NONE | `req.user!.email` from verified JWT; tagged-template SQL params; list endpoint owns-filter verified. |
| A02: Cryptographic Failures | NONE | No change to crypto primitives. |
| A03: Injection | NONE | All new queries use Prisma tagged templates. No new user-supplied string reaches SQL. |
| A04: Insecure Design | MEDIUM | **TASK-B-A04-1**: 5 batches × 200 MB = 1 GB peak staging disk; no per-user byte cap. **TASK-B-A04-2**: REAPED rows accumulate indefinitely; no secondary cleanup path. |
| A05: Security Misconfiguration | LOW | **TASK-B-A05-1**: `BULK_MAX_OPEN_BATCHES=0` or `NaN` disables feature or limit without startup warning. |
| A06: Vulnerable Components | NONE | No new dependencies. |
| A07: Auth & Session | NONE | No change. |
| A08: Software & Data Integrity | NONE | State machine transitions use tagged-template `$executeRaw`; no string concatenation. |
| A09: Logging & Monitoring | LOW | **TASK-B-A09-1**: HTTP 429 rejection produces no audit log record and no structured warning log line. |
| A10: SSRF | NONE | No new outbound HTTP calls. |

---

## Recommended Remediation Backlog

| Priority | ID | Action | Effort |
|----------|----|--------|--------|
| MEDIUM | TASK-B-A04-1 | Add per-user total-staging-bytes guard at `POST /api/documents/bulk/batches`; document `BULK_MAX_OPEN_BATCHES × BULK_MAX_TOTAL_MB` relationship in `install.conf` | Medium (1–2 h) |
| MEDIUM | TASK-B-A04-2 | Add secondary DELETE of REAPED rows older than `BULK_REAPED_RETENTION_DAYS` (default 7) to hourly cron; add partial index on `bulk_import_item(status)` | Medium (1–2 h) |
| LOW | TASK-B-A09-1 | Emit `log.warn(…)` on 429 rejection path with `user_email` and batch counts | Low (15 min) |
| LOW | TASK-B-A05-1 | Add `Number.isFinite(v) && v >= 1` floor for `BULK_MAX_OPEN_BATCHES`; log startup warning on out-of-range value | Low (15 min) |

---

*Audit completed: 2026-06-01. Scope limited to the batch state machine, concurrent-batch limit, and cleanup cron changes. For the broader bulk import pipeline security assessment see `owasp-bulk-import.md` and `owasp-bulk-ocr.md`.*
