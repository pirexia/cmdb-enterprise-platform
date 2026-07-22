# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Testing Credentials — Use These Always

**Never attempt to log in as `admin@cmdb.local` or any ADMIN user.** Admin role enforces mandatory MFA setup on first login, which requires interactive TOTP enrollment — you cannot complete it programmatically. Doing so wastes tokens and time.

Use the dedicated Claude test account instead:

| Field    | Value                  |
|----------|------------------------|
| Email    | `claude@cmdb.local`    |
| Password | `Claude@Test24!`       |
| Role     | `AUDITOR`              |
| MFA      | Disabled (never required for non-ADMIN roles) |

```bash
# Obtain a session token (returns JWT + sets HttpOnly cookie)
curl -sk -c /tmp/cmdb_cookies.txt -X POST https://localhost/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"claude@cmdb.local","password":"Claude@Test24!"}'

# Use the token in subsequent API calls
TOKEN=$(curl -sk -X POST https://localhost/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"claude@cmdb.local","password":"Claude@Test24!"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

curl -sk -H "Authorization: Bearer $TOKEN" https://localhost/api/health
```

The `requireAction: "MFA_SETUP_SUGGESTED"` in the login response is a suggestion only — the token is fully valid.

### Testing ADMIN-only flows — temporary MFA-enabled admin

The AUDITOR account above cannot exercise `requireAdmin` / `requireAdminRole` routes or ADMIN-only UI. **Do NOT add an MFA bypass to the code** (that is a backdoor — violates A07 / ISO 27001 and is dangerous if it reaches prod). Instead, seed a **temporary ADMIN whose MFA is genuinely enabled with a TOTP secret you generate**: it is fully MFA-compliant, but you can compute its login codes with `otplib` (the same library the server validates with — `index.ts` → `authenticator.check`), so codes always match. No interactive enrollment, no code changes.

**1. Seed the test admin** (run inside the backend container — it has `otplib` + `bcrypt` + Prisma; prod container is `cmdb-backend-prod`, dev is `cmdb-backend`):

```bash
cat > /tmp/seed_admin.js <<'EOF'
const { authenticator } = require('otplib');
const bcrypt = require('bcrypt');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const email  = 'claude-admin@cmdb.local';
  const secret = authenticator.generateSecret();           // base32, otplib-native
  const hash   = await bcrypt.hash('ClaudeAdmin#Test2026!', 12);
  await prisma.user.upsert({
    where:  { email },
    update: { password: hash, role: 'ADMIN', active: true, mfaEnabled: true, mfaSecret: secret, mfaPendingSecret: null },
    create: { username: 'claude-admin', email, password: hash, role: 'ADMIN', active: true, mfaEnabled: true, mfaSecret: secret },
  });
  console.log('SECRET=' + secret);                          // SAVE THIS — needed to compute login codes
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
EOF
podman cp /tmp/seed_admin.js cmdb-backend-prod:/app/seed_admin.js \
  && podman exec -w /app cmdb-backend-prod node seed_admin.js \
  && podman exec cmdb-backend-prod rm /app/seed_admin.js && rm -f /tmp/seed_admin.js
```

**2. Log in** — compute the current TOTP with `otplib` in the container, then POST it as `mfaCode`:

```bash
SECRET=<value printed in step 1>
CODE=$(podman exec cmdb-backend-prod node -e "console.log(require('otplib').authenticator.generate('$SECRET'))")
TOKEN=$(curl -sk -X POST https://localhost/api/auth/login -H 'Content-Type: application/json' \
  -d "{\"email\":\"claude-admin@cmdb.local\",\"password\":\"ClaudeAdmin#Test2026!\",\"mfaCode\":\"$CODE\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
curl -sk -H "Authorization: Bearer $TOKEN" https://localhost/api/health
```

Login MFA path (`index.ts`): when `user.mfa_enabled && user.mfa_secret`, login returns `401 {"error":"MFA_REQUIRED"}` without a code and validates `mfaCode` via `authenticator.check`. For browser/Playwright e2e, the login UI shows an `inputmode=numeric` code field — fill it with a freshly computed code (the code rotates every 30 s, so generate it right before use).

**3. Delete it when done.** This is a standing ADMIN whose password + TOTP secret end up in your logs — remove the account (and any test data you created) after testing:

```bash
podman exec cmdb-postgres-prod psql -U admin -d cmdb_db -c "DELETE FROM users WHERE email='claude-admin@cmdb.local';"
```

---

## Work Methodology — Follow This Before Every Task

### 1. Always Plan First

**Before touching any code**, create a written plan. Use the `superpowers:writing-plans` skill for any multi-step task. No exceptions.

- Decompose every mission into the smallest independent micro-tasks possible.
- Each micro-task must have a single, verifiable outcome (one file changed, one endpoint added, one test passing).
- Identify which tasks can run in parallel and which have sequential dependencies.
- Write the plan as a checklist and track progress with `TaskCreate` / `TaskUpdate`.

### 2. Parallelize with Subagents

Dispatch independent micro-tasks to subagents (`Agent` tool) whenever possible:

- Use `superpowers:dispatching-parallel-agents` for 2+ independent tasks.
- Use `superpowers:subagent-driven-development` when executing a written plan in the current session.
- Use `superpowers:executing-plans` to execute a plan in a fresh session with review checkpoints.
- Never do sequentially what can be done in parallel.

### 3. Always Use Available Skills

**Check for a matching skill before starting any implementation.** Skills in `.claude/skills/` take precedence over ad-hoc approaches.

| Trigger | Skill to invoke |
|---------|----------------|
| Any security concern, new endpoint, auth change | `vibesec-skill` |
| Bug, test failure, unexpected behaviour | `superpowers:systematic-debugging` |
| New feature / component / behaviour | `superpowers:brainstorming` → `superpowers:writing-plans` |
| Multi-step implementation | `superpowers:executing-plans` or `superpowers:subagent-driven-development` |
| Schema design, indexes, Postgres query | `supabase-postgres-best-practices` |
| New UI page or component refactor | `frontend-design` + `vercel-react-best-practices` |
| Pre-release review | `find-bugs` + `differential-review` |
| Documentation (manuals, compliance reports) | `documentation-writer` |
| Post-ship doc update | `autoship` |
| ReactFlow node component | `react-flow-node-ts` |
| Failing GitHub Actions checks | `gh-fix-ci` |
| About to claim work is done | `superpowers:verification-before-completion` |
| About to merge / finish a branch | `superpowers:finishing-a-development-branch` |
| Writing code with tests-first discipline | `superpowers:test-driven-development` |
| Requesting a review of your own changes | `superpowers:requesting-code-review` |
| Acting on review feedback you received | `superpowers:receiving-code-review` |
| Isolating parallel work in a separate checkout | `superpowers:using-git-worktrees` |
| Authoring or editing a skill in `.claude/skills/` | `superpowers:writing-skills` |
| Unsure which superpowers skill applies | `superpowers:using-superpowers` |

When in doubt, invoke `find-skills` — it searches for a skill by description.

---

## Security & Compliance Directives — Non-Negotiable

Every feature, fix, refactor, and configuration change **must** satisfy all of the following. These are not guidelines — they are acceptance criteria.

### OWASP Top 10 (2021)

