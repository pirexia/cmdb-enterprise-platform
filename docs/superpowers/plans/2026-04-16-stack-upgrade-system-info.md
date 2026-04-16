# Stack Upgrade & Dynamic System Info — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade all platform dependencies to latest stable supported versions and replace the static System Information table in Settings → Integrations with a live 5-column table (component, version, EOL date, license, status) backed by a new `/api/system-info` endpoint that queries endoflife.date.

**Architecture:** New `backend/src/services/systemInfoService.ts` detects installed versions at runtime, queries `endoflife.date` with 24h in-memory cache, and returns structured data to a new admin-only `GET /api/system-info` endpoint. Frontend replaces hardcoded `<dl>` with a `<table>` that fetches from that endpoint and renders status badges. Node.js 20 is upgraded to 22 (EOL 30 Apr 2026 — critical).

**Tech Stack:** Node.js 22-alpine, Express 5, Prisma 5, Next.js 16, TypeScript 5, nginx 1.27+, native `fetch` (Node 22), Tailwind CSS 4.

---

## Files map

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `backend/Dockerfile` | node:20-alpine → node:22-alpine (2 stages) |
| Modify | `frontend/Dockerfile` | node:20-alpine → node:22-alpine (3 stages) |
| Modify | `backend/package.json` | bump outdated packages |
| Modify | `frontend/package.json` | bump outdated packages |
| Modify | `docker-compose.yml` | add `NGINX_VERSION` env var to backend service |
| Modify | `docker-compose.prod.yml` | add `NGINX_VERSION` env var to backend service |
| **Create** | `backend/src/services/systemInfoService.ts` | version detection + endoflife.date cache + data model |
| Modify | `backend/src/index.ts` | add `import` + `GET /api/system-info` endpoint (~line 18 import, ~line 483 route) |
| Modify | `frontend/locales/es.json` | add `settings.integrations.sys_*` keys |
| Modify | `frontend/locales/en.json` | same |
| Modify | `frontend/locales/de.json` | same |
| Modify | `frontend/locales/pt.json` | same |
| Modify | `frontend/locales/fr.json` | same |
| Modify | `frontend/locales/it.json` | same |
| Modify | `frontend/app/settings/page.tsx` | replace static `<dl>` (lines 479–503) with dynamic table |
| Modify | `docs/ARCHITECTURE.md` | verify/complete nginx section, add stack table |
| Modify | `docs/ARCHITECTURE.en.md` | same in English |
| Modify | `docs/SYSADMIN_MANUAL.md` | Node.js 22 note, stack version table, nginx section |
| Modify | `docs/SYSADMIN_MANUAL.en.md` | same in English |
| Modify | `docs/USER_MANUAL.md` | describe new System Info table and badge meanings |
| Modify | `docs/USER_MANUAL.en.md` | same in English |
| Modify | `README.md` | update Node.js version reference (20 → 22) |
| Modify | `README.en.md` | same in English |

---

## Task 1: Upgrade Node.js 20 → 22 in Dockerfiles

**Files:**
- Modify: `backend/Dockerfile`
- Modify: `frontend/Dockerfile`

- [ ] **Step 1: Update backend/Dockerfile — both stages**

Open `backend/Dockerfile`. Change every `FROM node:20-alpine` to `FROM node:22-alpine`. There are 2 occurrences (builder and runner stages):

```dockerfile
# Stage 1
FROM node:22-alpine AS builder

# Stage 2
FROM node:22-alpine AS runner
```

- [ ] **Step 2: Update frontend/Dockerfile — all three stages**

Open `frontend/Dockerfile`. Change every `FROM node:20-alpine` to `FROM node:22-alpine`. There are 3 occurrences (deps, builder, runner stages):

```dockerfile
FROM node:22-alpine AS deps

FROM node:22-alpine AS builder

FROM node:22-alpine AS runner
```

- [ ] **Step 3: Commit**

```bash
git add backend/Dockerfile frontend/Dockerfile
git commit -m "chore(docker): upgrade base image node:20-alpine → node:22-alpine

Node.js 20 maintenance ends 2026-04-30. Node.js 22 is the current LTS."
```

---

## Task 2: Audit and upgrade backend npm packages

**Files:**
- Modify: `backend/package.json`

- [ ] **Step 1: Check what is outdated**

```bash
sg docker -c "docker exec cmdb-backend npm outdated"
```

