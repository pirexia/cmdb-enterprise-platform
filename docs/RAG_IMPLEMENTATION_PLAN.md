# Plan de implementación — Asistente IA con RAG local

**Estado global:** 🟢 Todas las oleadas ✅ completadas · Listo para PR contra `develop`
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

- [x] **H1** · ✅ Commit `797a270` — `docs/RAG_HOST_PREPARATION.md` + `.en.md` (514 líneas c/u, 11 secciones + 4 apéndices, validada en vivo en lx-gest01p.svc.int 2026-05-20).
- [x] **H2** · ✅ Commit `ae4d2ea` — `docs/ARCHITECTURE.md` + `.en.md`, sección §12 RAG (144 líneas c/u, diagramas Mermaid ingesta+query, topology, capacity planning AMX).
- [x] **H3** · ✅ Commit `ae4d2ea` — `docs/SYSADMIN_MANUAL.md` + `.en.md`, sección §19 Operación RAG (208 líneas c/u, backfill, backup pg_dump, monitorización, troubleshooting).

### Oleada -1 — Control de visibilidad de documentos por rol (B1 → B2 + B3)

- [x] **B1** · ✅ Commit `093b1d9` — migración `20260520120000_add_document_role_acl` con `read_admin/auditor/viewer` (default true) + índice `idx_documents_read_acl`.
- [x] **B2** · ✅ Commits `fb44974`+`162331d` — helpers `docVisibilityFilter`/`docVisibilitySqlCol`, filtro aplicado a 8 endpoints GET, `PATCH /api/documents/:id/acl` (ADMIN, Prisma.sql+join, audit log). tsc: 0 errores nuevos.
- [x] **B3** · ✅ Commits `fb44974`+`162331d`+`601c3dd` — switches ACL en modal de subida y vista detalle (ADMIN only), badge de visibilidad, i18n en 6 idiomas.

### Oleada 0 — Diseño y seguridad (1 agente bloqueante)

- [x] **A0** · ✅ Commit `a318212` — `docs/security/rag-dpia.md` (274 líneas, 13 secciones, STRIDE con 11 vectores) + deltas en `iso27001.md` (7 controles), `gdpr.md` (actividad de tratamiento Art.30), `nis2.md` (5 riesgos Art.21).

### Oleada 1 — Cimientos del RAG (5 paralelos)

- [x] **A1** · ✅ — `docker-compose.yml` y `docker-compose.prod.yml`: servicio `ollama` (imagen `docker.io/ollama/ollama:latest`, postgres → `pgvector/pgvector:pg15/pg16`, bind-mount `/opt/cmdb-data/ollama-models`, healthcheck, sin puertos al host). `.env.example` con 7 vars RAG. `nginx/conf.d/frontend.conf`: `location /api/chat/` con `proxy_buffering off` + `proxy_cache off` + `proxy_read_timeout 300s`.
- [x] **A2** · ✅ — Migración `20260520130000_add_pgvector_rag`: `CREATE EXTENSION vector`, tablas `rag_document_index`, `rag_chunks` (`embedding vector(1024)`), `rag_chat_sessions`, `rag_chat_messages`. Índice HNSW `m=16 ef_construction=64`. `schema.prisma` con 4 modelos + `Unsupported("vector(1024)")`. tsc: 0 errores nuevos.
- [x] **A3** · ✅ — `backend/src/services/ragService.ts`: SSRF allowlist (`ALLOWED_OLLAMA_PATTERN`), `getEmbedding()`, `getEmbeddingsBatch()` (lotes de 32), `chatWithContext()`, `streamChatWithContext()` (NDJSON), `buildRagPrompt()` (system prompt fijo anti-inyección), `sanitizeQuery()`, `isOllamaHealthy()`. Timeouts 30s embed / 120s chat. tsc: 0 errores nuevos.
- [x] **A4** · ✅ — `backend/src/services/docParser.ts`: PDF (`pdf-parse`), DOCX/DOC (`mammoth`), XLSX (`exceljs`, max 1000 filas/hoja), PPTX/ODT/ODS (`officeparser`), TXT/CSV. `package.json` actualizado. Timeout 60s/doc, límite 2M chars. tsc: 0 errores nuevos.
- [x] **A5** · ✅ — `backend/src/services/chunker.ts`: `chunkSections()`, `chunkText()`, `splitAtSentenceBoundary()`. Defaults: maxTokens=800, overlap=120, minChunkTokens=50. Token heuristic word/0.75. tsc: 0 errores nuevos.

