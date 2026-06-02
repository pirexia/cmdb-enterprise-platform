# OWASP Security Audit — Release v2.5.1

**Branch:** `develop`
**Base:** `main` (v2.5.0)
**Date:** 2026-06-02
**Reviewer:** Claude (differential-review skill)
**Scope:** All 33 commits unique to `develop` vs `main` (~1504 LOC, 18 files)

---

## Summary

| Severity | Count | Status |
|----------|-------|--------|
| Critical | 0     | — |
| High     | 2     | ✅ Fix recommended in v2.5.1 |
| Medium   | 4     | ✅ Fix recommended in v2.5.1 |
| Low      | 5     | 📋 Backlog v2.6.x |
| Info     | 3     | No action required |

**Overall verdict:** APPROVED FOR RELEASE WITH FIXES — 6 findings (2H + 4M) must land before tagging v2.5.1; 5 Low items can be deferred.

---

## Changed Files

| File | Lines +/- | Risk Level |
|------|-----------|------------|
| `backend/src/index.ts` | +318 / -55 | **HIGH** (new endpoints, bulk ops, raw SQL) |
| `frontend/components/BulkUpdateCIModal.tsx` | +266 / 0 (new) | MEDIUM (admin UI) |
| `frontend/app/inventory/page.tsx` | +154 / -10 | MEDIUM (selection + bulk flows) |
| `frontend/app/contracts/page.tsx` | +92 / -3 | LOW (UI + new DELETE wiring) |
| `frontend/app/documents/bulk/[batchId]/page.tsx` | +14 / -3 | LOW (status enum) |
| `frontend/app/documents/bulk/page.tsx` | +10 / -1 | LOW |
| `frontend/locales/{6}.json` | +66 each | LOW (static strings) |
| `.env.example`, `docs/*.md` | docs | INFO |

---

## Codebase Size & Strategy

**MEDIUM** (1 large backend file + 5 frontend deltas + 6 locale files). Strategy: **DEEP on backend new endpoints**, **STANDARD on frontend modals**, **SPOT-CHECK on locales / docs**.

---

## Phase 0: Triage

### Changes categorized by risk

| Change | Risk | OWASP Mapping |
|--------|------|---------------|
| `PATCH /api/cis/bulk-update` (Task F) | **HIGH** | A01, A04, A09 |
| `POST /api/cis/bulk-delete` (Task G) | **HIGH** | A01, A04, A09, GDPR Art.17 |
| `DELETE /api/contracts/:id` (Task C) | MEDIUM | A01, A09 |
| `DELETE /api/contracts/:id/documents/:docId` (Task C) | LOW | A01, A09 |
| `processCIBulkImportQueue` concurrency (Task B) | MEDIUM | A04 (DoS), A05 |
| `processBulkImportQueue` WARNING status (Task D) | LOW | A04, A09 |
| `materializeCIBulkItem` consoleIp fix (Task E) | LOW | (bugfix only) |
| `actions.back` i18n key (Task A) | INFO | None |

---

## Phase 1: Code Analysis

### A01 — Broken Access Control

All new endpoints are gated by `authenticateToken` + `requireAdmin`:

| Endpoint | Method | Auth | Role |
|----------|--------|------|------|
| `/api/cis/bulk-update` | PATCH | ✅ | ADMIN |
| `/api/cis/bulk-delete` | POST | ✅ | ADMIN |
| `/api/contracts/:id` | DELETE | ✅ | ADMIN |
| `/api/contracts/:id/documents/:docId` | DELETE | ✅ | ADMIN |

`req.user!.email` for the audit log comes from the verified JWT — never from request body. No IDOR surface (the schema lacks a tenant column, so global-admin access is the design baseline; multi-tenancy is out of scope for v2.5.1).

✅ Access control is correctly enforced.

### A03 — Injection