Note every package listed. Pay special attention to `multer` (currently `1.4.5-lts.1` — legacy branch) and `@types/node` (needs bump to ^22 for Node 22 fetch types).

- [ ] **Step 2: Upgrade @types/node to ^22**

In `backend/package.json`, change:
```json
"@types/node": "^20.11.24",
```
to:
```json
"@types/node": "^22",
```

- [ ] **Step 3: Check multer 2.x availability and upgrade**

Run:
```bash
sg docker -c "docker exec cmdb-backend npm info multer versions --json" | tail -5
```

If a stable `2.x` version exists:
- Read the changelog at https://github.com/expressjs/multer/blob/master/CHANGELOG.md
- If the storage API (`multer.diskStorage`, `req.file`, `req.files`) is backward compatible, update `package.json`:
  ```json
  "multer": "^2.0.0",
  ```
- If there are breaking changes that would require significant refactor, update to latest `1.x` LTS instead:
  ```json
  "multer": "^1.4.5-lts.1",
  ```
  And add a comment in `SYSADMIN_MANUAL.md` under known pending upgrades.

- [ ] **Step 4: Bump remaining outdated packages**

For each package reported by `npm outdated` in Step 1, update its version range in `backend/package.json` to `^{latest_major}.0.0` unless that major version has breaking changes (check npm changelog). For security libraries (`helmet`, `jsonwebtoken`, `bcrypt`, `express-rate-limit`), always take the latest stable.

- [ ] **Step 5: Reinstall dependencies inside container**

```bash
sg docker -c "docker exec cmdb-backend npm install"
```

- [ ] **Step 6: TypeScript check — 0 new errors**

```bash
cd backend && npx tsc --noEmit 2>&1 | grep -v "Property 'license' does not exist\|Property 'licenseUser' does not exist"
```

Expected: no output (0 new errors). If there are new errors, fix them before proceeding.

- [ ] **Step 7: Commit**

```bash
git add backend/package.json
git commit -m "chore(deps): upgrade backend npm packages to latest stable"
```

---

## Task 3: Audit and upgrade frontend npm packages

**Files:**
- Modify: `frontend/package.json`

- [ ] **Step 1: Check what is outdated**

```bash
sg docker -c "docker exec cmdb-frontend npm outdated"
```

Note every package listed.

- [ ] **Step 2: Bump outdated packages**

For each package reported, update its version range in `frontend/package.json` to `^{latest_major}.0.0`. Pay attention to:
- `reactflow` (currently `^11.11.4`) — check if v12 exists and is stable
- `lucide-react` (currently `^0.577.0`) — follow semver; icon names occasionally change
- `xlsx` (currently `^0.18.5`) — security-sensitive, take latest

- [ ] **Step 3: TypeScript check**

```bash
cd frontend && npx tsc --noEmit
```

Expected: 0 errors. Fix any new errors before proceeding.

- [ ] **Step 4: Commit**

```bash
git add frontend/package.json
git commit -m "chore(deps): upgrade frontend npm packages to latest stable"
```

---

## Task 4: Add NGINX_VERSION env var to compose files

**Files:**
- Modify: `docker-compose.yml`
- Modify: `docker-compose.prod.yml`

- [ ] **Step 1: Add env var to docker-compose.yml**

In `docker-compose.yml`, under the `backend` service's `environment:` block, add after `ALERT_RECIPIENT`:

```yaml
      # Nginx version — read by systemInfoService for System Info display
      # Update this when changing the nginx image tag
      NGINX_VERSION: "1.27"
```

- [ ] **Step 2: Add env var to docker-compose.prod.yml**

In `docker-compose.prod.yml`, under the `backend` service's `environment:` block, add after `ALERT_RECIPIENT`:

```yaml
      # Nginx version — read by systemInfoService for System Info display
      # Update this when changing the nginx image tag
      NGINX_VERSION: "1.27"
```

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml docker-compose.prod.yml
git commit -m "chore(config): expose NGINX_VERSION env var to backend for system info endpoint"
```

---

## Task 5: Create systemInfoService.ts

**Files:**
- Create: `backend/src/services/systemInfoService.ts`

- [ ] **Step 1: Create the service file**

Create `backend/src/services/systemInfoService.ts` with the following complete content:

```typescript
// backend/src/services/systemInfoService.ts
//
// Builds a live snapshot of the platform's tech stack:
//  - Versions detected at runtime from process + node_modules
//  - EOL dates fetched from endoflife.date (cached 24h)
//  - License types are static (update manually when adding new deps)
//
// Frontend-only packages (Next.js, React, Tailwind CSS) are hardcoded here
// because they are not installed in the backend container.
// ⚠️  UPDATE FRONTEND_VERSIONS whenever you bump frontend/package.json.

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

