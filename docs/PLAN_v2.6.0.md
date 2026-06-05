# Plan de desarrollo v2.6.0 — DCIM Module (2D MVP)

> Estado: 🟢 LISTO para ejecución (Open Questions Q1-Q4 + decisiones arquitectónicas cerradas el 2026-06-04)
> Rama base: `develop`
> Rama feature: `feature/dcim-rooms` (a crear desde develop)
> Target: `main` tag `v2.6.0`
> Última actualización: 2026-06-04
> Tipo: FEATURE GRANDE (multi-fase), MVP 2D (3D va a v2.7.0 — Q1 ✅)

> ⚠️ Prerequisito: v2.5.3 ya mergeada y publicada (main tag v2.5.3, 95bd112).

---

## Decisiones arquitectónicas — 2026-06-04

Tras revisión del grafo de conocimiento (`graphify-out/`) y análisis del estado actual:

| Decisión | Razón |
|----------|-------|
| **Backend: módulo dedicado** `backend/src/modules/dcim/` (router + schemas + audit) | C0 monolith ya tiene cohesion 0.02 (graphify). Patrón confirmado por C28 RAG (0.08) y C56 Serializer (0.14). Aditivo, no parte código existente. Sienta patrón para v2.7.x. |
| **Lifecycle workflow → deferido a v2.6.1** | Es cross-cutting (afecta a TODOS los hardware CIs, no solo DCIM). v2.6.0 = puro DCIM, focalizado. |
| **M3 masters tabs → eliminado** | `/admin/masters` ya tiene 8 tabs; +3 saturaba UX. CRUD vivirá en `/dcim/admin/*`. |
| **`requireUuidParam('id')` blanket** | Aplicar a TODOS los `:id` de DCIM **y** retroactivar a `/api/contracts/:id`, `/api/documents/:id`, `/api/licenses/:id`, `/api/masters/*/:id` — cierra F-02 del backlog v2.6.x. |
| **M0 simplificado** | Q1-Q4 ya cerradas. M0 = crear branch (un comando). |

---

## Checklist de hitos

| ID | Hito | Estado |
|----|------|--------|
| **M0** | Crear `feature/dcim-rooms` desde develop | ⬅ SIGUIENTE |
| **M1** | Schema Prisma + migración DCIM | ⏳ Pendiente |
| **M2** | Backend `modules/dcim/` + CRUD + audit logs + `requireUuidParam` blanket | ⏳ Pendiente |
| ~~M3~~ | ~~Frontend masters extensions~~ — **eliminado** (CRUD vivirá en `/dcim/admin/`) | ⏭️ ELIMINADO |
| **M4** | Frontend `/dcim` dashboard + room list + CRUD inline | ⏳ Pendiente |
| **M5** | 2D rack elevation (SVG) | ⏳ Pendiente |
| **M6** | 2D room plan (SVG o reactflow — evaluar en kickoff) | ⏳ Pendiente |
| ~~M7~~ | ~~3D room view (R3F)~~ — **movido a v2.7.0** (Q1) | ⏭️ Backlog v2.7.0 |
| **M8** | Power alerts engine + Heatmap overlay (Q4 ✅) | ⏳ Pendiente |
| **M9** | CI placement UI (`PlaceCIModal` dedicado) | ⏳ Pendiente |
| ~~M9-lifecycle~~ | ~~Lifecycle workflow~~ — **deferido a v2.6.1** | ⏭️ Backlog v2.6.1 |
| **M10** | OWASP `differential-review` + Compliance review | ⏳ Pendiente |
| **M11** | Release v2.6.0 | ⏳ Pendiente |

**Orden estricto:** M0 → M1 → STOP → M2 → STOP → M4 → STOP → M5 → STOP → M6 → STOP → M8 → STOP → M9 → STOP → M10 → STOP → M11

Cada hito = 1 rama `task-NN/<descripción>` desde `feature/dcim-rooms`, merge `--no-ff` al feature branch.
Cuando todos los hitos están listos, merge `feature/dcim-rooms` → develop → main + tag v2.6.0.

---

## M0 — Crear branch

```bash
git checkout develop && git pull --ff-only
git checkout -b feature/dcim-rooms
```

---

## M1 — Schema Prisma + migración

Skill: `supabase-postgres-best-practices`

