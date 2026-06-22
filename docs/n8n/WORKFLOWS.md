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
| `CMDB_BASE_URL` | `http://backend:3000` (nombre de servicio compose en prod; `cmdb-backend` es solo el contenedor de **dev**) |
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

> **Retención:** este workflow genera ~2.880 ejecuciones/día, casi todas no-ops. La instancia está
> configurada para **no persistir ejecuciones exitosas** (solo los fallos, 7 días). El rastro durable
> de qué se indexó vive en `audit_logs` como filas `INDEX_BATCH`. Ver
> [ADMIN_GUIDE.md § Retención de ejecuciones](./ADMIN_GUIDE.md#retención-de-ejecuciones).

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

**Nombre en n8n:** `Notificaciones CMDB`  ·  **Fichero:** `docs/n8n/json/notificaciones-cmdb.json`
**Trigger:** Webhook `POST /webhook/notify` — responde **al instante** (modo `onReceived`); relay fire-and-forget, el llamante no espera la entrega
**Propósito:** Enrutar una notificación a Teams y/o Slack según la configuración guardada en CMDB

### Flujo (implementación entregada)

```
[Webhook POST /webhook/notify]   ← responde 200 al instante (onReceived)
  Body: { channel: 'teams'|'slack'|'both', subject, message, severity }
         │
         ▼
[HTTP GET] http://backend:3000/api/internal/notify/config   (X-CMDB-Service-Token)
  ← { teamsWebhookUrl, slackBotToken, slackChannel }
         │
         ├─▶ [IF Teams?]  channel ∈ {teams,both}  Y  teamsWebhookUrl definido
         │        └─ true → [HTTP POST teamsWebhookUrl]  MessageCard (themeColor según severity)
         │
         └─▶ [IF Slack?]  channel ∈ {slack,both}  Y  slackBotToken definido
                  └─ true → [HTTP POST slack.com/api/chat.postMessage]  Authorization: Bearer <slackBotToken>
```

> **Dos gates IF independientes** (no un Switch de 3 salidas): así `channel:'both'` activa ambos canales de forma natural, y si falta la URL/token de un canal su gate da *false* y se omite (no se hace POST a `null`). Los nodos *Send* llevan `onError: continueRegularOutput` para que el fallo de un canal no aborte el otro.

### Configuración en la UI de administración

El webhook de Teams, el token de Slack y el canal se configuran en **Configuración → Alertas → Canales de notificación** (sección de UI añadida en v3.0.1) y se guardan en `alert_config`. El workflow los lee en ejecución vía `GET /api/internal/notify/config`.

> **Seguridad:** ese endpoint M2M devuelve los secretos a n8n, pero el endpoint **ADMIN** `GET /api/alerts/config` nunca los expone al navegador — solo `teamsConfigured`/`slackConfigured` (booleanos) + `slackChannel`. El campo del token en la UI es *write-only*.

---

## Variables de entorno globales (n8n)

Todas las instancias n8n (main + workers) comparten estas variables via `.env`:

```env
CMDB_BASE_URL=http://backend:3000   # servicio compose (prod). En dev el contenedor es "cmdb-backend".
CMDB_SERVICE_TOKEN=<mínimo 32 chars, igual que en backend .env>
FRONTEND_URL=https://localhost
```

> Los JSON entregados **hardcodean** `http://backend:3000` en las URLs de los nodos HTTP (no usan `CMDB_BASE_URL`), de modo que importan y funcionan sin variables extra. Si prefieres parametrizar, sustituye la URL por `={{ $env.CMDB_BASE_URL }}/api/internal/...`.

Los tokens, URLs y contraseñas específicos de cada workflow se almacenan como
**Credentials** en n8n (encriptadas con `N8N_ENCRYPTION_KEY`), no como env vars.

---

## Instalación y administración de los workflows

Los 7 workflows están versionados como **JSON importables** en `docs/n8n/json/`. Se entregan **sin IDs de credenciales** (para que el selector de credencial sea elegible al importar) y con las URLs internas apuntando a `http://backend:3000`.

| Workflow | Fichero | Trigger | Qué hace |
|----------|---------|---------|----------|
| Alertas CMDB | `alertas-cmdb.json` | Cron 08:00 | Escanea EOL/EOS/garantía/contratos/vulns/licencias → email + registra el run |
| Mantenimiento CMDB | `mantenimiento-cmdb.json` | 4 crons (03/02/04/horario) | Purga audit, limpia trusted devices, scan potencia DCIM, limpia staging |
| RAG Indexing | `rag-indexing.json` | Cada 30 s | Procesa cola de indexado RAG + análisis IA de importaciones |
| Bulk Import CIs | `bulk-import-cis.json` | Webhook | Recibe XLSX → crea batch de importación de CIs |
| LDAP/AD Sync | `ldap-ad-sync.json` | Cron 01:00 | Sincroniza usuarios del directorio (crea / reactiva / desactiva) |
| Backup CMDB | `backup-cmdb.json` | Cron 02:00 | `pg_dump` + `tar` de documentos → registra en audit |
| Notificaciones CMDB | `notificaciones-cmdb.json` | Webhook | Relay a Teams / Slack |

### Paso 0 — Credencial M2M (una sola vez)

Casi todos los nodos HTTP llaman a `/api/internal/*`, protegido con `X-CMDB-Service-Token`. Crea la credencial una vez y reutilízala en todos los workflows:

1. **Settings → Credentials → Add credential → "Header Auth"**
2. **Name:** `X-CMDB-Service-Token`  ·  **Value:** el valor de `CMDB_SERVICE_TOKEN` del `.env` del backend
3. Guárdala como **`CMDB Service Token`**

### Paso 1 — Importar

UI de n8n: **menú (⋮ arriba a la derecha) → Import from File →** selecciona el `.json`.
(Alternativa por API: `POST http://localhost:5678/api/v1/workflows` con cabecera `X-N8N-API-KEY` y `-d @<fichero>.json`.)

### Paso 2 — Asignar credenciales (nodos marcados con ⚠️ tras importar)

| Workflow | Credenciales a seleccionar |
|----------|----------------------------|
| Todos | **CMDB Service Token** (Header Auth) en cada nodo HTTP a `/api/internal/*` |
| Alertas CMDB | + credencial **SMTP** en `Send Email` y ajustar `fromEmail` |
| LDAP/AD Sync | + credencial **LDAP** en `LDAP Search` y poner `baseDN` / `filter` / `attributes` reales |
| Notificaciones / Backup | solo CMDB Service Token (Teams/Slack y el destino remoto se leen en runtime o se añaden aparte) |

### Paso 3 — Verificar y activar (¡en este orden!)

1. **Execute workflow** (test manual) e inspecciona la salida de cada nodo.
2. Para webhooks (Bulk, Notificaciones): pulsa *Listen for test event* y lanza un POST de prueba.
3. **Solo cuando el test pase**, activa el toggle del workflow. Validar limpio ≠ funcionar: comprueba la salida real antes de activar.
4. La **zona horaria** de los Schedule sale de *Workflow Settings* (los JSON ya traen `Europe/Madrid`).

### Administración diaria

- **Activar / Desactivar:** toggle arriba a la derecha. Un workflow inactivo no dispara su Schedule ni registra su Webhook de producción.
- **Historial:** pestaña **Executions** (por workflow o global); filtra por *success* / *error*.
- **Reintentos:** `Send Email` (Alertas) reintenta 3×; el resto no reintenta (el siguiente ciclo del cron es el reintento natural). RAG y LDAP usan `onError: continueRegularOutput` para tolerar respuestas `207` (error parcial) sin abortar.
- **Credenciales:** centralizadas en Settings → Credentials, cifradas con `N8N_ENCRYPTION_KEY` ⚠️ (irrecuperables si se pierde la clave).
- **Hostname interno:** los JSON usan `http://backend:3000` (servicio compose, válido en prod). En **dev** el contenedor es `cmdb-backend`.

### Extensiones opcionales (no incluidas en el JSON base)

Los JSON son la **línea base funcional**; las secciones 1-7 describen el diseño completo, del que puedes añadir:
- **Alertas:** registrar también runs `SKIPPED`/`ALL_CLEAR` (segunda rama del IF → `POST /alerts/record`).
- **Bulk Import:** polling con `GET /bulk/batches/:id` + aviso al operador; **proteger el webhook** con Basic/Header Auth antes de exponerlo fuera de la red interna.
- **Backup:** nodo de subida remota (S3/SFTP) entre `Trigger backup` y `Record backup` (cifrar si el destino es compartido).
- **Notificaciones:** lo invocan otros workflows vía `POST http://cmdb-n8n-main:5678/webhook/notify` (red interna de Podman).
