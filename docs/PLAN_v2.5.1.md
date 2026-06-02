# Plan de desarrollo v2.5.1

> Estado: 🟡 En progreso  
> Rama base: `develop`  
> Target: `main` tag `v2.5.1`  
> Última actualización: 2026-06-02  
> OWASP: análisis único al finalizar todas las tareas (no por tarea)

---

## Checklist de entregas

| ID | Tarea | Rama | Estado |
|----|-------|------|--------|
| **A** | Fix i18n: clave `actions.back` faltante en 6 locales | `task-i/i18n-actions-back` | ✅ Mergeada (32d4593) |
| **E** | 🐛 BUG CRÍTICO: CI Bulk commit falla con "Internal server error" | `task-m/ci-bulk-commit-bug` | ✅ Mergeada (413ee63) — backend desplegado |
| **B** | CI Bulk: 3 análisis concurrentes (`CI_BULK_CONCURRENCY`) | `task-j/ci-bulk-parallel` | ✅ Mergeada (00dc48d) — backend desplegado |
| **C** | Contratos: endpoint DELETE + desasociar documentos | `task-k/contracts-delete-unlink` | ✅ Mergeada (1208147) — backend+frontend desplegados |
| **D** | Bulk docs: estado `WARNING` para "sin texto extraído" | `task-l/bulk-warning-status` | ✅ Mergeada (5c5924e) — desplegado |
| **F** | Actualización masiva de campos en CIs | `task-n/ci-bulk-update` | ✅ Mergeada (262f56e) — desplegado |
| **G** | Borrado masivo de CIs seleccionados | `task-o/ci-bulk-delete` | ✅ Mergeada (b52edb1) — desplegado |
| **OWASP** | Análisis OWASP único de todas las tareas | (sobre `develop`) | ✅ Realizado — 2H+4M corregidos en task-p (08bf40a) |
| **R** | Release v2.5.1 | — | ⏳ Pendiente |

**Orden de ejecución:** A → **E** (bug bloqueante) → B → C → D → F → OWASP global → Release.

---

## Tarea A — Fix i18n `actions.back` ✅

Ver detalles en commits `82f31e4`. Falta merge a develop tras OK del usuario.

---

## 🐛 Tarea E — Bug crítico: CI Bulk commit falla

**Síntoma reportado:** Tras análisis IA, al pulsar "Crear todos" o "Crear CI" individual en un registro READY → `500 Internal server error`.

**Causa raíz identificada:**

Error de Prisma en `materializeCIBulkItem` (línea 4501 en `backend/src/index.ts`):
```
PrismaClientValidationError: Invalid `prisma.cI.create()` invocation
hardware: { create: { ..., ipAddress: null } }
                            ~~~~~~~~~
Unknown argument `ipAddress`. Available options are marked with ?.
```

**Modelo Prisma (schema.prisma:387-396):** `HardwareCI` solo tiene `ciId`, `serialNumber`, `model`, `manufacturer`. **No tiene `ipAddress`.**

La IP de hardware en el schema vive en `CI.consoleIp` (línea 303).

### Fix

| # | Acción | Fichero |
|---|--------|---------|
| E1 | En `materializeCIBulkItem` mover `decision.ipAddress` a `CI.consoleIp`. Eliminar `ipAddress` del bloque `hardware.create` | `backend/src/index.ts:4501` |
| E2 | Verificar que `processCIBulkImportQueue` no produzca items con `ipAddress` inválidos (mantener Zod schema permisivo, el campo es opcional y solo se mueve de lugar) | (sin cambios en Zod) |
| E3 | Smoke test: crear batch CI con fila que tenga `ipAddress` → "Crear todos" → CI creado, `consoleIp` populado | manual |
| E4 | TypeScript check + commit + merge a develop | — |

### Compliance
- ISO 27001 A.8.15: el endpoint ya emite `CI_BULK_COMMIT` audit log. Cambio sin impacto.
- GDPR art.5: ningún dato personal nuevo se introduce.

---

## Tarea B — CI Bulk: análisis concurrente

**Mejora:** `processCIBulkImportQueue` procesa 1 item/tick. Cambiar a concurrencia 3 con inicio inmediato del siguiente cuando uno termina.

- Env var `CI_BULK_CONCURRENCY` (default 3, rango 1..5)
- Helper `withConcurrency` interno (sin deps externas)
- Guard: `inFlight >= CI_BULK_CONCURRENCY` en vez de `inFlight > 0`
- `LIMIT` = `3 × CI_BULK_CONCURRENCY` (=9 por defecto)

### Subtareas
- [ ] B1: Helper `withConcurrency` + validar env var
- [ ] B2: Modificar worker con nuevo guard + LIMIT parametrizado
- [ ] B3: Actualizar `.env.example` y `SYSADMIN_MANUAL`
- [ ] B4: Commit + merge a develop

---

## Tarea C — Contratos: borrar + desasociar documentos

