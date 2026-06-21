# Plan v3.0.0 — Estado de Ejecución

## Última actualización: 2026-06-21 (UTC)
## Modelo en ejecución: Sonnet 4.6 / Opus 4.8
## Commit actual: 0f630b2 (T4 RAG queue → n8n)

## Decisiones aprobadas por el usuario
- **D-A:** Migrar alerts + RAG a n8n **Y también** los 4 crons de mantenimiento de `index.ts` (T3.5)
- **D-B:** Enfoque híbrido RAG — endpoint `/api/internal/rag/process-batch` (lógica probada, n8n solo agenda/reintenta)
- **D-C:** Bulk import n8n alimenta el pipeline existente (staging→review→commit)
- **D-D:** Excluir `server.key`/certs del backup automatizado; documentar backup manual
- **D-E:** Auth M2M vía `X-CMDB-Service-Token` + `/api/internal/*` (Tarea 0 aprobada)

## Orden de ejecución
T1 → T0 → T2 → T2.5 → T3 → T3.5 → T4 → T5 → T6 → T7 → T8 → T9 → T10

---

## Tareas

### Tarea 1: Actualizar ARCHITECTURE.md y ARCHITECTURE.en.md
- [x] ✅ COMPLETADA — Commit: 1f33b68
- §2 Stack, §3 Topología (9 contenedores), §4 Redes, §6 Mermaid, §10 Decisiones, §11 Capacity, §12 RAG — todo actualizado

### Tarea 0: Auth M2M — service token + /api/internal/*
- [x] ✅ COMPLETADA — Commit: 751ac65
- `backend/src/shared/middleware/serviceAuth.ts`, `backend/src/modules/internal/router.ts`, `nginx/conf.d/frontend.conf`, `.env.example`, `docker-compose.yml`, `docker-compose.prod.yml`

### Tarea 2: Desplegar n8n en Queue Mode
- [x] ✅ COMPLETADA — Commit: 4de1eb5
- redis + n8n-main + n8n-worker-1 + n8n-worker-2 en ambos compose; nginx `/n8n/` con auth_request

### Tarea 2.5: Auditoría volumen Ollama (solo informe)
- [x] ✅ COMPLETADA — Commit: 0459d7c
- Entregable: `docs/OLLAMA_VOLUME_AUDIT.md` — bind mount confirmado, riesgo LOW

### Tarea 3: Migrar alertas de node-cron a n8n
- [x] ✅ COMPLETADA — Commit: 76f87f0
- `backend/src/modules/alerts/scheduler.ts` → no-op; `backend/src/modules/internal/alerts.ts` (GET /scan, POST /record)

### Tarea 3.5: Migrar los 4 crons de mantenimiento de index.ts a n8n
- [x] ✅ COMPLETADA — Commit: 05b544b
- Eliminados 4 crons de `index.ts`; `backend/src/modules/internal/maintenance.ts` (4 endpoints POST)

### Tarea 4: Migrar queue de RAG a n8n (enfoque híbrido)
- [x] ✅ COMPLETADA — Commit: 0f630b2
- `backend/src/modules/internal/rag.ts` (POST /process-batch, DI pattern); cron */30s eliminado de `index.ts`

### Tarea 5: Importaciones masivas vía n8n
- [x] ✅ COMPLETADA — Commit: 3c73b09
- `backend/src/modules/internal/bulk.ts` (POST /submit + GET /batches/:id)

### Tarea 6: Sincronización LDAP/AD vía n8n
- [x] ✅ COMPLETADA — Commit: b64b4a3
- `backend/src/modules/internal/users.ts` (GET /ldap-sync-candidates + POST /ldap-sync)

### Tarea 7: Backup automatizado vía n8n + BACKUP_RESTORE_GUIDE.md
- [x] ✅ COMPLETADA — Commit: 70d11ea
- `postgresql16-client` en Dockerfile; `modules/internal/backup.ts` (trigger/record/list); `docs/BACKUP_RESTORE_GUIDE.md`

### Tarea 8: Notificaciones Teams/Slack vía n8n
- [x] ✅ COMPLETADA — Commit: 2d9ccd0
- Migración DB `20260621120000_add_notify_channels`; `schemas.ts` + `queries.ts` actualizados; `modules/internal/notify.ts`

### Tarea 9: Actualizar toda la documentación
- [x] ✅ COMPLETADA — Commit: 29d389c
- CLAUDE.md, README ×2, ARCHITECTURE.en.md, SYSADMIN_MANUAL ×2, DEPLOY.md (nuevo), docs/n8n/WORKFLOWS.md + ADMIN_GUIDE.md (nuevo), BACKUP_RESTORE_GUIDE.md

### Tarea 10: Despliegue limpio en main + smoke tests
- [ ] ⏳ PENDIENTE — Requiere acción manual del operador
- Ver `docs/DEPLOY.md` §Verificación post-despliegue para el checklist completo
- Prerequisito: ejecutar `podman-compose -f docker-compose.prod.yml up -d --build` en el servidor de producción
- Prerequisito: configurar workflows en UI n8n tras el primer arranque

---

## Decisiones tomadas en ejecución (no previstas en plan)
- (vacío)

## Errores encontrados y resolución
- (vacío)

## Estado final
**T0–T9: ✅ TODAS COMPLETADAS** (11 commits en `develop`)
**T10: ⏳ Pendiente** — despliegue en producción + smoke tests (manual)

### Checklist T10 (para el operador)
- [ ] `podman-compose -f docker-compose.prod.yml up -d --build`
- [ ] `curl -sk https://localhost/api/health` → `{"status":"ok"}`
- [ ] `podman exec cmdb-redis redis-cli -a "$REDIS_PASS" ping` → PONG
- [ ] Acceso a UI n8n en https://\<dominio\>/n8n/ con cuenta ADMIN
- [ ] Crear credencial `X-CMDB-Service-Token` en n8n UI
- [ ] Importar y activar workflows desde docs/n8n/
- [ ] Test de backup: `POST /api/internal/backup/trigger` → dump creado en BACKUP_LOCAL_PATH
- [ ] `prisma migrate deploy` aplicada (migración T8: notify_channels)
- [ ] Merge develop → main + tag v3.0.0
