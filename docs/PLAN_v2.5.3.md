# Plan de desarrollo v2.5.3

> Estado: ✅ COMPLETADA — release v2.5.3 publicado en origin (main 95bd112, tag v2.5.3)
> Rama base: `develop` (HEAD post-v2.5.2)
> Target: `main` tag `v2.5.3`
> Última actualización: 2026-06-04
> Tipo: bugfixes (4) + OWASP/Compliance review + release

> ⚠️ Nota: el usuario escribió "v2.5.2" pero esa versión ya está liberada. Se asume **v2.5.3** como siguiente versión.

---

## Checklist de entregas

| ID | Tarea | Rama | Estado |
|----|-------|------|--------|
| **P** | Fix bulk-update CI 500 al cambiar `ciTypeId` | `task-v/fix-bulk-update-ci-type` | ✅ Mergeada (51d84ea) |
| **Q** | CIDetailModal: botón inferior "Editar CI" → "Guardar cambios" + edición inline | `task-w/ci-detail-inline-save` | ✅ Mergeada |
| **R** | Bulk import XLSX: skip análisis IA + detección dup ampliada (name/serial/IP) + flag WARNING | `task-x/bulk-import-skip-ai` | ✅ Mergeada (32da8d2) |
| **S** | Datos Maestros > Modelos: exponer campos `eolDate` / `eosDate` en UI | `task-y/masters-models-eol-eos` | ✅ Mergeada (4489a83) |
| **T** | OWASP `differential-review` + Compliance review (ISO/GDPR/NIS2) | `task-z/owasp-v2.5.3-fixes` | ✅ Completada — F-01 fix incluido; F-02/F-03 → backlog v2.6.x |
| **U** | Release v2.5.3 (merge a main + tag + push) | — | ✅ Completada (merge 95bd112, tag v2.5.3 en origin) |

**Orden estricto:** P → STOP → Q → STOP → R → STOP → S → STOP → T → STOP → U

---

## Tarea P — Fix bulk-update CI 500 al cambiar `ciTypeId`

**Síntoma:** Al seleccionar varios CIs en el inventario, marcar un nuevo CIType y pulsar "Aplicar a la selección" → 500 Internal Server Error.

**Hipótesis (a verificar):**
- El endpoint `PATCH /api/cis/bulk-update` (línea 1527) acepta `ciTypeId` en el schema Zod sin validar que el tipo nuevo sea compatible con los `HardwareCI`/`SoftwareCI` ya existentes.
- Probable: cambio de CIType de categoría HARDWARE→SOFTWARE deja un CI con un `HardwareCI` huérfano (FK válida pero modelo inconsistente).
- Otra hipótesis: el `ciTypeId` enviado no es un UUID válido en la BD → Prisma lanza FK violation y se traga el mensaje en el `catch` genérico.

### Subtareas

- [ ] P1: Reproducir el bug en el entorno de prod local (login claude@cmdb.local, varios CIs seleccionados, change CIType, capturar el error real del log del backend).
- [ ] P2: Identificar la causa raíz: revisar el `console.error` en `backend/src/index.ts:1597` y reproducir con `docker logs cmdb-backend-prod`.
- [ ] P3: Implementar fix según causa:
  - Si es FK violation por CIType inexistente → devolver 400 con mensaje claro
  - Si es incompatibilidad de categoría (HW↔SW) → opciones: (a) rechazar con 400, (b) permitir y dejar el child huérfano, (c) borrar el child al cambiar categoría
  - **Recomendación:** opción (a) — rechazar con 400 + mensaje "El nuevo tipo no es compatible con CIs de categoría HW/SW; modifíquelos individualmente"
- [ ] P4: Añadir test e2e con `claude@cmdb.local` (curl): caso success + caso 400 controlado
- [ ] P5: Commit + merge a develop

Skill aplicable: `supabase-postgres-best-practices` (validar FKs), `find-bugs`

---

## Tarea Q — CIDetailModal: edición inline + "Guardar cambios"

