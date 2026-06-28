# Execution Log

---

# v3.4.2 — Columnas configurables (Inventario) · ✅ COMPLETADA · 2026-06-28

**Rama:** `feature/v3.4.2-inventory-column-picker` → `develop`.

## Análisis (Opus) — correcciones a premisas del prompt
- Códigos `dateType` kebab-case (no EOL/EOS); `CI.eolDate/eosDate` = columnas espejo por trigger (sortables); HardwareCI usa `serialNumber/model/manufacturer`; columnas derivadas de `ci_dates` (1:N) no sortables vía Prisma; relación CI→CIDate = `lifecycleDates`.
- **Alcance:** picker completo; filtros server-side de columnas nuevas diferidos a v3.4.3.

## Ejecución (Sonnet)
- Backend: `types.ts` (+configurable/defaultVisible/group/allColumns/visibleColumns); `inventory.ts` COLUMN_SPECS (61 columnas), `select` Prisma dinámico (merge de fragmentos) + orderBy allowlist; `schemas.ts` visibleColumns; `router` export visibles; `registry` allColumns.
- Frontend: `ColumnPicker.tsx` (portal, búsqueda, grupos, ▲▼/quitar, todas/ninguna/reset); `[id]/page.tsx` (visibleKeys + localStorage `report_columns_<id>_<userId>`, effectiveColumns, csv a /data y /export); `ReportTable` badges nuevos; i18n ×6.

## Verificación local
61 allColumns/8 default/7 grupos; data solo keys pedidas (sin over-fetching); sort hardware 200; export CSV solo visibles; next build + tsc + 25 tests OK.

## Commits
- `feat(reports): backend columnas configurables en inventory (~50 columnas)`
- `feat(reports): column picker en Inventario de CIs (frontend)`

---

# v3.4.1 — Correcciones Reporting Engine · ✅ COMPLETADA · 2026-06-28

**Rama:** `feature/v3.4.1-reporting-fixes` → `develop`. Análisis Opus, ejecución autónoma.

## Análisis (Opus)
- **P2 (500)** — 2 causas verificadas: (a) multi-select de 1 valor → Express entrega string → `{ in: 'X' }` revienta Prisma (inventory/lifecycle/compliance/impactMap); (b) `orderBy: {[sort]}` con columna de relación → 500 (inventory).
- **P7 (NaN)** — causa frontend: `security.ts` devuelve KPI string `"75%"`; `ReportTable` hacía `Number("75%")`=NaN. Mismo bug en licenses totalCost.
- **P4** — premisa mayormente incorrecta: `CI.eolDate/eosDate` = columnas espejo por trigger (`trg_sync_ci_eol_eos`); `lifecycle` ya usa `ci_dates`+`dateType`; **no existen** `contract_dates`/`license_dates`. **No-op documentado** (pushback).
- **P1** — 63 claves backend ausentes; `t()` hace traversal anidado → `reports.filter.horizon` no puede ser label y padre de opciones → opciones movidas a `reports.horizon.*`.

## Ejecución (Sonnet, autónoma)
1. `filterUtils.ts`: `asArray`, `resolveOrderBy`, `escapeLike`, `sortDir`. Aplicado en inventory/lifecycle/compliance/impactMap.
2. inventory: filtro `ciType` multi-select dinámico (`loadFilterOptions`→BD); `/filters` mergea opciones dinámicas.
3. impactMap ampliado a 17 relaciones (multi-select).
4. i18n 6 idiomas: `ci.status.*`, `ci.criticality.*`, `env.*`, `rel.*` (17), `decomm.status.*`, `reports.col/filter/kpi.*`, `reports.horizon.*`, `footer.version_short`.
5. `ReportTable`: `renderKpiValue` (fix NaN), filtros inline en cabeceras (popover multi-select + texto→search), badges completos.
6. Viewer carga `/filters`; sidebar versión condicional + color legible; `package.json`→3.4.1.

