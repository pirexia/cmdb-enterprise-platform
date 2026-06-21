# Guía de Backup y Restauración — CMDB Enterprise Platform

Versión: 3.0.0 | Audiencia: Administradores de sistema

---

## Resumen de estrategia de backup

| Qué | Método | Frecuencia | Destino |
|-----|--------|------------|---------|
| Base de datos (`cmdb_db`) | `pg_dump --format=custom` | Diario (02:00) vía n8n | `BACKUP_LOCAL_PATH` + opcional remoto |
| Documentos subidos | `tar -czf` del vol. `documents/` | Diario (02:00) vía n8n | `BACKUP_LOCAL_PATH` + opcional remoto |
| Modelos Ollama | **Manual / bajo demanda** | Según necesidad | Opción A: re-descargar; Opción B: copiar bind mount |
| TLS certs (`server.key`, `server.crt`) | **Manual — fuera del backup automatizado** | Tras renovación | Gestor de secretos externo |
| Configuración n8n | `pg_dump` incluye schema `n8n_data` | Diario (automático) | Incluido en el dump de `cmdb_db` |

> **D-D:** Los ficheros `server.key` y `server.crt` están excluidos del backup automatizado.
> Guardarlos en un gestor de secretos (HashiCorp Vault, AWS Secrets Manager, etc.) o en
> almacenamiento cifrado offline. Ver [§ Backup manual de certificados TLS](#backup-manual-de-certificados-tls).

---

## Backup automatizado (workflow n8n "Backup CMDB")

### Requisitos previos

1. `postgresql16-client` instalado en el contenedor backend (incluido desde v3.0.0).
2. `BACKUP_LOCAL_PATH` configurado en `.env` (default: `/var/backups/cmdb`).
3. El directorio `BACKUP_LOCAL_PATH` debe existir en el host y tener el SELinux label correcto:

```bash
mkdir -p /var/backups/cmdb
# RHEL 9 con SELinux Enforcing:
chcon -Rt svirt_sandbox_file_t /var/backups/cmdb
```

### Variables de entorno relevantes

```env
BACKUP_LOCAL_PATH=/var/backups/cmdb   # bind mount en el contenedor backend
BACKUP_RETENTION_DAYS=30              # días que se conservan los dumps locales
BACKUP_CRON=0 2 * * *                 # schedule del workflow n8n
```

### Lo que produce el workflow

Por cada ejecución se generan dos ficheros en `BACKUP_LOCAL_PATH`:

```
cmdb_YYYY-MM-DDTHH-MM-SS.dump         ← pg_dump formato custom (comprimido pg)
cmdb_YYYY-MM-DDTHH-MM-SS_docs.tar.gz  ← documentos subidos por usuarios
```

El workflow n8n también puede subir estos ficheros a un destino remoto (S3, SFTP, etc.)
si se configura el nodo de transferencia correspondiente (ver [docs/n8n/WORKFLOWS.md](./n8n/WORKFLOWS.md)).

### Verificar que el backup se ejecutó

```bash
# Listar backups locales en el backend
curl -sk -H "X-CMDB-Service-Token: $CMDB_SERVICE_TOKEN" \
  http://localhost:3000/api/internal/backup/list | python3 -m json.tool

# O directamente en el host
ls -lh /var/backups/cmdb/
```

---

## Backup manual

### Base de datos

```bash
# Desde el host (recomendado para backups de emergencia)
podman exec cmdb-postgres-prod \
  pg_dump -U admin -d cmdb_db --format=custom --compress=9 \
  > /var/backups/cmdb/manual_$(date +%Y%m%d_%H%M%S).dump

# Verificar integridad del dump
podman exec cmdb-postgres-prod \
  pg_restore --list /var/backups/cmdb/manual_YYYYMMDD_HHMMSS.dump | head -20
```

### Documentos subidos

```bash
# El volumen de documentos está en DOCUMENTS_STORAGE_PATH (default: ./document-storage)
tar -czf /var/backups/cmdb/docs_$(date +%Y%m%d_%H%M%S).tar.gz \
  -C /opt/cmdb-enterprise-platform document-storage/
```

### Backup manual de certificados TLS

> Los certificados **no se incluyen** en los backups automatizados. Guardar en un
> gestor de secretos o cifrar con GPG antes de almacenar.

```bash
# Exportar desde el volumen TLS (producción)
podman run --rm \
  -v cmdb-tls-certs:/certs:ro \
  -v /tmp:/out \
  alpine \
  sh -c "cp /certs/server.key /certs/server.crt /out/"

# Cifrar con GPG antes de almacenar
gpg --symmetric --cipher-algo AES256 -o /secure/server.key.gpg /tmp/server.key
gpg --symmetric --cipher-algo AES256 -o /secure/server.crt.gpg /tmp/server.crt

# Limpiar copia en claro
rm -f /tmp/server.key /tmp/server.crt
```

### Modelos Ollama (Opción A — recomendada)

Los modelos se pueden re-descargar; no se incluyen en los backups por su tamaño (~11 GB).

```bash
# Tras restaurar el sistema, re-descargar modelos
podman exec cmdb-ollama-prod ollama pull bge-m3:latest
podman exec cmdb-ollama-prod ollama pull qwen3:latest
```

### Modelos Ollama (Opción B — backup del bind mount)

```bash
# Solo si los modelos son difíciles de re-descargar (red restringida, etc.)
tar -czf /var/backups/cmdb/ollama_models_$(date +%Y%m%d).tar.gz \
  /opt/cmdb-data/ollama-models/
```

---

## Restauración

### Escenario 1: Restauración completa (servidor nuevo)

```bash
# 1. Clonar el repositorio y configurar .env
git clone <repo> /opt/cmdb-enterprise-platform
cd /opt/cmdb-enterprise-platform
cp .env.example .env
# Editar .env con los valores de producción

# 2. Restaurar TLS certs (antes de arrancar nginx)
mkdir -p certs/
gpg -d /secure/server.key.gpg > certs/server.key
gpg -d /secure/server.crt.gpg > certs/server.crt
chmod 600 certs/server.key

# 3. Arrancar PostgreSQL solo
podman-compose -f docker-compose.prod.yml up -d postgres
sleep 5

# 4. Restaurar la base de datos
podman cp /var/backups/cmdb/<dump>.dump cmdb-postgres-prod:/tmp/restore.dump
podman exec cmdb-postgres-prod \
  pg_restore -U admin -d cmdb_db --clean --if-exists /tmp/restore.dump
podman exec cmdb-postgres-prod rm /tmp/restore.dump

# 5. Restaurar documentos
mkdir -p document-storage/
tar -xzf /var/backups/cmdb/<backup>_docs.tar.gz -C ./

# 6. Arrancar el resto de servicios
podman-compose -f docker-compose.prod.yml up -d

# 7. Restaurar modelos Ollama (Opción A)
podman exec cmdb-ollama-prod ollama pull bge-m3:latest
podman exec cmdb-ollama-prod ollama pull qwen3:latest

# 8. Verificar
curl -sk https://localhost/api/health
```

### Escenario 2: Restauración solo de la base de datos (servidor existente)

```bash
# Parar el backend para evitar escrituras durante la restauración
podman stop cmdb-backend-prod

# Restaurar (--clean elimina objetos existentes antes de recrearlos)
podman cp /var/backups/cmdb/<dump>.dump cmdb-postgres-prod:/tmp/restore.dump
podman exec cmdb-postgres-prod \
  pg_restore -U admin -d cmdb_db --clean --if-exists /tmp/restore.dump
podman exec cmdb-postgres-prod rm /tmp/restore.dump

# Arrancar backend
podman start cmdb-backend-prod

# Verificar
curl -sk -H "Authorization: Bearer $TOKEN" https://localhost/api/health
```

### Escenario 3: Restauración de documentos

```bash
# Determinar destino (DOCUMENTS_STORAGE_PATH del .env, default: ./document-storage)
DOCS_PATH=/opt/cmdb-enterprise-platform/document-storage

# Restaurar (--strip-components=1 elimina el primer directorio del tar)
tar -xzf /var/backups/cmdb/<backup>_docs.tar.gz --strip-components=1 -C "$DOCS_PATH"

# Reiniciar backend para re-inicializar el caché de RAG
podman restart cmdb-backend-prod
```

### Escenario 4: Recuperación ante pérdida de N8N_ENCRYPTION_KEY

> Si se pierde `N8N_ENCRYPTION_KEY`, las credenciales almacenadas en n8n son irrecuperables.
> Los workflows (lógica) se pueden restaurar del dump de la DB; solo hay que re-introducir
> las credenciales manualmente.

```bash
# 1. Restaurar la DB incluye el schema n8n_data (workflows, ejecutados)
#    seguir Escenario 2 arriba

# 2. Actualizar N8N_ENCRYPTION_KEY en .env con la nueva clave
#    (si la clave antigua no está disponible, generar una nueva)
openssl rand -hex 32  # → nueva clave

# 3. Arrancar n8n con la nueva clave
podman-compose -f docker-compose.prod.yml restart n8n-main n8n-worker-1 n8n-worker-2

# 4. Re-introducir todas las credenciales en la UI de n8n:
#    - Header Auth (X-CMDB-Service-Token)
#    - SMTP
#    - LDAP (si aplica)
#    - Slack / Teams (si aplica)
```

---

## Validación de backups

### Verificar integridad del dump

```bash
# pg_restore --list no necesita una base de datos — solo lee el TOC del dump
pg_restore --list /var/backups/cmdb/<dump>.dump | head -30

# Verificar que el schema n8n_data está incluido
pg_restore --list /var/backups/cmdb/<dump>.dump | grep n8n_data
```

### Test de restauración (entorno de prueba)

```bash
# Crear una DB de prueba y restaurar
podman exec cmdb-postgres-prod createdb -U admin cmdb_test
podman cp /var/backups/cmdb/<dump>.dump cmdb-postgres-prod:/tmp/test.dump
podman exec cmdb-postgres-prod \
  pg_restore -U admin -d cmdb_test /tmp/test.dump
# Verificar tabla clave
podman exec cmdb-postgres-prod \
  psql -U admin -d cmdb_test -c "SELECT COUNT(*) FROM cis;"
# Limpiar
podman exec cmdb-postgres-prod dropdb -U admin cmdb_test
podman exec cmdb-postgres-prod rm /tmp/test.dump
```

---

## RTO / RPO objetivo

| Métrica | Objetivo | Cómo se consigue |
|---------|----------|------------------|
| **RPO** (pérdida máx. de datos) | < 24 horas | Backup diario automático vía n8n |
| **RTO** (tiempo máx. de recuperación) | < 15 minutos | Restauración directa con pg_restore + imagen Docker pre-construida |

Para objetivos más estrictos (RPO < 1h), configurar `pg_wal_archiving` o usar una
réplica de streaming — documentar en `docs/SYSADMIN_MANUAL.md`.

---

## Monitorización

El workflow n8n registra cada ejecución de backup en `audit_logs`:

```sql
SELECT action, details, created_at
FROM audit_logs
WHERE action IN ('BACKUP_SUCCESS', 'BACKUP_FAILURE')
ORDER BY created_at DESC
LIMIT 10;
```

También se puede consultar en la UI de CMDB: **Auditoría → filtrar por acción BACKUP_***.
