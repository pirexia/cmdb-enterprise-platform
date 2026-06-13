# OWASP Top 10 (2021) Security Review — v2.8.0 Plugin Engine

**Scope:** Plugin Engine subsystem (`backend/src/modules/plugins/`, `frontend/components/plugins/`, `frontend/app/plugins/`, core hook instrumentation in `backend/src/index.ts`, infra in `scripts/create-plugin-db-role.sql` + compose).

**Reviewer baseline (v2.7.0):** 0 Critical / 0 High / 0 Medium — 3 Low.

**v2.8.0 result:** 0 Critical / 0 High *(security)* / 3 Medium / 3 Low + observations.
Separately, the code review found **4 High-severity functional gaps** (H1–H4) where the runtime extension surface is not wired end-to-end — these are tracked in `docs/BACKLOG_v2.8.0.md` and GitHub issues. They are **not** exploitable vulnerabilities (an inert plugin runtime is fail-safe), but they mean parts of the documented feature do not execute.

> **Trust model (D1) — read first.** The security boundary of the Plugin Engine is the **admission gate**, not the runtime sandbox. Node's `vm` module is explicitly *not* a security mechanism (documented in `engine.ts:31-39`). The gate is: Ed25519 signature + SHA-256 checksum + magic-byte/symlink validation + manual security checklist + 4-eyes approval in production. The `vm` context is hardened (frozen, no `fs`/`process`/`require`/`child_process`/`eval`/`globalThis`, 5 s timeout, `fetch` allowlist) as defense-in-depth. A plugin approved in error by a human reviewer can escape the sandbox — this is an accepted, documented risk and the reason `PLUGIN_SECURITY_CHECKLIST.md` exists.

---

## Summary table

| #   | Risk                               | Verdict | Notes |
|-----|------------------------------------|---------|-------|
| A01 | Broken Access Control              | ✅ PASS | `router.use(requireAdmin)` on whole `/api/plugins` mount; `requireUuidParam` on every `:id`; 4-eyes gate on activate in prod. |
| A02 | Cryptographic Failures             | ✅ PASS | Ed25519 verify + SHA-256 checksum. ⚠️ L-02: `PLUGIN_SIGNING_PUBLIC_KEY` missing from env templates. |
| A03 | Injection                          | ⚠️ OBSERVATION | Zod manifest; tagged `$queryRaw` for logs; `execFile` (not `exec`) for `psql`/`unzip`. **M-01**: `validateMigrationSql` DDL allowlist has a logic gap. |
| A04 | Insecure Design                    | ✅ PASS | D1 admission-gate trust model is explicit and documented. Hardened frozen `vm` context. |
| A05 | Security Misconfiguration          | ⚠️ FINDINGS | **M-02**: migration falls back to superuser `DATABASE_URL` when `PLUGIN_DATABASE_URL` unset. **M-03**: rate-limiter IPv6 bypass. |
| A06 | Vulnerable & Outdated Components    | ✅ PASS | No new npm deps with CVEs. Plugins themselves are third-party components → mitigated by signature + checklist (supply chain). |
| A07 | Identification & Auth Failures     | ⚠️ OBSERVATION | 4-eyes `approvalToken` is a standard session JWT of another ADMIN — no dedicated approval scope/nonce; replayable within token TTL. |
| A08 | Software & Data Integrity Failures  | ⚠️ FINDINGS | Strong gate (Ed25519/SHA-256/magic-bytes/symlink/UUID names). Signature is **optional** (unsigned plugins allowed). M-01 weakens DDL integrity control. |
| A09 | Security Logging & Monitoring       | ✅ PASS | `pluginAudit()` insert-only on every write. ⚠️ L-06: `entity_id` inconsistency on reactivation errors. |
| A10 | Server-Side Request Forgery        | ✅ PASS | Sandbox `safeFetch` allowlist from manifest (`engine.ts:50-57`); marketplace URL from env only, never caller. |

---

## A01 — Broken Access Control ✅ PASS

- The plugin router applies `router.use(pluginRateLimiter)` then `router.use(requireAdmin)` to **every** route (`router.ts:120-121`). All 12 endpoints require a valid JWT resolving to `role === 'ADMIN'`; verified live: `AUDITOR` token → `403` on `GET /api/plugins`, `POST /upload`, `GET /:id/config`.
- `requireUuidParam('id')` guards every `:id` route (`router.ts:47-57`), rejecting non-UUID input with `400` before any DB access (IDOR-surface reduction).
- Production activation requires **4-eyes**: `approvalToken` must be a valid ADMIN JWT whose `id`/`email` differ from the requester (`router.ts:477-501`).
- `authenticateToken` runs ahead of the mount (the engine is mounted via `initializePluginEngine` after core middleware); a missing/invalid token yields no `req.user` → `requireAdmin` fails closed.