- `DELETE /api/contracts/:id` — hard delete, bloquea si tiene adendas activas (409)
- `DELETE /api/contracts/:id/documents/:docId` — desasociar documento de contrato
- UI: botón "Eliminar" con confirmación (solo ADMIN) + botón ✕ por documento
- 7 claves i18n × 6 locales

### Subtareas
- [ ] C1: Backend endpoint DELETE /api/contracts/:id
- [ ] C2: Backend endpoint DELETE /api/contracts/:id/documents/:docId
- [ ] C3: Frontend botón eliminar + desasociar
- [ ] C4: i18n 7 claves en 6 locales
- [ ] C5: Commit + merge a develop

---

## Tarea D — Bulk docs: estado WARNING

**Mejora:** Cuando no se puede extraer texto de un documento, usar `status='WARNING'` (en vez de `ANALYZED`) para distinguirlo visualmente.

- Nuevo estado batch: `READY_WITH_WARNINGS`
- Sumatorio: Creados + Pendientes + Errores + Advertencias
- Solo afecta a nuevos análisis (no retroactivo)

### Subtareas
- [ ] D1: Backend — WARNING en worker + recomputeBatchStatus + filtros endpoints
- [ ] D2: Frontend — badge amarillo + sumatorio
- [ ] D3: i18n 4 claves en 6 locales
- [ ] D4: Commit + merge a develop

---

## Tarea F — Update masivo de campos en CIs

**Funcionalidad nueva:** Seleccionar varios CIs y aplicar la misma actualización a todos en bloque (criticidad, entorno, tipo, ubicación, business impact, etc.).

### Diseño

**Campos actualizables masivamente** (los que tienen sentido aplicar igual a varios CIs):
- `criticality` (enum)
- `environment` (enum)
- `status` (enum)
- `ciTypeId` (FK)
- `locationId`, `costCenterId`, `branchId` (FK opcionales)
- `businessOwnerId`, `technicalLeadId` (FK opcionales)
- `businessImpact`, `dataClassification` (enums opcionales)
- `containsPii`, `spofRisk` (boolean)

**NO se pueden actualizar masivamente** (deben ser únicos por CI): `name`, `apiSlug`, `inventoryNumber`, `serialNumber`, `assignedUser`, `consoleIp`, etc.

### Subtareas

| # | Acción | Detalle |
|---|--------|---------|
| F1 | Backend: `PATCH /api/cis/bulk-update` con body `{ ciIds: string[], updates: {...} }` | requireAdmin, Zod validation, transacción atómica, AuditLog `CI_BULK_UPDATE` con detalles (ids + campos cambiados) |
| F2 | Frontend: añadir checkboxes en tabla de inventario (columna izquierda + "seleccionar todos") | Estado local `selectedIds: Set<string>` |
| F3 | Frontend: modal "Editar seleccionados" con formulario de los campos masivos (campos opcionales, solo los que el admin rellena se actualizan) | `BulkUpdateModal` |
| F4 | Frontend: botón "Editar N seleccionados" que abre modal, refresh tras éxito | UI clara |
| F5 | i18n: 6 claves nuevas (`bulk_update_button`, `bulk_update_title`, `bulk_update_confirm`, etc.) × 6 locales | — |
| F6 | Reindexar RAG de los CIs afectados tras el update | `queueEntityForIndexing('ci', id)` por cada uno |
| F7 | Commit + merge a develop | — |

### Compliance
- A01 (Access Control): `requireAdmin` obligatorio
- A03 (Injection): Zod valida tipos enum + UUIDs, Prisma parametrizado
- A09 (Logging): AuditLog `CI_BULK_UPDATE` con `{ ciIds, changes }` (sin PII)
- GDPR art.5: minimización — solo se actualizan campos que el admin selecciona explícitamente

---

## OWASP review global (al finalizar)

Tras todas las tareas mergeadas a develop, un único pase OWASP con foco en:
- A01 (access control) — endpoints DELETE (C1) y PATCH bulk (F1)
- A03 (injection) — todos los nuevos endpoints
- A04 (insecure design) — concurrencia CI bulk (B), hard delete contratos (C)
- A05 (misconfig) — env vars nuevas
- A08 (integrity) — WARNING status (D), bulk update transacción (F)
- A09 (logging) — todos los nuevos endpoints deben emitir AuditLog

Findings:
- Critical/High → fix antes del release
- Medium → fix antes del release
- Low → backlog v2.6.x

Documentar en `docs/security-audit/owasp-v2.5.1.md`.

---

## Backlog OWASP (findings Low de esta release)

| ID | Tarea | Finding | Prioridad |
|----|-------|---------|-----------|
| — | — | — | — |

---

## Release v2.5.1

- [ ] 6 tareas (A, E, B, C, D, F) mergeadas a develop
- [ ] OWASP global ejecutado, findings Critical/High/Medium → 0
- [ ] `CLAUDE.md` → v2.5.1
- [ ] `docs/USER_MANUAL.md` + `.en.md` actualizados (C, D, F)
- [ ] `docs/SYSADMIN_MANUAL.md` + `.en.md` actualizados (B)
- [ ] `git tag v2.5.1`
- [ ] Merge develop → main + push
