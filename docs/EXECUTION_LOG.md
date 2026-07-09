# Execution Log

---

# v3.5.0 — Staff Schedule (gestión de horarios del personal) · 🔄 EN PROGRESO · 2026-07-09

**Rama:** `feature/v3.5.0-staff-schedule` → `develop` (NO main). Plan: `docs/PLAN_v3.5.0.md`

## Análisis (Fable) — 2026-07-09
- Grounding: no existe `Department` (Branch/CostCenter/Location/SupportArea no son unidad organizativa de personas); `req.user={id,username,email,role,mfa_enabled}`; patrón módulo core = DCIM; erasure GDPR (`DELETE /api/admin/users/:id`) hace hard-delete raw SQL — con FK requerida a `User` sin cascade, fallaría; Plugin Engine descartado (sandbox no encaja con dominio acoplado a User).
- 3 preguntas de diseño planteadas al usuario (AskUserQuestion), las 3 resueltas hacia la opción de mayor rigor: **D2** 9 estados con controles Art.9 (no colapsar a AUSENTE genérico), **D3** autorización por departamento (no solo ADMIN), **D1** módulo core (no plugin).
- **Desviación crítica añadida por Fable (no en el spec)**: **D4 masking de salud en lectura** — un calendario de equipo con D2 expondría BAJA_MEDICA a compañeros → violación Art.9. `maskEntryForViewer()`: solo ADMIN y el propio interesado ven el estado preciso; el resto ve `AUSENTE` genérico + `healthMasked:true`.
- Otras decisiones: D5 TEXT+Zod (no enum PG, lección v3.4.4), D6 FKs Cascade a User (erasure), D7 SummerSchedule solo periodo global (horas en DepartmentScheduleConfig), D8 EPS=0.01 para floats, D14 DPIA obligatoria antes de merge.
- Plan completo en `docs/PLAN_v3.5.0.md` (10 tareas, pseudocódigo motor V1-V7, shapes de 15+ endpoints). Parada tras diseño (usuario cambió modelo manualmente a Sonnet).

## Ejecución (Sonnet)
- **T1 Schema+migración ✅** (commit `f4534be`, hecho por el orquestador directamente — raíz de la que dependen T2-T4/T6-T7): 6 modelos nuevos (`Department`, `DepartmentManager`, `DepartmentScheduleConfig`, `SummerSchedule`, `StaffSchedule`, `ScheduleEntry`, `ScheduleAlert`) + `User.departmentId`; migración manual `20260709120000_staff_schedule` (`CREATE TABLE IF NOT EXISTS` ×6, `ALTER TABLE users ADD COLUMN`, FKs con `ON DELETE CASCADE` a User en `schedule_entries`/`department_managers`, `SET NULL` en `users.department_id`); nota de erasure extendida en `index.ts` (comentario, sin cambio funcional — el cascade ya lo garantiza). Validado con `prisma validate` dentro del contenedor (sin ejecutar migración).
- **T5 i18n ✅** (commit `b9006f6`): 69 claves × 6 locales = 414 entradas, bloque `staffSchedule.*` anidado (estilo consistente con `reports.filter`/`inventory.status`). Commit limpio, sin mezcla con el agente backend (verificado `git status` antes de commitear, según instrucción). Diff revisado: 6 archivos, +600/-6, solo `frontend/locales/*.json`.
- **T2-T4 Backend ✅** (commit `2a79397`, 11 archivos +1632 líneas): módulo `backend/src/modules/staff-schedule/` completo (schemas/middleware/authz/queries/audit/validationEngine/service/router/export + tests). tsc limpio (regeneró cliente Prisma en contenedor efímero `node:22-alpine` sin tocar `cmdb-backend-prod`, sin ejecutar migraciones); 12/12 tests jest pasados (mismo contenedor efímero). **Desviaciones documentadas y aprobadas tras revisión del diff**: (1) V6 GUARDIA_COVERAGE / V7 BAJA_CONFLICT reinterpretadas a nivel semanal en vez de "mismo día" — el pseudocódigo del plan asumía múltiples estados por día, pero `ScheduleEntry` tiene un único `status` por `(schedule,user,date)` (constraint real), así que la literal sería código muerto; reinterpretación razonable y bien comentada en `validationEngine.ts`. (2) `cfg.minPresencePct/presenceStart/presenceEnd` fusiona `Department`+`DepartmentScheduleConfig` en `service.loadValidationConfig()` (el pseudocódigo los trataba como un solo objeto `cfg`, pero viven en 2 modelos distintos en el schema final). (3) `maskAlertForViewer` añadido más allá del plan — oculta `userId` de alertas `BAJA_CONFLICT` a viewers no autorizados (si no, la lista de alertas filtraría quién tiene baja médica aunque la entry esté enmascarada). (4) `getMonthlySummary`: `healthLeaveDays` se OMITE del todo para viewers no autorizados (no se envía en 0) — la sola presencia del campo en 0 ya sería señal. Verificado en `buildScheduleView`: los agregados (`weeklyNetHours`/`travelDays`/`guardDays`) se calculan sobre datos reales pero sin fuga, porque BAJA_MEDICA/BAJA_PATERNIDAD siempre computan 0h y no cuentan como VIAJE/GUARDIA. Diff completo revisado (validationEngine.ts, service.ts, middleware.ts, authz.ts, router.ts, schemas.ts, export.ts) antes de aprobar — sin issues de seguridad ni de rutas (verificado que no hay colisión entre `/:id` de 1 segmento y `/user/:userId/monthly` de 3 segmentos).
- **T6+T7 Frontend ✅ (2 intentos)** (commit final `77c5b35`, 18 archivos +1810 líneas): primer agente murió por límite de sesión justo antes de terminar el pase de i18n (dejó `page.tsx`+hooks+types+8 componentes completos y correctos en el working tree, sin commitear). Relanzado un segundo agente con instrucción explícita de auditar-lo-ya-hecho (no reescribir desde cero) — confirmó que el diseño ya estaba correcto (masking Art.9 en `ScheduleCell` con icono candado + tooltip; `AlertPanel` con botón "Re-validar"→`POST /:id/validate`, SIN endpoint inventado de "marcar resuelta"), completó las 16 claves i18n que faltaban en los 6 locales (incluida `sidebar.staffSchedule`) y limpió 2 claves huérfanas del diseño antiguo. tsc verificado en contenedor efímero (stage `deps` del Dockerfile, sin tocar `cmdb-frontend-prod`): 0 errores. Diff revisado por el orquestador (ScheduleCell, AlertPanel, page.tsx) — gating correcto por `canEdit`/`status`/`isAdmin`, patrón canónico de la casa respetado. **Lección reforzada**: cuando un subagente muere a mitad de tarea, relanzar con instrucción de auditar+completar (no repetir desde cero) evita perder el trabajo válido ya hecho.

