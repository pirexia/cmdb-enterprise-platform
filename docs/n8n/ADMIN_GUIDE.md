# n8n — Guía de Administración

Guía para administradores que gestionan la instancia de n8n integrada en CMDB Enterprise Platform v3.2.0.

---

## Acceso a la UI de n8n

La UI de n8n está disponible en `https://<dominio>/n8n/`.

**Requisitos:**
- Debes tener una cuenta CMDB con rol `ADMIN`.
- nginx valida tu sesión CMDB antes de redirigirte a n8n (auth_request a `/api/internal/n8n-gate`).
- Si ves un error `403`, verifica que tu token JWT esté activo y que tu rol sea `ADMIN`.

> En entorno de desarrollo, n8n también está accesible en `http://localhost:5678`
> sin autenticación adicional (solo en dev compose con `N8N_BASIC_AUTH_ACTIVE=false`).

---

## Arquitectura en Queue Mode

```
n8n-main (UI + trigger evaluator)
    │
    └── Redis (BullMQ) ──┬── n8n-worker-1 (ejecuta jobs)
                         └── n8n-worker-2 (ejecuta jobs)
```

- **n8n-main:** Solo evalúa triggers (crons, webhooks) y encola jobs en Redis. No ejecuta lógica de workflow.
- **n8n-worker-{1,2}:** Consumen jobs de la cola y ejecutan los nodos. Tienen acceso a Internet (SMTP, Teams, LDAP, S3) y a la red interna (backend, postgres, redis, ollama).
- **Redis:** Cola BullMQ. Sin Redis, n8n no arranca en Queue Mode.

---

## Variables de entorno críticas

