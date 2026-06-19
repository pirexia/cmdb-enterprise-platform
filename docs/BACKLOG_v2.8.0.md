# Backlog — v2.8.0 Plugin Engine (post-merge code review)

> Generated from the closing code review + OWASP audit of the Plugin Engine (2026-06-13).
> All code (T1–T10) is merged to `develop`. These items are **follow-ups**, not merge blockers.
> Severity: **High** = documented feature does not execute end-to-end · **Medium** = security/correctness · **Low** = hygiene/consistency.
> Security analysis: `docs/security/OWASP_v2.8.0.md`. Each H/M item has a GitHub issue (see "Issue" column).

> **v2.8.1 progress (2026-06-13):** ✅ **RESOLVED** — H-03 (#111), M-01 (#113), M-02 (#114), M-03 (#115) — merged in PR #118. Also enabled the real sandbox isolation test suite and blocked `eval`/`Function` in the vm context.
> ⬜ **REMAINING** — H-01 (#109), H-02 (#110), H-04 (#112) runtime wiring; Low batch (#116).
> *(GitHub issue auto-close is blocked by PAT permissions; #111/#114/#115 may still show OPEN despite being fixed — close manually.)*
>
> **v2.8.7 progress (2026-06-19):** ✅ **RESOLVED** — the remaining runtime-wiring High/Medium were verified done in later releases: H-01 (hooks/cron/routes now created in `router.ts`), H-02 (scoped Prisma proxy wired, no `{}`), H-04 (public `/ui` static route exists), M-03 (`ipKeyGenerator` applied). ✅ **Low batch (#116) closed in this PR:** L-01 (rollback descoped in docs — honest `501`), L-03 (install now extracts before migrating, rolls back the extracted dir on migration failure), L-04 (`updateStatus` enforces `canTransition`, exempting `→ERROR`), L-08 (`staging_zip` recorded on the registry row → O(1) lookup + GC on install/uninstall), L-09 (4-eyes approval token is now a short-lived, single-use, `{pluginId, action}`-scoped token via `POST /:id/approve`, no longer a replayable session JWT). L-02/L-05/L-07 were already resolved earlier.

## Context

The v2.8.0 lifecycle (upload → validate → install → activate → deactivate → uninstall) works at the **status/governance** layer: bundles are validated, signed, checksummed, audited, and 4-eyes-gated. What is **not** wired is the **runtime execution** layer — turning an activated plugin's bundle into live hooks, cron jobs, routes, and UI. Several pieces were scaffolded as stubs (`prismaProxy — wired in T3`, `RouteRegistry.mount` no-op, no `/ui` route) and never connected. An inert runtime is fail-safe (no security exposure), but the feature is partially non-functional versus the documentation.

---

## High — runtime not wired end-to-end

### H-01 — Activation never registers a plugin's hooks / cron / routes
**Where:** `router.ts` install/activate, `index.ts:44-106`, `engine.ts`.
No code creates `PluginHook`, `PluginRoute`, or `PluginCronJob` rows. Grep confirms the only reference is one `prisma.pluginCronJob.update` (lastRunAt) — there is **no `.create`** anywhere. The install flow extracts the bundle and runs the migration but never parses the bundle's hook/route/cron definitions (incl. `handlerCode`) into the DB. Boot reactivation reads `plugin.hooks` / `plugin.cronJobs`, which are always empty → **activating a plugin loads zero behavior.**
**Fix:** on install (or activate), parse the bundle's hook/route/cron definitions + handler code into the `Plugin*` tables; then reactivation and live activation register them.
**Accept:** activating the `hello-world` example registers a `postCreateCI` hook that runs.

### H-02 — Sandbox handlers receive an empty Prisma proxy
**Where:** `index.ts:58` (`{} /* prismaProxy — wired in T3 */`) and `:76`.
Hook and cron handlers are invoked with `{}` as `prisma`. Any `db:read`/`db:write` from plugin code throws `TypeError`. The documented `hello-world` (writes to `plg_hello_world_log`) cannot work.
**Fix:** build a scoped Prisma proxy (read-only to core per `db:read`, read-write restricted to `plg_<id>_*` per `db:write`) and pass it into `SandboxExecutor.runHandler`.
**Accept:** a hook can `INSERT` into its own `plg_*` table and is denied on core tables.

### H-03 — Admin panel cannot list plugins (response-shape mismatch)
**Where:** `frontend/app/plugins/admin/page.tsx:273-276` vs `router.ts:147`.
Backend returns `{ plugins: [...] }`; the panel does `const data = await res.json() as Plugin[]; setPlugins(data)`, then `plugins.map(...)`. `data` is an object, not an array → the list never renders (or throws). Also `LogEntry` type (`{level,message,timestamp}`) ≠ API rows (`{action,user_email,details,created_at}`) → log viewer shows empty (L-05).
**Fix:** read `res.json().plugins`; align `LogEntry` with the audit row shape.
**Accept:** uploaded plugins appear in the table; logs render.

### H-04 — Plugin UI iframe points to a non-existent backend route
**Where:** `frontend/components/plugins/PluginIframe.tsx:132` → `/api/plugins/:id/ui?slot=…`; no such route exists (grep: no `/ui`, `sendFile`, or `express.static` in the plugins module).
Every rendered slot iframe loads a 404 (and would be ADMIN-gated by `router.use(requireAdmin)` even if it existed). UI slots are non-functional.
**Fix:** add a route that serves `PLUGIN_STORAGE_PATH/installed/<id>/ui/*` static assets with a strict per-plugin CSP, mounted **outside** the admin guard (UI may be viewed by non-admins); validate `slot` against the manifest's `uiSlots`.
**Accept:** an installed plugin with a `ui/` bundle renders inside its slot iframe.

---

## Medium — security / correctness

### M-01 — `validateMigrationSql` only blocks `DROP TABLE` on core
**Where:** `engine.ts:265-281`. TRUNCATE / DELETE FROM / ALTER TABLE / DROP INDEX on core objects pass validation (inner check only matches `DROP TABLE <non-plg>`). Mitigated in prod by the restricted role, but the documented control is incomplete. **OWASP A03/A08.**
**Fix:** reject any dangerous verb whose target does not start with `plg_<id>_`.

### M-02 — Migration falls back to superuser when `PLUGIN_DATABASE_URL` unset
**Where:** `engine.ts:297,310,317`; `docker-compose.yml` defaults it empty. In dev, plugin migrations run as admin/superuser. With M-01, a crafted migration could damage core. Prod requires the var (`:?`). **OWASP A05/A08.**
**Fix:** hard-fail when the restricted URL is missing (no superuser fallback); document `cmdb_plugin` as mandatory in dev too.

### M-03 — Rate limiter IPv6 bypass
**Where:** `middleware.ts:39-42`. Custom `keyGenerator` uses raw `req.ip` without `ipKeyGenerator`; `express-rate-limit` v8 logs `ERR_ERL_KEY_GEN_IPV6` at boot; IPv6 clients can bypass the limit. **OWASP A05.**
**Fix:** `import { ipKeyGenerator } from 'express-rate-limit'` and key on `` `${ipKeyGenerator(req.ip)}-${pluginId}` ``.

---

## Low — hygiene / consistency

| ID | Where | Issue | Fix |
|----|-------|-------|-----|
| L-01 | `router.ts:752` | `rollback` returns `501` though D4 lists it complete | Implement version rollback or descope in docs |
| L-02 | `router.ts:332` | `PLUGIN_SIGNING_PUBLIC_KEY` not in `.env.example`/compose | Add env var + docs |
| L-03 | `router.ts:435-442` | install runs up-migration **before** extract; extract failure leaves migration applied | Extract first, or roll back migration on failure |
| L-04 | `middleware.ts:19-30,63-78`; `engine.ts:366` | Dead code: unused `pluginUploadMulter`/`validateUploadedFile`; `canTransition` never called by `updateStatus` | Remove dead exports; enforce `canTransition` in `updateStatus` |
| L-05 | `page.tsx:53-57` vs `router.ts:724` | Log viewer type ≠ API row shape | Align types (folded into H-03) |
| L-06 | `index.ts:102` | Reactivation audit uses `pluginId` (kebab) for `entity_id` vs UUID elsewhere | Use `plugin.id` (UUID) |
| L-07 | `router.ts:83,94,104` | `.tar.gz`/`.tgz` accepted but only `unzip` used → install fails | Reject non-zip at upload, or add tar path |
| L-08 | `router.ts:301-316,410-425,610-625` | Staging zip found by O(n) manifest scan; orphaned zips never GC'd | Store staging path on the registry row; add cleanup |
| L-09 | `router.ts:486-500` | 4-eyes `approvalToken` is a generic session JWT (no scope/nonce, replayable in TTL) | Issue a short-lived approval token bound to `{pluginId, action}` |

---

## Suggested sequencing for a v2.8.1 hardening pass

1. **M-02 + M-01 + M-03** (security, small, independent) — one PR.
2. **H-03** (admin panel) — small frontend fix, unblocks manual testing of the whole lifecycle.
3. **H-01 + H-02** (hook/cron/route registration + Prisma proxy) — the substantive runtime work; ship the `hello-world` integration test alongside.
4. **H-04** (UI slot serving route + CSP).
5. **L-**\* batch — one cleanup PR.
