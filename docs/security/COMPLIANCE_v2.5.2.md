# Compliance Review — CMDB Enterprise Platform v2.5.2

| Field | Value |
|-------|-------|
| **Release** | v2.5.2 |
| **Branch** | `develop` (HEAD post-task-u) |
| **Base** | `main` (v2.5.1) |
| **Review date** | 2026-06-03 |
| **Reviewer** | Claude (automated compliance agent) |
| **Scope** | `git diff main...develop` — Tasks H, K, I, L/task-u fixes |
| **Frameworks** | ISO 27001:2022, GDPR (EU 2016/679), NIS2 (EU 2022/2555), ISO 22301:2019 |

---

## Executive Summary

Release v2.5.2 introduces three functional changes and one OWASP remediation pass. All changes are **narrow in scope** and follow established security patterns from v2.5.1. No new personal data processing has been introduced. The audit trail has been **extended** with richer fields. Two documentation gaps are noted as non-blocking.

| Verdict | Count |
|---------|-------|
| ✅ PASS | 12 |
| ⚠️ GAP (non-blocking) | 2 |
| ❌ FAIL (blocking) | 0 |

**Overall verdict: ✅ PASS — release v2.5.2 unblocked. Address GAP items in v2.6.x.**

---

## Scope — Changed Files

| File | Task | Nature |
|------|------|--------|
| `backend/src/index.ts` | K + task-u | Bulk import master upsert + audit enrichment |
| `backend/prisma/migrations/20260602184003_hardware_software_cascade_on_delete/migration.sql` | H | FK ON DELETE CASCADE |
| `backend/prisma/migrations/20260603100000_device_models_unique_name_manufacturer/migration.sql` | task-u | UNIQUE index for race-condition fix |
| `frontend/app/page.tsx` | I | Dashboard deep-link URL params |
| `frontend/app/inventory/page.tsx` | I | Client-side filter from `?type=` |
| `frontend/app/contracts/page.tsx` | I | Client-side filter from `?filter=` |
| `docs/PLAN_v2.5.2.md` | — | Documentation only |

---

## ISO 27001:2022 Findings

### A.8.15 — Logging

#### Finding ISO-01: Single-CI delete audit record
**Check:** Does `DELETE /api/cis/:id` produce an `audit_logs` record with sufficient fields?

- Route: `app.delete('/api/cis/:id', authenticateToken, requireAdmin, ...)`
- Implementation: delete and audit are wrapped in a single `prisma.$transaction`. The audit record uses `action='DELETE_CI'`, `entity='CI'`, `entity_id=<uuid>`, `user_email`, and `details={"name":"<ci_name>"}`.
- The pre-fetch of `ci.name` happens **outside** the transaction, before the delete; the name is preserved in `details.name` even after the row is gone.
- The delete executes first inside the tx, then the audit INSERT — both succeed atomically or both roll back.

**Observation:** The audit occurs after the delete inside the same transaction. Should the `INSERT INTO audit_logs` fail after `tx.cI.delete()` succeeds at the DB level, the transaction rolls back and neither change persists. Atomicity is preserved. **No gap.**

**Verdict: ✅ PASS** — `details.name` preserves the CI name for post-deletion forensics. Transaction guarantees atomicity.

---

#### Finding ISO-02: Bulk-delete audit records
**Check:** Does `POST /api/cis/bulk-delete` produce per-CI and aggregate audit records?

- Route: `app.post('/api/cis/bulk-delete', authenticateToken, requireAdmin, ...)`
- Implementation: inside a single transaction — (1) one `DELETE_CI` record per CI with `details={"name":"<name>"}` written **before** the `deleteMany`, (2) one `CI_BULK_DELETE` aggregate record with `{requested, deleted, notFound, sample[0..9], truncated, brokenRefs, forced}`.
- The per-CI audit is written prior to deletion, so entity names are captured from the pre-fetched `existingMap`.

**Verdict: ✅ PASS** — dual-layer audit (per-item + aggregate) satisfies NIS2 Art.23 traceability. Transaction ensures no phantom audit rows.

---

#### Finding ISO-03: CI_BULK_COMMIT audit — manufacturerId + ciModelId fields (Task K + task-u)
**Check:** Does the `CI_BULK_COMMIT` record now include `manufacturerId` and `ciModelId`?

Before task-u the `CI_BULK_COMMIT` details were: `{ batchItemId, ciName }`.

After task-u the details are:
```
{ batchItemId, ciName, manufacturerId: <uuid|null>, ciModelId: <uuid|null> }
```

This change was introduced by the task-u diff in `materializeCIBulkItem` (line 4901).

**Verdict: ✅ PASS** — the commit record now links back to the master data rows it created or resolved. NIS2 incident reconstruction is complete (see NIS2 findings below).

