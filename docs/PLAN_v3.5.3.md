# vCenter Connector Implementation Plan — v3.5.3

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Phase 1 (this document) authored by Opus — design only, no code, no commits.** Phase 2 execution runs on Sonnet.

**Goal:** Unidirectional sync (vCenter → CMDB) that automatically reconciles vCenter VMs into the CMDB as `VIRTUAL_SERVER` CIs, orchestrated by an n8n scheduled workflow, extensible to future hypervisor connectors (OLVM, Solaris).

**Architecture:** A generic connector pattern (`BaseConnector` → `VCenterConnector` + `VCenterClient` + `VCenterMapper`) inside `backend/src/modules/integrations/connectors/`. A shared `runVCenterSync()` service is invoked by two thin routes: an **ADMIN JWT** route (`/api/integrations/vcenter/*`, UI-facing) and an **M2M service-token** route (`/api/internal/vcenter/sync`, n8n-facing). n8n schedules the sync via a code-provisioned workflow template. **No new config table and no credential encryption module** — all config/secrets come from env vars (house pattern); VM power-state + vCenter metadata persist in a single additive `vcenter_sync` JSONB column on `configuration_items`, mirroring the existing `vulnerabilities` (Greenbone) and `agent_status` (CrowdStrike) integration columns.

**Tech Stack:** Node 22, Express 5, Prisma 6, PostgreSQL 16, undici (Node built-in, self-signed TLS via `Agent` dispatcher), n8n 1.123.x (Queue Mode), Next.js 16 / React 19, Tailwind 4.

---

## Design Decisions (resolved with the user — these OVERRIDE the original spec)

| # | Decision | Rationale / spec deviation |
|---|----------|---------------------------|
| **D1** | **Credentials & config from env vars only. No `integration_configs` table, no AES module.** | Original spec asked for AES-256 in DB. CLAUDE.md marks "secrets from env vars, never hardcoded" as non-negotiable (ISO 27001 A.8.12); no crypto pattern exists in the codebase (LDAP/SMTP/n8n all use env). UI panel = status + Test + Sync-now only (no credential form fields). |
| **D2** | **Never overwrite CI `status` from `power_state`.** New VMs are created `ACTIVO`; `status` is operator-owned lifecycle thereafter. Real power state persists separately in `vcenter_sync.powerState`. A VM absent from vCenter → `RETIRADO`. | Spec conflated power state with lifecycle status. `CIStatus` = `ACTIVO / INACTIVO / RETIRADO` is a governance field; overwriting it each sync would strip operator control and confuse "powered off" with "decommissioned". |
| **D3** | **n8n workflow shipped as a code template** in `n8n-provisioning/workflows.ts`, auto-provisioned on-boot + via the existing resync button, using the already-provisioned `httpHeaderAuth` (`X-CMDB-Service-Token`) credential. | Canonical pattern since v3.2.0 (".env single source of truth"). Spec's standalone importable JSON is the pre-v3.2.0 pattern. |
| **D4** (derived) | **Zero config-schema changes.** Sync history goes to `audit_logs` (`action='SYNC_VCENTER'`), exactly as Greenbone/CrowdStrike already do — no `sync_logs` table. One tiny additive migration adds `vcenter_sync jsonb` to `configuration_items`. | Follows D1 + the established integration-column pattern on `CI`. Keeps RTO low (ISO 22301): feature adds no relational schema. |
| **D5** (field ownership) | **vCenter owns physical facts; operator owns governance.** Sync writes/refreshes `vCpus`, `ram`, `adminIp`, `hostName`, `clusterName`, `operatingSystem`, and `vcenter_sync`. Sync **never** touches `status`, `criticality`, `environment`, `businessOwner`, `technicalLead`, or any NIS2/GDPR governance field after create. | Prevents the sync from clobbering human-curated data every run. |

---

## Global Constraints (verbatim from CLAUDE.md — every task inherits these)