| # | Risk | Requirement in this codebase |
|---|------|------------------------------|
| A01 | Broken Access Control | Every route must verify role via `requireAdmin` or `requireAudit`; ownership checks on CIs/documents must use DB-level filters, not post-fetch filtering |
| A02 | Cryptographic Failures | Passwords: bcrypt (rounds ≥ 12). JWT: HS256 with secret ≥ 32 bytes, stored in HttpOnly cookie. TLS 1.2+ enforced at nginx. No secrets in source code or logs |
| A03 | Injection | All DB access via Prisma tagged template literals. LIKE queries must escape `%`, `_`, `\`. LDAP input must pass `escapeLdap()`. File paths must use `path.join` with allowlisted base dirs |
| A04 | Insecure Design | Threat-model new features before implementation. Use the `vibesec-skill` on every new endpoint |
| A05 | Security Misconfiguration | CSP set in nginx + Next.js. nginx strips `Server` / `X-Powered-By`. `helmet` on all Express responses. No debug endpoints in production |
| A06 | Vulnerable Components | Do not introduce dependencies with known CVEs. Run `npm audit` after adding packages |
| A07 | Auth & Session Failures | JWT in HttpOnly cookie, SameSite=Strict. ADMIN MFA mandatory. Trusted-device tokens expire. Rate-limiting on `/api/auth/login` |
| A08 | Software & Data Integrity | File uploads validated by magic bytes + UUID filenames. CSR uses `execFile`, not `exec`. No `eval` or `Function()` |
| A09 | Logging & Monitoring Failures | Every write must produce an `AuditLog` record. Errors logged internally; never exposed in API response bodies |
| A10 | SSRF | External HTTP calls (endoflife.date, JWKS endpoint) must use an allowlist; never accept caller-supplied URLs for outbound requests |

### ISO 27001:2022

- Every data-modifying operation must be logged in `AuditLog` with `action`, `entity`, `entity_id`, `user_email` (A.8.15 — Logging).
- `AuditLog` records are insert-only — no UI path may update or delete them (A.8.15 — Log protection).
- Access control changes (user creation, role change, erasure) require audit records (A.9.2 — User access management).
- Sensitive config (JWT secret, DB credentials, SMTP password) must come from environment variables — never hardcoded (A.8.12 — Data leakage prevention).
- New integrations must document their data flows before implementation (A.5.37 — Documented operating procedures).

### GDPR (EU 2016/679)

- Personal data fields: `email`, `username`, `ssoExternalId`. Any new PII field must be documented and included in the erasure endpoint (`DELETE /api/users/:id/erase`).
- Data minimisation: collect only what is strictly necessary for the feature.
- No personal data in logs — use user IDs, not names/emails, in structured log messages.
- Data subject requests (access, erasure, portability) must be completable via existing API endpoints — do not add manual workarounds.
- Privacy-by-design: run a DPIA impact check for any feature that introduces new personal data processing.

### NIS2 (EU 2022/2555)

- Significant incidents must be reportable within 24h (initial) / 72h (detailed) — do not design audit or logging in a way that prevents this.
- New integrations with third-party services count as supply-chain risk — document them and ensure they can be disabled independently.
- Availability measures: new features must not introduce single points of failure or unbounded resource consumption.

### ISO 22301:2019 (Business Continuity)

- Do not remove or weaken DB backup mechanisms (`pg_dump` workflow in sysadmin docs).
- New stateful services (caches, queues) must have a documented recovery procedure before merging.
- RTO target: application restartable in < 15 min from a clean Docker pull. Do not introduce start-up dependencies that break this.
- Changes to infrastructure (Docker images, nginx config, TLS) must be tested in dev compose before prod.

---

## Environment & Commands

**This server has a single environment: production.** There is no separate dev stack — `docker-compose.prod.yml` is the only compose file, and it is what you develop against. Container engine is **podman** (via `podman-compose`, rootless — no `docker`/`sg docker` group needed on this host). Never run `npm install` or `npx prisma` directly on the host — always through the container or via `podman exec`.

**Always pass `-f docker-compose.prod.yml` explicitly on every compose command.** Omitting `-f` lets podman-compose fall back to directory-derived project naming, which is unsafe to rely on — see the pod-naming note below.

```bash
# Start / rebuild all containers
podman-compose -f docker-compose.prod.yml down && podman-compose -f docker-compose.prod.yml up -d --build

# Apply schema changes (run inside backend container)
podman exec cmdb-backend-prod npx prisma migrate deploy

# Generate Prisma client after schema edits
podman exec cmdb-backend-prod npx prisma generate

# TypeScript check (pre-commit gate — must pass with 0 new errors)
cd backend && npx tsc --noEmit

# Backend container shell
podman exec -it cmdb-backend-prod sh

# PostgreSQL shell (user/db come from .env — defaults shown)
podman exec -it cmdb-postgres-prod psql -U admin -d cmdb_db

# DB backup
podman exec cmdb-postgres-prod pg_dump -U admin cmdb_db > backup_$(date +%F).sql