**Observation (tracked H-04):** the iframe UI route `GET /api/plugins/:id/ui` does not exist yet. When implemented, note that `router.use(requireAdmin)` would make plugin UI ADMIN-only — UI meant for AUDITOR/VIEWER must be mounted **outside** the admin guard.

---

## A02 — Cryptographic Failures ✅ PASS

- Integrity verified with SHA-256 over the uploaded bundle (`engine.ts:235-239`) and optional Ed25519 signature over the checksum (`router.ts:342-351`, `crypto.verify(null, …, spki/der, …)` — correct for Ed25519).
- No new secret material at rest. 4-eyes uses the existing HS256 session secret.
- **Finding L-02:** `PLUGIN_SIGNING_PUBLIC_KEY` is read at `router.ts:332` but is absent from `.env.example`, `docker-compose.yml`, and `docker-compose.prod.yml`. Until set, any plugin declaring `manifest.signature` is rejected with `422`. Document and add the variable.

---

## A03 — Injection ⚠️ OBSERVATION

- Manifest parsed/validated with Zod (`schemas.ts`). Log queries use tagged `$queryRaw` with bound params (`router.ts:723-738`).
- Shell-out to `psql` and `unzip` uses `execFile` with arg arrays — never `exec`, no shell interpolation (`engine.ts:343-349`, `router.ts:83-97`).
- `$queryRawUnsafe(\`SELECT * FROM "${tablename}"\`)` in uninstall (`router.ts:589`): `tablename` originates from `pg_tables` (system catalog) and is re-checked `startsWith('plg_')` — not user input. Acceptable; low residual risk.
- The `dropPluginTables` `DO $$` block interpolates `prefix` into a `LIKE` clause (`engine.ts:320-328`), but `prefix` derives from a kebab-case-validated `pluginId` (`^[a-z0-9-]+$`) with `-`→`_`, so it cannot contain quotes. Safe.

**Finding M-01 (Medium):** `PluginValidator.validateMigrationSql` (`engine.ts:265-281`) is the documented primary control for plugin DDL, but its logic only throws on `DROP TABLE <non-plg>`. When `DANGEROUS_DDL_PATTERN` matches a `TRUNCATE`, `DELETE FROM`, `ALTER TABLE`, or `DROP INDEX` against a core object, the inner check (`dropOnCore`) is `null`, so the statement **passes validation**. Mitigated in production by the restricted `cmdb_plugin` role (no privileges on core tables), but the control as documented is incomplete and must be hardened (see M-02 for the case where the role mitigation is absent).

---

## A04 — Insecure Design ✅ PASS

- The trust model is explicit (D1) and documented in code (`engine.ts:31-39`), `PLUGIN_ENGINE.md`, and `PLUGIN_SECURITY_CHECKLIST.md`. The admission gate is the boundary; the sandbox is defense-in-depth.
- The `vm` context is frozen (`Object.freeze`) and strips `process`/`require`/`fs`/`child_process`/`eval`/`Function`/`globalThis`/timers (`engine.ts:59-93`), with a hard 5 s timeout.
- Data isolation by design (D2): plugin tables are prefixed `plg_<id>_` and executed by a role with no core-table privileges; uninstall takes a JSON backup before dropping.

---

## A05 — Security Misconfiguration ⚠️ FINDINGS

**Finding M-02 (Medium — prod-mitigated):** `MigrationRunner` falls back to the main `DATABASE_URL` (admin/superuser) whenever `PLUGIN_DATABASE_URL` is unset (`engine.ts:297,310,317`). `docker-compose.yml` (dev) defaults it to empty (`PLUGIN_DATABASE_URL:-`), so in dev plugin migrations run as **superuser**. Combined with M-01, a crafted `migration.sql` could `TRUNCATE`/`ALTER` core tables in a dev or misconfigured environment. Production compose requires the variable (`:?`), so prod is protected — but the silent superuser fallback should be replaced with a hard failure when the restricted URL is missing.

**Finding M-03 (Medium):** `pluginRateLimiter` uses a custom `keyGenerator` returning `` `${req.ip}-${pluginId}` `` without the `ipKeyGenerator` helper (`middleware.ts:39-42`). `express-rate-limit` v8 raises `ERR_ERL_KEY_GEN_IPV6` at boot (observed in logs) and IPv6 clients can rotate within a /64 to bypass the 100 req/min limit. Wrap the IP with `ipKeyGenerator`.

- CSP: plugin iframes are same-origin behind nginx; existing `frame-src 'self' blob:` already covers them — no CSP weakening introduced.

---

## A06 — Vulnerable & Outdated Components ✅ PASS

- No new npm dependencies introduced; the engine reuses `multer`, `express-rate-limit`, `jsonwebtoken`, `node-cron`, `zod`, all already in the tree.
- **Supply-chain note (NIS2):** plugins are, by definition, third-party code. The signature + checksum + checklist + 4-eyes gate is the supply-chain control. Each plugin is independently disableable (`deactivate`) without redeploying the platform.

