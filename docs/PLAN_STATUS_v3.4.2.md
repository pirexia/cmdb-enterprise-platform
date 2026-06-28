# PLAN_STATUS v3.4.2 — Columnas configurables (Inventario de CIs)

> **Rama:** `feature/v3.4.2-inventory-column-picker` → `develop` (NO `main`)
> **Base:** v3.4.1. Análisis: Opus · Ejecución: Sonnet (autónoma)
> **Estado global:** 🔄 En progreso

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
| T1 | types.ts (configurable/defaultVisible/group/allColumns/visibleColumns) | ⏳ |
| T2 | inventory.ts COLUMN_SPECS (~50) + query dinámica | ⏳ |
| T3 | schemas.ts + router /data + /export visibleColumns | ⏳ |
| T4 | registry/meta exponen allColumns | ⏳ |
| T5 | i18n ×6 (col.* nuevos + columnPicker.* + group.*) | ⏳ |
| T6 | ColumnPicker.tsx | ⏳ |
| T7 | ReportTable visibleColumns | ⏳ |
| T8 | viewer + useReportData + localStorage | ⏳ |
| T9 | build + smoke test local | ⏳ |
| T10 | docs (PLAN_STATUS, EXECUTION_LOG, CLAUDE.md) | ⏳ |

## Criterios de aceptación
- [ ] allColumns ≥ 40 en inventory; select Prisma dinámico sin over-fetching
- [ ] picker: grupos, búsqueda, show/hide, reorder, reset, aplicar
- [ ] persistencia localStorage por usuario+reporte
- [ ] tabla renderiza solo visibles en orden; export respeta visibles
- [ ] i18n ×6; tsc limpio; smoke test OK; NO merge a main