All new SQL uses Prisma tagged templates:
- `tx.cI.updateMany({ where: { id: { in: ciIds } } })` — Prisma client (parameterized).
- `${JSON.stringify(...)}::jsonb` — bound parameter (PostgreSQL parses the value after binding).
- `${Prisma.join(ciIds.map((i) => Prisma.sql\`${i}::uuid\`))}` — composed safely; each `i` is bound.

Zod validates every `ciId` as UUID **before** they reach SQL — invalid IDs are rejected with 400.

✅ No SQL injection surface introduced. No `$queryRawUnsafe`. No string concatenation into SQL.

⚠️ One concatenation **into the `action` column** (not into SQL): `'DELETE_CI:' + name` — see **V2.5.1-A09-1**.

### A04 — Insecure Design

- **Payload limits:** 500 for `bulk-update`, 200 for `bulk-delete`. Reasonable for an admin-only CMDB; below the express body limit and below any practical Postgres `IN ()` clause concern.
- **`withConcurrency` clamp:** `parseInt(...) ?? '3'` then `>=1 && <=5`. Robust against negative / NaN values; tested mentally with `''`, `'0'`, `'-1'`, `'10'`, `'abc'` — all fall back to `3`.
- **Atomic claim in queue:** `UPDATE ... WHERE status='PENDING_ANALYSIS'` then `if (Number(claimed) === 0) return` correctly serializes concurrent ticks. ✅
- **Atomic transaction:** `prisma.$transaction(async (tx) => { updateMany; audit_logs INSERT; })` for bulk-update and bulk-delete is correct — either the data change and the audit record both land, or neither does. ✅
- **RAG purge after delete:** Iterated with `await` in a `for...of` loop (lines 1641–1643) — see **V2.5.1-A04-1**.

### A05 — Security Misconfiguration

- New env var `CI_BULK_CONCURRENCY`: documented in `.env.example`, clamped at runtime, default `3`. ✅
- No new secrets, no permissive CORS, no new third-party deps. ✅
- nginx CSP and helmet config unchanged. ✅

### A07 — Auth & Session

No changes to session handling. JWT cookie remains HttpOnly/Strict. No new login surface introduced. ✅

### A08 — Software & Data Integrity

- All bulk ops wrap delete/update + audit in `prisma.$transaction` — write-and-log atomicity satisfied. ✅
- One transactional regression risk: `purgeEntityFromRag` is called **outside** the transaction (intentional, RAG is eventually-consistent). Accepted; documented in the handler comment. ✅
- The single-CI `DELETE /api/cis/:id` is NOT wrapped in a transaction (pre-existing — see **V2.5.1-A09-2**).

### A09 — Logging & Monitoring

Every new write produces an `audit_logs` insert with `user_email` from the verified JWT:

| Action | `entity_id` | `details` | PII? |
|--------|-------------|-----------|------|
| `CI_BULK_UPDATE` | nil UUID `00000000-...` | `{ciIds[], changes, affected}` | UUIDs only |
| `CI_BULK_DELETE` | nil UUID `00000000-...` | `{ciIds[], count}` | UUIDs only |
| `DELETE_CI:<name>` (per CI) | `<ci.id>` | (none) | **CI name in `action` column** — see V2.5.1-A09-1 |
| `DELETE` (contract) | `<contract.id>` | `{contractNumber, wasAddendum}` | None |
| `UNLINK_DOCUMENT` (contract↔doc) | `<contract.id>` | `{documentId}` | UUIDs only |

The `'DELETE_CI:' + name` pattern is **pre-existing in the single `DELETE /api/cis/:id`** (line 1673). Task G replicates it in the bulk path — see V2.5.1-A09-1.

### A10 — SSRF

No external HTTP calls introduced. ✅

---

## Findings

### V2.5.1-A09-1 — High: PII leak + truncation risk via `'DELETE_CI:' + name` in `audit_logs.action` (A09 / GDPR Art.5 / ISO 27001 A.8.15)