// ── Types ──────────────────────────────────────────────────────────────────────

interface EolApiResponse {
  cycle:              string;
  releaseDate:        string;
  eol:                string | boolean;
  latest:             string;
  latestReleaseDate:  string;
  lts?:               string | boolean;
  support?:           string | boolean;
}

export interface StackComponent {
  name:           string;
  category:       string;
  version:        string;
  latestVersion?: string;
  eolDate?:       string | boolean;   // ISO date | false (no EOL) | undefined (no data)
  isEol:          boolean;
  daysToEol?:     number;             // negative = already past EOL
  license:        string;
  hasEolData:     boolean;
}

export interface SystemInfoResponse {
  components:   StackComponent[];
  generatedAt:  string;
}

// ── Static maps ────────────────────────────────────────────────────────────────

// Products with pages on endoflife.date → product slug
const EOL_PRODUCTS: Record<string, string> = {
  'Node.js':    'nodejs',
  'PostgreSQL': 'postgresql',
  'nginx':      'nginx',
  'Next.js':    'nextjs',
};

const LICENSE_MAP: Record<string, string> = {
  'Node.js':      'MIT',
  'Express':      'MIT',
  'Next.js':      'MIT',
  'React':        'MIT',
  'PostgreSQL':   'PostgreSQL License',
  'nginx':        'BSD-2-Clause',
  'Prisma':       'Apache 2.0',
  'TypeScript':   'Apache 2.0',
  'Tailwind CSS': 'MIT',
  'Zod':          'MIT',
  'Helmet':       'MIT',
  'jsonwebtoken': 'MIT',
  'bcrypt':       'MIT',
  'node-cron':    'MIT',
  'nodemailer':   'MIT',
  'multer':       'MIT',
};

// ⚠️  Keep in sync with frontend/package.json
const FRONTEND_VERSIONS: Record<string, string> = {
  'Next.js':      '16.1.6',
  'React':        '19.2.3',
  'Tailwind CSS': '4.x',
};

// ── Cache ──────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
let systemInfoCache: { data: SystemInfoResponse; fetchedAt: number } | null = null;

