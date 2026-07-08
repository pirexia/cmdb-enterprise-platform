# PLAN v3.4.4 — Relación `INSTALLED_IN` (Blade Enclosure / Convergentes)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Relación direccional de contenido `source → INSTALLED_IN → target` (blade/módulo → chasis), con unicidad por source, validación por tipo de CI, visualización en detalle de CI, columna+filtro en inventario y en el reporte `inventory`.

**Architecture:** Se reutiliza íntegramente la infraestructura existente de relaciones (`CIRelation` + enum PG `RelationType` + `RELATION_TYPE_MATRIX` espejada backend/frontend + handlers genéricos en `index.ts`). Solo se añaden: 2 migraciones SQL, validaciones específicas de `INSTALLED_IN` en los POST de relaciones, include aplanado en `CI_INCLUDE`/`flattenCI`, sección en `CIDetailModal`, modal `InstallInEnclosureModal`, columna/filtro en inventario y reporte, e i18n ×6.

**Tech Stack:** Express 5 + Prisma 6 + PostgreSQL 16, Next.js 16 App Router (Client Components), Tailwind 4, i18n propio (6 locales JSON).

**Rama:** `feature/v3.4.4-blade-enclosure-relation` (desde `develop`). **NO merge a `main`.**

---

## Hechos descubiertos (análisis Fable, 2026-07-08)

### Códigos reales en BD (vía API `/api/masters/ci-types`)
| Rol | Código CIType | Nombre |
|---|---|---|
| Contenedor (target) | `BLADE_SYSTEM___BLADE_ENCLOSURE` | Blade system / blade enclosure (`isSystem:false`) |
| Contenedor (target) | `CONVERGED_INFRASTRUCTURE` | Converged Infrastructure (`isSystem:false`) |
| Contenido (source) | `PHYSICAL_SERVER`, `STORAGE`, `NETWORK` | Confirmado por el usuario (multiselección) |

### Mapa de código existente
- **Enum:** `backend/prisma/schema.prisma:65-88` (`enum RelationType`, 17 valores). Enum nativo PG (`ci_relations.relation_type`, cast `::"RelationType"` en inserts).
- **Modelo:** `CIRelation` (`schema.prisma:412-428`), `@@unique([sourceCiId, targetCiId, relationType])`; en `CI`: `relationsFrom CIRelation[] @relation("SourceCI")` (L384), `relationsTo` (L385).
- **Catálogo/matriz backend:** `backend/src/relationTypes.ts` — `VALID_RELATION_TYPES`, `RELATION_CATEGORIES`, `RELATION_TYPE_MATRIX`, `validateRelationCiTypes()`. **Espejo obligado** en `frontend/lib/relationTypes.ts` (`RELATION_TYPES`, `RELATION_CATEGORIES`, `CATEGORY_COLORS`, `RELATION_TYPE_MATRIX`, `relationAllowed()`).
- **Handlers (genéricos, en `backend/src/index.ts`):**
  - `GET /api/cis/:id/relations` L2802-2924 — SQL crudo, devuelve `{ outgoing, incoming, all, total }`, filas `RelationRow` snake_case.
  - `POST /api/cis/:id/relations` L2932-2993 y `POST /api/relations` L3001-3061 — validación manual (no Zod): tipo ∈ `VALID_RELATION_TYPES`, no self, matriz vía `validateRelationCiTypes` (422), INSERT...SELECT atómico, dup → 23505 → 409. AuditLog `CREATE_RELATION:<type>` / entity `CI_RELATION`.
  - `DELETE /api/relations/:id` L3068-3096 — AuditLog `DELETE_RELATION`.
