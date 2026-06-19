# Plan v2.8.7

**Estado:** COMPLETADO ✅  
**Rama:** `feature/v2.8.7` → develop → main  
**Fecha inicio:** 2026-06-18  

---

## Objetivo

Tres mejoras de calidad + un fix de UX para v2.8.7:

| Tarea | Descripción |
|-------|-------------|
| **T1** | Añadir campos de infraestructura faltantes al template Excel de importación masiva |
| **T2** | Auditoría visual DCIM (Playwright) + corrección de outliers reales |
| **T3** | Unificación de tema claro: `/decommission/*` + `/plugins/admin` |
| **T4** | Renombrar "Decomisionado"→"Decomisado" en locale ES (valores visibles) |

---

## T1 — Bulk Import: campos faltantes

**Fichero:** `backend/src/index.ts` (excepción acotada al bloque bulk ~líneas 2280–2410)

**Campos a añadir al template y parser:**

*Infraestructura HW (en HardwareCI):*
- `cpuModel`, `vCpus`, `ram`, `disk`, `adminIp`, `mgmtIp`, `hostName`
- `clusterName`, `firmwareVersion`, `dns`, `vlan`, `consoleIp`

*Ubicación física (HardwareCI):*
- `floor`, `room`, `rack`, `rackUnit`

*Continuidad / GRC (CI principal):*
- `rto`, `rpo`, `recoveryPriority`, `spofRisk`, `containsPii`

*Lookups FK (CI principal):*
- `location` (nombre → `location_id`)
- `businessOwner`, `technicalLead`, `userDni` (user lookups)

**Estrategia:**
1. Añadir columnas al header del template Excel
2. Añadir celdas de ejemplo en fila 2
3. Extender el parser `parseRow()` para leer los nuevos campos
4. Resolver FKs de location/users por nombre/DNI antes del upsert
5. tsc + rebuild + test con curl de descarga

---

## T2 — Auditoría visual DCIM

**Herramienta:** Playwright (Python), Chromium en `~/.cache/ms-playwright/`

**Alcance:**
- Capturar screenshots de `/dcim`, `/dcim/buildings`, `/dcim/floors`, `/dcim/rooms`, `/dcim/aisles`
- Identificar elementos con `bg-slate-900/800` o `text-slate-100/200` o `border-white` fuera del SVG de rack
- Corregir solo inconsistencias reales; el SVG de rack chassis es oscuro por diseño

---

## T3 — Unificación tema claro

**Ficheros:**
- `frontend/app/decommission/page.tsx` — lista de planes
- `frontend/app/decommission/[id]/page.tsx` — detalle + Gantt
- `frontend/app/plugins/admin/page.tsx` — panel de administración de plugins

**Patrón objetivo:** mismo tema que `/inventory`:
- Fondo: `bg-white` / `bg-slate-50`
- Texto: `text-slate-800` / `text-slate-700` / `text-slate-500`
- Bordes: `border-slate-200`
- Header de tabla: `bg-slate-100 text-slate-600`
- Badges/pills: colores semánticos sobre fondo claro

---

## T4 — Rename ES: Decomisionado → Decomisado

**Fichero:** `frontend/locales/es.json`

**Solo valores visibles** (etiquetas, títulos, subtítulos en ES). Las claves (`decommission.*`), rutas API, tablas DB y el CHANGELOG histórico permanecen intactos. Otros idiomas (en/de/pt/fr/it) no se tocan.

---

## Checklist de Definition of Done

- [ ] T1: tsc sin nuevos errores; template Excel descargable con todas las columnas; parse funciona end-to-end
- [ ] T2: screenshots OK; outliers corregidos; no regresiones
- [ ] T3: tema claro en las 3 páginas; verificado visualmente con Playwright
- [ ] T4: strings ES actualizados; sidebar/título/subtítulo muestran "Decomisado"
- [ ] Containers rebuild + health check OK
- [ ] CHANGELOG [2.8.7] completado
- [ ] PR develop→main + tag v2.8.7 + GitHub release