## Verificación local (prod compose)
- version.json `3.4.1/87c17d8`; filtros 1-valor + sort relación → 200 (antes 500); ciType 31 opciones; coverage `'0%'`; i18n 6/6; `tsc`/`next build`/25 tests OK.

## Commits
- `fix(reports): 500 en filtros + ciType dinámico + i18n 6 idiomas (P1,P2,P3)`
- `fix(reports): filtros inline en columnas + KPI string + versión sidebar (P5,P6,P7)`
- `docs(v3.4.1): plan status + execution log`

## Extensión post-merge (mismo ciclo)
- **E1** `662f491` — popover de filtro de columna recortado por `overflow-x-auto`; fix con `createPortal`+`position:fixed`, cierre en scroll/resize.
- **E2** `268af13` — filtros inline en cabeceras extendidos a los 10 reportes; texto en cabecera escribe a clave propia (audit-trail entity/action) o `search`; status select→multiselect en licenses/decommission (asArray + IN, decommission con whitelist `DECOMM_STATUSES`); criticality multiselect nuevo en obsolescence/security.
- **Release** — `develop`→`main` vía PR, tag `v3.4.1`, GitHub release.

---

# v3.4.0 — Reporting Engine

## Tarea 1 — Diseño (Opus) · ✅ COMPLETADA · 2026-06-28

- **Análisis del código actual:**
  - `frontend/app/reports/page.tsx` (675 líneas): 3 reportes client-side (obsolescencia, contratos, seguridad). Usa `fetchAllCIs`, `apiFetch('/api/contracts')`, `exportToCSV`, `openPrintWindow`. Sin backend, sin RBAC.
  - Plugin Engine (`backend/src/modules/plugins/engine.ts`): sandbox `vm` (contexto congelado, sin `require`/`process`/`eval`, timeout 5 s, prisma proxy con permisos). Plugins = code-strings en BD; registran hooks/cronJobs/routes vía `manifest`. **No** admite closures vivas.
  - Schema: `model CI`→`configuration_items` (L299); `vulnerabilities Json?` en CI (L369); EOL/EOS en `ci_dates`/`base_software_dates`; entidades de los 10 reportes presentes (Contract, License/LicenseUser, Document, AuditLog, DecommissionPlan, CIRelation).
- **Decisión arquitectónica (confirmada por usuario):** extensibilidad de plugins en **DOS NIVELES** — core via closure `registerReport()`; plugin via metadata en manifest + route sandboxed (`runRoute`). Preserva el boundary de seguridad del sandbox. Descartado el `registerReport({query: closure})` literal del prompt para plugins (rompería el sandbox, A02/A08).
- **Entregables:** `docs/PLAN_STATUS_v3.4.0.md` (arquitectura completa) + esta entrada.
- **Restricción respetada:** sin código ejecutado, sin commits.

### Próximo paso (T2, Sonnet)
Cortar `feature/v3.4.0-reporting-engine` de `develop`. Backend en orden: `types.ts` → `registry.ts` → `schemas.ts` → `middleware.ts` → `audit.ts` → `export.ts` → 10 reportes core → `router.ts` → mount en `index.ts` → tests. Gate: `cd backend && npx tsc --noEmit` sin errores nuevos.

---

# Execution Log — v3.3.0 (Bug Hunt, Pentest, Compliance)

> Bitácora cronológica de la sesión. Se actualiza tras cada acción significativa.
> Rama de trabajo: `develop` (destino final). NO merge a `main` sin orden explícita.

---

## Fase 1 — Planificación (Opus 4.8)

### [Inicio] Reconocimiento del entorno (solo lectura)

Investigación previa al diseño del plan. Hallazgos que **contradicen premisas del prompt**:

