# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
```

> `sg docker -c "..."` is required when the current shell session does not have the `docker` group — common in WSL2.

**Known pre-existing TypeScript errors** (ignore in `tsc` output, do not fix):
- `Property 'license' does not exist on type 'PrismaClient'`
- `Property 'licenseUser' does not exist on type 'PrismaClient'`

These are caused by a Prisma client generation mismatch inside Docker; they do not affect the running application.

## Architecture

### Overview

Single-repo monolith with two independent Docker services communicating over `cmdb-network`:

```
frontend (Next.js 15, :3001) ──HTTP──▶ backend (Express, :3000) ──▶ postgres (:5432)
```

Two compose files: `docker-compose.yml` (development, exposes all ports, includes Adminer) and `docker-compose.prod.yml` (production, DB not exposed, isolated networks, named TLS volume). The frontend's `NEXT_PUBLIC_API_URL` env var is baked in at build time; changing it requires a full container rebuild.

### Backend (`backend/src/index.ts`)

The entire API lives in a **single file** (~4,000 lines). There are no route files or controllers — all endpoints, middleware, types, and services are co-located. Key sections in order:

1. **Constants & config** — env vars, JWT secret, bcrypt rounds, password policy
2. **Zod schemas** — `LoginSchema`, `CICreateSchema`, `ContractCreateSchema` (validate at entry points)
3. **Middleware** — `authenticateToken` (async, checks active status on every request), `requireAdmin`, `requireAudit`
4. **Route handlers** — grouped by domain: auth, SSO, users, CIs, relations, contracts, documents, licenses, masters, integrations
5. **Cron jobs** — EOL alerts (email), trusted device cleanup, SSO state store purge

External services are in `backend/src/services/`:
- `ldap.ts` — LDAP/AD authentication with RFC 4514/4515 escaping
- `microsoftSso.ts` — Microsoft 365 SSO: PKCE helpers, JWKS validation (24h cache), token exchange, ID token verification
- `emailService.ts` — Nodemailer SMTP alerts for EOL/EOS
- `eolService.ts` — endoflife.date API integration

**Auth flow (in order):**
1. **Microsoft SSO** — `GET /api/auth/sso/microsoft` → Azure AD → `GET /api/auth/sso/microsoft/callback`. Validates state (CSRF), nonce, JWKS signature, `tid`/`aud`/`iss`/domain. SSO login automatically grants a trusted device (no MFA required).
2. **LDAP/AD** — if `USE_LDAP=true`, credentials are validated against the directory via `ldap.ts`
3. **Local** — bcrypt comparison against `users.password` in DB

All paths issue a JWT (HS256, 8h) stored in localStorage. Every protected request goes through `authenticateToken` which: verifies JWT signature + algorithm, checks `mfaSetupRequired` flag, then queries DB to confirm `users.active = true`.

**RBAC:** Three roles — `ADMIN` (full write), `AUDITOR` (read + audit logs), `VIEWER` (read-only). Enforced by `requireAdmin` / `requireAudit` middleware on each route.

**SSO state store:** Server-side `Map<string, SsoStateEntry>` keyed by `state` param, purged every 10 min. Entries expire after 10 min to prevent replay. Never use a client-supplied state/nonce without verifying it exists in the store.

**Raw SQL pattern:** When Prisma ORM is insufficient, use `` prisma.$queryRaw`...` `` with tagged template literals (parameterized, no string concatenation). COUNT() queries return `bigint` — always wrap with `Number()` before `res.json()`.

### Frontend (`frontend/`)

Next.js 15 App Router. All pages are **Client Components** (`"use client"`) — there are no React Server Components with data fetching. Pages call the backend API directly via `lib/apiFetch.ts`.

**Key patterns:**
- `lib/apiFetch.ts` — wrapper around `fetch` that injects `Authorization: Bearer <token>` and checks JWT expiry before every request (clears localStorage if expired)
- `contexts/AuthContext.tsx` — session state, JWT rehydration on mount (validates `exp` claim), 60-second periodic expiry check
- `contexts/LanguageContext.tsx` — 6-language support (ES/EN/DE/PT/FR/IT). All UI strings **must** use `const { t } = useLanguage()` and call `t("key")` — never hardcode text. Locale files: `frontend/locales/{en,es,de,pt,fr,it}.json`. Adding a new string requires adding the key to all 6 files.
- `components/AppShell.tsx` — layout shell with `Sidebar.tsx`; wraps all authenticated pages
- Modals (`AddCIModal`, `EditCIModal`, `CIDetailModal`, `AddRelationModal`, etc.) — self-contained with local state, call apiFetch directly

**Routing:** `frontend/app/<module>/page.tsx`. Current modules: `inventory`, `entities`, `map`, `contracts`, `licenses`, `documents`, `vulnerabilities`, `integrations`, `audit`, `reports`, `admin`, `profile`, `settings`, `auth/sso-callback`.

### Database (`backend/prisma/schema.prisma`)

PostgreSQL 15 (dev) / 16 (prod). Prisma as ORM + migration runner. The schema is the single source of truth.

**Core models and relationships:**
- `CI` (ConfigurationItem) — central entity; has optional `HardwareCI` or `SoftwareCI` child records (1:1), belongs to `CIType`, `Location`, `CostCenter`, `Branch`
- `CIType` / `CITypeCategory` — master data for CI classification
- `CIRelation` — many-to-many self-join on CI with typed `RelationType` enum
- `Contract` → `_CIToContract` (M:M)
- `License` → `_LicenseToCI` (M:M), `LicenseUser` (1:M)
- `Document` — versioned (parent/child via `rootId`), linked to CIs, contracts, licenses via join tables
- `User` — `ssoProvider` (`microsoft` | `ldap` | null) + `ssoExternalId` (Azure OID for SSO users, email for LDAP shadow users) distinguish external identity source
- `AuditLog` — insert-only, never updated via UI (ISO 27001 immutability)
- `PasswordHistory` — last N hashes stored per user (configurable via `PASSWORD_HISTORY_COUNT`)

**Migration workflow:** Create a new timestamped directory under `backend/prisma/migrations/`, write `migration.sql` manually using `IF NOT EXISTS` guards, then apply with `prisma migrate deploy`. Do not use `migrate dev` in Docker.

## Security Constraints (non-negotiable)

- **All `$queryRaw` / `$executeRaw` calls must use tagged template literals** — never string concatenation or `$queryRawUnsafe`
- **LIKE queries** — escape `%`, `_`, `\` before interpolation; use `ESCAPE '\\'` clause
- **LDAP** — always apply `escapeLdap()` (RFC 4514/4515) to username before DN construction
- **SSO** — always validate `tid`, `iss`, `aud`, `nonce`, and email domain in ID tokens; never trust client-supplied state/nonce
- **File uploads** — magic bytes must be validated after multer fileFilter; UUID filenames only
- **API responses** — never expose stack traces, Prisma error objects, or raw DB errors; use generic messages and log internally
- **AuditLog** — every write to a CI, relation, contract, document, or user must insert an audit record with `action`, `entity`, `entity_id`, `user_email`

## Definition of Done

Before committing any `fix` or `feat`:

1. `npx tsc --noEmit` passes (no new errors beyond the known pre-existing ones)
2. Containers rebuild and start cleanly (`docker compose up -d --build`)
3. Update docs if applicable:
   - Visual/flow changes → `docs/USER_MANUAL.md` + `docs/USER_MANUAL.en.md`
   - Sysadmin/install changes → `docs/SYSADMIN_MANUAL.md` + `docs/SYSADMIN_MANUAL.en.md`
   - Architecture changes → `ARCHITECTURE.md` + `ARCHITECTURE.en.md`

## Git Workflow

- `main` — production releases (tagged `vX.Y.Z`)
- `develop` — active development; PRs merge here first
- Feature branches cut from `develop`, merged back via PR
- Current release: **v1.7.0** (i18n 6 languages + Microsoft 365 SSO)

## Specialist Skills

Skills are in `.claude/skills/`. Invoke with the `Skill` tool when the task matches:

| Skill | When to use |
|-------|-------------|
| `vibesec-skill` | Security review — CSRF, SSRF, file upload, mass assignment, JWT |
| `supabase-postgres-best-practices` | Schema design, indexes, query optimization, BigInt |
| `find-bugs` + `differential-review` | Pre-release bug hunt on a branch diff |
| `documentation-writer` | Compliance reports, manuals, Diátaxis-structured docs |
| `frontend-design` | New UI pages or component refactors |
| `autoship` | Automated documentation updates after a feature ships |
