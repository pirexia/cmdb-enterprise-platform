# Plan de desarrollo v2.5.2

> Estado: 🟡 En progreso
> Rama base: `develop` (HEAD post-v2.5.1)
> Target: `main` tag `v2.5.2`
> Última actualización: 2026-06-02
> Tipo: bugfixes (3 críticos/altos) + 1 feature pequeña + OWASP/Compliance review

---

## Checklist de entregas

| ID | Tarea | Rama | Estado |
|----|-------|------|--------|
| **H** | 🔴 Fix DELETE CI cascade — `hardware_cis`/`software_cis` FK CASCADE | `task-q/fix-delete-ci-cascade` | ⬅ SIGUIENTE |
| **K** | Bulk import CI: upsert `manufacturer` + `device_model` | `task-r/bulk-import-master-upsert` | ⏳ Pendiente |
| **I** | Dashboard cards con filtros URL (`?type=`/`?filter=`) | `task-s/dashboard-filters-url` | ⏳ Pendiente |
| **J** | Master data `contract_lifecycle_statuses` + integración | `task-t/contract-lifecycle-status` | ⏳ Pendiente |
| **L** | OWASP `differential-review` global | (sobre `develop`) | ⏳ Pendiente |
| **M** | Compliance ISO 27001 / GDPR / NIS2 | (sobre `develop`) | ⏳ Pendiente |
| **N** | Backlog v2.6.x documentado en este fichero | docs | ⏳ Pendiente |
| **O** | Release v2.5.2 (merge a main + tag) | — | ⏳ Pendiente |

**Orden estricto:** H → STOP → K → STOP → I → STOP → J → STOP → L → STOP → M → STOP → N → STOP → O

---

## 🔴 Tarea H — Fix DELETE CI cascade (BLOQUEANTE)

**Causa raíz confirmada:**
- `backend/prisma/migrations/20260312235540_init/migration.sql` creó las FKs de `hardware_cis.ci_id` y `software_cis.ci_id` con `ON DELETE RESTRICT`
- `backend/prisma/schema.prisma:393/403` declaran `onDelete: Cascade`
- Postgres rechaza cualquier DELETE de un CI con hardware/software asociado

**Verificación SQL contra prod:**
```
hardware_cis | ci_id | RESTRICT  ← MAL
software_cis | ci_id | RESTRICT  ← MAL
```

### Subtareas
- [ ] H1: Nueva migración SQL en `backend/prisma/migrations/<ts>_hardware_software_cascade_on_delete/migration.sql` con `ALTER TABLE ... DROP/ADD CONSTRAINT ... ON DELETE CASCADE`
- [ ] H2: Aplicar migración (`prisma migrate deploy`) en container
- [ ] H3: Smoke test single delete: crear CI hardware → borrar → OK
- [ ] H4: Smoke test bulk delete con CIs hw/sw
- [ ] H5: Commit + merge a develop

Skill aplicable: `supabase-postgres-best-practices`

---

## Tarea K — Bulk import: upsert manufacturer + model

**Causa raíz confirmada:** `materializeCIBulkItem` (líneas 4824-4830) crea `HardwareCI` con strings literales `manufacturer`/`model` sin tocar las tablas maestras. Por eso "Modelos" en Datos Maestros está vacío después de importar.

### Subtareas
- [ ] K1: En `materializeCIBulkItem`, antes del `tx.cI.create()`:
  - Si `decision.manufacturer`: upsert en `manufacturers` (`ON CONFLICT (name) DO UPDATE`) → `manufacturerId`
  - Si `decision.model` y manufacturerId: upsert en `device_models` (key `(name, manufacturer_id)`) → `ciModelId`
  - Asignar `ciModelId` al payload del CI
- [ ] K2: Verificar unique compuesto en `device_models`; si no existe usar SELECT/INSERT WHERE NOT EXISTS
- [ ] K3: Audit log `CREATE_MASTER` para masters auto-creados (dentro del mismo `tx`)
- [ ] K4: Smoke test con XLSX (manufacturer existente + model nuevo, manufacturer nuevo + model nuevo)
- [ ] K5: Commit + merge a develop

Skill aplicable: `supabase-postgres-best-practices`

---

## Tarea I — Dashboard cards con filtros URL

### Subtareas
- [ ] I1: `frontend/app/inventory/page.tsx` — leer `searchParams.get("type")`, mapear a filtro `hardware`/`software` (usar `ci.hardware !== null`/`ci.software !== null`)
- [ ] I2: `frontend/app/contracts/page.tsx` — leer `searchParams.get("filter")`, mapear:
  - `adenda` → `filters.type = "adenda"`
  - `active` → `filters.status = "activo"`
  - `expiring` → `filters.status = "vence_pronto"`
  - `expired` → `filters.status = "vencido"`
- [ ] I3: `frontend/app/page.tsx` — añadir query params a los Links:
  - Hardware → `/inventory?type=hardware`
  - Software → `/inventory?type=software`
  - Adendas → `/contracts?filter=adenda`
  - Activos → `/contracts?filter=active`
  - Vencidos/expiring → `/contracts?filter=expired` o `?filter=expiring`
- [ ] I4: Smoke test de 6 navegaciones
- [ ] I5: Commit + merge a develop

Skill aplicable: `vercel-react-best-practices`

---

## Tarea J — Master data contract lifecycle statuses

**Decisión clave:** convive con el cálculo por fechas. Dos badges en la lista de contratos:
- `lifecycle_status_id` (master editable): ACTIVE / CANCELLED
- date-based status (calculado): en vigor / vence pronto / vencido

### Subtareas