**Comportamiento actual:**
- En el modal de detalle del CI hay **dos botones**:
  - Header (línea 222): "Editar" pequeño → llama `onEdit()` → abre `EditCIModal` (modal separado)
  - Footer (línea 476): "Editar CI" grande → mismo `onEdit()` → mismo modal separado
- Ambos hacen lo mismo: cierran el detalle y abren el editor completo.

**Comportamiento deseado:**
- El **botón inferior** debe pasar a "Guardar cambios" y permitir editar campos inline en el propio modal de detalle.
- El header "Editar" (botón pequeño) mantiene el comportamiento actual (abrir editor completo) para edición avanzada.
- Tras pulsar "Guardar cambios", se hace PATCH `/api/cis/:id` con los cambios y se cierra el popup.

### Subtareas

- [ ] Q1: Decidir qué campos pasan a ser editables inline (probablemente: status, criticality, environment, location, businessOwner, technicalLead, notes — los simples; nada de hardware/software children por complejidad).
- [ ] Q2: Refactor `frontend/components/CIDetailModal.tsx`:
  - Estado local `editedFields: Record<string, unknown>` que clona el CI inicial
  - Reemplazar el render del valor por `<input>`/`<select>` para los campos editables
  - Botón footer cambia de etiqueta "btn_edit_ci" → "btn_save_changes" (nueva i18n key)
- [ ] Q3: Handler `handleSave()`: PATCH `/api/cis/:id` con el diff (only changed fields) + cerrar modal + refrescar lista
- [ ] Q4: i18n: nueva clave `ci_detail.btn_save_changes` + `ci_detail.save_error` en los 6 idiomas
- [ ] Q5: Smoke test: editar status + criticality desde el detail, guardar, verificar audit log
- [ ] Q6: Commit + merge a develop

Skill aplicable: `vercel-react-best-practices`, `frontend-design`

---

## Tarea R — Bulk import XLSX: skip IA + detección dup ampliada

**Comportamiento actual:**
- Cada item del lote XLSX se procesa con LLM (Ollama) — incluso cuando el XLSX ya trae nombre, serial, IP, etc. claramente extraídos.
- Eso es lento (segundos por item × cientos de items) y no aporta valor para XLSX bien estructurados.
- La función `processCIBulkImportQueue` (línea 4443) sí hace conflict detection por `name` y `serialNumber`/`inventoryNumber`, pero **no por IP**.

**Comportamiento deseado:**
- XLSX bypass: si la fila ya trae nombre + (serial o IP) válidos, saltar el LLM y marcar como ANALYZED directamente.
- Detección de duplicados ampliada: añadir comprobación por IP (en `HardwareCI.ipAddress`) y devolver warning si hay match.
- Status nuevo o etiqueta `possibleDuplicate: true` en el item para que la UI lo muestre como atención.

### Subtareas

- [ ] R1: Añadir flag a la lógica de análisis: si `raw.name` + (`raw.serialNumber` || `raw.ipAddress` || `raw.inventoryNumber`) están bien formados, saltar Ollama y construir el resultado de análisis directamente desde las columnas del XLSX.
- [ ] R2: Extender la detección de duplicados en `processCIBulkImportQueue` (línea ~4490) para añadir comprobación por IP (LEFT JOIN con `hardware_cis.ip_address`).
- [ ] R3: Si `conflicts.length > 0`, marcar el item con `possibleDuplicate: true` en el analysis JSON (sin bloquear el commit posterior, sólo aviso).
- [ ] R4: Frontend `documents/bulk/[batchId]/page.tsx` (o equivalente CI bulk review page): renderizar badge "⚠ Posible duplicado" si el flag está presente.
- [ ] R5: i18n: clave `bulk.possible_duplicate` en los 6 idiomas
- [ ] R6: Smoke test: subir XLSX con 5 filas, una con nombre ya existente → ver que se procesa rápido (sin LLM) y muestra el warning.
- [ ] R7: Commit + merge a develop