### Oleada 2 — API RAG (4 paralelos)

- [x] **A6** · ✅ — `queueDocumentForIndexing()` + `processRagQueue()` en index.ts (3009–3104). Hooks en `POST /api/documents` (3423), `POST /api/documents/:id/versions` (3632). Nueva ruta `POST /api/documents/:id/reindex` (3401). Cron `*/30 * * * * *` gateado por `RAG_ENABLED` (4231). Audit log `INDEX_DOC` / `REINDEX_DOC`. Cascada vía FK ON DELETE CASCADE. tsc: 0 errores nuevos.
- [x] **A7** · ✅ — `POST /api/admin/rag/backfill` (3512) idempotente con UPSERT a PENDING, audit log `RAG_BACKFILL` con conteo en `details`. `ragBackfillLimiter` 1/min (226). 503 si `RAG_ENABLED!='true'`. tsc: 0 errores nuevos.
- [x] **A8** · ✅ — 6 endpoints chat (4787–4996): `GET/POST/DELETE /api/chat/sessions`, `GET /api/chat/sessions/:id/messages`, `POST /api/chat/ask`, `POST /api/chat/ask/stream` (SSE con `text/event-stream`, `X-Accel-Buffering: no`, eventos `session/citations/token/done/error`). `chatAskLimiter` 10/min (239). Zod schemas (289). Verifica ownership de sesión. tsc: 0 errores nuevos.
- [x] **A9** · ✅ — `ragSearchChunks(query, role, topK)` (3117) con ACL pre-filter + pgvector kNN en una sola query (HNSW `<=>`). `logAskRag()` (3168) con SHA-256 del query (sin PII). Import ampliado en ragService. tsc: 0 errores nuevos.

### Oleada 3 — Frontend chat (3 paralelos)

- [x] **A10** · ✅ — `frontend/lib/useChatStream.ts` (245 líneas, SSE parser line-by-line, ChatStreamEvent tipado, AbortController), `frontend/app/chat/page.tsx` (560 líneas, layout 2 columnas, optimistic UI, citations chips → `/documents/:id`, banner 503 distinto), `Sidebar.tsx` +1 entrada `sidebar.assistant` con icono `Sparkles`. Markdown plano (sin react-markdown). 0 errores TS nuevos.
- [x] **A11** · ✅ — `sidebar.assistant` + bloque `chat` (18 claves incl. error.{generic,empty,rateLimit}) + extensión `document` (indexing.{title,pending,indexing,ready,error,notIndexed,chunkCount,indexedAt} + reindex/reindexConfirm/reindexQueued) en los 6 idiomas (es/en/de/pt/fr/it). Validación JSON OK.
- [x] **A12** · ✅ — Backend: `GET /api/documents/:id/index-status` (22 líneas, LEFT JOIN, devuelve NOT_INDEXED por defecto). Frontend: badge coloreado con i18n, botón Re-indexar (ADMIN only) con confirm, polling cada 5s mientras PENDING/INDEXING, cleanup en unmount. 0 errores TS nuevos.

### Oleada 4 — Instalador desatendido y actualización (2 paralelos)

- [x] **I1** · ✅ — `scripts/install.sh` 962 → 1314 líneas (+352). Parser CLI completo (`--unattended`, `--config-file`, `--enable-rag`, `--apply-host-tuning`, etc.), helpers `prompt()`/`confirm()` con guard de modo unattended, fase 5b host tuning (sysctl, limits, firewalld, AMX/AVX-512 check, Linux-only), bloque RAG en .env (fase 6), fase 10b bootstrap (capacity check, Ollama healthcheck 90s, `ollama pull` embed+chat, `prisma migrate deploy`, smoke test `/api/embeddings`). `scripts/install.example.conf` (77 líneas) + `install.conf` para lx-gest01p.svc.int (40 líneas). `bash -n`: OK.
- [x] **I2** · ✅ — `scripts/update.sh` 584 → 687 líneas (+103). Detección automática RAG vía `.env` (`RAG_PRESENT`), función `ensure_ollama_models()` con healthcheck 60s y pull condicional, flag `--reindex` con función `reindex_documents()` (UPDATE PENDING + INSERT faltantes vía psql). Backup verificado: `pg_dump` ya incluye todas las tablas `rag_*` (whole-DB dump). `bash -n`: OK.

