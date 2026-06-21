# n8n Workflows — CMDB Enterprise Platform v3.0.0

Catálogo completo de todos los workflows n8n desplegados en esta plataforma.
Para instalación y gestión de la UI de n8n, ver [ADMIN_GUIDE.md](./ADMIN_GUIDE.md).

---

## Índice

1. [Alertas CMDB](#1-alertas-cmdb)
2. [Mantenimiento del Sistema](#2-mantenimiento-del-sistema)
3. [RAG Indexing](#3-rag-indexing)
4. [Bulk Import CIs](#4-bulk-import-cis)
5. [LDAP/AD Sync](#5-ldapad-sync)
6. [Backup Automatizado](#6-backup-automatizado)
7. [Notificaciones Teams/Slack](#7-notificaciones-teamsslack)

---

## 1. Alertas CMDB

**Nombre en n8n:** `Alertas CMDB`
**Trigger:** Schedule — 1 vez/día (por defecto 08:00, configurable vía `ALERTS_SCHEDULE_CRON`)
**Sustituye:** `cron.schedule(ALERTS_SCHEDULE_CRON)` en `modules/alerts/scheduler.ts`

### Flujo

```
[Cron: ALERTS_SCHEDULE_CRON]
         │
         ▼
[HTTP GET] /api/internal/alerts/scan
  ← { shouldSend, htmlBody, subject, recipients, fingerprint, breakdown }
         │
         ├─ shouldSend = false → [No-op — no hay alertas activas]
         │
         └─ shouldSend = true
                  │
                  ▼
         [Send Email] SMTP
           To: recipients
           Subject: subject
           Body: htmlBody (HTML)
                  │
                  ▼
         [HTTP POST] /api/internal/alerts/record
           { success: true, fingerprint, recipientCount }
```

### Variables de entorno n8n necesarias

| Variable | Descripción |
|----------|-------------|
| `CMDB_BASE_URL` | p.ej. `http://cmdb-backend:3000` |
| `CMDB_SERVICE_TOKEN` | Token M2M ≥32 chars |
| `SMTP_*` | Configuración SMTP (igual que el backend) |

### Notas de seguridad

- El endpoint `/api/internal/alerts/scan` no envía el email; solo lo construye. n8n gestiona el envío real para que el log quede en n8n.
- Si el envío SMTP falla, n8n reintenta 3 veces antes de marcar el workflow como error. El endpoint `/record` solo se llama si el envío fue exitoso.
- `fingerprint` en `/record` evita duplicados si n8n ejecuta el workflow más de una vez en el mismo día (dedup en DB).

---

## 2. Mantenimiento del Sistema

**Nombre en n8n:** `Mantenimiento CMDB`
**Trigger:** Schedule — múltiples horarios (un nodo Cron por tarea)
**Sustituye:** 4 `cron.schedule(...)` eliminados de `index.ts`

### Subtareas y schedules

| Endpoint | Schedule | Variable de entorno | Default |
|----------|----------|---------------------|---------|
| `POST /api/internal/maintenance/purge-audit-logs` | 03:00 diario | `AUDIT_PURGE_CRON` | `0 3 * * *` |
| `POST /api/internal/maintenance/cleanup-trusted-devices` | 02:00 diario | `TRUSTED_DEVICE_CLEANUP_CRON` | `0 2 * * *` |
| `POST /api/internal/maintenance/dcim-power-scan` | 04:00 diario | `DCIM_POWER_CRON` | `0 4 * * *` |
| `POST /api/internal/maintenance/cleanup-bulk-staging` | cada hora | `BULK_STAGING_CLEANUP_CRON` | `0 * * * *` |

### Flujo (por subtarea)

```
[Cron: schedule]
       │
       ▼
[HTTP POST] /api/internal/maintenance/<endpoint>
  Header: X-CMDB-Service-Token: <token>
  ← { ok, deleted/reaped/alertsFound/... }
       │
       ├─ ok = true → [Log resultado]
       │
       └─ ok = false / HTTP 5xx → [Error + notificación opcional]
```

### Respuestas de cada endpoint

```
purge-audit-logs      → { ok, deleted, cutoffDate, retentionDays }
cleanup-trusted-devices → { ok, deleted }
dcim-power-scan       → { ok, alertsFound, rackIds? }
cleanup-bulk-staging  → { ok, reaped, permanentlyDeleted }
```

---

## 3. RAG Indexing

**Nombre en n8n:** `RAG Indexing`
**Trigger:** Schedule — cada 30 segundos (`RAG_QUEUE_CRON`, default `*/30 * * * * *`)
**Sustituye:** `cron.schedule('*/30 * * * * *', ...)` eliminado de `index.ts`

> **Nota:** Este workflow solo es efectivo cuando `RAG_ENABLED=true` en el backend.
> Si RAG no está habilitado, el endpoint devuelve `{ ok: true, skipped: true }` y n8n no reintenta.

### Flujo

```
[Cron: */30s]
      │
      ▼
[HTTP POST] /api/internal/rag/process-batch
  Header: X-CMDB-Service-Token: <token>
  ← { ok, durationMs }   — HTTP 200
  ← { ok:false, errors } — HTTP 207 (error parcial)
      │
      ├─ HTTP 200 { skipped:true } → [No-op]
      │
      ├─ HTTP 200 { ok:true } → [Log duración]
      │
      └─ HTTP 207 → [Log errores — n8n NO reintenta para no solapar ciclos]
```

### Lógica interna del endpoint

El endpoint llama secuencialmente a las tres funciones del pipeline RAG (inyectadas desde `index.ts`):

1. `processRagQueue()` — indexa CIs pendientes en el vector store de Ollama
2. `processBulkImportQueue()` — procesa análisis IA de lotes de importación de documentos
3. `processCIBulkImportQueue()` — analiza filas de importación masiva de CIs

Si alguna lanza excepción, el error se captura, se loguea y se incluye en la respuesta 207, pero las siguientes funciones siguen ejecutándose.

### Configuración recomendada

- **Execution timeout:** 25 segundos (menor que el intervalo de 30s para evitar solapamiento)
- **Error handling:** "Continue on Fail" activo para capturar el 207 sin abortar el workflow
- **Retry on fail:** Desactivado — el siguiente ciclo (30s) es el reintento natural

---

## 4. Bulk Import CIs

**Nombre en n8n:** `Bulk Import CIs`
**Trigger:** Webhook (`POST /webhook/bulk-import-cis`) — disparado externamente
**Propósito:** Permite a sistemas externos (scripts de inventario, herramientas ETL, pipelines CI/CD)
subir un fichero XLSX de CIs sin requerir credenciales de usuario ADMIN.

### Flujo

```
[Webhook: POST /webhook/bulk-import-cis]
  Body: multipart/form-data con campo "file" (.xlsx)
         │
         ▼
[HTTP POST] /api/internal/bulk/submit
  Header: X-CMDB-Service-Token: <token>
  Body:   multipart/form-data { file: <xlsx buffer> }
  ← { batchId, rowCount, statusUrl }
         │
         ├─ HTTP 4xx → [Respond 400 al caller con error]
         │
         └─ HTTP 201 { batchId }
                  │
                  ▼
         [Wait: 60 segundos]
                  │
                  ▼
         [Loop: Poll status]
         GET /api/internal/bulk/batches/<batchId>
         ← { status, committed, pending, errors }
                  │
                  ├─ pending > 0 → [Wait 30s → Poll again]  (max 10 iteraciones)
                  │
                  └─ pending = 0
                            │
                            ├─ errors > 0 → [Send alert: análisis con errores]
                            │
                            └─ ok → [Send email/notification: batch listo para revisión]
                                       "El lote <batchId> (N CIs) está listo para revisión
                                        en la UI: https://<FRONTEND_URL>/inventory?batch=<batchId>"
         │
         ▼
[Respond 200 al caller: { batchId, rowCount }]
```

### Formato del XLSX

El fichero debe seguir la misma estructura que la plantilla descargable desde la UI
(`GET /api/cis/bulk/template.xlsx`). Columnas obligatorias:

| Columna | Tipo | Descripción |
|---------|------|-------------|
| `name` | string | Nombre del CI (obligatorio) |
| `ci_type` | string | Tipo de CI (debe existir en maestros) |
| `location` | string | Sede/localización |
| `status` | string | `ACTIVE`, `INACTIVE`, `DECOMMISSIONED` |
| ... | ... | Ver plantilla para todas las columnas |

### Limitaciones

- Máximo `CI_BULK_MAX_ROWS` filas (default: 500) por lote
- Máximo `BULK_MAX_OPEN_BATCHES` lotes abiertos simultáneos para `n8n@cmdb.local` (default: 5)
- Tamaño máximo del fichero: 10 MB

### Ejemplo de llamada al webhook

```bash
curl -X POST "https://<N8N_URL>/webhook/bulk-import-cis" \
  -F "file=@inventario.xlsx" \
  -H "Authorization: Basic <n8n-webhook-auth>"
```

---

## 5. LDAP/AD Sync

**Nombre en n8n:** `LDAP/AD Sync`
**Trigger:** Schedule (`LDAP_SYNC_CRON`, default `0 1 * * *` — 01:00 diario)
**Condición:** Solo se ejecuta si `USE_LDAP=true` en el backend (verificado en primer paso)

### Flujo

```
[Cron: LDAP_SYNC_CRON]
         │
         ▼
[LDAP Query: Read Active Users]
  Server: LDAP_URL (desde .env del backend, replicado en n8n)
  Base DN: LDAP_BASE_DN
  Filter: (&(objectClass=person)(!(userAccountControl:1.2.840.113556.1.4.803:=2)))
  Attrs: sAMAccountName, mail, displayName, memberOf
         │
         ▼
[HTTP GET] /api/internal/users/ldap-sync-candidates
  Header: X-CMDB-Service-Token: <token>
  ← { existing: [{ email, ssoExternalId, active }], manualUsers: [email] }
         │
         ▼
[Code Node: Diff]
  Para cada usuario LDAP:
    - email = mail attribute
    - no está en manualUsers (ssoExternalId IS NULL → no tocar)
    - no existe → CREATE
    - existe + active=false → REACTIVATE
    - existe + active=true → ya OK
  Para cada usuario en existing con ssoProvider='ldap' no en LDAP:
    - → DEACTIVATE
         │
         ├─ creates[]
         ├─ reactivates[]
         └─ deactivates[]
         │
         ▼
[HTTP POST] /api/internal/users/ldap-sync
  Body: { creates, reactivates, deactivates }
  ← { created, reactivated, deactivated, errors[] }
         │
         ▼
[Log resultado + notificar si hay errores]
```

### Reglas de seguridad aplicadas en el endpoint

- Los usuarios con `sso_external_id IS NULL` (creados manualmente) **nunca se tocan**.
- Las contraseñas de usuarios LDAP creados son hashes aleatorios (no usables para login local).
- Los usuarios desactivados no se eliminan; solo se marca `active=false`.
- Todos los cambios generan un registro en `audit_logs`.

### Variables de entorno n8n requeridas

| Variable | Descripción |
|----------|-------------|
| `LDAP_URL` | `ldap://dc.ejemplo.com:389` |
| `LDAP_BIND_DN` | DN del usuario de servicio LDAP |
| `LDAP_BIND_PASSWORD` | Contraseña del bind user |
| `LDAP_BASE_DN` | Base DN para búsqueda de usuarios |
| `LDAP_SYNC_DOMAIN` | Dominio de email a sincronizar (p.ej. `empresa.com`) |

---

## 6. Backup Automatizado

**Nombre en n8n:** `Backup CMDB`
**Trigger:** Schedule (`BACKUP_CRON`, default `0 2 * * *` — 02:00 diario)
**Propósito:** `pg_dump` de la base de datos + snapshot de documentos/uploads

> Para el procedimiento completo de restauración y backups manuales,
> ver [docs/BACKUP_RESTORE_GUIDE.md](../BACKUP_RESTORE_GUIDE.md).

### Flujo

```
[Cron: BACKUP_CRON]
         │
         ▼
[HTTP POST] /api/internal/backup/trigger
  Header: X-CMDB-Service-Token: <token>
  ← { ok, backupId, dumpPath, docsPath }
         │
         ├─ ok = false → [Alert + abort]
         │
         └─ ok = true
                  │
                  ▼
         [Opcional: HTTP PUT/S3/SFTP]
           Subir dumpPath + docsPath al destino remoto
           (configurado en el nodo n8n; ver ADMIN_GUIDE.md)
                  │
                  ▼
         [HTTP POST] /api/internal/backup/record
           { backupId, success, destination, sizeMb }
                  │
                  ▼
         [Cleanup: eliminar dumps locales > BACKUP_RETENTION_DAYS]
```

### Lo que se incluye y excluye

| Incluido | Excluido |
|----------|----------|
| `pg_dump` completo de `cmdb_db` | `server.key`, `server.crt` (D-D) |
| `documents/` (uploads de usuarios) | Modelos Ollama (re-descargables) |
| `staging/` (imports en curso) | Logs de contenedores |

---

## 7. Notificaciones Teams/Slack

**Nombre en n8n:** `Notificaciones CMDB`
**Trigger:** Webhook interno — llamado desde el workflow de Alertas y otros
**Propósito:** Enrutar notificaciones a Teams y/o Slack según la configuración en DB

### Flujo

```
[Webhook interno: POST /webhook/notify]
  Body: { channel: 'teams'|'slack'|'both', subject, message, severity }
         │
         ├─ channel includes 'teams'
         │        │
         │        ▼
         │ [HTTP POST] Teams Incoming Webhook URL
         │   Body: Adaptive Card con subject + message + severity color
         │
         └─ channel includes 'slack'
                  │
                  ▼
         [Slack node] Post message to #channel
           Token: SLACK_BOT_TOKEN
           Text: `:${severity}: *${subject}*\n${message}`
```

### Configuración en la UI de administración

Los webhooks de Teams y tokens de Slack se configuran en `Configuración > Alertas > Canales`
y se almacenan en la tabla `alert_config` de la DB.

El workflow de n8n lee estos valores en tiempo de ejecución vía:
```
GET /api/internal/notify/config
← { teamsWebhookUrl, slackBotToken, slackChannel }
```

---

## Variables de entorno globales (n8n)

Todas las instancias n8n (main + workers) comparten estas variables via `.env`:

```env
CMDB_BASE_URL=http://cmdb-backend:3000
CMDB_SERVICE_TOKEN=<mínimo 32 chars, igual que en backend .env>
FRONTEND_URL=https://localhost
```

Los tokens, URLs y contraseñas específicos de cada workflow se almacenan como
**Credentials** en n8n (encriptadas con `N8N_ENCRYPTION_KEY`), no como env vars.

---

## Importar workflows en n8n

Los ficheros JSON de cada workflow están en `docs/n8n/json/`:

```bash
# Copiar al contenedor y usar la API de n8n para importar
curl -X POST "http://localhost:5678/api/v1/workflows" \
  -H "Content-Type: application/json" \
  -H "X-N8N-API-KEY: <tu-api-key>" \
  -d @docs/n8n/json/alertas-cmdb.json
```

O desde la UI de n8n: **Menu → Import from file**.

> Los ficheros JSON se generan/exportan desde la UI de n8n tras configurar
> las credenciales. No están versionados en este repo porque contienen
> referencias a IDs de credenciales específicos de cada instalación.
