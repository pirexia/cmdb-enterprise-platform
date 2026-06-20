# Plan v3.0.0 — Estado de Ejecución

## Última actualización: 2026-06-21 (UTC)
## Modelo en ejecución: Sonnet 4.6
## Commit actual: (inicio — sin commit aún)

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
- [ ] 🔄 En progreso — Iniciada: 2026-06-21
- Archivos a modificar: `docs/ARCHITECTURE.md`, `docs/ARCHITECTURE.en.md`
- Cambios: §2 Stack (Node 22, Prisma 6, +n8n/Redis/Ollama), §3 Topología (+6 contenedores), §4 Redes (+puertos), §6 Mermaid (diagrama actualizado), §11 Capacity (+n8n/redis), §12 RAG (modelo actualizado, referenciar §3)
- Bloqueos: Ninguno

### Tarea 0: Auth M2M — service token + /api/internal/*
- [ ] Pendiente
- Archivos: `backend/src/shared/serviceAuth.ts` (nuevo), `backend/src/modules/internal/router.ts` (nuevo), `nginx/conf.d/frontend.conf`, `.env.example`, `docker-compose.yml`, `docker-compose.prod.yml`

### Tarea 2: Desplegar n8n en Queue Mode
- [ ] Pendiente
- Archivos: `docker-compose.yml`, `docker-compose.prod.yml`, `nginx/conf.d/frontend.conf`, `.env.example`

### Tarea 2.5: Auditoría volumen Ollama (solo informe)
- [ ] Pendiente
- Entregable: `docs/OLLAMA_VOLUME_AUDIT.md`

### Tarea 3: Migrar alertas de node-cron a n8n
- [ ] Pendiente
- Archivos: `backend/src/modules/alerts/scheduler.ts` (eliminar cron), `backend/src/modules/internal/alerts.ts` (nuevos endpoints)
- Nota: `pipeline.ts`/`engine.ts`/`email-builder.ts` se conservan

### Tarea 3.5: Migrar los 4 crons de mantenimiento de index.ts a n8n
- [ ] Pendiente
- Crons a migrar: AuditPurgeCron (03:00), TrustedDeviceCron (02:00), DcimPowerCron (04:00), BulkCleanupCron (cada hora)
- Archivos: `backend/src/index.ts` (eliminar crons), `backend/src/modules/internal/` (endpoints batch)

### Tarea 4: Migrar queue de RAG a n8n (enfoque híbrido)
- [ ] Pendiente
- Archivos: `backend/src/index.ts` (eliminar cron */30s), `backend/src/modules/internal/rag.ts` (nuevo endpoint process-batch)

### Tarea 5: Importaciones masivas vía n8n
- [ ] Pendiente
- Workflow n8n alimenta `POST /api/cis/bulk/batches` (pipeline existente)

### Tarea 6: Sincronización LDAP/AD vía n8n
- [ ] Pendiente
- Archivos: `backend/src/modules/internal/users.ts` (nuevos endpoints CRUD), migración DB (si se añaden campos)

### Tarea 7: Backup automatizado vía n8n + BACKUP_RESTORE_GUIDE.md
- [ ] Pendiente
- Entregable: `docs/BACKUP_RESTORE_GUIDE.md`
- Nota D-D: certs excluidos del backup automatizado

### Tarea 8: Notificaciones Teams/Slack vía n8n
- [ ] Pendiente
- Archivos: migración DB (`alert_config` + `alert_rules`), `backend/src/modules/alerts/schemas.ts`, `backend/src/modules/internal/notify.ts`

### Tarea 9: Actualizar toda la documentación
- [ ] Pendiente
- Archivos: `README.md`, `README.en.md`, `docs/SYSADMIN_MANUAL.md`, `docs/SYSADMIN_MANUAL.en.md`, `docs/USER_MANUAL.md`, `docs/USER_MANUAL.en.md`, `docs/DEPLOY.md` (nuevo), `docs/RAG_HOST_PREPARATION.md`, `CLAUDE.md`, `docs/n8n/WORKFLOWS.md` (nuevo), `docs/n8n/ADMIN_GUIDE.md` (nuevo)

### Tarea 10: Despliegue limpio en main + smoke tests
- [ ] Pendiente

---

## Decisiones tomadas en ejecución (no previstas en plan)
- (vacío)

## Errores encontrados y resolución
- (vacío)

## Próxima acción al reanudar
1. Continuar con Tarea 1: actualizar ARCHITECTURE.md
2. Luego commit y pasar a Tarea 0
