# PLAN_STATUS v3.4.0 — Reporting Engine

> **Estado global:** 🔄 Tarea 1 (diseño, Opus) COMPLETADA · Tareas 2–8 ⏳ pendientes (ejecución Sonnet)
> **Rama:** `feature/v3.4.0-reporting-engine` (cortar de `develop`) → destino `develop`. **NO merge a `main`.**
> **Decisión de arquitectura clave (confirmada por usuario):** extensibilidad de plugins en **dos niveles** (core closures + plugin route sandboxed). Ver §3.

---

## 1. Resumen ejecutivo

Sustituir los reportes actuales (client-side en `frontend/app/reports/page.tsx`, 675 líneas, 3 reportes) por un **módulo backend `reports`** con registry extensible, RBAC por reporte, 10 reportes estándar, exportación CSV/XLSX server-side, y un frontend listado + viewer. Patrón de módulo: referencia `dcim` / `timeline`.

## 2. Hallazgos del análisis (Tarea 1)

| Hallazgo | Detalle | Impacto en el plan |
|---|---|---|
| Modelo CI | `model CI` → tabla `configuration_items` (`schema.prisma:299`) | Queries usan `prisma.cI` |
| Vulnerabilidades | Campo `vulnerabilities Json?` en CI (`schema.prisma:369`), **no** modelo aparte | Reporte Seguridad agrega sobre JSONB |
| Fechas EOL/EOS | En `ci_dates` / `base_software_dates` | Reportes Obsolescencia + Lifecycle leen de ahí |
| Plugin Engine | `vm` sandbox, handlers = **code-strings** en BD, registran hooks/cron/**routes** vía manifest. NO closures vivas (`engine.ts`) | Tarea 5 = dos niveles (§3) |
| Reportes actuales | Obsolescencia, Contratos, Seguridad — los 3 están entre los 10 estándar | Tarea 4 = implementarlos como core + reemplazar la página |
| Roles | ADMIN (write) · AUDITOR (read+audit) · VIEWER (read) | Rank VIEWER(1) < AUDITOR(2) < ADMIN(3); `minRole` = rank ≥ |

## 3. Decisión de arquitectura — extensibilidad de plugins (DOS NIVELES)

- **Reportes core (los 10):** se registran con `registerReport(def)` usando una **closure in-process** (`def.query: (prisma, filters) => Promise<ReportResult>`). Código compilado y confiable. `source: 'core'`.
- **Reportes de plugin:** se declaran como **metadata en el `manifest`** (`reports: [...]` + `routePath`) y los datos se sirven a través del **mecanismo de ROUTE sandboxed ya existente** (`pluginRuntime.runRoute`). `source: 'plugin'`. El host:
  - Aplica RBAC (`requireReportAccess`) con el `minRole` declarado.
  - Genera el CSV/XLSX él mismo a partir de las filas que devuelve el plugin (el plugin **solo** aporta datos, nunca genera el fichero).
  - Si el plugin se desactiva → el reporte desaparece (registry lo des-registra).
- **Razón:** nunca se inyecta una closure de plugin en el host → el boundary de seguridad del sandbox `vm` queda intacto (CLAUDE.md A02/A08, plugin sandbox = control de seguridad).

## 4. Estructura de archivos

### Backend — `backend/src/modules/reports/`
```
index.ts        # export createReportsRouter(prisma) + initializeReportRegistry()
types.ts        # ReportDefinition, ReportMeta, ReportFilters, ReportResult, ReportColumn, ReportFilterDefinition
registry.ts     # Map core; registerReport / registerPluginReport / unregisterPluginReports / getAvailableReports(role) / getReport(id)
schemas.ts      # Zod: ReportQuerySchema (from,to,page,limit,sort,dir,search + dynamic), ExportQuerySchema
middleware.ts   # requireReportAccess(reportId) → 404/403, adjunta req.report
audit.ts        # logReportView / logReportExport (entity='report', insert-only)
export.ts       # toCSV(columns, rows) · toXLSX(columns, rows) (ExcelJS, ya es dep)
reports/        # un archivo por reporte core (registerReport en cada uno)
  inventory.ts obsolescence.ts security.ts contracts.ts licenses.ts
  compliance.ts lifecycle.ts auditTrail.ts impactMap.ts decommission.ts
__tests__/      # router.test.ts registry.test.ts queries.test.ts
```

### Frontend — `frontend/app/reports/`
```
page.tsx                 # listado (grid de tarjetas) — REEMPLAZA el actual
[id]/page.tsx            # viewer de un reporte
components/ ReportList ReportCard ReportViewer ReportFilters ReportTable ReportExport
hooks/      useReports useReportData useReportExport
types/report.ts
```

## 5. Interfaces TypeScript (contrato — `types.ts`)

```typescript
type UserRole = 'ADMIN'|'AUDITOR'|'VIEWER';
type ReportCategory = 'inventory'|'security'|'financial'|'compliance'|'lifecycle'|'audit';
type ExportFormat = 'csv'|'xlsx';

interface ReportColumn { key: string; labelKey: string; type?: 'string'|'number'|'date'|'badge'; sortable?: boolean; }
interface ReportFilterDefinition { key: string; type: 'date-range'|'select'|'multi-select'|'search'|'toggle'; labelKey: string; options?: { value: string; labelKey: string }[]; }
interface ReportFilters { from?: string; to?: string; page: number; limit: number; sort?: string; dir?: 'asc'|'desc'; search?: string; [k: string]: unknown; }
interface ReportKpi { labelKey: string; value: number|string; tone?: 'green'|'amber'|'red'|'neutral'; }
interface ReportResult { data: Record<string, unknown>[]; total: number; kpis?: ReportKpi[]; }
type ReportQueryFn = (prisma: PrismaClient, filters: ReportFilters) => Promise<ReportResult>;

interface ReportDefinition {
  id: string; nameKey: string; descriptionKey: string;
  category: ReportCategory; minRole: UserRole; icon: string; tags: string[];
  columns: ReportColumn[]; filters: ReportFilterDefinition[]; exportFormats: ExportFormat[];
  source: 'core'|'plugin'; pluginId?: string;
  query?: ReportQueryFn;     // core
  routePath?: string;        // plugin (sandboxed route)
}
// Enviado al frontend (sin query/routePath):
interface ReportMeta { id; nameKey; descriptionKey; category; minRole; icon; tags; exportFormats; columns; source; available: boolean; }
```

## 6. Endpoints REST

| Método | Ruta | Guard | Respuesta |
|---|---|---|---|
| GET | `/api/reports` | authenticateToken | `{ reports: ReportMeta[] }` — TODOS, con `available` por rol (tarjetas atenuadas en UI) |
| GET | `/api/reports/:id/filters` | requireReportAccess | `{ filters: ReportFilterDefinition[], columns: ReportColumn[] }` |
| GET | `/api/reports/:id/data` | requireReportAccess | `{ data, total, page, limit, kpis }` |
| GET | `/api/reports/:id/export?format=csv\|xlsx` | requireReportAccess | descarga de fichero; audit `EXPORT_REPORT` |

Mount en `index.ts`: `initializeReportRegistry(); app.use('/api/reports', authenticateToken, createReportsRouter(prisma));`

## 7. Reportes estándar (10)

| id | nombre | cat | minRole | fuente datos |
|---|---|---|---|---|
| `inventory` | Inventario de Activos | inventory | VIEWER | CI agrupado por tipo/ubicación/estado/criticidad; KPIs total/activos/inactivos/retirados |
| `obsolescence` | Obsolescencia EOL/EOS | lifecycle | VIEWER | CI + `ci_dates`/`base_software_dates`; semáforo + días restantes |
| `security` | Seguridad Ejecutivo | security | VIEWER | `CI.vulnerabilities` JSONB por severidad + cobertura CrowdStrike |
| `contracts` | Contratos y Adendas | financial | ADMIN | Contract `endDate`, días restantes, estado, proveedor, adendas |
| `licenses` | Licencias | financial | ADMIN | License + LicenseUser: uso, asignaciones, costes, vencimientos |
| `compliance` | Compliance GDPR/ISO | compliance | AUDITOR | CIs con PII/clasificación, gaps de política |
| `lifecycle` | Lifecycle de Activos | lifecycle | VIEWER | `ci_dates`: adquisición→operación→mantenimiento→retirada |
| `audit-trail` | Audit Trail | audit | AUDITOR | `audit_logs` filtrado por entidad/usuario/acción/fecha |
| `impact-map` | Mapa de Impacto | inventory | VIEWER | `CIRelation` aplanado (origen, tipo, destino). Grafo visual → diferido v3.4.1 |
| `decommission` | Decommission | lifecycle | ADMIN | DecommissionPlan: progreso, sistemas afectados, timeline |

## 8. Seguridad (criterios de aceptación por módulo)

- **A01:** `requireReportAccess` en `/data`, `/export`, `/filters`. Filtros a nivel BD.
- **A03:** todo vía Prisma; `search` con LIKE escapa `%`,`_`,`\` + `ESCAPE '\\'`; nunca `$queryRawUnsafe`.
- **A09:** audit `VIEW_REPORT` / `EXPORT_REPORT` (sin PII en details; ids + resumen de filtros).
- **DoS:** `limit` máx 500; export con tope de filas (50k) y streaming. `Number()` sobre COUNT bigint.
- **Plugin:** datos vía sandbox route existente; fichero lo genera el host.

## 9. Frontend — estética

Patrón canónico de la casa (`min-h-screen bg-slate-50`, header sticky, `rounded-none`, paneles `ring-1 ring-slate-200`). Badges categoría: inventory=azul, security=rojo, financial=verde, compliance=púrpura, lifecycle=naranja, audit=gris. Badge rol: VIEWER=verde, AUDITOR=azul, ADMIN=rojo. Tarjetas no disponibles: opacidad 50% + "Requiere [ROL]".

## 10. i18n

Claves `reports.*` en `frontend/locales/{es,en,de,pt,fr,it}.json` (las 6). Lista base en el prompt + `nameKey`/`descriptionKey` de cada reporte (`reports.def.<id>.name` / `.desc`) + columnas (`reports.col.<key>`) + filtros (`reports.filter.<key>`).

## 11. Secuencia de ejecución (Sonnet)

- **T2 Backend:** types → registry → schemas → middleware → audit → export → 10 reportes core → router → mount index.ts → tests. Verificar `tsc --noEmit`.
- **T3 Frontend:** types → hooks → componentes → listado → viewer → i18n ×6.
- **T4 Migración:** los 3 reportes (obsolescence/contracts/security) ya son core; reemplazar la página vieja; conservar lógica print como referencia en git history.
- **T5 Plugins:** extender manifest schema (`reports[]` + permiso `reports:register`); hook activate/deactivate → registry; proxy `/data` a route sandboxed; doc.
- **T6 Tests:** RBAC (VIEWER no ve ADMIN), registry, queries, render frontend.
- **T7 Docs:** README, ARCHITECTURE(.en), USER_MANUAL(.en), SYSADMIN_MANUAL(.en), CLAUDE.md, REPORTS.md (nuevo), PLUGIN_ENGINE.md.
- **T8 Deploy local develop:** `podman-compose -f docker-compose.prod.yml`… verificar; **NO main**.

## 12. Estado de tareas

| Tarea | Estado |
|---|---|
| T1 Diseño (Opus) | ✅ Completada |
| T2 Backend module | ⏳ Pendiente |
| T3 Frontend | ⏳ Pendiente |
| T4 Migrar 3 reportes | ⏳ Pendiente |
| T5 Extensibilidad plugins | ⏳ Pendiente |
| T6 Tests | ⏳ Pendiente |
| T7 Documentación | ⏳ Pendiente |
| T8 Deploy + verificación local | ⏳ Pendiente |
