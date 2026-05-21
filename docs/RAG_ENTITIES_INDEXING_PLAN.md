# Plan de implementación — RAG sobre entidades estructuradas (CIs, contratos, licencias, vulnerabilidades)

**Estado global:** 🔵 Aprobado, pendiente de inicio
**Rama de trabajo:** `claude/rag-entities-indexing`
**Destino final:** PR a `develop` (nunca a `main`)
**Servidor de producción objetivo:** `lx-gest01p.svc.int`
**Fecha del plan:** 2026-05-21
**Predecesor:** `docs/RAG_IMPLEMENTATION_PLAN.md` (PR #88, fusionado en `develop` `248c5ff`)

---

## 1. Objetivo

Ampliar el asistente IA para que responda sobre **atributos estructurados** de los CIs, contratos, licencias y vulnerabilidades, no sólo sobre el texto de ficheros adjuntos. Mantener búsqueda local (Ollama + pgvector), citaciones obligatorias, ACL por rol y compliance (OWASP, ISO 27001, NIS2, GDPR, ISO 22301).

Preguntas que pasan a ser respondibles:

- *"¿Qué servidores tienen criticidad ALTA en producción?"*
- *"¿Qué contratos vencen el próximo trimestre con Dell?"*
- *"¿Cuántas licencias de Microsoft 365 tenemos asignadas a la sede de Barcelona?"*
- *"¿Qué CIs dependen de `srv-db-prod-01`?"*
- *"¿Qué vulnerabilidades críticas afectan a los servidores de producción?"*

---

## 2. Decisiones cerradas (sesión de planificación 2026-05-21)

| # | Decisión | Resolución |
|---|---|---|
| 1 | Indexar vulnerabilidades | ✅ Sí. Abierto a `VIEWER` también (mismo nivel que CIs/contratos/licencias) |
| 2 | `LicenseUser` (DNI, email) | ✅ Incluir **agregado y sin PII**: contadores y desglose por sede/centro (sin nombres, DNIs ni emails) |
| 3 | Chips de filtro en el frontend | ✅ Mantener "Documentos", añadir "CIs", "Contratos", "Licencias", "Vulnerabilidades" |
| 4 | Sincronización | ✅ Hooks en endpoints API (POST/PUT/PATCH/DELETE). Sin triggers en BD ni cron de reconciliación 24 h |
| 5 | Esquema BD | ✅ Opción C: extender `rag_chunks` con `entity_type` + `entity_id`, `document_id` NULLABLE |
| 6 | Reserva hardware | ✅ Documentar punto de inflexión a 50k CIs; dejar ganchos para escalado horizontal de Ollama |

---

## 3. Alcance — qué se indexa y qué no

| Entidad | Indexar | Notas |
|---|---|---|
| `CI` + `HardwareCI`/`SoftwareCI` | ✅ | Núcleo. Atributos completos + criticidad + entorno + ubicación |
| `CIRelation` | ✅ embebida | Renderizada como párrafo "Relaciones:" en el doc sintético del CI origen |
| `Contract` | ✅ | Número, vendor, fechas, alcance, importe, CIs asociados |
| `License` | ✅ | Vendor, tipo, fechas, contadores agregados de usuarios (sin PII) |
| `Vulnerability` | ✅ | CVE, score, CI afectado, fecha de descubrimiento. **Visible a todos los roles** |
| `LicenseUser` (DNI, email) | ❌ como chunk propio | Sólo cuento agregado en el chunk del License. Decisión nº 2 |
| Master data (`CIType`, `Branch`, `Location`, `CostCenter`) | ❌ | Se incluyen como atributos textuales dentro del CI; no como chunks aislados |
| `AuditLog` | ❌ | Ya existe `query_hash` SHA-256; no aporta búsqueda semántica |
| `User` | ❌ | PII pura. GDPR Art.5 minimización |

---

## 4. Análisis de dimensionamiento y hardware

### 4.1 Carga esperada (CMDB típico)

| Entidad | Filas | Chunks/fila | Vectores |
|---|---|---|---|
| CIs | 500–5.000 | 1–2 | 500–10.000 |
| Contratos | 50–500 | 1 | 50–500 |
| Licencias | 20–200 | 1 | 20–200 |
| Vulnerabilidades | 100–2.000 | 1 | 100–2.000 |
| **Total nuevo** | | | **~700–12.700** |

### 4.2 Coste vs VM actual (`lx-gest01p`: 12 vCPU AMX, 32 GiB RAM, 150 GB)

| Recurso | Impacto | Veredicto |
|---|---|---|
| Disco | +3–50 MB vectores + ~10 MB HNSW overhead | Despreciable (queda ~149 GB libres) |
| RAM en consulta | HNSW en memoria: ~150 MB | Sin presión |
| Backfill inicial | 12.000 × 50 ms (bge-m3 sobre AMX) ≈ 10 min one-time | Aceptable |
| Embed runtime | ~50 ms por UPDATE async | Imperceptible |
| kNN latencia | <50 ms sobre 20–30k chunks | Sin tuning |
| Chat model | Sin cambio (qwen2.5:7b: 10–18 s respuesta completa) | Sin cambio |

**Conclusión**: el hardware actual cubre el escenario hasta ~10× la carga típica. Ninguna ampliación necesaria.

### 4.3 Margen para gran cuenta (>50.000 CIs) — decisión nº 6

Documentado como umbral de revisión, no como bloqueante:

| Indicador | Umbral | Acción recomendada |
|---|---|---|
| Total `rag_chunks` | >300.000 | Subir `ef_search` o segmentar índice por `entity_type` (HNSW partial) |
| Latencia kNN | >200 ms p95 | Mover Ollama a segunda VM o GPU; aumentar `OLLAMA_NUM_PARALLEL` |
| RAM Postgres | >80 % de la VM | Subir RAM o split de BD relacional vs. vector store |
| Backfill > 30 min | Cualquiera | Paralelizar workers de embed (envar `RAG_EMBED_WORKERS`, hoy implícito = 1) |

Se añade sección §20 al `SYSADMIN_MANUAL.md` con estos umbrales y procedimientos de escalado.

---

## 5. Cambios en BD

### 5.1 Migración `20260521120000_rag_entity_chunks`

```sql
-- Extender rag_chunks para soportar entidades no-documento
ALTER TABLE "rag_chunks" ALTER COLUMN "document_id" DROP NOT NULL;
ALTER TABLE "rag_chunks"
  ADD COLUMN IF NOT EXISTS "entity_type" text NOT NULL DEFAULT 'document'
    CHECK ("entity_type" IN ('document','ci','contract','license','vulnerability')),
  ADD COLUMN IF NOT EXISTS "entity_id"   uuid;
UPDATE "rag_chunks" SET "entity_id" = "document_id" WHERE "entity_id" IS NULL;
ALTER TABLE "rag_chunks" ALTER COLUMN "entity_id" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_rag_chunks_entity"
  ON "rag_chunks"("entity_type", "entity_id");

-- Estado de indexación por entidad (espejo de rag_document_index)
CREATE TABLE IF NOT EXISTS "rag_entity_index" (
  "id"          uuid        NOT NULL DEFAULT gen_random_uuid(),
  "entity_type" text        NOT NULL
    CHECK ("entity_type" IN ('ci','contract','license','vulnerability')),
  "entity_id"   uuid        NOT NULL,
  "status"      text        NOT NULL DEFAULT 'PENDING'
    CHECK ("status" IN ('PENDING','INDEXING','READY','ERROR')),
  "error_message" text,
  "chunk_count" integer     NOT NULL DEFAULT 0,
  "indexed_at"  timestamptz,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "rag_entity_index_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "rag_entity_index_unique" UNIQUE ("entity_type","entity_id")
);
CREATE INDEX IF NOT EXISTS "idx_rag_entity_index_status" ON "rag_entity_index"("status");
```

### 5.2 Compatibilidad con datos existentes

- Filas existentes de `rag_chunks` reciben `entity_type='document'` y `entity_id=document_id` automáticamente.
- `rag_document_index` se mantiene intacto (sigue rigiendo el ciclo de documentos).
- `ragSearchChunks` se amplía para hacer JOIN condicional por `entity_type`.

---

## 6. Serializador de entidades (`backend/src/services/entitySerializer.ts`)

Funciones puras que convierten un registro a texto plano (~400–1500 tokens). Mismo contrato que devuelve `ParseResult` para reaprovechar `chunkSections`.

```typescript
export async function serializeCI(ciId: string): Promise<ParseResult>;
export async function serializeContract(id: string): Promise<ParseResult>;
export async function serializeLicense(id: string): Promise<ParseResult>;
export async function serializeVulnerability(id: string): Promise<ParseResult>;
```

Ejemplo de salida (`serializeCI`):

```
CI: srv-db-prod-01
Slug: srv-db-prod-01
Tipo: Servidor (Hardware)
Estado: Activo
Criticidad: ALTA
Entorno: PRODUCCIÓN
Ubicación: Datacenter Madrid, sala A1, rack 12
Sede: Sede Central Madrid
Centro de coste: IT-INFRA-001
Descripción: Servidor primario de la BD de licencias.

Atributos hardware:
  Marca: Dell
  Modelo: PowerEdge R750
  Número de serie: 7XYZ123
  CPU: 2x Intel Xeon Gold 6336Y (24 cores)
  RAM: 256 GB
  Disco: 4x 1.92 TB NVMe RAID-10
  Sistema operativo: Red Hat Enterprise Linux 9.2

Relaciones:
  - Aloja a: app-licensing (HOSTS)
  - Depende de: switch-core-01 (NETWORK_DEPENDS_ON)
  - Conectado a: san-storage-02 (STORAGE)

Contratos asociados: CONT-2024-0089 (Dell ProSupport hasta 2028-12-31)
Documentos asociados: 3
```

Reglas anti-leak PII (decisión nº 2):
- `LicenseUser` agregado: `"licencia con 12 usuarios asignados, 8 en Sede Madrid, 4 en Sede Barcelona"`
- Sin DNI, sin email, sin nombre
- Si el campo `License.notes` contiene PII (texto libre del usuario), se incluye literal — responsabilidad del operador

---

## 7. ACL en `ragSearchChunks`

| `entity_type` | Filtro SQL |
|---|---|
| `document` | `JOIN documents root ... WHERE root.read_<role> = true` (existente) |
| `ci` / `contract` / `license` / `vulnerability` | Sin filtro adicional — cualquier usuario autenticado los ve hoy en la UI |

Implementación con `UNION ALL` separado por tipo, o con `WHERE entity_type IN (...) AND (entity_type != 'document' OR <ACL doc>)`. Decisión final en E1c según legibilidad del SQL.

Si en una versión futura se añade ACL por CI (per-CI o por sede), se replica aquí — está documentado como deuda en el `rag-dpia.md`.

---

## 8. Sincronización por hooks (decisión nº 4)

Patrón idéntico a `queueDocumentForIndexing(docId, version)`:

```typescript
async function queueEntityForIndexing(
  entityType: 'ci'|'contract'|'license'|'vulnerability',
  entityId: string
): Promise<void>;
```

Endpoints donde se inyecta el hook (sin tocar response):

| Entidad | Endpoints con hook |
|---|---|
| CI | `POST /api/cis`, `PATCH /api/cis/:id`, `DELETE /api/cis/:id`, `POST /api/cis/:id/relations`, `DELETE /api/cis/:id/relations/:rid` (re-indexa origen+destino), `POST /api/cis/:id/documents` (re-indexa CI) |
| Contract | `POST /api/contracts`, `PATCH /api/contracts/:id`, `DELETE /api/contracts/:id`, asociaciones CI/doc |
| License | `POST /api/licenses`, `PATCH /api/licenses/:id`, `DELETE /api/licenses/:id`, `POST/DELETE /api/licenses/:id/users` (re-indexa license, agregados) |
| Vulnerability | `POST /api/vulnerabilities`, `PATCH`, `DELETE`, `POST /api/cis/:id/vulnerabilities` |

DELETE elimina vía `DELETE FROM rag_chunks WHERE entity_type=$1 AND entity_id=$2;` + DELETE espejo en `rag_entity_index`.

---

## 9. Worker `processRagQueue` — extensión

El worker actual de 30 s pasa a procesar **ambas colas** (`rag_document_index` y `rag_entity_index`) con prioridad:

1. Documents primero (preserva latencia de upload)
2. Vulnerabilidades (volumen contenido, crítico para seguridad)
3. Contratos / Licencias
4. CIs (mayor volumen, menos urgente)

Cada ciclo: hasta 3 ítems por tabla → 6 por tick. Sin colisión con los 3 cron existentes.

---

## 10. Endpoint de backfill — extensión

```
POST /api/admin/rag/backfill
  body: { entityTypes?: Array<'document'|'ci'|'contract'|'license'|'vulnerability'> }
  - omitido → todas las entidades (comportamiento de hoy: solo 'document')
  - explícito → sólo las pedidas
audit log: 'RAG_BACKFILL_ENTITIES' con detalle de qué se queueó
rate limit: ragBackfillLimiter (1/min) existente
```

Idempotente: UPSERT a PENDING en `rag_entity_index` / `rag_document_index`.

---

## 11. Frontend — decisión nº 3 (chips + iconos)

`frontend/app/chat/page.tsx`:

- 5 chips de filtro en cabecera: `Documentos`, `CIs`, `Contratos`, `Licencias`, `Vulnerabilidades`. Multi-select.
- El estado se pasa como `entityTypes: string[]` en el body del POST a `/api/chat/ask` y `/api/chat/ask/stream`.
- Backend filtra el kNN por `entity_type IN (...)` antes del ORDER BY.
- Citaciones en el thread muestran icono según tipo: `FileText` (doc), `Server` (CI), `FileSignature` (contrato), `Key` (licencia), `ShieldAlert` (vuln).
- Deep-link en citación:
  - document → `/documents/:id`
  - ci → `/inventory/:id`
  - contract → `/contracts/:id`
  - license → `/licenses/:id`
  - vulnerability → `/vulnerabilities` (filtrado por CVE)

i18n: 8 nuevas claves (`chat.filter.documents`, `chat.filter.cis`, etc.) en los 6 idiomas.

---

## 12. Oleadas y agentes

> Misma convención que el plan anterior: agentes no ejecutan git; orquestador commitea al final de cada oleada.

### E0 — Plan y DPIA delta (manual, 1 paso)

- [ ] **E0** · Actualizar `docs/security/rag-dpia.md` con:
  - Nueva actividad de tratamiento: indexación de CIs/contratos/licencias/vulnerabilidades
  - Decisión sobre `LicenseUser` (agregado, no PII)
  - Vector de amenaza nuevo: "Inferencia de inventario crítico vía chunks de vulnerabilidades" + mitigación (mismo system prompt)
  - Retención: igual que `rag_chunks` actual (cascada de borrado por entidad)

### E1 — Cimientos (3 paralelos)

- [ ] **E1a** · Migración `20260521120000_rag_entity_chunks` + actualizar `schema.prisma` (`RagChunk.documentId` opcional, nuevos campos, modelo `RagEntityIndex`).
- [ ] **E1b** · `backend/src/services/entitySerializer.ts` con 4 serializadores. Cobertura PII verificada (no DNI/email/nombre).
- [ ] **E1c** · Ampliar `ragSearchChunks` en `backend/src/index.ts`: nuevo parámetro `entityTypes?: string[]`, ACL ramificada por tipo, mismo system prompt.

### E2 — Hooks de ingesta (4 paralelos, uno por dominio)

- [ ] **E2a** · `queueEntityForIndexing('ci', …)` en todos los endpoints CRUD de CIs + relations.
- [ ] **E2b** · Hooks en contratos.
- [ ] **E2c** · Hooks en licencias + LicenseUser (re-indexa license padre).
- [ ] **E2d** · Hooks en vulnerabilidades.

Cada agente añade tests de humo manuales en `docs/RAG_VERIFICATION_A13.md` (cómo verificar el hook tras un POST).

### E3 — Worker y backfill (2 paralelos)

- [ ] **E3a** · Extender `processRagQueue` para procesar `rag_entity_index` con prioridad documents > vulns > contratos/licencias > CIs. Audit logs `INDEX_CI`, `INDEX_CONTRACT`, `INDEX_LICENSE`, `INDEX_VULN`.
- [ ] **E3b** · Endpoint `POST /api/admin/rag/backfill` con `entityTypes?` opcional. Audit log `RAG_BACKFILL_ENTITIES`.

### E4 — Frontend (3 paralelos)

- [ ] **E4a** · Chips multi-select en `/chat`, persistencia en sessionStorage. Body POST extendido con `entityTypes`.
- [ ] **E4b** · Citaciones con icono por tipo + deep-link al detalle de la entidad.
- [ ] **E4c** · 8 nuevas claves i18n en los 6 idiomas + actualización del `SYSADMIN_MANUAL.md` §19 (umbrales de escalado, decisión nº 6) y `USER_MANUAL.md` §23 (filtros nuevos).

### E5 — Verificación y cierre (2 paralelos)

- [ ] **E5a** · Verificación end-to-end (A13-bis): `tsc`, `bash -n`, seguridad (a–i), smoke (subir CI, preguntar, validar citación, comprobar audit log).
- [ ] **E5b** · Cierre: PR a `develop` con resumen completo + actualización del README (sección "Asistente IA" para mencionar entidades, no solo docs).

---

## 13. Auditoría — nuevos `action`

Compatible con el vocabulario existente (28 valores). Añade:

- `INDEX_CI`, `INDEX_CONTRACT`, `INDEX_LICENSE`, `INDEX_VULN`
- `REINDEX_ENTITY` (botón manual; no incluido en E0 si no aporta valor)
- `RAG_BACKFILL_ENTITIES`

`ASK_RAG` (existente) sigue capturando consultas en chat; no cambia.

---

## 14. Fuera de alcance

- ACL por CI / por sede (deuda).
- Triggers en BD (se descarta a favor de hooks en API, decisión nº 4).
- Búsqueda híbrida (BM25 + kNN). Hoy sólo semántica; si los usuarios piden búsqueda por igualdad estricta, va a una siguiente iteración.
- Reindex visual por entidad (botón en cada página). Si surge necesidad, se añade en E4.
- OCR de PDFs escaneados (seguimos sin OCR — limitación documentada).

---

## 15. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Hook falla silencioso → vector store desactualizado | Mismo patrón que docs: `queueEntityForIndexing` es `void async`, errores logueados. Detección con vista `rag_entity_index WHERE updated_at < entities.updated_at` (consulta diagnóstica en SYSADMIN §19) |
| Backfill inicial bloquea worker → docs nuevos esperan | Worker procesa documents primero (prioridad fija) |
| Hallucination más probable con números/fechas | Reforzar regla 6 del system prompt: *"No inventes ni extrapoles fechas, números, versiones, importes o identificadores que no aparezcan literalmente en los fragmentos."* Cambio en `ragService.ts` |
| `entitySerializer` revela campos sensibles futuros | Allowlist explícita de campos en el serializador. Cualquier campo nuevo se añade por elección, no por defecto |
| Búsqueda mezclada satura chunks con CIs y oculta documentos relevantes | Chips de filtro + boost opcional por tipo en `ragSearchChunks` (deuda menor) |

---

## 16. Compliance — deltas

| Marco | Delta |
|---|---|
| **GDPR** | Confirma minimización (DNI/email de LicenseUser fuera). DPIA actualizada en E0 |
| **ISO 27001 A.8.15** | Nuevos eventos auditados (INDEX_CI/CONTRACT/LICENSE/VULN, RAG_BACKFILL_ENTITIES) |
| **NIS2 Art.21** | Vulnerabilidades en chat: facilita gestión de riesgos. Pre-requisito: la BD de vulns NO contiene credenciales/PoC |
| **ISO 22301** | Sin impacto en RTO (la VM cubre, backfill <15 min para 12k vectores) |
| **OWASP A01** | El JOIN ramificado por `entity_type` mantiene ACL pre-filter como hoy |

---

## 17. Entregable

1. PR contra `develop` con todos los cambios anteriores.
2. Actualización de `SYSADMIN_MANUAL.md` §19 con umbrales de escalado y procedimiento de backfill selectivo.
3. Actualización de `USER_MANUAL.md` §23 con la sección de filtros del chat.
4. `docs/security/rag-dpia.md` actualizada (E0).

---

## 18. Incidencias

| Fecha | Agente | Bloqueo | Resolución |
|---|---|---|---|
| _sin incidencias_ | — | — | — |

---

## 19. Historial de cambios del plan

| Fecha | Cambio | Autor |
|---|---|---|
| 2026-05-21 | Creación del documento. Decisiones 1–6 confirmadas por el usuario. | sesión de planificación |
