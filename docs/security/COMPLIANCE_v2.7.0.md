# Compliance Review — v2.7.0

**Scope:** T4 OperatingSystem CRUD · T5 BaseSoftware CRUD + CI association · T6 CI infrastructure fields · T7 bulk-import cascade · T8 Relation Map · T10 audit log improvements.

**Frameworks:** ISO/IEC 27001:2022 · GDPR (EU 2016/679) · NIS2 (EU 2022/2555) · ISO 22301:2019.

---

## Executive summary

| Framework | Scope in v2.7.0 | Verdict |
|-----------|-----------------|---------|
| ISO/IEC 27001:2022 | A.8.15 logging, A.9.2 access control, A.8.12 data-leakage prevention | ✅ COMPLIANT |
| GDPR (EU 2016/679) | Data minimisation, no PII in logs, erasure coverage | ✅ COMPLIANT |
| NIS2 (EU 2022/2555) | Availability, incident reportability, supply-chain risk | ✅ COMPLIANT |
| ISO 22301:2019 | Business continuity, RTO < 15 min, no new SPOFs | ✅ COMPLIANT |

**Overall:** v2.7.0 is compliant across all four frameworks with no open gaps. One advisory (FE/BE relation-matrix duplication) is tracked under OWASP L-02 and has no compliance impact.

---

## ISO/IEC 27001:2022 ✅ COMPLIANT

### What v2.7.0 adds/changes
- New master-data module (OperatingSystem, BaseSoftware) with full CRUD + CI association.
- 11 new infrastructure attributes on CIs.
- Bulk-import cascade that auto-creates master records.
- 12 new relation types with a CI-type restriction matrix.
- Audit-log `details` JSONB column + `entityName` query filter.

### A.8.15 — Logging
- **Every data-modifying operation emits an `AuditLog`** with `action`, `entity`, `entity_id`, `user_email`, `created_at`:
  - Catalog writes via `catalogAudit()` (`modules/catalog/audit.ts`) — `CREATE_OS`/`UPDATE_OS`/`DELETE_OS`, `CREATE_BASE_SOFTWARE`/`UPDATE_BASE_SOFTWARE`/`DELETE_BASE_SOFTWARE`, `ASSOCIATE_BASE_SOFTWARE`/`DISSOCIATE_BASE_SOFTWARE`.
  - Cascade-created masters via `CREATE_MASTER` records (`index.ts:5264`, `5286`).
  - CI create/update via `buildAuditDetails()` payloads.
- **Log immutability (A.8.15 log protection) preserved:** all v2.7.0 audit writes are `INSERT`-only; no UPDATE/DELETE path against `audit_logs` is introduced. The `details` column is additive — existing rows and the insert-only invariant are untouched.
- The new `entityName` filter is a **read-only** enrichment (CTE join to resolve human-readable names at query time); it does not mutate audit rows.

### A.9.2 — User access management
- Access-control changes remain ADMIN-gated and audited. v2.7.0 adds no new user/role mutation paths; existing user-management audit coverage is unchanged.
- All catalog and relation writes require `ADMIN` (`requireAdmin`), enforced server-side. Read access is role-appropriate (any authenticated role can read master data).

### A.8.12 — Data leakage prevention
- No secrets are hardcoded; the module reads no new sensitive configuration. JWT secret, DB and SMTP credentials continue to come from environment variables.
- Error responses are generic; Prisma error objects and stack traces are never returned to clients (logged to `console.error` server-side only).
- Audit `details` contain only non-personal infrastructure metadata (OS/BaseSoftware name/version, CI field changes by ID) — no credential or PII leakage.

**Verdict:** ✅ COMPLIANT — logging coverage complete, immutability intact, access control and leakage controls satisfied.

---

## GDPR (EU 2016/679) ✅ COMPLIANT

### What v2.7.0 adds/changes
New persisted data is **infrastructure metadata about systems, not data subjects**: OS/BaseSoftware catalogue entries; CI specs (`cpuModel`, `vCpus`, `ram`, `disk`, `adminIp`, `mgmtIp`, `hostName`, `clusterName`, `firmwareVersion`, `dns`, `operatingSystemId`); relation records; audit `details`.

