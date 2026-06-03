# OWASP Security Audit — Release v2.5.2

**Branch:** `develop`
**Base:** `main` (v2.5.1)
**Date:** 2026-06-03
**Reviewer:** Claude (differential-review skill, surgical mode)
**Scope:** `git diff main...develop` — 6 files, ~320 LOC added / 6 LOC removed

---

## Summary

| Severity     | Count | Status |
|--------------|-------|--------|
| Critical     | 0     | — |
| High         | 1     | ✅ MITIGATED in task-u (ON CONFLICT upsert + UNIQUE index) |
| Medium       | 1     | ✅ FIXED in task-u (CI_BULK_COMMIT details extended) |
| Low          | 3     | 📋 Backlog v2.6.x (except A03-2: fixed in task-u) |
| Informational| 2     | No action required |

**Overall verdict:** ✅ PASS — all blocking findings resolved. Release v2.5.2 unblocked.

**Overall verdict:** BLOCKED — 1 High finding must be resolved before tagging v2.5.2.
The cascade migration (Task H) and the dashboard URL filter feature (Task I) are both clean. The bulk-import master upsert (Task K) introduces a race-condition upsert gap (High) and a minor audit-log completeness gap (Medium) that must be addressed.

---

## Changed Files

| File | Lines +/- | Risk Level |
|------|-----------|------------|
| `backend/src/index.ts` | +41 / 0 | **HIGH** (new raw SQL upsert inside transaction) |
| `backend/prisma/migrations/20260602184003_hardware_software_cascade_on_delete/migration.sql` | +24 / 0 | **MEDIUM** (schema change, blast-radius analysis required) |
| `frontend/app/page.tsx` | +6 / -6 | LOW (deep-link URL params on anchor hrefs) |
| `frontend/app/inventory/page.tsx` | +11 / 0 | LOW (client-side filter from URL param) |
| `frontend/app/contracts/page.tsx` | +10 / 0 | LOW (client-side filter from URL param) |
| `docs/PLAN_v2.5.2.md` | +228 / 0 | INFO (documentation only) |

---

## Codebase Size & Strategy

**SMALL** (6 files, 320 LOC delta). Strategy: **DEEP** on all changed files. No spot-checking needed.

---

## Phase 0: Triage

### Changes categorized by risk

| Change | Risk | OWASP Mapping |
|--------|------|---------------|
| Task K: `materializeCIBulkItem` manufacturer + model upsert | **HIGH** | A03, A09, A08 |
| Task H: CASCADE FK migration `hardware_cis` / `software_cis` | MEDIUM | A08, A09 |
| Task I: Dashboard URL `?type=` / `?filter=` deep-links | LOW | A01/frontend |

---

## Phase 1: Code Analysis

### A01 — Broken Access Control

**Task K (backend):** The new upsert block is inside `materializeCIBulkItem`, which is called exclusively from:
- `POST /api/cis/bulk/items/:id/commit` (line 2376)
- `processCIBulkImportQueue` (line 2409)

Both call sites sit inside `requireAdmin`-gated routes or internal queue workers (no external surface). The `userEmail` passed to audit log lines comes from `req.user!.email` at the call site — sourced from the verified JWT, never from request body. ✅

**Task I (frontend deep-links):** The `?type=` and `?filter=` parameters are consumed exclusively in `useEffect` hooks that only set local React state (filter presets). They do not:
- Make any API calls with the raw param value
- Bypass the `AppShell` auth gate (`AppShell.tsx:23` — redirects to `/login` if `!user`)
- Reach the backend at all — all data is fetched via `apiFetch` which injects the verified JWT

The `router.replace(...)` call strips the param immediately after reading it, preventing history leakage. No IDOR or auth-bypass surface. ✅

**No new endpoints added** (Task H and Task I are migration + frontend only). ✅

### A03 — Injection

All new `$queryRaw` / `$executeRaw` calls use **tagged template literals** (parameterized). Verified line by line:

