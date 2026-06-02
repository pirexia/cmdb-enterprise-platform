# OWASP Top 10 (2021) Security Audit — Bulk Batch List Endpoint & My Imports Page (Task C)

**Audit ID:** OWASP-TASK-C-001
**Audit date:** 2026-06-01
**Auditor:** Independent security review
**Classification:** CONFIDENTIAL — Internal security audit record
**Platform version:** v2.3.x (`main`, post-change)

---

## Scope

Targeted review of three related changes:

1. **`GET /api/documents/bulk/batches`** (`backend/src/index.ts:4494–4511`) — now returns `errors` (count of ERROR items) and `totalBytes` (raw bytes, cast from `bigint` to `Number`) in addition to the previously existing fields. Ownership scoped to `created_by = ${req.user!.email}`. Pagination: `LIMIT 100`, `ORDER BY b.created_at DESC`.
2. **`frontend/app/documents/bulk/page.tsx`** — new client-side page listing the caller's bulk import batches with status badges, item counts, filter tabs (All / Open / Done), and 10-second auto-refresh while any batch is in a non-terminal state. Guarded by `if (!isAdmin) return <error>`.
3. **Documents page** (`frontend/app/documents/page.tsx:499–502`) — new "My imports" button navigating to `/documents/bulk`, rendered inside `{isAdmin && …}`.

**OWASP categories assessed:** A01, A03, A04, A09.

---

## Findings by Severity

| Severity | Count | IDs |
|----------|-------|-----|
| CRITICAL | 0 | — |
| HIGH     | 0 | — |
| MEDIUM   | 1 | TASK-C-A04-1 |
| LOW      | 2 | TASK-C-A01-1, TASK-C-A05-1 |
| INFO     | 4 | A01 ownership verified; A03 injection surface verified clean; A09 read-only gap acceptable; XSS surface verified clean |

**Overall verdict: Changes are safe. Ownership isolation is correct and injection-free. One MEDIUM finding (LIMIT 100 silently drops oldest batches within the retention window for high-volume users). Two LOW findings (misleading non-admin error fallback; `BULK_REAPED_RETENTION_DAYS` lacks a NaN/floor guard). No access-control bypass, no injection, no XSS.**

---

## A01: Broken Access Control

**Applicability:** HIGH — the list endpoint uses `req.user!.email` as the ownership predicate; the frontend has an `isAdmin` guard that a non-admin user could try to bypass by navigating directly to `/documents/bulk`.
**Risk Level:** LOW (one finding — frontend guard is misleading but server enforces correctly).

### Controls Verified

`req.user!.email` is populated exclusively by `authenticateToken` (`index.ts:313–356`), which verifies the JWT signature with `jwt.verify(token, JWT_SECRET_VALUE, { algorithms: ['HS256'] })` and confirms `users.active = true` in the database before assigning the payload. The list query at `index.ts:4505` uses `WHERE b.created_by = ${req.user!.email}` as a tagged-template Prisma parameter — no string interpolation, no SQL injection. **A user cannot see another user's batches.**

`requireAdmin` middleware is applied to the endpoint (`index.ts:4495`), so a non-ADMIN authenticated user (AUDITOR, VIEWER) is rejected with HTTP 403 before the query runs. The `isAdmin` frontend guard at `page.tsx:116–118` is defence-in-depth only; it does not substitute for the server-side check.

The `errors` and `totalBytes` fields are both computed from DB-internal data (aggregate `COUNT()` and stored `total_bytes` column). Neither field is derived from any user-supplied string.

### Finding TASK-C-A01-1 — LOW | CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:N/I:N/A:N (0.0 base, elevated by UX/compliance concern)

**Location:** `frontend/app/documents/bulk/page.tsx:116–118` — non-admin fallback render.

**Description:** When `!isAdmin` the page renders `t("common.unknown_error")` inside a full-height centred `div` with no redirect, no 403 message, and no navigation back to a known page. This is the only observable behaviour for a VIEWER or AUDITOR who navigates directly to `/documents/bulk` via URL. The server correctly returns HTTP 403, and `apiFetch` surfaces the error state — but the rendered text ("unknown error") is misleading and provides no actionable guidance.