### Subtareas
- [ ] M1.1: Editar `backend/prisma/schema.prisma` — añadir modelos `DcimBuilding`, `DcimFloor`, `DcimRoom`, `DcimAisle`, `DcimFootprint` (según § 3 del spec)
- [ ] M1.2: Extender `HardwareCI` con `sizeU`, `powerW`, `rackTotalU`, `rackPowerMaxW`, `rackWidthMm`, `rackDepthMm`, `parentRackCiId`, `uPosition`, `orientation`. **NO añadir `lifecycleStatus`** (deferido a v2.6.1).
- [ ] M1.3: Crear migración `<ts>_dcim_initial/migration.sql` con:
  - CREATE TABLE para las 5 tablas DCIM (`IF NOT EXISTS`)
  - ALTER TABLE hardware_cis ADD COLUMN para los 9 nuevos campos
  - INSERT en `ci_types` para la fila `Rack` (`isSystem=true`)
  - CHECK constraints sobre dimensiones positivas + `rackTotalU IS NOT NULL` requerido cuando ciType=Rack (documentar invariante)
  - Rollback SQL en comentario
- [ ] M1.4: `prisma generate` + `prisma migrate deploy` en container
- [ ] M1.5: Verificar `\d dcim_buildings`, etc. en psql
- [ ] M1.6: Commit `feat(dcim M1): schema + migration for buildings, floors, rooms, aisles, footprints`

---

## M2 — Backend `modules/dcim/` + CRUD + audit logs

Skill: `supabase-postgres-best-practices`, `vibesec-skill`

> **Cambio arquitectónico v2.6.0**: en lugar de añadir endpoints a `backend/src/index.ts` (cohesion ya 0.02), crear módulo dedicado. Patrón inspirado en `backend/src/services/{ragService,entitySerializer}.ts` (graphify confirmó cohesion 0.08-0.14, mejor que el monolito).

### Estructura del módulo

```
backend/src/modules/dcim/
  router.ts        — Express Router con todos los endpoints
  schemas.ts       — Zod schemas (DcimBuildingCreate, DcimRoomUpdate, ...)
  audit.ts         — helpers para emitir audit logs DCIM
  middleware.ts    — re-export tipo `requireUuidParam`, `requireAdmin`, etc.
  queries.ts       — queries Prisma reutilizables (dashboard KPIs, heatmap SUM)
```

Montaje desde `index.ts`:
```typescript
import { dcimRouter } from './modules/dcim/router';
app.use('/api/dcim', dcimRouter);
```

### Subtareas

- [ ] M2.0: **Defensa retroactiva** — aplicar `requireUuidParam('id')` a TODOS los `:id` existentes en `index.ts` (cierra F-02 backlog): `/api/contracts/:id`, `/api/documents/:id`, `/api/licenses/:id`, `/api/masters/*/:id`. Commit independiente: `fix(security): blanket requireUuidParam on :id routes (closes F-02)`.
- [ ] M2.1: Crear `backend/src/modules/dcim/{router,schemas,audit,middleware,queries}.ts` esqueletos.
- [ ] M2.2: Endpoints CRUD para `DcimBuilding` — `authenticateToken, requireAudit` (GETs) / `authenticateToken, requireAdmin, requireUuidParam('id')` (writes). RBAC: VIEWER bloqueado en GETs también.
- [ ] M2.3: Endpoints CRUD para `DcimFloor`
- [ ] M2.4: Endpoints CRUD para `DcimRoom`
- [ ] M2.5: Endpoints CRUD para `DcimAisle`
- [ ] M2.6: Endpoints CRUD para `DcimFootprint`
- [ ] M2.7: Endpoints `POST/DELETE /api/dcim/footprints/:id/assign-rack`
- [ ] M2.8: Endpoint `PATCH /api/cis/:id/placement` (vive en `index.ts` porque es ruta de CI, no de DCIM — pero usa helpers de `modules/dcim/queries`)
- [ ] M2.9: Endpoint `GET /api/dcim/dashboard` (KPIs)
- [ ] M2.10: Endpoint `GET /api/dcim/rooms/:id/plan` (grid + footprints + racks)
- [ ] M2.11: Endpoint `GET /api/dcim/racks/:ciId/elevation` (U slots + CIs ocupantes)
- [ ] M2.12: Endpoint `GET /api/dcim/alerts` — query con `LEFT JOIN LATERAL` + `GROUP BY rack_id` (no N+1)
- [ ] M2.13: Audit logs en todos los writes (`CREATE_DCIM_*`, `UPDATE_DCIM_*`, `DELETE_DCIM_*`, `ASSIGN_RACK`, `UNASSIGN_RACK`, `CI_PLACEMENT`)
- [ ] M2.14: Smoke test script `backend/scripts/dcim-smoke.sh` — bash + curl + claude@cmdb.local que ejecuta flow completo (crear building → floor → room → footprint → assign rack → placement CI → verificar dashboard → cleanup). Falla CI si algún paso rompe.
- [ ] M2.15: Commit por endpoint o por grupo lógico (no un único commit gigante)

