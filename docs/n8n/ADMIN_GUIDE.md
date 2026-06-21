# n8n — Guía de Administración

Guía para administradores que gestionan la instancia de n8n integrada en CMDB Enterprise Platform v3.0.0.

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
| `N8N_ALLOWED_IPS` | `.env` | IPs/CIDRs que pueden acceder a la UI vía nginx. Default: `127.0.0.1`. |
| `WEBHOOK_URL` | `.env` | URL base para webhooks de n8n (p.ej. `https://cmdb.empresa.com/n8n/`). |

---

## Primer arranque

1. **Asegúrate de que `.env` está completo.** Ver `.env.example` sección `# v3.0.0 — n8n / Redis`.

2. **Arranca los contenedores:**
   ```bash
   podman-compose -f docker-compose.prod.yml up -d redis n8n-main n8n-worker-1 n8n-worker-2
   ```

3. **Accede a la UI:** `https://<dominio>/n8n/`

4. **Crea el usuario admin de n8n** (solo en el primer arranque — n8n muestra un wizard).

5. **Crea las credenciales** necesarias para cada workflow:
   - `Header Auth` — `X-CMDB-Service-Token: <token>` (para todos los endpoints `/api/internal/*`)
   - `SMTP` — Servidor de correo para alertas
   - `LDAP` — DN de bind + contraseña (si `USE_LDAP=true`)
   - `Slack OAuth2` o `Slack Bot Token` — Para notificaciones Slack
   - `HTTP Header Auth` — Para webhooks de Teams

6. **Importa los workflows** desde `docs/n8n/json/` (ver [WORKFLOWS.md](./WORKFLOWS.md)).

7. **Activa los workflows** (toggle en la UI — arrancan desactivados por defecto).

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
| Workflow falla con `401` en endpoint interno | `CMDB_SERVICE_TOKEN` no coincide | Actualizar credencial `Header Auth` en n8n UI |
| n8n no arranca | `N8N_ENCRYPTION_KEY` no definida | Añadir al `.env` y reiniciar |
| Webhook no recibe peticiones | `WEBHOOK_URL` mal configurada | Debe incluir `/n8n/` al final si pasa por nginx |
