# Módulo Línea de Tiempo (Gantt)

Introducido en **v3.1.0**. Vista Gantt read-only que agrega todas las fechas relevantes del sistema CMDB en un único panel interactivo.

## Ruta

`/timeline` — disponible para todos los roles (VIEWER, AUDITOR, ADMIN).

## Funcionalidad

### Vista Gantt

- **Barras de intervalo**: contratos y licencias con `startDate`/`endDate`.
- **Hitos diamante**: fechas puntuales (EOL, EOS, vencimientos, custom).
- **Hitos punteados**: fechas heredadas de datos maestros (SO, DeviceModel, BaseSoftware).
- **Línea roja "Hoy"**: visible en todos los niveles de zoom.
- **Línea fija de etiquetas** (columna izquierda, 230px) con badge de tipo.

### Entidades incluidas

| Tipo | `kind` API | Fuente de fechas |
|------|-----------|-----------------|
| CI | `ci` | `eolDate`, `eosDate`, `lastCheckDate` y `CIDate` custom |
| Contrato | `contract` | `startDate`, `endDate` |
| Licencia | `license` | `startDate`, `endDate` |
| Plan Decomisado | `decommission` | `createdAt`, `completedAt` |
| Sistema Operativo | `os` | `OperatingSystemDate` (DateType) |
| Software Base | `software` | `BaseSoftwareDate` (DateType) |
| Modelo Dispositivo | `model` | `eolDate`, `eosDate`, `DeviceModelDate` |

### Zoom

Cinco niveles: **Día / Semana / Mes / Trimestre / Año**.

- Botones en la barra de herramientas.
- `Ctrl + scroll` sobre el Gantt.

El botón **Centrar en Hoy** (`Target` icon) desplaza el scroll horizontal hasta la fecha actual.

### Codificación de color

| Color | Criterio |
|-------|---------|
| Verde | Más de 30 días hasta el vencimiento |
| Amarillo | 15–30 días hasta el vencimiento |
| Rojo | Menos de 15 días hasta el vencimiento |
| Gris oscuro | Vencido (fecha pasada) |
| Gris claro | CI con estado INACTIVO o RETIRADO |
| Azul | Sin fecha de vencimiento definida |

La lógica de color está centralizada en `frontend/lib/timelineColor.ts`.

### Fechas relacionadas (filas desplegables)

Cada fila de tipo **CI** tiene un **chevron desplegable** (▸) junto al nombre. Al expandirlo se consulta `GET /api/timeline/legacy/:ciId` y se insertan **filas hijas indentadas** debajo del CI, una por cada entidad relacionada:

| Fuente | `source` | Contenido en la fila hija |
|--------|----------|---------------------------|
| Sistema Operativo | `os` | Diamantes punteados por cada fecha de ciclo de vida del SO |
| Modelo de dispositivo | `model` | EOL/EOS del modelo + fechas `DeviceModelDate` |
| Software Base (M:M) | `software` | Una fila por cada software, con sus fechas |
| Contrato (M:M) | `contract` | **Barra de intervalo punteada** start→end + hito de vencimiento |
| Licencia (M:M) | `license` | **Barra de intervalo punteada** start→end + hito de vencimiento |

Las filas hijas se renderizan con marcas punteadas para diferenciarlas de las fechas propias del CI. Cada `ciId` se consulta una sola vez y se cachea mientras dure la sesión; pueden expandirse varios CIs simultáneamente.

**Nota:** las fuentes solo-fecha (OS, software, modelo) que no tengan ninguna fecha de ciclo de vida se omiten (no aportan hitos al Gantt). Contratos y licencias se muestran siempre que estén asociados, porque tienen intervalo start/end.

### Filtros

- **Tipo**: checkboxes para las 7 entidades.
- **Subtipo**: dropdown de CIType (solo visible cuando "CI" está activo).
- **Búsqueda**: input con debounce 300ms sobre el nombre del elemento.
- **Estado**: checkboxes filtrados por los tipos seleccionados.
- **Tipo de Fecha**: toggles EOL / EOS / Vencimiento / Inicio / Completado / Custom.
- **Limpiar filtros**: restaura los valores por defecto.

Los filtros persisten en `localStorage` con clave `"timeline-filters"`.

## API Backend

Módulo en `backend/src/modules/timeline/`. Montado en `index.ts`:

```
app.use('/api/timeline', authenticateToken, createTimelineRouter(prisma))
```

### Endpoints

#### `GET /api/timeline/items`

Parámetros query (Zod validado):