| Line (approx) | Statement | Parameterized? |
|---------------|-----------|----------------|
| `tx.$queryRaw\`SELECT … LOWER(${mfrName})\`` | SELECT manufacturer | ✅ bound param |
| `tx.$queryRaw\`INSERT INTO "manufacturers" … ${mfrName} … \`` | INSERT manufacturer | ✅ bound param |
| `tx.$executeRaw\`INSERT INTO "audit_logs" … ${mfrId}::uuid … ${userEmail} … ${JSON.stringify(…)}::jsonb …\`` | Audit log manufacturer | ✅ all bound |
| `tx.$queryRaw\`SELECT … LOWER(${modelName}) AND manufacturer_id = ${mfrId}::uuid\`` | SELECT device model | ✅ bound params |
| `tx.$queryRaw\`INSERT INTO "device_models" … ${modelName} … ${mfrId}::uuid …\`` | INSERT device model | ✅ bound params |
| `tx.$executeRaw\`INSERT INTO "audit_logs" … ${ciModelId}::uuid … ${userEmail} … ${JSON.stringify(…)}::jsonb …\`` | Audit log device model | ✅ all bound |

No `$queryRawUnsafe`, no `$executeRawUnsafe`, no string concatenation into SQL. ✅

`JSON.stringify({...})::jsonb` — the value is bound as a parameter and the `::jsonb` cast is applied server-side after binding. This is the same safe pattern already established in v2.5.1. ✅

### A03 — Race condition / duplicate insert (separate from injection)

`manufacturers` has a `UNIQUE` index on `name` (`manufacturers_name_key` — migration `20260315223241`). `device_models` has **no** unique constraint on `(name, manufacturer_id)`.

The upsert pattern used is:
```
SELECT … LOWER(name) = LOWER($mfrName)  -- no lock
INSERT … VALUES (…)                     -- may race
```

Under concurrent bulk-import sessions (up to `CI_BULK_CONCURRENCY=3` parallel workers, plus manual single-commit endpoint), two workers processing different items with the same manufacturer name within the same millisecond will both pass the SELECT check with 0 rows, then both attempt INSERT. For **manufacturers**, the `UNIQUE` index will cause the second INSERT to raise `23505 unique_violation` — the entire `prisma.$transaction` rolls back with an unhandled exception, returning 500 to the user. For **device_models**, the absence of a unique constraint means **duplicate rows are silently created** — two `DeviceModel` records for `(name='ThinkPad L14', manufacturer_id=X)` will coexist indefinitely, corrupting the master data.

See **V2.5.2-A03-1**.

### A08 — Software & Data Integrity (CASCADE migration blast radius)

**Task H migration** changes `ON DELETE RESTRICT → CASCADE` on:
- `hardware_cis.ci_id → configuration_items.id`
- `software_cis.ci_id → configuration_items.id`

**Blast radius analysis — what cascades when `DELETE FROM configuration_items WHERE id = X`:**

| Table | FK behaviour | Effect |
|-------|-------------|--------|
| `hardware_cis` | **CASCADE** (this migration) | Child row deleted ✅ intended |
| `software_cis` | **CASCADE** (this migration) | Child row deleted ✅ intended |
| `ci_relations` (source) | CASCADE (init migration) | Source-side relations deleted ✅ intended |
| `ci_relations` (target) | CASCADE (init migration) | Target-side relations deleted ✅ intended |
| `_ContractToCI` | CASCADE (Prisma implicit M2M) | CI-contract links deleted ✅ already pre-existing |
| `_LicenseToCI` | CASCADE (Prisma implicit M2M) | CI-license links deleted ✅ already pre-existing |
| `document_cis` | CASCADE (schema.prisma `onDelete: Cascade`) | Document-CI links deleted ✅ already pre-existing |
| `configuration_items` (child CIs via `parentCIId`) | SET NULL | Parent reference nulled ✅ safe |
| `configuration_items.ci_model_id` | SET NULL (from `device_models`) | Model deref nulled ✅ safe |