---

## M3 — ⏭️ ELIMINADO

Decisión 2026-06-04: en lugar de añadir 3 tabs nuevas a `/admin/masters` (que ya tiene 8 y satura UX), el CRUD de Buildings/Floors/Rooms vivirá inline en `/dcim/admin/*` o en `/dcim` mismo. Esto da contexto visual mientras editas.

---

## M4 — /dcim dashboard + room list + CRUD inline

Skill: `vercel-react-best-practices`, `frontend-design`

### Subtareas
- [ ] M4.1: Nueva entrada en `Sidebar.tsx` "Salas técnicas y CPD" (visible para ADMIN+AUDITOR; VIEWER no la ve). i18n key `nav.dcim`.
- [ ] M4.2: Página `/dcim/page.tsx` — Dashboard con KPIs + lista de salas + widget alertas. ADMIN ve botón "Nuevo edificio" / "Nueva sala" inline.
- [ ] M4.3: CRUD inline Buildings/Floors/Rooms en `/dcim/admin/page.tsx` (cascading) o como sub-componentes del dashboard.
- [ ] M4.4: Click en sala → navegar a `/dcim/rooms/[id]`
- [ ] M4.5: Página `/dcim/rooms/[id]/page.tsx` — vista única con **modo edit toggle** (patrón Tarea Q CIDetailModal). NO crear `/edit` separado para reducir drift.
- [ ] M4.6: i18n `dcim.*` claves base (6 idiomas) — usar prefijos `dcim.dashboard.*`, `dcim.room.*`, `dcim.building.*`, etc.
- [ ] M4.7: Commit

---

## M5 — 2D rack elevation

Skill: `vercel-react-best-practices`, `frontend-design`

### Subtareas
- [ ] M5.1: Componente `RackElevation2D.tsx` — **SVG puro** (no reactflow — es una columna estática sin pan/zoom). N slots U (1=bottom, N=top), CIs ocupantes como rectángulos coloreados por status/criticidad.
- [ ] M5.2: Hover sobre CI → tooltip con nombre/serial/uPosition/orientation
- [ ] M5.3: Click sobre CI → abre `CIDetailModal` existente
- [ ] M5.4: Toggle FRONT/REAR (Q4 ✅) — renderiza la vista correspondiente
- [ ] M5.5: Drawer en `/dcim/rooms/[id]` que se abre al clicar un rack en el plano 2D
- [ ] M5.6: Smoke test con rack de prueba (10 CIs colocados, mix FRONT/REAR)
- [ ] M5.7: Commit

---

## M6 — 2D room plan

Skill: `frontend-design`, `vercel-react-best-practices`

> **Evaluar en kickoff de M6**: usar `reactflow` (ya instalado, usado en `/map`) con custom nodes para footprints vs `SVG + react-zoom-pan-pinch`. ReactFlow da pan/zoom/click handlers gratis. La decisión final depende de cuán "libre" se quiere el editor.

### Subtareas
- [ ] M6.1: Componente `RoomPlan2D.tsx` — grid N×M, celdas coloreadas por kind (rack=verde, infra=gris, libre=blanco), pasillos resaltados
- [ ] M6.2: Click sobre huella tipo rack → drawer con `RackElevation2D` (M5)
- [ ] M6.3: Pan + zoom (reactflow nativo o `react-zoom-pan-pinch` según decisión M6.1)
- [ ] M6.4: Modo edit (visible para ADMIN) — clic-para-añadir huellas, marcar tipo, asignar pasillo. Drag&drop opcional v2.7.
- [ ] M6.5: Smoke test
- [ ] M6.6: Commit

---

## M7 — ⏭️ MOVIDO A v2.7.0

Decisión Q1 (2026-06-03): MVP es 2D-first. Toggle 2D/3D presente en UI con 3D marcado como "Coming soon" para preparar el camino. Stack previsto para v2.7: `three` + `@react-three/fiber` + `@react-three/drei`.

