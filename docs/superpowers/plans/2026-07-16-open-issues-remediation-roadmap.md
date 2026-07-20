# Open Issues — Recap & Remediation Roadmap (2026-07-16)

Status of all 9 open GitHub issues, verified against `origin/main` and live code, plus a prioritized plan for the 4 that need real work.

---

## Bucket A — Already fixed, only need closing (5 issues)

These were fixed in prior releases; the fix commits are confirmed present in `origin/main` and (where checkable) live in code. They were simply never closed on GitHub.

| # | Sev | Title | Fixed in | Verification |
|---|-----|-------|----------|--------------|
| #165 | **HIGH / Security** | LDAP TLS `allowUnauthorizedCerts` invertido (MITM) | v3.3.0 `f82fefa` | `credentials.ts:77` now `=== 'true'` (opt-in), comment warns MITM. Commit in main. |
| #166 | MEDIUM / Backend | RBAC manual en `/api/admin/n8n/resync` | v3.3.0 `f82fefa` | Centralizado a `requireAdmin` en el mount. Commit in main. |
| #168 | MEDIUM / Infra | `N8N_API_KEY`/`N8N_INTERNAL_URL` no pasados al backend | v3.3.0 `85500e6` | Ambas vars en `environment:` de ambos compose. Commit in main. |
| #167 | LOW / Infra | Dev compose sin `EXECUTIONS_DATA_*` (ejecuciones ilimitadas) | v3.3.0 `0c7abc4` | Prune+maxAge en dev n8n. Commit in main. |
| #179 | LOW / Infra | Ventana de reintento n8n de 60s insuficiente | **v3.5.5** (this session) | Window 60s→120s (15×8s). Verified live post-deploy: boot log `intento 1/15`. |

**Action:** close all 5 with a note pointing at the fixing commit/release. No code work. Needs your go-ahead (closing issues is an outward-facing action) — see "Immediate action" below.

---

## Bucket B — Real work remaining (4 issues)

### Priority ranking

1. **#181** (MEDIUM, Infra) — n8n credential provisioning broken, actively failing in prod every boot
2. **#172** (MEDIUM, Security) — non-transactional audit in legacy `index.ts` + non-staff-schedule modules (ISO 27001 A.8.15)
3. **#153** (deps) — transitive `exceljs → uuid` npm-audit advisories
4. **#152** (tech-debt) — `otplib` v12 → v13 migration (MFA TOTP)

Rationale: #181 is a live functional failure; #172 is a compliance gap with a narrow failure window (partially done already); #153/#152 are low-actionability hygiene items.

---

### #181 — n8n credential provisioning fails (500/400)

**Status:** root cause confirmed live, not fixed. Every backend boot logs 4 errors:
`CMDB Service Token` (500), `CMDB SMTP` (500), `CMDB LDAP` (400), `vCenter Sync` workflow (400). The 7 existing workflows update fine; impact is scoped to new credential creation + the vCenter workflow.

**Root cause (500s, confirmed):** n8n 1.123.x organizes credentials/workflows by `Project`. Every user created through n8n's normal flow (UI, `/rest/owner/setup`, invite) gets a personal `Project` + a `project_relation` row (`project:personalOwner`). The service identity `cmdb-provisioner@cmdb.local` is created by `scripts/lib/n8n-bootstrap.sh` (`n8n_ensure_owner_and_key`, Case B) via a **direct SQL `INSERT`** into `n8n_data."user"`, which skips the hook that would create that Project. Credential creation then fails: `Could not find any entity of type "Project"`.

**Not yet root-caused:** the LDAP `400` (likely an incomplete credential payload / wrong credential type for this n8n version) and the vCenter workflow `400` (may cascade from the missing credential).

**Proposed approach** (pick one at implementation time — decision for the session that picks this up):
- **Option A (targeted):** in `n8n_ensure_owner_and_key` Case B, after the user `INSERT`, also insert the personal `Project` + `project_relation` rows the normal flow would create (inspect `n8n_data.project` / `project_relation` schema in 1.123.27 first). Lowest blast radius, but couples the bootstrap script to n8n's internal schema.
- **Option B (use the real owner):** mint the provisioning key against the genuine instance owner (Case A / `/rest/owner/setup`) instead of a SQL-inserted service identity — the owner gets its Project automatically. Viable only if a real owner doesn't already exist separately; needs checking.
- **Then:** re-diagnose the LDAP + vCenter `400`s once credential creation works (the vCenter `400` may disappear once its credential exists).