- **`CI_INCLUDE`** `index.ts:520-542` + **`flattenCI`** `index.ts:546+` — NO incluye relaciones CI-CI hoy.
- **Migración patrón enum:** `backend/prisma/migrations/20260612170000_relation_types_extended/migration.sql` — `ALTER TYPE "RelationType" ADD VALUE IF NOT EXISTS '...';` (una por línea). Más reciente: `20260621120000_add_notify_channels`.
- **Reporte inventory:** `backend/src/modules/reports/reports/inventory.ts` — `ColSpec {col, select, extract, orderBy?}`, `mergeSelect` dinámico, `filters[]` + `loadFilterOptions(prisma)`, `asArray` en `filterUtils.ts`.
- **Frontend detalle:** `frontend/components/CIDetailModal.tsx` — NO muestra relaciones hoy; patrón `Section` (L142) + `Field`; i18n namespace `ci_detail.*`; patrón DCIM rack en L527-542. **No existe** `app/inventory/[id]/page.tsx` (solo modal).
- **Inventario:** `frontend/app/inventory/page.tsx` — registro `InvCol` (L348-357), `ALL_COLS` useMemo (L527-623), filtros de cabecera hardcodeados en estado `filters` (7 claves) + useMemo `filtered` (L477-518), persistencia `inventory_columns_${userId}`.
- **AddRelationModal:** filtra tipos vía `relationAllowed` → `INSTALLED_IN` aparece automáticamente al registrarlo en la matriz. Sin cambios salvo i18n.
- **Mapa:** `frontend/app/map/page.tsx:86-93` — `RELATION_COLORS` hardcodeado (añadir entrada) + i18n `map.relation_type_*`.
- **i18n:** namespaces reales: `relation.type_*` / `relation.cat_*` (AddRelationModal), `map.relation_type_*` (mapa), `ci_detail.*` (modal detalle), `reports.col.*` / `reports.filter.*` (reportes e inventario).

---

## Decisiones de diseño (Fase Fable)

| # | Decisión | Justificación |
|---|---|---|
| **D1** | **Validación de tipos: matriz hardcodeada** (`RELATION_TYPE_MATRIX`), NO campo nuevo en `CIType` | El mecanismo ya existe exactamente para esto y se usa para las 17 relaciones actuales. Un campo en `CIType` exigiría migración + UI de maestros + sync para una taxonomía estática. YAGNI. Entrada: `INSTALLED_IN: { source: ['PHYSICAL_SERVER','STORAGE','NETWORK'], target: ['BLADE_SYSTEM___BLADE_ENCLOSURE','CONVERGED_INFRASTRUCTURE'] }` |
| **D2** | **Dos migraciones separadas**: (1) `ADD VALUE`, (2) índice único parcial | PG no permite usar un valor de enum nuevo en la misma transacción que lo crea; `prisma migrate deploy` ejecuta cada migración en su propia transacción → separar garantiza seguridad. `ADD VALUE IF NOT EXISTS` es seguro con datos existentes (patrón probado en `20260612170000`) |
| **D3** | **Unicidad por source: doble capa** — check app (409 con mensaje amigable) + índice único parcial en BD (`WHERE relation_type = 'INSTALLED_IN'`) | A01: enforcement a nivel BD, no solo aplicación. El check app da UX; el índice es el backstop contra race conditions |
| **D4** | **Estado del contenedor**: al crear, target con `status = 'RETIRADO'` → 422. Si un chasis pasa a RETIRADO después, NO se propaga estado (peligroso/irreversible); el detalle del CI contenido muestra **badge de advertencia** (amber) | Cumple la regla de ciclo de vida del spec sin efectos colaterales destructivos. Requiere exponer `status` de los endpoints en el GET de relaciones (columnas `source_status`/`target_status` añadidas al SQL) |
| **D5** | **Sin endpoints nuevos** | `GET /api/cis/:id/relations` ya devuelve incoming (contenidos) y outgoing (contenedor) con nombres/slugs; `POST /api/relations` + `DELETE /api/relations/:id` cubren instalar/desinstalar; la lista de enclosures activos se obtiene con `fetchAllCIs` + filtro cliente (patrón de `AddRelationModal`). Menos superficie de ataque, menos código. *(Desviación consciente de Tarea B.6/B.7 del prompt: los endpoints pedidos ya existen de facto.)* |
| **D6** | **`CI_INCLUDE` + `flattenCI`**: incluir `relationsFrom` filtrado a `INSTALLED_IN` y aplanar a `installedInId/installedInName/installedInStatus/installedInRelationId` | Alimenta columna de inventario y sección del detalle sin N+1; join indexado por `@@index([sourceCiId])` |
| **D7** | **Componente "Blade Slots": DIFERIDO** (futura versión) | No existe modelo de datos de bahía/slot (ni campo de posición en `CIRelation`). Hacerlo bien exige schema nuevo (nº slot, tamaño, validación de solapes tipo DCIM U-slots). Fuera de alcance v3.4.4 |
| **D8** | **Reporte inventory**: `ColSpec` custom no-sortable (`relationsFrom[0].targetCI.name`) + filtro multi-select dinámico (`loadFilterOptions` lista CIs de tipos contenedores) aplicado con `relationsFrom: { some: {...} }` | Ordenar por relación filtrada no es expresable en `orderBy` Prisma simple → columna no sortable (aceptable) |
| **D9** | **Claves i18n según convenciones reales de la casa** (no las sugeridas literales del prompt): `relation.type_INSTALLED_IN`, `map.relation_type_INSTALLED_IN`, `ci_detail.*`, `reports.col.installedIn`, `reports.filter.installedIn` | Los namespaces `relations.type.X` / `ci.detail.*` del prompt no existen; usar los reales evita duplicidad |
| **D10** | **Categoría de relación**: `structural` (junto a CONTAINS/ATTACHED_TO), color heredado indigo | Coherencia semántica y visual en mapa y modal |
| **D11** | **Sin worktree**: trabajar en el checkout principal sobre la feature branch | La verificación exige reconstruir contenedores desde este directorio (podman-compose usa el contexto del repo) |

