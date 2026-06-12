# OWASP Top 10 (2021) Security Review — v2.7.0

**Scope:** New features in release v2.7.0
- T4 — OperatingSystem CRUD (`backend/src/modules/catalog/`)
- T5 — BaseSoftware CRUD + CI association (`backend/src/modules/catalog/`)
- T6 — CI infrastructure fields (11 new columns on `configuration_items`)
- T7 — Bulk-import cascade (OS + BaseSoftware upsert on commit)
- T8 — Relation Map (12 new `RelationType` values + CI-type matrix)
- T10 — Audit log improvements (`details` JSONB, `entityName` filter)

**Reviewer baseline (v2.6.0):** 0 Critical / 0 High / 0 Medium — 4 Low.
**v2.7.0 result:** 0 Critical / 0 High / 0 Medium — 3 Low (informational). Posture maintained.

---

## Summary table

| #   | Risk                              | Verdict | Notes |
|-----|-----------------------------------|---------|-------|
| A01 | Broken Access Control             | ✅ PASS | `authenticateToken` on whole `/api/catalog` mount; `requireAdmin` on every write; `requireUuidParam` on every `:id`/`:ciId`/`:bswId`. |
| A02 | Cryptographic Failures            | ✅ PASS | No new secrets, crypto, or PII-at-rest. JWT/cookie unchanged. |
| A03 | Injection                         | ✅ PASS | 100% Prisma ORM or tagged-template `$queryRaw`. `entityName` ILIKE escaped with `escapeLike` + `ESCAPE '\\'`. |
| A04 | Insecure Design                   | ✅ PASS | D3 server-side type matrices (BaseSoftware allowlist, infra mutual-exclusion, relation matrix) enforced in backend, not UI. |
| A05 | Security Misconfiguration         | ✅ PASS | No new headers/config; module reuses existing helmet + nginx CSP. |
| A06 | Vulnerable & Outdated Components   | ✅ PASS | No new dependencies introduced by any T4–T10 task. |
| A07 | Identification & Auth Failures    | ✅ PASS | No new auth surface; all routes behind existing JWT middleware. |
| A08 | Software & Data Integrity Failures | ⚠️ OBSERVATION | Cascade upsert atomic via `ON CONFLICT (code)` in `$transaction`; one cross-module duplication note (relationTypes). |
| A09 | Security Logging & Monitoring     | ✅ PASS | Every write inserts an `AuditLog`; `details` JSONB carries no PII. |
| A10 | Server-Side Request Forgery       | ✅ PASS | No outbound HTTP introduced by v2.7.0. |

**Low findings:** L-01 (catalog DELETE leaks usage count — info only), L-02 (relation matrix duplicated FE/BE — drift risk), L-03 (catalog GET unrestricted to any authenticated role — by design).

---

## A01 — Broken Access Control ✅ PASS

**What v2.7.0 does**

- The catalog router is mounted at `app.use('/api/catalog', authenticateToken, createCatalogRouter(prisma))` (`index.ts:264`). Every catalog route therefore requires a valid JWT before any handler runs.
- Inside `router.ts`, all state-changing routes carry an explicit `requireAdmin` guard:
  - `POST/PATCH/DELETE /operating-systems` and `.../:id`
  - `POST/PATCH/DELETE /base-software` and `.../:id`
  - `POST /cis/:ciId/base-software`, `DELETE /cis/:ciId/base-software/:bswId`
- `requireAdmin` returns `403 Forbidden` for any non-`ADMIN` role (`router.ts:22-28`).
- Read routes (`GET`) are intentionally open to any authenticated role (`AUDITOR`/`VIEWER`/`ADMIN`), consistent with the platform's read-everywhere RBAC model.
- Every route bearing a path parameter is protected by `requireUuidParam`, which rejects non-UUID input with `400` (`router.ts:11-20`) — this is both an input-validation and an IDOR-surface-reduction control (no arbitrary string reaches the DB layer).
- T6/T8 handlers in `index.ts` reuse the existing `authenticateToken` + `requireAdmin` chain (`app.post('/api/relations', authenticateToken, requireAdmin, …)` at `index.ts:3644`).

**Verdict:** ✅ PASS — every write path is ADMIN-gated; ownership/existence is checked at DB level (`findById` / `getCiTypeCode` returning `null` → `404`), not via post-fetch filtering.

**Finding L-03 (informational):** Catalog `GET` endpoints expose the full OS/BaseSoftware catalogue to `VIEWER`/`AUDITOR`. This is by design (master data is non-sensitive reference data) and matches existing CIType/Location master-data behaviour. No action required.

---

## A02 — Cryptographic Failures ✅ PASS

**What v2.7.0 does**