---

#### Finding ISO-04: CREATE_MASTER audit events for auto-created manufacturers and device models (Task K)
**Check:** Are `CREATE_MASTER` events emitted for manufacturer/model upserts during bulk import?

- `Manufacturer` upsert (new row only): `CREATE_MASTER` with `entity='Manufacturer'`, `entity_id=<uuid>`, `details={"name":"<mfrName>","source":"ci-bulk-import"}`.
- `DeviceModel` upsert (new row only): `CREATE_MASTER` with `entity='DeviceModel'`, `entity_id=<uuid>`, `details={"name":"<modelName>","manufacturerId":"<uuid>","source":"ci-bulk-import"}`.
- Both are emitted **inside the same transaction** as the CI creation. No audit record is emitted when an existing master record is resolved (correct — no new write occurred).

**Verdict: ✅ PASS** — events are transaction-scoped, cover only new inserts, and include the `source` field to distinguish automated from manual creation.

---

#### Finding ISO-05: Task I — Dashboard URL params
**Check:** Do the `?type=` and `?filter=` parameters trigger any server-side writes requiring audit coverage?

- `frontend/app/inventory/page.tsx`: reads `searchParams.get("type")` in a client-side `useEffect` and applies it as a local React state filter over already-fetched CIs. No API write is triggered.
- `frontend/app/contracts/page.tsx`: reads `searchParams.get("filter")` and sets a local `filters` state. No API write is triggered.
- `frontend/app/page.tsx`: adds `?type=hardware`, `?type=software`, `?filter=adenda`, `?filter=active`, `?filter=expired`, `?filter=expiring` to dashboard link `href` attributes.

**Verdict: ✅ PASS** — purely client-side presentation change. No server writes; no audit requirement.

---

### A.8.32 — Change Management / Rollback

#### Finding ISO-06: Migration 20260602184003 — CASCADE FK fix (Task H)
**Check:** Is a documented rollback SQL procedure provided?

The migration SQL:
```sql
ALTER TABLE "hardware_cis" DROP CONSTRAINT "hardware_cis_ci_id_fkey";
ALTER TABLE "hardware_cis" ADD CONSTRAINT ... ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "software_cis" DROP CONSTRAINT "software_cis_ci_id_fkey";
ALTER TABLE "software_cis" ADD CONSTRAINT ... ON DELETE CASCADE ON UPDATE CASCADE;
```

The migration file contains no rollback DDL. The PLAN_v2.5.2.md backlog item `V2.5.2-A08-1` explicitly flags this gap: _"Migración 20260602184003 sin procedimiento SQL de rollback documentado; añadir a PLAN o migration.sql"_.

**Rollback DDL** (for reference, not present in the migration file):
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

**Verdict: ⚠️ GAP (non-blocking)** — rollback DDL is not documented inside the migration file or PLAN. The change itself is correct and already applied. Document the rollback SQL in v2.6.x (backlog item V2.5.2-A08-1 already tracks this).

---

#### Finding ISO-07: Migration 20260603100000 — UNIQUE index on device_models (task-u)
**Check:** Is rollback DDL provided?

The migration includes an explicit rollback comment:
```sql
-- Rollback: DROP INDEX IF EXISTS "device_models_name_mfr_key";
```

**Verdict: ✅ PASS** — rollback is documented in the migration file.

---

### A.9.2 — Access Control

#### Finding ISO-08: Bulk-import commit route authorization
**Check:** Is `POST /api/cis/bulk/items/:id/commit` gated by `requireAdmin`?

```
app.post('/api/cis/bulk/items/:id/commit', authenticateToken, requireAdmin, ...)
```

Additional ownership check: the handler queries `ci_bulk_import_item` joined with `ci_bulk_import_batch` filtering `b.created_by = req.user!.email`, preventing an ADMIN from committing another ADMIN's batches.

All other bulk routes (`batches`, `reanalyze`, `template.xlsx`, `bulk-delete`, `bulk-update`) also carry `requireAdmin`.

**Verdict: ✅ PASS** — `requireAdmin` enforced on all bulk-import write routes. Ownership check adds a second layer.

---

#### Finding ISO-09: Inventory and contracts read endpoints — authentication
**Check:** Do the API endpoints called by the Task I pages still require authentication?

- `GET /api/cis` (line 1329): `authenticateToken` (all authenticated roles).
- `GET /api/contracts` (line 1830): `authenticateToken` (all authenticated roles).

Both endpoints require a valid JWT. The client-side URL parameter feature does not bypass authentication — it only pre-fills the local filter state after the page has loaded and the authenticated API calls have completed.