## Global Constraints

- Conventional Commits; al menos 1 commit por tarea. Rama `feature/v3.4.4-blade-enclosure-relation`. NO merge a `main`.
- `npx tsc --noEmit` limpio en backend y frontend (ignorar pre-existentes `Property 'license'`/`Property 'licenseUser'`).
- NO `prisma migrate dev`; solo migración manual + `prisma migrate deploy` dentro del contenedor.
- Toda escritura → AuditLog (ya cubierto por handlers existentes). Errores API genéricos, sin stack traces.
- i18n: toda cadena nueva vía `t("key")` y presente en los 6 locales (`es,en,de,pt,fr,it`).
- Estética: patrón canónico de la casa (`rounded-none`, `ring-1 ring-slate-200`, ver CLAUDE.md).
- Backend y frontend `relationTypes.ts` DEBEN quedar en sync (comentario L2 de ambos).
- Documentar cada acción en `docs/EXECUTION_LOG.md` y estado en `docs/PLAN_STATUS_v3.4.4.md`.

---

### Task 1: Backend core — enum, matriz, validaciones, include

**Files:**
- Create: `backend/prisma/migrations/20260708090000_relation_type_installed_in/migration.sql`
- Create: `backend/prisma/migrations/20260708090100_installed_in_unique_source/migration.sql`
- Modify: `backend/prisma/schema.prisma:65-88` (enum)
- Modify: `backend/src/relationTypes.ts` (VALID + categories + matrix)
- Modify: `backend/src/index.ts` — `CI_INCLUDE` (L520), `flattenCI` (L546), GET relations (L2802-2924), POST ×2 (L2932, L3001)

**Interfaces (produce):**
- Campos aplanados en respuesta `/api/cis`: `installedInId: string|null`, `installedInName: string|null`, `installedInStatus: string|null`, `installedInRelationId: string|null`
- `GET /api/cis/:id/relations`: filas ganan `source_status`, `target_status` (string)
- Constantes exportadas en `backend/src/relationTypes.ts`: `INSTALLED_IN_SOURCE_TYPES`, `INSTALLED_IN_TARGET_TYPES`