#### J1 — Migración SQL
- [ ] Crear `backend/prisma/migrations/<ts>_contract_lifecycle_statuses/migration.sql`:
  - Tabla `contract_lifecycle_statuses` (id, code unique, name, sort_order, is_system, timestamps)
  - Columna `contracts.lifecycle_status_id` UUID NULL + FK ON DELETE SET NULL
  - Index `(lifecycle_status_id)`
  - Seed: `ACTIVE` / `CANCELLED` con `is_system=true`
  - Backfill: `UPDATE contracts SET lifecycle_status_id = (SELECT id FROM contract_lifecycle_statuses WHERE code='ACTIVE')`

#### J2 — Schema Prisma
- [ ] Añadir modelo `ContractLifecycleStatus`
- [ ] Añadir `lifecycleStatusId` y `lifecycleStatus` a `Contract`
- [ ] `prisma generate`

#### J3 — Backend CRUD masters
- [ ] `GET/POST/PATCH/DELETE /api/masters/contract-statuses` (patrón `support-areas`)
- [ ] Validar: `is_system` no se puede eliminar (409), `code` no editable, audit logs

#### J4 — Backend contracts
- [ ] POST/PATCH `/api/contracts` aceptan `lifecycleStatusId`; default = ACTIVE si no se envía
- [ ] `CONTRACT_INCLUDE` añade `lifecycleStatus: { select: { id, code, name } }`

#### J5 — Frontend admin masters UI
- [ ] Nueva tab "Estados de contrato" en `frontend/app/admin/masters/page.tsx`
- [ ] CRUD con disabled para `is_system=true` en delete + code edit

#### J6 — Frontend contracts UI
- [ ] Selector en `AddContractModal`
- [ ] Selector en panel edit de `ContractRow`
- [ ] Badge dual en la lista (lifecycle + date-based)

#### J7 — i18n (6 locales)
- [ ] Claves nuevas para `masters.contract_statuses.*` y `contracts.lifecycle_status.*`

#### J8 — Commit + merge a develop

Skills: `supabase-postgres-best-practices`, `vercel-react-best-practices`

---

## Tarea L — OWASP differential review

Subagente con skill `differential-review` sobre `git diff main...develop` del release v2.5.2.

**Foco:**
- A03: nuevos `$queryRaw`/`$executeRaw` en K y J3
- A01: J3 valida `requireAdmin`
- A04: K3 audit dentro del mismo `tx`
- A05: J1 migración sin gaps RLS
- A08: H — CASCADE sin abrir puerta a borrado de masters
- A09: J3 + K3 emiten audit logs
- A10: N/A

Output: `docs/security-audit/owasp-v2.5.2.md`

Política:
- Critical/High → fix antes del release (rama `task-u/owasp-v2.5.2-fixes`)
- Medium → fix en v2.5.2 si es rápido
- Low → backlog en este fichero

---

## Tarea M — Compliance review

Subagente con skill `documentation-writer`.

**Foco:**
- ISO 27001 A.8.15: nuevos endpoints emiten audit logs
- ISO 27001 A.8.32: documentar SQL rollback de H1 y J1
- GDPR Art.5: no PII en logs nuevos
- GDPR Art.30: documentar nuevo master en registro de procesamiento
- NIS2 Art.23: reconstrucción de batch desde audit_logs

Output: `docs/security/COMPLIANCE_v2.5.2.md`

---

## Tarea N — Backlog v2.6.x

### Findings Low heredados de v2.5.1
> Documentados en `docs/security-audit/owasp-v2.5.1.md`

| ID | Categoría | Esfuerzo | Descripción |
|----|-----------|----------|-------------|
| V2.5.1-A09-4 | Performance/Audit | S | GIN index sobre `audit_logs.details->'ciIds'` |
| V2.5.1-A05-1 | Config/Safety | XS | Startup warning si `CI_BULK_CONCURRENCY` fuera de rango |
| V2.5.1-A04-5 | Rate limiting | S | Rate limit dedicado (10/min) para bulk endpoints |
| V2.5.1-A04-6 | Defensive coding | XS | Assert sobre `withConcurrency` task array bound |
| V2.5.1-A04-7 | Concurrency | M | Pre-check adendas dentro de transaction con `FOR UPDATE` |

### Findings Low nuevos de v2.5.2
> Se irán añadiendo conforme L y M arrojen resultados

| ID | Categoría | Esfuerzo | Descripción |
|----|-----------|----------|-------------|
| — | — | — | _(pendiente OWASP/Compliance review)_ |

---

## Tarea O — Release v2.5.2

- [ ] Actualizar `CLAUDE.md` (current release → v2.5.2, previous → v2.5.1)
- [ ] Commit `chore(release): prepare v2.5.2 — update CLAUDE.md`
- [ ] `git checkout main && git merge --no-ff develop`
- [ ] `git tag v2.5.2`
- [ ] `git push origin main develop v2.5.2`
- [ ] Memoria del proyecto actualizada

---

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|--------|------------|
| H1: ALTER de FK lockea tablas | Tablas pequeñas (<10k filas); `pg_dump` previo sugerido al usuario |
| K1: deadlocks en upsert | Bulk import es secuencial por batch; cada item es TX corta |
| J1: prod sin downtime | Columna nullable + backfill en la misma migración |
| J7: olvidar locales | Checklist por idioma + smoke test cambio de idioma |
| L: bloquea release | Patrones replican código v2.5.1 ya auditado |

---

## Notas de ejecución

- Modelo planificación: Opus. Modelo ejecución: **Sonnet**
- Cada subtarea = commit corto y sintético
- Cada tarea completa = merge `--no-ff` a develop
- STOP tras cada tarea para revisión del usuario
- OWASP y Compliance al final del implementation work
- Findings Low → este fichero (NUNCA en memoria, para sobrevivir cierre de sesión)