| Parámetro | Tipo | Descripción |
|-----------|------|-------------|
| `types` | CSV enum | `ci,contract,license,decommission,os,software,model` |
| `ciTypeId` | UUID | Filtra CIs por CIType |
| `status` | CSV | Filtra por estado (ACTIVO, INACTIVO, etc.) |
| `dateTypes` | CSV | `eol,eos,end,start,completed,custom` |
| `search` | string (max 200) | Búsqueda por nombre (escapada con `escapeLike`) |
| `limit` | int (max 1000) | Default 200 |
| `offset` | int | Paginación |

Respuesta:
```json
{
  "total": 277,
  "data": [
    {
      "id": "uuid",
      "kind": "ci",
      "name": "Servidor Web 01",
      "subType": "Servidor",
      "status": "ACTIVO",
      "startDate": null,
      "endDate": "2026-12-31",
      "milestones": [
        { "type": "eol", "date": "2026-12-31", "label": "EOL" }
      ]
    }
  ]
}
```

#### `GET /api/timeline/filters`

Devuelve metadatos para poblar los dropdowns del panel de filtros:

```json
{
  "ciTypes": [{ "id": "uuid", "name": "Servidor" }],
  "dateTypes": [{ "id": "uuid", "name": "EOL", "category": "HARDWARE" }],
  "statuses": [{ "value": "ACTIVO", "label": "Activo", "kinds": ["ci", "license"] }]
}
```

#### `GET /api/timeline/legacy/:ciId`

Requiere UUID válido (middleware `requireUuidParam`). Agrega todas las entidades relacionadas con el CI como **children** (cada una se renderiza como fila hija indentada):
- `OperatingSystemDate` (vía `operatingSystemId`) → `source: 'os'`
- `DeviceModelDate` + `eolDate`/`eosDate` del modelo (vía `ciModelId`) → `source: 'model'`
- `BaseSoftwareDate` de todos los `CIBaseSoftware` asociados (M:M) → `source: 'software'`
- **Contratos** asociados (M:M `_ContractToCI`) → `source: 'contract'` con `startDate`/`endDate`
- **Licencias** asociadas (M:M `_LicenseToCI`) → `source: 'license'` con `startDate`/`endDate` + `status`

```json
{
  "ciId": "uuid",
  "children": [
    {
      "source": "model",
      "sourceName": "Synergy 480 Gen10 Plus",
      "milestones": [
        { "type": "eol", "date": "2029-12-31", "label": "EOL", "inherited": true, "inheritedFrom": "model" }
      ]
    },
    {
      "source": "contract",
      "sourceName": "SOPORTE-2025",
      "startDate": "2025-01-01",
      "endDate": "2026-12-31",
      "milestones": [
        { "type": "end", "date": "2026-12-31", "label": "Vencimiento", "inherited": true, "inheritedFrom": "contract" }
      ]
    }
  ]
}
```

## Arquitectura Frontend

```
frontend/app/timeline/
├── page.tsx                      # Página principal
├── types/
│   └── timeline.ts               # Tipos compartidos
├── hooks/
│   ├── useTimeline.ts            # useTimeline, useTimelineFiltersData, useLegacyDates
│   └── useTimelineFilters.ts     # Persistencia localStorage
└── components/
    ├── TimelineGantt.tsx         # SVG Gantt con forwardRef + centerToday imperativo
    ├── TimelineFilters.tsx       # Panel de filtros
    ├── TimelineToolbar.tsx       # Zoom + Centrar Hoy
    └── TimelineLegend.tsx        # Leyenda de colores
frontend/lib/timelineColor.ts     # Single source of truth de bandas de color
```

### Decisión de implementación Gantt

Se evaluó `react-modern-gantt@0.9.x` y se descartó por incapacidad de soportar:
- Hitos diamante personalizados
- Estilos punteados para herencia
- Zoom Ctrl+scroll sin conflicto con DnD interno

Se implementó un **Gantt SVG custom** siguiendo el patrón de `frontend/app/decommission/[id]/page.tsx`.

## i18n

Bloque `timeline.*` y `sidebar.timeline` disponibles en los 6 idiomas: ES, EN, DE, FR, IT, PT.

## Seguridad

- Read-only: sin escrituras → sin `AuditLog` (A.8.15 aplica solo a operaciones de escritura).
- `search` escapa caracteres LIKE con `escapeLike()` antes de interpolación.
- `ciTypeId` validado como UUID por Zod antes de pasar a Prisma.
- `/legacy/:ciId` valida UUID vía `requireUuidParam('ciId')`.
- Todos los `$queryRaw` en `queryDecommission()` usan tagged template literals.
