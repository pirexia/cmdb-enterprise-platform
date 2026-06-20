# Plan v2.9.2 — RAG/AI Quality Improvements

**Rama:** `feature/v2.9.2-ai-rag` → `develop`  
**Estado:** En progreso  
**Inicio:** 2026-06-20

---

## Contexto

El módulo RAG/AI Assistant (Asistente de IA) fue integrado en v2.7.0 y extendido progresivamente hasta v2.9.1. Esta versión aborda deuda técnica acumulada en calidad de indexado, cobertura de entidades, modelo de chat y estructura del código.

**Alcance aprobado:**
- T-C: Fix calidad OCR (disparador por densidad, DPI 300)
- T-A: Indexar Planes de Decomisado en RAG
- T-B: Extraer `modules/ai/` (Strangler Fig)
- T-D: Actualizar modelo chat a qwen3:latest
- T-E: Cascada re-index cuando se renombra un maestro
- T-F: Verificación final — todos los CIs y entidades con estado READY

---

## Arquitectura RAG actual (pre-v2.9.2)

```
index.ts (~900 líneas de RAG)
  ├── RagEntityType: 'ci'|'contract'|'license'|'vulnerability'
  ├── queueEntityForIndexing / purgeEntityFromRag
  ├── processRagQueue (worker, cron 30s)
  ├── ragSearchChunks (kNN + ACL)
  ├── logAskRag
  └── 6 endpoints chat: sessions CRUD + /ask + /ask/stream + /admin/rag/backfill

services/
  ├── ragService.ts     — Ollama client (embed, chat, stream, prompt)
  ├── chunker.ts        — semantic chunker (800 tok, 120 overlap)
  ├── docParser.ts      — PDF/DOCX/XLSX/CSV parser + OCR Tesseract
  └── entitySerializer.ts — CI/contract/license/vulnerability → text + PII scrub

Modelos Ollama:
  ├── bge-m3:latest     — embedding 1024d, multilingual, 1.2 GB (INMUTABLE)
  └── qwen3:latest      — chat LLM, 8B, 5.2 GB (nuevo en v2.9.2)
```

**Gaps identificados:**
1. OCR solo activa cuando PDF totalmente vacío (bug `docParser.ts:181`)
2. DecommissionPlan no se indexa en RAG
3. RAG/AI vive en `index.ts` en lugar de `modules/ai/`
4. Modelo chat era `qwen2.5:7b-instruct-q4_K_M` (sin actualizar)
5. Renombrar un maestro (Location, Branch, etc.) no re-indexa los CIs afectados

---

## PRs del plan

| PR | Bloque | Estado |
|----|--------|--------|
| PR-1 | T-D: Swap model → qwen3:latest + think:false | ✅ Completado |
| PR-2 | T-C: Fix OCR calidad (densidad + DPI 300) | ⏳ Pendiente |
| PR-3 | T-A: Index DecommissionPlan | ⏳ Pendiente |
| PR-4 | T-E: Cascada re-index maestros | ⏳ Pendiente |
| PR-5 | T-B: Extraer modules/ai/ | ⏳ Pendiente |
| T-F | Verificación final 200+ CIs READY | ⏳ Pendiente |
| T5 | Deploy limpio a main | ⏳ Pendiente — requiere OK explícito |

---

## PR-1 · T-D — Swap chat model → qwen3:latest

**Archivos modificados:**
- `backend/src/services/ragService.ts`
- `docker-compose.prod.yml`
- `docker-compose.yml`
- `.env` (RAG_CHAT_MODEL=qwen3:latest)

**Cambios:**
1. Pull `qwen3:latest` (5.2 GB) via container temporal en red `cmdb-public`
2. Default `RAG_CHAT_MODEL` cambiado de `qwen2.5:7b-instruct-q4_K_M` → `qwen3:latest`
3. Parámetro `think: RAG_CHAT_THINK` añadido a ambas llamadas Ollama API (chat + stream)
4. `RAG_CHAT_THINK=false` por defecto (env-configurable) — suprime el modo thinking de qwen3
5. Función `stripThinkingBlocks()` como red de seguridad en respuesta no-streaming
6. Smoke test: modelo correcto, sin bloques `<think>`, citaciones correctas

