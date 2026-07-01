# PLAN_STATUS v3.4.2 — Columnas configurables (Inventario de CIs)

> **Rama:** `feature/v3.4.2-inventory-column-picker` → `develop` (NO `main`)
> **Base:** v3.4.1. Análisis: Opus · Ejecución: Sonnet (autónoma)
> **Estado global:** ✅ Completado — verificado en local. Pendiente: merge a `develop`.

## Objetivo
Column picker dinámico en `/reports/inventory`: ver/añadir/quitar/reordenar columnas,
persistir en `localStorage` por usuario+reporte, exportar solo visibles, resetear.

## Correcciones a premisas del prompt (verificadas contra schema)
1. **Códigos dateType** son kebab-case (`end-of-life`, `end-of-support`, `purchase-date`,
   `hw-end-of-warranty`, `deployment-date`, `decommission-date`, `review-date`) — NO `EOL`/`EOS`.
2. **eolDate/eosDate** = columnas espejo por trigger (camino oficial, sin JOIN) → escalares sortables.
   Las demás fechas → `lifecycleDates` (relación CI→CIDate) + `dateType.code`.
3. **HardwareCI**: campos reales `serialNumber`/`model`/`manufacturer` (no `hw*`); keys del reporte libres.
4. **Sortable**: columnas derivadas de `ci_dates` (1:N) NO sortables vía Prisma orderBy → `sortable:false`.
   Escalares + relaciones to-one (incl. `hardware.*`) sí.
5. Relación CI→CIDate se llama **`lifecycleDates`**; DeviceModel→`manufacturer` (Manufacturer.name).

## Decisión de alcance
- **Incluye:** picker completo (~50 columnas, grupos, búsqueda, reorder ▲▼, persist, export visible, reset),
  `select` Prisma dinámico (sin over-fetching), i18n ×6.
- **Mantiene:** los 4 filtros existentes (status, criticality, ciType, name→search) — funcionan para columnas visibles.
- **Difiere a v3.4.3:** filtros inline server-side para las ~46 columnas nuevas (esfuerzo separado,
  fuera de objetivos/criterios de aceptación).

## Arquitectura backend — `inventory.ts` COLUMN_SPECS
```ts
interface ColSpec {
  col: ReportColumn;                                  // metadata (labelKey, type, sortable, group, defaultVisible)
  select: Prisma.CISelect;                            // fragmento mergeado en findMany.select
  extract: (ci: any) => unknown;                      // valor de fila
  orderBy?: (d:'asc'|'desc') => Prisma.CIOrderByWithRelationInput;
}
const SPECS: Record<string, ColSpec> = { ... }        // ~50 entradas
```
Query: `visibleColumns` (csv) → keys válidas (o defaults) → merge selects (+id) → findMany →
`data = rows.map(ci => ({ id, ...fromEntries(keys.map(k => [k, SPECS[k].extract(ci)])) }))`.
`lifecycleDates`/`hardware`/`software` se incluyen una sola vez si se pide alguna columna suya.

## Tipos (`types.ts`)
- `ReportColumn`: `+ configurable?`, `defaultVisible?`, `group?`; `type` añade `'boolean'`; `filter` añade `'date-range'|'number'|'toggle'`.
- `ReportDefinition` + `ReportMeta`: `+ allColumns?: ReportColumn[]`.
- `ReportFilters`: `+ visibleColumns?: string[]`.

## Router/export
- `/data`: `visibleColumns` llega vía passthrough; inventory lo usa.
- `/export`: router resuelve `cols = resolveVisibleColumns(def, vc) ?? def.columns` y los pasa a `toCSV`/`toXLSX`.

## Frontend
- `ColumnPicker.tsx` (nuevo): botón engranaje → popover (portal) con columnas agrupadas, checkbox, ▲▼, búsqueda, "todas/ninguna/reset/aplicar".
- `ReportTable.tsx`: prop `visibleColumns` → renderiza solo esas, en orden.
- `[id]/page.tsx`: estado `visibleColumns` + `localStorage` (`report_columns_<id>_<userId>`); pasa a hook+tabla+export.
- `useReportData.ts`: envía `visibleColumns` en query string.
- i18n: `reports.columnPicker.*`, `reports.col.*` nuevos, `reports.col.group.*` ×6.

## Grupos del picker
general · location · network · hardware · software · governance · lifecycle

## Tareas
| ID | Tarea | Estado |
|---|---|---|
| T1 | types.ts (configurable/defaultVisible/group/allColumns/visibleColumns) | ✅ |
| T2 | inventory.ts COLUMN_SPECS (61 columnas) + query dinámica | ✅ |
| T3 | schemas.ts + router /export visibleColumns | ✅ |
| T4 | registry/meta exponen allColumns | ✅ |
| T5 | i18n ×6 (≈60 col.* + columnPicker.* + group.*) | ✅ |
| T6 | ColumnPicker.tsx (portal, grupos, ▲▼, búsqueda) | ✅ |
| T7 | ReportTable badges nuevos + effectiveColumns en viewer | ✅ |
| T8 | viewer + localStorage + envío visibleColumns | ✅ |
| T9 | build + smoke test local | ✅ |
| T10 | docs (PLAN_STATUS, EXECUTION_LOG, CLAUDE.md) | ✅ |

## Verificación (local, prod compose)
- meta inventory: 8 columnas default · **61 allColumns** · 7 grupos (general/location/network/hardware/software/governance/lifecycle)
- `/data?visibleColumns=name,adminIp,manufacturer,hwSerialNumber,businessImpact,spofRisk` → fila con **exactamente** esas keys (+id) → select Prisma dinámico sin over-fetching ✅
- sort por columna hardware (`hwSerialNumber`, relación to-one) → 200 ✅
- export CSV `visibleColumns=name,adminIp,businessImpact` → cabecera solo con esas 3 ✅
- `next build` OK · backend `tsc` limpio · 25/25 tests · `/reports/inventory` 200

## Criterios de aceptación
- [x] allColumns ≥ 40 (61); select Prisma dinámico sin over-fetching
- [x] picker: grupos, búsqueda, show/hide, reorder ▲▼, reset
- [x] persistencia localStorage por usuario+reporte
- [x] tabla renderiza solo visibles en orden; export respeta visibles
- [x] i18n ×6; tsc limpio; smoke test OK; NO merge a main

## Diferido a v3.4.3 (documentado)
Filtros inline server-side para las ~46 columnas nuevas (texto/multiselect dinámico/
número/fecha/toggle). Fuera de objetivos y criterios de v3.4.2. Se mantienen los 4
filtros existentes (status, criticality, ciType, name→search) operativos.