| Variable | Dónde | Descripción |
|----------|-------|-------------|
| `N8N_ENCRYPTION_KEY` | `.env` | **CRÍTICO: si se pierde, las credenciales son irrecuperables.** Guardar en gestor de secretos. |
| `CMDB_SERVICE_TOKEN` | `.env` | Token M2M ≥32 chars. Debe coincidir entre backend y workflows n8n. |
| `REDIS_PASSWORD` | `.env` | Contraseña de Redis. Usada por n8n y Redis por igual. |
| `N8N_API_KEY` | `.env` | API key REST de n8n. **Generada automáticamente** por `install.sh`/`update.sh` (Phase 10d / `ensure_n8n_api_key`). Sin esta key el aprovisionamiento automático queda desactivado. |
| `N8N_ALLOWED_IPS` | `.env` | IPs/CIDRs que pueden acceder a la UI vía nginx. Default: `127.0.0.1`. |
| `WEBHOOK_URL` | `.env` | URL base para webhooks de n8n (p.ej. `https://cmdb.empresa.com/n8n/`). |
| `EXECUTIONS_DATA_SAVE_ON_SUCCESS` | compose | `none` — no persistir ejecuciones exitosas. Ver [Retención de ejecuciones](#retención-de-ejecuciones). |
| `EXECUTIONS_DATA_SAVE_ON_ERROR` | compose | `all` — sí persistir ejecuciones fallidas (para depurar). |
| `EXECUTIONS_DATA_PRUNE` | compose (main) | `true` — purga automática del histórico. |
| `EXECUTIONS_DATA_MAX_AGE` | compose (main) | `168` horas (7 días) — antigüedad máxima antes de purgar. |
| `EXECUTIONS_DATA_PRUNE_MAX_COUNT` | compose (main) | `10000` — tope duro de filas en `execution_entity`. |

> **Nota sobre `CMDB_SERVICE_TOKEN` y los workflows:** los workflows **no leen** esta env var
> vía `$env`. Autentican contra `/api/internal/*` mediante la **credencial de n8n** `Header Auth account`
> (tipo `httpHeaderAuth`), guardada cifrada en la BD. El valor del token debe coincidir en ambos sitios:
> la env var del backend (para *validar*) y la credencial de n8n (para *enviar* el header). Por eso un
> workflow recién importado aparece **inactivo** hasta que un ADMIN vincula sus credenciales en la UI.

---

## Retención de ejecuciones

Cada ejecución de un workflow puede persistirse en el schema `n8n_data` (tablas `execution_entity`
+ `execution_data`). Algunos workflows sondean con mucha frecuencia — **RAG Indexing corre cada 30 s
(~2.880 ejecuciones/día)** — por lo que sin una política de retención la tabla crece **sin límite**
(hinchazón de la BD, UI de n8n lenta).

**Política configurada** (en `n8n-main` + ambos workers del `docker-compose.prod.yml`):

| Variable | Valor | Efecto |
|----------|-------|--------|
| `EXECUTIONS_DATA_SAVE_ON_SUCCESS` | `none` | Las ejecuciones **exitosas NO se guardan**. |
| `EXECUTIONS_DATA_SAVE_ON_ERROR` | `all` | Las ejecuciones **fallidas SÍ se guardan**. |
| `EXECUTIONS_DATA_SAVE_ON_PROGRESS` | `false` | No persistir estados intermedios. |
| `EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS` | `false` | No guardar ejecuciones manuales (botón *Execute Workflow*). |
| `EXECUTIONS_DATA_PRUNE` | `true` | Purga automática (solo en `n8n-main`). |
| `EXECUTIONS_DATA_MAX_AGE` | `168` | Retener errores 7 días como máximo. |
| `EXECUTIONS_DATA_PRUNE_MAX_COUNT` | `10000` | Tope duro de filas. |

> **Estas variables son globales de la instancia**, no por-workflow. Aplican por igual a *todos* los
> workflows (RAG Indexing, Alertas CMDB, LDAP/AD Sync, Backup, etc.).

### El criterio es por ESTADO, no por contenido

n8n decide **solo por el estado final** de la ejecución, sin inspeccionar el payload:

| Ejecución | ¿Se guarda con esta política? |
|-----------|-------------------------------|
| `error` / `crashed` | ✅ Sí (7 días, tope 10k) |
| `success` — tick vacío (no-op) | ❌ No |
| `success` — **que sí hizo trabajo real** (p. ej. indexó 3 documentos) | ❌ **No tampoco** |

No existe en n8n una opción "guardar solo los éxitos que hicieron algo": las únicas son
`none` / `all` / `error`. Poner `all` reintroduce la hinchazón (los ~2.880 ticks/día casi todos vacíos).

### ¿Dónde queda el rastro auditable del trabajo real?

El registro durable de **qué se indexó y cuándo** NO depende del histórico de n8n: el backend escribe
una fila **`INDEX_BATCH` en `audit_logs`** solo cuando hubo trabajo real
(`backend/src/modules/ai/queue.ts`, guard `if (totalActivity > 0)`). Es inmutable (insert-only,
ISO 27001 A.8.15). Así:

- **Histórico de ejecuciones de n8n** = telemetría operativa efímera → solo conservamos los **fallos**.
- **`audit_logs` `INDEX_BATCH`** = registro de negocio durable → **intacto**, es el sitio correcto.

### Purga manual del histórico acumulado

Si el histórico ya creció antes de aplicar la política, puede vaciarse con:

```sql
TRUNCATE TABLE n8n_data.execution_annotation_tags,
               n8n_data.execution_annotations,
               n8n_data.execution_data,
               n8n_data.execution_metadata,
               n8n_data.execution_entity
RESTART IDENTITY CASCADE;
```

> El `CASCADE` también vacía tablas internas de n8n que esta plataforma no usa
> (`test_case_execution`, `chat_hub_messages`) — sin pérdida de datos de negocio.

---

## Aprovisionamiento automático (v3.2.0+)

A partir de **v3.2.0**, credenciales y workflows se aprovisionan **automáticamente** al arrancar el backend. No es necesario importar JSONs ni crear credenciales a mano en la UI.

### Cómo funciona

1. `install.sh` (Phase 10d) o `update.sh` (`ensure_n8n_api_key`) generan el usuario admin de n8n y obtienen una API key REST, que se inyecta en `.env` como `N8N_API_KEY`.
2. Al arrancar el backend (`provisionOnBoot` en `backend/src/modules/n8n-provisioning/onBoot.ts`), se invocan automáticamente:
   - **Credenciales** — se crean o recrean si el valor de `.env` cambió (p.ej. `CMDB_SERVICE_TOKEN` rotado).
   - **Workflows** — se crean o actualizan desde las plantillas en código (`backend/src/modules/n8n-provisioning/workflows.ts`) y se activan según su política (`smtp` / `ldap` / `always`).
3. Si el aprovisionamiento falla (n8n aún no arrancado), reintenta cada 6 s hasta 10 veces.

### Forzar re-aprovisionamiento manual

Desde **Configuración → n8n** (solo ADMIN) → botón **Re-sincronizar workflows**. Llama a `POST /api/admin/n8n/resync` y muestra el informe de credenciales y workflows.

```bash
# O via API
TOKEN=$(curl -sk -X POST https://localhost/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"<admin>","password":"<pass>","mfaCode":"<code>"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
curl -sk -X POST https://localhost/api/admin/n8n/resync \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

### Verificar estado del aprovisionamiento

```bash
# La key debe estar poblada
grep N8N_API_KEY .env

# Logs del backend al arrancar
podman logs cmdb-backend-prod 2>&1 | grep -i "n8n\|provision"
```

---

## Primer arranque

> **v3.2.0+:** Los pasos 4–7 los realiza el aprovisionamiento automático. Solo es necesario intervenir manualmente si `N8N_API_KEY` está vacía en `.env` o si añades credenciales personalizadas (Slack, Teams).

1. **Asegúrate de que `.env` está completo.** Ver `.env.example` sección `# v3.0.0 — n8n / Redis`.

2. **Arranca los contenedores:**
   ```bash
   podman-compose -f docker-compose.prod.yml up -d redis n8n-main n8n-worker-1 n8n-worker-2
   ```

3. **Accede a la UI:** `https://<dominio>/n8n/`

4. _(Auto) Usuario admin de n8n_ — creado por `n8n_ensure_owner_and_key` en Phase 10d del instalador.

5. _(Auto) Credenciales_ — aprovisionadas por `provisionOnBoot` al arrancar el backend:
   - `CMDB Internal API` — `Header Auth` con `X-CMDB-Service-Token` (para `/api/internal/*`)
   - `CMDB SMTP` — Servidor de correo (solo si `ALERT_FROM_EMAIL` configurado)
   - `CMDB LDAP` — DN de bind (solo si `USE_LDAP=true` y `LDAP_BIND_PASSWORD` configurado)
   - `Slack Bot Token` / `Teams Webhook` — **Manuales** — crearlas en la UI y vincularlas a los nodos de notificación.

6. _(Auto) Workflows_ — importados y activados automáticamente. Ver [WORKFLOWS.md](./WORKFLOWS.md).

7. **Activa manualmente** los workflows de Slack/Teams si los configuraste (toggle en la UI).

---

## Gestión de workers

### Escalar workers

Para añadir más workers (p.ej. en entornos de alta carga), añade al compose:

```yaml
n8n-worker-3:
  <<: *n8n-worker-base
  container_name: n8n-worker-3
```

No hay límite de workers; todos comparten la misma cola Redis.

### Verificar que los workers están activos

```bash
# Desde el host
podman exec n8n-main n8n worker --help 2>/dev/null || \
  curl -s http://localhost:5678/healthz
```

En la UI de n8n: **Admin Panel → Workers** muestra el estado de cada worker.

---

## Logs y diagnóstico

```bash
# Logs del nodo principal
podman logs -f n8n-main

# Logs de un worker
podman logs -f n8n-worker-1

# Redis — verificar que la cola está activa
podman exec cmdb-redis redis-cli -a "$REDIS_PASSWORD" ping
podman exec cmdb-redis redis-cli -a "$REDIS_PASSWORD" info keyspace
```

### Workflows fallidos

En la UI de n8n: **Executions** → filtrar por `Error`. Cada ejecución muestra:
- El nodo que falló
- El mensaje de error
- El payload de entrada/salida de cada nodo

---

## Seguridad operativa

### Rotación del CMDB_SERVICE_TOKEN

1. Genera un nuevo token: `openssl rand -hex 32`
2. Actualiza `.env` (backend y n8n)
3. Reinicia backend: `podman-compose restart cmdb-backend-prod`
4. Reinicia n8n: `podman-compose restart n8n-main n8n-worker-1 n8n-worker-2`
5. Actualiza las credenciales `Header Auth` en la UI de n8n.

### Rotación del N8N_ENCRYPTION_KEY

> **ADVERTENCIA:** La rotación de `N8N_ENCRYPTION_KEY` requiere re-introducir
> manualmente todas las credenciales en la UI de n8n. Las credenciales existentes
> cifradas con la clave antigua son irrecuperables.

1. Exporta todos los workflows (sin credenciales) antes de rotar.
2. Genera nueva clave: `openssl rand -hex 32`
3. Detén n8n, actualiza `.env`, arranca n8n.
4. Re-introduce todas las credenciales en la UI.

### Acceso de emergencia

Si nginx está caído y necesitas acceder a la UI de n8n directamente:

```bash
# Conectar al contenedor n8n-main con port forward temporal
podman exec -it n8n-main sh
# O bien, exponer temporalmente el puerto (solo en mantenimiento planificado)
podman run --network=host ...
```

---

## Backup de la configuración de n8n

La configuración de n8n (workflows, credenciales cifradas, ejecuciones) se almacena en el
schema `n8n_data` del PostgreSQL compartido. El backup automatizado (workflow "Backup CMDB")
incluye este schema automáticamente en el `pg_dump`.

Para exportar solo los workflows (sin credenciales):
```bash
# API de n8n
curl -s "http://localhost:5678/api/v1/workflows" \
  -H "X-N8N-API-KEY: <tu-api-key>" \
  | python3 -m json.tool > backup_workflows_$(date +%F).json
```

---

## Resolución de problemas frecuentes

| Síntoma | Causa probable | Solución |
|---------|----------------|----------|
| UI `/n8n/` devuelve 403 | Token CMDB expirado o no es ADMIN | Volver a hacer login en CMDB |
| Workers no consumen jobs | Redis sin contraseña o desconectado | Verificar `REDIS_PASSWORD` y `podman logs cmdb-redis` |
| Workflow falla con `401` en endpoint interno | `CMDB_SERVICE_TOKEN` no coincide | Forzar re-sync desde Configuración → n8n o vía `POST /api/admin/n8n/resync` |
| n8n no arranca | `N8N_ENCRYPTION_KEY` no definida | Añadir al `.env` y reiniciar |
| Botón "Re-sincronizar" devuelve 503 | `N8N_API_KEY` vacía en `.env` | Ver sección [Aprovisionamiento automático](#aprovisionamiento-automático-v320) — ejecutar Phase 10d manualmente |
| Workflows creados pero inactivos | Política `smtp`/`ldap` y config no detectada | Verificar `ALERT_FROM_EMAIL` y `USE_LDAP` en `.env`; re-sincronizar |
| Webhook no recibe peticiones | `WEBHOOK_URL` mal configurada | Debe incluir `/n8n/` al final si pasa por nginx |
