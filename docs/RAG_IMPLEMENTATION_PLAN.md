# Plan de implementación — Asistente IA con RAG local

**Estado global:** 🟡 En preparación · Aún no se ha iniciado la oleada -2
**Rama de trabajo:** `claude/local-llm-document-search-wrlSq`
**Destino final:** PR a `develop` (nunca a `main`)
**Servidor de producción objetivo:** `lx-gest01p.svc.int` (RHEL 9, 12 vCPU AMX, 32 GiB RAM)
**Última actualización:** 2026-05-20

---

## 1. Objetivo

Integrar un asistente conversacional con RAG (Retrieval-Augmented Generation) sobre el corpus documental del CMDB. El usuario puede preguntar en lenguaje natural y el sistema responde citando los documentos asociados (contratos, procedimientos, fichas técnicas, etc.), respetando la asociación con CIs, las ACL por rol y la normativa aplicable (OWASP, ISO 27001:2022, NIS2, GDPR, ISO 22301).

Restricción dura: **todo el procesamiento ocurre localmente** (Ollama + pgvector dentro de la misma red Podman/Docker). Sin transferencia internacional de datos. Sin servicios externos de IA.

---

## 2. Decisiones cerradas

| Pieza | Elección |
|---|---|
| BD vectorial | **pgvector** dentro del mismo PostgreSQL — cero infraestructura nueva |
| Embeddings | **`bge-m3`** (1024-d, multilingüe, ~600 MB) vía Ollama |
| LLM chat | **`qwen2.5:7b-instruct-q4_K_M`** (configurable; fallback `qwen2.5:3b` para hosts pequeños) |
| Runtime LLM | Servicio `ollama` en compose, red interna, sin exposición al host |
| Parsing | `pdf-parse`, `mammoth` (docx), `exceljs` (xlsx — ya en deps), `officeparser` (pptx/odt/ods) |
| Chunking | Semántico por encabezados + cap 800 tokens / overlap 120 |
| Búsqueda | HNSW `vector_cosine_ops` + filtro metadata pre-vector + reranking MMR |
| Streaming UI | SSE (`text/event-stream`) |
| Citaciones | Cada respuesta incluye `[{documentId, version, page, section, snippet}]` con deep-link |
| ACL documentos | Flags binarios `read_admin / read_auditor / read_viewer` (default `true,true,true`) |
| Auditoría | `AuditLog` insert por cada `ASK_RAG`, `INDEX_DOC`, `REINDEX_DOC`, `UPDATE_DOC_ACL`, `RAG_BACKFILL` |
| Rate limit chat | 10 req/min/usuario sobre `/api/chat/ask*` |
| Retención de sesiones | 90 días sesiones+mensajes, 1 año audit log `ASK_RAG` |

---

## 3. Dimensionamiento aprobado

VM de producción `lx-gest01p`:

| Recurso | Antes | Ahora | Comentario |
|---|---|---|---|
| vCPU | 4 | **12** | Xeon Gold 6526Y "Sapphire Rapids" — AMX expuesto al guest |
| RAM | 8 GiB | **32 GiB** | Suficiente para Postgres + Backend + Ollama 7B con buffer |
| Disco extra | — | **+150 GB** | LV `containers` 100 GB (`/var/lib/containers`) y LV `cmdbdata` 70 GB (`/opt/cmdb-data`) |
| GPU | — | — | Inferencia CPU con AMX → ~12–18 tok/s en `qwen2.5:7b` Q4_K_M |
| Compat. VMware | v19 | **v21** (ESXi 8.0) | Necesario para AMX; ya aplicado |

Tiempos de respuesta esperados (1 usuario, 12 vCPU + AMX):
- TTFT (time-to-first-token): 1–2 s
- Respuesta completa (~250 tokens): 10–18 s (con streaming SSE percepción ≈ instantánea)

---

## 4. Estado del host (a 2026-05-20)

Verificado en vivo en `lx-gest01p.svc.int`:

- [x] Compatibilidad VM subida a v21
- [x] AMX visible en `/proc/cpuinfo` (`amx_tile amx_bf16 amx_int8`)
- [x] Disco nuevo `sde` 150 GB añadido a `vg00`
- [x] LV huérfanas limpiadas (recuperados ~29 GB)
- [x] LVs `containers` (100 GB) y `cmdbdata` (70 GB) creadas, formateadas XFS y persistidas en `/etc/fstab`
- [x] `dnf -y update` aplicado
- [x] Podman 5.8.0 + podman-compose 1.5.0 operativos
- [x] `sysctl` y `limits` aplicados (ver `docs/RAG_HOST_PREPARATION.md`)
- [x] `firewalld` activo (`http, https, ssh, cockpit, dhcpv6-client`)
- [x] `/opt/cmdb-data/{repo,documents,postgres,ollama-models,backups}` creados
- [x] `podman info` reporta `graphRoot: /var/lib/containers/storage` sobre la LV nueva
- [x] Smoke test `podman pull alpine` correcto
- [ ] SELinux en `enforcing` (deuda de hardening, no bloquea)

---

## 5. Oleadas y agentes

> **Convenciones para los agentes:**
>
> 1. Cada agente actualiza su propia casilla y la del agente padre al **completar** su tarea.
> 2. Al cerrar una oleada, quien commitea la rama actualiza el bloque "Estado global" arriba.
> 3. Los agentes NO ejecutan `git` directamente — la sesión orquestadora consolida commits al final de cada oleada para evitar conflictos de checkout.
> 4. Si un agente encuentra un bloqueo, marca su casilla como ❌ y añade una línea bajo "Incidencias" al final del documento.

### Oleada -2 — Documentación de host y arquitectura (3 paralelos)

- [ ] **H1** · Crear `docs/RAG_HOST_PREPARATION.md` y `.en.md` con la guía paso a paso ya validada en vivo en `lx-gest01p`. Incluye: dimensionamiento, ajustes vCenter (AMX), LVM, dnf update, Podman, sysctl/limits, firewalld, SELinux como deuda, smoke test, troubleshooting.
- [ ] **H2** · Actualizar `docs/ARCHITECTURE.md` y `.en.md`: añadir sección "9bis. Subsistema RAG / Asistente IA" con diagrama Mermaid (Browser → nginx → backend → pgvector / ollama), capacity planning, AMX, retención.
- [ ] **H3** · Actualizar `docs/SYSADMIN_MANUAL.md` y `.en.md`: operación de Ollama (`ollama pull/list/ps`), backup de pgvector (`pg_dump --table=rag_*`), troubleshooting, integración con cron de EOL existente, métricas (`podman stats`).

### Oleada -1 — Control de visibilidad de documentos por rol (B1 → B2 + B3)

- [x] **B1** · ✅ Completado en commit `093b1d9` — migración `add_document_role_acl` + 3 campos boolean en `schema.prisma`. **Pendiente añadir el índice** `@@index([readAdmin, readAuditor, readViewer], map: "idx_documents_read_acl")` (no entró en el commit original; B2 puede crearlo en su migración o en una nueva).
- [ ] **B2** · Backend (`backend/src/index.ts`): helper `docVisibilityFilter(role)`, aplicar en todos los `GET /api/documents*`, `GET /api/documents/:id/download`, `GET /api/documents/:id/versions`, `GET /api/cis/:id/documents`, `GET /api/contracts/:id/documents`, `GET /api/licenses/:id/documents`. Nuevo `PATCH /api/documents/:id/acl` (ADMIN, Zod, audit log `UPDATE_DOC_ACL`). Bloquear `POST /api/cis/:id/documents` si el doc no es legible por el rol.
- [ ] **B3** · Frontend: switches "Visible para ADMIN/AUDITOR/VIEWER" en `AddDocumentModal` y `EditDocumentModal` (editables solo si ADMIN; resto solo lectura). Badge en `DocumentDetailModal`. Claves i18n en los 6 idiomas (`es/en/de/pt/fr/it.json`).

### Oleada 0 — Diseño y seguridad (1 agente bloqueante)