**Key finding:** The CASCADE scope is **strictly limited to child rows of the CI** (`hardware_cis`, `software_cis`). No cross-entity cascade was introduced. The `manufacturers` and `device_models` tables are **not** affected by a CI delete — the relation goes in the opposite direction (`CI.ciModelId → DeviceModel.id` with `ON DELETE SET NULL`). A CI delete will never cascade into master data tables. ✅

**Mass-delete vector:** The cascade does not open any new mass-delete path beyond what existed with the pre-existing `ci_relations` / `_ContractToCI` cascades. An ADMIN could already trigger broad cascades by deleting a CI. The migration fixes a correctness bug without expanding the attack surface. ✅

**Lock window:** `ALTER TABLE … DROP CONSTRAINT … ADD CONSTRAINT` acquires `ACCESS EXCLUSIVE` briefly on `hardware_cis` and `software_cis`. Both tables are 1:1 with `configuration_items`. In a typical CMDB with < 50 k CIs the lock is held for < 1 second. Acceptable for a maintenance window. ✅

### A09 — Logging & Monitoring

**Audit log placement — atomicity:**

The new audit log inserts for `CREATE_MASTER` are placed **inside** `prisma.$transaction(async (tx) => { … })`. Specifically:
- `INSERT INTO "manufacturers" … RETURNING id` → `INSERT INTO "audit_logs" … 'CREATE_MASTER','Manufacturer'` — both inside `tx`
- `INSERT INTO "device_models" … RETURNING id` → `INSERT INTO "audit_logs" … 'CREATE_MASTER','DeviceModel'` — both inside `tx`

If the CI creation later fails (e.g. inventory number conflict), the entire transaction rolls back, including the master INSERT and its audit record. This is **correct**: no phantom audit records for masters that were never committed. ✅

**Audit coverage — what events are recorded:**

| Action | Trigger | Audit emitted? |
|--------|---------|----------------|
| New `Manufacturer` auto-created | bulk import | ✅ `CREATE_MASTER / Manufacturer` |
| Existing `Manufacturer` reused | bulk import | ✅ (no write, no audit needed) |
| New `DeviceModel` auto-created | bulk import | ✅ `CREATE_MASTER / DeviceModel` |
| Existing `DeviceModel` reused | bulk import | ✅ (no write, no audit needed) |
| CI committed | bulk import | ✅ `CI_BULK_COMMIT / CI` (pre-existing) |

**Gap found:** When a new manufacturer is inserted but the transaction later rolls back (due to subsequent CI create failure), the audit record for the manufacturer is correctly absent. However, if a **duplicate device model** is silently created (no unique constraint — see A03-1), only one `CREATE_MASTER/DeviceModel` audit record is emitted per insert — the duplicate is also audited. This is a consequence of the upsert race, not an audit gap per se. ✅ / ⚠️ (depends on A03-1 fix)

**Gap found — no audit for CASCADE-deleted `hardware_cis` / `software_cis` rows:**

When `DELETE /api/cis/:id` or `POST /api/cis/bulk-delete` runs, the `hardware_cis` / `software_cis` child rows are now silently deleted by Postgres CASCADE. The `DELETE_CI` / `CI_BULK_DELETE` audit record documents the CI deletion, but does **not** record that a hardware or software detail record was also removed. For compliance purposes (ISO 27001 A.8.15), the pre-existing `DELETE_CI` audit entry already captures this implicitly (a CI with a hardware child is effectively "one asset"), so this is an informational note rather than a finding. However, if a future forensic query asks "which serial numbers were deleted on date X?", the answer requires joining `audit_logs` with `hardware_cis` snapshots that no longer exist. See **V2.5.2-A09-1** (Low).

### A05 — Security Misconfiguration

- No new environment variables introduced (Task H, K, I).
- No new third-party dependencies.
- CSP, helmet, nginx config unchanged.
- No debug endpoints or console.log of sensitive data in the new code paths. ✅

### A01/Frontend — URL param deep-link abuse

