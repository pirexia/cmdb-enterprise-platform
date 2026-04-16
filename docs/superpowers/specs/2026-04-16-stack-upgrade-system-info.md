# Stack Upgrade & Dynamic System Info — Design Spec

**Date:** 2026-04-16
**Branch:** develop
**Release context:** v1.7.1 → v1.8.0

---

## Overview

Two related goals addressed together:

1. **Stack upgrade:** Audit all platform dependencies and bring them to latest stable supported versions, with Node.js 20 → 22 as the critical item (EOL 30 Apr 2026, 14 days away at spec date).
2. **Dynamic System Info UI:** Replace the static 2-column hardcoded list in Settings → Integrations & Systems → System Information with a live 5-column table that shows each component's installed version, end-of-support date (queried from endoflife.date), and software license type. Add nginx, which is missing from the current view despite being part of the architecture since v1.7.1.

---

## Architecture context

```
Browser ──HTTPS:443──▶ nginx ─── /        ──▶ frontend (Next.js, :3001)
                              └── /api/*  ──▶ backend  (Express,  :3000)
                                                          └──▶ postgres (:5432)
```

nginx was added as unified TLS gateway in v1.7.1 (commit 1031fe6) but is absent from the System Info view and not reflected in all documentation sections.

---

## Block 1 — Package audit & upgrade

### Scope

| Component | Current | Target | Priority |
|-----------|---------|--------|----------|
| Node.js (Dockerfiles) | 20-alpine | **22-alpine** | CRITICAL — EOL 30 Apr 2026 |
| multer | 1.4.5-lts.1 | ^2.x if available | HIGH — legacy branch |
| All other npm deps | various | latest stable | MEDIUM — npm warnings |

### Process

1. Run `npm outdated` in both `backend/` and `frontend/`.
2. For each outdated package:
   - Check changelog for breaking changes.
   - Update `package.json` version range.
   - Fix any TypeScript or runtime incompatibilities.
3. **Non-upgrade criterion:** If a major version bump requires extensive refactor with no security benefit, document as "known pending upgrade" in SYSADMIN_MANUAL and keep current LTS-stable version.
4. Update `FROM node:20-alpine` → `FROM node:22-alpine` in both Dockerfiles (3 stages total: backend builder, backend runner, frontend — each has its own FROM).
5. Rebuild containers and verify health check passes: `curl -sk https://localhost/api/health`.

---

## Block 2 — Backend: `systemInfoService.ts` + endpoint

### New file: `backend/src/services/systemInfoService.ts`

Follows the same pattern as `eolService.ts`.

#### Data model

```typescript
interface StackComponent {
  name: string;           // Display name, e.g. "Node.js"
  category: string;       // "Runtime" | "Framework" | "Database" | "Gateway" | "ORM" | "Language" | "Library"
  version: string;        // Installed version (detected at runtime)
  latestCycle?: string;   // Latest stable cycle from endoflife.date
  eolDate?: string | false; // ISO date string, false = no EOL for this cycle, undefined = no data
  isEol: boolean;
  daysToEol?: number;     // Negative = already EOL
  license: string;        // SPDX identifier or short name
  hasEolData: boolean;    // Whether endoflife.date has a page for this product
}

interface SystemInfoResponse {
  components: StackComponent[];
  generatedAt: string; // ISO timestamp of last cache refresh
}
```

#### Version detection (runtime)

| Component | Source |
|-----------|--------|
| Node.js | `process.version` |
| npm packages | Read `node_modules/{pkg}/package.json` → `version` field |
| nginx | `process.env.NGINX_VERSION` env var |
| PostgreSQL | Parse major version from `process.env.DATABASE_URL` |

#### endoflife.date integration

Products with confirmed pages on endoflife.date:
- `nodejs`, `postgresql`, `nginx`, `nextjs`

For all other components (express, react, prisma, typescript, tailwindcss, zod, bcrypt, jsonwebtoken, helmet, node-cron, nodemailer, multer): `hasEolData: false`, `eolDate: undefined`.

Query pattern: `GET https://endoflife.date/api/{product}/{cycle}.json`

**Cache:** In-memory `Map<string, { data: StackComponent[]; fetchedAt: number }>`, TTL 24 hours. On cache miss or expired, re-fetch. On fetch error, return stale cache if available; otherwise return component with `hasEolData: false` — never throw a 500.

#### License map (static, curated)

