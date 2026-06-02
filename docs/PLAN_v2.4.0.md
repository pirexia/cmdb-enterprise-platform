# Plan de desarrollo v2.4.0

> Estado: 🟡 En progreso  
> Rama base: `develop`  
> Target: `main` tag `v2.4.0`  
> Última actualización: 2026-06-02

---

## Checklist de entregas

- [x] **BUG-OCR** — OCR docs escaneados: **RESUELTO** — ya estaba activo en prod (feature/ocr-support mergeada). Test en tiempo real 2026-06-02: 22 págs escaneadas → OCR activo → textExtracted:true, proveedor y nº extraídos correctamente.
- [x] **BUG-ANALYSIS** — Análisis IA texto digital: **RESUELTO** — mismo test confirma pipeline Ollama funcional.
- [x] **Task F** — Eliminar importación CSV e integrar vista de lotes CI — código correcto, **pendiente rebuild contenedores** (ver BUG-CONTAINERS)
- [x] **Task G** — Revisión completitud de auditoría (AuditLog) — G1/G2/G3 completos, **G4 (OWASP) pendiente**
- [x] **BUG-CONTAINERS** — Rebuild contenedores post-merge Task F — ✅ verificado: código de import CSV ausente en chunks compilados
- [ ] **G4 + Merge Task G** — OWASP audit Task G + merge a develop
- [ ] **Backlog OWASP** — Findings pendientes de sesiones anteriores (selectivo)
- [ ] **Release** — Merge develop → main + tag v2.4.0

---

## BUG-CONTAINERS: Frontend muestra botones CSV eliminados por Task F

**Síntoma:** La vista de Inventario de CIs muestra "Plantilla CSV" e "Importar CSV" aunque el código de Task F los eliminó correctamente.

**Causa:** Los contenedores Docker no han sido rebuildeados desde el merge de Task F. El frontend Next.js compila en build time — el contenedor sirve la build antigua.

**Verificado:** `frontend/app/inventory/page.tsx` no contiene `handleImportCSV`, `handleDownloadTemplate` ni los botones de importación. El código es correcto.

**Fix:** Rebuild de contenedores con:
```bash
sg docker -c "docker compose -f docker-compose.prod.yml down && docker compose -f docker-compose.prod.yml up -d --build"
```

> ⚠️ Hacer esto después del merge de Task G para no rebuildar dos veces.

---

## BUG-OCR: OCR docs escaneados no extrae texto ✅ RESUELTO

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
- [x] Comprobar env vars en el contenedor prod
- [x] Forzar un documento de prueba y leer logs en tiempo real
- [x] Corregir la causa raíz
- [x] Commit `fix(ocr): ...` — integrado en feature/ocr-support → develop
- [x] OWASP / compliance: verificado
- [x] Merge `feature/ocr-support` → develop ✅

---

## BUG-ANALYSIS: Análisis IA falla en PDFs con texto digital ✅ RESUELTO

**Síntoma:** documentos con texto seleccionable también dan error de análisis.
Indica problema en la llamada Ollama (`analyzeDocumentForImport`), no en el OCR.

**Acciones:**
- [x] Revisar logs Ollama durante análisis real
- [x] Ajustar timeout / prompt — contexto reducido 12000→6000 chars (`b20a09b`)
- [x] Serializar queue doc+CI de uno en uno (`b20a09b`)
- [x] Merge junto con BUG-OCR ✅

---

## Task F: Eliminar importación CSV + mejora vista lotes CI ✅ COMPLETO

**Objetivo:** con el bulk import AI de CIs ya disponible, la importación CSV es
redundante. Eliminarla simplifica la UI y elimina superficie de ataque.
Además, añadir acceso directo a la lista de lotes CI en la barra de inventario
(como documentos tiene el botón "Mis importaciones").

### Sub-tareas

#### F1 — Backend: eliminar endpoint legado `POST /api/cis/bulk` (JSON síncrono) ✅
- [x] Eliminar el handler del endpoint síncrono — commit `f81a65d`
- [x] Eliminar las constantes/tipos locales que sólo usa ese handler
- [x] `npx tsc --noEmit` pasa sin errores nuevos
- [x] Compliance check: no había AuditLog en el endpoint legado → no hay pérdida

#### F2 — Frontend: eliminar importación CSV del inventario ✅
- [x] Eliminar `handleDownloadTemplate` (descarga plantilla CSV) — commit `e3520cb`
- [x] Eliminar `handleImportCSV` + `Papa.parse` + `papaparse` import
- [x] Eliminar botón "Descargar plantilla" y label "Importar CSV"
- [x] Limpiar imports no usados (`FileDown`, `Download`, `Upload`, `Papa`)

#### F3 — Frontend: botón "Mis importaciones" en toolbar de inventario ✅
- [x] Botón "Mis importaciones" navegando a `/inventory/bulk?tab=list` — commit `72fee99`
- [x] Verificado: `/inventory/bulk/page.tsx` muestra lista de lotes con estados y detalle