**`?type=hardware|software` (inventory):** The effect handler maps the param to one of two hard-coded enum values (`"HARDWARE"` or `"SOFTWARE"`). Any other value results in `mapped = null` and the filter is not applied. No server-side request is made with the param value. Impossible to inject into an API call. ✅

**`?filter=adenda|active|expiring|expired` (contracts):** The effect handler uses a strict `if/else if` chain against four hard-coded string literals. Anything outside the four values is silently ignored. ✅

**Auth gate:** Both pages are wrapped in `AppShell`, which checks `useAuth().user` and redirects to `/login` if unauthenticated. The URL params are only evaluated after authentication is confirmed (React renders in order; the `useEffect` for the param runs after the page mounts, by which time AppShell has already enforced auth). No auth bypass possible. ✅

---

## Findings

### V2.5.2-A03-1 — High: SELECT-then-INSERT upsert race condition in master upsert — UniqueViolation DoS on `manufacturers`, silent duplicate rows on `device_models` (A03 / A08 / A09)

**Severity:** High
**Status:** ✅ MITIGATED — fixed in branch `task-u/owasp-v2.5.2-fixes` (migration 20260603100000 + ON CONFLICT upsert)
**File:** `backend/src/index.ts` (lines ~4816–4844, inside `materializeCIBulkItem`)
**OWASP:** A03 (data integrity), A08 (software & data integrity)

**Description:**

The manufacturer and device model upsert uses a non-atomic SELECT-then-INSERT pattern without any row-level lock. With `CI_BULK_CONCURRENCY` up to 3 and the availability of the manual single-commit endpoint (`POST /api/cis/bulk/items/:id/commit`), two concurrent workers can both observe "no existing manufacturer" and both attempt `INSERT INTO "manufacturers"`.

For **manufacturers**: a `UNIQUE` index exists (`manufacturers_name_key`). The second INSERT raises PostgreSQL error `23505` (unique_violation). Prisma re-throws this as an unhandled exception inside the transaction, rolling back the entire item commit and returning HTTP 500. This is a **denial-of-service against bulk import** for any batch containing two or more items with the same new manufacturer processed concurrently.

For **device_models**: **no unique constraint** exists on `(name, manufacturer_id)`. Both INSERTs succeed, creating two identical-name model records for the same manufacturer. These corrupt the master data: the Datos Maestros UI will show duplicates; future SELECT queries may return either row; and there is no migration path to clean them up automatically.

**Evidence:**

```
// backend/src/index.ts (Task K, inside prisma.$transaction)
const existingMfr = await tx.$queryRaw<{ id: string }[]>`
  SELECT id::text AS id FROM "manufacturers" WHERE LOWER(name) = LOWER(${mfrName}) LIMIT 1`;
// ↑ no lock — another concurrent TX can also see 0 rows here
let mfrId: string;
if (existingMfr.length > 0) {
  mfrId = existingMfr[0].id;
} else {
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "manufacturers"(id, name, created_at, updated_at)
    VALUES (gen_random_uuid(), ${mfrName}, now(), now())
    RETURNING id::text AS id`;
  // ↑ raises 23505 if concurrent TX won the race (manufacturers has UNIQUE on name)
```

```
// For device_models (no UNIQUE constraint):
const insertedModel = await tx.$queryRaw<{ id: string }[]>`
  INSERT INTO "device_models"(id, name, manufacturer_id, created_at, updated_at)
  VALUES (gen_random_uuid(), ${modelName}, ${mfrId}::uuid, now(), now())
  RETURNING id::text AS id`;
