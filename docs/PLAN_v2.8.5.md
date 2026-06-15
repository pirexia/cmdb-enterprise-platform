# Plan v2.8.5 — Bug Sidebar + Marketplace + Módulo Decomisionado

> Documento vivo de seguimiento del plan v2.8.5.
> Actualizar tras cada tarea completada.
> Última actualización: 2026-06-15.
> Base: tag `v2.8.4` (módulo alertas email profesional).

---

## 1. Resumen ejecutivo

v2.8.5 entrega tres bloques independientes:

1. **Bug fix crítico** — Sidebar duplicado en `/plugins/admin` (y latente en `/admin/certificates`) por doble envoltura de `AppShell`. Fix de 1-2 commits.
2. **Marketplace de plugins completo** — el proxy `/api/plugins/marketplace` ya existe pero falta endurecimiento (Zod upstream, cache TTL, allowlist SSRF), flujo de instalación desde marketplace (`POST /marketplace/install`) y rejilla UI con filtros. Plus documentación.
3. **Módulo Decomisionado (core)** — nuevo módulo `backend/src/modules/decommission/` + `frontend/app/decommission/` para gestionar planes de desconexión de sistemas: inventario recursivo (CTE sobre `CIRelation`), Gantt, CRUD docs/contratos/licencias, validación de fechas padre-hijo, impresión selectiva. La "fecha de baja" usa el DateType existente `decommission-date` vía `CIDate`.

---

## 2. Decisiones arquitectónicas (aprobadas 2026-06-15)

| # | Decisión | Elección |
|---|----------|----------|
| D1 | Implementación del Decomisionado | **Módulo core** (patrón DCIM): `backend/src/modules/decommission/` + `frontend/app/decommission/`. No plugin iframe. |
| D2 | Fecha de baja del CI Sistema | **Reusar DateType/CIDate** con el DateType existente `code='decommission-date'` (`Fecha de Baja Programada`). Sin columna nueva. |
| D3 | Alcance del Marketplace | **Completo**: hardening backend + cache + allowlist SSRF + flujo de instalación + rejilla UI con filtros + docs. |
| D4 | CIType "Sistema" | Seed idempotente en migración. El DateType `decommission-date` ya existe (migración `20260614100000_date_types`). No se recrea. |
| D5 | Gantt | Evaluar `gantt-task-react` vs SVG custom al iniciar T4. Si dependencia nueva → `npm audit` obligatorio y consulta explícita. |
| D6 | SSRF en marketplace | `PLUGIN_MARKETPLACE_URL` y `downloadUrl` del JSON upstream validadas contra allowlist HTTPS-only, sin IP privadas, sin `file://`. |

---

## 3. Tareas

### T1 · Fix Sidebar duplicado — `fix/plugin-admin-sidebar-duplicated`

**Estado:** ✅ COMPLETADA — 2026-06-15
**Complejidad:** Baja
**Rama:** `fix/plugin-admin-sidebar-duplicated`

**Causa raíz:** `app/layout.tsx:28` envuelve TODAS las páginas en `<AppShell>`. Las páginas `plugins/admin/page.tsx` (L328, L339) y `admin/certificates/page.tsx` (L119) también renderizan `<AppShell>` → doble Sidebar.

**Fix:** Sustituir `<AppShell>` interno por `<>…</>` (fragment) en ambas páginas. Quitar import de `AppShell`.

**Archivos:**
- `frontend/app/plugins/admin/page.tsx`
- `frontend/app/admin/certificates/page.tsx`

**Skills:** `vercel-react-best-practices`, `find-bugs`, `webapp-testing`
**DoD:** Sidebar único en ambas rutas, verificación visual.
**Commits estimados:** 1-2
**Commits realizados:** `4e85362` fix(ui): remove double AppShell wrapper in plugins/admin and admin/certificates
**PR:** pendiente apertura

---

### T2 · Marketplace completo — `feature/plugin-marketplace`

**Estado:** ⬜ PENDIENTE
**Complejidad:** Media
**Rama:** `feature/plugin-marketplace`