# Run a Node.js script inside the backend container (for DB operations needing bcrypt/Prisma)
# Copy script to /app/ so node_modules are in scope
podman cp /tmp/myscript.js cmdb-backend-prod:/app/myscript.js && podman exec -w /app cmdb-backend-prod node myscript.js && podman exec cmdb-backend-prod rm /app/myscript.js
```

**Pod-naming note (root cause of a near-miss during the v3.5.6 release, fixed in v3.5.7):** `docker-compose.prod.yml` declares a top-level `name: cmdb-prod` so its podman-compose project/pod name is deterministic, never derived from the working directory. Do not remove that `name:` key, and never invoke `podman-compose` for this project without `-f docker-compose.prod.yml` — a bare `down`/`up` with no `-f` (or a stray second compose file reintroduced later) risks resolving to the same pod as production.

**Known pre-existing TypeScript errors** (ignore in `tsc` output, do not fix):
- `Property 'license' does not exist on type 'PrismaClient'`
- `Property 'licenseUser' does not exist on type 'PrismaClient'`

These are caused by a Prisma client generation mismatch inside Docker; they do not affect the running application.

---

## Technology Stack

### Runtime & Framework Versions

| Layer       | Technology          | Version    |
|-------------|---------------------|------------|
| **Runtime** | Node.js             | 22.x (LTS) |
| **Backend** | Express             | ^5.2.1     |
| **Backend** | TypeScript          | ^5.3.3     |
| **Backend** | Prisma ORM          | ^6.x       |
| **Backend** | Zod                 | ^3.24.2    |
| **Backend** | jsonwebtoken        | ^9.0.3     |
| **Backend** | bcrypt              | ^6.0.0     |
| **Backend** | otplib (TOTP MFA)   | ^12.0.1    |
| **Backend** | helmet              | ^8.1.0     |
| **Backend** | express-rate-limit  | ^8.0.0     |
| **Backend** | multer              | ^2.1.1     |
| **Backend** | cookie-parser       | ^1.4.7     |
| **Backend** | nodemailer          | ^8.0.5     |
| **Backend** | node-cron           | ^4.2.1     |
| **Backend** | ldap-authentication | ^4.0.4     |
| **Frontend**| Next.js             | 16.2.4     |
| **Frontend**| React               | 19.2.3     |
| **Frontend**| Tailwind CSS        | ^4.x       |
| **Frontend**| lucide-react        | ^1.0.0     |
| **Frontend**| reactflow           | ^11.11.4   |
| **Frontend**| exceljs             | ^4.4.0     |
| **Frontend**| papaparse           | ^5.5.3     |
| **Database**| PostgreSQL          | 15 (dev) / 16 (prod) |
| **Proxy**   | nginx               | 1.30-alpine |

---

## Architecture

### Overview

Single-repo monolith with nine Docker services behind an nginx TLS gateway (v3.0.0):

```
Browser ──HTTPS:443──▶ nginx ─── /         ──▶ frontend  (Next.js,  :3001, HTTP internal)
                               ├── /api/*   ──▶ backend   (Express,  :3000, HTTP internal)
                               └── /n8n/*   ──▶ n8n-main  (:5678, auth_request ADMIN gate)
                                                  └── Redis (:6379) ← BullMQ queue
                                                  └── n8n-worker-{1,2} (job execution)
                               backend ──▶ postgres (:5432, internal, schema: public + n8n_data)
                               backend ──▶ ollama   (:11434, internal)
```

Only nginx exposes host ports (443 HTTPS, 80 HTTP→redirect). All other containers are internal.
`/api/internal/*` is blocked at nginx (deny all → 404); accessible only container-to-container via `X-CMDB-Service-Token`.

A single compose file: `docker-compose.prod.yml` (nginx as gateway, DB and backend not exposed to host, isolated networks, named TLS volume `cmdb-tls-certs`). There is no separate dev compose file — this is the only environment.

**TLS certificates** live in `./certs/` at project root (not `./backend/certs/`). Nginx mounts them read-only; backend mounts them read-write (for the CSR generation endpoint). The named Docker volume `cmdb-tls-certs` mirrors this directory for the production compose.

The frontend's `NEXT_PUBLIC_API_URL` env var is baked in at build time; changing it requires a full container rebuild. With the nginx gateway, `NEXT_PUBLIC_API_URL` should be the same URL as `FRONTEND_URL` (e.g. `https://localhost`) — no port suffix needed.

**nginx strips upstream security headers** (`proxy_hide_header` for `X-Powered-By`, `Server`, etc.) before setting its own, preventing duplicate CSP headers.

### Backend (`backend/src/index.ts`)

The legacy API lives in a **single file** (~7,800 lines). There are no route files or controllers for it — all endpoints, middleware, types, and services are co-located. Key sections in order:

1. **Constants & config** — env vars, JWT secret, bcrypt rounds, password policy
2. **Zod schemas** — `LoginSchema`, `CICreateSchema`, `ContractCreateSchema` (validate at entry points)
3. **Middleware** — `authenticateToken` (async, checks active status on every request), `requireAdmin`, `requireAudit`
4. **Route handlers** — grouped by domain: auth, SSO, users, CIs, relations, contracts, documents, licenses, masters, integrations
5. **Cron jobs** — EOL alerts (email), trusted device cleanup, SSO state store purge

> **Module convention (since v2.6.0):** New large features must **not** be added to `index.ts`. Create a self-contained module under `backend/src/modules/<name>/` (router, Zod schemas, middleware, queries, audit) and mount its router from `index.ts`. The DCIM module (`backend/src/modules/dcim/`) is the reference implementation. `index.ts` remains the home for the existing legacy domains only — do not grow it further.

> **Connector pattern (since v3.5.3):** External-system sync integrations (hypervisors, infra inventories) follow a generic connector pattern under `backend/src/modules/integrations/connectors/` — `BaseConnector` (abstract) → concrete connector (e.g. `VCenterConnector`) → HTTP client (session/TLS handling) → pure, unit-tested mapper (external entity → CI payload). The vCenter connector is the reference implementation for future connectors (OLVM, Solaris) — see `docs/INTEGRATIONS.md`. Design decisions D1–D5 (also apply to future connectors of this kind): **D1** config/credentials from env vars only, no DB config table, no crypto module; **D2** sync never overwrites operator-owned `status` after CI creation; **D3** scheduling workflow shipped as a code-provisioned n8n template, not a standalone importable JSON; **D4** sync history lives in `audit_logs`, no dedicated `sync_logs` table; **D5** the external system owns physical facts (specs, IPs, hostnames), the operator owns governance fields (criticality, environment, business/technical owner).

External services are in `backend/src/services/`:
- `ldap.ts` — LDAP/AD authentication with RFC 4514/4515 escaping
- `microsoftSso.ts` — Microsoft 365 SSO: PKCE helpers, JWKS validation (24h cache), token exchange, ID token verification
- `emailService.ts` — Nodemailer SMTP alerts for EOL/EOS
- `eolService.ts` — endoflife.date API integration

**Auth flow (in order):**
1. **Microsoft SSO** — `GET /api/auth/sso/microsoft` → Azure AD → `GET /api/auth/sso/microsoft/callback`. Validates state (CSRF), nonce, JWKS signature, `tid`/`aud`/`iss`/domain. SSO login automatically grants a trusted device (no MFA required).
2. **LDAP/AD** — if `USE_LDAP=true`, credentials are validated against the directory via `ldap.ts`
3. **Local** — bcrypt comparison against `users.password` in DB

All paths issue a JWT (HS256, 8h) **stored in an HttpOnly cookie** (`token`). The cookie is `SameSite=Strict; Secure; HttpOnly`. The response JSON also returns the token in the body for backward-compatible API access. Every protected request goes through `authenticateToken` which: reads the JWT from the `Authorization: Bearer` header (API) or the `token` cookie (browser), verifies signature + algorithm, checks `mfaSetupRequired` flag, then queries DB to confirm `users.active = true`.

**MFA behaviour by role:**
- `ADMIN`: mandatory TOTP MFA setup on first login. Returns a limited token (`mfaSetupRequired: true`) until setup is complete. Only `/api/auth/mfa/setup` and `/api/auth/mfa/enable` are allowed on a limited token.
- `AUDITOR` / `VIEWER`: MFA is suggested but never enforced. Full token is issued immediately.

**RBAC:** Three roles — `ADMIN` (full write), `AUDITOR` (read + audit logs), `VIEWER` (read-only). Enforced by `requireAdmin` / `requireAudit` middleware on each route.

**SSO state store:** Server-side `Map<string, SsoStateEntry>` keyed by `state` param, purged every 10 min. Entries expire after 10 min to prevent replay. Never use a client-supplied state/nonce without verifying it exists in the store.

**LDAP strict mode:** `LDAP_STRICT_MODE=true` blocks local fallback for non-`@cmdb.local` / `@cmdb.internal` accounts when `USE_LDAP=true`. Defaults to `false`.

**Raw SQL pattern:** When Prisma ORM is insufficient, use `` prisma.$queryRaw`...` `` with tagged template literals (parameterized, no string concatenation). COUNT() queries return `bigint` — always wrap with `Number()` before `res.json()`.

**Security headers:** All responses go through `helmet` (v8) for base headers. nginx adds CSP. Next.js adds `Content-Security-Policy` via `next.config.ts` headers. nginx strips upstream `X-Powered-By` / `Server` headers to avoid duplication.

### Frontend (`frontend/`)

Next.js 16 App Router. All pages are **Client Components** (`"use client"`) — there are no React Server Components with data fetching. Pages call the backend API directly via `lib/apiFetch.ts`.

**Key patterns:**
- `lib/apiFetch.ts` — wrapper around `fetch` that injects `Authorization: Bearer <token>` and checks JWT expiry before every request (clears storage if expired)
- `contexts/AuthContext.tsx` — session state, JWT rehydration on mount (validates `exp` claim), 60-second periodic expiry check
- `contexts/LanguageContext.tsx` — 6-language support (ES/EN/DE/PT/FR/IT). All UI strings **must** use `const { t } = useLanguage()` and call `t("key")` — never hardcode text. Locale files: `frontend/locales/{en,es,de,pt,fr,it}.json`. Adding a new string requires adding the key to all 6 files.
- `components/AppShell.tsx` — layout shell with `Sidebar.tsx`; wraps all authenticated pages
- Modals (`AddCIModal`, `EditCIModal`, `CIDetailModal`, `AddRelationModal`, etc.) — self-contained with local state, call apiFetch directly

**Routing:** `frontend/app/<module>/page.tsx`. Current modules: `inventory`, `entities`, `map`, `contracts`, `licenses`, `documents`, `vulnerabilities`, `integrations`, `audit`, `reports`, `admin`, `profile`, `settings`, `auth/sso-callback`, `privacy`.

### Database (`backend/prisma/schema.prisma`)

PostgreSQL 15 (dev) / 16 (prod). Prisma v6 as ORM + migration runner. The schema is the single source of truth.

**Core models and relationships:**
- `CI` (ConfigurationItem) — central entity; has optional `HardwareCI` or `SoftwareCI` child records (1:1), belongs to `CIType`, `Location`, `CostCenter`, `Branch`
- `CIType` / `CITypeCategory` — master data for CI classification
- `CIRelation` — many-to-many self-join on CI with typed `RelationType` enum
- `Contract` → `_CIToContract` (M:M)
- `License` → `_LicenseToCI` (M:M), `LicenseUser` (1:M)
- `Document` — versioned (parent/child via `rootId`), linked to CIs, contracts, licenses via join tables
- `User` — `ssoProvider` (`microsoft` | `ldap` | null) + `ssoExternalId` (Azure OID for SSO users, email for LDAP shadow users) + `mfaEnabled` / `mfaSecret` for TOTP MFA
- `AuditLog` — insert-only, never updated via UI (ISO 27001 immutability); protected by RLS-equivalent policy
- `PasswordHistory` — last N hashes stored per user (configurable via `PASSWORD_HISTORY_COUNT`)

**Migration workflow:** Create a new timestamped directory under `backend/prisma/migrations/`, write `migration.sql` manually using `IF NOT EXISTS` guards, then apply with `prisma migrate deploy`. Do not use `migrate dev` in Docker.

---

## Security Constraints (non-negotiable)

- **All `$queryRaw` / `$executeRaw` calls must use tagged template literals** — never string concatenation or `$queryRawUnsafe`
- **LIKE queries** — escape `%`, `_`, `\` before interpolation; use `ESCAPE '\\'` clause
- **LDAP** — always apply `escapeLdap()` (RFC 4514/4515) to username before DN construction
- **SSO** — always validate `tid`, `iss`, `aud`, `nonce`, and email domain in ID tokens; never trust client-supplied state/nonce
- **File uploads** — magic bytes must be validated after multer fileFilter; UUID filenames only
- **API responses** — never expose stack traces, Prisma error objects, or raw DB errors; use generic messages and log internally
- **AuditLog** — every write to a CI, relation, contract, document, or user must insert an audit record with `action`, `entity`, `entity_id`, `user_email`
- **CSP** — Next.js sets `Content-Security-Policy` via `next.config.ts`; nginx sets its own stricter policy. Do not set CSP inside Express (helmet CSP is disabled) to avoid duplication
- **HttpOnly JWT** — the session cookie is `HttpOnly; Secure; SameSite=Strict`. Do not revert to localStorage storage
- **CSR endpoint** — certificate signing uses `execFile`, never `exec`

---

## GDPR / Compliance Endpoints

- `GET /privacy` — public privacy notice page (no auth required)
- `DELETE /api/users/:id/erase` — permanent personal data erasure (ADMIN only); anonymises all PII fields and inserts an audit record
- Audit log records cannot be deleted or modified via API (ISO 27001 immutability + NIS2 Art.23 compliance)

---

## Definition of Done

Before committing any `fix` or `feat`:

1. `npx tsc --noEmit` passes (no new errors beyond the known pre-existing ones)
2. Containers rebuild and start cleanly (`podman-compose -f docker-compose.prod.yml up -d --build`)
3. Health check passes through nginx: `curl -sk https://localhost/api/health`
4. Update docs if applicable:
   - Visual/flow changes → `docs/USER_MANUAL.md` + `docs/USER_MANUAL.en.md`
   - Sysadmin/install changes → `docs/SYSADMIN_MANUAL.md` + `docs/SYSADMIN_MANUAL.en.md`
   - Architecture changes → `docs/ARCHITECTURE.md` + `docs/ARCHITECTURE.en.md`
   - nginx config changes → `nginx/conf.d/frontend.conf`

---

## Git Workflow

- `main` — production releases (tagged `vX.Y.Z`)
- `develop` — active development; PRs merge here first
- Feature branches cut from `develop`, merged back via PR
- Current release: **v3.5.6** — see "Plan Activo" § Releases recientes below for full detail on this and all prior releases (this line is a pointer only; kept brief to avoid drifting out of sync with the authoritative section).

### Planning documents — active

- **v2.6.0 — RELEASED** → `docs/SPEC_v2.6.0_dcim.md` + `docs/PLAN_v2.6.0.md` (M0–M11 completados; OWASP `docs/security-audit/owasp-v2.6.0.md` + Compliance `docs/security/COMPLIANCE_v2.6.0.md`)
- **v2.6.1 — RELEASED** → DCIM rack placement full flow (tag `v2.6.1`, merged develop → main)

---

## Specialist Skills

**Always check for a matching skill before implementing anything.** Skills live in two places: project-local (`.claude/skills/`, versioned with this repo) and global (`~/.claude/skills/`, shared across all sessions on this machine). The trigger table in the Work Methodology section above takes precedence; the inventory below is the full catalogue.

### Project-local skills (`.claude/skills/`)

| Skill | When to use |
|-------|-------------|
| `vibesec-skill` | Security review — CSRF, SSRF, file upload, mass assignment, JWT, OWASP Top 10 audit |
| `supabase-postgres-best-practices` | Schema design, indexes, query optimization, BigInt handling |
| `find-bugs` | Bug hunt on local branch changes before PR |
| `differential-review` | Security-focused review of a diff or PR |
| `documentation-writer` | Compliance reports, manuals, Diátaxis-structured docs, DPIA, BCP |
| `frontend-design` | New UI pages or component refactors |
| `vercel-react-best-practices` | Next.js / React performance and patterns |
| `autoship` | Automated doc updates after a feature ships |
| `react-flow-node-ts` | ReactFlow node components with TypeScript + store (used in `/map` + DCIM) |
| `gh-fix-ci` | Debug and fix failing GitHub Actions checks |
| `readme-i18n` | Internationalisation of README / docs |
| `neon-postgres` | Serverless Postgres reference (this project runs PostgreSQL on RHEL, not Neon — reference only) |
| `find-skills` | Discover a skill when you're not sure which one applies |

### Global skills (`~/.claude/skills/`)

| Skill | When to use |
|-------|-------------|
| `agent-owasp-compliance` | OWASP Agentic Security (ASI Top 10) compliance checks |
| `api-security-hardening` | REST API hardening — auth, rate limiting, CORS, input validation |
| `owasp-security` | OWASP Top 10 secure coding — XSS, SQLi, CSRF, auth |
| `express-typescript` | Express 5 + TypeScript middleware, routing, security patterns |
| `prisma-development` | Prisma 6 best practices, schema design, migrations |
| `prisma-client-api` | Prisma 6 queries, CRUD, filters, `$transaction` |
| `docker-security-guide` | Container hardening — CIS benchmark, non-root, secrets, capability drop |
| `nginx-configuration` | nginx reverse proxy, TLS, headers, API gateway |
| `javascript-typescript-jest` | Jest tests with TypeScript — mocking, structure, patterns |
| `webapp-testing` | Playwright — UI testing, screenshots, browser logs |
| `typescript-strict-migrator` | Incremental migration to TS strict mode |
| `cron` | Cron job patterns and scheduling |
| `pre-commit-standards` | Conventional Commits + pre-commit hooks |
| `graphify` | Codebase knowledge graph (see § graphify below) |
| `n8n-workflow-patterns` | Diseño de workflows n8n — patrones Schedule/Webhook/HTTP/Code/Loop |
| `n8n-node-configuration` | Configuración detallada de nodos n8n — HTTP Request, credenciales, expresiones |

### Task → required skills

| Task type | Consult these skills first |
|-----------|---------------------------|
| Backend API / Express | `express-typescript`, `api-security-hardening`, `owasp-security`, `vibesec-skill` |
| Database / Prisma | `prisma-development`, `prisma-client-api`, `supabase-postgres-best-practices` |
| Security / auth / hardening | `owasp-security`, `agent-owasp-compliance`, `api-security-hardening`, `vibesec-skill`, `docker-security-guide` |
| Frontend / Next.js / React | `vercel-react-best-practices`, `frontend-design`, `react-flow-node-ts`, `webapp-testing` |
| Tests / QA | `javascript-typescript-jest`, `webapp-testing`, `find-bugs` |
| Docker / Podman / deploy | `docker-security-guide`, `nginx-configuration`, `autoship` |
| Cron / scheduled jobs | `cron` |
| n8n workflows | `n8n-workflow-patterns`, `n8n-node-configuration` |
| Documentation | `documentation-writer`, `readme-i18n` |
| Code review | `differential-review`, `find-bugs`, `owasp-security` |
| Git / commits / CI | `pre-commit-standards`, `gh-fix-ci`, `autoship` |
| TypeScript strict | `typescript-strict-migrator`, `express-typescript` |
| Context discovery | `graphify`, `find-skills` |

If no skill matches, fall back to the superpowers skills (see Work Methodology section).

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Plan Activo

**Versión actual en producción:** v3.5.7 (tag creado, release GitHub, main/develop sincronizados, 2026-07-22)
**Rama activa:** `develop`
**PRs abiertos:** ninguno
**Issues abiertos para la siguiente sesión:** #153 (npm audit exceljs→uuid), #152 (otplib v12→v13, auth-crítico). Follow-ups surgidos durante #172 (no abiertos como issues todavía — ver `docs/internal/plans/2026-07-16-open-issues-remediation-roadmap.md`, ahora fuera de origin): `index.ts` no es importable/montable en tests (app.listen() incondicional), Task 6 bulk-import batch-create con bucle de hasta 500 INSERTs secuenciales dentro de una transacción, `backend/src/modules/internal/alerts.ts:117-121` con el mismo patrón mutación-sin-transacción que #172 corrigió en todo lo demás.

### Issue #181 — resuelto y desplegado en producción (2026-07-16/17)

Aprovisionamiento n8n: 3 credenciales + 1 workflow fallaban con 500/400. Causas raíz confirmadas en vivo contra la instancia real de n8n 1.123.27: (1) el usuario de servicio (`cmdb-provisioner@cmdb.local`), creado por INSERT SQL directo en `scripts/lib/n8n-bootstrap.sh`, carecía del "personal project" que n8n exige para crear credenciales — corregido con SQL idempotente (creación de `project`+`project_relation`, verificada en vivo: crea → no-op en la segunda ejecución, sin duplicados); (2) `buildLdapCredential` enviaba `baseDn` (rechazado por el schema de n8n, `additionalProperties:false`) y `port` como número (el schema exige string) — corregido; (3) el 400 del workflow `vCenter Sync` era una cascada de (1), resuelto sin cambio de código adicional. **Hallazgo cross-cutting durante la implementación**: `podman exec ... psql -c "..."` NO sustituye variables `:'var'` contra esta imagen de postgres (confirmado aislando `\echo :x` vs `SELECT :x;` — el primero sustituye, el segundo da error de sintaxis; la misma consulta por stdin sí sustituye) — el bloque SQL se alimenta ahora por heredoc/stdin con `-i` en el exec. Verificado end-to-end en producción: backfill aplicado sobre el usuario real (autorizado explícitamente), backend redesplegado (`podman build` directo + verificación de `String(port)`/ausencia de `baseDn` en el `dist` compilado + `down`/`up` completo), log de arranque `aprovisionamiento completado` sin errores, `POST /api/admin/n8n/resync` → 200 `errors: []`, las 3 credenciales + los 8 workflows (incluido vCenter Sync) provisionan correctamente. 63/63 tests, `tsc --noEmit` limpio. Plan: `docs/superpowers/plans/2026-07-16-issue-181-n8n-credential-provisioning.md`.

**Patrón canónico de la casa** (vistas de nivel superior — Dashboard, Inventory, Vulnerabilities, Reports, DCIM, Decommission):
```
<div className="min-h-screen bg-slate-50">
  <header className="sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-5">
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-xl font-bold text-slate-900">{título}</h1>
        <p className="text-sm text-slate-500 mt-0.5">{subtítulo}</p>
      </div>
      {/* botones */}
    </div>
  </header>
  <div className="px-8 py-8 space-y-8 w-full">
    {/* contenido — paneles con ring-1 ring-slate-200 bg-white shadow-sm */}
  </div>
