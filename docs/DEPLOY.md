# Guía de Despliegue — CMDB Enterprise Platform v3.0.0

Guía paso a paso para desplegar la versión 3.0.0 desde cero o actualizar desde v2.9.x.

---

## Prerrequisitos del host

- RHEL 9 / AlmaLinux 9 con Podman ≥ 4.6 o Docker ≥ 24
- `podman-compose` instalado (`pip install podman-compose`)
- SELinux en modo Enforcing (compatible — los volúmenes llevan `:Z`)
- Puertos 80 y 443 libres
- RAM: 16 GB mínimo recomendado (backend + frontend + ollama + n8n × 3 + redis)
- Disco: ≥ 40 GB en la partición de datos (modelos Ollama ~11 GB + documentos + backups)

---

## Variables de entorno requeridas (v3.0.0)

Copiar `.env.example` a `.env` y completar **todos** los campos obligatorios:

```bash
cp .env.example .env
# Generar secretos
openssl rand -hex 32    # → CMDB_SERVICE_TOKEN  (M2M — compartido con n8n)
openssl rand -hex 32    # → N8N_ENCRYPTION_KEY  (CRÍTICO: irrecuperable si se pierde)
openssl rand -hex 16    # → REDIS_PASSWORD
openssl rand -hex 32    # → JWT_SECRET
```

| Variable | Obligatoria | Descripción |
|----------|-------------|-------------|
| `JWT_SECRET` | ✅ | HS256 signing key (≥32 chars) |
| `CMDB_SERVICE_TOKEN` | ✅ | Token M2M backend↔n8n (≥32 chars) |
| `N8N_ENCRYPTION_KEY` | ✅ | Clave cifrado credenciales n8n (≥32 chars) |
| `REDIS_PASSWORD` | ✅ | Contraseña Redis BullMQ |
| `POSTGRES_USER` | ✅ | Usuario PostgreSQL |
| `POSTGRES_PASSWORD` | ✅ | Contraseña PostgreSQL |
| `POSTGRES_DB` | ✅ | Nombre de la base de datos |
| `FRONTEND_URL` | ✅ | URL pública (p.ej. `https://cmdb.empresa.com`) |
| `WEBHOOK_URL` | ✅ | URL base webhooks n8n (= `FRONTEND_URL/n8n/`) |
| `PLUGIN_DATABASE_URL` | ✅ | URL conexión para DDL de plugins |
| `BACKUP_LOCAL_PATH` | ✅ | Ruta host para dumps (p.ej. `/var/backups/cmdb`) |
| `N8N_BASIC_AUTH_USER` | prod | Usuario básico n8n (complementa el gate CMDB) |
| `N8N_BASIC_AUTH_PASSWORD` | prod | Contraseña básica n8n |
| `SMTP_*` | opcional | Para alertas por email |

---

## Instalación desde cero

```bash
# 1. Clonar el repositorio
git clone <repo> /opt/cmdb-enterprise-platform
cd /opt/cmdb-enterprise-platform

# 2. Generar certificados TLS autofirmados (o copiar los reales)
mkdir -p certs/
openssl req -x509 -nodes -newkey rsa:4096 -days 365 \
  -keyout certs/server.key -out certs/server.crt \
  -subj "/CN=cmdb.empresa.com"
chmod 600 certs/server.key

# 3. Configurar .env
cp .env.example .env
# Editar .env con todos los valores obligatorios

# 4. Crear directorios de datos en el host
mkdir -p /opt/cmdb-data/ollama-models
mkdir -p /var/backups/cmdb
chcon -Rt svirt_sandbox_file_t /var/backups/cmdb  # SELinux

# 5. Construir y arrancar todos los servicios
podman-compose -f docker-compose.prod.yml up -d --build

# 6. Esperar a que el backend aplique migraciones y esté sano
sleep 10
curl -sk https://localhost/api/health

# 7. Descargar modelos Ollama (necesario antes del primer uso del chat IA)
podman exec cmdb-ollama-prod ollama pull bge-m3:latest
podman exec cmdb-ollama-prod ollama pull qwen3:latest

# 8. Verificar estado de todos los contenedores
podman-compose -f docker-compose.prod.yml ps
```

---

## Actualización desde v2.9.x