| # | Premisa del prompt | Estado real verificado | Impacto |
|---|--------------------|------------------------|---------|
| D1 | Dashboard n8n con 6.997 ejecuciones / 70 fallos en vivo | **Stack APAGADO** — `podman ps` vacío. No hay nada corriendo. | Tareas 1, smoke tests, Playwright y verificación de badge **requieren levantar el stack completo**. La evidencia del prompt fue observada por el usuario en una sesión previa, no es reproducible ahora sin arrancar. |
| D2 | "`EXECUTIONS_DATA_PRUNE` no está habilitado" (causa de acumulación) | En **`docker-compose.prod.yml` YA está configurado**: `PRUNE=true`, `MAX_AGE=168`, `SAVE_ON_SUCCESS=none`, `SAVE_ON_ERROR=all`, `PRUNE_MAX_COUNT=10000`. En **`docker-compose.yml` (dev) NO hay ninguna var `EXECUTIONS_DATA`**. | La Tarea 2 cambia de "añadir purga" a: (a) replicar config en dev compose, (b) investigar por qué se acumuló pese a config prod (probable: usuario en dev, o interacción MAX_AGE×PRUNE_MAX_COUNT con RAG cada 30s). |
| D3 | `frontend/scripts/gen-version.mjs` lee package.json `0.1.0` | Confirmado: el script existe, `frontend/package.json` version = `0.1.0`. Badge muestra `v3.0.0 unknown`. | Tarea 3 válida tal cual. |

Otros hechos verificados:
- `SECURITY_AUDIT.md` vive en la **raíz** (17 KB), no en `docs/`. El prompt pide `docs/SECURITY_AUDIT.md`.
- `docs/n8n/` tiene `ADMIN_GUIDE.md`, `PROVISIONING.md`, `WORKFLOWS.md`. **No existe** `TROUBLESHOOTING.md` (a crear).
- Módulo `backend/src/modules/n8n-provisioning/` existe: `apiClient.ts`, `config.ts`, `credentials.ts`, `onBoot.ts`, `provisioner.ts`, `router.ts`, `workflows.ts`, `templates/`, `__tests__/`.
- `gh` CLI autenticado como `pirexia` sobre el repo real. Issues abiertos: #152 (otplib v12→v13), #153 (exceljs→uuid). **Crear issues = acción real sobre repo público.**
- Rama actual `develop`, limpia, sincronizada con origin. `main` ya en `v3.2.0` (234a679).

### Decisiones que requieren confirmación del usuario antes de ejecutar (Fase 2)

1. **Levantar el stack completo** (postgres + backend + frontend + n8n main+2 workers + redis + ollama + nginx) — necesario para Tareas 1, badge, Playwright, smoke tests. ¿Autorizado?
2. **Creación masiva de issues en GitHub** sobre `pirexia/cmdb-enterprise-platform` (repo real) — el prompt pide un issue por finding. Puede generar docenas. ¿Confirmar volumen / o agrupar?
3. **Cambio de modelo Opus→Sonnet** — yo (Claude) no puedo auto-cambiar el modelo; lo controla el usuario vía `/model`. Aclarado.

### Decisiones del usuario (confirmadas)

| # | Decisión | Respuesta |
|---|----------|-----------|
| 1 | Levantar stack | **Dev completo** (`podman compose up -d` — todos los servicios) |
| 2 | Issues GitHub | **Uno por finding** (fiel al prompt; repo real `pirexia/cmdb-enterprise-platform`). Verificar duplicados antes de crear. Milestone `v3.3.0`. |
| 3 | Modelo Fase 2 | **Sonnet** — el usuario cambia con `/model sonnet`; tras ello se ejecuta en modo autónomo. |

**FIN FASE 1 (Opus).** Plan listo en `docs/PLAN_STATUS_v3.3.0.md`. A la espera de `/model sonnet` para iniciar Fase 2.

_(El plan completo está en `docs/PLAN_STATUS_v3.3.0.md`.)_

---

## Fase 2 — Ejecución (Sonnet)

_(Pendiente de arranque tras cambio de modelo.)_