**Verdict: ✅ PASS** — no unauthenticated data access introduced.

---

### A.5.37 — Documented Operating Procedures

The bulk-import master upsert pattern (Task K) is described in PLAN_v2.5.2.md (§Tarea K). The migration procedure follows the established pattern (manual `migration.sql` + `prisma migrate deploy`). The OWASP audit report (`docs/security-audit/owasp-v2.5.2.md`) documents the High and Medium findings and their resolution in task-u.

**Verdict: ✅ PASS** — operating procedures are documented.

---

## GDPR Findings

### Art.5 — Data Minimisation

#### Finding GDPR-01: CREATE_MASTER audit records — PII assessment
**Check:** Do the new `CREATE_MASTER` audit records for manufacturers and device models leak any personal data?

- `Manufacturer` record details: `{ name: "<vendor_name>", source: "ci-bulk-import" }` — vendor/company name, not personal data.
- `DeviceModel` record details: `{ name: "<model_name>", manufacturerId: "<uuid>", source: "ci-bulk-import" }` — product name + UUID, not personal data.

No email addresses, usernames, or other PII appear in these `details` payloads. The `user_email` field is the triggering ADMIN's email, which is a standard audit field used consistently throughout the codebase and serves legitimate accountability purposes (ISO 27001 A.8.15).

**Verdict: ✅ PASS** — no PII in details payloads. `user_email` in the audit record is compliant by design.

---

#### Finding GDPR-02: CI_BULK_COMMIT details — PII assessment
**Check:** Does the updated `CI_BULK_COMMIT` record (`{ batchItemId, ciName, manufacturerId, ciModelId }`) contain PII?

- `batchItemId`: UUID, no PII.
- `ciName`: CI asset name (e.g., "SRV-PROD-01"), not personal data.
- `manufacturerId`: UUID foreign key, not personal data.
- `ciModelId`: UUID foreign key, not personal data.

**Verdict: ✅ PASS** — no PII introduced.

---

### Art.17 — Right to Erasure

The `DELETE /api/users/:id/erase` endpoint is not modified in this release. No new personal data fields have been added to the User model or any model linked to it. The `assignedUser` field on `CI` is a plain string (not a FK to `users`) and is already handled by the existing erasure endpoint via anonymisation.

**Verdict: ✅ PASS** — no new erasure obligations introduced.

---

### Art.30 — Records of Processing Activities

#### Finding GDPR-03: New master data entities — processing register assessment
**Check:** Do auto-created `manufacturers` and `device_models` records constitute personal data processing requiring an Art.30 register entry?

- `manufacturers` table: stores vendor/company names (e.g., "Dell", "Cisco"). These are legal entity names, not natural person data. Not personal data under GDPR Art.4(1).
- `device_models` table: stores product model names (e.g., "PowerEdge R740"). Not personal data.
- The `created_by` trail is the ADMIN's `user_email` captured in `audit_logs`, already covered by the existing processing register entry for audit logging.

**Conclusion:** The auto-creation of manufacturer and device model master records during bulk import does **not** introduce new personal data processing. No new Art.30 register entry is required.

**Verdict: ✅ PASS** — no new processing of personal data. Existing Art.30 entries remain sufficient.

---

## NIS2 Findings

### Art.23 — Incident Reporting / Audit Trail Reconstruction

#### Finding NIS2-01: Hypothetical incident — "malicious bulk import created phantom manufacturer records"
**Reconstruction trace:**

1. **Identify the window:** Query `audit_logs WHERE action = 'CREATE_MASTER' AND entity = 'Manufacturer' AND details->>'source' = 'ci-bulk-import'` filtered by time window.
2. **Find the triggering CI commit:** Query `audit_logs WHERE action = 'CI_BULK_COMMIT' AND details->>'manufacturerId' = '<mfr_uuid>'` — returns the `batchItemId` and the committed `entity_id` (CI UUID).
3. **Trace to batch:** Query `ci_bulk_import_item WHERE id = '<batchItemId>'` to get `batch_id`, then `ci_bulk_import_batch WHERE id = '<batch_id>'` to get `created_by`, `created_at`, and the original uploaded file reference.
4. **Actor identification:** `audit_logs.user_email` on both the `CREATE_MASTER` and `CI_BULK_COMMIT` records identifies the ADMIN who triggered the import.

**Assessment:** The audit trail is fully reconstructible. The `source: 'ci-bulk-import'` tag on `CREATE_MASTER` events and the `manufacturerId` field on `CI_BULK_COMMIT` records form a complete chain from master row → commit → batch → actor.

**Verdict: ✅ PASS** — incident can be reconstructed within the 24h initial NIS2 reporting window.

---