**Effort:** M (schema investigation on a live n8n + a bootstrap-script change + re-verify all 4 provisioning calls). **Risk:** touches the n8n bootstrap path used by install/update — test in dev n8n before prod. **Testable:** after fix, `POST /api/admin/n8n/resync` returns a report with `errors: []`.

---

### #172 — non-transactional audit (legacy + remaining modules)

**Status:** partially done. The **staff-schedule module is already transactional** (`audit.ts` takes `Prisma.TransactionClient`, router wraps mutation+audit in one `$transaction`, `auditTransaction.test.ts` exists — shipped in v3.5.1). Issue was left open only for the rest.

**Remaining scope:** the legacy `index.ts` pattern (mutation commits, then a separate `$executeRaw` audit insert — e.g. `CREATE_RELATION`/`DELETE_RELATION` at `index.ts:3070`, `:3146`, and the other legacy domains) plus any non-staff-schedule module following the same 2-step pattern. If the audit insert fails or the process dies between the two steps, the write persists with no `audit_logs` record — a strict A.8.15 gap.

**Proposed approach:**
- Inventory every write path that does `mutation` then a separate audit insert (grep `INSERT INTO audit_logs` in `index.ts` and each module; cross-check against the write handlers).
- Wrap each `mutation + audit` in a single `prisma.$transaction(async (tx) => { ... })`, passing `tx` to both. Follow the exact pattern already proven in `staff-schedule/audit.ts` + `router.ts`.
- Per write path: add/extend a test that forces the audit insert to fail and asserts the mutation rolled back (mirror `auditTransaction.test.ts`).
- `reports/audit.ts` swallows audit errors (`console.error` + continue) — defensible for reads (`VIEW_REPORT`/`EXPORT_REPORT`), **not** for writes; confirm it's only used on read paths.

**Effort:** L (many legacy handlers, each needs a transaction wrap + a rollback test — good candidate for decomposition into per-domain tasks). **Risk:** medium — touching every legacy write path; TDD per handler contains it. **Testable per handler:** forced-audit-failure test shows no orphaned write.

---

### #153 — transitive `exceljs → uuid` npm-audit advisories

**Status:** open, low actionability (from `project_pending` memory: verified low-impact 2026-06-19).

**Proposed approach:** `cd backend && npm audit` to get the current advisory set; check whether a newer `exceljs` (or an `overrides` pin on the transitive `uuid`) clears it without breaking the XLSX export used by the reports/inventory modules. If `exceljs` has no fixed release, an `overrides` entry in `package.json` is the fallback. Verify XLSX export still works after the bump (reports module has export tests).

**Effort:** S. **Risk:** low (dev dependency surface; export is well-tested). **Testable:** `npm audit` clean for that advisory + reports export test green.

---

### #152 — `otplib` v12 → v13 migration (MFA TOTP)

**Status:** open, tech-debt (from `project_pending` memory).

**Proposed approach:** review `otplib` v13 changelog for breaking API changes (`authenticator.generate/check/verify`, used in the MFA login path in `index.ts` and the test-admin recipe). Bump, adjust call sites, run the MFA e2e path (the CLAUDE.md temp-admin recipe is a ready-made end-to-end check — seed a TOTP admin, compute a code with the new lib, log in). **Critical constraint:** the same `otplib` validates real user MFA — a regression locks out every MFA-enabled admin. Must verify login end-to-end before shipping, not just unit tests.

**Effort:** S–M. **Risk:** medium (auth-critical) — but well-contained and directly testable end-to-end. **Testable:** seed temp MFA admin, log in with a v13-generated code → 200.

---

## Suggested sequencing

1. **Now (no code):** close the 5 Bucket-A issues (#165, #166, #167, #168, #179) with fix references.
2. **Next session:** #181 (live prod failure) — brainstorm Option A vs B first, then implement + verify in dev n8n.
3. **After:** #172 remaining scope — decompose into per-domain transaction-wrap tasks with rollback tests (subagent-driven, one domain per task).
4. **Hygiene, batchable anytime:** #153 and #152 — small, independent; can be done in parallel or folded into a maintenance release.

Each of #181, #172, #153, #152 can be expanded into a full bite-sized implementation plan when it's picked up — this document is the triage layer above those.
