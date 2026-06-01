# OWASP Top 10 (2021) Security Audit — CI Status Column (Task D)

**Audit ID:** OWASP-TASK-D-001
**Audit date:** 2026-06-01
**Auditor:** Independent security review
**Classification:** CONFIDENTIAL — Internal security audit record
**Platform version:** v2.3.x (`main`, post-change)

---

## Scope

Targeted review of the `status` column addition to the CI inventory table:

1. **`CIStatusBadge` component** (`frontend/app/inventory/page.tsx:175–186`) — renders a coloured `<span>` badge for ACTIVO / INACTIVO / RETIRADO values.
2. **Sort logic** (`page.tsx:346`) — `SortCol` extended with `"status"`; sort uses `.localeCompare` on `(a.status ?? "ACTIVO")`.
3. **Filter logic** (`page.tsx:324`) — `filters.status` compared with `===` against `(ci.status ?? "ACTIVO")` in a client-side `useMemo`.
4. **Filter dropdown** (`page.tsx:630–635`) — hardcoded `<option>` values; calls `setFilter("status", value)`.
5. **Data cell** (`page.tsx:713`) — `<CIStatusBadge status={ci.status ?? "ACTIVO"} t={t} />`.

No backend changes. `status` was already returned by `GET /api/cis`. i18n keys added to all 6 locale files.

**OWASP categories assessed:** A01, A03, A04.

---

## Findings by Severity

| Severity | Count | IDs |
|----------|-------|-----|
| CRITICAL | 0 | — |
| HIGH     | 0 | — |
| MEDIUM   | 0 | — |
| LOW      | 1 | TASK-D-A04-1 |
| INFO     | 3 | A01 server-side controls unchanged; A03 XSS surface clean; A03 filter injection impossible |

**Overall verdict: Change is safe. No XSS surface, no access-control bypass, no injection. One LOW finding: the `?? "ACTIVO"` default silently presents null-status CIs as active, which may mislead operators reviewing the inventory.**

---

## A01: Broken Access Control

**Applicability:** LOW — the status filter is entirely client-side; no new server-side query parameters were added.
**Risk Level:** NONE.

The status filter operates on data that `GET /api/cis` has already returned. That endpoint is guarded by `authenticateToken` and `requireAudit` (unchanged). The server applies DB-level RBAC before returning any CI rows; client-side filtering is cosmetic and cannot expose CIs the user is not authorised to see. **No access-control bypass is possible.**

---

## A03: Injection / XSS

**Applicability:** HIGH — `ci.status` originates from the API and is rendered into the DOM.
**Risk Level:** NONE.

### XSS Surface

`CIStatusBadge` renders the status value in two places:

| Usage | Path | Safe? |
|-------|------|-------|
| CSS class lookup | `cfg[status] ?? "bg-slate-100 text-slate-500"` | Yes — an unknown key returns the fallback string; the `cfg` object is a static Record with no dynamic property assignment. The class string is applied via JSX `className`, not `dangerouslySetInnerHTML`. |
| Text content | `t(\`inventory.status.${status}\`) ?? status` | Yes — `t()` resolves the key through a nested object walk and returns the raw key string if not found (`LanguageContext.tsx:84–88`). The result is a React text node. |

No path from `ci.status` to `dangerouslySetInnerHTML` exists anywhere in the component tree. React escapes text nodes by default. **No XSS surface identified.**

### Filter Injection

`filters.status` is compared with strict equality (`===`) against the API-supplied `ci.status` in a client-side `useMemo`. The filter value originates from a `<select>` with hardcoded `<option>` elements — no free-text input, no URL parameter parsing, no server-side query involvement. **No injection surface exists.**

---

## A04: Insecure Design

**Applicability:** MEDIUM — the `?? "ACTIVO"` default affects how null-status CIs are classified in the UI.
**Risk Level:** LOW (one finding).

### Finding TASK-D-A04-1 — LOW | CVSS:3.1/AV:N/AC:H/PR:L/UI:R/S:U/C:N/I:N/A:N (0.0 base, elevated by compliance concern)

**Location:** `page.tsx:324` (filter), `page.tsx:346` (sort), `page.tsx:713` (badge render) — all use `ci.status ?? "ACTIVO"`.

**Description:** A CI with `status: null` in the database is displayed, filtered, and sorted as if its status is ACTIVO (active). An operator filtering the inventory to `ACTIVO` will see all null-status CIs in the results without any visual indication that their status is unset rather than explicitly confirmed active.

This is not a security exploit — no data is exposed and no access control is bypassed. However, it creates a misleading operational picture:

- A CI may have been imported without a `status` value (e.g. via bulk import or direct DB insert), leaving its lifecycle state genuinely unknown.
- Showing it as ACTIVO implies it has been reviewed and confirmed operational, which is incorrect.
- An operator auditing the inventory for "all active CIs" will silently include these unreviewed items.

Under ISO 27001 A.8.9 (Configuration management) and NIS2 availability assurance, the CI inventory is expected to reflect accurate lifecycle state. Silently promoting `null` to ACTIVO weakens the reliability of that record.

**Impact:** Operational / audit accuracy. No security exploit path. No data exposed.

**Remediation:** Introduce a distinct "Unknown" display state for null status values:

```tsx
// In CIStatusBadge, accept null explicitly
function CIStatusBadge({ status, t }: { status: string | null; t: (k: string) => string }) {
  if (status === null) {
    return (
      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold bg-slate-100 text-slate-400 italic">
        {t("inventory.status.UNKNOWN")}
      </span>
    );
  }
  // ... existing cfg lookup
}
```

Add `"UNKNOWN"` to all 6 locale files. Adjust the filter and sort callers to pass `ci.status` without the `?? "ACTIVO"` coercion; treat `null` as a separate filter option or exclude it from the ACTIVO filter bucket.

---

## Summary Risk Matrix

| OWASP Category | Risk | Finding |
|----------------|------|---------|
| A01: Broken Access Control | NONE | Status filter is client-side over already-authorised data; server-side RBAC unchanged. |
| A02: Cryptographic Failures | NONE | No change to crypto primitives. |
| A03: Injection / XSS | NONE | `CIStatusBadge` renders status as a React text node; `cfg[status]` lookup cannot produce HTML; no `dangerouslySetInnerHTML`. Filter uses strict `===` comparison on hardcoded select values. |
| A04: Insecure Design | LOW | **TASK-D-A04-1**: `?? "ACTIVO"` default silently presents null-status CIs as active; misleads operators filtering or auditing the inventory. |
| A05–A10 | NONE | No new dependencies, no new auth surface, no new server calls, no file operations, no outbound HTTP. |

---

## Recommended Remediation Backlog

| Priority | ID | Action | Effort |
|----------|----|--------|--------|
| LOW | TASK-D-A04-1 | Replace `?? "ACTIVO"` coercion with an explicit "Unknown" badge for null status; add locale key to all 6 files; treat null as a distinct filter value | Low (30 min) |

---

*Audit completed: 2026-06-01. Scope limited to the CIStatusBadge component, status sort/filter logic, and the filter dropdown in `frontend/app/inventory/page.tsx`. No backend changes were in scope. For the broader CI inventory security assessment see `owasp-top10.md` and `general-security.md`.*
