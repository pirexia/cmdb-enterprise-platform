# PLAN_STATUS v3.4.1 — Correcciones Reporting Engine

> **Rama:** `feature/v3.4.1-reporting-fixes` → `develop` (NO `main`)
> **Base:** v3.4.0 (Reporting Engine). Análisis: Opus · Ejecución: Sonnet (autónoma)
> **Estado global:** ✅ Completado — verificado en local (prod compose). Pendiente: merge a `develop`.

---

## Veredictos del análisis (Opus)

| # | Veredicto | Acción |
|---|---|---|
| P1 i18n | ✅ Real — 63 claves backend ausentes | Crear namespaces canónicos `ci.status.*`, `ci.criticality.*`, `env.*`, `rel.*` (17 valores) + `reports.col/filter/kpi.*` faltantes, en 6 idiomas |
| P2 500 filtros | ✅ Real (2 causas) | (a) helper `asArray()` para multi-select de 1 valor; (b) helper `resolveOrderBy()` con allowlist para columnas de relación |
| P3 ciType | ✅ Real | Filtro multi-select dinámico (opciones desde BD vía `loadFilterOptions`) |
| P4 fechas | ⚠️ Premisa mayormente incorrecta | **NO migrar.** `CI.eolDate/eosDate` = columnas espejo por trigger (`trg_sync_ci_eol_eos`). `lifecycle` ya usa `ci_dates`+`dateType`. No existen `contract_dates`/`license_dates`. Documentado. |
| P5 filtros inline | ✅ Real (feature) | `ReportTable` con filtros en cabecera: finitos→reusa `filters` declarados; texto→`search` global; fechas→panel |
| P6 versión sidebar | ✅ Real | Bump `package.json`→3.4.1; render condicional commit (`footer.version_short`); color contraste |
| P7 NaN coverage | ✅ Real (frontend) | `ReportTable` renderiza KPIs string tal cual (arregla coverage% y totalCost EUR) |

### Justificación P4 (pushback)
- Migración `20260614120000_date_associations`: trigger `trg_sync_ci_eol_eos` mantiene `configuration_items.eol_date/eos_date` sincronizadas desde `ci_dates` (dateType `end-of-life`/`end-of-support`). Comentario explícito: "legacy ... columns ... for backward compat". → leerlas es el camino denormalizado **oficial**.
- `lifecycle.ts` ya consulta `prisma.cIDate` + `dateType`. Correcto.
- Esquema: solo existen 4 tablas `*_dates` (ci/os/bsw/devicemodel). **No** hay `contract_dates`/`license_dates`. `Contract.endDate` y `License.endDate` son canónicos.
- Conclusión: migrar añadiría JOINs/latencia/riesgo sin beneficio. **No-op documentado.**

---

## Tareas

| ID | Tarea | Estado |
|---|---|---|
| T1 | Backend: helpers `filterUtils.ts` (`asArray`, `resolveOrderBy`, `escapeLike`, `sortDir`) | ✅ |
| T2 | Backend: helpers en inventory/lifecycle/compliance/impactMap (fix 500) | ✅ |
| T3 | Backend: filtro ciType dinámico + `loadFilterOptions` + `/filters` enriquecido | ✅ |
| T4 | i18n: claves en 6 idiomas (namespaces canónicos + 17 rel.* + reports.horizon.*) | ✅ |
| T5 | Frontend: `ReportTable.renderKpiValue` (fix NaN P7) | ✅ |
| T6 | Frontend: filtros inline en cabeceras (P5) | ✅ |
| T7 | Frontend: viewer carga `/filters` (opciones dinámicas) | ✅ |
| T8 | Frontend: sidebar versión (P6) + bump package.json 3.2.0→3.4.1 | ✅ |
| T9 | Verificación: tsc + build + smoke test local | ✅ |
| T10 | Docs: EXECUTION_LOG, PLAN_STATUS, CLAUDE.md | ✅ |

## Verificación (smoke test local, prod compose)
- `version.json` → `{"version":"3.4.1","commit":"87c17d8"}` (P6 ✅)
- inventory `?status=ACTIVO` (1 valor) → **HTTP 200** (antes 500) ✅
- inventory `?criticality=HIGH` (1 valor) → **HTTP 200** ✅
- inventory `?sort=ciType&dir=desc` (columna relación) → **HTTP 200** (antes 500) ✅
- inventory `?status=ACTIVO&status=INACTIVO` (array) → **HTTP 200** ✅
- inventory `/filters` → `ciType` con **31 opciones** dinámicas (P3 ✅)
- security KPI coverage → `'0%'` (string, sin NaN; `renderKpiValue` lo muestra literal) (P7 ✅)
- i18n: 132 claves backend resueltas en **6/6 idiomas**; claves frontend OK (P1 ✅)
- `tsc` backend limpio; `next build` OK (29/29 páginas); 25/25 tests verdes
- `/reports` → HTTP 200

## Decisión P4 (no-op documentado)
No se migró obsolescence/contracts/licenses a un sistema dateType: `CI.eolDate/eosDate`
son columnas espejo por trigger; `lifecycle` ya usa `ci_dates`+`dateType`; no existen
`contract_dates`/`license_dates`. Migrar añadiría JOINs/latencia/riesgo sin beneficio.

## Criterios de aceptación
- [x] 0 claves i18n sin resolver en los 10 reportes (6 idiomas)
- [x] Filtros laterales sin 500 (incluido 1 solo valor) en todos los reportes
- [x] inventory con filtro ciType (multi-select dinámico)
- [x] Filtros inline en cabeceras (multi-select finitos + texto)
- [x] KPIs coverage/totalCost sin NaN
- [x] Versión sidebar sin "Unknown", legible
- [x] `tsc --noEmit` limpio (salvo `license`/`licenseUser` pre-existentes)
- [x] Smoke test local OK
- [x] NO merge a main