// ↑ succeeds silently — duplicate row created
```

**Attack / failure scenario:**

1. Batch contains 3 items: `[HP ProBook, HP EliteBook, HP ZBook]` — all manufacturer "HP" (new), all concurrent.
2. Workers 1, 2, 3 each SELECT manufacturers → all see 0 rows.
3. Worker 1 INSERTs "HP" (succeeds). Workers 2 and 3 hit unique_violation → their transactions roll back → items remain in `COMMITTING` state forever (the claim UPDATE set `status='COMMITTING'` but the outer transaction rolls back so they revert to prior state — depends on Postgres behaviour; in practice the item may get stuck).
4. Admin retries → Workers 2 and 3 now see "HP" exists → succeed. But the stuck items may require manual intervention.

For device models: two concurrent items with manufacturer "HP" and model "ProBook 450 G9" both create a `DeviceModel` row. Future queries `WHERE name = 'ProBook 450 G9' AND manufacturer_id = <hp_id>` return 2 rows. The `LIMIT 1` in the SELECT path returns a non-deterministic row.

**Remediation:**

**Option A (preferred — use PostgreSQL `INSERT … ON CONFLICT DO NOTHING … RETURNING`):**

```sql
-- manufacturers (has UNIQUE on name):
INSERT INTO "manufacturers"(id, name, created_at, updated_at)
VALUES (gen_random_uuid(), ${mfrName}, now(), now())
ON CONFLICT (name) DO NOTHING
RETURNING id::text AS id
```
Then if RETURNING is empty (conflict), SELECT again to get the existing id.

```typescript
let inserted = await tx.$queryRaw<{ id: string }[]>`
  INSERT INTO "manufacturers"(id, name, created_at, updated_at)
  VALUES (gen_random_uuid(), ${mfrName}, now(), now())
  ON CONFLICT (name) DO NOTHING
  RETURNING id::text AS id`;