---

## M8 — Power alerts engine + Heatmap overlay

Skill: `supabase-postgres-best-practices`, `frontend-design`

### Subtareas
- [ ] M8.1: Endpoint `GET /api/dcim/alerts` — **una sola query** con `LEFT JOIN LATERAL (SELECT SUM(power_w) FROM ... WHERE parent_rack_ci_id = rack.id)` + `GROUP BY rack_id`. Returns racks donde `sum_power_w > rack_power_max_w`. **No N+1**.
- [ ] M8.2: Materializar en dashboard como widget de alertas
- [ ] M8.3: Cron diario opcional: detectar nuevas alertas y emitir audit log `DCIM_POWER_ALERT`
- [ ] M8.4: **Heatmap power overlay (Q4 ✅)**: capa sobre `RoomPlan2D` con gradiente verde→amarillo→rojo según `(sum_powerW / rack_power_max_w) %`. Toggle on/off. Reutiliza la misma query de M8.1.
- [ ] M8.5: i18n (`dcim.alerts.*`, `dcim.heatmap.*`)
- [ ] M8.6: Commit

---

## M9 — CI placement UI

Skill: `vercel-react-best-practices`

> **Cambio arquitectónico v2.6.0**: en lugar de meter la sección "Ubicación física" dentro de `EditCIModal` (que ya es grande — C74 en graphify), crear modal dedicado **`PlaceCIModal.tsx`** abierto desde un botón "Ubicar en rack" en `EditCIModal` y `CIDetailModal`. Separation of concerns.

### Subtareas — Placement
- [ ] M9.1: Componente `PlaceCIModal.tsx` con:
  - Cascading dropdowns: Sede → Edificio → Planta → Sala → Pasillo → Huella → Rack
  - `uPosition` (input numérico con validación contra `rackTotalU`)
  - `orientation` (radio FRONT/REAR — Q4 ✅)
  - `sizeU` + `powerW` (inputs numéricos, prefilled si el CI ya los tiene)
- [ ] M9.2: Validación cliente: no permitir colocar CI en U ocupado (conflict check llamando a `GET /api/dcim/racks/:ciId/elevation` y FRONT/REAR considerados por separado)
- [ ] M9.3: Validación servidor: el endpoint `PATCH /api/cis/:id/placement` también valida overlapping (defense in depth)
- [ ] M9.4: Botón "Ubicar en rack" en `EditCIModal` + `CIDetailModal` (solo ADMIN, solo si `ciType=HARDWARE` y `parentRackCiId != null` muestra "Mover a otro rack" / "Quitar del rack")
- [ ] M9.5: `RackElevation2D` (M5) ya soporta toggle FRONT/REAR — verificar integración
- [ ] M9.6: i18n (`dcim.place.*`)
- [ ] M9.7: Commit

> **Lifecycle workflow deferido a v2.6.1** — no se implementa en este hito. Documentar como "próximo release" en el User Manual.

---

## M10 — OWASP + Compliance review

> Sugerencia: ejecutar `differential-review` también al final de M2 y M9 como checkpoint mid-flight (no solo aquí). Critical/High atrapados pronto cuestan menos.

- [ ] M10.1: Subagente `differential-review` sobre `git diff develop...feature/dcim-rooms`
- [ ] M10.2: Output `docs/security-audit/owasp-v2.6.0.md`
- [ ] M10.3: Fix Critical/High inmediatamente (rama `task-NN/owasp-v2.6.0-fixes`)
- [ ] M10.4: Documentar Medium fix-or-backlog
- [ ] M10.5: Low → backlog en este fichero
- [ ] M10.6: Compliance review (ISO 27001 / GDPR / NIS2 / ISO 22301)
- [ ] M10.7: Output `docs/security/COMPLIANCE_v2.6.0.md`
- [ ] M10.8: Commit

---

## M11 — Release v2.6.0

- [ ] M11.1: Merge `feature/dcim-rooms` → develop (`--no-ff`)
- [ ] M11.2: Actualizar `CLAUDE.md` (current → v2.6.0, previous → v2.5.3)
- [ ] M11.3: Actualizar `docs/USER_MANUAL.md` + `.en.md` con la nueva sección DCIM
- [ ] M11.4: Actualizar `docs/SYSADMIN_MANUAL.md` (no requiere cambios en compose, sólo notas sobre la nueva tabla)
- [ ] M11.5: Actualizar `docs/ARCHITECTURE.md` con diagrama de módulo DCIM y el nuevo patrón `backend/src/modules/`
- [ ] M11.6: Merge develop → main + tag `v2.6.0`
- [ ] M11.7: Push: `git push origin main develop v2.6.0`
- [ ] M11.8: Crear GitHub Release (manual)
- [ ] M11.9: Memoria del proyecto actualizada