**Severity:** High
**Status:** ✅ Fix recommended in v2.5.1
**File:** `backend/src/index.ts:1628` (new bulk-delete) and `:1673` (pre-existing single-delete)

**Description:**

The action string is built as `'DELETE_CI:' + name`, with `name` being the CI's free-text `name` field. The `audit_logs.action` column is `VARCHAR(100)` (schema.prisma:410). The CI `name` column is `VARCHAR(255)` (schema.prisma:276). Concatenating a 255-char name with the 10-char `'DELETE_CI:'` prefix can produce up to 265 chars — exceeding the audit column.

Two consequences:

1. **Trigger truncation or insert failure.** PostgreSQL `VARCHAR(100)` will reject the insert with `value too long for type character varying(100)`. Since the audit insert sits **inside** the transaction, the entire bulk-delete rolls back — Denial of Service for any batch containing a long-named CI.
2. **PII / sensitive data leak into a column intended for action codes.** A CI named e.g. `"Laptop-Pedro Sanchez-DNI12345678X-Marketing"` (a common shadow-naming convention in mid-sized CMDBs) places PII directly into the `action` column — a column that's frequently indexed, returned in summary endpoints, and rendered in audit dashboards. This violates GDPR Art.5 (data minimisation) and ISO 27001 A.8.15 (logs should be structured).

**Exploitation scenario:**
- Attacker (low-privileged ADMIN, or a malicious insider) creates a CI named with a 250-char unicode string then bulk-deletes 50 CIs including it → entire transaction rolls back → no audit record at all → forensic gap.
- More subtly: a long benign CI name silently breaks the bulk operation, leading to confusing 500 responses and unreliable behaviour.

**Recommendation:**
- Move the CI name **out of** `action` and **into** the `details` JSONB column:
  ```typescript
  await tx.$executeRaw`
    INSERT INTO "audit_logs"(id, action, entity, entity_id, user_email, details, created_at)
    VALUES(gen_random_uuid(), 'DELETE_CI', 'CI', ${id}::uuid, ${req.user!.email},
           ${JSON.stringify({ name })}::jsonb, now())`;
  ```
- Apply the same fix to the pre-existing single-CI delete (line 1673) for consistency.
- Optional: add a CHECK constraint `LENGTH(action) <= 100` migration to surface the issue early.

---

### V2.5.1-A04-1 — High: No pre-check on `POST /api/cis/bulk-delete` for active contracts/licenses/documents — silent referential decoupling (A04 / NIS2 Art.23)

**Severity:** High
**Status:** ✅ Fix recommended in v2.5.1
**File:** `backend/src/index.ts:1605-1649`

**Description:**

The Prisma schema attaches CIs to contracts and licenses through implicit M2M tables `ContractToCI` and `LicenseToCI` (schema.prisma:203, 632), and to documents through the explicit `DocumentCI` join (schema.prisma:506, with `onDelete: Cascade`). When a CI is hard-deleted:

- `DocumentCI` rows are silently deleted (cascade).
- M2M `ContractToCI` / `LicenseToCI` rows are silently deleted (Prisma's implicit join tables default to cascade-on-delete).
- The `Contract` / `License` / `Document` records themselves survive.

**No pre-check warns the admin** that they are about to:
1. Unlink a CI from N active production contracts (potentially breaking SLA tracking).
2. Unlink a CI from M licenses (license counts now incorrect — compliance impact).
3. Drop K document↔CI associations (orphaned audit trail — "which CIs did this PCI/DSS evidence cover before deletion?" becomes unanswerable).

In contrast, `DELETE /api/contracts/:id` **does** pre-check addendums and returns 409. The asymmetry is a design flaw.

**Exploitation scenario:**
- An admin selects 50 CIs (one of which is the primary database server attached to 12 critical contracts and 8 commercial licenses) and clicks bulk-delete. The UI confirmation does not warn. Post-deletion the contracts/licenses still exist but with broken CI links — quarterly compliance report misses 12 contracts. This is realistic insider-error, not an attack, but the **forensic** record only shows `DELETE_CI` with no mention of the destroyed associations.

**ISO 27001 / NIS2 trace gap:** The `details` payload of `CI_BULK_DELETE` records only `{ciIds[], count}` — not which associations were severed. After deletion there is no way to reconstruct which contracts/licenses were affected.

**Recommendation (choose one or both):**

A) **Pre-check + 409** (matches contract pattern):
```typescript
const refs = await prisma.$queryRaw<{ contracts: bigint; licenses: bigint; docs: bigint }[]>`
  SELECT
    (SELECT COUNT(*) FROM "_ContractToCI" WHERE "B" = ANY(${ciIds}::uuid[])) AS contracts,
    (SELECT COUNT(*) FROM "_LicenseToCI"  WHERE "B" = ANY(${ciIds}::uuid[])) AS licenses,
    (SELECT COUNT(*) FROM "document_cis"  WHERE ci_id = ANY(${ciIds}::uuid[])) AS docs`;
// Return 409 with counts if non-zero AND request lacks an explicit `force: true` flag.
```