**Rendimiento CPU (AMX):**
- Cold load: ~41s (primer request, carga del modelo 5.2 GB en RAM)
- Warm: ~10-20s (modelo en memoria, OLLAMA_KEEP_ALIVE=-1)
- Embedding: sin cambios (bge-m3 inmutable)

---

## PR-2 · T-C — Fix OCR quality

### Problema raíz
`docParser.ts:181`: OCR solo activa cuando `!text.trim()` (PDF completamente vacío).
PDFs escaneados con cualquier texto embebido (marca de agua, cabecera) omiten OCR → chunks de baja calidad.

### Solución
- Trigger OCR por **densidad de texto** en lugar de vacío total
- Umbral: < 0.5 caracteres/página (configurable via `OCR_MIN_CHARS_PER_PAGE`)
- `OCR_DPI` default: 150 → 300
- Superficie de error en admin: endpoint para ver documentos con `status='ERROR'`
- Re-backfill de documentos afectados

---

## PR-3 · T-A — Index DecommissionPlan

### Entidades a serializar
```
DecommissionPlan {
  id, name, status, systemCiId (con nombre), completedAt
  cis: [{ ci.name, scheduledDate, notes, depth }]  // PII scrub en notes
  documents: count
  contracts: count
  licenses: count
}
```

### Cambios
1. `serializeDecommission(planId)` en `entitySerializer.ts`
2. `RagEntityType` → `'ci'|'contract'|'license'|'vulnerability'|'decommission'`
3. Queue/purge/worker/backfill/search con caso `'decommission'`
4. Wiring en `modules/decommission/router.ts`
5. Frontend: chip filtro + deep-link + i18n ×6

---

## PR-4 · T-E — Cascada re-index maestros

### Maestros que afectan texto serializado de CIs
- Location (nombre)
- Branch (nombre)
- CostCenter (nombre)
- Manufacturer (nombre)
- Model (nombre)
- CIType (nombre)

### Cambios
- Helper `reindexCIsByMaster(masterType, masterId)` en módulo masters
- Callback `queueEntityForIndexing('ci', ciId)` por cada CI afectado tras PATCH de maestro
- Presupuesto por tick configurable (`RAG_CI_BUDGET_PER_TICK`)

---

## PR-5 · T-B — Extraer modules/ai/

### Estructura destino
```
backend/src/modules/ai/
  ├── router.ts        — chat sessions + ask + ask/stream + admin/rag/backfill
  ├── schemas.ts       — ChatAskSchema, ChatSessionCreateSchema
  ├── queries.ts       — ragSearchChunks, queueEntityForIndexing, purgeEntityFromRag,
  │                       processRagQueue, logAskRag
  ├── middleware.ts    — chatAskLimiter, ragBackfillLimiter
  └── audit.ts
```

Services permanecen en `services/` (compartidos: docParser, entitySerializer, ragService, chunker).

**Constraint:** Movimiento puro, 0 cambios de comportamiento. `differential-review` obligatorio sobre ruta ACL del retrieval.

---

## T-F — Verificación final

```sql
SELECT entity_type, status, COUNT(*) as n
FROM rag_entity_index
GROUP BY entity_type, status
ORDER BY entity_type, status;
```

Criterio de éxito: todos los CIs `READY`, 0 `ERROR` sin justificación.

---

## Definition of Done (v2.9.2)

- [ ] `tsc --noEmit` sin errores nuevos
- [ ] `curl -sk https://localhost/api/health` → `{"status":"ok"}`
- [ ] `/api/chat/ask` → modelo `qwen3:latest`, sin bloques `<think>`
- [ ] PDFs escaneados con texto embebido activan OCR por densidad
- [ ] Plans de Decomisado aparecen como fuente en el chat
- [ ] Renombrar maestro → CIs afectados re-indexados
- [ ] `modules/ai/` existe, `index.ts` sin código RAG/chat
- [ ] Todos los CIs en `rag_entity_index` con `status='READY'`
- [ ] Docs actualizadas (USER_MANUAL, SYSADMIN, ARCHITECTURE)
- [ ] PR por bloque, differential-review en PR-5 (ACL path)
- [ ] Deploy limpio con OK explícito del usuario