- No new secrets, encryption keys, or credential material are introduced.
- The 11 new CI infrastructure fields (`cpuModel`, `vCpus`, `ram`, `disk`, `adminIp`, `mgmtIp`, `hostName`, `clusterName`, `operatingSystemId`, `firmwareVersion`, `dns`) are infrastructure metadata, not secrets, and are not credentials.
- JWT issuance, the HttpOnly/`SameSite=Strict`/`Secure` cookie, bcrypt rounds, and TLS termination at nginx are all unchanged.

**Verdict:** ✅ PASS — no cryptographic surface added or weakened.

---

## A03 — Injection ✅ PASS

**What v2.7.0 does**

- **T4/T5 (catalog):** All DB access goes through the Prisma client (`prisma.operatingSystem.*`, `prisma.baseSoftware.*`, `prisma.cIBaseSoftware.*` in `queries.ts`). The auto-code generator uses a parameterised `findMany({ where: { code: { startsWith: base } } })` — `base` is regex-sanitised to `[A-Z0-9_]` before use (`router.ts:71`), no raw SQL.
- **catalogAudit** (`audit.ts`) uses a `$executeRaw` **tagged template literal** with `${action}`, `${entity}`, `${entityId}::uuid`, `${userEmail}` — fully parameterised, no concatenation.
- **T7 (bulk cascade):** OS/BaseSoftware upserts use tagged-template `$queryRaw`/`$executeRaw` with `ON CONFLICT (code) DO NOTHING` (`index.ts:5257-5290`). All interpolated values (`osCode`, `osName`, `osVersion`, `userEmail`, JSON details) are template parameters.
- **T8 (relations):** CI-type lookup and the atomic `INSERT … SELECT … WHERE` are tagged-template `$queryRaw`; `relationType` is bound and cast `::"RelationType"` so an out-of-enum value fails at the type cast in addition to the `VALID_RELATION_TYPES` allowlist check at `index.ts:3584`/`3652`.
- **T10 (audit query):** the refactored CTE query is `$queryRaw` with `Prisma.sql`/`Prisma.join` fragments. The new `entityName` filter is the key injection-sensitive path and is correctly handled:
  ```
  const nameWhere = entityName
    ? Prisma.sql`WHERE entity_name ILIKE ${'%' + escapeLike(entityName.trim()) + '%'} ESCAPE '\\'`
    : Prisma.empty;
  ```
  `escapeLike` (`index.ts:113-115`) escapes `\`, `%`, `_`; the value is bound as a parameter (not concatenated into SQL text); the `ESCAPE '\\'` clause makes the escapes effective. The `entityName` type is also validated to be a string (`index.ts:2670`).

**Verdict:** ✅ PASS — no string concatenation into SQL anywhere in v2.7.0; LIKE/ILIKE wildcard escaping is correct per the codebase standard.

---

## A04 — Insecure Design ✅ PASS

**What v2.7.0 does**

Three distinct business-rule (D3) restrictions are all enforced **server-side**, which is the correct trust boundary:

1. **BaseSoftware → CI allowlist:** `POST /cis/:ciId/base-software` resolves the CI's type code and rejects with `422` unless it is in `BASE_SOFTWARE_ALLOWED_CI_TYPES` = `PHYSICAL_SERVER`, `VIRTUAL_SERVER`, `CLOUD_INSTANCE` (`router.ts:291-294`, `schemas.ts:28`).
2. **Infra-field mutual exclusion:** `validateInfraFieldsForType` (`index.ts:333-349`) rejects `cpuModel` + `vCpus` set together, and enforces physical-vs-virtual field applicability by CI type. Applied on both CI create (`index.ts:1490`) and update (`index.ts:1706-1712`, re-deriving effective values from current row to catch partial updates).
3. **Relation CI-type matrix:** `validateRelationCiTypes` (`relationTypes.ts:60-74`) checks source/target type codes against `RELATION_TYPE_MATRIX`; returns `422` on violation (`index.ts:3603`). `VALID_RELATION_TYPES` allowlist returns `400` for unknown types first. Legacy CIs without a resolved type code pass by design (documented), preserving existing data.

These are threat-modelled, least-surprise designs: invalid combinations cannot be persisted regardless of client.

**Verdict:** ✅ PASS — restrictions enforced at the server, distinct status codes (`400` malformed vs `422` semantic) aid correct client handling and avoid ambiguous failure modes.

---

## A05 — Security Misconfiguration ✅ PASS

**What v2.7.0 does**

- No new Express headers, CSP directives, or nginx changes. The catalog module inherits the global helmet config and the nginx/Next.js CSP.
- No debug or introspection endpoints added.
- Error handlers return generic messages (`{ error: 'Internal server error' }`) and log details to `console.error` server-side only (see A09).

**Verdict:** ✅ PASS.

---

## A06 — Vulnerable and Outdated Components ✅ PASS

**What v2.7.0 does**

- T4–T10 add **no new npm dependencies**. The catalog module uses only `express`, `@prisma/client`, and `zod` — all already in the dependency tree. No `npm audit` regression introduced.

**Verdict:** ✅ PASS.

---

## A07 — Identification and Authentication Failures ✅ PASS

**What v2.7.0 does**

- No new authentication surface, login path, token type, or session mechanism. All new routes sit behind the existing `authenticateToken` middleware, which verifies JWT signature + algorithm, the `mfaSetupRequired` flag, and live `users.active = true` on every request.

**Verdict:** ✅ PASS.

---

## A08 — Software and Data Integrity Failures ⚠️ OBSERVATION

**What v2.7.0 does**

- **T7 cascade integrity:** the OS/BaseSoftware upserts execute inside the bulk-commit `$transaction` (`tx.*`), and use `ON CONFLICT (code) DO NOTHING … RETURNING` with a deterministic `code` derived from the natural key (`masterCodeFromNaturalKey(name, version)`). This is the idempotent, concurrency-safe pattern: under parallel bulk workers no duplicate master rows are created, and the `RETURNING`-empty branch re-selects the existing row's id (`index.ts:5262-5269`, `5284-5291`). Correct.
- **T8 relation creation** uses an atomic `INSERT … SELECT … WHERE (COUNT = 2)` so a relation can only be persisted when both CIs exist — eliminating the TOCTOU race a separate existence-check would create (`index.ts:3605-3611`).
- **No deserialization of untrusted data, no `eval`/`Function`, no dynamic `require`.**

**Finding L-02 (Low — integrity/maintainability):** `RELATION_TYPE_MATRIX` / `VALID_RELATION_TYPES` are duplicated between `backend/src/relationTypes.ts` and `frontend/lib/relationTypes.ts` (noted in the file header "keep both in sync"). The backend copy is authoritative and enforced, so this is not an exploitable access-control gap, but divergence could let the UI offer a relation the backend rejects (or vice-versa), degrading data-integrity UX. Recommend a shared source or a CI check asserting parity.

**Verdict:** ⚠️ OBSERVATION — integrity controls are sound; the only item is the FE/BE matrix duplication (L-02). No exploitable defect.

---

## A09 — Security Logging and Monitoring Failures ✅ PASS

**What v2.7.0 does**

- **Every write produces an AuditLog record:**
  - Catalog: `CREATE_OS`/`UPDATE_OS`/`DELETE_OS`, `CREATE_BASE_SOFTWARE`/`UPDATE_BASE_SOFTWARE`/`DELETE_BASE_SOFTWARE`, `ASSOCIATE_BASE_SOFTWARE`/`DISSOCIATE_BASE_SOFTWARE` via `catalogAudit` (`router.ts`, `audit.ts`).
  - T7 cascade: `CREATE_MASTER` records for newly-created OS/BaseSoftware, with `source: 'ci-bulk-import'` in `details` (`index.ts:5264`, `5286`).
  - T6 CI create/update: `buildAuditDetails(...)` payloads (`index.ts:1547`).
- **AuditLog remains insert-only** — all new writes are `INSERT INTO "audit_logs"`; no UPDATE/DELETE path is added (ISO 27001 A.8.15 immutability preserved).
- **`details` JSONB carries no PII:** `buildAuditDetails(description, changes?)` documents that `changes` must use IDs, not emails (`index.ts:117-127`). The cascade `details` carry only OS/BaseSoftware `name`/`version`/`source` — infrastructure metadata, not personal data.
- **No sensitive data in error responses:** every catch returns a generic message and logs internally via `console.error('[catalog] … error:', err)`.

**Verdict:** ✅ PASS — full audit coverage on writes; no PII in `details`; insert-only invariant intact.

---

## A10 — Server-Side Request Forgery (SSRF) ✅ PASS

**What v2.7.0 does**

- No T4–T10 feature performs outbound HTTP. No caller-supplied URL is ever fetched. The existing allowlisted external calls (endoflife.date, JWKS) are untouched.

**Verdict:** ✅ PASS.

---

## Low findings (informational)

| ID   | Risk area | Description | Recommendation |
|------|-----------|-------------|----------------|
| L-01 | A01/info disclosure | Catalog `DELETE` returns `Cannot delete: in use by N record(s)` (`router.ts:138,253`). Discloses a usage count to ADMIN only. | Accept — ADMIN-only, operationally useful, no cross-tenant data. |
| L-02 | A08/integrity | Relation-type matrix duplicated FE/BE. | Single source of truth or CI parity check. |
| L-03 | A01/design | Catalog `GET` open to all authenticated roles. | Accept — non-sensitive master data, matches existing pattern. |

**Conclusion:** v2.7.0 introduces **0 Critical / 0 High / 0 Medium** OWASP findings and **3 Low (informational)**. Security posture meets or exceeds the v2.6.0 baseline. No remediation is required before release; L-02 is recommended as a maintainability hardening for a future iteration.