- [ ] **Step 1.1 — Migración 1** (`20260708090000_relation_type_installed_in/migration.sql`):
```sql
-- v3.4.4: INSTALLED_IN relation type (blade/module → enclosure/converged)
ALTER TYPE "RelationType" ADD VALUE IF NOT EXISTS 'INSTALLED_IN';
```
- [ ] **Step 1.2 — Migración 2** (`20260708090100_installed_in_unique_source/migration.sql`):
```sql
-- v3.4.4: a CI can be INSTALLED_IN at most one container (DB-level backstop)
CREATE UNIQUE INDEX IF NOT EXISTS "ci_relations_installed_in_source_unique"
  ON "ci_relations" ("source_ci_id")
  WHERE "relation_type" = 'INSTALLED_IN';
```
- [ ] **Step 1.3 — schema.prisma**: añadir al final del enum (tras `MANAGES`):
```prisma
  // ── v3.4.4 — Containment ──
  INSTALLED_IN       // Source is installed inside target (e.g., Blade Server → Blade Enclosure)
```
- [ ] **Step 1.4 — `backend/src/relationTypes.ts`**: añadir `'INSTALLED_IN'` a `VALID_RELATION_TYPES`; `INSTALLED_IN: 'structural'` en `RELATION_CATEGORIES`; en la matriz:
```ts
INSTALLED_IN: {
  source: ['PHYSICAL_SERVER', 'STORAGE', 'NETWORK'],
  target: ['BLADE_SYSTEM___BLADE_ENCLOSURE', 'CONVERGED_INFRASTRUCTURE'],
},
```
y exportar:
```ts
export const INSTALLED_IN_SOURCE_TYPES = RELATION_TYPE_MATRIX.INSTALLED_IN.source;
export const INSTALLED_IN_TARGET_TYPES = RELATION_TYPE_MATRIX.INSTALLED_IN.target;
```
- [ ] **Step 1.5 — Validaciones en index.ts**: helper único usado por AMBOS POST (antes del INSERT, tras la validación de matriz):
```ts
// v3.4.4 — INSTALLED_IN business rules: single container per source + container must not be retired
async function validateInstalledIn(sourceCiId: string, targetCiId: string): Promise<{ status: number; error: string } | null> {
  const existing = await prisma.cIRelation.findFirst({
    where: { sourceCiId, relationType: 'INSTALLED_IN' },
    select: { id: true, targetCI: { select: { name: true } } },
  });
  if (existing) return { status: 409, error: `El CI ya está instalado en "${existing.targetCI.name}". Desinstálalo primero.` };
  const target = await prisma.cI.findUnique({ where: { id: targetCiId }, select: { status: true } });
  if (target?.status === 'RETIRADO') return { status: 422, error: 'El chasis destino está retirado; no admite nuevas instalaciones.' };
  return null;
}
```
En cada POST, tras `validateRelationCiTypes`:
```ts
if (relationType === 'INSTALLED_IN') {
  const violation = await validateInstalledIn(sourceCiId, targetCiId);
  if (violation) { res.status(violation.status).json({ error: violation.error }); return; }
}
```
Y en el `catch` de ambos POST, mapear también la violación del índice parcial (23505 sobre `ci_relations_installed_in_source_unique`) a 409.
- [ ] **Step 1.6 — GET relations + status**: añadir `s.status AS source_status, t.status AS target_status` al SELECT de depth=1 y al CTE recursivo; ampliar el tipo `RelationRow` local con `source_status: string; target_status: string;`.
- [ ] **Step 1.7 — CI_INCLUDE + flattenCI**:
```ts
// en CI_INCLUDE
relationsFrom: {
  where: { relationType: 'INSTALLED_IN' },
  select: { id: true, targetCI: { select: { id: true, name: true, status: true } } },
},
```
```ts
// en flattenCI: destructurar también relationsFrom y añadir
const installedIn = relationsFrom?.[0] ?? null;
installedInRelationId: installedIn?.id ?? null,
installedInId:     installedIn?.targetCI?.id ?? null,
installedInName:   installedIn?.targetCI?.name ?? null,
installedInStatus: installedIn?.targetCI?.status ?? null,
```
> Nota: `CI_INCLUDE` es `as const`; si el `where` da guerra de tipos con `satisfies`/`Prisma.CIInclude`, tipar el fragmento como `Prisma.CIInclude['relationsFrom']`.
- [ ] **Step 1.8 — Verificar**: `cd backend && npx tsc --noEmit` (solo pre-existentes). Commit:
```bash
git add backend/prisma backend/src/relationTypes.ts backend/src/index.ts
git commit -m "feat(relations): INSTALLED_IN relation type with uniqueness + container validations"
```

### Task 2: Reporte inventory — columna + filtro `installedIn`

**Files:** Modify: `backend/src/modules/reports/reports/inventory.ts`

**Interfaces:** Consume `asArray` de `../filterUtils`. Produce columna `installedIn` (group `location`, no sortable) y filtro `installedIn` (multi-select dinámico, values = ids de CIs contenedores).

- [ ] **Step 2.1** — ColSpec (añadir a `SPECS`, junto a las columnas `location`):
```ts
installedIn: {
  col: { key: 'installedIn', labelKey: 'reports.col.installedIn', type: 'string', group: 'location', configurable: true, sortable: false },
  select: { relationsFrom: { where: { relationType: 'INSTALLED_IN' }, select: { targetCI: { select: { name: true } } } } } as Prisma.CISelect,
  extract: (ci) => (ci as AnyCI).relationsFrom?.[0]?.targetCI?.name ?? '',
},
```
- [ ] **Step 2.2** — Filtro: añadir `{ key: 'installedIn', type: 'multi-select', labelKey: 'reports.filter.installedIn' }` al array `filters`; en `loadFilterOptions` añadir:
```ts
const enclosures = await prisma.cI.findMany({
  where: { ciTypeDef: { code: { in: ['BLADE_SYSTEM___BLADE_ENCLOSURE', 'CONVERGED_INFRASTRUCTURE'] } } },
  select: { id: true, name: true }, orderBy: { name: 'asc' },
});
// → installedIn: enclosures.map((e) => ({ value: e.id, label: e.name }))
```
En `query()`:
```ts
const installedInFilter = asArray(filters['installedIn']);
if (installedInFilter) where.relationsFrom = { some: { relationType: 'INSTALLED_IN', targetCiId: { in: installedInFilter } } };
```
- [ ] **Step 2.3** — Si existe suite jest del módulo reports, añadir caso columna+filtro; ejecutarla. `npx tsc --noEmit`. Commit `feat(reports): installedIn column + filter in inventory report`.