| Component | License |
|-----------|---------|
| Node.js | MIT |
| Express | MIT |
| Next.js | MIT |
| React | MIT |
| PostgreSQL | PostgreSQL License |
| nginx | BSD-2-Clause |
| Prisma | Apache 2.0 |
| TypeScript | Apache 2.0 |
| Tailwind CSS | MIT |
| Zod | MIT |
| Helmet | MIT |
| jsonwebtoken | MIT |
| bcrypt | MIT |
| node-cron | MIT |
| nodemailer | MIT |
| multer | MIT |

#### Endpoint

```
GET /api/system-info
Middleware: authenticateToken, requireAdmin
Response 200: SystemInfoResponse
Response 401/403: standard auth errors
```

#### Environment variables added to both compose files

```yaml
# Under backend service → environment:
NGINX_VERSION: "1.27"   # update when nginx image is bumped
```

---

## Block 3 — Frontend: dynamic table

### Location

`frontend/app/settings/page.tsx` — "Información del Sistema" section (currently lines 479–503).

### Table structure (5 columns)

```
┌──────────────┬──────────┬─────────────┬──────────────────┬──────────────┐
│ Componente   │ Versión  │ Fin soporte │ Licencia         │ Estado       │
├──────────────┼──────────┼─────────────┼──────────────────┼──────────────┤
│ Node.js      │ 22.x.x   │ 2027-04-30  │ MIT              │ ● Activo     │
│ PostgreSQL   │ 16.x     │ 2028-11-09  │ PostgreSQL Lic.  │ ● Activo     │
│ nginx        │ 1.28     │ —           │ BSD-2-Clause     │ ● Activo     │
│ ...          │ ...      │ ...         │ ...              │ ...          │
└──────────────┴──────────┴─────────────┴──────────────────┴──────────────┘
```

### Status badges

| Badge | Colour | Condition |
|-------|--------|-----------|
| Activo | Green | `!isEol && daysToEol > 90` (or no EOL date) |
| Próximo EOL | Amber | `!isEol && daysToEol <= 90` |
| Sin soporte | Red | `isEol === true` |
| Comunidad | Grey | `hasEolData === false` |

### Loading states

- **Loading:** skeleton rows (same count as expected components)
- **Error:** inline error banner inside the card, retry button
- **Success:** rendered table

### i18n

New keys added to all 6 locale files (`es`, `en`, `de`, `pt`, `fr`, `it`) under `settings.system_info`:

```json
{
  "settings": {
    "system_info": {
      "title": "Información del Sistema",
      "col_component": "Componente",
      "col_version": "Versión",
      "col_eol": "Fin de soporte",
      "col_license": "Licencia",
      "col_status": "Estado",
      "status_active": "Activo",
      "status_eol_soon": "Próximo EOL",
      "status_eol": "Sin soporte",
      "status_community": "Comunidad",
      "eol_unknown": "—",
      "loading": "Cargando información del sistema…",
      "error": "No se pudo cargar la información del sistema."
    }
  }
}
```

(Translations for all 6 languages required.)

---

## Block 4 — Documentation

| Document | Changes |
|----------|---------|
| `docs/ARCHITECTURE.md` + `.en.md` | Verify nginx section is complete and accurate after v1.7.1 changes; add nginx to stack table |
| `docs/SYSADMIN_MANUAL.md` + `.en.md` | Node.js 22 upgrade notes; stack version table with EOL dates; nginx configuration section |
| `docs/USER_MANUAL.md` + `.en.md` | Describe new System Info table and badge meanings |

---

## Definition of Done

- [ ] `npx tsc --noEmit` passes with 0 new errors (beyond known pre-existing ones)
- [ ] `docker compose up -d --build` succeeds with Node.js 22 images
- [ ] `curl -sk https://localhost/api/health` returns 200
- [ ] `GET /api/system-info` (as admin) returns valid JSON with all 16 components
- [ ] Settings → System Info shows the 5-column table with live data
- [ ] Badges display correctly for EOL, near-EOL, and community components
- [ ] All 6 locale files updated
- [ ] Documentation updated
- [ ] Pushed to `develop`

---

## Execution strategy

Four independent blocks executed in parallel by specialised subagents, coordinated by the main agent:

1. **Agent A** — Block 1 (package audit + Node.js 22 upgrade)
2. **Agent B** — Block 2 (systemInfoService.ts + endpoint)
3. **Agent C** — Block 3 (frontend table + i18n) — depends on Block 2 API contract (can start from the interface definition above)
4. **Agent D** — Block 4 (documentation)

Final integration: main agent merges changes, runs full build + health check, commits, pushes to develop.