- [ ] **A0** · Crear `docs/security/rag-dpia.md` (DPIA + threat model STRIDE) + delta en `docs/security-audit/{iso27001,gdpr,nis2}.md`. Mapea cada riesgo a control y a fichero/línea donde se implementará. **Bloquea las oleadas 1-3.**

### Oleada 1 — Cimientos del RAG (5 paralelos)

- [ ] **A1** · Compose: nuevo servicio `ollama` en `docker-compose.yml` y `docker-compose.prod.yml` (imagen `docker.io/ollama/ollama:latest`, bind-mount opcional a `/opt/cmdb-data/ollama-models`, healthcheck, sin exposición al host). Añadir variables `OLLAMA_BASE_URL`, `RAG_EMBED_MODEL`, `RAG_CHAT_MODEL`, `RAG_ENABLED`, `RAG_CHAT_TEMPERATURE`, `RAG_TOP_K`, `RAG_RATE_LIMIT_PER_MIN` en `.env.example`. Compatible con `podman-compose 1.5+`.
- [ ] **A2** · Migración pgvector: `CREATE EXTENSION IF NOT EXISTS vector`, tablas `rag_document_index`, `rag_chunks` (FK doc, `embedding vector(1024)`, `section`, `page_start/end`, `token_count`, `metadata jsonb`), `rag_chat_sessions`, `rag_chat_messages`. Índice HNSW. Actualizar `schema.prisma` con `Unsupported("vector(1024)")`. **OJO**: validar que la imagen Postgres elegida lleva pgvector (ver hallazgos de revisión final).
- [ ] **A3** · `backend/src/services/ragService.ts`: cliente Ollama (embed + chat) con allowlist de host (`OLLAMA_BASE_URL`), timeouts, errores enmascarados, retry exponencial.
- [ ] **A4** · `backend/src/services/docParser.ts`: extracción de texto por extensión con re-validación de magic bytes. Devuelve `Array<{sectionPath, text, page?}>`. Límites duros (tiempo, tamaño).
- [ ] **A5** · `backend/src/services/chunker.ts`: chunking heading-aware + cap 800 tok / overlap 120, metadata enriquecida.

### Oleada 2 — API RAG (4 paralelos)

- [ ] **A6** · Ingesta automática: hooks en `POST /api/documents` y `POST /api/documents/:id/versions`. Cola con `node-cron` cada 30 s + tabla `rag_document_index` con estados `PENDING/INDEXING/READY/ERROR`. Cascada de borrado. Audit log `INDEX_DOC`.
- [ ] **A7** · `POST /api/admin/rag/backfill` (ADMIN, rate-limit estricto, audit log `RAG_BACKFILL`, idempotente).
- [ ] **A8** · Endpoints chat: `GET/POST/DELETE /api/chat/sessions`, `GET /api/chat/sessions/:id/messages`, `POST /api/chat/ask`, `POST /api/chat/ask/stream` (SSE). Pipeline retrieval → MMR → prompt con citaciones obligatorias → llamada Ollama. Zod, helmet, `express-rate-limit` 10/min.
- [ ] **A9** · Middleware `enforceDocAccess`: filtro SQL combinando `read_<role>` y kNN en una sola query. Sanitización prompt-injection (strip control chars, system prompt blindado). Audit log `ASK_RAG` con hash de la query (sin contenido PII).

### Oleada 3 — Frontend chat (3 paralelos)

- [ ] **A10** · `frontend/app/chat/page.tsx` (Client Component): lista de sesiones, hilo con bubbles, chips de filtro (tipo doc, CI, contrato, fechas), input multilinea, SSE consumer en `apiFetch.ts`, markdown render con `react-markdown` + `remark-gfm`, citaciones clicables a `/documents/:id`. Entrada en `Sidebar.tsx`.
- [ ] **A11** · Claves i18n del chat en los 6 idiomas.
- [ ] **A12** · `DocumentDetailModal`: badge "Indexado / En cola / Error / Sin indexar" + botón "Re-indexar" (ADMIN) → `POST /api/documents/:id/reindex`.

### Oleada 4 — Instalador desatendido y actualización (2 paralelos)