**Backend:**
- Zod schema del JSON upstream: `{plugins:[{id,name,version,description,author,downloadUrl,iconUrl,minPlatformVersion,permissions[],category}]}`
- Cache TTL 5 min (Map en memoria)
- Allowlist SSRF en `PLUGIN_MARKETPLACE_URL` y en `downloadUrl` (HTTPS, no IP privada, no `file://`, no `localhost`)
- Rate-limit 10/min para marketplace
- Endpoint `POST /api/plugins/marketplace/install`: download→magic bytes+manifest Zod→checksum SHA-256→registrar→activar (reutiliza pipeline de `/upload`)

**Frontend (`plugins/admin/page.tsx`):**
- Nueva pestaña/sección "Marketplace"
- Rejilla de tarjetas: nombre, autor, versión, descripción, categoría, badge versión mínima (deshabilitar si incompatible)
- Filtros por categoría + búsqueda por nombre
- Botón "Instalar" con feedback de progreso
- i18n ×6

**Docs:**
- `docs/PLUGIN_MARKETPLACE.md` (nuevo): formato del JSON, env vars, publicar plugin, seguridad
- `docs/SYSADMIN_MANUAL.md` + `.en.md`: vars `PLUGIN_ENABLE_MARKETPLACE`, `PLUGIN_MARKETPLACE_URL`
- `docs/PLUGIN_ENGINE.md`: sección marketplace
- `README.md`: feature marketplace

**Skills:** `vibesec-skill`, `api-security-hardening`, `owasp-security`, `express-typescript`, `frontend-design`, `documentation-writer`
**DoD:** Endpoint funcional con URL configurada, rejilla UI, instalación end-to-end, `tsc --noEmit` limpio.
**Commits estimados:** 4-6
**Commits realizados:** —
**PR:** —

---

### T3 · Seed CIType "Sistema" — `feature/ci-type-sistema`

**Estado:** ✅ COMPLETADA — 2026-06-15
**Complejidad:** Baja
**Rama:** `feature/ci-type-sistema`

**Migración idempotente** (`ON CONFLICT DO NOTHING`) que siembra:
- CITypeCategory **"LOGICAL"** (Lógico / Aplicación, sort_order 7) — categoría nueva para entes lógicos
- CIType **"SISTEMA"** bajo categoría `LOGICAL` — para planes de decomisionado
- **NO** se crea DateType `decommission-date` — ya existía en `20260614100000_date_types`

**Archivos:**
- `backend/prisma/migrations/20260615130000_add_ci_type_sistema/migration.sql` ✅
- Migración registrada en `_prisma_migrations` y aplicada en prod postgres ✅

**Skills:** `prisma-development`, `supabase-postgres-best-practices`
**Commits realizados:** `f82f3e0` feat(data): seed CITypeCategory LOGICAL and CIType SISTEMA
**PR:** #145

---

### T4 · Módulo Decomisionado — `feature/decommission-plan`

**Estado:** ⬜ PENDIENTE
**Complejidad:** Alta
**Rama:** `feature/decommission-plan`
**Depende de:** T3

**Schema (migración manual idempotente):**
- `decommission_plan` (id, name, system_ci_id, status DRAFT/ACTIVE/COMPLETED/CANCELLED, created_by, created_at, updated_at, completed_at)
- `decommission_plan_ci` (id, plan_id, ci_id, parent_ci_id?, depth, is_shared, scheduled_date, notes, sort_order)
- `decommission_plan_document` (id, plan_id, document_id, source AUTO/MANUAL)
- `decommission_plan_contract` (id, plan_id, contract_id, source AUTO/MANUAL)
- `decommission_plan_license` (id, plan_id, license_id, source AUTO/MANUAL)