### Oleada 5 — Verificación y documentación de cierre (2 paralelos)

- [x] **A13** · ✅ — `docs/RAG_VERIFICATION_A13.md` (15 KB, 10 secciones). Veredicto: **Ready to open PR after manual smoke test**. 2 bugs HIGH detectados y arreglados:
  - **BUG-001** (CRÍTICO): imágenes Postgres no llevaban pgvector. Fix: `pgvector/pgvector:pg15` y `pg16` en ambos compose files (commit `7782c90`).
  - **BUG-002** (MEDIO): `POST /api/chat/ask` usaba `result.answer`/`result.modelUsed` pero `chatWithContext()` devuelve `{ content, model }`. Fix: 3 sitios actualizados (commit `7782c90`).
  - Todos los checks pasan: tsc (0 nuevos), bash -n (OK), JSON locales (6/6), seguridad (a-i todos PASS), cron sin colisión, docker sin puertos expuestos, nginx SSE correcto.
- [x] **A14** · ✅ — `docs/USER_MANUAL.md` §23 (ya presente, 61 líneas) y `.en.md` con misma estructura traducida. §11 cross-reference a §23 ya presente en ambos. `README.md` ya tenía el bullet RAG (línea 50). `README.en.md` (commit `7782c90`): +2 filas (Licence Repository y Local AI Assistant with RAG) para alinear con la versión es.

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

Revisión completada el 2026-05-20 (agente Explore en foreground). Resumen de hallazgos accionables:

### 8.1 Cambios obligatorios en infraestructura

| # | Hallazgo | Implicación / acción |
|---|---|---|
| F1 | Imagen Postgres actual: `postgres:15-alpine` (dev) y `postgres:16-alpine` (prod). **No incluye pgvector.** | **A1/A2:** Cambiar a `pgvector/pgvector:pg15` y `pgvector/pgvector:pg16` respectivamente. Mantener volúmenes y env vars. |
| F2 | `nginx/conf.d/frontend.conf` no desactiva buffering en `/api/`. SSE quedaría retardado/buffereado. | **A1 + A8:** Añadir bajo `location /api/`: `proxy_buffering off;` y forzar response header `X-Accel-Buffering: no` en `/api/chat/ask/stream`. |
| F3 | `frontend/lib/apiFetch.ts` no soporta SSE (solo fetch JSON). | **A10:** Crear hook nuevo `useChatStream()` usando `fetch` + `response.body.getReader()` con `credentials: "include"`. No tocar `apiFetch`. |

### 8.2 Patrones existentes a respetar

| # | Hallazgo | Implicación |
|---|---|---|
| F4 | 24 endpoints existentes bajo `/documents` (líneas 3056–4394 de `backend/src/index.ts`). | **B2:** Aplicar `docVisibilityFilter(role)` a los GETs (`/api/documents`, `/api/documents/:id`, `/api/documents/:id/download`, `/api/documents/:id/versions`, `/api/cis/:id/documents`, `/api/contracts/:id/documents`, `/api/licenses/:id/documents`, `/api/documents/:id/notes`). Bloquear POSTs de asociación si el doc no es legible. |
| F5 | Cron jobs actuales en `backend/src/index.ts`: línea ~3873 (CRON_SCHEDULE configurable, EOL/contratos/vulns), ~3891 (`0 3 * * *` purge audit_logs), ~3917 (`0 2 * * *` purge trusted_devices). Todos en `Europe/Madrid`. | **A6:** Programar reindexado RAG a `0 4 * * *` o procesar la cola cada 30 s con `*/30 * * * * *` (preferible). Sin colisión. |
| F6 | Rate limiters actuales: `/api/auth/login` (15 min, 10 fallidos), `/api/auth/sso/*` (15 min, 20), global `/api/*` (60 s, 300). | **A8/A9:** Añadir limitador específico para `/api/chat/ask*` (10/min/usuario) que opera *encima* del global. Backfill y reindex con su propio rate-limit (1/min ADMIN). |
| F7 | Vocabulario `action` de `audit_logs` (28 valores únicos, ej. `CREATE_CI`, `LINK_DOCUMENT`, `GDPR_ERASURE`). | **A6/A7/A8/A9 + B2:** Los nuevos `ASK_RAG`, `INDEX_DOC`, `REINDEX_DOC`, `UPDATE_DOC_ACL`, `RAG_BACKFILL` no colisionan. |
| F8 | `backend/src/services/systemInfoService.ts` devuelve `{components: StackComponent[], generatedAt}`. | **A1/A3:** Añadir entrada `{ name: 'Ollama', category: 'AI/ML', version: ... }`. Para versión live, llamar a `GET ${OLLAMA_BASE_URL}/api/version`. |