```bash
cd /opt/cmdb-enterprise-platform

# 1. Pull de los últimos cambios
git pull origin develop   # o el tag v3.0.0 cuando esté liberado

# 2. Añadir las nuevas variables al .env existente
# Ver sección "Variables de entorno requeridas" arriba.
# Las mínimas nuevas: CMDB_SERVICE_TOKEN, N8N_ENCRYPTION_KEY, REDIS_PASSWORD,
#                     WEBHOOK_URL, BACKUP_LOCAL_PATH

# 3. Crear directorio de backups
mkdir -p /var/backups/cmdb
chcon -Rt svirt_sandbox_file_t /var/backups/cmdb

# 4. Rebuild de los contenedores modificados
podman-compose -f docker-compose.prod.yml down
podman-compose -f docker-compose.prod.yml up -d --build

# 5. Verificar migración de la DB (incluye notify_channels T8)
curl -sk https://localhost/api/health

# 6. Verificar servicio M2M
TOKEN_SERVICE=$(cat .env | grep CMDB_SERVICE_TOKEN | cut -d= -f2)
curl -sk -H "X-CMDB-Service-Token: $TOKEN_SERVICE" \
  http://localhost:3000/api/internal/ping
# → {"pong":true,"ts":"..."}
```

---

## Verificación post-despliegue (smoke tests)

```bash
# 1. Health check general
curl -sk https://localhost/api/health

# 2. Redis activo
REDIS_PASS=$(cat .env | grep REDIS_PASSWORD | cut -d= -f2)
podman exec cmdb-redis redis-cli -a "$REDIS_PASS" ping
# → PONG

# 3. n8n activo (requiere login CMDB ADMIN)
# Acceder a https://<dominio>/n8n/ desde el navegador — debe mostrar la UI de n8n

# 4. Ollama modelos disponibles
podman exec cmdb-ollama-prod ollama list
# → bge-m3:latest, qwen3:latest

# 5. Endpoint interno accesible desde backend
podman exec cmdb-backend-prod \
  curl -s -H "X-CMDB-Service-Token: $TOKEN_SERVICE" \
  http://localhost:3000/api/internal/ping
# → {"pong":true}

# 6. pg_dump disponible en backend
podman exec cmdb-backend-prod pg_dump --version
# → pg_dump (PostgreSQL) 16.x

# 7. Login en la aplicación (navegador)
# https://<dominio>/ → pantalla de login → credenciales de un usuario AUDITOR/ADMIN

# 8. Test de backup
podman exec cmdb-backend-prod \
  curl -s -X POST \
  -H "X-CMDB-Service-Token: $TOKEN_SERVICE" \
  http://localhost:3000/api/internal/backup/trigger
# → {"ok":true,"backupId":"cmdb_...","dumpMb":...}
ls -lh /var/backups/cmdb/
```

---

## Configuración inicial de n8n

Tras el primer arranque, acceder a `https://<dominio>/n8n/` (requiere rol ADMIN en CMDB):

1. **Crear usuario admin de n8n** (wizard en primer login)
2. **Crear credencial `Header Auth`:**
   - Name: `CMDB Service Token`
   - Name: `X-CMDB-Service-Token`
   - Value: `<valor de CMDB_SERVICE_TOKEN en .env>`
3. **Crear credencial SMTP** (si se usan alertas por email)
4. **Importar workflows** desde `docs/n8n/json/` (una vez estén exportados)
5. **Activar workflows** con el toggle

Ver [docs/n8n/ADMIN_GUIDE.md](./n8n/ADMIN_GUIDE.md) para instrucciones detalladas.

---

## Rollback

```bash
# Si el despliegue falla y necesitas volver a v2.9.2:
git checkout v2.9.2  # o el tag anterior
podman-compose -f docker-compose.prod.yml down
podman-compose -f docker-compose.prod.yml up -d --build

# Restaurar DB si hubo migración (las nuevas columnas de T8 tienen DEFAULT, no rompen v2.9.x)
# Solo necesario si se quiere eliminar los nuevos campos:
podman exec cmdb-postgres-prod psql -U admin -d cmdb_db -c "
  ALTER TABLE alert_config
    DROP COLUMN IF EXISTS teams_webhook_url,
    DROP COLUMN IF EXISTS slack_bot_token,
    DROP COLUMN IF EXISTS slack_channel;
  ALTER TABLE alert_rules DROP COLUMN IF EXISTS channels;
"
```

---

## Puertos y servicios

| Servicio | Puerto host | Red interna | Notas |
|----------|-------------|-------------|-------|
| nginx | 443 (HTTPS), 80 (→redirect) | — | Único servicio expuesto |
| frontend | — | 3001 | Solo accesible vía nginx `/` |
| backend | — | 3000 | Solo accesible vía nginx `/api/*` |
| postgres | — | 5432 | Solo red interna |
| ollama | — | 11434 | Solo red interna |
| redis | — | 6379 | Solo red interna |
| n8n-main | — | 5678 | Accesible vía nginx `/n8n/` (auth gate) |
| n8n-worker-{1,2} | — | — | Solo red interna, consume de Redis |
