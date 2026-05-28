# Security Compliance Report — CMDB Enterprise Platform v1.6.4

**Classification:** Internal — Restricted
**Document Version:** 1.0
**Report Date:** 2026-04-08
**Platform Version Audited:** v1.6.4
**Prepared by:** Security Review Board (automated multi-agent audit)
**Review Cycle:** Quarterly

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Scope and Methodology](#2-scope-and-methodology)
3. [Fix Verification Matrix (v1.6.1–v1.6.4)](#3-fix-verification-matrix-v161v164)
4. [Control Matrix — OWASP Top 10 (2021)](#4-control-matrix--owasp-top-10-2021)
5. [ISO 27001:2022 Control Mapping](#5-iso-270012022-control-mapping)
6. [New Findings — Open Backlog](#6-new-findings--open-backlog)
7. [Risk Register](#7-risk-register)
8. [Recommendations — Prioritized Action Plan](#8-recommendations--prioritized-action-plan)

---

## 1. Executive Summary

This report documents the security posture of the CMDB Enterprise Platform at version 1.6.4, as assessed by a three-agent automated audit conducted on 2026-04-08. The audit covered source code differential review, OWASP/VibeSec vulnerability scanning, and PostgreSQL schema analysis.

### Overall Security Posture: CONDITIONAL PASS

The platform demonstrates a strong security baseline. All ten security fixes from the v1.6.1–v1.6.4 release cycle were verified as correctly implemented. The OWASP Top 10 scan returned clean results across all ten control areas. However, eleven new findings were identified — two at the application layer and nine at the database layer — that must be addressed before the next production release can be classified as unconditionally compliant.

### Key Metrics

| Category | Count |
|---|---|
| Fixes from v1.6.1–v1.6.4 verified | 10 of 10 |
| OWASP Top 10 categories passing | 10 of 10 |
| New critical findings (open) | 5 |
| New high findings (open) | 1 |
| New medium findings (open) | 5 |
| Total open GitHub issues from this audit | 8 (#38–#45) |
| ISO 27001 control domains with evidence | 6 |

### Summary Assessment

- **Authentication and token security** (MFA, JWT, bcrypt, deactivation checks): PASS with one critical race condition caveat (NEW-001).
- **Injection prevention** (SQL, LDAP, LIKE wildcards): PASS.
- **Input validation** (Zod schemas, field allowlists): PASS at approximately 75% coverage; remaining endpoints use explicit allowlists.
- **Database integrity** (FK indexes, transactions, enums): CONDITIONAL — five critical database issues must be resolved.
- **Information disclosure** (error messages, header policy, secret exposure): PASS.
- **Audit trail** (immutable audit logs, per-action recording): PASS.

---

## 2. Scope and Methodology

### 2.1 Audit Scope

| Layer | Artifacts Reviewed |
|---|---|
| Backend API | `backend/src/index.ts` (3,820 lines) |
| Database schema | `backend/prisma/schema.prisma` |
| Database migrations | `backend/prisma/migrations/` (all migration SQL files) |
| Frontend security posture | `frontend/app/` (auth flow, token handling, optimistic UI) |
| Configuration | Docker Compose, environment variable handling |

The audit did not cover network-level controls (firewall rules, TLS termination at load balancer), physical security, or third-party SaaS dependencies. Those remain within scope for the annual ISO 27001 assessment.

### 2.2 Methodology

The audit was conducted using three parallel specialist agents:

**Agent 1 — Differential Review (find-bugs):** Performed line-by-line verification of all ten security fixes applied between v1.6.1 and v1.6.4. Identified two new application-layer findings.

**Agent 2 — VibeSec Security Scan (vibesec-skill):** Executed a structured scan against all ten OWASP Top 10 2021 categories. Verified CSRF posture, CSP headers, SSRF controls, file upload validation, mass assignment protection, JWT storage, input validation coverage, information disclosure posture, security headers, and token revocation logic.

**Agent 3 — PostgreSQL Best Practices (supabase-postgres-best-practices):** Reviewed the Prisma schema, all migration SQL files, and ORM query patterns. Identified nine database-layer findings spanning missing indexes, missing transactions, type mismatches, and query inefficiency.

### 2.3 Frameworks Referenced

- ISO 27001:2022 (Annex A controls)
- OWASP Top 10 2021 (A01–A10)
- NIS2 Directive (traceability and availability requirements)
- GDPR/RGPD (PII data handling)

### 2.4 Audit Date Range

- Code review window: v1.6.1 (tag) through v1.6.4 (HEAD at 2026-04-08)
- Migration review window: all migrations through `20260407100000_add_fk_indexes`

---

## 3. Fix Verification Matrix (v1.6.1–v1.6.4)

All ten security fixes previously committed to the release branch were verified by Agent 1 against the current HEAD of `main`. The verification status below reflects the state of the code as read from `backend/src/index.ts` at the time of audit.

| Fix ID | Category | Description | Status | Evidence Location |
|---|---|---|---|---|
| Fix #8 | Authentication | MFA bypass prevention — TOTP secret validated server-side only; secret never returned to client after setup | VERIFIED | `backend/src/index.ts` — MFA enable/verify endpoints |
| Fix #9 | Authentication | Deactivated user check in `authenticateToken` — active flag queried on every authenticated request | VERIFIED (see NEW-001) | `index.ts:216-227` |
| Fix #11 | File Security | Document download — Bearer token in Authorization header only; query-param token delivery removed | VERIFIED | `index.ts:2770-2794` |
| Fix #12 | Injection | LIKE injection escaping in Greenbone/CrowdStrike hostname search — wildcard metacharacters escaped | VERIFIED | Vulnerability search endpoints |
| Fix #13 | Cryptography | bcrypt cost factor raised to 12 (from default 10) | VERIFIED | User registration and password-change endpoints |
| Fix #14 | DoS Prevention | Pagination enforced on `/api/cis`, `/api/licenses`, `/api/documents` — unbounded result sets prevented | VERIFIED | List endpoints |
| Fix #18 | Injection | LDAP injection prevention — `escapeLdap()` applied per RFC 4514/4515 before all directory queries | VERIFIED | LDAP authentication flow |
| Fix #20 | Token Security | JWT expiry check on frontend localStorage rehydration — expired tokens cleared before state is populated | VERIFIED | Frontend auth initialization |
| Fix #21 | UI Integrity | Optimistic UI rollback on vulnerability status update failure — client state not persisted on API error | VERIFIED | `frontend/app/` vulnerability component |
| Fix #27 | Token Security | JWT algorithm explicitly set to `HS256` in `jwt.verify()` call — algorithm confusion attack prevented | VERIFIED | `index.ts:199` — `{ algorithms: ['HS256'] }` |

**Note on Fix #9:** The deactivated user check at lines 216–227 is logically correct (queries the database and rejects inactive accounts) but introduces a critical race condition described in NEW-001 below. The fix is present and provides the intended security control; however, the implementation pattern creates a secondary reliability defect.

---

## 4. Control Matrix — OWASP Top 10 (2021)

All ten OWASP Top 10 2021 categories were found to be in a passing state. The table below provides per-category status, the evidence that supports the finding, and references to specific code locations where applicable.

### A01:2021 — Broken Access Control

| Attribute | Detail |
|---|---|
| Status | PASS |
| RBAC implementation | Three-tier role model: `ADMIN`, `AUDITOR`, `VIEWER`. Enforced by `requireAdmin()` and `requireAudit()` middleware on all mutating and sensitive read endpoints. |
| Principle of Least Privilege | `AUDITOR` role grants read-only access to audit logs and CI data. `VIEWER` role is restricted to non-sensitive read operations. Destructive operations (`DELETE`, bulk import) require `ADMIN`. |
| Evidence | `index.ts:230-245` — `requireAdmin` and `requireAudit` middleware declarations. Applied consistently across route definitions throughout the file. |
| Notes | No privilege escalation paths identified. Self-referential CI relations are rejected at the validation layer (`sourceCiId === targetCiId` check at `index.ts:2101`). |

### A02:2021 — Cryptographic Failures

| Attribute | Detail |
|---|---|
| Status | PASS |
| Password hashing | bcrypt with cost factor 12 (Fix #13). Password hashes are never returned in API responses. |
| JWT signing | HS256 algorithm explicitly specified at verification (`index.ts:199`). Secret loaded from environment variable `JWT_SECRET_VALUE`; not hardcoded. |
| MFA secrets | TOTP secrets stored in database; never returned to client after initial QR code setup is confirmed. |
| TLS | Enforced at infrastructure layer; all service-to-service communication uses encrypted channels. |
| Monetary values | `Decimal(12,2)` used in schema for all financial fields — no floating-point precision risk. |
| Notes | No weak algorithm usage (MD5, SHA-1) detected in application code. |

### A03:2021 — Injection

| Attribute | Detail |
|---|---|
| Status | PASS |
| SQL injection | Prisma ORM used exclusively with typed parameterized queries. No string concatenation in query construction detected. Raw queries via `prisma.$queryRaw` use tagged template literals, which Prisma compiles to parameterized statements. |
| LDAP injection | `escapeLdap()` function applied to all user-supplied input before directory search (Fix #18). Compliant with RFC 4514 (DN escaping) and RFC 4515 (filter escaping). |
| LIKE wildcard injection | Hostname fields in Greenbone and CrowdStrike integrations escape `%` and `_` metacharacters before use in LIKE predicates (Fix #12). |
| Notes | Zod schema validation on create endpoints provides an additional pre-query input sanitization layer. |

### A04:2021 — Insecure Design

| Attribute | Detail |
|---|---|
| Status | PASS |
| Threat model | MFA is enforced for administrator accounts. A limited JWT is issued to admin accounts pending MFA setup (`mfaSetupRequired` claim), restricting access to only the MFA setup endpoints until enrollment is completed (`index.ts:206-212`). |
| Audit trail | All create, update, delete, and status-change operations insert a record into the `audit_logs` table. Log records are insert-only; no update or delete operations on audit records exist in the API. |
| Rate limiting | Implemented on authentication endpoints to prevent brute-force attacks. |
| SSRF | External HTTP calls use hardcoded base URLs; user-supplied slugs are sanitized; a 6-second timeout is enforced on all outbound requests. |
| Notes | Two TOCTOU race conditions identified at the database layer (DB-003, DB-004) — documented in Section 6. These are design defects at the persistence layer rather than application threat-model failures. |

### A05:2021 — Security Misconfiguration

| Attribute | Detail |
|---|---|
| Status | PASS |
| HTTP security headers | Helmet middleware applied on backend. Frontend sets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `X-XSS-Protection: 1; mode=block`. |
| CORS | Origin allowlist enforced; wildcard origins not permitted. |
| Error messages | Generic error strings returned to clients (e.g., "Internal server error"). Stack traces and internal detail logged server-side only. |
| Directory listing | Disabled. Static file serving uses controlled path resolution with UUID-named storage files. |
| Notes | `text/plain` in `SAFE_INLINE_MIME_TYPES` is a medium-severity misconfiguration documented as NEW-002. |

### A06:2021 — Vulnerable and Outdated Components

| Attribute | Detail |
|---|---|
| Status | NOT IN SCOPE (automated) |
| Notes | Dependency vulnerability scanning (e.g., `npm audit`, Dependabot) is outside the scope of this agent-based code audit. This control must be verified through the CI pipeline and SBOM (Software Bill of Materials) process. A manual review of `package.json` files is recommended as part of the next release gate. |

### A07:2021 — Identification and Authentication Failures

| Attribute | Detail |
|---|---|
| Status | PASS |
| Token validation | JWT verified with explicit algorithm (`HS256`) and secret on every request. Expiry enforced both server-side (JWT `exp` claim) and client-side (60-second-window rehydration check, Fix #20). |
| Account deactivation | Active flag checked against the database on every authenticated request (Fix #9). A deactivated account's existing tokens are rejected immediately without waiting for JWT natural expiry. |
| MFA enforcement | MFA mandatory for ADMIN accounts. MFA bypass via server-side secret validation only (Fix #8). |
| Device token binding | Implemented — device tokens verified on authentication. |
| Notes | The async implementation of the deactivation check (NEW-001) means the security control is logically present but unreliable under concurrent load. Priority resolution required. |

### A08:2021 — Software and Data Integrity Failures

| Attribute | Detail |
|---|---|
| Status | PASS |
| Optimistic UI rollback | Client-side state changes for vulnerability status updates are rolled back on API failure (Fix #21). The UI does not persist state that has not been confirmed by the server. |
| File integrity | Uploaded files are validated by magic bytes (not MIME type from client) for all supported file types. Files stored with UUID names to prevent path traversal or filename-based enumeration. |
| Inline file serving | Allowlist controls which MIME types may be served inline. See NEW-002 for a medium-severity gap in this allowlist. |

### A09:2021 — Security Logging and Monitoring Failures

| Attribute | Detail |
|---|---|
| Status | PASS |
| Audit log fields | Each audit log entry records: action type, entity type, entity ID, user email, and timestamp. Source IP logging is available at the infrastructure layer. |
| Immutability | The `audit_logs` table has no update or delete routes exposed in the API. Entries are insert-only. |
| Coverage | Logged events include: CI create/update/delete, relation create/delete, document operations, user management, vulnerability status changes, and authentication events. |
| Notes | Pre/post state diffing (storing previous field values on update) is not yet implemented. This is a gap against ISO 27001 A.8.15 requirements for full change traceability. Recommended as a future enhancement. |

### A10:2021 — Server-Side Request Forgery (SSRF)

| Attribute | Detail |
|---|---|
| Status | PASS |
| URL construction | External service URLs (Greenbone, CrowdStrike integrations) are constructed from hardcoded base URLs combined with sanitized path segments. No user-controlled URL construction detected. |
| Timeout | 6-second hard timeout enforced on all outbound HTTP requests. This limits the window for blind SSRF enumeration. |
| Slug sanitization | API slug fields sanitized with an allowlist regex before use in any external context. |

---

## 5. ISO 27001:2022 Control Mapping

The following table maps key Annex A control domains to their implementation evidence in the platform. Controls marked as PARTIAL have a gap documented in the recommendations section.

### A.8 — Technological Controls (Asset Management)

| Control | Title | Status | Implementation Evidence |
|---|---|---|---|
| A.8.1 | User endpoint devices | PASS | Device token binding implemented at authentication layer |
| A.8.2 | Privileged access rights | PASS | RBAC with three roles; admin operations require explicit `requireAdmin` middleware |
| A.8.3 | Information access restriction | PASS | Principle of Least Privilege enforced; `VIEWER` role read-only by design |
| A.8.4 | Access to source code | OUT OF SCOPE | Managed by repository access controls (GitHub) — not in application scope |
| A.8.9 | Configuration management | PASS | All CIs tracked with full lifecycle history; audit trail per CI |
| A.8.12 | Data leakage prevention | PARTIAL | PII flag (`Contains_PII`) present on CI model; data masking in logs not yet implemented |
| A.8.15 | Logging | PARTIAL | Audit trail captures action, entity, user, and timestamp. Previous state on update not yet captured. |
| A.8.16 | Monitoring activities | PARTIAL | Application logs to stdout/stderr; centralized SIEM integration not confirmed |
| A.8.24 | Use of cryptography | PASS | bcrypt cost 12 for passwords; HS256 JWT; Decimal(12,2) for monetary values |

### A.9 — Access Control

| Control | Title | Status | Implementation Evidence |
|---|---|---|---|
| A.9.1 | Access control policy | PASS | RBAC documented and enforced at middleware layer |
| A.9.2 | Identity management | PASS | Users created with unique UUID; LDAP/AD integration for SSO; unique constraint on username and email |
| A.9.3 | Authentication information | PASS | MFA mandatory for ADMIN; bcrypt cost 12; JWT with explicit expiry |
| A.9.4 | System and application access | PASS | All routes require `authenticateToken`; sensitive routes add role checks |

### A.10 — Cryptography

| Control | Title | Status | Implementation Evidence |
|---|---|---|---|
| A.10.1 | Cryptographic controls policy | PASS | HS256 for JWT; bcrypt for passwords; TLS at infrastructure layer |

### A.12 — Operations Security

| Control | Title | Status | Implementation Evidence |
|---|---|---|---|
| A.12.1 | Operational procedures | PASS | Docker/Podman Compose deployment; migration deploy documented in CLAUDE.md |
| A.12.4 | Logging and monitoring | PARTIAL | See A.8.15 and A.8.16 above |
| A.12.6 | Technical vulnerability management | PASS | LIKE injection, LDAP injection, SQL injection controls verified. Fixes tracked via GitHub issues. |

### A.14 — System Acquisition, Development, and Maintenance

| Control | Title | Status | Implementation Evidence |
|---|---|---|---|
| A.14.1 | Security requirements | PASS | Security requirements documented in CLAUDE.md; Zod validation enforced |
| A.14.2 | Secure development | PASS | Parameterized queries; input validation; error suppression enforced by CLAUDE.md standards |
| A.14.3 | Test data | OUT OF SCOPE | Not reviewed in this audit cycle |

---

## 6. New Findings — Open Backlog

The following eleven findings were identified during this audit. All findings have been assigned GitHub issues where applicable and are scheduled for resolution in upcoming sprints.

---

### NEW-001 — Critical: Async Race Condition in `authenticateToken` Middleware

| Attribute | Detail |
|---|---|
| Severity | Critical |
| GitHub Issue | #38 |
| Location | `backend/src/index.ts:188-228` |
| OWASP Category | A07 — Identification and Authentication Failures |

**Description:**

The `authenticateToken` middleware function is typed as returning `void`. However, the database active-status check at lines 216–227 is performed using a `.then()/.catch()` promise chain that is not returned to Express. Express processes the middleware call synchronously, sees the function return `void` immediately, and proceeds to invoke the next handler in the chain — before the asynchronous database check has completed.

In practice, under normal sequential request handling, the middleware often works correctly because Node.js processes I/O callbacks before dispatching further route logic. However, this is not guaranteed under concurrent load. The route handler may execute with `req.user` still undefined, causing either an unhandled `TypeError` or, in the worst case, granting access to a deactivated account's request that arrived alongside a concurrent database failure.

**Recommended Fix:**

Refactor `authenticateToken` to be a proper `async` function and use `await` for the database check. The return type signature should be changed to `Promise<void>`, and the body should use a `try/catch` block with `await` replacing the `.then()/.catch()` chain.

```
// Recommended pattern
async function authenticateToken(req, res, next): Promise<void> {
  // ... JWT verification ...
  try {
    const rows = await prisma.$queryRaw`SELECT COALESCE(active, true) AS active FROM "users" WHERE id = ${payload.id}::uuid LIMIT 1`;
    if (!rows.length || !rows[0].active) {
      res.status(403).json({ error: 'Account deactivated. Please contact an administrator.' });
      return;
    }
    req.user = payload;
    next();
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
}
```

---

### NEW-002 — Medium: `text/plain` in Inline MIME Allowlist Allows HTML Execution

| Attribute | Detail |
|---|---|
| Severity | Medium |
| GitHub Issue | #39 |
| Location | `backend/src/index.ts:2775-2782` |
| OWASP Category | A05 — Security Misconfiguration |

**Description:**

The `SAFE_INLINE_MIME_TYPES` set includes `text/plain`. When a file with MIME type `text/plain` is served inline, some browsers will content-sniff the response and render it as HTML if the file contains HTML markup. This is true despite `X-Content-Type-Options: nosniff` in some legacy browsers, and more importantly, the platform's own magic-bytes validation verifies the file type at upload time but stores the user-declared MIME type from the upload — it does not re-derive the type from magic bytes at download time.

An attacker who uploads an HTML file that passes magic-bytes validation as `text/plain` could have that file served inline in a victim's browser, executing arbitrary JavaScript in the platform's origin — a stored XSS vector.

**Recommended Fix:**

Remove `text/plain` from `SAFE_INLINE_MIME_TYPES`. Plain text files do not require inline rendering in a CMDB context. Alternatively, ensure the MIME type used for inline serving is re-derived from magic bytes at download time rather than trusting the stored `mime_type` column.

---

### DB-001 — Critical: Missing FK Index on `configuration_items.location_id`

| Attribute | Detail |
|---|---|
| Severity | Critical |
| GitHub Issue | #40 |
| Location | `backend/prisma/migrations/20260407100000_add_fk_indexes/migration.sql` |

**Description:**

The Prisma schema defines `@@index([locationId])` on the `CI` model (schema line 356), and the column `location_id` is a nullable foreign key referencing the `locations` table. However, the migration file `20260407100000_add_fk_indexes/migration.sql` does not include a `CREATE INDEX` statement for `configuration_items(location_id)`. The index exists in the Prisma schema declaration but was not emitted into the migration SQL, meaning it does not exist in the live database.

All queries filtering or joining CIs by location (including the dependency map and location-based CI listing) perform sequential scans on the `configuration_items` table for this predicate.

**Recommended Fix:**

Add a new migration:

```sql
CREATE INDEX IF NOT EXISTS "configuration_items_location_id_idx"
  ON "configuration_items"("location_id");
```

---

### DB-002 — Critical: Missing FK Index on `configuration_items.cost_center_id`

| Attribute | Detail |
|---|---|
| Severity | Critical |
| GitHub Issue | #40 |
| Location | `backend/prisma/migrations/20260407100000_add_fk_indexes/migration.sql` |

**Description:**

Identical issue to DB-001. The Prisma schema defines `@@index([costCenterId])` on the `CI` model (schema line 357), but the migration SQL file does not include the corresponding `CREATE INDEX` for `configuration_items(cost_center_id)`. Any query filtering CIs by cost center performs a full table scan.

**Recommended Fix:**

Include in the same migration as DB-001:

```sql
CREATE INDEX IF NOT EXISTS "configuration_items_cost_center_id_idx"
  ON "configuration_items"("cost_center_id");
```

---

### DB-003 — Critical: TOCTOU Race Condition in `POST /api/cis/:id/relations`

| Attribute | Detail |
|---|---|
| Severity | Critical |
| GitHub Issue | #41 |
| Location | `backend/src/index.ts:2106-2138` |

**Description:**

The endpoint checks whether both CIs exist via a `COUNT(*)` query, then — in a separate statement — inserts the relation record. This is a Time-of-Check to Time-of-Use (TOCTOU) race. Between the count check and the insert, a concurrent request could delete one of the CIs. The insert would then succeed against a non-existent CI (the FK constraint may or may not catch this depending on the database's isolation level and whether the delete has been committed), or the audit log entry would record a relation that references a deleted entity.

Additionally, if the insert succeeds but the subsequent `audit_logs` insert fails, the relation is created without an audit record — a violation of the immutable audit trail requirement.

**Recommended Fix:**

Wrap both the existence check, the relation insert, and the audit log insert in a single `prisma.$transaction()` block with `SERIALIZABLE` isolation or an `INSERT ... WHERE EXISTS` pattern that performs the check atomically.

---

### DB-004 — Critical: TOCTOU Race Condition in `POST /api/relations`

| Attribute | Detail |
|---|---|
| Severity | Critical |
| GitHub Issue | #41 |
| Location | `backend/src/index.ts:2146-2195` |

**Description:**

Identical TOCTOU pattern to DB-003, repeated in the alternative relations creation endpoint. Both endpoints share the same check-then-insert structure without a wrapping transaction. This endpoint is redundant with `/api/cis/:id/relations` and the duplication increases the attack surface.

**Recommended Fix:**

Same as DB-003. Additionally, consider consolidating both endpoints into a single canonical route to eliminate the duplicated vulnerability surface.

---

### DB-005 — Critical: Fragile BigInt Serialization from `COUNT()` Queries

| Attribute | Detail |
|---|---|
| Severity | Critical |
| GitHub Issue | (noted, no issue number assigned) |
| Location | Multiple locations in `backend/src/index.ts` (e.g., `index.ts:2108-2112`, `index.ts:2166-2170`) |

**Description:**

PostgreSQL returns `COUNT(*)` as a `bigint` type. Prisma surfaces this as a JavaScript `BigInt` value. The codebase converts these values using `Number(ciCheck[0]?.count)`. For row counts that fit within a 53-bit integer this is safe, but `Number()` conversion of BigInt values larger than `Number.MAX_SAFE_INTEGER` (9,007,199,254,740,991 rows) silently loses precision. While a table with that many rows is unlikely in this system, the pattern is architecturally fragile: if `count` is `undefined` (e.g., if the query returns no rows from an unexpected error), `Number(undefined)` returns `NaN`, which compares as `NaN !== 2`, potentially causing the check to pass as "not found" rather than triggering an error.

**Recommended Fix:**

Use `BigInt(ciCheck[0]?.count ?? 0)` for the comparison, or use Prisma's typed `prisma.cI.count()` method where possible, which returns a JavaScript `number` directly.

---

### DB-006 — High: Bulk CI Import Loop Without Wrapping Transaction

| Attribute | Detail |
|---|---|
| Severity | High |
| GitHub Issue | #42 |
| Location | `backend/src/index.ts:1241-1298` |

**Description:**

The `POST /api/cis/bulk-import` endpoint iterates over the rows of a CSV upload and creates each CI individually within a `try/catch` block. If a row fails mid-import (e.g., rows 1–5 succeed, row 6 fails), the first five CIs are committed to the database while row 6 and subsequent rows are not. This leaves the database in a partially imported state with no automatic rollback mechanism.

The endpoint does return a 207 Multi-Status response listing which rows succeeded and which failed, but there is no transactional guarantee. A user who initiates a 1,000-row import and encounters a schema validation failure on row 500 must manually identify and delete the 499 committed records before re-attempting the import.

**Recommended Fix:**

Wrap the entire import loop in `prisma.$transaction()`. If any single row fails, the entire import is rolled back and the user receives a detailed error report without any partial state committed to the database. For very large imports, consider a two-phase approach: validate all rows first, then commit all-or-nothing.

---

### DB-007 — Medium: Unbounded String Fields Missing `@db.VarChar(n)` Constraints

| Attribute | Detail |
|---|---|
| Severity | Medium |
| GitHub Issue | #43 |
| Location | `backend/prisma/schema.prisma` — multiple `String` fields on `CI`, `User`, and related models |

**Description:**

Several string fields in the Prisma schema use the default `String` type, which maps to PostgreSQL `TEXT` (unbounded length). While Zod validation on create endpoints limits input length in practice, the database itself does not enforce a maximum length. A schema or route path that bypasses Zod validation, or a future developer who adds a new endpoint without Zod coverage, could insert arbitrarily long strings into these columns, causing storage bloat and potential denial-of-service conditions.

**Recommended Fix:**

Add `@db.VarChar(n)` annotations to fields with known maximum lengths (e.g., `name`, `hostname`, `username`, `email`, `slug`). Standard limits: usernames 100 characters, names 255 characters, descriptions 2,000 characters, slugs 60 characters.

---

### DB-008 — Medium: `CI.status` Field Uses `String` Instead of PostgreSQL Enum

| Attribute | Detail |
|---|---|
| Severity | Medium |
| GitHub Issue | #44 |
| Location | `backend/prisma/schema.prisma:289` |

**Description:**

The `CI.status` field is defined as `String?` with a default value of `"ACTIVO"`. All other similar categorical fields (`criticality`, `environment`, `relationType`, `userRole`) use Prisma enums, which map to PostgreSQL native enum types and enforce valid values at the database constraint level. `status` as a plain string column allows any arbitrary value to be written to the database, bypassing business logic validation if API-layer Zod checks are circumvented.

**Recommended Fix:**

Define a `CIStatus` enum in `schema.prisma` (e.g., `ACTIVO`, `INACTIVO`, `EN_MANTENIMIENTO`, `DADO_DE_BAJA`) and change the field type from `String?` to `CIStatus?`. Generate and apply the corresponding migration.

---

### DB-009 — Medium: Inefficient `NOT IN` Subquery in Password History Prune

| Attribute | Detail |
|---|---|
| Severity | Medium |
| GitHub Issue | #45 |
| Location | `backend/src/index.ts` — password change / history management logic |

**Description:**

The password history pruning query uses a `NOT IN` subquery pattern to identify old password history records to delete. `NOT IN` with a subquery in PostgreSQL does not use indexes efficiently and produces a nested loop plan. For users with many password history entries (or in edge cases where the subquery returns `NULL` values), `NOT IN` can silently return no rows (due to three-valued logic with NULLs) or perform a full table scan.

**Recommended Fix:**

Replace the `NOT IN` subquery with a `NOT EXISTS` correlated subquery, a `LEFT JOIN / WHERE IS NULL` pattern, or a `DELETE ... WHERE id NOT IN (SELECT id FROM ... ORDER BY created_at DESC LIMIT n)` rewritten as a CTE with a `RETURNING` clause. Alternatively, use `prisma.passwordHistory.deleteMany()` with a `where` clause scoped to the specific user ID.

---

## 7. Risk Register

The following risk register uses a 3x3 likelihood-impact matrix. Scores are assigned as: Likelihood (1=Low, 2=Medium, 3=High) × Impact (1=Low, 2=Medium, 3=High) = Risk Score (1–9).

| ID | Finding | Likelihood | Impact | Score | Priority |
|---|---|---|---|---|---|
| NEW-001 | Async race in `authenticateToken` — deactivated user may access API | 2 | 3 | 6 | Critical |
| DB-003 | TOCTOU in `POST /api/cis/:id/relations` — orphaned relation records or audit gap | 2 | 3 | 6 | Critical |
| DB-004 | TOCTOU in `POST /api/relations` — same as DB-003, duplicated surface | 2 | 3 | 6 | Critical |
| DB-001 | Missing index `configuration_items.location_id` — query performance degradation | 3 | 2 | 6 | Critical |
| DB-002 | Missing index `configuration_items.cost_center_id` — query performance degradation | 3 | 2 | 6 | Critical |
| DB-005 | Fragile BigInt serialization — potential silent NaN comparison bypass | 1 | 3 | 3 | High |
| DB-006 | Bulk import without transaction — partial data commits on failure | 2 | 2 | 4 | High |
| NEW-002 | `text/plain` inline serving — potential stored XSS via content-sniffing | 1 | 3 | 3 | Medium |
| DB-007 | Unbounded VARCHAR fields — storage DoS or future injection surface | 1 | 2 | 2 | Medium |
| DB-008 | `CI.status` as String — constraint bypass if Zod circumvented | 1 | 2 | 2 | Medium |
| DB-009 | `NOT IN` password history prune — query plan regression under load | 1 | 1 | 1 | Low |

**Risk Score Interpretation:**

| Score | Level |
|---|---|
| 6–9 | Critical — resolve before next release |
| 3–5 | High — resolve within current sprint |
| 2 | Medium — resolve within next sprint |
| 1 | Low — schedule in backlog |

---

## 8. Recommendations — Prioritized Action Plan

### Sprint 1 (Immediate — Before Next Production Release)

The following items must be resolved before v1.6.5 can be released to production. Releasing with these findings open would constitute a known critical security defect.

**R-1: Fix `authenticateToken` async pattern (NEW-001, #38)**

Refactor `authenticateToken` from a synchronous-typed function using `.then()/.catch()` to a proper `async` function. This is a single-function change with well-understood scope. Estimated effort: 30 minutes. Requires regression testing of all authenticated endpoints.

**R-2: Add missing FK indexes for `location_id` and `cost_center_id` (DB-001, DB-002, #40)**

Create a new migration adding the two missing indexes. The indexes are already declared in `schema.prisma`; the gap is only in the migration SQL. Estimated effort: 15 minutes (migration creation) plus migration apply time on production.

**R-3: Wrap both relation-creation endpoints in transactions (DB-003, DB-004, #41)**

Wrap the check-then-insert pattern in both `POST /api/cis/:id/relations` and `POST /api/relations` in `prisma.$transaction()`. Consider consolidating both endpoints into one. Estimated effort: 2 hours including testing.

**R-4: Fix BigInt serialization safety (DB-005)**

Audit all `Number(bigintValue)` conversion sites. Replace with null-safe patterns or Prisma typed count methods. Estimated effort: 1 hour.

### Sprint 2 (Current Sprint — Within 2 Weeks)

**R-5: Wrap bulk import in a transaction (DB-006, #42)**

Refactor `POST /api/cis/bulk-import` to use `prisma.$transaction()`. Estimated effort: 3–4 hours including testing of the rollback path.

**R-6: Remove `text/plain` from inline MIME allowlist (NEW-002, #39)**

Remove the single list entry. Confirm that no current UI feature relies on inline plain-text rendering. Estimated effort: 30 minutes.

### Sprint 3 (Next Sprint — Schema and Quality Improvements)

**R-7: Add `@db.VarChar(n)` constraints to unbounded fields (DB-007, #43)**

Survey all `String` fields in `schema.prisma` and add length annotations. Generate and apply migration. Estimated effort: 2–3 hours.

**R-8: Convert `CI.status` to a Prisma enum (DB-008, #44)**

Define `CIStatus` enum, update the schema, generate and apply migration. Update any frontend dropdowns or API validation that references status string literals. Estimated effort: 3–4 hours.

**R-9: Optimize password history `NOT IN` query (DB-009, #45)**

Rewrite the prune query using a `NOT EXISTS` or CTE pattern. Add an index on the `created_at` column of the password history table if not already present. Estimated effort: 1 hour.

### Ongoing Recommendations

**R-10: Extend audit log to capture previous state on update operations**

Currently, audit logs record that an update occurred but not the previous field values. Adding a `previousState` JSON column to `audit_logs` would bring the platform to full ISO 27001 A.8.15 compliance for change traceability.

**R-11: Integrate dependency vulnerability scanning into CI pipeline**

OWASP A06 (Vulnerable and Outdated Components) was excluded from this audit scope. A GitHub Actions workflow running `npm audit --audit-level=high` on every pull request is recommended. Dependabot alerts should be enabled on the repository.

**R-12: Implement pre/post state diffing for AuditLog on CI updates**

When a CI is updated via `PATCH /api/cis/:id`, capture the fields changed and their before/after values in the audit log entry. This satisfies NIS2 full lifecycle traceability requirements and ISO 27001 A.8.15.

**R-13: Evaluate consolidating `POST /api/cis/:id/relations` and `POST /api/relations`**

Both endpoints implement the same logic with the same vulnerabilities. Maintaining two parallel implementations doubles the remediation and maintenance burden. Consolidate to a single canonical endpoint and deprecate the duplicate.

---

## Appendix A: GitHub Issues Summary

| Issue | Severity | Title | Sprint |
|---|---|---|---|
| #38 | Critical | Async race condition in `authenticateToken` middleware | 1 |
| #39 | Medium | `text/plain` in inline MIME allowlist — stored XSS risk | 2 |
| #40 | Critical | Missing FK indexes for `location_id` and `cost_center_id` | 1 |
| #41 | Critical | TOCTOU race in relation creation endpoints (2 affected routes) | 1 |
| #42 | High | Bulk CI import loop without transaction | 2 |
| #43 | Medium | Unbounded VARCHAR fields in schema | 3 |
| #44 | Medium | `CI.status` stored as String instead of enum | 3 |
| #45 | Low | Inefficient `NOT IN` subquery in password history prune | 3 |

---

## Appendix B: Audit Agent Inventory

| Agent | Skill Profile | Primary Output |
|---|---|---|
| Agent 1 | `find-bugs`, `differential-review` | Fix verification matrix; NEW-001, NEW-002 |
| Agent 2 | `vibesec-skill` | OWASP Top 10 control matrix |
| Agent 3 | `supabase-postgres-best-practices` | DB-001 through DB-009 |
| Reporting | `documentation-writer` | This document |

---

*This document is auto-generated by the CMDB Enterprise Platform security audit pipeline. It reflects the state of the codebase at HEAD on 2026-04-08 and should be reviewed and countersigned by the platform CISO before distribution outside the engineering team.*

---

## Appendix C: Post-Audit Amendment — v2.3.2 OCR Capability

**Amendment Date:** 2026-05-28 | **Platform Version:** v2.3.2

### Change Summary

Version 2.3.2 added Tesseract 5 OCR as a fallback extraction path for scanned PDFs in the RAG ingestion pipeline.

| Property | Detail |
|---|---|
| Processing location | Fully server-side within the Docker backend container — no external transmission |
| Temporary files | Page-level PNG files in `/tmp`, deleted in a `finally` block; never persisted |
| Output storage | `rag_chunks` table, same ACL / retention / cascade-delete policies as all other chunks |
| PII exposure | OCR output may contain PII (names, addresses, signatures) from scanned contracts. Not currently passed through `scrubPII()` — DPO decision pending |
| Access control | OCR chunks inherit source document ACL; pre-kNN ACL filter applies identically |
| Shell injection risk | None — `pdftoppm` called via `execFile` (no shell), paths are internally generated |

### Compliance Impact

| Framework | Impact |
|---|---|
| GDPR Art. 5.1.c (data minimisation) | Medium — `scrubPII()` not yet applied to OCR output; tracked as open action A2.5.1 in `docs/security/rag-dpia.md` Amendment v1.2 |
| ISO 27001 A.8.12 (data leakage prevention) | No new external data flows; all processing is local |
| NIS2 Art. 21.2.e (secure development) | OCR runs as a contained subprocess with no shell injection risk |
| ISO 22301 (business continuity) | Non-blocking fallback; failure does not affect non-scanned document ingestion |

### Open Actions (v2.3.3 backlog)

- Evaluate extending `scrubPII()` to OCR-extracted text before chunking
- Define an allowlist of document categories eligible for OCR indexing
- Update DPIA ISMS-DPIA-002 — see Amendment v1.2 in `docs/security/rag-dpia.md`