</div>
```
- Botón primario: `rounded-none bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[var(--accent)]/90 shadow-sm`
- Botón secundario/refresh: `rounded-none border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50`
- Panel/card: `bg-white shadow-sm ring-1 ring-slate-200` (ring, NO border)
- Esquinas: **`rounded-none`** en toda la app

### Releases recientes

> Nota (v3.5.7): las rutas `docs/PLAN_v*.md`, `docs/PLAN_STATUS_v*.md`, `docs/RELEASE_v*.md`, `docs/SPEC_*.md` y `docs/superpowers/plans/*` citadas en las entradas de abajo se movieron a `docs/internal/{plans,plan-status,releases,specs}/` (gitignored, solo en disco local) — el historial de citas se deja tal cual por precisión histórica, pero el fichero real ya no está en esa ruta ni en origin.

- **v3.5.7** ✅ LIBERADA (tag `v3.5.7`, PR develop→main, release en GitHub, main/develop sincronizados, 2026-07-22): consolidación a un único entorno (producción) + limpieza de `docs/`. **Contenedores**: se elimina `docker-compose.yml` (dev) — causa raíz del near-miss de podman durante v3.5.6 (ambos compose sin `name:` de proyecto propio → mismo pod). `docker-compose.prod.yml` es ahora el único fichero, con `name: cmdb-prod` explícito en la cabecera (verificado: `podman-compose -f docker-compose.prod.yml config` resuelve el proyecto correctamente). Se evaluó renombrar los 4 contenedores sin sufijo `-prod` (`cmdb-redis`, `cmdb-n8n-main`, `cmdb-n8n-worker-1/2`) pero se descartó: `cmdb-n8n-main` es hostname DNS interno real (`N8N_INTERNAL_URL`) y target directo de `podman exec` en `install.sh`/`update.sh`/`n8n-bootstrap.sh` — renombrarlo exigía tocar scripts funcionales + `.env` ya desplegado + un test, sin aportar seguridad adicional ya que la causa raíz real (colisión de pod) queda resuelta solo con borrar el fichero dev. Limpiadas variables muertas de `.env.example` (`POSTGRES_PORT`, `ADMINER_PORT`, restos del stack dev inexistente). Actualizados README/CLAUDE.md/ambos manuales sysadmin: reemplazados ~50 ejemplos `sg docker`/`docker compose` sin `-f`/nombres de contenedor sin `-prod` por los comandos reales `podman`/`podman-compose -f docker-compose.prod.yml` que usa este host. **Docs**: 61 ficheros de planificación interna (PLAN_v\*, PLAN_STATUS_v\*, RELEASE_v\*, specs, RAG runbooks, bug-hunt/audit reports, test logs, backlog/execution log) movidos de `docs/` y `docs/superpowers/` a `docs/internal/{plans,plan-status,releases,specs,rag,audits,testing,misc}/`, gitignorado y `git rm --cached` — quedan en disco local pero fuera de origin; la documentación de aplicación/cumplimiento (manuales, arquitectura, integraciones, plugin engine, DPIA, ISMS) se queda intacta donde estaba. Verificado: ningún enlace markdown funcional apuntaba a los ficheros movidos (solo citas en prosa dentro del changelog de CLAUDE.md, ahora con nota explicando la nueva ubicación). Redeploy de producción verificado tras el cambio: `down`/`up` limpio con `-f docker-compose.prod.yml`, `/api/health` 200, login OK.

- **v3.5.6** ✅ LIBERADA (tag `v3.5.6`, PR #187 `fix/172-audit-transactions`→`develop` fusionado, release en GitHub, main/develop sincronizados, 2026-07-21): cierra el alcance restante de #172 (ISO 27001 A.8.15) — todo camino de escritura+auditoría en el monolito legacy `index.ts` (29 sitios: CI core, relaciones, admin de usuarios incl. borrado GDPR, auth/SSO/MFA, importación masiva, enlaces/certificados/vulnerabilidades) y en 6 módulos (`catalog` 14, `dcim` 17, `decommission` 11, `settings` 3, `alerts` 5, `plugins` 17 — 66 sitios) ahora envuelve mutación + inserción en `AuditLog` en una única `prisma.$transaction`, siguiendo el patrón ya enviado en `staff-schedule` (v3.5.1). Ejecutado vía subagent-driven-development: Tareas 1-7 secuenciales (comparten `index.ts`), Tareas 8-12 paralelizadas en 5 worktrees git aislados (módulos sin solape de archivos) — patrón confirmado exitoso, documentado en memoria para reutilizar. **Dos rondas de fix tras revisión**: Task 7 (subida de certificado — escritura a filesystem, no a BD, no puede unirse a una transacción Prisma; primera pasada dejó el restore compensatorio sin proteger — corregido con try/catch dedicado + marcador de log `CERT_RESTORE_FAILED` + mutex en proceso + tests simulando fallo de fs); Task 12 (activar/desactivar plugin — envolvía efectos de runtime irreversibles, cron en vivo programado, hooks registrados, DENTRO de la transacción — un rollback podía dejar código de plugin sandboxed ejecutándose mientras la BD decía lo contrario; corregido moviendo `registerPlugin`/`unregisterPlugin` a después del commit). Revisión final de toda la rama (modelo opus, diff de ~315KB/19 commits): 0 Critical, 0 Important. Sitio de mayor riesgo (borrado GDPR, 4 pasos) re-trazado independientemente por el revisor en sus 4 ramas de fallo, sin hallar ningún camino de commit parcial. 477/477 tests, `tsc --noEmit` limpio, barrido grep confirma 0 sitios de auditoría huérfanos. **Hallazgo operativo durante el despliegue, fuera del plan original**: los pods de desarrollo y producción de podman comparten el mismo pod subyacente (`pod_cmdb-enterprise-platform`) porque ni `docker-compose.yml` ni `docker-compose.prod.yml` declaran un nombre de proyecto distinto — un `podman-compose down` sin `-f docker-compose.prod.yml` puede intentar tocar contenedores de producción; la mitigación es pasar siempre `-f docker-compose.prod.yml` explícitamente para cualquier operación sobre producción. **Follow-ups nuevos, no abiertos como issues todavía**: `index.ts` no es importable/montable en tests (bloquea probar los handlers reales, no solo réplicas manuales de la lógica de transacción); Task 6 mantiene una transacción abierta durante hasta 500 INSERTs secuenciales por fila en la creación de lotes masivos (candidato a convertir a una única sentencia bulk); `backend/src/modules/internal/alerts.ts:117-121` (endpoint M2M de n8n) tiene el mismo patrón mutación-sin-transacción que este release corrigió en todo lo demás, fuera del inventario original del plan. Plan: `docs/superpowers/plans/2026-07-17-issue-172-audit-transactions.md`.
- **v3.5.5** ✅ LIBERADA (tag `v3.5.5`, PR #182 feature→develop + PR develop→main, release en GitHub, desplegada y verificada en producción, 2026-07-16): resuelve #178 (`N8N_API_KEY` desincronizada) y #179 (ventana de reintento de aprovisionamiento n8n insuficiente). `N8nApiError` tipado (status + `isAuthError` para 401/403) permite a `provisionOnBoot()` distinguir credencial inválida (falla rápido, log accionable, no gasta reintentos) de "n8n aún no listo" (reintenta); ventana ampliada de 60s (10×6s) a 120s (15×8s); `POST /api/admin/n8n/resync` devuelve `502` accionable en vez de 500 genérico; healthcheck de observabilidad en `n8n-main` en ambos compose — **sin** `depends_on` hacia el backend (evaluado y rechazado a propósito: convertiría una integración opcional en un punto único de fallo de arranque, NIS2/ISO 22301); `scripts/update.sh` auto-detecta y regenera una `N8N_API_KEY` presente pero rechazada (antes solo detectaba vacía). **Hallazgo en vivo durante la verificación en producción, fuera del plan original**: busybox `wget` (las imágenes de n8n-main y backend) devuelve un `403` espurio contra peticiones genuinamente válidas a esta versión de n8n (1.123.27) — confirmado comparando la misma petición vía `wget` vs `node fetch` (el mecanismo real de `apiClient.ts`), mismo contenedor, mismo instante: `fetch` obtiene 200/401 limpio, `wget` no, sin cabecera `WWW-Authenticate` (descarta basic-auth). Esto rompía tanto el healthcheck nuevo como la sonda de `update.sh` — corregidos ambos a `node -e fetch(...)`; una primera pasada del fix perdió el margen de reintento (`--tries=2`) que evita falsos negativos en el arranque en frío de n8n (#179) — restaurado con reintento único (backoff 1s) solo ante fallo de red/timeout, nunca ante un rechazo HTTP definitivo. **Fix operativo aplicado en producción de forma independiente al merge de código**: `N8N_API_KEY` regenerada y verificada en vivo (401 confirmado resuelto, 7/7 workflows reaprovisionados, `POST /api/admin/n8n/resync` → 200) — durante ese diagnóstico se descubrió y documentó una variante del bug de caching de `podman-compose`: un `--force-recreate` SELECTIVO de un servicio dentro de un pod ya existente puede dejar el contenedor con variables de entorno de una instantánea de pod obsoleta (confirmado byte a byte, dos keys JWT distintas con mismo prefijo/longitud) — solo un `down`+`up` completo del stack garantiza que un `.env` editado se recoja de verdad. **Nuevo issue #181** (no arreglado, fuera de alcance): 3 credenciales + 1 workflow de aprovisionamiento fallan con 500/400 una vez resuelta la autenticación — root cause del 500 confirmado en vivo (el usuario de servicio `cmdb-provisioner@cmdb.local`, creado por `n8n-bootstrap.sh` vía INSERT SQL directo, carece del `Project` personal que n8n 1.123.x exige para crear credenciales — el insert directo se salta el hook de n8n que lo crearía). 63/63 tests, `tsc --noEmit` limpio. Plan: `docs/superpowers/plans/2026-07-16-n8n-provisioning-178-179.md`.
- **v3.5.4** ✅ LIBERADA (tag `v3.5.4`, merge develop→main, despliegue completo del stack de producción verificado, 2026-07-16): agrupa 4 commits que quedaron en `develop` tras el release de v3.5.3 sin llegar a fusionarse a `main` — **H1-H2 hardening** del conector vCenter: robustez ante VMs sin guest info (503) y resolución del host ESXi por mapeo inverso verificada contra un vCenter 8.x real (`docs/INTEGRATIONS.md` actualizado, sustituye el intento inicial vía `VM.Summary.host` que no existe en esa versión de la API); sección **Hipervisores** en Datos Maestros (gap detectado post-v3.5.3). Además, **fix nuevo de esta sesión**: reconciliación de la relación `HOSTS` cuando VMware DRS migra una VM a otro host ESXi entre sincronizaciones — antes la relación al host antiguo quedaba huérfana indefinidamente (una VM podía terminar mostrada como alojada por varios ESXi a la vez); ahora, tras resolver el host actual sin ambigüedad, se buscan y eliminan las relaciones `HOSTS` obsoletas hacia otro `PHYSICAL_SERVER`, con auditoría `DELETE_RELATION` (A.8.15) y reindexado RAG del host antiguo; nunca se ejecuta si la resolución del host queda nula/ambigua. 3 tests nuevos, 30/30 en `vcenter.test.ts`, `tsc --noEmit` limpio. Plan: `docs/superpowers/plans/2026-07-15-vcenter-hosts-drs-reconciliation.md`. **Incidencia de despliegue documentada como aprendizaje operativo**: `podman-compose build --no-cache` no invalidó de forma fiable el stage `builder` del Dockerfile multi-stage del backend (build silenciosamente stale) — corregido reconstruyendo con `podman build` directo y verificando el `dist` compilado en una imagen aislada antes de tocar producción; recrear el contenedor individual quedó en deadlock de dependencias de pod en podman, resuelto con `down`/`up` completo del stack (confirmado con el usuario por el corte de servicio que implica). **2 issues de infraestructura n8n abiertos para la siguiente sesión, no bloqueantes para este release**: #178 (`N8N_API_KEY` desincronizada — 401 unauthorized en `provisionOnBoot()`, causa raíz documentada desde v3.5.3) y #179 (ventana de reintento de 60s insuficiente cuando el stack completo arranca en frío y `n8n-main` tarda más en estar listo).
- **v3.5.3** ✅ LIBERADA (tag `v3.5.3`, PR #176 feature→develop + PR #177 develop→main, release en GitHub, despliegue limpio verificado, 2026-07-13): conector **vCenter → CMDB** (sincronización unidireccional de VMs como CIs `VIRTUAL_SERVER`). Patrón de conector genérico reutilizable (`BaseConnector`→`VCenterConnector`→`VCenterClient`→`VCenterMapper`, todo en `backend/src/modules/integrations/connectors/`), tabla maestra **`Hypervisor`** (`code`/`name`/`isSystem`, sembrada con `VMWARE`) + **`CI.hypervisorId`** (FK, fijado solo al crear, marcador de propiedad) + **`CI.powerState`** (columna escalar, hecho físico refrescado en cada sync) — reemplaza el diseño inicial de columna aditiva `vcenter_sync` JSONB (Task A, rediseñado en las Tasks G1-G4 tras pregunta del usuario sobre convivencia con OLVM/Solaris), servicio `runVCenterSync()` con lock en proceso + auditoría transaccional + retiro de VMs huérfanas fenced por **igualdad exacta `hypervisorId = <id de la fila VMware>`** (no un simple "no nulo", que dejaría de ser seguro con un segundo conector) (Task C, rework en G4), 4 rutas ADMIN/AUDITOR + 1 ruta interna M2M (`/api/internal/vcenter/sync`) + CRUD `/api/masters/hypervisors` (Task G2), workflow n8n `"vCenter Sync"` code-provisionado auto-activado por `VCENTER_SYNC_ENABLED` (Task D), tarjeta `VCenterCard`+`SyncLogTable` en Configuración→Integraciones (Task E), campo "Hipervisor" obligatorio en `AddCIModal`/`EditCIModal` para CIs `VIRTUAL_SERVER` (Task G3). Decisiones D1–D5: sin tabla de config ni cifrado (env vars); `powerState` nunca sobrescribe `status`; workflow como plantilla en código (patrón desde v3.2.0); historial en `audit_logs`, no tabla nueva; vCenter posee hechos físicos, operador posee gobernanza. 10 vars `VCENTER_*` nuevas, todas opcionales (feature OFF por defecto). **Tasks H1-H2 (gap detectado por el usuario pre-merge)**: H1 — adopción de CIs manuales preexistentes en el primer sync (match único por nombre case-insensitive, solo `hypervisorId IS NULL` — fence a nivel BD; 0 o 2+ candidatos ⇒ crear nuevo, nunca adivinar); H2 — resolución best-effort del host ESXi (`VCenterClient.hostSummary()`, campos de la API vSphere no verificados contra vCenter real — documentado, degrada a null) + relación `HOSTS` idempotente hacia el CI `PHYSICAL_SERVER` (upsert por clave única compuesta, nunca falla el sync de la VM). Extra: resueltos 13 fallos de test preexistentes en develop (tests desincronizados n8n-router/timeline + mkdir eager de multer en plugins fuera de Docker). 416/416 tests, 2 revisiones de rama completa sin hallazgos Critical. `docs/PLAN_v3.5.3.md` + `docs/PLAN_STATUS_v3.5.3.md` + `docs/INTEGRATIONS.md` + `docs/EXECUTION_LOG.md`.
- **v3.5.2** ✅ LIBERADA (tag `v3.5.2`, PR #175 develop→main, desplegada y verificada en producción, 2026-07-10 — entrada añadida retroactivamente, faltaba en esta lista): fix Configuración→Integraciones — Backend API "No responde" (`/health`→`/api/health`, nginx solo enruta `/api/*`) + badges LDAP/SMTP leían `NEXT_PUBLIC_*` de build-time → nuevo `GET /api/integrations/status` con estado real del servidor.
- **v3.5.1** ✅ LIBERADA (tag `v3.5.1`, PR develop→main, desplegada en producción, 2026-07-10): parches sobre Staff Schedule. (1) **Auditoría transaccional (issue #172)**: los 13 endpoints de escritura del módulo envuelven mutación + `auditStaffSchedule(tx,…)` en un mismo `prisma.$transaction` → si el audit falla, la mutación revierte (A.8.15, no "escritura sin registrar"). `auditStaffSchedule`/queries/service/authz ampliados a `Prisma.TransactionClient`; test de rollback (`auditTransaction.test.ts`, 14/14). `reports/audit.ts` swallow documentado como válido solo para logging de lectura. Deuda aceptada (granularidad/`details`) en `docs/STAFF_SCHEDULE.md §12`. Legacy `index.ts` queda como seguimiento (issue #172 abierto para ello). (2) **Fix etiquetas horario flexible**: los 4 campos flex reetiquetados por ventana (entrada 07:00–10:30 / salida 16:00–19:00) — 4 claves i18n nuevas ×6 (`flexEntryFrom/To`, `flexExitFrom/To`).
- **v3.5.0** ✅ LIBERADA (tag `v3.5.0`, PR #173 develop→main, desplegada en producción, 2026-07-09): módulo core **Staff Schedule** (planificación de horarios del personal por departamento — NO fichaje). 6 tablas nuevas (`Department`, `DepartmentManager`, `DepartmentScheduleConfig`, `SummerSchedule`, `StaffSchedule`, `ScheduleEntry`, `ScheduleAlert`) + `User.departmentId`. Decisiones clave (3 preguntas al usuario, las 3 resueltas hacia el mayor rigor): módulo core no plugin (D1); 9 estados de jornada con controles GDPR Art.9 para `BAJA_MEDICA`/`BAJA_PATERNIDAD` (D2); autorización row-level vía `DepartmentManager` — un no-ADMIN edita solo sus departamentos (D3). **Desviación crítica añadida por el análisis (no en el spec original)**: masking de salud en lectura (`maskEntryForViewer`/`maskAlertForViewer`/omisión de `healthLeaveDays`) — sin ello, D2+D3+calendario de equipo habría expuesto bajas médicas a compañeros/managers no autorizados (D4). Motor de validaciones V1-V7 (TEXT+Zod, no enum PG); FKs `Cascade` a `User` para no romper la erasure GDPR existente; `SummerSchedule` solo periodo global (horas por departamento). Verificado en despliegue local con un manager real no-admin: masking confirmado end-to-end, no solo por revisión de código. DPIA obligatoria: `docs/DPIA_STAFF_SCHEDULE.md`. `docs/PLAN_v3.5.0.md` + `docs/PLAN_STATUS_v3.5.0.md` + `docs/STAFF_SCHEDULE.md`.
- **v3.4.4** ✅ LIBERADA (tag `v3.4.4`, PR #171, desplegada y verificada en producción, 2026-07-09): relación de contención **`INSTALLED_IN`** (blade/módulo → Blade Enclosure / Convergente). Decisiones clave: validación de tipos vía `RELATION_TYPE_MATRIX` existente (NO campo en CIType — source `PHYSICAL_SERVER/STORAGE/NETWORK`, target `BLADE_SYSTEM___BLADE_ENCLOSURE/CONVERGED_INFRASTRUCTURE`); unicidad por source en doble capa (check app 409 + índice único parcial `ci_relations_installed_in_source_unique`); **2 migraciones separadas** (PG no permite usar un valor de enum nuevo en la transacción que lo crea); target RETIRADO → 422 al crear, retiro posterior → badge advertencia (sin propagación de estado); **sin endpoints nuevos** (reutiliza `/api/cis/:id/relations` + `POST /api/relations` + `DELETE /api/relations/:id`); `flattenCI` expone `installedIn*`; componente "Blade Slots" DIFERIDO (no hay modelo de bahías). `docs/PLAN_v3.4.4.md` + `docs/PLAN_STATUS_v3.4.4.md`.
- **v3.4.3** ✅ LIBERADA (tag `v3.4.3`, PR #170, 2026-07-01): column picker en la **vista** `/inventory` (no solo el reporte) — tabla hecha a mano refactorizada a sistema dirigido por columnas (registro `InvCol` useMemo, ~55 columnas con renders especiales + planas; cabecera/filtros/cuerpo iteran sobre columnas visibles; checkbox/nombre/acciones fijos). Backend: `CI_INCLUDE` +`branch`+`lifecycleDates`, `flattenCI` +`manufacturerName`. `ColumnPicker` generalizado a `PickerColumn` y reutilizado. Persistencia `localStorage`. `docs/PLAN_STATUS_v3.4.3.md`.
- **v3.4.2** ✅ LIBERADA (tag `v3.4.2`, PR #170, 2026-07-01): column picker en Inventario de CIs — `inventory.ts` registro `COLUMN_SPECS` con **61 columnas** (escalares, relaciones, HardwareCI/SoftwareCI, gobierno NIS2/GDPR, fechas ciclo de vida vía `lifecycleDates`+`dateType`), `select` Prisma **dinámico** (merge de fragmentos solo de columnas pedidas → sin over-fetching) + orderBy allowlist; `types.ts` (+`configurable`/`defaultVisible`/`group`/`allColumns`/`visibleColumns`); `ColumnPicker.tsx` (portal, grupos, ▲▼, búsqueda, persistencia `localStorage` por usuario+reporte); export respeta columnas visibles. Filtros server-side de columnas nuevas diferidos a v3.4.3. `docs/PLAN_STATUS_v3.4.2.md`.
- **v3.4.1** ✅ LIBERADA (tag `v3.4.1`, merge develop→main vía PR, 2026-06-28): correcciones Reporting Engine + filtros inline en cabeceras de los 10 reportes (popover vía `createPortal`, texto/multiselect) — fix 500 en filtros (helper `asArray` para multi-select de 1 valor + `resolveOrderBy` allowlist para columnas de relación, en `modules/reports/filterUtils.ts`); filtro `ciType` dinámico (`loadFilterOptions`→BD, `/filters` enriquecido); i18n 6 idiomas (namespaces canónicos `ci.status.*`/`ci.criticality.*`/`env.*`/`rel.*` 17 valores/`decomm.status.*`, `reports.horizon.*`); filtros inline en cabeceras de columna (popover); fix NaN KPIs (`ReportTable.renderKpiValue` para strings tipo "75%"/"12 EUR"); sidebar versión (`footer.version_short` condicional + color legible + `package.json`→3.4.1). **P4 (migrar fechas a dateType) descartado**: `CI.eolDate/eosDate` son columnas espejo por trigger; no existen `contract_dates`/`license_dates`. `docs/PLAN_STATUS_v3.4.1.md`.
- **v3.4.0** 🚧 EN DEVELOP (2026-06-28): Reporting Engine — módulo `backend/src/modules/reports/` (10 reportes core, registry extensible, RBAC por reporte, CSV/XLSX export, audit log), frontend `app/reports/` (listado + viewer dinámico), i18n ×6, extensibilidad plugins vía `manifest.reports[]`, 25 tests. Mergeado a develop; pendiente tag + merge a main.
- **v3.3.0** 🚧 EN DEVELOP (develop, 2026-06-27): bug hunt (BUG-001 LDAP TLS, BUG-002 RBAC, BUG-003 ejecuciones, BUG-004 N8N_API_KEY en compose); diagnóstico n8n → workflows aprovisionados; SECURITY_AUDIT.md v3.3.0; COMPLIANCE_v3.3.0.md; docs/n8n/TROUBLESHOOTING.md. Pendiente tag + merge a main.
- **v3.2.0** ✅ LIBERADA (2026-06-27): `.env` única fuente de verdad para n8n — módulo `n8n-provisioning` (provisioner + onBoot + router + workflows), UI Configuración → n8n (resync card, i18n ×6), `install.sh` Phase 10d bootstrap, `update.sh` `ensure_n8n_api_key`. Tag `v3.2.0`, merge develop→main.
- **v3.1.0** ✅ LIBERADA (2026-06-22): módulo Línea de Tiempo Gantt — backend 3 endpoints (`/api/timeline/items`, `/filters`, `/legacy/:ciId`) + SVG Gantt frontend + i18n ×6 + docs.
- **v3.0.1** ✅ LIBERADA (2026-06-21): UI de configuración de canales Teams/Slack en Alertas (campos write-only, fix de fuga de secretos en `getConfig`); 7 workflows n8n importables en `docs/n8n/json/` + guía instalación/admin en `docs/n8n/WORKFLOWS.md`; fix hostname M2M (`backend:3000`, no `cmdb-backend`); fix paginación completa de CIs (`fetchAllCIs`) en vistas de lista/agregación; skills n8n (`n8n-workflow-patterns`, `n8n-node-configuration`).
- **v3.0.0** ✅ LIBERADA (2026-06-21): n8n Queue Mode (main + 2 workers) + Redis 7; nginx `/n8n/` con auth_request ADMIN; M2M auth `X-CMDB-Service-Token`; `/api/internal/*` router; 5 dominios de cron migrados a n8n; `pg_dump` backup; Teams/Slack canales. `docs/PLAN_STATUS_v3.0.0.md`.
- **v2.9.2** ✅ LIBERADA (2026-06-20): AI/RAG improvements — qwen3:latest + think:false; stats CMDB en prompt (fix conteo); OCR density trigger + DPI 300; DecommissionPlan indexado en RAG (chip Decomisión en chat); cascada re-index CIs cuando maestro renombrado; `modules/ai/` extraído de `index.ts` (−640 líneas). `docs/PLAN_v2.9.2.md`.
- **v2.9.1** ✅ LIBERADA (2026-06-20): Unificación estética DCIM + Decommission al patrón canónico de la casa. Fix `/api/plugins` 403 (faltaba `authenticateToken` en mounts del plugin engine). PR #163.
- **v2.9.0** ✅ LIBERADA (2026-06-20): Modularización backend Strangler Fig — `index.ts` ~8 200→~4 900 líneas; 7 dominios extraídos a `modules/` (settings, vendors, integrations, licenses, contracts, masters, documents) + `shared/` middleware/utils. Tests jest+supertest por módulo (todos verdes). PRs #154–#162. `docs/PLAN_v2.9.0.md`.
- **v2.8.7** ✅ LIBERADA (2026-06-19): Bulk import +24 campos infra/GRC (cols 25–48); tema claro en `/decommission/*` + `/plugins/admin`; fix dropdown sistemas invisible; i18n ES "Decomisado". `docs/PLAN_v2.8.7.md`.
- **v2.8.6** ✅ LIBERADA (2026-06-16): Fixes modal Decomisionado (label "(SISTEMA)", i18n `actions.create`/`view`, endpoint `GET /api/decommission/systems` + combobox debounce) + limpieza i18n página detalle. PR #149.
- **v2.8.5** ✅ LIBERADA (2026-06-15): Fix sidebar duplicado (T1), Marketplace plugins hardening + one-click install + UI (T2), CIType SISTEMA (T3), Módulo Decomisionado (T4). PRs #144–#147.
- **v2.8.4** ✅ LIBERADA (2026-06-15): Módulo alertas email (7 categorías, config UI, scheduler, historial, i18n ×6, EOL modelo). PRs #133–#142.
- **v2.8.3** ✅ LIBERADA (2026-06-14): Fechas propias del CI + edición modelos por modal.
- **v2.8.2** ✅ LIBERADA (2026-06-14): DateType lifecycle dates + mirror triggers.
- **v2.8.0** ✅ LIBERADA: Plugin Engine.

### Para iniciar la próxima versión
1. Crear `docs/PLAN_vX.Y.Z.md` con el plan completo.
2. Actualizar esta sección con la nueva versión y estado.
3. Rama: `feature/...` cortada de `develop`.

### Resumen v3.4.0
Reporting Engine completo: módulo backend `backend/src/modules/reports/` con `types.ts`, `registry.ts` (Map extensible), `schemas.ts` (Zod), `middleware.ts` (`requireReportAccess` RBAC 404/403), `audit.ts` (VIEW_REPORT/EXPORT_REPORT, insert-only), `export.ts` (toCSV + toXLSX ExcelJS), `router.ts` (GET /api/reports, /data, /export, /filters), y 10 reportes core: `inventory`, `obsolescence`, `security`, `contracts`, `licenses`, `compliance`, `lifecycle`, `audit-trail`, `impact-map`, `decommission`. Frontend: `app/reports/page.tsx` (listado agrupado por categoría, sustituye 675 líneas client-side), `app/reports/[id]/page.tsx` (viewer con sidebar filtros dinámicos + export), 3 componentes (`ReportCard`, `ReportTable`, `ReportFilterPanel`), 2 hooks (`useReports`, `useReportData`). i18n ×6 (ES/EN/DE/PT/FR/IT): claves `reports.list.*`, `.view.*`, `.category.*`, `.filter.*`, `.kpi.*`, `.col.*`, `.def.*`. Plugin extensibility: `plugins/schemas.ts` añade `reports[]` al manifest, `engine.ts` llama `registerReport(source:'plugin')` en activate y `unregisterPluginReports` en deactivate, `router.ts` proxía a `pluginRuntime.runRoute` manteniendo sandbox intacto. Tests: 25/25 ✓ (registry RBAC, 401/403/200, audit, CSV/XLSX, plugin proxy). Verificado en prod: 273 CIs, RBAC correcto, export CSV OK. **Desviaciones:** `decommission.ts` usa `$queryRawUnsafe` (Prisma no genera el modelo); `Environment` sin valor DR; `RelationType` con valores reales del schema (HOSTS/DEPENDS_ON/CONNECTED_TO/…). `docs/PLAN_STATUS_v3.4.0.md`.

### Resumen v3.3.0
Bug hunt autónomo + diagnóstico n8n + pentest SAST + compliance: **BUG-001** LDAP TLS `allowUnauthorizedCerts` invertida (corregida en `credentials.ts`); **BUG-002** RBAC manual en router n8n-provisioning → centralizado a `requireAdmin` en mount `index.ts:314`; **BUG-003** dev compose sin purga ejecuciones n8n; **BUG-004** `N8N_API_KEY`/`N8N_INTERNAL_URL` no pasadas al backend en compose (raíz del aprovisionamiento omitido). Fix nginx resolver `10.89.1.1`→`10.89.0.1` (dev). Version badge: `GIT_TAG` ARG en Dockerfile + `gen-version.mjs` prioriza env→git describe→package.json. `SECURITY_AUDIT.md` actualizado (sección v3.3.0); `COMPLIANCE_v3.3.0.md` (ISO 27001 / GDPR / NIS2 / ISO 22301, todos ✅); `docs/n8n/TROUBLESHOOTING.md` (INC-001 a INC-003). Issues GitHub: #165–#168. **Variables nuevas:** `LDAP_ALLOW_UNAUTHORIZED_CERTS` (opt-in, default false), `N8N_INTERNAL_URL` (default `http://n8n-main:5678`) — ahora declaradas en ambos compose.

### Resumen v3.2.0
`.env` como única fuente de verdad para n8n: módulo `backend/src/modules/n8n-provisioning/` con `provisioner.ts` (idempotente: lee credenciales vía `$queryRaw` en `n8n_data.credentials_entity`, delete+create o create; workflows via API list, update o create; activación por política `smtp`/`ldap`/`always`), `onBoot.ts` (fire-and-forget, retry ×10 cada 6s), `router.ts` (`POST /api/admin/n8n/resync`, solo ADMIN, AuditLog `N8N_RESYNC`), `workflows.ts` (plantillas en código). UI: `N8nResyncCard` en Configuración → pestaña n8n (ADMIN only), i18n ×6. `install.sh` Phase 10d: espera healthz n8n, `n8n_ensure_owner_and_key`, inyecta `N8N_API_KEY` en `.env` via `sed`, reinicia backend. `update.sh`: `ensure_required_env_vars` ampliado (genera secretos n8n/Redis con `openssl rand`), `check_new_env_vars` con vars v3.2.0, nueva `ensure_n8n_api_key()` post-deploy. **Variable nueva crítica: `N8N_API_KEY` (auto-generada, vacía → aprovisionamiento desactivado).**

### Resumen v3.0.0
n8n Queue Mode (main + 2 workers) + Redis 7 integrados en ambos compose; nginx `/n8n/` con auth_request ADMIN. M2M auth `X-CMDB-Service-Token` + `/api/internal/*` router (`modules/internal/`). 5 dominios de scheduling migrados de node-cron a n8n: alertas diarias, 4 crons de mantenimiento, RAG indexing (*/30s), bulk CI import (webhook), LDAP sync. 6 módulos internos nuevos: alerts, maintenance, rag, bulk, users, backup, notify. `postgresql16-client` en Dockerfile backend para `pg_dump`. DB migration: `alert_config` + `alert_rules` con canales Teams/Slack. `docs/n8n/WORKFLOWS.md` + `ADMIN_GUIDE.md` + `BACKUP_RESTORE_GUIDE.md`. **Variables de entorno críticas nuevas: `CMDB_SERVICE_TOKEN` (≥32 chars), `REDIS_PASSWORD`, `N8N_ENCRYPTION_KEY`, `BACKUP_LOCAL_PATH`.**

### Resumen v2.9.2
AI/RAG: modelo qwen3:latest (think:false); inyección stats CMDB en prompt (60s cache, fix conteo); OCR density trigger (< 100 chars/página) + DPI 300; DecommissionPlan serializado e indexado en RAG (chip Decomisión + i18n ×6 + cita → /decommission/:id); cascada re-index CIs al renombrar branches/cost-centers/ci-types (dependency injection en masters router); extracción `modules/ai/` (queue.ts + router.ts, ~640 líneas fuera de index.ts); fix ALLOWED_ENTITY_TYPES incluye 'decommission'. `docs/PLAN_v2.9.2.md`.

### Resumen v2.8.5
Fix sidebar duplicado (/plugins/admin, /admin/certificates). Marketplace de plugins hardening completo (SSRF allowlist, Zod upstream, cache 5 min, `POST /marketplace/install` one-click). CIType "Sistema" + categoría LOGICAL. Módulo Decomisionado (CTE recursiva, Gantt SVG, CRUD docs/contratos/licencias, coherencia fechas, impresión). i18n ×6 en todas las claves nuevas.