---

## A07 — Identification & Authentication Failures ⚠️ OBSERVATION

- All endpoints behind the existing JWT chain; no new auth primitive.
- **Observation:** the 4-eyes `approvalToken` is just another ADMIN's session JWT (`router.ts:486-500`). It carries no `purpose: "plugin-approval"` scope or per-activation nonce, so any valid second-admin session token authorizes any activation and is replayable for the token's lifetime. Acceptable for a first cut, but a dedicated short-lived approval token bound to `{pluginId, action}` would be stronger. Tracked as L-09 (enhancement).

---

## A08 — Software & Data Integrity Failures ⚠️ FINDINGS

**Strengths:** magic-byte validation (gzip `1f8b` / zip `504b`) after the multer ext filter (`engine.ts:242-262`); symlink rejection via `lstatSync`; UUID-named staging files; SHA-256 checksum recomputed at validate; optional Ed25519 signature; `execFile`-only extraction.

**Findings:**
- **Signature is optional** (`schemas.ts:44`, `manifest.signature` optional). An unsigned plugin passes validate when no signature is declared. For a high-assurance posture, require a signature in production (config flag) and reject unsigned bundles.
- **M-01** (see A03) weakens the DDL integrity control.
- **L-07:** `.tar.gz`/`.tgz` are accepted by the ext filter and gzip magic bytes, but every extraction path uses `unzip` (`router.ts:83,94,104`). A `.tar.gz` upload passes upload+validate then **fails at install**. Either reject non-zip at upload or add a tar path.

---

## A09 — Security Logging & Monitoring ✅ PASS

- `pluginAudit()` writes an insert-only `audit_logs` row for every state change: `PLUGIN_UPLOADED`, `PLUGIN_VALIDATED`/`_VALIDATION_FAILED`, `PLUGIN_INSTALLED`, `PLUGIN_ACTIVATED`, `PLUGIN_DEACTIVATED`, `PLUGIN_UNINSTALLED`, `PLUGIN_CONFIG_UPDATED`, `PLUGIN_ERROR` (`audit.ts`, used throughout `router.ts`). Uses a tagged-template `$executeRaw` — no concatenation.
- **Finding L-06:** reactivation-failure audit logs with `entity_id = plugin.pluginId` (kebab string) (`index.ts:102`), whereas every other audit + the `GET /:id/logs` query keys on `plugin.id` (UUID) (`router.ts:726`). Boot-time reactivation errors will not surface in the plugin's log viewer. Normalize to the UUID.

---

## A10 — Server-Side Request Forgery ✅ PASS

- The only outbound HTTP from plugin code is `safeFetch`, which rejects any origin not in `manifest.allowedHosts` (`engine.ts:50-57`) — SSRF allowlist enforced inside the frozen context.
- The marketplace proxy fetches `${PLUGIN_MARKETPLACE_URL}/api/plugins` from an **env-configured** URL with a 10 s `AbortController` timeout (`router.ts:166-184`); the caller never supplies the URL.

---

## Compliance cross-references

- **ISO 27001 A.8.15 (logging):** audit insert-only — PASS (L-06 to fix for completeness).
- **ISO 27001 A.8.25/8.28 (secure SDLC):** admission gate + signed bundles — PASS; harden M-01.
- **ISO 27001 A.8.12 (data-leakage):** secrets from env; no PII in plugin logs — PASS; close L-02.
- **GDPR:** plugins touching PII must be flagged in review (checklist); `dataRetention` + JSON backup enable erasure. No PII in hook payloads (login hook passes `userId/role/email` only — see note for `email`).
- **NIS2 (supply chain):** signature + per-plugin disable + documented data flows — PASS; M-02 superuser fallback is the priority remediation for availability/integrity.

---

## Remediation priority

| ID | Sev | Control | Action |
|----|-----|---------|--------|
| M-02 | Medium | A05/A08 | Replace superuser fallback with hard failure when `PLUGIN_DATABASE_URL` unset; document `cmdb_plugin` role as mandatory. |
| M-01 | Medium | A03/A08 | Rewrite `validateMigrationSql` to reject **all** TRUNCATE/DELETE/ALTER/DROP on non-`plg_` objects, not only `DROP TABLE`. |
| M-03 | Medium | A05 | Wrap `req.ip` with `ipKeyGenerator` in `pluginRateLimiter`. |
| L-02 | Low | A02 | Add `PLUGIN_SIGNING_PUBLIC_KEY` to env templates. |
| L-06 | Low | A09 | Use `plugin.id` (UUID) for reactivation audit `entity_id`. |
| L-07 | Low | A08 | Reject non-zip at upload, or implement tar extraction. |
| L-09 | Low | A07 | Scope/nonce-bind the 4-eyes `approvalToken`. |

*Functional gaps H-01…H-04 are tracked in `docs/BACKLOG_v2.8.0.md`.*