This is not a security bypass (the API enforces the check), but it is a compliance concern: a user who accidentally reaches the page receives no information that they lack the required role, which could generate unnecessary support tickets or obscure a configuration problem.

**Impact:** UX / auditability. No data exposed.

**Remediation:** Replace the non-admin fallback with an explicit access-denied message and a redirect to `/documents`:

```tsx
if (!isAdmin) {
  router.replace("/documents");
  return null;
}
```

---

## A03: Injection

**Applicability:** HIGH — `errors` and `totalBytes` are new fields returned by a raw SQL query.
**Risk Level:** NONE (controls verified).

### Assessment

The entire query at `index.ts:4497–4508` uses Prisma's tagged template literal (`prisma.$queryRaw\`...\``). The only parameter interpolated is `${req.user!.email}` (the verified JWT email), which Prisma parameterizes as `$1` — no string concatenation touches the SQL. The `errors` and `totalBytes` values are computed server-side via `COUNT() FILTER (WHERE i.status = 'ERROR')` and `b.total_bytes::text` respectively — neither field touches user-supplied input. **No injection surface exists.**

`bigint` values (`committed`, `pending`, `errors`) are correctly wrapped with `Number()` at `index.ts:4509` before serialization, consistent with the project's established pattern for PostgreSQL `COUNT()` results.

---

## A04: Insecure Design (Response Size / Data Visibility)

**Applicability:** MEDIUM — the endpoint uses `LIMIT 100` with no pagination; terminal batches accumulate within the `BULK_REAPED_RETENTION_DAYS` window.
**Risk Level:** MEDIUM (one finding).

### Controls Verified

- Response is bounded to 100 rows (`LIMIT 100`, `ORDER BY b.created_at DESC`).
- Open batches are capped at `BULK_MAX_OPEN_BATCHES` (default 5) per user.
- Terminal batches are permanently deleted after `BULK_REAPED_RETENTION_DAYS` (default 7 days) by the secondary cleanup pass in the hourly cron (`index.ts:5624–5631`).
- The response payload contains only aggregate counts and metadata — no user-controlled strings (no `original_name`, no file content).

### Finding TASK-C-A04-1 — MEDIUM | CVSS:3.1/AV:N/AC:H/PR:H/UI:N/S:U/C:N/I:N/A:L (2.5)

**Location:** `index.ts:4507` — `LIMIT 100` without pagination; `frontend/app/documents/bulk/page.tsx:93` — `setBatches(data)` replaces the full list on every poll.

**Description:** The list endpoint returns at most 100 batches per user (most recent first). A high-volume ADMIN user who creates and terminates batches repeatedly within the `BULK_REAPED_RETENTION_DAYS` window (default 7 days) can accumulate more than 100 terminal batch rows before the retention cleanup removes them. When this happens, the list silently shows only the 100 most recent batches — the oldest ones within the retention window are dropped from the response without any indication to the user.

**Concrete scenario with defaults:** `BULK_MAX_OPEN_BATCHES = 5`. A user creates and commits 5 batches per day for 21 days. After 7 days the oldest 35 are deleted by the retention cron. Between days 8–14 the user holds 5 × 7 = 35 terminal rows simultaneously; at 15+ days (before cleanup) they can exceed 100 terminal rows — but this requires sustained high-frequency usage.

