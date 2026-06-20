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

**Development runs entirely in Docker** (WSL2 local, RHEL 9 production). Never run `npm install` or `npx prisma` directly on the host — always through the container or via `docker exec`.

```bash
# Start / rebuild all containers
sg docker -c "docker compose down && docker compose up -d --build"

# Apply schema changes (run inside backend container)
sg docker -c "docker exec cmdb-backend npx prisma migrate deploy"

# Generate Prisma client after schema edits
sg docker -c "docker exec cmdb-backend npx prisma generate"

# TypeScript check (pre-commit gate — must pass with 0 new errors)
cd backend && npx tsc --noEmit

# Backend container shell
sg docker -c "docker exec -it cmdb-backend sh"

# PostgreSQL shell (user/db come from .env — defaults shown)
sg docker -c "docker exec -it cmdb-postgres psql -U admin -d cmdb_db"

# DB backup
sg docker -c "docker exec cmdb-postgres pg_dump -U admin cmdb_db" > backup_$(date +%F).sql

# Run a Node.js script inside the backend container (for DB operations needing bcrypt/Prisma)
# Copy script to /app/ so node_modules are in scope
sg docker -c "docker cp /tmp/myscript.js cmdb-backend:/app/myscript.js && docker exec -w /app cmdb-backend node myscript.js && docker exec cmdb-backend rm /app/myscript.js"
```

> `sg docker -c "..."` is required when the current shell session does not have the `docker` group — common in WSL2.

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

Single-repo monolith with three Docker services behind an nginx TLS gateway:

```
Browser ──HTTPS:443──▶ nginx ─── /         ──▶ frontend (Next.js, :3001, HTTP internal)
                               └── /api/*   ──▶ backend  (Express,  :3000, HTTP internal)
                                                              └──▶ postgres (:5432, internal)
```

Only nginx exposes host ports (443 HTTPS, 80 HTTP→redirect). Frontend and backend are internal containers with no host port binding.

Two compose files: `docker-compose.yml` (development, exposes all ports, includes Adminer) and `docker-compose.prod.yml` (production, nginx as gateway, DB and backend not exposed, isolated networks, named TLS volume `cmdb-tls-certs`).

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
2. Containers rebuild and start cleanly (`docker compose up -d --build`)
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
- Current release: **v2.6.1** (DCIM rack placement full flow: assign-rack from footprint edit panel, U-slot overlap validation + EditCIModal placement UX, rack location section in CIDetailModal + placement pre-fill, GET /api/cis/:id endpoint, footprint kinds + inline edit panel + delete 409 protection; docs: skills inventory + module convention, gitignore hardening)
- Previous release: **v2.6.0** (DCIM Module 2D MVP: Buildings/Floors/Rooms/Aisles/Footprints, RackElevation2D SVG, RoomPlan2D ReactFlow, PlaceCIModal, power alerts cron + heatmap overlay, requireUuidParam blanket F-02 closed, OWASP 0 C/H/M — 4 Low, 2 fixed in-branch)

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

---

## Plan Activo

**Versión actual en producción:** v2.9.0 — ✅ LIBERADA (tag `v2.9.0`, merge develop→main, 2026-06-20)
**Próxima versión:** —
**PRs abiertos:** —

### Para iniciar la próxima versión
1. Crear `docs/PLAN_vX.Y.Z.md` con el plan completo.
2. Actualizar esta sección con la nueva versión y estado.
3. Rama: `feature/...` cortada de `develop`.

### Releases recientes
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

### Resumen v2.8.5
Fix sidebar duplicado (/plugins/admin, /admin/certificates). Marketplace de plugins hardening completo (SSRF allowlist, Zod upstream, cache 5 min, `POST /marketplace/install` one-click). CIType "Sistema" + categoría LOGICAL. Módulo Decomisionado (CTE recursiva, Gantt SVG, CRUD docs/contratos/licencias, coherencia fechas, impresión). i18n ×6 en todas las claves nuevas.
