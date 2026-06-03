# Plan de desarrollo v2.6.0 — DCIM Module (2D MVP)

> Estado: 🟢 LISTO para ejecución (Open Questions Q1-Q4 resueltas el 2026-06-03)
> Rama base: `develop`
> Rama feature: `feature/dcim-rooms` (a crear desde develop)
> Target: `main` tag `v2.6.0`
> Última actualización: 2026-06-03
> Tipo: FEATURE GRANDE (multi-fase), MVP 2D (3D va a v2.7.0 — Q1 ✅)

> ⚠️ Prerequisito: completar y mergear **v2.5.3** (bugfixes) antes de empezar v2.6.0.

---

## Checklist de hitos

| ID | Hito | Estado |
|----|------|--------|
| **M0** | Spec aprobado + Open Questions cerradas (Q1-Q4) | ⬅ SIGUIENTE |
| **M1** | Schema Prisma + migraciones DCIM | ⏳ Pendiente |
| **M2** | Backend CRUD + audit logs | ⏳ Pendiente |
| **M3** | Frontend masters extensions (Edificios/Plantas/Salas) | ⏳ Pendiente |
| **M4** | Frontend /dcim dashboard + room list | ⏳ Pendiente |
| **M5** | 2D rack elevation (SVG) | ⏳ Pendiente |
| **M6** | 2D room plan (SVG grid) | ⏳ Pendiente |
| ~~M7~~ | ~~3D room view (R3F)~~ — **movido a v2.7.0 por decisión Q1** | ⏭️ Backlog v2.7.0 |
| **M8** | Power alerts engine + heatmap overlay (Q4 ✅) | ⏳ Pendiente |
| **M9** | CI placement UI (asignar CI a U slot) + lifecycle workflow (Q4 ✅) | ⏳ Pendiente |
| **M10** | OWASP + Compliance review | ⏳ Pendiente |
| **M11** | Release v2.6.0 | ⏳ Pendiente |

**Orden estricto:** M0 → M1 → STOP → M2 → STOP → M3 → STOP → M4 → STOP → M5 → STOP → M6 → STOP → M8 → STOP → M9 → STOP → M10 → STOP → M11

Cada hito = 1 rama `task-NN/<descripción>` desde `feature/dcim-rooms`, merge `--no-ff` al feature branch.
Cuando todos los hitos están listos, merge `feature/dcim-rooms` → develop → main + tag v2.6.0.

---

## M0 — Aprobación de spec

- [ ] Revisar `docs/SPEC_v2.6.0_dcim.md`
- [ ] Responder Open Questions Q1, Q2, Q3, Q4
- [ ] Aceptar cambios propuestos (o pedir modificaciones)
- [ ] Crear rama `feature/dcim-3d-rooms` desde develop

---

## M1 — Schema Prisma + migraciones

Skill: `supabase-postgres-best-practices`

### Subtareas
- [ ] M1.1: Editar `backend/prisma/schema.prisma` — añadir modelos `DcimBuilding`, `DcimFloor`, `DcimRoom`, `DcimAisle`, `DcimFootprint` (según § 3 del spec)
- [ ] M1.2: Extender `HardwareCI` con `sizeU`, `powerW`, `rackTotalU`, `rackPowerMaxW`, `rackWidthMm`, `rackDepthMm`, `parentRackCiId`, `uPosition`, `orientation`
- [ ] M1.3: Crear migración `<ts>_dcim_initial/migration.sql` con:
  - CREATE TABLE para las 5 tablas DCIM (`IF NOT EXISTS`)
  - ALTER TABLE hardware_cis ADD COLUMN para los 9 nuevos campos
  - INSERT en `ci_types` para la fila `Rack` (`isSystem=true`)
  - CHECK constraints sobre dimensiones positivas
  - Rollback SQL en comentario
- [ ] M1.4: `prisma generate` + `prisma migrate deploy` en container
- [ ] M1.5: Verificar `\d dcim_buildings`, etc. en psql
- [ ] M1.6: Commit `feat(dcim M1): schema + migration for buildings, floors, rooms, aisles, footprints`

---

## M2 — Backend CRUD + audit logs

Skill: `supabase-postgres-best-practices`, `vibesec-skill`

