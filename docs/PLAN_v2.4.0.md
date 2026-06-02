# Plan de desarrollo v2.4.0

> Estado: 🟡 En progreso  
> Rama base: `develop`  
> Target: `main` tag `v2.4.0`  
> Última actualización: 2026-06-02

---

## Checklist de entregas

- [x] **BUG-OCR** — OCR docs escaneados: **RESUELTO** — ya estaba activo en prod (feature/ocr-support mergeada). Test en tiempo real 2026-06-02: 22 págs escaneadas → OCR activo → textExtracted:true, proveedor y nº extraídos correctamente.
- [x] **BUG-ANALYSIS** — Análisis IA texto digital: **RESUELTO** — mismo test confirma pipeline Ollama funcional.
- [x] **Task F** — Eliminar importación CSV e integrar vista de lotes CI
- [ ] **Task G** — Revisión completitud de auditoría (AuditLog) en toda la app
- [ ] **Backlog OWASP** — Findings Low pendientes de sesiones anteriores
- [ ] **Release** — Merge develop → main + tag v2.4.0

---

## BUG-OCR: OCR docs escaneados no extrae texto

**Síntoma:** el worker `processBulkImportQueue` analiza ficheros escaneados y
devuelve `textExtracted: false`, como si no hubiera texto. Tesseract 5.5.1 está
instalado y operativo en el contenedor.

**Hipótesis a verificar (en orden):**
1. `OCR_ENABLED` env var en producción (¿está a `false`?).
2. El fallback OCR en `parseDocument` → `parsePdfWithOcr` se invoca correctamente
   cuando `pdf-parse` devuelve texto vacío.
3. El timeout global `TOTAL_OCR_TIMEOUT_MS` mata el proceso antes de extraer texto.
4. `pdftoppm` no está disponible en el contenedor prod (solo hay tesseract).

**Acciones:**
- [ ] Comprobar env vars en el contenedor prod
- [ ] Forzar un documento de prueba y leer logs en tiempo real
- [ ] Corregir la causa raíz
- [ ] Commit `fix(ocr): ...` en rama `bugfix/ocr-bulk-docs`
- [ ] OWASP / compliance: verificar que el fix no introduce nuevos riesgos
- [ ] Merge `bugfix/ocr-bulk-docs` → develop

---

## BUG-ANALYSIS: Análisis IA falla en PDFs con texto digital

**Síntoma:** documentos con texto seleccionable también dan error de análisis.
Indica problema en la llamada Ollama (`analyzeDocumentForImport`), no en el OCR.

**Hipótesis:**
1. Timeout de 60 s demasiado corto para el hardware actual.
2. Modelo Ollama no cargado / OOM en CPU.
3. Respuesta Ollama correcta pero `JSON.parse` falla (modelo no devuelve JSON puro).
4. `RAG_ENABLED` desactivado → worker no se ejecuta.

**Acciones:**
- [ ] Revisar logs Ollama durante análisis real
- [ ] Ajustar timeout / prompt si procede
- [ ] Commit `fix(bulk-analysis): ...` en `bugfix/ocr-bulk-docs` (misma rama)
- [ ] Merge junto con BUG-OCR

---

## Task F: Eliminar importación CSV + mejora vista lotes CI

**Objetivo:** con el bulk import AI de CIs ya disponible, la importación CSV es
redundante. Eliminarla simplifica la UI y elimina superficie de ataque.
Además, añadir acceso directo a la lista de lotes CI en la barra de inventario
(como documentos tiene el botón "Mis importaciones").

### Sub-tareas

#### F1 — Backend: eliminar endpoint legado `POST /api/cis/bulk` (JSON síncrono)
- [ ] Eliminar el handler del endpoint síncrono (~línea 2190 index.ts)
- [ ] Eliminar las constantes/tipos locales que sólo usa ese handler
- [ ] `npx tsc --noEmit` pasa sin errores nuevos
- [ ] Commit: `feat(task-f F1): remove legacy synchronous POST /api/cis/bulk`
- [ ] Compliance check: no había AuditLog en el endpoint legado → no hay pérdida

#### F2 — Frontend: eliminar importación CSV del inventario
- [ ] Eliminar `handleDownloadTemplate` (descarga plantilla CSV)
- [ ] Eliminar `handleImportCSV` + `Papa.parse` + `papaparse` import
- [ ] Eliminar botón "Descargar plantilla" y label "Importar CSV"
- [ ] Eliminar i18n keys: `download_template`, `import_csv`, `import_success`
  de los 6 ficheros de locale
- [ ] Limpiar imports no usados (`FileDown`, `Download`, `Upload`, `Papa`)
- [ ] Commit: `feat(task-f F2): remove CSV import from inventory UI`

#### F3 — Frontend: botón "Mis importaciones" en toolbar de inventario
- [ ] Añadir botón "Mis importaciones ↗" junto al de "Importar XLSX (AI)" que navega
  directamente a `/inventory/bulk` (la vista ya existe, sólo falta el acceso rápido)
- [ ] Verificar que `/inventory/bulk/page.tsx` muestra correctamente la lista de
  lotes con estados, fechas y acceso al detalle de cada uno
- [ ] Commit: `feat(task-f F3): add 'My CI batches' quick-access button to inventory`

#### F4 — Auditoría, OWASP y compliance Task F
- [ ] Subagente independiente: security review del diff completo de Task F
- [ ] Verificar A01 (sin bypass de `requireAdmin`), A03 (sin nuevas superficies de
  inyección), A09 (no se pierde trazabilidad al eliminar el CSV)