### Task 3: Frontend — mirror, detalle CI, modal instalar, inventario

**Files:**
- Modify: `frontend/lib/relationTypes.ts` (mirror exacto de Task 1.4: `RELATION_TYPES` + `RELATION_CATEGORIES` + `RELATION_TYPE_MATRIX`)
- Modify: `frontend/app/map/page.tsx:86-93` (`RELATION_COLORS` + entrada `INSTALLED_IN`, color structural indigo)
- Create: `frontend/components/InstallInEnclosureModal.tsx`
- Modify: `frontend/components/CIDetailModal.tsx` (nueva `Section`)
- Modify: `frontend/app/inventory/page.tsx` (interfaz `CI` + `InvCol` + filtro)

**Interfaces (consume de Task 1):** campos aplanados `installedIn*` en `/api/cis`; `GET /api/cis/:id/relations` con `source_status/target_status`; `POST /api/relations` body `{sourceCiId,targetCiId,relationType:'INSTALLED_IN'}` → 201/409/422; `DELETE /api/relations/:id`.

- [ ] **Step 3.1 — Mirror `relationTypes.ts`** (idéntico a backend) + `RELATION_COLORS` del mapa.
- [ ] **Step 3.2 — `InstallInEnclosureModal.tsx`** (patrón visual de `AddRelationModal`, no cascada DCIM — un solo select buscable):
  - Props: `{ ciId, ciName, currentRelationId?: string|null, currentEnclosureName?: string|null, onClose, onDone }`.
  - Carga `fetchAllCIs()` y filtra cliente: `ciType ∈ {BLADE_SYSTEM___BLADE_ENCLOSURE, CONVERGED_INFRASTRUCTURE}` y `status === 'ACTIVO'`, excluyendo `ciId`.
  - Select buscable (reutilizar el patrón `CISelect` de `AddRelationModal`) mostrando nombre + ubicación si está en los datos.
  - Guardar: si `currentRelationId` → primero `DELETE /api/relations/${currentRelationId}` (cambio de chasis), luego `POST /api/relations`. Errores 409/422 → mostrar `error` del servidor en el modal.
  - Botón "Desinstalar" (rojo, secundario) visible si `currentRelationId`: `DELETE` + `onDone()`.
  - Estética canónica: `rounded-none`, ring, botón primario `bg-[var(--accent)]`.
- [ ] **Step 3.3 — `CIDetailModal.tsx`**: nueva `Section title={t("ci_detail.section_containment")}` (color slate), tras la sección de rack DCIM:
  - Fetch `apiFetch(\`/api/cis/${ci.id}/relations?depth=1\`)` en `useEffect` (solo si el tipo del CI participa en la matriz o siempre — más simple: siempre, y ocultar sección si no hay datos ni es tipo contenedor/instalable).
  - **Contenido (source)**: si `outgoing` tiene `relation_type === 'INSTALLED_IN'` → `Field` "Instalado en" con nombre del chasis + badge amber `t("ci_detail.enclosure_retired_warning")` si `target_status === 'RETIRADO'`. Botones (solo ADMIN): "Cambiar/Instalar en chasis" abre `InstallInEnclosureModal`; "Desinstalar" con `confirm(t("ci_detail.confirm_uninstall"))` → `DELETE /api/relations/:id`.
  - **Contenedor (target)**: si el CI es de tipo contenedor → tabla compacta de `incoming.filter(r => r.relation_type === 'INSTALLED_IN')` con nombre del CI instalado y acción quitar (ADMIN). Vacío → `t("ci_detail.no_installed")`.
  - Para CIs instalables sin instalación: botón "Instalar en chasis" (ADMIN).
- [ ] **Step 3.4 — Inventario `page.tsx`**: añadir a la interfaz `CI` los 4 campos `installedIn*`; nueva `InvCol`:
```ts
{ key: "installedIn", labelKey: "reports.col.installedIn", group: "location",
  filterCell: /* select con nombres únicos de enclosure presentes en los CIs cargados */,
  cell: (ci) => txt(ci.installedInName) },
```
  Extender el estado `filters` con clave `installedIn` y el useMemo `filtered` con `if (filters.installedIn && ci.installedInName !== filters.installedIn) return false;` (filtro exacto por select, consistente con los demás).