- **Secrets from env vars only.** Never in source, logs, or API responses. Never log `VCENTER_PASSWORD`.
- **A03 Injection:** all DB access via Prisma tagged template literals; no `$queryRawUnsafe`, no string concatenation. LIKE escapes `%`, `_`, `\` with `ESCAPE '\\'`.
- **A01 Access control:** every UI route guarded by `authenticateToken` + `requireAdmin` (config/test/sync) or `requireAudit` (read log/status). Internal route guarded by `X-CMDB-Service-Token` (`timingSafeEqual`).
- **A09 Logging:** every write (VM create/update/retire, sync run) inserts an `audit_logs` record. `audit_logs` is insert-only.
- **A10 SSRF:** the outbound host is `VCENTER_URL` from env (operator-controlled, not caller-supplied). Never accept a caller-supplied vCenter URL in a request body.
- **A02/TLS:** `rejectUnauthorized` defaults to `false` **only** when `VCENTER_SSL_VERIFY !== 'true'`; document the self-signed risk; support an optional CA via `VCENTER_CA_CERT` path.
- **i18n:** all new UI strings via `t("key")`; every new key added to all 6 locale files (`en, es, de, pt, fr, it`).
- **Modules:** new feature code lives in `backend/src/modules/…`; do **not** grow `index.ts`.
- **Migrations:** manual timestamped `migration.sql` with `IF NOT EXISTS`; apply via `prisma migrate deploy`. Never `migrate dev` in Docker.
- **TS gate:** `npx tsc --noEmit` — 0 new errors (ignore pre-existing `license` / `licenseUser`).
- **Commits:** Conventional Commits. Branch `feature/v3.5.3-vcenter-connector` off `develop`. **No merge to `main`.**

---

## Environment Variables (new — declare in both compose files, `install.sh`, `update.sh` check lists)

| Var | Default | Purpose |
|-----|---------|---------|
| `VCENTER_URL` | *(empty)* | Base URL, e.g. `https://vcenter.local`. Empty ⇒ connector disabled (no provisioning, endpoints 409). |
| `VCENTER_USER` | *(empty)* | vCenter username (Basic auth for `POST /api/session`). |
| `VCENTER_PASSWORD` | *(empty)* | vCenter password. **Never logged.** |
| `VCENTER_SSL_VERIFY` | `false` | `true` enforces cert validation. `false` ⇒ accept self-signed (documented risk). |
| `VCENTER_CA_CERT` | *(empty)* | Optional path to a CA PEM to validate a self-signed cert properly. |
| `VCENTER_SYNC_ENABLED` | `false` | Master gate for scheduled sync provisioning + `/sync` endpoints. |
| `VCENTER_CI_TYPE` | `VIRTUAL_SERVER` | Target CIType code for new VMs (already seeded, `isSystem=true`). |
| `VCENTER_DEFAULT_ENVIRONMENT` | `PRODUCTION` | Required enum default for new VMs (vCenter doesn't supply it). |
| `VCENTER_DEFAULT_CRITICALITY` | `MEDIUM` | Required enum default for new VMs. |
| `VCENTER_SYNC_CRON` | `0 */6 * * *` | Schedule for the n8n workflow (every 6h). |

Reuses existing: `CMDB_SERVICE_TOKEN` (n8n→backend M2M), `N8N_INTERNAL_URL`.

---

## File Structure

```
backend/prisma/migrations/<ts>_ci_vcenter_sync_column/migration.sql   # + vcenter_sync jsonb (IF NOT EXISTS)
backend/prisma/schema.prisma                                          # + vcenterSync Json? on CI
backend/src/modules/integrations/
├── connectors/
│   ├── base/BaseConnector.ts        # abstract: connect(), discover(), close()
│   ├── vcenter/VCenterClient.ts     # HTTP (undici Agent, session token, self-signed)
│   ├── vcenter/VCenterConnector.ts  # implements BaseConnector for vCenter
│   └── vcenter/VCenterMapper.ts     # vCenter VM → CI upsert payload (pure, unit-tested)
├── connectors/types.ts              # DiscoveredVM, ConnectorConfig, SyncResult, IHypervisorConnector
├── vcenterConfig.ts                 # reads + validates env → typed config (no secrets in returns to client)
├── vcenterService.ts                # runVCenterSync(): orchestration (create/update/retire/lock/audit)
├── router.ts                        # (extend) ADMIN routes: /vcenter/status|test|sync|sync-log
└── __tests__/vcenter.*.test.ts
backend/src/modules/internal/
├── vcenter.ts                       # M2M route: POST /internal/vcenter/sync (service token)
└── router.ts                        # (extend) mount vcenter internal route
backend/src/modules/n8n-provisioning/
├── workflows.ts                     # (extend) vcenter-sync template + ActivateWhen 'vcenter'
├── config.ts                        # (extend) cfg.vcenter { enabled, cron, internalUrl }
└── templates/                       # (add) vcenter-sync workflow JSON template
frontend/app/settings/page.tsx       # (extend) Integraciones tab → vCenter card
frontend/components/settings/VCenterCard.tsx          # status + test + sync-now + log table
frontend/components/settings/SyncLogTable.tsx
frontend/lib/hooks/useVCenterStatus.ts / useSyncNow.ts / useSyncLog.ts
frontend/locales/{en,es,de,pt,fr,it}.json            # + integrations.vcenter.* keys
docs/INTEGRATIONS.md                 # new: connector architecture + vCenter runbook
docs/EXECUTION_LOG.md / docs/PLAN_STATUS_v3.5.3.md    # progress tracking
```

---

## Corrected field mapping (vCenter VM → CI)

| vCenter source | CI target | Transform | Written on |
|---|---|---|---|
| `vm` (MoRef) | `apiSlug` = `vm-{moref}` | idempotent unique match key | create only |
| `name` | `name` | direct | create + update |
| `cpu_count` | `vCpus` | int | create + update |
| `memory_size_MiB` | `ram` | `Math.round(MiB/1024) + " GB"` | create + update |
| `guest_OS` / `guest.family` | `operatingSystemId` | upsert `OperatingSystem` by derived `code`; link | create + update *(only if resolvable; never null-out an existing OS)* |
| `guest/identity.ip_address` | `adminIp` | direct (nullable) | create + update |
| `guest/identity.host_name` | `hostName` | direct (nullable) | create + update |
| `cluster` | `clusterName` | direct (nullable) | create + update |
| `power_state` | `vcenter_sync.powerState` | `POWERED_ON`/`POWERED_OFF`/`SUSPENDED` | create + update |
| ESXi `host` | `vcenter_sync.esxiHost` + best-effort `HOSTS` relation (ESXi PHYSICAL_SERVER → VM) | only if ESXi CI already exists; never fail sync | create + update |
| — | `status` | `ACTIVO` | **create only** (D2) |
| — | `criticality` / `environment` | `VCENTER_DEFAULT_*` | **create only** (D5) |

`vcenter_sync` JSON shape: `{ moref, powerState, esxiHost, cluster, lastSyncAt }`.

---

## Sync algorithm (`runVCenterSync`)

```
acquire in-process lock (module boolean + startedAt); if held → return 409 { error: 'SYNC_IN_PROGRESS' }
try:
  connector = new VCenterConnector(vcenterConfig())
  await connector.connect()                       // POST /api/session → token
  vms = await connector.discover()                // list + per-VM guest/identity + hardware
  seenSlugs = new Set()
  for vm of vms:
    slug = `vm-${vm.moref}`; seenSlugs.add(slug)
    payload = VCenterMapper.toCI(vm, defaults)
    existing = prisma.cI.findUnique({ where: { apiSlug: slug } })
    if existing: update ONLY D5-owned fields + vcenter_sync → updated++
    else:        create with status ACTIVO + defaults + vcenter_sync → created++
    audit CI_UPDATE / CI_CREATE (entity 'CI')
  // retire VMs that vanished from vCenter (only those we own = have vcenter_sync + VCENTER_CI_TYPE + status != RETIRADO)
  orphans = prisma.cI where ciType=VCENTER_CI_TYPE AND vcenter_sync IS NOT NULL AND apiSlug NOT IN seenSlugs AND status != RETIRADO
  for o of orphans: set status=RETIRADO; audit CI_RETIRE → retired++
finally:
  await connector.close()                         // DELETE /api/session (best-effort)
  release lock
audit SYNC_VCENTER with { created, updated, retired, errors, durationMs }  // history source (D4)
return { status: errors ? 'PARTIAL' : 'SUCCESS', created, updated, retired, errors }
```

**Lock note:** single backend container ⇒ in-process boolean is sufficient. If backend is ever scaled horizontally, upgrade to a Redis `SET NX EX` lock (Redis already in stack). Documented, not implemented now.

---

## REST endpoints

| Method | Route | Auth | Purpose |
|---|---|---|---|
| GET | `/api/integrations/vcenter/status` | ADMIN/AUDITOR | `{ configured, url(host only), sslVerify, syncEnabled, lastSync }` — **no secrets** |
| POST | `/api/integrations/vcenter/test` | ADMIN | session create+delete against vCenter; `{ ok, message }` |
| POST | `/api/integrations/vcenter/sync` | ADMIN | manual sync (UI "Sync now") → `SyncResult` |
| GET | `/api/integrations/vcenter/sync-log` | ADMIN/AUDITOR | last N `SYNC_VCENTER` audit rows (parsed counts) |
| POST | `/api/internal/vcenter/sync` | Service token | n8n scheduled trigger → same `runVCenterSync()` |

---

## Tasks

### Task A — Migration + schema: `vcenter_sync` column
**Files:** `backend/prisma/migrations/<ts>_ci_vcenter_sync_column/migration.sql`, `backend/prisma/schema.prisma:CI`
- [ ] Write `migration.sql`: `ALTER TABLE "configuration_items" ADD COLUMN IF NOT EXISTS "vcenter_sync" jsonb;`
- [ ] Add `vcenterSync Json? @map("vcenter_sync")` to `model CI`.
- [ ] `prisma migrate deploy` + `prisma generate` in the backend container.
- [ ] Verify column exists (`\d configuration_items`). Commit `feat(db): add vcenter_sync column to CI`.

### Task B — Connector core (types, base, client, mapper)
**Files:** `connectors/types.ts`, `connectors/base/BaseConnector.ts`, `connectors/vcenter/VCenterClient.ts`, `connectors/vcenter/VCenterMapper.ts`, `vcenterConfig.ts`, tests.
- [ ] `types.ts`: `IHypervisorConnector { connect(); discover(): Promise<DiscoveredVM[]>; close() }`, `DiscoveredVM`, `SyncResult`.
- [ ] `vcenterConfig.ts`: read/validate env → typed config; `toPublic()` strips user/password.
- [ ] `VCenterClient.ts`: undici `Agent({ connect: { rejectUnauthorized } })` dispatcher; `session()` (Basic → token, header `vmware-api-session-id`); `listVMs()`, `vmGuest(id)`, `vmDetail(id)`; `logout()`. **Never log credentials.**
- [ ] `VCenterMapper.ts` (pure): `toCI(vm, defaults)` → create/update payloads per the mapping table. **Unit-test this first (TDD)** with fixture VMs (powered on/off, missing guest ip, unknown OS).
- [ ] `VCenterConnector.ts`: orchestrates client calls into `DiscoveredVM[]`.
- [ ] Commit per file group with failing-test-first cycle.

### Task C — Sync service + routes (ADMIN + internal)
**Files:** `vcenterService.ts`, `integrations/router.ts`, `internal/vcenter.ts`, `internal/router.ts`, `index.ts` (mount already exists), tests.
- [ ] `vcenterService.ts`: `runVCenterSync()` per the algorithm (lock, upsert D5 fields, retire orphans, audit). Inject `prisma` + `queueForIndexing` (RAG re-index created/updated CIs, matching integrations module convention).
- [ ] Extend `integrations/router.ts`: `status`, `test`, `sync`, `sync-log` (guards per table). Reuse `flattenCI`-style shaping only where needed; responses expose host-only URL, never creds.
- [ ] `internal/vcenter.ts`: `POST /vcenter/sync` calling `runVCenterSync()`; mount in `internal/router.ts`.
- [ ] Tests (jest+supertest): 401/403 matrix, `409 SYNC_IN_PROGRESS`, create/update/retire against a mocked `VCenterConnector`, audit row asserted.
- [ ] `tsc --noEmit` clean. Commit.

### Task D — n8n workflow template (code-provisioned)
**Files:** `n8n-provisioning/config.ts`, `workflows.ts`, `templates/vcenter-sync.json`.
- [ ] Extend `config.ts` with `vcenter { enabled, cron, internalUrl }` from env.
- [ ] Extend `ActivateWhen` union with `'vcenter'`; `renderWorkflows` includes the vCenter template when `cfg.vcenter.enabled`.
- [ ] Template: Schedule Trigger (`VCENTER_SYNC_CRON`) → HTTP Request `POST {N8N_INTERNAL_URL→backend}/api/internal/vcenter/sync` with `httpHeaderAuth` (`X-CMDB-Service-Token`) → IF `status==200` → NoOp; else → existing notify path.
- [ ] Verify provisioning creates + activates the workflow (resync button / onBoot). Commit.

### Task E — Frontend vCenter card
**Files:** `frontend/app/settings/page.tsx`, `components/settings/VCenterCard.tsx`, `SyncLogTable.tsx`, hooks, 6 locale files.
- [ ] `VCenterCard.tsx` in the Integraciones tab: status badge (configured / not-configured / error), **Test connection** button (spinner + result), **Sync now** button (ADMIN only), last-sync "hace X min" badge.
- [ ] `SyncLogTable.tsx`: date, status, created, updated, retired, errors (from `/sync-log`).
- [ ] Hooks `useVCenterStatus`, `useSyncNow`, `useSyncLog` via `apiFetch`.
- [ ] Add all `integrations.vcenter.*` keys (spec list) to all 6 locales. Follow the canonical house pattern (`ring-1 ring-slate-200`, `rounded-none`, accent button).
- [ ] Rebuild frontend (build-time env), verify UI. Commit.

### Task F — Compose/install wiring, docs, verification
**Files:** `docker-compose.yml`, `docker-compose.prod.yml`, `install.sh`, `update.sh`, `docs/*`.
- [ ] Declare the new `VCENTER_*` vars in both compose files (backend service env) and `update.sh` `check_new_env_vars`.
- [ ] `docs/INTEGRATIONS.md`: connector architecture, env reference, self-signed risk note, manual test against a real vCenter, how to add a future connector.
- [ ] Update `docs/ARCHITECTURE.md` (+ `.en`), `docs/USER_MANUAL.md` (+ `.en`), `CLAUDE.md` (connector pattern + D1–D5), `docs/PLAN_STATUS_v3.5.3.md`, `docs/EXECUTION_LOG.md`.
- [ ] Full verify: `podman compose up -d --build`; `curl -sk https://localhost/api/health`; `test` endpoint against a reachable vCenter (or documented mock); smoke the UI card; `tsc --noEmit` clean.

---

## Testing strategy

- **Unit (no I/O):** `VCenterMapper` — the highest-value tests; cover powered-off, suspended, missing guest IP, unknown/blank `guest_OS`, MiB→GB rounding.
- **Integration (mocked client):** `runVCenterSync` create/update/retire + lock 409 + audit assertions, injecting a fake `IHypervisorConnector`.
- **Endpoint (supertest):** auth matrix (VIEWER 403, AUDITOR read-only, ADMIN full), no-secrets-in-`status`.
- **Manual (real vCenter):** documented in `INTEGRATIONS.md` — no live vCenter in CI, so the self-signed path is validated manually and via a unit test on the undici Agent options.

## Open risks / things to confirm during execution
1. **vSphere API shape** across versions (7.x vs 8.x): `GET /api/vcenter/vm` field names (`memory_size_MiB`, `cpu_count`) are stable in 7.0U2+; guard for absent `guest/identity` (VMware Tools not running) → nullable ip/hostname.
2. **OS code derivation** from `guest_OS` (e.g. `RHEL_9_64`, `WINDOWS_SERVER_2022`): mapper produces a normalized `code`+`name`; never null out an existing OS on update.
3. **Retirement blast radius:** the orphan query is fenced to `ciType=VCENTER_CI_TYPE AND vcenter_sync IS NOT NULL` so it can only ever retire CIs this connector created — it can never touch manually-entered VMs.
