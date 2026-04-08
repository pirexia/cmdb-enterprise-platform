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

# PostgreSQL shell
sg docker -c "docker exec -it cmdb-postgres psql -U cmdb_db_user -d cmdb_db"

# DB backup
sg docker -c "docker exec cmdb-postgres pg_dump -U cmdb_db_user cmdb_db" > backup_$(date +%F).sql
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

The backend runs HTTPS (self-signed certs in `certs/`) even in development. The frontend's `NEXT_PUBLIC_API_URL` env var is baked in at build time; changing it requires a full container rebuild.

### Backend (`backend/src/index.ts`)

The entire API lives in a **single file** (~3,800 lines). There are no route files or controllers — all endpoints, middleware, types, and services are co-located. Key sections in order:

1. **Constants & config** — env vars, JWT secret, bcrypt rounds, password policy
2. **Zod schemas** — `LoginSchema`, `CICreateSchema`, `ContractCreateSchema` (validate at entry points)
3. **Middleware** — `authenticateToken` (async, checks active status on every request), `requireAdmin`, `requireAudit`
4. **Route handlers** — grouped by domain: auth, users, CIs, relations, contracts, documents, licenses, masters, integrations
5. **Cron jobs** — EOL alerts (email), trusted device cleanup

External services are in `backend/src/services/`:
- `ldap.ts` — LDAP/AD authentication with RFC 4514/4515 escaping
- `emailService.ts` — Nodemailer SMTP alerts for EOL/EOS
- `eolService.ts` — endoflife.date API integration

**Auth flow:** JWT (HS256, 8h) stored in localStorage. Every protected request goes through `authenticateToken` which: verifies JWT signature + algorithm, checks `mfaSetupRequired` flag, then queries DB to confirm `users.active = true`. MFA setup tokens are limited to 15 min and restricted to `/api/auth/mfa/*` paths.

**RBAC:** Three roles — `ADMIN` (full write), `AUDITOR` (read + audit logs), `VIEWER` (read-only). Enforced by `requireAdmin` / `requireAudit` middleware on each route.

**Raw SQL pattern:** When Prisma ORM is insufficient, use `prisma.$queryRaw\`...\`` with tagged template literals (parameterized, no string concatenation). COUNT() queries return `bigint` — always wrap with `Number()` before `res.json()`.

### Frontend (`frontend/`)

Next.js 15 App Router. All pages are **Client Components** (`"use client"`) — there are no React Server Components with data fetching. Pages call the backend API directly via `lib/apiFetch.ts`.

**Key patterns:**
- `lib/apiFetch.ts` — wrapper around `fetch` that injects `Authorization: Bearer <token>` and checks JWT expiry before every request (clears localStorage if expired)
- `contexts/AuthContext.tsx` — session state, JWT rehydration on mount (validates `exp` claim), 60-second periodic expiry check
- `contexts/LanguageContext.tsx` — ES/EN toggle; all UI strings should use this context, not hardcoded text
- `components/AppShell.tsx` — layout shell with `Sidebar.tsx`; wraps all authenticated pages
- Modals (`AddCIModal`, `EditCIModal`, `CIDetailModal`, `AddRelationModal`, etc.) — self-contained with local state, call apiFetch directly

**Routing:** `frontend/app/<module>/page.tsx`. Current modules: `inventory`, `entities`, `map`, `contracts`, `licenses`, `documents`, `vulnerabilities`, `integrations`, `audit`, `reports`, `admin`, `profile`, `settings`.

### Database (`backend/prisma/schema.prisma`)

PostgreSQL 15 (dev) / 16 (prod). Prisma as ORM + migration runner. The schema is the single source of truth.

**Core models and relationships:**
- `CI` (ConfigurationItem) — central entity; has optional `HardwareCI` or `SoftwareCI` child records (1:1), belongs to `CIType`, `Location`, `CostCenter`, `Branch`
- `CIType` / `CITypeCategory` — master data for CI classification (replaces old enum)
- `CIRelation` — many-to-many self-join on CI with typed `RelationType` enum
- `Contract` → `_CIToContract` (M:M) — contracts linked to CIs
- `License` → `_LicenseToCI` (M:M), `LicenseUser` (1:M) — license repository
- `Document` — versioned (parent/child via `rootId`), linked to CIs, contracts, licenses via join tables
- `AuditLog` — insert-only, never updated via UI (ISO 27001 immutability)
- `PasswordHistory` — last N hashes stored per user (configurable via `PASSWORD_HISTORY_COUNT`)

**Migration workflow:** Create a new timestamped directory under `backend/prisma/migrations/`, write `migration.sql` manually, then apply with `prisma migrate deploy` (not `migrate dev` in Docker — use `--create-only` then `deploy`).

## Security Constraints (non-negotiable)

- **All `$queryRaw` / `$executeRaw` calls must use tagged template literals** — never string concatenation or `$queryRawUnsafe`
- **LIKE queries** — escape `%`, `_`, `\` before interpolation; use `ESCAPE '\\'` clause
- **LDAP** — always apply `escapeLdap()` (RFC 4514/4515) to username before DN construction
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
- Current release in progress: **v1.6.5** (all issues #38–#45 resolved, pending tag + merge to main)

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