---

## Trazabilidad de cambios al plan

| Fecha | Cambio | Razón |
|-------|--------|-------|
| 2026-06-04 | Backend → módulo dedicado `modules/dcim/` | Grafo confirmó C0 cohesion 0.02; C28/C56 son modelos limpios (0.08-0.14) |
| 2026-06-04 | Lifecycle workflow deferido a v2.6.1 | Cross-cutting concern; afecta a todos los CIs hardware, no solo DCIM |
| 2026-06-04 | M3 eliminado | `/admin/masters` ya tiene 8 tabs; CRUD inline en `/dcim` da mejor UX |
| 2026-06-04 | `requireUuidParam` blanket retroactivo | Cierra F-02 del backlog v2.6.x — lección de Tarea P v2.5.3 |
| 2026-06-04 | M0 simplificado a "crear branch" | Q1-Q4 ya cerradas el 2026-06-03 |
| 2026-06-04 | M9 placement → modal dedicado `PlaceCIModal` | EditCIModal ya saturado (C74 en graphify) |
| 2026-06-04 | M8 alerts query especificada (no N+1) | Performance — query con `LATERAL JOIN` + `GROUP BY` |
| 2026-06-04 | M4 toggle edit inline (no `/edit` separada) | Patrón Tarea Q CIDetailModal — reduce drift |
| 2026-06-04 | Typos corregidos | `requireAuditor`→`requireAudit`, `vercel-react-best-packages`→`...-practices`, `feature/dcim-3d-rooms`→`feature/dcim-rooms` |

---

## Backlog DCIM v2.6.1 (próximo)

- **Lifecycle workflow** (PLANNED → IN_INVENTORY → COMMISSIONED → DECOMMISSIONED) — feature focalizada en gestión de ciclo de vida de hardware. Tocará: inventory page, CIDetailModal, EditCIModal, AddCIModal, bulk import, badges, color-coding en RackElevation2D, audit log `CI_LIFECYCLE_CHANGE`.

## Backlog DCIM v2.7.x

> Items fuera de scope para v2.6.0. La vista 3D va aquí por decisión Q1 (2D-first).

- **3D room view (R3F + three.js + drei)** — feature principal de v2.7.0
- DXF/PDF/SVG import del plano (decisión Q3)
- Weight tracking por rack (decisión Q4 — no seleccionado)
- Cable management (power + network port-to-port) (decisión Q4 — no seleccionado)
- "What-If" placement simulator (decisión Q4 — no seleccionado)
- Half-U / asymmetric devices (decisión Q4 — no seleccionado)
- Environmental sensors integration (temp/humidity)
- AR mode
- Time-lapse playback (capacity over time)
- Fault-tolerance simulator
- 3D models GLTF de chasis específicos (Dell PowerEdge, Cisco Catalyst, etc.)
- F-04 i18n key-parity check script (no aceptado en v2.6.0 — añadir si surge desync)
- F-07 API drift checker frontend↔backend (no aceptado en v2.6.0 — opcional)

---

## Notas operativas

- **Auto Mode**: el usuario quiere revisar tarea por tarea → STOP tras cada hito completo
- **Branch strategy**: cada hito = subrama del `feature/dcim-rooms`; tras OK del usuario, merge al feature branch (no a develop hasta el final)
- **Commits atómicos**: por subtarea M_x.y, no por hito completo
- **Push tras cada tarea**: el usuario lo pidió explícitamente
- **Skills disponibles**: `supabase-postgres-best-practices`, `vercel-react-best-practices`, `frontend-design`, `vibesec-skill`, `differential-review`, `documentation-writer`, `find-bugs`
- **Modelo planificación**: Opus. **Modelo ejecución**: Sonnet (recordatorio: cambiar antes de empezar M1)
- **Defensa estándar**: TODOS los `:id` routes nuevos llevan `requireUuidParam('id')` desde día 1
- **Patrón módulo**: cualquier feature grande siguiente (v2.7.x DCIM 3D, etc.) replica `backend/src/modules/<name>/` — no añadir más al monolito