**Security impact:** Low — the endpoint is scoped to the caller's own batches, and the `ORDER BY created_at DESC` means the most operationally relevant (newest) batches are always shown. However, the silent truncation:
1. Could mislead the user into thinking old batches were deleted (when they haven't been yet), obscuring the audit trail visible to the user.
2. Triggers a full list replacement on every 10-second auto-refresh poll. At 100 rows × typical batch record size (~200 bytes per row), each poll response is ~20 KB — acceptable, but the polling interval combined with a large result set creates a modest sustained backend load when many ADMIN users are active simultaneously. With the default 10-second interval across N concurrent active users, the endpoint is called `N × 6` times per minute.

**Impact:** Data visibility (silent pagination loss); minor sustained DB load under concurrent use. Not an exploit path.

**Remediation:**
1. Add a `total` count to the response so the client can indicate when results are truncated:

```typescript
const [rows, countRows] = await Promise.all([
  prisma.$queryRaw<...[]>`SELECT … LIMIT 100`,
  prisma.$queryRaw<[{ total: bigint }][]>`SELECT COUNT(*) AS total FROM "bulk_import_batch" WHERE created_by = ${req.user!.email}`,
]);
res.json({ batches: rows.map(…), total: Number(countRows[0].total) });
```

2. Optionally add `?offset=` pagination (0-based) so the UI can page through older batches. This is low-priority given the 7-day retention default.
3. On the frontend, display a notice when `total > batches.length` (e.g. "Showing 100 of N batches. Older batches expire after 7 days.").

---

## A05: Security Misconfiguration

**Applicability:** LOW — `BULK_REAPED_RETENTION_DAYS` is a new env var used in a raw SQL `make_interval()` call.
**Risk Level:** LOW.

### Finding TASK-C-A05-1 — LOW | CVSS:3.1/AV:L/AC:H/PR:H/UI:N/S:U/C:N/I:N/A:L (1.9)

**Location:** `index.ts:3136` — `parseInt(process.env.BULK_REAPED_RETENTION_DAYS ?? '7', 10)`; `index.ts:5629` — `make_interval(days => ${BULK_REAPED_RETENTION_DAYS}::int)`.

**Description:** `BULK_REAPED_RETENTION_DAYS` is parsed with `parseInt` but has no `Number.isFinite` or floor guard, consistent with the pre-existing risk identified for `BULK_MAX_OPEN_BATCHES` in `TASK-B-A05-1`.

Two failure modes:

- **`BULK_REAPED_RETENTION_DAYS=0`**: `make_interval(days => 0)` is valid SQL and evaluates to `'0 days'`. The condition `updated_at < now() - '0 days'` is `updated_at < now()`, which is always true — all REAPED rows are immediately deleted on the next cron tick, regardless of how recently they were marked REAPED. This eliminates the grace period the feature is designed to provide (users can no longer see recently expired batches in the list).

- **`BULK_REAPED_RETENTION_DAYS=NaN`**: `::int` cast of `NaN` in PostgreSQL raises `invalid input syntax for type integer` — the cron's `catch` block swallows the error (`log.error('[BulkCleanupCron] Cleanup error:', e)`) and the secondary cleanup pass is silently skipped. This is a milder failure than the `=0` case (rows accumulate rather than being over-deleted) but is still an operator misconfiguration that leaves no obvious trace beyond the error log.

**Impact:** Configuration error causes either premature batch row deletion (0) or indefinite retention (NaN). Neither is a direct security exploit, but the `=0` case erases the user-facing history for REAPED batches, which could interfere with post-incident forensics if an operator accidentally sets it.

**Remediation:**

```typescript
const _rawRetentionDays = parseInt(process.env.BULK_REAPED_RETENTION_DAYS ?? '7', 10);
const BULK_REAPED_RETENTION_DAYS = Number.isFinite(_rawRetentionDays) && _rawRetentionDays >= 1
  ? _rawRetentionDays
  : 7;
```

Apply the same `Number.isFinite(v) && v >= 1 ? v : default` pattern to all `BULK_*` `parseInt` constants at `index.ts:3123–3136` for consistency. Log a startup warning if any value is out of range.

---

## A09: Logging & Monitoring

**Applicability:** LOW — the new endpoint is a read-only list; no write operations are performed.
**Risk Level:** NONE.

### Assessment

`GET /api/documents/bulk/batches` is a scoped read of the caller's own data. Under ISO 27001 A.8.15, audit logging of read-only list endpoints that return no third-party data is not required. The data returned (aggregate counts, UUIDs, timestamps) carries no PII beyond the implicit scoping to `req.user!.email`, which is already captured in the JWT and available in nginx access logs.

The auto-refresh mechanism (10-second interval from the frontend) generates repeated GET calls while batches are active. These are authentication-checked by `authenticateToken` on every request, so repeated polling does not create a session or access-control gap.

**No audit logging gap identified for this endpoint.**

---

## XSS Surface Assessment

All fields rendered in `frontend/app/documents/bulk/page.tsx` are safe:

| Field | Type | Rendered as |
|-------|------|-------------|
| `b.id` | UUID string (DB-generated) | React key + `router.push()` path segment — never rendered as HTML |
| `b.status` | Enum string, mapped via `cfg[status]` lookup | Translation key lookup via `t()`, then JSX text node |
| `b.fileCount` | Integer | JSX text node `{b.fileCount}` |
| `b.committed` / `b.pending` / `b.errors` | Integer | JSX text node inside `<span>` |
| `b.totalBytes` | Integer | Passed to `formatFileSize()` (arithmetic only), rendered as JSX text node |
| `b.createdAt` | ISO timestamp | Passed to `formatDate()` (date parsing only), rendered as JSX text node |

No field uses `dangerouslySetInnerHTML`. The `StatusBadge` component maps status to a translation key via `t(\`documents.bulk.status_${status}\`)` — the resulting string is rendered as a React text node, not HTML. An unknown status value falls back to `cfg.UPLOADED` via the `?? cfg.UPLOADED` guard at `page.tsx:67`. **No XSS surface identified.**

---

## Summary Risk Matrix

| OWASP Category | Risk | Finding |
|----------------|------|---------|
| A01: Broken Access Control | LOW | **TASK-C-A01-1**: Non-admin fallback renders generic "unknown error" instead of redirecting; server-side enforcement is correct. |
| A02: Cryptographic Failures | NONE | No change to crypto primitives. |
| A03: Injection | NONE | All new fields computed server-side via tagged-template Prisma query; no user-supplied string reaches SQL or HTML. |
| A04: Insecure Design | MEDIUM | **TASK-C-A04-1**: `LIMIT 100` silently truncates oldest batches for high-volume users within the retention window; no `total` count returned; 10-second polling multiplies load with concurrent users. |
| A05: Security Misconfiguration | LOW | **TASK-C-A05-1**: `BULK_REAPED_RETENTION_DAYS` lacks `Number.isFinite` + floor guard; `=0` deletes all REAPED rows immediately; `=NaN` silently skips secondary cleanup. |
| A06: Vulnerable Components | NONE | No new dependencies. |
| A07: Auth & Session | NONE | Auto-refresh polls are authentication-checked on every request via `authenticateToken`. |
| A08: Software & Data Integrity | NONE | No new file operations; `b.id` UUID in `router.push` is DB-generated, not user-controlled. |
| A09: Logging & Monitoring | NONE | Read-only list endpoint; no audit log entry required. No PII returned beyond aggregate counts. |
| A10: SSRF | NONE | No new outbound HTTP calls. |

---

## Recommended Remediation Backlog

| Priority | ID | Action | Effort |
|----------|----|--------|--------|
| MEDIUM | TASK-C-A04-1 | Return `total` batch count alongside the 100-row result; add frontend notice when results are truncated | Low (30 min) |
| LOW | TASK-C-A05-1 | Add `Number.isFinite(v) && v >= 1 ? v : default` guard for `BULK_REAPED_RETENTION_DAYS`; apply same pattern to all `BULK_*` `parseInt` constants; log startup warning on out-of-range values | Low (20 min) |
| LOW | TASK-C-A01-1 | Replace non-admin fallback with `router.replace("/documents"); return null;` | Low (5 min) |

---

*Audit completed: 2026-06-01. Scope limited to the GET batch list endpoint, the My Imports frontend page, and the documents-page navigation button. For the broader bulk import pipeline security assessment see `owasp-bulk-import.md` and `owasp-bulk-ocr.md`. For the batch state machine, concurrent-batch limit, and cleanup cron see `owasp-task-b.md`.*
