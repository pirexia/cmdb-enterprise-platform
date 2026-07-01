# PLAN_STATUS v3.4.3 — Column picker en la vista /inventory

> **Rama:** `feature/v3.4.3-inventory-column-picker` → `develop` (NO `main`)
> **Base:** v3.4.2. **Estado:** ✅ Completado — verificado en local. Pendiente merge a `develop`.

## Objetivo
Columnas configurables (paridad con el reporte) en la **vista** `/inventory`, no solo en el reporte.
Decisión del usuario: paridad total (~50 columnas) + columnas especiales (vulns/agente/soporte/tipo) también ocultables; checkbox/nombre/acciones fijos.

## Hallazgo clave (reduce el backend)
`/api/cis` (CI_INCLUDE + flattenCI) **ya devolvía** casi todos los campos (todos los escalares vía `...rest`, hardware/software, location/costCenter, businessOwner/technicalLead, ciTypeDef, operatingSystem). Solo faltaba `branch` y `lifecycleDates`. `flattenCI` destripa `ciModel` → se expone `manufacturerName` aparte.

## Implementación
- **Backend:** `CI_INCLUDE` +`branch` +`lifecycleDates`; `flattenCI` +`manufacturerName`.
- **Frontend (`app/inventory/page.tsx`):**
  - Interfaz `CI` ampliada con todos los campos del listado (alineados con `CIDetail` donde solapan).
  - Registro `InvCol[]` (useMemo) — ~55 columnas: especiales con render propio (soporte, tipo+icono, environment/criticality/status badges, vulns Greenbone, agente CrowdStrike, responsable técnico) + planas (`txt/dateCell/yesno`); fechas de ciclo de vida vía `lifecycleDates`+`dateType.code`.
  - Tabla refactorizada a **dirigida por columnas**: cabecera (orden), fila de filtros y cuerpo iteran sobre `visibleCols`. Checkbox (admin) + nombre + acciones (admin) fijos.
  - `ColumnPicker` (reutilizado de reports, generalizado a `PickerColumn`) en la barra de herramientas; persistencia `localStorage` `inventory_columns_<userId>`.
- **i18n ×6:** `inventory.columns.{greenbone,crowdstrike,technical_lead}`, `inventory.unassigned`, `inventory.filter_type_all` (reusa `reports.col.*` y `reports.columnPicker.*` de v3.4.2).

## Verificación local
- `next build` + `tsc` backend OK.
- `/api/cis` devuelve `branch`, `lifecycleDates`, `manufacturerName` (ej. HPE/CPD).
- `/inventory` 200; imágenes desplegadas (force-recreate verificado).

## Criterios de aceptación
- [x] Vista /inventory con columnas configurables (~55), especiales ocultables
- [x] checkbox/nombre/acciones fijos; orden ▲▼; búsqueda; grupos; reset; localStorage
- [x] Backend mínimo (branch + lifecycleDates + manufacturerName)
- [x] i18n ×6; build OK; smoke local OK; NO merge a main

## Nota
Persisten los filtros existentes (name/type/environment/criticality/status/vulns/agent) — siguen la columna a la que pertenecen. Las columnas planas nuevas no tienen filtro inline (igual que el reporte; diferible).