export function clearSystemInfoCache(): void {
  systemInfoCache = null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function readPkgVersion(pkgName: string): string {
  try {
    const pkgPath = path.join(process.cwd(), 'node_modules', pkgName, 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    return (JSON.parse(raw) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function fetchEolCycle(product: string, cycle: string): Promise<EolApiResponse | null> {
  try {
    const res = await fetch(`https://endoflife.date/api/${product}/${cycle}.json`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return await res.json() as EolApiResponse;
  } catch {
    return null;
  }
}

function extractCycle(name: string, version: string): string {
  if (!version || version === 'unknown') return 'unknown';
  const v = version.replace(/^v/, '');
  const parts = v.split('.');
  // nginx uses major.minor as cycle (e.g. "1.27")
  if (name === 'nginx') return `${parts[0]}.${parts[1]}`;
  // All others use major only (e.g. "22", "16")
  return parts[0];
}

function daysUntil(dateStr: string): number {
  return Math.floor((new Date(dateStr).getTime() - Date.now()) / 86_400_000);
}

async function getPostgresVersion(prisma: PrismaClient): Promise<string> {
  try {
    const rows = await prisma.$queryRaw<Array<{ version: string }>>`SELECT version()`;
    // "PostgreSQL 16.2 on x86_64-pc-linux-gnu..." → "16.2"
    const match = rows[0]?.version.match(/PostgreSQL (\d+\.\d+)/);
    return match ? match[1] : 'unknown';
  } catch {
    return 'unknown';
  }
}

// ── Main export ────────────────────────────────────────────────────────────────

export async function getSystemInfo(prisma: PrismaClient): Promise<SystemInfoResponse> {
  // Return cached data if still fresh
  if (systemInfoCache && Date.now() - systemInfoCache.fetchedAt < CACHE_TTL_MS) {
    return systemInfoCache.data;
  }

  const postgresVersion = await getPostgresVersion(prisma);

  const defs: Array<{ name: string; category: string; version: string }> = [
    { name: 'Node.js',      category: 'Runtime',   version: process.version.replace(/^v/, '') },
    { name: 'PostgreSQL',   category: 'Database',  version: postgresVersion },
    { name: 'nginx',        category: 'Gateway',   version: process.env.NGINX_VERSION ?? 'unknown' },
    { name: 'Express',      category: 'Framework', version: readPkgVersion('express') },
    { name: 'Prisma',       category: 'ORM',       version: readPkgVersion('@prisma/client') },
    { name: 'Next.js',      category: 'Framework', version: FRONTEND_VERSIONS['Next.js'] },
    { name: 'React',        category: 'Framework', version: FRONTEND_VERSIONS['React'] },
    { name: 'TypeScript',   category: 'Language',  version: readPkgVersion('typescript') },
    { name: 'Tailwind CSS', category: 'Library',   version: FRONTEND_VERSIONS['Tailwind CSS'] },
    { name: 'Zod',          category: 'Library',   version: readPkgVersion('zod') },
    { name: 'Helmet',       category: 'Library',   version: readPkgVersion('helmet') },
    { name: 'jsonwebtoken', category: 'Library',   version: readPkgVersion('jsonwebtoken') },
    { name: 'bcrypt',       category: 'Library',   version: readPkgVersion('bcrypt') },
    { name: 'node-cron',    category: 'Library',   version: readPkgVersion('node-cron') },
    { name: 'nodemailer',   category: 'Library',   version: readPkgVersion('nodemailer') },
    { name: 'multer',       category: 'Library',   version: readPkgVersion('multer') },
  ];

  const components: StackComponent[] = await Promise.all(
    defs.map(async (def): Promise<StackComponent> => {
      const license   = LICENSE_MAP[def.name] ?? 'MIT';
      const eolSlug   = EOL_PRODUCTS[def.name];

      // No endoflife.date page for this component
      if (!eolSlug || def.version === 'unknown') {
        return { ...def, license, hasEolData: false, isEol: false };
      }

      const cycle = extractCycle(def.name, def.version);
      if (cycle === 'unknown') {
        return { ...def, license, hasEolData: false, isEol: false };
      }

      const eolData = await fetchEolCycle(eolSlug, cycle);
      if (!eolData) {
        return { ...def, license, hasEolData: false, isEol: false };
      }

      const eolDate  = eolData.eol;
      let isEol      = false;
      let daysToEol: number | undefined;

      if (typeof eolDate === 'string') {
        daysToEol = daysUntil(eolDate);
        isEol     = daysToEol < 0;
      } else if (eolDate === true) {
        isEol = true;
      }

      return {
        ...def,
        latestVersion: eolData.latest,
        eolDate,
        isEol,
        daysToEol,
        license,
        hasEolData: true,
      };
    })
  );

  const result: SystemInfoResponse = { components, generatedAt: new Date().toISOString() };
  systemInfoCache = { data: result, fetchedAt: Date.now() };
  return result;
}
```

- [ ] **Step 2: TypeScript check — 0 new errors**

```bash
cd backend && npx tsc --noEmit 2>&1 | grep -v "Property 'license' does not exist\|Property 'licenseUser' does not exist"
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/systemInfoService.ts
git commit -m "feat(backend): add systemInfoService with endoflife.date integration and 24h cache"
```

---

## Task 6: Add GET /api/system-info endpoint to index.ts

**Files:**
- Modify: `backend/src/index.ts`

- [ ] **Step 1: Add import at line ~18** (after existing service imports)

In `backend/src/index.ts`, after the line:
```typescript
import { lookupEolWithFallbacks, fetchProductCycles } from './services/eolService';
```

Add:
```typescript
import { getSystemInfo } from './services/systemInfoService';
```

- [ ] **Step 2: Add endpoint after /api/health (around line 483)**

In `backend/src/index.ts`, after:
```typescript
app.get('/api/health', healthHandler);
```

Add:
```typescript
// ── System info (admin only) ──────────────────────────────────────────────────
app.get('/api/system-info', authenticateToken, requireAdmin, async (_req: Request, res: Response) => {
  try {
    const info = await getSystemInfo(prisma);
    res.json(info);
  } catch (err) {
    console.error('[system-info]', err);
    res.status(500).json({ error: 'Failed to retrieve system information' });
  }
});
```

- [ ] **Step 3: TypeScript check — 0 new errors**

```bash
cd backend && npx tsc --noEmit 2>&1 | grep -v "Property 'license' does not exist\|Property 'licenseUser' does not exist"
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add backend/src/index.ts
git commit -m "feat(api): add GET /api/system-info endpoint (admin only)"
```

---

## Task 7: Rebuild containers and verify endpoint

**Files:** none (runtime verification)

- [ ] **Step 1: Full rebuild**

```bash
sg docker -c "docker compose down && docker compose up -d --build"
```

Wait for all containers to be healthy (≈60s).

- [ ] **Step 2: Health check**

```bash
curl -sk https://localhost/api/health
```

Expected: `{"status":"ok"}` or similar.

- [ ] **Step 3: Test system-info endpoint**

First, get a valid admin JWT (replace credentials with your admin user):
```bash
TOKEN=$(curl -sk -X POST https://localhost/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"YOUR_ADMIN_PASSWORD"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
```

Then call the endpoint:
```bash
curl -sk https://localhost/api/system-info \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool | head -60
```

Expected: JSON with `components` array of 16 items. Verify:
- `Node.js` version starts with `22.`
- `PostgreSQL` version shows real DB version (e.g. `16.2`)
- `nginx` version shows `1.27`
- `hasEolData: true` for Node.js, PostgreSQL, nginx, Next.js
- `hasEolData: false` for Express, React, Prisma, TypeScript, etc.

- [ ] **Step 4: No commit needed** — this is a verification task.

---

## Task 8: Add i18n keys to all 6 locale files

**Files:**
- Modify: `frontend/locales/es.json`
- Modify: `frontend/locales/en.json`
- Modify: `frontend/locales/de.json`
- Modify: `frontend/locales/pt.json`
- Modify: `frontend/locales/fr.json`
- Modify: `frontend/locales/it.json`

- [ ] **Step 1: Update es.json**

In `frontend/locales/es.json`, find the `settings.integrations` block (around line 485). Add these keys at the end of the block, before the closing `}`:

```json
      "sys_col_component": "Componente",
      "sys_col_version": "Versión",
      "sys_col_eol": "Fin de soporte",
      "sys_col_license": "Licencia",
      "sys_col_status": "Estado",
      "sys_status_active": "Activo",
      "sys_status_eol_soon": "Próximo EOL",
      "sys_status_eol": "Sin soporte",
      "sys_status_community": "Comunidad",
      "sys_eol_unknown": "—",
      "sys_loading": "Cargando información del sistema…",
      "sys_error": "No se pudo cargar la información del sistema.",
      "sys_retry": "Reintentar"
```

- [ ] **Step 2: Update en.json** — same location:

```json
      "sys_col_component": "Component",
      "sys_col_version": "Version",
      "sys_col_eol": "End of Support",
      "sys_col_license": "License",
      "sys_col_status": "Status",
      "sys_status_active": "Active",
      "sys_status_eol_soon": "EOL Soon",
      "sys_status_eol": "No Support",
      "sys_status_community": "Community",
      "sys_eol_unknown": "—",
      "sys_loading": "Loading system information…",
      "sys_error": "Could not load system information.",
      "sys_retry": "Retry"
```

- [ ] **Step 3: Update de.json** — same location:

```json
      "sys_col_component": "Komponente",
      "sys_col_version": "Version",
      "sys_col_eol": "Support-Ende",
      "sys_col_license": "Lizenz",
      "sys_col_status": "Status",
      "sys_status_active": "Aktiv",
      "sys_status_eol_soon": "EOL bald",
      "sys_status_eol": "Kein Support",
      "sys_status_community": "Community",
      "sys_eol_unknown": "—",
      "sys_loading": "Systeminformationen werden geladen…",
      "sys_error": "Systeminformationen konnten nicht geladen werden.",
      "sys_retry": "Erneut versuchen"
```

- [ ] **Step 4: Update pt.json** — same location:

```json
      "sys_col_component": "Componente",
      "sys_col_version": "Versão",
      "sys_col_eol": "Fim do suporte",
      "sys_col_license": "Licença",
      "sys_col_status": "Estado",
      "sys_status_active": "Ativo",
      "sys_status_eol_soon": "EOL próximo",
      "sys_status_eol": "Sem suporte",
      "sys_status_community": "Comunidade",
      "sys_eol_unknown": "—",
      "sys_loading": "Carregando informações do sistema…",
      "sys_error": "Não foi possível carregar as informações do sistema.",
      "sys_retry": "Tentar novamente"
```

- [ ] **Step 5: Update fr.json** — same location:

```json
      "sys_col_component": "Composant",
      "sys_col_version": "Version",
      "sys_col_eol": "Fin du support",
      "sys_col_license": "Licence",
      "sys_col_status": "Statut",
      "sys_status_active": "Actif",
      "sys_status_eol_soon": "EOL proche",
      "sys_status_eol": "Sans support",
      "sys_status_community": "Communauté",
      "sys_eol_unknown": "—",
      "sys_loading": "Chargement des informations système…",
      "sys_error": "Impossible de charger les informations système.",
      "sys_retry": "Réessayer"
```

- [ ] **Step 6: Update it.json** — same location:

```json
      "sys_col_component": "Componente",
      "sys_col_version": "Versione",
      "sys_col_eol": "Fine supporto",
      "sys_col_license": "Licenza",
      "sys_col_status": "Stato",
      "sys_status_active": "Attivo",
      "sys_status_eol_soon": "EOL prossimo",
      "sys_status_eol": "Nessun supporto",
      "sys_status_community": "Community",
      "sys_eol_unknown": "—",
      "sys_loading": "Caricamento informazioni di sistema…",
      "sys_error": "Impossibile caricare le informazioni di sistema.",
      "sys_retry": "Riprova"
```

- [ ] **Step 7: Commit**

```bash
git add frontend/locales/
git commit -m "feat(i18n): add system info table keys to all 6 locale files"
```

---

## Task 9: Update settings/page.tsx with dynamic System Info table

**Files:**
- Modify: `frontend/app/settings/page.tsx`

- [ ] **Step 1: Add StackComponent type and state — top of file**

After the existing `type TabId` line (around line 26), add:

```typescript
interface StackComponent {
  name:           string;
  category:       string;
  version:        string;
  latestVersion?: string;
  eolDate?:       string | boolean;
  isEol:          boolean;
  daysToEol?:     number;
  license:        string;
  hasEolData:     boolean;
}

interface SystemInfoData {
  components:   StackComponent[];
  generatedAt:  string;
}
```

- [ ] **Step 2: Add state variables**

Inside the main component function, after the existing state declarations, add:

```typescript
const [sysInfo, setSysInfo]         = useState<SystemInfoData | null>(null);
const [sysInfoLoading, setSysInfoLoading] = useState(false);
const [sysInfoError, setSysInfoError]     = useState(false);
```

- [ ] **Step 3: Add fetch effect**

After the existing `useEffect` hooks (but still inside the component), add:

```typescript
useEffect(() => {
  if (tab !== 'integrations' || sysInfo !== null) return;
  setSysInfoLoading(true);
  setSysInfoError(false);
  apiFetch('/api/system-info')
    .then(r => r.json())
    .then((data: SystemInfoData) => setSysInfo(data))
    .catch(() => setSysInfoError(true))
    .finally(() => setSysInfoLoading(false));
}, [tab, sysInfo]);
```

- [ ] **Step 4: Add badge helper function**

After the `Toggle` sub-component (around line 50), add:

```typescript
function SysStatusBadge({ c }: { c: StackComponent }) {
  if (!c.hasEolData) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
        <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
        Community
      </span>
    );
  }
  if (c.isEol) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
        <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
        Sin soporte
      </span>
    );
  }
  if (typeof c.daysToEol === 'number' && c.daysToEol <= 90) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
        Próximo EOL
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
      <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
      Activo
    </span>
  );
}
```

**Note:** The badge text is hardcoded here because `SysStatusBadge` is a sub-component defined outside the main component and cannot call `useLanguage()`. If full i18n on the badges is needed in the future, pass the translated strings as props. For now this is consistent with other hardcoded UI strings in this file.

- [ ] **Step 5: Replace the static System Info section**

Locate and replace the entire `{/* System Info */}` block (lines 479–503, the `<div>` containing the `<dl>`):

Replace this block:
```tsx
            {/* System Info */}
            <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
              <div className="border-b border-slate-100 px-6 py-4 bg-slate-50">
                <p className="text-sm font-semibold text-slate-700">Información del Sistema</p>
              </div>
              <div className="px-6 py-4">
                <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-sm">
                  {[
                    ["Plataforma",        "CMDB Enterprise Platform"],
                    ["Stack Backend",     "Node.js + Express + Prisma ORM"],
                    ["Stack Frontend",    "Next.js 16 + Tailwind CSS 4"],
                    ["Base de datos",     "PostgreSQL 16"],
                    ["Autenticación",     "JWT HS256 (8h) + MFA TOTP"],
                    ["Seguridad",         "Helmet + CORS estricto + HTTPS opcional"],
                    ["Alertas",           "node-cron + nodemailer (SMTP)"],
                    ["Cumplimiento",      "ISO 27001 A.9.2 / A.10.1 / A.12.4"],
                  ].map(([k, v]) => (
                    <div key={k} className="flex justify-between border-b border-slate-50 pb-2">
                      <dt className="text-slate-500 font-medium">{k}</dt>
                      <dd className="text-slate-800 text-right">{v}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
```

With this new block:
```tsx
            {/* System Info — dynamic table */}
            <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200 overflow-hidden">
              <div className="border-b border-slate-100 px-6 py-4 bg-slate-50 flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-700">{t("settings.integrations.system_info")}</p>
                {sysInfo && (
                  <span className="text-xs text-slate-400">
                    {new Date(sysInfo.generatedAt).toLocaleString()}
                  </span>
                )}
              </div>

              {sysInfoLoading && (
                <div className="flex items-center justify-center gap-2 py-8 text-sm text-slate-400">
                  <RefreshCw className="h-4 w-4 animate-spin" />
                  {t("settings.integrations.sys_loading")}
                </div>
              )}

              {sysInfoError && (
                <div className="flex items-center justify-between px-6 py-4">
                  <p className="text-sm text-red-600">{t("settings.integrations.sys_error")}</p>
                  <button
                    onClick={() => {
                      setSysInfo(null);
                      setSysInfoError(false);
                      setSysInfoLoading(true);
                      apiFetch('/api/system-info')
                        .then(r => r.json())
                        .then((data: SystemInfoData) => setSysInfo(data))
                        .catch(() => setSysInfoError(true))
                        .finally(() => setSysInfoLoading(false));
                    }}
                    className="text-xs font-medium text-indigo-600 hover:underline"
                  >
                    {t("settings.integrations.sys_retry")}
                  </button>
                </div>
              )}

              {sysInfo && !sysInfoLoading && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-slate-100 bg-slate-50">
                        <th className="px-4 py-2 text-left font-semibold text-slate-500">{t("settings.integrations.sys_col_component")}</th>
                        <th className="px-4 py-2 text-left font-semibold text-slate-500">{t("settings.integrations.sys_col_version")}</th>
                        <th className="px-4 py-2 text-left font-semibold text-slate-500">{t("settings.integrations.sys_col_eol")}</th>
                        <th className="px-4 py-2 text-left font-semibold text-slate-500">{t("settings.integrations.sys_col_license")}</th>
                        <th className="px-4 py-2 text-left font-semibold text-slate-500">{t("settings.integrations.sys_col_status")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sysInfo.components.map((c) => (
                        <tr key={c.name} className="border-b border-slate-50 hover:bg-slate-50 transition-colors">
                          <td className="px-4 py-2.5 font-medium text-slate-800">
                            {c.name}
                            <span className="ml-1.5 text-slate-400 font-normal">{c.category}</span>
                          </td>
                          <td className="px-4 py-2.5 font-mono text-slate-700">{c.version}</td>
                          <td className="px-4 py-2.5 text-slate-600">
                            {typeof c.eolDate === 'string'
                              ? c.eolDate
                              : t("settings.integrations.sys_eol_unknown")}
                          </td>
                          <td className="px-4 py-2.5 text-slate-600">{c.license}</td>
                          <td className="px-4 py-2.5">
                            <SysStatusBadge c={c} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
```

- [ ] **Step 6: TypeScript check**

```bash
cd frontend && npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/settings/page.tsx
git commit -m "feat(ui): replace static system info list with dynamic 5-column table"
```

---

## Task 10: Update documentation

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/ARCHITECTURE.en.md`
- Modify: `docs/SYSADMIN_MANUAL.md`
- Modify: `docs/SYSADMIN_MANUAL.en.md`
- Modify: `docs/USER_MANUAL.md`
- Modify: `docs/USER_MANUAL.en.md`

- [ ] **Step 1: Read current ARCHITECTURE.md** and verify the following items are present and accurate. Add any missing ones:

  - Architecture diagram showing nginx as TLS gateway (not optional HTTPS)
  - Stack table including nginx 1.27 with `BSD-2-Clause` license
  - Note that `NEXT_PUBLIC_API_URL` equals `FRONTEND_URL` (same nginx host)
  - Note that backend and frontend have no host port bindings in production

- [ ] **Step 2: Read current ARCHITECTURE.en.md** and apply the same verification + additions in English.

- [ ] **Step 3: Update SYSADMIN_MANUAL.md** — add or update the following sections:
  - **Versiones del stack** table: add Node.js 22 (EOL Apr 2027), nginx 1.27 (BSD-2-Clause), PostgreSQL 16 (EOL Nov 2028)
  - **Upgrade de Node.js**: note that the platform migrated from Node.js 20 to 22 in v1.8.0 due to impending EOL; to upgrade in future, change `FROM node:XX-alpine` in both Dockerfiles
  - **nginx**: brief section on the nginx gateway, config files location (`nginx/nginx.conf`, `nginx/conf.d/`), and the `NGINX_VERSION` env var that feeds the System Info display

- [ ] **Step 4: Update SYSADMIN_MANUAL.en.md** — same changes in English.

- [ ] **Step 5: Update USER_MANUAL.md** — in the Settings section, add description of the **Información del Sistema** table:
  - Columns: Component, Version, End of Support, License, Status
  - Status badges: green = Active (supported), amber = EOL Soon (≤90 days), red = No Support, grey = Community (no formal EOL policy)
  - Data is refreshed from endoflife.date every 24h

- [ ] **Step 6: Update USER_MANUAL.en.md** — same in English.

- [ ] **Step 7: Update README.md** — find the line that references "Node.js 20" and update it to "Node.js 22". The line is near the top of the file in the tech stack summary.

- [ ] **Step 8: Update README.en.md** — same change in the English README.

- [ ] **Step 9: Commit**

```bash
git add docs/ARCHITECTURE.md docs/ARCHITECTURE.en.md \
        docs/SYSADMIN_MANUAL.md docs/SYSADMIN_MANUAL.en.md \
        docs/USER_MANUAL.md docs/USER_MANUAL.en.md \
        README.md README.en.md
git commit -m "docs: update architecture, sysadmin, user manuals and READMEs for v1.8.0 stack upgrade"
```

---

## Task 11: Final integration test and push to develop

**Files:** none (verification + git push)

- [ ] **Step 1: Full rebuild with all changes**

```bash
sg docker -c "docker compose down && docker compose up -d --build"
```

- [ ] **Step 2: Health check**

```bash
curl -sk https://localhost/api/health
```

Expected: `{"status":"ok"}` (or equivalent healthy response).

- [ ] **Step 3: TypeScript gate — backend**

```bash
cd backend && npx tsc --noEmit 2>&1 | grep -v "Property 'license' does not exist\|Property 'licenseUser' does not exist"
```

Expected: no output.

- [ ] **Step 4: TypeScript gate — frontend**

```bash
cd frontend && npx tsc --noEmit
```

Expected: no output.

- [ ] **Step 5: Verify system-info endpoint**

```bash
TOKEN=$(curl -sk -X POST https://localhost/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"YOUR_ADMIN_PASSWORD"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

curl -sk https://localhost/api/system-info \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool | grep -E '"name"|"version"|"isEol"|"hasEolData"'
```

Expected: 16 components, Node.js shows `22.x`, PostgreSQL shows real version, `isEol: false` for all (after Node.js upgrade).

- [ ] **Step 6: Verify non-admin cannot access system-info**

```bash
# Get a viewer JWT (replace with a viewer-role user)
VIEWER_TOKEN=$(curl -sk -X POST https://localhost/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"viewer_user","password":"VIEWER_PASSWORD"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

curl -sk https://localhost/api/system-info \
  -H "Authorization: Bearer $VIEWER_TOKEN" -o /dev/null -w "%{http_code}"
```

Expected: `403`.

- [ ] **Step 7: Manual UI check** — open `https://localhost` in browser, log in as admin, navigate to Settings → Integrations y Sistemas. Confirm:
  - System Info section shows the 5-column table
  - Badges render correctly (green/amber/red/grey)
  - Timestamp shown in header
  - No console errors

- [ ] **Step 8: Push to develop**

```bash
git push origin develop
```