if (inserted.length === 0) {
  // Row existed; fetch it
  const existing = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM "manufacturers" WHERE LOWER(name) = LOWER(${mfrName}) LIMIT 1`;
  mfrId = existing[0].id;
} else {
  mfrId = inserted[0].id;
  // emit audit log only on actual insert
}
```

**Option B (prerequisite for device_models — add UNIQUE constraint):**

Add a migration:
```sql
CREATE UNIQUE INDEX "device_models_name_manufacturer_id_key"
  ON "device_models"(LOWER(name), manufacturer_id);
```
Then apply the same `ON CONFLICT DO NOTHING` pattern.

Both options A and B must be applied. The unique index on `device_models` is independently needed regardless of the upsert strategy.

---

### V2.5.2-A09-1 — Medium: `CREATE_MASTER` audit log not emitted when existing manufacturer / model is reused — partial audit trail for master-data provenance (A09 / ISO 27001 A.8.15)

**Severity:** Medium
**Status:** ✅ FIXED — `manufacturerId` + `ciModelId` added to CI_BULK_COMMIT details in `task-u/owasp-v2.5.2-fixes`
**File:** `backend/src/index.ts` (~4819–4836)
**OWASP:** A09

**Description:**

When a bulk import item reuses an existing manufacturer or device model (the `existingMfr.length > 0` or `existingModel.length > 0` branches), no audit record is emitted. This is by design — no write occurred. However, there is no audit record linking a specific bulk-import batch/item to the master data it consumed. After deletion or renaming of the master record, it is not possible to reconstruct from `audit_logs` alone which batches used "Manufacturer X model Y".

This is a **low-severity forensic gap**, not a security vulnerability. The CI commit itself (`CI_BULK_COMMIT`) records the `batchItemId`, from which the manufacturer/model can be inferred by joining `ci_bulk_import_items` — but only while that staging record exists. If the batch is purged, the provenance chain is broken.

**Recommendation:**

Include `manufacturerId` and `ciModelId` in the existing `CI_BULK_COMMIT` details payload:

```typescript
${JSON.stringify({
  batchItemId: item.id,
  ciName: newCi.name,
  manufacturerId: mfrId ?? null,      // add these
  ciModelId: ciModelId ?? null,       // add these
})}::jsonb
```

This adds provenance to the existing audit record without requiring a new event type. Low effort (1-line change). Recommended for v2.5.2 if K1 is already being touched for the upsert fix.

---

### V2.5.2-A08-1 — Low: CASCADE migration adds no rollback procedure to `PLAN_v2.5.2.md` — ISO 22301 recovery gap (A08 / ISO 22301:2019)

**Severity:** Low
**Status:** 📋 BACKLOG v2.6.x
**File:** `docs/PLAN_v2.5.2.md`, `backend/prisma/migrations/20260602184003_hardware_software_cascade_on_delete/migration.sql`
**OWASP:** A08

**Description:**

`PLAN_v2.5.2.md` notes the rollback risk for Task H ("H1: ALTER de FK lockea tablas") but documents only "pg_dump previo sugerido al usuario" as a mitigation. There is no documented SQL rollback procedure (reverse the `DROP CONSTRAINT / ADD CONSTRAINT` steps). ISO 22301:2019 §8.4 (recovery procedures) requires that schema changes affecting cascade behaviour include a tested rollback path.

The rollback SQL is straightforward:
```sql
ALTER TABLE "hardware_cis" DROP CONSTRAINT "hardware_cis_ci_id_fkey";
ALTER TABLE "hardware_cis"
  ADD CONSTRAINT "hardware_cis_ci_id_fkey"
  FOREIGN KEY ("ci_id") REFERENCES "configuration_items"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "software_cis" DROP CONSTRAINT "software_cis_ci_id_fkey";
ALTER TABLE "software_cis"
  ADD CONSTRAINT "software_cis_ci_id_fkey"
  FOREIGN KEY ("ci_id") REFERENCES "configuration_items"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
```

**Recommendation:** Document the rollback SQL in `PLAN_v2.5.2.md` under Task H and/or in a `_rollback.sql` file alongside the migration. Target: Compliance review (Task M).

---

### V2.5.2-A03-2 — Low: `device_models` table lacks a unique constraint on `(name, manufacturer_id)` — pre-existing but exposed by Task K (A03 / data integrity)

**Severity:** Low
**Status:** 📋 BACKLOG (prerequisite for V2.5.2-A03-1 fix — will be resolved together)
**File:** `backend/prisma/schema.prisma:256–269`, migration `20260315223241`
**OWASP:** A03 (data integrity)

**Description:**

The `DeviceModel` Prisma model has no `@@unique([name, manufacturerId])` declaration and no corresponding database unique index. While `manufacturers` has a `UNIQUE` index on `name`, `device_models` can accumulate duplicate `(name, manufacturer_id)` rows. This is a pre-existing gap that Task K exposed by adding automated inserts.

The fix (a new `CREATE UNIQUE INDEX` migration + `@@unique` in schema.prisma) is a prerequisite for the `ON CONFLICT DO NOTHING` upsert pattern in the V2.5.2-A03-1 remediation, so both findings will be resolved by the same fix. Tracked separately for completeness.

---

### V2.5.2-INFO-1 — Informational: No audit record for CASCADE-deleted `hardware_cis` / `software_cis` detail rows on CI deletion

**Severity:** Informational
**Status:** No action required (accepted design)
**File:** `backend/src/index.ts:1734–1741` (single CI delete), `backend/src/index.ts:1615–1709` (bulk CI delete)
**OWASP:** A09

The `DELETE_CI` and `CI_BULK_DELETE` audit records document the CI-level deletion. The `hardware_cis` / `software_cis` child rows are now CASCADE-deleted without a separate audit record for the detail rows. Since these tables are 1:1 children of the CI (identified by the same `ci_id`), the CI-level audit record implicitly covers the deletion of the child detail. The serial number and model fields are not captured in the `details` payload.

For forensic completeness, the serial number could be included in the `DELETE_CI` `details.serialNumber` before deletion. This is an enhancement, not a compliance violation given the current audit schema. **Recommended for v2.6.x.**

---

### V2.5.2-INFO-2 — Informational: `?type=` and `?filter=` params immediately stripped via `router.replace` — no open-redirect risk

**Severity:** Informational
**Status:** No action required
**File:** `frontend/app/inventory/page.tsx:369`, `frontend/app/contracts/page.tsx:871–874`

Both deep-link `useEffect` hooks call `router.replace("/inventory", …)` and `router.replace("/contracts", …)` with a hardcoded path string immediately after consuming the param. There is no dynamic path construction from user input, and the replaced URL never includes the original param value. No open-redirect, no reflected XSS, no state persistence in browser history. ✅

---

## Phase 2: Cross-cutting Checks

### ISO 27001 A.8.15 — Audit log atomicity

All new `audit_logs` inserts in Task K are inside the same `prisma.$transaction`. If the CI create fails, the audit records for the auto-created masters are also rolled back. This satisfies the atomicity requirement. ✅

### GDPR Art.5 — Data minimisation in logs

New audit log `details` payloads:
- `CREATE_MASTER/Manufacturer`: `{ name: mfrName, source: 'ci-bulk-import' }` — manufacturer name is not PII. ✅
- `CREATE_MASTER/DeviceModel`: `{ name: modelName, manufacturerId: mfrId, source: 'ci-bulk-import' }` — device model name is not PII. ✅
- No user names, email addresses, or DNI values in any new log records. ✅

### NIS2 Art.23 — Incident reconstructability

The `CI_BULK_COMMIT` record links `batchItemId → ciId`, enabling reconstruction of which items were committed in an incident. The gap in `manufacturerId` / `ciModelId` not being in the commit details is noted in V2.5.2-A09-1 (Medium). The cascade migration does not remove any existing reconstruction path. ✅ with minor gap.

### A04 — No new payload limits or concurrency issues introduced

Task K adds no new endpoints and no new configurable limits. It runs inside the existing `materializeCIBulkItem` transaction, bounded by `CI_BULK_CONCURRENCY`. The additional DB round-trips (2–4 queries per item) are proportional to existing work. No unbounded resource consumption. ✅

Task H migration: `ACCESS EXCLUSIVE` lock is ephemeral. No persistent performance impact. ✅

---

## Findings Table

| ID | Severity | OWASP | Title | Status |
|----|----------|-------|-------|--------|
| V2.5.2-A03-1 | **High** | A03, A08 | SELECT-then-INSERT upsert race — UniqueViolation DoS on manufacturers, silent duplicate rows on device_models | ✅ MITIGATED (task-u) |
| V2.5.2-A09-1 | Medium | A09 | CI_BULK_COMMIT audit record omits manufacturerId / ciModelId provenance | ✅ FIXED (task-u) |
| V2.5.2-A08-1 | Low | A08 | CASCADE migration has no documented SQL rollback procedure | 📋 BACKLOG v2.6.x |
| V2.5.2-A03-2 | Low | A03 | `device_models` table lacks unique constraint on `(name, manufacturer_id)` | ✅ FIXED (migration 20260603100000) |
| V2.5.2-INFO-1 | Info | A09 | No audit record for serial number / model detail on CI deletion | ✅ Accepted design |
| V2.5.2-INFO-2 | Info | A01 | Deep-link URL params stripped immediately — no open-redirect | ✅ Pass |

---

## Backlog Items for v2.6.x

The following Low findings from v2.5.1 remain open:

| ID | Categoria | Esfuerzo | Descripción |
|----|-----------|----------|-------------|
| V2.5.1-A09-4 | Performance/Audit | S | GIN index sobre `audit_logs.details->'ciIds'` |
| V2.5.1-A05-1 | Config/Safety | XS | Startup warning si `CI_BULK_CONCURRENCY` fuera de rango |
| V2.5.1-A04-5 | Rate limiting | S | Rate limit dedicado (10/min) para bulk endpoints |
| V2.5.1-A04-6 | Defensive coding | XS | Assert sobre `withConcurrency` task array bound |
| V2.5.1-A04-7 | Concurrency | M | Pre-check adendas dentro de transaction con `FOR UPDATE` |

New Low findings added in v2.5.2:

| ID | Categoria | Esfuerzo | Descripción |
|----|-----------|----------|-------------|
| V2.5.2-A08-1 | Compliance/Recovery | XS | Documentar SQL rollback de migración CASCADE en PLAN y/o `_rollback.sql` |
| V2.5.2-INFO-1 | Forensics/Audit | XS | Incluir `serialNumber`/`model` en `details` de `DELETE_CI` antes de borrado |