B) **Capture broken associations in the audit `details`:**
```typescript
const broken = await tx.$queryRaw`...same query as above...`;
// include broken.contracts/licenses/docs in CI_BULK_DELETE details payload
```

Recommend implementing **both** — A) for safety (force-flag opt-in for genuine bulk cleanup), B) for forensic completeness.

---

### V2.5.1-A04-2 — Medium: `audit_logs.details.ciIds` is unbounded JSON — DoS / index bloat risk (A04 / A09)

**Severity:** Medium
**Status:** ✅ Fix recommended in v2.5.1
**File:** `backend/src/index.ts:1576-1578` (bulk-update), `:1633-1635` (bulk-delete)

**Description:**

Both `CI_BULK_UPDATE` and `CI_BULK_DELETE` write `JSON.stringify({ ciIds, ... })` to the `details` JSONB column. With 500 UUIDs (36 chars + JSON quoting + commas ≈ 42 bytes each), `ciIds` alone can reach ~21 KB per record. Over 100 admin operations/day this contributes ~2 MB/day to a single jsonb column, slowing queries that select `details` and bloating index pages.

More importantly, **there is no Zod cap on JSON size at the express body parser level for this route** — Express's default `100kb` JSON limit applies, but the audit record stores the full payload regardless.

**Exploitation / accident scenario:**
- A misbehaving script sends 500 valid UUIDs in `ciIds` then calls bulk-update once per second. After 1 hour: ~75 MB of audit `details` written. Eventually causes `pg_repack` runs, longer query times on the audit dashboard.

**Recommendation:**
- Store only the **count** in `details` and store the actual UUID list in a separate ndjson/csv archive bucket if forensic needs require it. Example:
  ```typescript
  details: { count: ciIds.length, sample: ciIds.slice(0, 10), truncated: ciIds.length > 10 }
  ```
- Or insert per-CI `BULK_UPDATE:<id>` audit rows (similar to per-CI `DELETE_CI` rows in bulk-delete) and keep `CI_BULK_UPDATE` as just an aggregate marker.

Combined with V2.5.1-A04-1, switching to "per-CI audit + aggregate marker" satisfies both findings.

---

### V2.5.1-A04-3 — Medium: `purgeEntityFromRag` awaited serially inside HTTP handler (blocks response under load) (A04)

**Severity:** Medium
**Status:** ✅ Fix recommended in v2.5.1
**File:** `backend/src/index.ts:1641-1643`

**Description:**

```typescript
for (const id of ciIds) {
  try { await purgeEntityFromRag('ci', id); } catch (e) { ... }
}
```

With 200 CIs and a slow PostgreSQL connection (or `pgvector` index latency), this loop blocks the HTTP response by up to 200 × ~50ms = 10s. The reverse-proxy timeout (nginx default 60s) is not at risk, but the client experience is poor and the request occupies a Node event loop worker.