### 8.3 Constatación de estado

| # | Hallazgo | Implicación |
|---|---|---|
| F9 | **No existe** ninguna integración LLM previa (`grep openai|anthropic|ollama|pgvector|embedding` = vacío). | Vía libre. |
| F10 | **No existen tests automatizados** (`*.test.ts`, `*.spec.ts`, `jest.config`, `vitest.config` = 0 ficheros). | A13 mantiene verificación manual + `tsc --noEmit`. Tests automatizados quedan fuera de alcance. |
| F11 | `backend/src/index.ts` = 4.462 líneas. Tras el RAG: estimado 4.800–4.850. Umbral seguro 5.500. | No extraer a módulos en esta fase; documentar en `ARCHITECTURE.md` que si se acerca a 5.500 conviene `backend/src/modules/`. |
| F12 | Migración B1 (`20260520120000_add_document_role_acl/migration.sql`) verificada in situ: incluye los 3 campos **y el índice** `idx_documents_read_acl`. Backend NO la consume todavía (`grep readAdmin backend/src/index.ts` = vacío). | B1 ✅ completo. B2 sigue siendo necesario (consumir flags + nuevo `PATCH /api/documents/:id/acl`). |
| F13 | Sidebar actual (13 enlaces, `frontend/components/Sidebar.tsx`): no hay sección Chat/IA. | **A10:** Añadir `sidebar.assistant` → `/chat` con icono `Sparkles` o `MessageSquareText`. Visible a todos los roles autenticados. |

### 8.4 Ajustes derivados al plan

1. **A1** debe cambiar las imágenes de Postgres a `pgvector/pgvector:pg15` (dev) y `pgvector/pgvector:pg16` (prod) **además** del nuevo servicio `ollama`.
2. **A1** además debe editar `nginx/conf.d/frontend.conf` para añadir `proxy_buffering off;` en `location /api/`.
3. **A6** usa cola con tick cada 30 s en lugar de horario fijo nocturno (más responsivo y evita conflicto con los 3 cron existentes).
4. **A8** debe setear `X-Accel-Buffering: no` y `Cache-Control: no-cache` en cabeceras de la respuesta SSE.
5. **A10** crea un hook nuevo `useChatStream.ts` en `frontend/lib/`, no toca `apiFetch.ts`.
6. **A14** añade a `ARCHITECTURE.md` la nota sobre el tamaño del monolito (límite blando ~5.500 líneas; tras esto, considerar `backend/src/modules/`).

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
| 2026-05-20 | Integrados 13 hallazgos pre-flight; ajustes derivados en A1/A6/A8/A10/A14 | sesión de planificación |
| 2026-05-20 | Oleada 1 completada: A1–A5 ✅ (compose, pgvector, ragService, docParser, chunker) | sesión orquestadora |
| 2026-05-20 | Oleada 2 completada: A6 (ingestión + cron), A7 (backfill), A8 (chat + SSE), A9 (kNN+ACL+audit) | sesión orquestadora |
| 2026-05-20 | Oleada 3 completada: A10 (chat page + SSE hook + sidebar), A11 (i18n 6 idiomas), A12 (indexing badge + reindex) | sesión orquestadora |
| 2026-05-20 | Oleada 4 completada: I1 (install.sh + install.example.conf + install.conf), I2 (update.sh con --reindex) | sesión orquestadora |
| 2026-05-20 | Oleada 5 completada: A13 (verificación + 2 bugs HIGH fixed), A14 (cierre USER_MANUAL+README). Listo para PR. | sesión orquestadora |