- [ ] **I1** · Refactor `scripts/install.sh`:
  - Flags CLI: `--unattended`, `--config-file <ruta>`, `--enable-rag`, `--rag-chat-model`, `--rag-embed-model`, `--data-path`, `--admin-email`, `--admin-password`, `--public-url`, `--company-name`, `--use-podman`, `--apply-host-tuning`.
  - Fase 5b "Host tuning" opcional: sysctl, limits, firewalld, comprobación AMX/AVX-512.
  - Fase 10b "RAG bootstrap": pull de Ollama, espera healthcheck, `ollama pull` de embed + chat models, `prisma migrate deploy`, smoke test `POST /api/chat/ask`.
  - Detector de capacidad: si RAM < 16 GB o vCPU < 8 → warning + sugerencia `qwen2.5:3b`.
  - Mantener compatibilidad macOS dev.
  - Logs a `$INSTALL_DIR/install-<fecha>.log` con secciones.
- [ ] **I2** · Refactor `scripts/update.sh`:
  - Detección automática de RAG en `.env`.
  - Re-pull de modelos Ollama si cambia el tag.
  - Backup pre-update de la BD entera (incluye `rag_*`).
  - Flag `--reindex` para reprocesar tras cambio de embed model.

### Oleada 5 — Verificación y documentación de cierre (2 paralelos)

- [ ] **A13** · Verificación end-to-end: `verify` + `find-bugs` + `differential-review`. Smoke real (subir PDF, query en ES, validar citaciones), `tsc --noEmit` sin nuevos errores, audit log verificado, `curl https://localhost/api/health`.
- [ ] **A14** · Documentación de cierre:
  - `docs/USER_MANUAL.md` y `.en.md`: nueva §"Asistente IA: búsqueda inteligente de documentos".
  - `docs/USER_MANUAL.md` §11: actualizar para reflejar nuevos switches de ACL.
  - `README.md` y `README.en.md`: sección breve sobre RAG + enlace a `RAG_HOST_PREPARATION.md`.

---

## 6. Entregables al cerrar el plan

1. PR contra `develop` con todos los cambios anteriores.
2. Fichero `scripts/install.example.conf` con plantilla para instalación desatendida.
3. Fichero `install.conf` específico para `lx-gest01p` con sus paths (`/opt/cmdb-data/...`), dominios y modelos elegidos.
4. Comando único de despliegue:
   ```bash
   cd /opt/cmdb-data/repo && \
     sudo bash scripts/install.sh \
       --unattended \
       --config-file ./install.conf \
       --enable-rag \
       --apply-host-tuning
   ```

---

## 7. Fuera de alcance

- Merge a `develop` o `main` (solo se abre PR).
- Reinstalar SELinux en `enforcing` (anotado como deuda).
- Multi-tenant en RAG (se deja hueco `tenantId` en el schema pero sin activar).
- Integración con LLMs remotos (Anthropic, OpenAI). Todo local.
- Tests automatizados nuevos (se verifica manualmente; framework de tests no existe en el repo según revisión).
- OCR de PDFs escaneados (los PDFs con imágenes sin texto extraíble quedan fuera del RAG en esta fase; documentado como limitación).

---

## 8. Pre-flight findings — revisión final del proyecto

> Pendiente de integrar. Agente background `af7a42457eb411415` ejecutándose; al terminar se insertan aquí los hallazgos relevantes con `file_path:line` y la implicación sobre el plan.

| # | Hallazgo | Implicación |
|---|---|---|
| _pendiente_ | _pendiente_ | _pendiente_ |

---

## 9. Incidencias

> Si un agente encuentra un bloqueo durante la ejecución, añade una fila aquí con fecha, agente, descripción y resolución propuesta.

| Fecha | Agente | Bloqueo | Resolución |
|---|---|---|---|
| _sin incidencias_ | — | — | — |

---

## 10. Historial de cambios del plan

| Fecha | Cambio | Autor |
|---|---|---|
| 2026-05-20 | Creación del documento de plan | sesión de planificación |
| 2026-05-20 | Marcado B1 como completado (commit `093b1d9` previo) | sesión de planificación |