This is **inconsistent with the codebase's own pattern** — the bulk-update handler (line 1582) correctly uses `void queueEntityForIndexing(...)` to fire-and-forget RAG indexing.

**Exploitation:** Not a security exploit per se, but contributes to DoS if an admin bulk-deletes 200 CIs while other admins are working.

**Recommendation:**
- Replace the `for (const id of ciIds) await purgeEntityFromRag(...)` with `Promise.all(ciIds.map(id => purgeEntityFromRag('ci', id).catch(...)))` for parallel execution **before** responding, OR
- Run RAG purge fully async with `void`, and rely on the next `processRagQueue` tick + the `purgeEntityFromRag` idempotency to catch orphan chunks.

Recommend option 2 (consistency with the indexing pattern in the same file).

---

### V2.5.1-A09-2 — Medium: Single-CI `DELETE /api/cis/:id` is not transactional — audit can desync from delete (A09 / ISO 27001 A.8.15)

**Severity:** Medium
**Status:** ✅ Fix recommended in v2.5.1 (related to Task G)
**File:** `backend/src/index.ts:1657-1684` (pre-existing pattern, still present in develop)

**Description:**

```typescript
await prisma.cI.delete({ where: { id } });            // 1. delete
await prisma.$executeRaw`INSERT INTO "audit_logs"...`; // 2. log
await purgeEntityFromRag('ci', id);                    // 3. RAG
```

If step 2 throws (DB hiccup, network blip) the CI is gone but no audit record is written — ISO 27001 A.8.15 breach. The new bulk-delete (Task G) correctly uses `prisma.$transaction` for both steps; the single-CI version still does not.

**Recommendation:** Wrap delete + audit insert in `prisma.$transaction` to match the bulk-delete pattern:
```typescript
await prisma.$transaction(async (tx) => {
  await tx.cI.delete({ where: { id } });
  await tx.$executeRaw`INSERT INTO "audit_logs"(...) VALUES(...)`;
});
```
Pre-existing finding but exposed clearly by Task G's improved pattern in the same file.

---

### V2.5.1-A09-3 — Medium: Bulk-delete reports `notFound` count but doesn't audit which IDs didn't exist (A09 / NIS2 Art.23)

**Severity:** Medium
**Status:** ✅ Fix recommended in v2.5.1
**File:** `backend/src/index.ts:1645`

**Description:**

```typescript
res.json({ deleted: result, notFound: ciIds.length - existing.length, requested: ciIds.length });
```

If the admin submits `ciIds = [<5 valid>, <5 unknown>]`, the response correctly reports `notFound: 5` but the audit record only mentions the full `ciIds` array indiscriminately. A forensic reviewer cannot tell from `audit_logs` alone which 5 CIs were actually deleted. NIS2 Art.23 requires "who did what when" — and "what" here is ambiguous.

**Recommendation:** Persist both `requested` (the input) and `actuallyDeleted` (the IDs whose names were in `existingMap`) in the `details`:
```typescript
details: { requested: ciIds, deleted: Array.from(existingMap.keys()), count: existing.length }
```