#### F4 — Auditoría, OWASP y compliance Task F ✅
- [x] Security review del diff completo de Task F — commit `044534a`
- [x] Resultado: 0C / 0H / 0M / 0L
- [x] **Merge** `task-f/remove-csv-ci-batch-view` → develop — commit `38c2183`

> ⚠️ Nota pendiente: `actions.download_template` ("Plantilla CSV") sigue en locales — es clave huérfana; no se usa en inventory/page.tsx. Limpiar en Backlog.

---

## Task G: Revisión completitud AuditLog en toda la app 🟡 EN PROGRESO

**Objetivo:** garantizar que toda operación de escritura deja registro en
`audit_logs`, cumpliendo A.8.15 (ISO 27001), art. 5 GDPR (accountability) y
NIS2 art. 23 (trazabilidad de incidentes).

**Alcance actual detectado:** ~90 inserts en audit_logs vs ~114 endpoints de
escritura → gap estimado de ~24 endpoints sin trazabilidad.

### Sub-tareas

#### G1 — Análisis: mapear todos los endpoints de escritura sin AuditLog ✅
- [x] Generada tabla completa durante análisis de sesión (G2+G3 derivan de este análisis)
- [x] Categorizado por riesgo; gaps de mayor impacto identificados

#### G2 — Implementar AuditLog en gaps críticos ✅ — commit `eeee725`
- [x] `LOGOUT` — registro al cerrar sesión
- [x] MFA: `MFA_SETUP_INITIATED`, `MFA_ENABLED`, `MFA_DISABLED`, `MFA_RESET`
- [x] Reset vulnerabilidades: `RESET_VULNS`
- [x] Delete all MFRs: `DELETE_ALL_MFRS`
- [x] Settings de sistema (SMTP, LDAP, SSO, tema, contraseña política)
- [x] Cambios de estado/entorno de CI sin AuditLog previo

#### G3 — Implementar AuditLog en gaps secundarios ✅ — commit `c8696c1`
- [x] Links/unlinks Documento↔CI, Documento↔Contrato, CI↔Contrato
- [x] Bulk-link: `LINK_DOCUMENT` (CI ids, contract ids), `LINK_CI` (document ids, contract ids)
- [x] Integrations: sync manual, toggle enable/disable integración
- [x] Cambios de rol de usuario, activar/desactivar usuario
- [x] Extras: `fix(dockerfile)` npm cache clean `10965e9`; serializar cola `b20a09b`

#### G4 — Auditoría, OWASP y compliance Task G ⬅ SIGUIENTE PASO
- [ ] Subagente independiente: security review del diff de Task G
- [ ] Verificar A09 antes/después; verificar que `details` no contiene PII (GDPR art. 5)
- [ ] Actualizar `docs/security-audit/owasp-task-g.md`
- [ ] Commit: `docs(security): OWASP audit Task G`
- [ ] **Merge** `task-g/audit-completeness` → develop
- [ ] Rebuild contenedores (también resuelve BUG-CONTAINERS)

---

## Backlog OWASP (findings pendientes de sesiones anteriores)

> No bloquean el release pero deben quedar documentados y priorizados para v2.5.x

| ID | Feature | Finding | Prioridad |
|----|---------|---------|-----------|
| BULK-A04-1 | Bulk doc import | Sin tope de lotes concurrentes por admin (DoS disco/cola) | P2 |
| BULK-A08-2 | Bulk doc import | No re-valida magic-bytes al materializar el documento | P2 |
| OCR-A03-2 | OCR | Validar `OCR_DPI`/`OCR_LANGUAGES` contra allowlist antes de pasarlos a argv | P2 |
| OCR-A09-1 | OCR | Añadir AuditLog `OCR_INVOKED` y `OCR_FAILED` | P3 |
| OCR-A05-1 | OCR | Fijar versiones de paquetes apk de OCR en Dockerfile (`tesseract`, `poppler-utils`) | P3 |
| MFA-A05-1 | MFA wizard | TOTP secret renderizado en DOM durante el setup (visible en DevTools) | P2 |
| TECH-DEBT-1 | npm | `otplib` v12→v13 (deprecated) | P3 |
| TECH-DEBT-2 | npm | `uuid` v8→v11 (deprecated) | P3 |
| OPS-1 | Seed | Seed no llama backfill RAG al final | P3 |
| OPS-2 | TLS | Cert self-signed → CA corporativa | P2 |
| F-LOCALE-1 | i18n | `actions.download_template` ("Plantilla CSV") clave huérfana en 6 locales tras Task F | P3 |
| CI-BULK-A05-1 | CI bulk | `processCIBulkImportQueue`: missing `RAG_ENABLED` guard — **YA CORREGIDO en E5** | ✅ |

---

## Release v2.4.0

- [ ] Task G completo y mergeado a develop
- [ ] Contenedores rebuildeados (`docker compose ... up -d --build`)
- [ ] `GET /api/health` OK + botones CSV ausentes en Inventario (verifica BUG-CONTAINERS)
- [ ] `npx tsc --noEmit` limpio en backend
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