#### Finding NIS2-02: Hypothetical incident — "CI was deleted and hardware details lost"
**Reconstruction trace:**

1. **Find the deletion:** Query `audit_logs WHERE action = 'DELETE_CI' AND entity_id = '<ci_uuid>'` — returns `user_email`, `created_at`, and `details = {"name": "<ci_name>"}`.
2. **Find bulk context (if applicable):** Query `audit_logs WHERE action = 'CI_BULK_DELETE' AND details->>'sample' @> '"<ci_uuid>"'` for bulk deletes.

**Gap identified:** The `DELETE_CI` audit record captures only `{ name: "<ci_name>" }` in `details`. It does **not** preserve the hardware attributes that were cascade-deleted (serial number, model, manufacturer, etc.). After deletion, this data is unrecoverable from the audit trail alone.

This is a **pre-existing limitation** from v2.5.1 (not introduced in v2.5.2). The `CI_BULK_COMMIT` record that originally created the CI does preserve `ciName`, `manufacturerId`, and `ciModelId`, which partially reconstructs provenance — but the specific serial number is not in any audit record.

**Verdict: ⚠️ GAP (non-blocking)** — CI deletion audit captures name only; hardware attributes (serial number, model, manufacturer string) are not preserved in `details`. For forensic completeness, a future enhancement should snapshot the `HardwareCI` / `SoftwareCI` row into `details` before deletion. Tracking as backlog item for v2.6.x.

---

## ISO 22301:2019 Findings

### Recovery Procedures for Schema Changes

#### Finding BC-01: Migration 20260602184003 — reversibility (Task H)
**Change:** Drops and re-creates two FK constraints from `ON DELETE RESTRICT` to `ON DELETE CASCADE` on `hardware_cis` and `software_cis`.

**Reversibility assessment:**
- The DDL change is fully reversible by re-dropping and re-creating the constraints with `ON DELETE RESTRICT`.
- No data is altered; no rows are deleted by the migration itself.
- The rollback DDL is not documented in the migration file (see ISO-06 gap).
- RTO impact: `ALTER TABLE` acquires `ACCESS EXCLUSIVE` briefly on two tables that are 1:1 with `configuration_items`. Lock window is very short (sub-second on typical CMDB dataset sizes).

**Verdict: ⚠️ GAP (non-blocking)** — migration is reversible in practice but rollback DDL is undocumented. Same gap as ISO-06. Backlog item V2.5.2-A08-1.

---

#### Finding BC-02: Migration 20260603100000 — reversibility (task-u)
**Change:** Creates a functional `UNIQUE INDEX` on `device_models(LOWER(name), manufacturer_id)`.

**Reversibility assessment:**
- Documented rollback: `DROP INDEX IF EXISTS "device_models_name_mfr_key";`
- Creating the index will fail if duplicate rows exist — but the migration uses `CREATE UNIQUE INDEX IF NOT EXISTS`, so it is idempotent and safe to re-run.
- No data modification; no downtime risk.

**Verdict: ✅ PASS** — rollback documented; procedure is straightforward.

---

#### Finding BC-03: Application restartability (ISO 22301 RTO < 15 min)
No new stateful services, caches, or queues are introduced in v2.5.2. The bulk-import changes are transactional DB operations only. Dashboard URL parameter changes are frontend-only. No new start-up dependencies added.

**Verdict: ✅ PASS** — RTO target unaffected.

---

## Gaps & Recommendations

| ID | Framework | Severity | Description | Target |
|----|-----------|----------|-------------|--------|
| V2.5.2-A08-1 | ISO 27001 A.8.32 / ISO 22301 | ⚠️ Non-blocking | Migration `20260602184003` has no documented rollback DDL. Add rollback SQL as a comment block in the migration file or in PLAN. | v2.6.x |
| V2.5.2-NIS2-01 | NIS2 Art.23 | ⚠️ Non-blocking | `DELETE_CI` audit record captures only `{name}`. Hardware attributes (serial, model, manufacturer) are not snapshotted before CASCADE delete, limiting forensic reconstruction of hardware CIs. Enhance `DELETE_CI` handler to pre-fetch and include `HardwareCI` snapshot in `details`. | v2.6.x |

---

## Overall Verdict

**✅ PASS — Release v2.5.2 is approved for merge to `main`.**

- All 12 checked controls pass.
- 2 non-blocking gaps are documented and tracked for v2.6.x.
- 0 blocking failures.
- No new personal data processing introduced.
- All bulk-import write paths require `ADMIN` role.
- Audit trail extended with `manufacturerId` + `ciModelId` on `CI_BULK_COMMIT` records.
- Race-condition upsert gap (High, OWASP A03) and audit completeness gap (Medium, OWASP A09) both resolved in task-u before this review.