(This is independent of V2.5.1-A04-2's recommendation — applies the same correction philosophy.)

---

### V2.5.1-A04-4 — Medium: Duplicate UUIDs in `ciIds` are accepted and inflate audit counts (A04)

**Severity:** Medium
**Status:** ✅ Fix recommended in v2.5.1
**File:** `backend/src/index.ts:1571-1572` (bulk-update), `:1610-1611` (bulk-delete)

**Description:**

The Zod schema is `z.array(z.string().uuid()).min(1).max(500)` — it does not deduplicate. Side effects:

- `bulk-update`: `updateMany({ where: { id: { in: [dup, dup] } } })` runs once but `affected` count reflects DB rows (still N). The audit `details.ciIds` shows duplicates — confusing for forensics.
- `bulk-delete`: per-CI `DELETE_CI` audit row is written **twice** for a duplicated ID before `deleteMany` runs (which then deletes the row once). Result: TWO audit records, ONE actual delete → integrity gap.
- `for (const id of ciIds) void queueEntityForIndexing(...)` indexes the same CI multiple times (wastes Ollama capacity).

**Exploitation:** Submit 500 copies of the same UUID — RAG queue is hit 500 times for one entity, contributing to A04 (resource exhaustion under heavy load).

**Recommendation:**
- Apply `.transform((arr) => Array.from(new Set(arr)))` in both Zod schemas to deduplicate on validation.

---

### V2.5.1-A09-4 — Low: `entity_id = nil UUID` for `CI_BULK_*` events is not queryable per-CI (A09)

**Severity:** Low
**Status:** 📋 Backlog v2.6.x
**File:** `backend/src/index.ts:1576, 1633`

**Description:**

`CI_BULK_UPDATE` and `CI_BULK_DELETE` use `'00000000-0000-0000-0000-000000000000'::uuid` as `entity_id`. The actual CI IDs are reachable only through `details.ciIds`, which requires a JSONB containment query (`details @> '{"ciIds": ["<id>"]}'::jsonb`) — works, but is slow at scale and is not indexed.

This is consistent with the pattern noted in `owasp-task-g.md` (G-L01). The recommendation there ("use a fixed nil UUID for SYSTEM-scope events") has been adopted in Task F/G correctly — the **next** step is to add a GIN index on `audit_logs.details->'ciIds'` if forensic queries by CI become common.

**Recommendation:** Track for v2.6.x as part of audit-log query optimization. Combined with V2.5.1-A09-3 fix (`details.deleted: [...]`), add migration:
```sql
CREATE INDEX idx_audit_logs_details_ciids ON audit_logs USING GIN ((details->'ciIds'));
```

---

### V2.5.1-A05-1 — Low: `CI_BULK_CONCURRENCY` clamp silently masks misconfiguration (A05)

**Severity:** Low
**Status:** 📋 Backlog v2.6.x
**File:** `backend/src/index.ts:4334-4337`

**Description:**

```typescript
const _rawCiConcurrency = parseInt(process.env.CI_BULK_CONCURRENCY ?? '3', 10);
const CI_BULK_CONCURRENCY = (!isNaN(_rawCiConcurrency) && _rawCiConcurrency >= 1 && _rawCiConcurrency <= 5)
  ? _rawCiConcurrency
  : 3;
```

If an operator sets `CI_BULK_CONCURRENCY=20` (typo or misunderstanding), the value is silently clamped to `3` with no log entry. Operators may believe they configured high concurrency.

**Recommendation:**
- Emit a startup warning when the env var is set but rejected:
  ```typescript
  if (process.env.CI_BULK_CONCURRENCY && CI_BULK_CONCURRENCY !== _rawCiConcurrency) {
    console.warn(`[Config] CI_BULK_CONCURRENCY=${process.env.CI_BULK_CONCURRENCY} out of range [1..5], clamped to 3.`);
  }
  ```

---

### V2.5.1-A04-5 — Low: Missing rate limit specific to bulk endpoints (A04)

**Severity:** Low
**Status:** 📋 Backlog v2.6.x
**File:** `backend/src/index.ts:226-234` (rate limiter scope)

**Description:**

The global `apiLimiter` is 300 req/min/IP. A compromised admin account could call `/api/cis/bulk-delete` with 200-CI batches up to ~300 times per minute = 60 000 CIs/min destruction rate. Even legitimate use does not need more than ~1-2 bulk operations per minute.

**Recommendation:** Add a dedicated limiter:
```typescript
const bulkOpsLimiter = rateLimit({ windowMs: 60_000, limit: 10 });
app.patch('/api/cis/bulk-update', bulkOpsLimiter, authenticateToken, requireAdmin, ...);
app.post('/api/cis/bulk-delete', bulkOpsLimiter, authenticateToken, requireAdmin, ...);
```

---

### V2.5.1-A04-6 — Low: `withConcurrency` does not bound the `tasks` array length (A04)

**Severity:** Low
**Status:** 📋 Backlog v2.6.x
**File:** `backend/src/index.ts:4351-4368`

**Description:**

`withConcurrency` accepts any-length `tasks` array. Called from `processCIBulkImportQueue` with `fetchLimit = CI_BULK_CONCURRENCY * 3` (max 15), so safe today. But if reused elsewhere with caller-supplied length, a million-element array would allocate `new Array(1_000_000)` for results synchronously.

**Recommendation:** Document the contract or add an assert: `if (tasks.length > 10000) throw new Error('withConcurrency: too many tasks');`

---

### V2.5.1-A04-7 — Low: Contract DELETE pre-check is TOCTOU-racy (A04)

**Severity:** Low
**Status:** 📋 Backlog v2.6.x
**File:** `backend/src/index.ts:1839-1862`

**Description:**

```typescript
// 1. Pre-check addendums
const addendums = await prisma.$queryRaw`SELECT COUNT(*) ...`;
if (Number(...) > 0) return res.status(409)...;
// ...
await prisma.$transaction(async (tx) => { await tx.contract.delete(...); ... });
```

Between the pre-check and the transaction, another admin could create an addendum referencing this contract. The schema declares `parentContract` with `onDelete: SetNull`, so the deletion will succeed and orphan the new addendum (no FK violation). The 409 guard is bypassed silently in the race window.

**Exploitation:** Low realism (requires two admins acting in milliseconds). Impact is correctness only — the deleted parent is gone, the addendum survives without a parent.

**Recommendation:** Move the addendum count check **inside** the transaction with `SELECT ... FOR UPDATE`:
```typescript
await prisma.$transaction(async (tx) => {
  const [{ c }] = await tx.$queryRaw<...>`
    SELECT COUNT(*) AS c FROM "contracts"
     WHERE parent_contract_id = ${contractId}::uuid FOR UPDATE`;
  if (Number(c) > 0) throw new Error('HAS_ADDENDUMS');
  await tx.contract.delete({ where: { id: contractId } });
  // ...
});
```

---

## Informational

### INFO-1: WARNING status pathway (Task D)

The new `WARNING` status for non-extractable documents flows through `processBulkImportQueue`, `recomputeBatchStatus`, `commit-batch`, `reanalyze-item`, `reanalyze-batch` — all queries use `IN ('ANALYZED','ERROR','WARNING')`. No SQL injection surface, no permission bypass. The frontend renders a yellow badge and surfaces a hint message. ✅

### INFO-2: `materializeCIBulkItem` bugfix (Task E)

`ipAddress` was moved from `HardwareCI.create` (the field does not exist) to `CI.consoleIp` (`VARCHAR(45)` — accommodates IPv6). No new attack surface; fixes a 500 error that was preventing legitimate bulk commits. ✅

### INFO-3: i18n `actions.back` key (Task A)

Static string addition across 6 locales. No XSS surface (React JSX escapes interpolations). ✅

---

## Compliance Matrix

| Standard | Requirement | Status before v2.5.1 | Status after v2.5.1 (with fixes) |
|----------|------------|---------------------|----------------------------------|
| ISO 27001 A.8.15 | Audit logs insert-only, atomic with action | Single delete non-atomic (V2.5.1-A09-2) | ✅ Fixed by recommended transaction wrap |
| ISO 27001 A.8.15 | Action codes structured, not free-text | `'DELETE_CI:' + name` puts CI name in `action` | ✅ Fixed by moving name to `details` (V2.5.1-A09-1) |
| GDPR Art.5 | Data minimisation in logs | CI name in `action` may contain PII | ✅ Fixed by V2.5.1-A09-1 |
| GDPR Art.17 | Right to erasure — hard delete cascades | Document↔CI cascades; contracts/licenses M2M cleared | ✅ Working, but caller is not warned (V2.5.1-A04-1) |
| NIS2 Art.21 | Availability — bulk ops bounded | Limits 500/200; no dedicated rate limit | ⚠️ Mitigated by global 300/min; V2.5.1-A04-5 recommended for backlog |
| NIS2 Art.23 | Traceability — "who did what when" | Bulk audit lacks broken-assoc detail (V2.5.1-A04-1) + notFound not audited (V2.5.1-A09-3) | ✅ Fixed by recommended `details` enrichment |
| OWASP A01 | RBAC on new endpoints | ✅ All gated by `requireAdmin` | ✅ Maintained |
| OWASP A03 | Parameterized SQL | ✅ All Prisma tagged templates | ✅ Maintained |
| OWASP A04 | Insecure design — payload limits, concurrency | ✅ Sensible defaults; minor gaps in dup/rate | ✅ Improved with fixes |
| OWASP A07 | Session integrity | No session-layer changes | ✅ N/A |
| OWASP A08 | Atomic data + audit | ✅ Bulk paths use $transaction | ✅ Maintained (single delete still pending fix) |
| OWASP A09 | Logging completeness | ✅ All new writes audited | ✅ Maintained |
| OWASP A10 | SSRF | No new outbound HTTP | ✅ N/A |

---

## Conclusion

Task F/G/C/D/B add substantial new admin functionality but maintain the codebase's overall security posture. The single largest gap is the pre-existing `'DELETE_CI:' + name` pattern that Task G replicated in the bulk path — easy to fix and high-leverage (V2.5.1-A09-1, V2.5.1-A09-2).

The bulk-delete endpoint's lack of pre-check for active contracts/licenses/documents (V2.5.1-A04-1) is the most consequential design gap — it does not allow an attack but allows an admin error to silently sever referential context that compliance audits depend on.

**Verdict:** RELEASE-BLOCKING fixes are the 2 High + 4 Medium findings (below). All 5 Low findings can ship to v2.6.x backlog.

### Fix-before-v2.5.1 list (Critical + High + Medium)

All 7 items fixed in `task-p/owasp-v2.5.1-fixes` (merged 08bf40a):

- [x] **V2.5.1-A09-1** (High) — ✅ Fixed: CI name moved to `details.name`; `action = 'DELETE_CI'` (structured).
- [x] **V2.5.1-A04-1** (High) — ✅ Fixed: pre-check + 409 with `brokenRefs` breakdown; opt-in `force: true` to proceed; audit captures broken counts + forced flag.
- [x] **V2.5.1-A04-2** (Medium) — ✅ Fixed: `details` now stores `{ count, sample(10), truncated }` instead of full UUID array.
- [x] **V2.5.1-A04-3** (Medium) — ✅ Fixed: `void purgeEntityFromRag().catch(...)` fan-out instead of serial `await`.
- [x] **V2.5.1-A04-4** (Medium) — ✅ Fixed: `.transform(arr => Array.from(new Set(arr)))` on both bulk schemas.
- [x] **V2.5.1-A09-2** (Medium) — ✅ Fixed: single-CI DELETE + audit wrapped in `prisma.$transaction`.
- [x] **V2.5.1-A09-3** (Medium) — ✅ Fixed: bulk-delete `details` persists `requested`, `deleted`, `notFound`.

### Backlog v2.6.x list (Low)

- [ ] **V2.5.1-A09-4** — GIN index on `audit_logs.details->'ciIds'`.
- [ ] **V2.5.1-A05-1** — Warn on out-of-range `CI_BULK_CONCURRENCY`.
- [ ] **V2.5.1-A04-5** — Dedicated rate limit (10/min) on bulk endpoints.
- [ ] **V2.5.1-A04-6** — Document/assert `withConcurrency` task array bound.
- [ ] **V2.5.1-A04-7** — Move contract-addendum pre-check inside transaction with `FOR UPDATE`.

**Result: 0C / 2H / 4M (release-blocking) / 5L (backlog)**