- [ ] **Step 3.5** — `cd frontend && npx tsc --noEmit`. Commit `feat(ui): INSTALLED_IN — CI detail containment section, install-in-enclosure modal, inventory column+filter`.

### Task 4: i18n ×6

**Files:** Modify: `frontend/locales/{es,en,de,pt,fr,it}.json`

Claves (mismos nombres en los 6, valores traducidos):
```
relation.type_INSTALLED_IN            "Instalado en"
map.relation_type_INSTALLED_IN        "Instalado en"
ci_detail.section_containment         "Chasis / Contenido"
ci_detail.installed_in                "Instalado en"
ci_detail.contains                    "Contiene"
ci_detail.install_btn                 "Instalar en chasis"
ci_detail.change_enclosure_btn        "Cambiar de chasis"
ci_detail.uninstall_btn               "Desinstalar"
ci_detail.confirm_uninstall           "¿Desinstalar este CI del chasis?"
ci_detail.no_installed                "Ningún CI instalado"
ci_detail.select_enclosure            "Seleccionar chasis"
ci_detail.enclosure_retired_warning   "El chasis está retirado — revisar este CI"
reports.col.installedIn               "Chasis / Enclosure"
reports.filter.installedIn            "Chasis"
```
- [ ] Añadir en los 6 locales junto a sus bloques existentes (`relation.*` ~L1646 es.json, `map.*` ~L1553, `ci_detail.*`, `reports.col`/`reports.filter`). Commit `feat(i18n): INSTALLED_IN keys ×6 locales`.

### Task 5: Documentación + versión

**Files:** Modify: `docs/ARCHITECTURE.md` + `docs/ARCHITECTURE.en.md` (nueva relación + reglas), `docs/USER_MANUAL.md` + `docs/USER_MANUAL.en.md` (uso: instalar/desinstalar, columna/filtro), `CLAUDE.md` (Plan Activo + decisiones D1-D4), `frontend/package.json` → `3.4.4`, `docs/PLAN_STATUS_v3.4.4.md`, `docs/EXECUTION_LOG.md`.
- [ ] Commit `docs: v3.4.4 INSTALLED_IN — architecture, user manual, plan status` + `chore(release): bump frontend a 3.4.4`.

### Task 6: Despliegue local + verificación (inline, no subagente)

- [ ] Rebuild contenedores (memoria ops: **podman-compose binario**, frontend siempre con build por `NEXT_PUBLIC_API_URL`): backend+frontend `--no-cache`, `down`/`up -d`.
- [ ] `podman exec cmdb-backend-prod npx prisma migrate deploy` → 2 migraciones aplicadas; `npx prisma generate` ya en build.
- [ ] Smoke API (cuenta `claude@cmdb.local` para reads; para writes ADMIN seguir procedimiento CLAUDE.md del admin temporal MFA):
  1. Crear relación válida blade→enclosure → 201 + AuditLog.
  2. Repetir mismo source con otro chasis → 409.
  3. Source tipo no permitido (p.ej. LAPTOP) → 422.
  4. Target no contenedor → 422.
  5. `GET /api/cis/:id/relations` muestra la relación con `target_status`.
  6. `GET /api/cis` expone `installedInName`.
  7. Reporte inventory con columna+filtro `installedIn` (API `/api/reports/inventory/data`).
  8. DELETE relación → 200 + AuditLog.
- [ ] UI (Playwright o manual): detalle CI muestra sección, modal instala/desinstala, columna+filtro en inventario, mapa pinta INSTALLED_IN.
- [ ] Limpiar datos de prueba y el admin temporal. `curl -sk https://localhost/api/health` OK.
- [ ] Merge `feature/v3.4.4-blade-enclosure-relation` → `develop` (no-ff). **NO a main.**

---

## Trazabilidad criterios de aceptación → tareas
Migración enum→T1.1-1.3 · unicidad→T1.2+1.5 · tipos source/target→T1.4 · endpoints→D5 (existentes) · detalle CI→T3.3 · modal→T3.2 · inventario col+filtro→T3.4 · reporte→T2 · i18n→T4 · estética→T3 · tsc→T1.8/T2.3/T3.5 · smoke→T6 · commits/rama→global · no-main→global.