---

# v3.4.4 — Relación INSTALLED_IN (Blade Enclosure / Convergentes) · 🔄 EN PROGRESO · 2026-07-08

**Rama:** `feature/v3.4.4-blade-enclosure-relation` → `develop` (NO main). Plan: `docs/PLAN_v3.4.4.md` · Estado: `docs/PLAN_STATUS_v3.4.4.md`

## Análisis (Fable) — 2026-07-08
- Exploración con 2 agentes (backend relaciones+reportes, frontend relaciones+inventario) + API `/api/masters/ci-types` (cuenta test AUDITOR; lectura directa a BD prod denegada por clasificador).
- **Hallazgos:** relaciones sin Zod — validación manual vía `VALID_RELATION_TYPES` + `RELATION_TYPE_MATRIX` espejada backend/frontend (`backend/src/relationTypes.ts` ↔ `frontend/lib/relationTypes.ts`); handlers genéricos `index.ts:2802-3096`; `CIDetailModal` NO muestra relaciones CI-CI hoy; `CI_INCLUDE` sin relaciones; patrón migración enum probado (`20260612170000_relation_types_extended`); `RELATION_COLORS` hardcodeado en `map/page.tsx`.
- **Códigos CIType (BD):** contenedores `BLADE_SYSTEM___BLADE_ENCLOSURE`, `CONVERGED_INFRASTRUCTURE`; instalables (decisión usuario): `PHYSICAL_SERVER`, `STORAGE`, `NETWORK`.
- **Decisiones D1-D11** en el plan; destacadas: matriz hardcodeada (no campo CIType), 2 migraciones (ADD VALUE + índice único parcial), sin endpoints nuevos, Blade Slots diferido, sin propagación de estado (badge advertencia).
- Rama y tracking (#1-#6 con dependencias) creados.

## Ejecución (Sonnet, subagentes)
- **T1 Backend core ✅** (commit `28bb9d4`): 2 migraciones (`20260708090000` ADD VALUE, `20260708090100` índice único parcial `ci_relations_installed_in_source_unique`); enum en schema.prisma; `relationTypes.ts` (+INSTALLED_IN en VALID/CATEGORIES/MATRIX + exports SOURCE/TARGET_TYPES); `validateInstalledIn()` compartido por ambos POST (409 ya-instalado con nombre de chasis / 422 chasis RETIRADO); 23505 → "Relación duplicada o CI ya instalado"; GET relations + `source_status`/`target_status` (depth=1 y CTE); `CI_INCLUDE.relationsFrom` filtrado + `flattenCI` → `installedInRelationId/Id/Name/Status`. Nota: `as any`/`as never` puntuales porque el cliente Prisma local no conoce aún el valor (se regenera en build del contenedor). tsc: solo pre-existentes. Diff revisado y aprobado por el orquestador.
- **T2 Reporte inventory ✅** (commit `f5043bc`): ColSpec `installedIn` (grupo location, no sortable), filtro multi-select registrado, `loadFilterOptions` con enclosures dinámicos (`ciTypeDef.code IN (BLADE_SYSTEM___BLADE_ENCLOSURE, CONVERGED_INFRASTRUCTURE)`), `where.relationsFrom.some` vía `asArray`. Sin test nuevo (suite mockea Prisma sin cubrir el registro SPECS; jest no ejecutable en host — se valida en T6). tsc: solo pre-existentes. Diff revisado y aprobado.
- **T4 i18n ✅ con incidencia** (commit `68f0ab0`): 14 claves ×6 locales (84/84, JSON válido). **Incidencia:** condición de carrera en el índice compartido — el commit de T4 arrastró los archivos frontend de T3 (staged en paralelo). Árbol limpio tras el commit; pendiente confirmar con el informe de T3 si la instantánea capturada es su estado final verificado (si no, T3 commiteará los arreglos encima). Lección: no paralelizar commits de subagentes en un mismo checkout — serializar commits o usar worktrees.
- **T3 Frontend ✅** (dentro de `9e34512`, amend del combinado T3+T4): mirror `relationTypes.ts` + `INSTALLED_IN_TARGET_TYPES`; `RELATION_COLORS` en mapa; `InstallInEnclosureModal.tsx` nuevo (select buscable de enclosures ACTIVO, cambio de chasis = DELETE+POST, banner de error 409/422, desinstalar con confirm); `CIDetailModal` sección "Chasis / Contenido" (instalado-en con badge RETIRADO amber, lista de contenidos con quitar, gating `isAdmin` existente); inventario: interfaz CI +`installedIn*`, `InvCol` con filterCell select (opciones únicas derivadas), filtro exacto en `filtered`. tsc verificado por el subagente dentro del contenedor (stage deps del Dockerfile) — exit 0. Diff revisado y aprobado; "Todos" hardcodeado en filterCell aceptado por consistencia con filtros vecinos (deuda pre-existente de la página).
- **Mensaje de commit corregido:** `68f0ab0` → amend → `9e34512` `feat(ui+i18n): INSTALLED_IN — ...` reflejando el contenido real (T3+T4).
- **T5 Docs ✅** (`35bfafd` docs, `cdd8c7a` bump): ARCHITECTURE .md/.en (§13.3 → 18 tipos + bloque v3.4.4), USER_MANUAL .md/.en (§9: fila INSTALLED_IN + subsección "Instalar en chasis"), CLAUDE.md (Plan Activo + release v3.4.4 en curso), package.json → 3.4.4.
- **T6 Despliegue + smoke + merge ✅** (2026-07-09): rebuild `--no-cache` backend+frontend con podman-compose; recreate en orden (nginx depends_on frontend/backend, hubo que parar/eliminar los 3 en cascada); `prisma migrate deploy` aplicó ambas migraciones (verificado: enum 18 valores, índice parcial presente). 8 smoke tests con admin temporal MFA (procedimiento CLAUDE.md, creado y luego eliminado de BD): 201 crear / 409 duplicado con nombre de chasis / 422 tipo source inválido / 422 tipo target inválido / GET relations con status / `/api/cis` aplanado / reporte columna+filtro / 422 target RETIRADO / 200 DELETE — todos correctos. UI: `/inventory` 200, login AUDITOR OK. 3 CIs de prueba y admin temporal eliminados. **Merge no-ff a `develop`** (NO main).

---

# v3.4.3 — Column picker en la vista /inventory · ✅ COMPLETADA · 2026-06-28

**Rama:** `feature/v3.4.3-inventory-column-picker` → `develop`. Decisión usuario: paridad total + especiales ocultables.

- **Hallazgo:** `/api/cis` (CI_INCLUDE+flattenCI) ya devolvía casi todo; solo faltaba `branch`+`lifecycleDates`; `flattenCI` destripa `ciModel` → se expone `manufacturerName`.
- **Backend:** CI_INCLUDE +branch +lifecycleDates; flattenCI +manufacturerName.
- **Frontend:** interfaz CI ampliada (alineada con CIDetail); registro `InvCol` (~55 cols, especiales+planas, lifecycleDates por code); tabla refactorizada a dirigida-por-columnas (cabecera/filtros/cuerpo iteran sobre visibleCols; checkbox/nombre/acciones fijos); ColumnPicker reutilizado (PickerColumn) + localStorage `inventory_columns_<userId>`; i18n ×6.
- **Errores resueltos en build:** CI no asignable a CIDetail (operatingSystem.version y ciModel.manufacturer opcionales → no opcionales); ReportColumn residual en ColumnPicker → PickerColumn.
- **Verificación:** build OK; /api/cis con branch/lifecycleDates/manufacturerName (HPE/CPD); /inventory 200; desplegado.

## Commit
- `feat(inventory): column picker en la vista /inventory (paridad reporte)`

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