### Data minimisation (Art. 5(1)(c))
- All new fields are bounded by Zod (`max` lengths, `int` ranges, `ip()` validation for `adminIp`/`mgmtIp`, `uuid()` for FKs). Nothing collected beyond what the asset-inventory purpose requires.
- No new personal-data field is introduced. The platform's PII inventory (`email`, `username`, `ssoExternalId`) is unchanged.

### No PII in logs (Art. 5(1)(c), 25)
- `buildAuditDetails(description, changes?)` is documented to use **IDs, not emails**, in `changes` (`index.ts:117-127`), keeping personal data out of structured `details`.
- Cascade `details` carry only `name`/`version`/`source` of master records — non-personal.
- The `user_email` column in `AuditLog` is the existing, intentional accountability field required by ISO 27001 A.8.15 / NIS2; it is not new in v2.7.0 and is already covered by the platform's privacy notice and erasure flow.

### Erasure endpoint coverage (Art. 17)
- `DELETE /api/users/:id/erase` anonymises the defined PII fields (`email`, `username`, `ssoExternalId`). **v2.7.0 adds no new personal-data field**, so the erasure endpoint requires no extension — its coverage remains complete.
- New tables (`operating_systems`, `base_software`, `ci_base_software`) contain no personal data and are therefore correctly out of scope for erasure.

### DPIA note
- No DPIA trigger: v2.7.0 introduces no new processing of personal data, no profiling, and no new data subjects. Network identifiers such as `adminIp`/`mgmtIp` here describe managed infrastructure assets, not natural persons.

**Verdict:** ✅ COMPLIANT — privacy-by-design preserved; no new PII; erasure coverage unaffected.

---

## NIS2 (EU 2022/2555) ✅ COMPLIANT

### What v2.7.0 adds/changes
Catalogue + CI-attribute + relation-mapping capabilities, all internal to the existing monolith.

### Availability (Art. 21)
- No new stateful service, cache, queue, or external runtime dependency is introduced — no new single point of failure.
- Resource consumption is bounded: list endpoints return finite master-data sets; the bulk cascade runs inside the existing import `$transaction` with `ON CONFLICT DO NOTHING` (idempotent, no unbounded retry/loop). Zod `max` limits and the auto-code suffix loop are bounded by existing-row count.

### Incident reportability (Art. 23 — 24h/72h)
- The insert-only, append-rich `AuditLog` (now with `details`) **improves** forensic reconstruction for incident reporting; no change weakens or removes audit capability. The 24h/72h reporting workflow is not impeded.

### Supply-chain risk (Art. 21(2)(d))
- **No new third-party dependency or external integration** is added by T4–T10 (verified: catalog module uses only pre-existing `express`/`@prisma/client`/`zod`). Supply-chain attack surface is unchanged.
- Each feature is independently disableable (catalog router is a separately-mounted module; relation types are validated against an in-code allowlist) — no new always-on external coupling.

**Verdict:** ✅ COMPLIANT — no new SPOF, audit/reportability strengthened, supply-chain surface unchanged.

---

## ISO 22301:2019 — Business Continuity ✅ COMPLIANT

### What v2.7.0 adds/changes
Schema additions (new tables + 11 CI columns) and new application routes; no infrastructure/topology change.

### Backup integrity
- The `pg_dump` backup workflow is unaffected; new tables/columns are captured by a standard logical dump with no special handling. No backup mechanism is removed or weakened.

### RTO < 15 min
- No new start-up dependency, migration-on-boot blocker, or external service is introduced. Schema changes are delivered as additive, `IF NOT EXISTS`-guarded migrations applied via `prisma migrate deploy`; the application remains restartable from a clean container pull within the RTO target.

### No new SPOFs / recovery procedure
- No new stateful runtime service (cache/queue/worker) is added, so no new recovery procedure is required. The bulk-cascade logic is stateless and transactional — a failed import rolls back cleanly, leaving no partial master-data corruption.

**Verdict:** ✅ COMPLIANT — continuity, RTO, and SPOF criteria all met.

---

## Conclusion

v2.7.0 is **compliant with ISO/IEC 27001:2022, GDPR, NIS2, and ISO 22301:2019**. The release adds no personal data, no new third-party dependency, and no new single point of failure, while strengthening audit forensics via the `details` JSONB column. No compliance gaps require remediation before release. The FE/BE relation-matrix duplication (OWASP L-02) is a maintainability advisory with no compliance impact.