**Backend `modules/decommission/`:**
- `schemas.ts` — Zod: PlanCreate, PlanUpdate, CIUpdate
- `queries.ts` — Prisma queries
- `middleware.ts` — requirePlanOwner, validatePlanStatus
- `audit.ts` — insertDecommissionAudit()
- `router.ts` — rutas (ver tabla)
- `__tests__/` — tests unitarios/integración

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/decommission/plans` | Listar planes |
| POST | `/api/decommission/plans` | Crear plan (requiere systemCiId) |
| GET | `/api/decommission/plans/:id` | Detalle de plan |
| PATCH | `/api/decommission/plans/:id` | Actualizar plan |
| DELETE | `/api/decommission/plans/:id` | Eliminar plan |
| POST | `/api/decommission/plans/:id/generate` | Generar inventario CIs (CTE recursiva, exige CIDate decommission-date) |
| GET | `/api/decommission/plans/:id/cis` | Listar CIs del plan con anidación |
| PATCH | `/api/decommission/plans/:id/cis/:ciId` | Actualizar fecha/notes de CI en plan |
| GET | `/api/decommission/plans/:id/gantt` | Datos Gantt |
| GET | `/api/decommission/plans/:id/export` | Exportar Excel |
| GET/POST/DELETE | `/api/decommission/plans/:id/documents` | CRUD documentos |
| GET/POST/DELETE | `/api/decommission/plans/:id/contracts` | CRUD contratos |
| GET/POST/DELETE | `/api/decommission/plans/:id/licenses` | CRUD licencias |

**Lógica `/generate`:**
1. Verificar CI es de tipo "Sistema"
2. Verificar que tiene `CIDate` con `DateType.code = 'decommission-date'` → error 400 si falta
3. CTE recursiva sobre `CIRelation` con set de visitados + límite profundidad (anti-ciclos)
4. Calcular `depth`, `isShared` (relacionado con otro CI tipo "Sistema" distinto)
5. Heredar AUTO docs/contratos/licencias
6. `scheduledDate` default = fecha de baja del Sistema

**Validación de fechas:** `fecha_hijo ≤ fecha_padre` → warning en response + badge rojo en UI.

**Frontend `app/decommission/`:**
- `page.tsx` — lista de planes (tabla + botón Nuevo Plan)
- `[id]/page.tsx` — detalle: inventario jerárquico, Gantt, docs, contratos, licencias, impresión
- i18n ×6 (claves en los 6 `locales/*.json`)

**Skills:** `prisma-development`, `vibesec-skill`, `express-typescript`, `react-flow-node-ts`, `frontend-design`, `javascript-typescript-jest`, `documentation-writer`
**DoD:** CRUD funcional, `/generate` recursivo, Gantt visible, impresión, `tsc --noEmit` limpio, tests pasando.
**Commits estimados:** 8-12
**Commits realizados:** —
**PR:** —

---

### T5 · Cierre v2.8.5 — (en `develop` → `main`)

**Estado:** ⬜ PENDIENTE
**Complejidad:** Media
**Depende de:** T1, T2, T3, T4

**Checklist:**
- [ ] `README.md` — features v2.7.0, v2.8.0-2.8.5, stack, env vars
- [ ] `CHANGELOG.md` — entrada `[2.8.5] - 2026-06-XX`
- [ ] `docs/ARCHITECTURE.md` + `.en.md` — modelo de datos actualizado, diagramas
- [ ] `docs/USER_MANUAL.md` + `.en.md` — Marketplace, Plan de Decomisionado
- [ ] `docs/SYSADMIN_MANUAL.md` + `.en.md` — env vars nuevas
- [ ] `docs/SECURITY_AUDIT.md` — matriz de acceso nuevos endpoints, SSRF marketplace
- [ ] `docs/PLUGIN_ENGINE.md` — sección Marketplace, ejemplo Decomisionado
- [ ] `docs/PLUGIN_MARKETPLACE.md` — nuevo
- [ ] `CLAUDE.md` sección Plan Activo — estado FINALIZADO
- [ ] MEMORY.md — decisiones clave v2.8.5
- [ ] PR `develop` → `main` — creado y mergeado
- [ ] Tag `v2.8.5` en `main` + Release GitHub

**Commits estimados:** 3-4
**Commits realizados:** —
**PR:** —

---

## 4. Diagrama de dependencias

```mermaid
graph LR
    T1[T1 Bug Sidebar] --> T5[T5 Cierre/Release]
    T2[T2 Marketplace] --> T5
    T3[T3 CIType Sistema] --> T4[T4 Módulo Decomisionado]
    T4 --> T5
```

## 5. Orden de ejecución

**Secuencia:** T1 → T3 → T4 → T2 → T5
(T1, T2, T3 son paralelizables entre sí)

## 6. Riesgos

| ID | Riesgo | Mitigación |
|----|--------|-----------|
| R1 | Dependencia Gantt nueva | `npm audit` + alternativa SVG custom si CVEs |
| R2 | Ciclos en CIRelation | CTE con set visitados + tope profundidad (patrón del mapa) |
| R3 | SSRF en downloadUrl marketplace | Allowlist HTTPS, no IPs privadas, no file://, checksum |
| R4 | Base develop desactualizada | `git checkout develop && git pull` al inicio |