Skill aplicable: `supabase-postgres-best-practices`, `vercel-react-best-practices`

---

## Tarea S — Datos Maestros > Modelos: exponer EOL/EOS

**Estado actual:**
- BD: `DeviceModel.eolDate` y `eosDate` ya existen en el schema (líneas 280-281 de `schema.prisma`). Confirmado.
- UI: la página Datos Maestros > Modelos no muestra estos campos al editar un modelo.
- Hay un job EOL/EOS que llama a endoflife.date — debe poder guardar las fechas resultantes en estos campos (revisar a posteriori).

**Comportamiento deseado:**
- En la pantalla de admin de Modelos: añadir dos columnas/inputs `eol_date` y `eos_date` (date picker).
- En el endpoint backend `PATCH /api/masters/device-models/:id`: aceptar y persistir estos campos.
- Audit log `UPDATE_MASTER` con los cambios.

### Subtareas

- [ ] S1: Localizar endpoint actual `GET/POST/PATCH/DELETE /api/masters/device-models` (o equivalente)
- [ ] S2: Backend: añadir `eolDate` y `eosDate` (date / `YYYY-MM-DD`) al body schema Zod y a la mutación Prisma
- [ ] S3: Frontend admin masters: añadir inputs `<input type="date">` en la row/edit-mode de cada modelo
- [ ] S4: i18n: claves `masters.models.eol_date` y `masters.models.eos_date` en los 6 idiomas
- [ ] S5: Smoke test: editar un modelo, fijar EOL, refrescar, verificar persistencia + audit log
- [ ] S6: Commit + merge a develop

Skill aplicable: `vercel-react-best-practices`, `documentation-writer`

---

## Tarea T — OWASP + Compliance review

Subagente con skill `differential-review` sobre `git diff main...develop` (release v2.5.3).

**Foco:**
- A01: nuevo endpoint PATCH `/api/cis/:id` desde detail modal → `requireAdmin`
- A03: nuevas queries Prisma en R (IP conflict check) → tagged template literals
- A04: nuevos campos editables inline (Q) → validar Zod
- A09: nuevos audit logs en S (UPDATE_MASTER device_models)

Output:
- `docs/security-audit/owasp-v2.5.3.md`
- `docs/security/COMPLIANCE_v2.5.3.md`

Política:
- Critical/High → fix antes del release (`task-z/owasp-v2.5.3-fixes`)
- Medium → fix en v2.5.3 si rápido
- Low → backlog v2.6.x en este fichero

---

## Tarea U — Release v2.5.3

- [ ] Actualizar `CLAUDE.md` (current → v2.5.3)
- [ ] Commit `chore(release): prepare v2.5.3`
- [ ] `git checkout main && git merge --no-ff develop`
- [ ] `git tag v2.5.3`
- [ ] `git push origin main develop v2.5.3`
- [ ] Crear GitHub Release manualmente
- [ ] Memoria del proyecto actualizada

---

## Backlog v2.6.x (heredado)

Ver `docs/PLAN_v2.5.2.md` § Tarea N (7 Lows pendientes).

### Nuevos Lows de v2.5.3 (Tarea T — OWASP/Compliance review)

- **F-02 (A04 — Insecure Design):** aplicar `requireUuidParam` también a `/api/contracts/:id`, `/api/documents/:id`, `/api/licenses/:id` para uniformidad defensiva. No hay vector activo (no hay rutas literales declaradas después), pero cierra cualquier regresión futura por route-ordering.
- **F-03 (A04 — Insecure Design):** `/api/users` devuelve la lista completa para selectores de owner/lead. Paginar / limitar a 100 por defecto cuando el CMDB crezca.

---

## Notas de ejecución

- Modelo planificación: **Opus** (ahora). Modelo ejecución: **Sonnet** (cambiar antes de empezar).
- Cada subtarea = commit corto y sintético
- Cada tarea = merge `--no-ff` a develop + STOP para revisión
- OWASP y Compliance al final
- Findings Low → este fichero