### Subtareas
- [ ] M2.1: Endpoints CRUD para `DcimBuilding` (GET list, POST, PATCH, DELETE) — `requireAdmin` para writes, `requireAuditor` para reads. RBAC: VIEWER bloqueado.
- [ ] M2.2: Endpoints CRUD para `DcimFloor`
- [ ] M2.3: Endpoints CRUD para `DcimRoom`
- [ ] M2.4: Endpoints CRUD para `DcimAisle` (si Q2 = A o C)
- [ ] M2.5: Endpoints CRUD para `DcimFootprint`
- [ ] M2.6: Endpoints `assign-rack` / `unassign-rack` en footprints
- [ ] M2.7: Endpoint `PATCH /api/cis/:id/placement` para posicionar CI en rack
- [ ] M2.8: Endpoint `GET /api/dcim/dashboard` (KPIs)
- [ ] M2.9: Endpoint `GET /api/dcim/rooms/:id/plan` (devuelve grid + footprints + racks)
- [ ] M2.10: Endpoint `GET /api/dcim/racks/:ciId/elevation` (U slots + CIs)
- [ ] M2.11: Endpoint `GET /api/dcim/alerts` (overpower racks)
- [ ] M2.12: Audit logs en todos los writes (`CREATE_DCIM_*`, `UPDATE_DCIM_*`, `DELETE_DCIM_*`, `ASSIGN_RACK`, `UNASSIGN_RACK`, `CI_PLACEMENT`)
- [ ] M2.13: Smoke test API completo con curl + claude@cmdb.local
- [ ] M2.14: Commit por endpoint o por grupo lógico (no un único commit gigante)

---

## M3 — Frontend masters extensions

Skill: `vercel-react-best-practices`, `frontend-design`

### Subtareas
- [ ] M3.1: Nueva tab "Edificios" en `frontend/app/admin/masters/page.tsx` con CRUD
- [ ] M3.2: Nueva tab "Plantas"
- [ ] M3.3: Nueva tab "Salas/CPD" (kind selector: TECHNICAL_ROOM | CPD)
- [ ] M3.4: i18n: claves `masters.buildings.*`, `masters.floors.*`, `masters.rooms.*` en los 6 idiomas
- [ ] M3.5: Smoke test: crear edificio → planta → sala desde la UI
- [ ] M3.6: Commit

---

## M4 — /dcim dashboard + room list

Skill: `vercel-react-best-practices`, `frontend-design`

### Subtareas
- [ ] M4.1: Nueva entrada en `Sidebar.tsx` "Salas técnicas y CPD" (visible para ADMIN+AUDITOR)
- [ ] M4.2: Página `/dcim/page.tsx` — Dashboard con KPIs + lista de salas + widget alertas
- [ ] M4.3: Click en sala → navegar a `/dcim/rooms/[id]`
- [ ] M4.4: Página `/dcim/rooms/[id]/page.tsx` — skeleton con toggle 2D/3D (lógica viene en M5/M6/M7)
- [ ] M4.5: i18n `dcim.*` claves base (6 idiomas)
- [ ] M4.6: Commit

---

## M5 — 2D rack elevation

Skill: `vercel-react-best-packages`, `frontend-design`

### Subtareas
- [ ] M5.1: Componente `RackElevation2D.tsx` — SVG con N slots U (1=bottom, N=top), CIs ocupantes como rectángulos coloreados por status/criticidad
- [ ] M5.2: Hover sobre CI → tooltip con nombre/serial/uPosition
- [ ] M5.3: Click sobre CI → abre `CIDetailModal`
- [ ] M5.4: Drawer en `/dcim/rooms/[id]` que se abre al clicar un rack en el plano 2D
- [ ] M5.5: Smoke test con rack de prueba (10 CIs colocados)
- [ ] M5.6: Commit

---

## M6 — 2D room plan

Skill: `frontend-design`, `vercel-react-best-practices`

### Subtareas
- [ ] M6.1: Componente `RoomPlan2D.tsx` — SVG grid de N×M huellas, coloreado por kind (rack=verde, infra=gris, libre=blanco), pasillos resaltados
- [ ] M6.2: Click sobre huella tipo rack → drawer con `RackElevation2D`
- [ ] M6.3: Zoom + pan con `react-zoom-pan-pinch` o equivalente
- [ ] M6.4: Editor de plano (`/dcim/rooms/[id]/edit`) — drag&drop opcional, primero clic-para-añadir
- [ ] M6.5: Smoke test
- [ ] M6.6: Commit

---

## M7 — ⏭️ MOVIDO A v2.7.0

Decisión Q1 (2026-06-03): MVP es 2D-first. El toggle 2D/3D estará presente en la UI con 3D marcado como "Coming soon" para preparar el camino. Stack previsto para v2.7: `three` + `@react-three/fiber` + `@react-three/drei`.

---

## M8 — Power alerts engine + Heatmap overlay (Q4 ✅)

Skill: `supabase-postgres-best-practices`, `frontend-design`

