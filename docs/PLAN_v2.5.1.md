# Plan de desarrollo v2.5.1

> Estado: 🟡 En progreso  
> Rama base: `develop`  
> Target: `main` tag `v2.5.1`  
> Última actualización: 2026-06-02

---

## Checklist de entregas

| ID | Tarea | Rama | Estado | OWASP findings |
|----|-------|------|--------|----------------|
| **A** | Fix i18n: clave `actions.back` faltante en 6 locales | `task-i/i18n-actions-back` | ⬅ EN CURSO | — |
| **B** | CI Bulk: 3 análisis concurrentes (`CI_BULK_CONCURRENCY`) | `task-j/ci-bulk-parallel` | ⏳ Pendiente | — |
| **C** | Contratos: endpoint DELETE + desasociar documentos | `task-k/contracts-delete-unlink` | ⏳ Pendiente | — |
| **D** | Bulk docs: estado `WARNING` para "sin texto extraído" | `task-l/bulk-warning-status` | ⏳ Pendiente | — |
| **R** | Release v2.5.1 | — | ⏳ Pendiente | — |

---

## Tarea A — Fix i18n `actions.back`

**Problema:** `frontend/app/inventory/bulk/[batchId]/page.tsx:540` usa `t("actions.back")` pero la clave `back` no existe en el namespace `actions` de ningún locale. El resultado visible es el literal `actions.back` en la UI.

**Fix:** Añadir `"back"` al namespace `actions` en los 6 ficheros:
- `es: "Volver"` · `en: "Back"` · `de: "Zurück"` · `pt: "Voltar"` · `fr: "Retour"` · `it: "Indietro"`

### Subtareas
- [ ] A1: Añadir clave a los 6 locales
- [ ] A2: Validar JSON parseable
- [ ] A3: OWASP review
- [ ] A4: Commit + merge a develop

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
- [ ] B4: OWASP review
- [ ] B5: Commit + merge a develop

---

## Tarea C — Contratos: borrar + desasociar documentos

**Nuevas funcionalidades:**
- `DELETE /api/contracts/:id` — hard delete, bloquea si tiene adendas activas (409)
- `DELETE /api/contracts/:id/documents/:docId` — desasociar documento de contrato
- UI: botón "Eliminar" con confirmación (solo ADMIN) + botón ✕ por documento

### Subtareas
- [ ] C1: Backend endpoint DELETE /api/contracts/:id
- [ ] C2: Backend endpoint DELETE /api/contracts/:id/documents/:docId
- [ ] C3: Frontend botón eliminar + desasociar
- [ ] C4: i18n 7 claves en 6 locales
- [ ] C5: OWASP review
- [ ] C6: Commit + merge a develop

---

## Tarea D — Bulk docs: estado WARNING

**Mejora:** Cuando no se puede extraer texto de un documento, usar `status='WARNING'` (en vez de `ANALYZED`) para distinguirlo visualmente en la UI.

- Nuevo estado batch: `READY_WITH_WARNINGS`
- Sumatorio en "Mis importaciones": Creados + Pendientes + Errores + Advertencias
- Solo afecta a nuevos análisis (no retroactivo)

### Subtareas
- [ ] D1: Backend — WARNING en worker + recomputeBatchStatus + filtros endpoints
- [ ] D2: Frontend — badge amarillo + sumatorio
- [ ] D3: i18n 4 claves en 6 locales
- [ ] D4: OWASP review
- [ ] D5: Commit + merge a develop

---

## Backlog OWASP (findings Low de esta release)

> Se irá completando conforme se ejecutan las tareas

| ID | Tarea | Finding | Prioridad |
|----|-------|---------|-----------|
| — | — | — | — |

---

## Release v2.5.1

- [ ] 4 tareas mergeadas a develop
- [ ] 0 Critical/High/Medium pendientes
- [ ] `CLAUDE.md` → v2.5.1
- [ ] `docs/USER_MANUAL.md` + `.en.md` actualizados (C, D)
- [ ] `docs/SYSADMIN_MANUAL.md` + `.en.md` actualizados (B)
- [ ] `git tag v2.5.1`
- [ ] Merge develop → main + push