- [ ] Si findings Critical/High → corregir en esta tarea antes de merge
- [ ] Si findings Medium → corregir en esta tarea
- [ ] Si findings Low → añadir a sección Backlog de este fichero
- [ ] Actualizar `docs/security-audit/owasp-task-f.md`
- [ ] Commit: `docs(security): OWASP audit Task F`
- [ ] **Merge** `task-f/remove-csv-ci-batch-view` → develop

---

## Task G: Revisión completitud AuditLog en toda la app

**Objetivo:** garantizar que toda operación de escritura deja registro en
`audit_logs`, cumpliendo A.8.15 (ISO 27001), art. 5 GDPR (accountability) y
NIS2 art. 23 (trazabilidad de incidentes).

**Alcance actual detectado:** ~90 inserts en audit_logs vs ~114 endpoints de
escritura → gap estimado de ~24 endpoints sin trazabilidad.

### Sub-tareas

#### G1 — Análisis: mapear todos los endpoints de escritura sin AuditLog
- [ ] Generar tabla completa: endpoint → ¿tiene AuditLog? → entidad/acción sugerida
- [ ] Categorizar por riesgo: qué datos modifica cada endpoint
- [ ] Identificar los gaps de mayor impacto (usuarios, permisos, configuración)
- [ ] Commit: `docs(audit-gap): map of write endpoints missing AuditLog` (sólo doc)

#### G2 — Implementar AuditLog en gaps críticos (usuarios, settings, contratos)
- [ ] Endpoints de usuario: cambio de rol, cambio de contraseña, activar/desactivar
- [ ] Endpoints de settings: cambio de tema, configuración SMTP/LDAP/SSO
- [ ] Endpoints de contratos y licencias (si faltan)
- [ ] Endpoints de masters (fabricantes, tipos CI, ubicaciones…) ya cubiertos
  con `CREATE_MASTER`/`UPDATE_MASTER`/`DELETE_MASTER` — verificar todos
- [ ] Acciones de login/logout: verificar que `LOGIN` se registra
- [ ] Commit: `feat(task-g G2): add missing AuditLog records — users + settings`

#### G3 — Implementar AuditLog en gaps secundarios (documentos, CIs, relaciones)
- [ ] Verificar bulk document: `BULK_UPLOAD`, `BULK_COMMIT`, `BULK_DISCARD_*`,
  `BULK_REANALYZE_*` — check que cubren todos los caminos
- [ ] Verificar CI bulk: `CI_BULK_UPLOAD`, `CI_BULK_COMMIT`, `CI_BULK_DISCARD_*`,
  `CI_BULK_REANALYZE_*` — ídem
- [ ] Verificar vulnerabilidades: create/update/delete/resolve
- [ ] Commit: `feat(task-g G3): add missing AuditLog records — docs + CIs + vulns`

#### G4 — Auditoría, OWASP y compliance Task G
- [ ] Subagente independiente: security review del diff de Task G
- [ ] Verificar A09 antes/después; verificar que los datos no contienen PII
  en los campos `details` (GDPR art. 5 — minimización)
- [ ] Actualizar `docs/security-audit/owasp-task-g.md`
- [ ] Commit: `docs(security): OWASP audit Task G`
- [ ] **Merge** `task-g/audit-completeness` → develop

---

## Backlog OWASP (findings Low de sesiones anteriores)

> No bloquean el release pero deben quedar documentados y priorizados para v2.5.x

| ID | Feature | Finding | Prioridad |
|----|---------|---------|-----------|
| BULK-A04-1 | Bulk doc import | Sin tope de lotes concurrentes por admin en doc bulk (DoS disco/cola) | P2 |
| BULK-A08-2 | Bulk doc import | No re-valida magic-bytes al materializar el documento | P2 |
| OCR-A03-2 | OCR | Validar `OCR_DPI`/`OCR_LANGUAGES` contra allowlist antes de pasarlos a argv | P2 |
| OCR-A09-1 | OCR | Añadir AuditLog `OCR_INVOKED` y `OCR_FAILED` | P3 |
| OCR-A05-1 | OCR | Fijar versiones de paquetes apk de OCR en Dockerfile (`tesseract`, `poppler-utils`) | P3 |
| MFA-A05-1 | MFA wizard | TOTP secret renderizado en DOM durante el setup (visible en DevTools) | P2 |
| TECH-DEBT-1 | npm | `otplib` v12→v13 (deprecated) | P3 |
| TECH-DEBT-2 | npm | `uuid` v8→v11 (deprecated) | P3 |
| OPS-1 | Seed | Seed no llama backfill RAG al final | P3 |
| OPS-2 | TLS | Cert self-signed → CA corporativa | P2 |
| CI-BULK-A05-1 | CI bulk | `processCIBulkImportQueue`: missing `RAG_ENABLED` guard — **YA CORREGIDO en E5** | ✅ |

---

## Release v2.4.0

- [ ] Todos los checks anteriores completados y mergeados a develop
- [ ] `npx tsc --noEmit` limpio en backend
- [ ] Containers rebuildeados y `GET /api/health` OK
- [ ] `git checkout main && git merge --no-ff develop`
- [ ] `git tag v2.4.0`
- [ ] Actualizar `CLAUDE.md`: Current release → v2.4.0
- [ ] Actualizar `docs/ARCHITECTURE.md` + `.en.md` si aplica

---

## Notas de ejecución

- Modelo para planificación: Opus; para ejecución: Sonnet
- Cada sub-tarea tiene su propio commit (pequeño y sintético)
- Cada Task completa hace merge a develop con `--no-ff`
- Stop para revisión del usuario tras cada Task (F, G)
- Los bugs se resuelven antes de las tasks principales
- La secuencia es: BUG-OCR+ANALYSIS → Task F → Task G → Backlog (selectivo) → Release