### Subtareas
- [ ] M8.1: Endpoint `GET /api/dcim/alerts` — query que devuelve racks donde `SUM(child_cis.powerW) > rack.rackPowerMaxW`
- [ ] M8.2: Materializar en dashboard como widget de alertas
- [ ] M8.3: Cron diario opcional: detectar nuevas alertas y emitir audit log `DCIM_POWER_ALERT`
- [ ] M8.4: **Heatmap power overlay (Q4 ✅)**: capa SVG sobre `RoomPlan2D` con gradiente verde→amarillo→rojo según `(SUM powerW / rackPowerMaxW) %`. Toggle on/off.
- [ ] M8.5: i18n (`dcim.alerts.*`, `dcim.heatmap.*`)
- [ ] M8.6: Commit

---

## M9 — CI placement UI + Lifecycle workflow (Q4 ✅)

Skill: `vercel-react-best-practices`

### Subtareas — Placement
- [ ] M9.1: En `EditCIModal` (CIs hardware): añadir sección "Ubicación física" con selectores:
  - Sede → Edificio → Planta → Sala → Pasillo → Huella → Rack (cascading dropdowns)
  - uPosition (input numérico con validación contra `rackTotalU`)
  - **orientation** (radio FRONT/REAR — Q4 ✅)
  - sizeU + powerW (inputs numéricos)
- [ ] M9.2: Validación: no permitir colocar CI en U ocupado (conflict check con FRONT/REAR considerado por separado)
- [ ] M9.3: Endpoint backend `PATCH /api/cis/:id/placement` (ya creado en M2.7) + smoke test desde UI
- [ ] M9.4: `RackElevation2D` renderiza FRONT y REAR como vistas separadas (toggle en el drawer)

### Subtareas — Lifecycle (Q4 ✅)
- [ ] M9.5: Backend: añadir validación de transición de `lifecycleStatus` (PLANNED → IN_INVENTORY → COMMISSIONED → DECOMMISSIONED, con re-deploy permitido)
- [ ] M9.6: Endpoint `PATCH /api/cis/:id/lifecycle` con audit log `CI_LIFECYCLE_CHANGE`
- [ ] M9.7: UI: badge de lifecycle en `CIDetailModal` + selector en `EditCIModal`
- [ ] M9.8: Color-coding del rack/CI en `RackElevation2D` según lifecycle (gris=planned, normal=commissioned, tachado=decom)
- [ ] M9.9: i18n (`ci.lifecycle.*`)
- [ ] M9.10: Commit

---

## M10 — OWASP + Compliance review

- [ ] M10.1: Subagente `differential-review` sobre `git diff develop...feature/dcim-3d-rooms`
- [ ] M10.2: Output `docs/security-audit/owasp-v2.6.0.md`
- [ ] M10.3: Fix Critical/High inmediatamente (rama `task-NN/owasp-v2.6.0-fixes`)
- [ ] M10.4: Documentar Medium fix-or-backlog
- [ ] M10.5: Low → backlog en este fichero
- [ ] M10.6: Compliance review (ISO 27001 / GDPR / NIS2)
- [ ] M10.7: Output `docs/security/COMPLIANCE_v2.6.0.md`
- [ ] M10.8: Commit

---

## M11 — Release v2.6.0

- [ ] M11.1: Merge `feature/dcim-3d-rooms` → develop (`--no-ff`)
- [ ] M11.2: Actualizar `CLAUDE.md` (current → v2.6.0, previous → v2.5.3)
- [ ] M11.3: Actualizar `docs/USER_MANUAL.md` + `.en.md` con la nueva sección DCIM
- [ ] M11.4: Actualizar `docs/SYSADMIN_MANUAL.md` (no requiere cambios en compose, sólo notas)
- [ ] M11.5: Actualizar `docs/ARCHITECTURE.md` con diagrama de módulo DCIM
- [ ] M11.6: Merge develop → main + tag `v2.6.0`
- [ ] M11.7: Push: `git push origin main develop v2.6.0`
- [ ] M11.8: Crear GitHub Release (manual)
- [ ] M11.9: Memoria del proyecto actualizada

---

## Trazabilidad de cambios al plan

> Cualquier nueva especificación, bug encontrado durante el desarrollo, finding OWASP, o cambio de alcance se documenta aquí.

_(vacío)_

---

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

---

## Notas operativas

- **Auto Mode**: el usuario quiere revisar tarea por tarea → STOP tras cada hito completo
- **Branch strategy**: cada hito = subrama del `feature/dcim-3d-rooms`; tras OK del usuario, merge al feature branch (no a develop hasta el final)
- **Commits atómicos**: por subtarea M_x.y, no por hito completo
- **Push tras cada tarea**: el usuario lo pidió explícitamente
- **Skills disponibles**: `supabase-postgres-best-practices`, `vercel-react-best-practices`, `frontend-design`, `vibesec-skill`, `differential-review`, `documentation-writer`, `find-bugs`
- **Modelo planificación**: Opus. **Modelo ejecución**: Sonnet (recordatorio: cambiar antes de empezar M1)
