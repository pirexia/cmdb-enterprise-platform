# 🚀 CMDB Enterprise Platform — Runbook de Despliegue en Producción

**Servidor objetivo:** `lx-gest01p` (Red Hat Enterprise Linux 8/9)  
**Versión del documento:** 1.0  
**Fecha:** 2026-03-15  
**Prerrequisitos:** Docker Engine 24+ o Podman 4+ con Docker Compose plugin

---

## Índice

1. [Prerequisitos en el servidor RHEL](#1-prerrequisitos-en-el-servidor-rhel)
2. [Clonar el repositorio](#2-clonar-el-repositorio)
3. [Configurar el entorno (.env)](#3-configurar-el-entorno-env)
4. [Generar los certificados SSL](#4-generar-los-certificados-ssl)
5. [Preparar los volúmenes TLS](#5-preparar-los-volúmenes-tls)
6. [Construir y levantar los servicios](#6-construir-y-levantar-los-servicios)
7. [Verificar el despliegue](#7-verificar-el-despliegue)
8. [Configurar el backup automático (cron)](#8-configurar-el-backup-automático-cron)
9. [Configurar firewall (firewalld)](#9-configurar-firewall-firewalld)
10. [Actualización de la aplicación](#10-actualización-de-la-aplicación)
11. [Rollback rápido](#11-rollback-rápido)
12. [Diagnóstico y resolución de problemas](#12-diagnóstico-y-resolución-de-problemas)

---

## 1. Prerrequisitos en el servidor RHEL

```bash
# Verificar versión del SO
cat /etc/redhat-release

# Instalar Docker Engine (RHEL 8/9)
sudo dnf install -y dnf-plugins-core
sudo dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo
sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Iniciar y habilitar Docker
sudo systemctl enable --now docker

# Añadir el usuario de despliegue al grupo docker (evita sudo en cada comando)
sudo usermod -aG docker $USER
newgrp docker

# Verificar instalación
docker --version
docker compose version

# Instalar git si no está disponible
sudo dnf install -y git

# Instalar openssl (para generar certificados y JWT secret)
sudo dnf install -y openssl
```

> **SELinux (RHEL):** Los volumenes en `docker-compose.prod.yml` ya incluyen el sufijo `:Z`
> que relabela los archivos para SELinux en modo Enforcing. No es necesario desactivarlo.

---

## 2. Clonar el repositorio

```bash
# Elegir directorio de despliegue
sudo mkdir -p /opt/cmdb
sudo chown $USER:$USER /opt/cmdb
cd /opt/cmdb

# Clonar el repositorio
git clone https://github.com/pirexia/cmdb-enterprise-platform.git .

# Verificar contenido
ls -la
```

---

## 3. Configurar el entorno (.env)

```bash
# Copiar el template
cp .env.example .env

# Editar con valores de producción
nano .env
```

### Variables obligatorias en producción

```bash
# ── Base de datos ──────────────────────────────────────────────────────────
POSTGRES_DB=cmdb_db
POSTGRES_USER=cmdb_admin           # Cambia el usuario por defecto
POSTGRES_PASSWORD=<contraseña-segura-32-chars>

# ── Backend ────────────────────────────────────────────────────────────────
BACKEND_PORT=3000
JWT_SECRET=$(openssl rand -base64 48)   # Genera y pega el resultado

# ── Frontend ───────────────────────────────────────────────────────────────
FRONTEND_PORT=3001
# URL del backend tal como la ve el NAVEGADOR del usuario (IP/dominio real)
NEXT_PUBLIC_API_URL=https://lx-gest01p.tudominio.com:3000

# ── Seguridad ──────────────────────────────────────────────────────────────
HTTPS_ENABLED=true
CORS_ORIGINS=https://lx-gest01p.tudominio.com:3001

# ── SMTP / Alertas ─────────────────────────────────────────────────────────
SMTP_HOST=smtp.tudominio.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=cmdb-alerts@tudominio.com
SMTP_PASS=<contraseña-smtp>
ALERT_RECIPIENT=it-ops@tudominio.com
ALERT_WARN_DAYS=30
ALERT_CRON_SCHEDULE=30 8 * * *
```

> **Seguridad:** El archivo `.env` nunca debe commitearse. Está en `.gitignore`.

```bash
# Restringir permisos del .env
chmod 600 .env
```

### Generar JWT_SECRET de forma segura

```bash
openssl rand -base64 48
# Salida de ejemplo: abc123...48chars...XYZ=
# Copia ese valor en JWT_SECRET en .env
```

---

## 4. Generar los certificados SSL

### Opción A — Certificado autofirmado (desarrollo/intranet)

```bash
# Usando el script incluido en el proyecto
bash backend/scripts/generate-certs.sh

# Los certificados se generan en backend/certs/
ls -la backend/certs/
# → server.key   (clave privada — NUNCA compartir)
# → server.crt   (certificado autofirmado — 365 días)
```

### Opción B — Certificado de una CA corporativa (recomendado producción)

```bash
# 1. Genera una CSR (Certificate Signing Request)
openssl req -new -newkey rsa:2048 -nodes \
  -keyout backend/certs/server.key \
  -out    backend/certs/server.csr \
  -subj   "/C=ES/ST=Madrid/O=TuEmpresa/CN=lx-gest01p.tudominio.com"

# 2. Envía server.csr a tu CA corporativa
# 3. Cuando recibas el certificado firmado, guárdalo como:
cp certificado-firmado.crt backend/certs/server.crt

# 4. Verifica que la clave y el certificado coinciden
openssl x509 -noout -modulus -in backend/certs/server.crt | md5sum
openssl rsa  -noout -modulus -in backend/certs/server.key | md5sum
# Ambas líneas deben mostrar el mismo hash MD5
```

---

## 5. Preparar los volúmenes TLS

Los certificados deben copiarse al volumen Docker nombrado `cmdb-tls-certs`:

```bash
# Crear el volumen (si no existe)
docker volume create cmdb-tls-certs

# Copiar los certificados al volumen
docker run --rm \
  -v cmdb-tls-certs:/dest \
  -v $(pwd)/backend/certs:/src:ro \
  alpine sh -c "cp /src/server.key /src/server.crt /dest/ && chmod 600 /dest/server.key"

# Verificar
docker run --rm -v cmdb-tls-certs:/certs alpine ls -la /certs
```

---

## 6. Construir y levantar los servicios

```bash
cd /opt/cmdb

# Construir las imágenes (multi-stage, tarda ~3 minutos la primera vez)
docker compose -f docker-compose.prod.yml build --no-cache

# Levantar todos los servicios en background
docker compose -f docker-compose.prod.yml up -d

# Ver logs en tiempo real (ctrl+C para salir)
docker compose -f docker-compose.prod.yml logs -f
```

### Verificar que todos los contenedores están healthy

```bash
docker compose -f docker-compose.prod.yml ps
```

Salida esperada:

```
NAME                  STATUS            PORTS
cmdb-postgres-prod    running (healthy)
cmdb-backend-prod     running (healthy) 0.0.0.0:3000->3000/tcp
cmdb-frontend-prod    running           0.0.0.0:3001->3001/tcp
```

---

## 7. Verificar el despliegue

```bash
# 1. Salud del backend API
curl -k https://localhost:3000/health
# Respuesta: {"status":"ok","timestamp":"..."}

# 2. Frontend accesible
curl -sI http://localhost:3001 | head -5
# Respuesta: HTTP/1.1 200 OK

# 3. Verificar headers de seguridad (Helmet)
curl -sI http://localhost:3000/health | grep -i "x-frame\|x-content\|x-xss"
# Debe mostrar:
#   X-Frame-Options: SAMEORIGIN
#   X-Content-Type-Options: nosniff
#   X-XSS-Protection: 0

# 4. Primer login
# Abre en el navegador: http://lx-gest01p:3001
# Usuario admin por defecto: admin@cmdb.local / Admin1234!
# (Cambia la contraseña inmediatamente tras el primer login)
```

---

## 8. Configurar el backup automático (cron)

```bash
# Hacer el script ejecutable
chmod +x /opt/cmdb/scripts/db-backup.sh

# Crear directorio de backups
sudo mkdir -p /opt/cmdb/backups
sudo chown $USER:$USER /opt/cmdb/backups

# Probar el backup manualmente (debe crear un archivo .sql.gz)
BACKUP_DIR=/opt/cmdb/backups \
PG_CONTAINER=cmdb-postgres-prod \
POSTGRES_DB=cmdb_db \
POSTGRES_USER=cmdb_admin \
  bash /opt/cmdb/scripts/db-backup.sh

ls -lh /opt/cmdb/backups/

# Añadir al crontab del sistema (ejecuta a las 02:00 AM todos los días)
sudo crontab -e
```

Añade esta línea al crontab:

```cron
# CMDB Enterprise Platform — Database backup diario a las 02:00 AM
0 2 * * * BACKUP_DIR=/opt/cmdb/backups PG_CONTAINER=cmdb-postgres-prod POSTGRES_DB=cmdb_db POSTGRES_USER=cmdb_admin /opt/cmdb/scripts/db-backup.sh >> /var/log/cmdb-backup.log 2>&1
```

```bash
# Verificar que el cron quedó registrado
sudo crontab -l | grep cmdb

# Crear el archivo de log con permisos correctos
sudo touch /var/log/cmdb-backup.log
sudo chown $USER:$USER /var/log/cmdb-backup.log

# Rotar los logs de backup (logrotate)
sudo tee /etc/logrotate.d/cmdb-backup << 'EOF'
/var/log/cmdb-backup.log {
    weekly
    rotate 12
    compress
    missingok
    notifempty
}
EOF
```

---

## 9. Configurar firewall (firewalld)

```bash
# Abrir puertos necesarios
sudo firewall-cmd --permanent --add-port=3000/tcp   # Backend API
sudo firewall-cmd --permanent --add-port=3001/tcp   # Frontend
sudo firewall-cmd --reload

# Verificar
sudo firewall-cmd --list-ports
# Debe mostrar: 3000/tcp 3001/tcp

# Nota: Puerto 5432 (PostgreSQL) NO debe abrirse — la BD es solo interna
# Nota: Si usas un reverse proxy (Nginx), abre 80/443 en lugar de 3000/3001
```

---

## 10. Actualización de la aplicación

```bash
cd /opt/cmdb

# 1. Obtener cambios del repositorio
git pull origin main

# 2. Reconstruir las imágenes con los cambios
docker compose -f docker-compose.prod.yml build --no-cache

# 3. Reiniciar con cero downtime (reemplaza contenedores uno a uno)
docker compose -f docker-compose.prod.yml up -d

# 4. Verificar que todo está correcto
docker compose -f docker-compose.prod.yml ps
curl -k https://localhost:3000/health
```

---

## 11. Rollback rápido

Si el despliegue falla, vuelve al commit anterior:

```bash
cd /opt/cmdb

# Ver el historial de commits
git log --oneline -10

# Volver al commit anterior
git checkout <hash-del-commit-anterior>

# Reconstruir con la versión anterior
docker compose -f docker-compose.prod.yml build --no-cache
docker compose -f docker-compose.prod.yml up -d
```

---

## 12. Diagnóstico y resolución de problemas

### Ver logs de un servicio específico

```bash
docker logs cmdb-backend-prod  --tail 100 -f
docker logs cmdb-postgres-prod --tail 50  -f
docker logs cmdb-frontend-prod --tail 50  -f
```

### Conectarse a la base de datos (debugging)

```bash
docker exec -it cmdb-postgres-prod psql -U cmdb_admin -d cmdb_db
# Dentro de psql:
\dt                    # listar tablas
SELECT COUNT(*) FROM configuration_items;
\q                     # salir
```

### Restaurar un backup

```bash
# Listar backups disponibles
ls -lh /opt/cmdb/backups/

# Restaurar un backup específico
gunzip -c /opt/cmdb/backups/backup_20260315_020000.sql.gz \
  | docker exec -i cmdb-postgres-prod psql -U cmdb_admin -d cmdb_db
```

### Reiniciar un servicio sin detener los demás

```bash
docker compose -f docker-compose.prod.yml restart backend
docker compose -f docker-compose.prod.yml restart frontend
```

### Detener toda la plataforma (mantenimiento)

```bash
docker compose -f docker-compose.prod.yml down
# Los datos persisten en los volúmenes (postgres-data, tls-certs)
```

### Limpiar imágenes antiguas (liberar espacio)

```bash
docker image prune -f
docker system prune -f --volumes
```

---

## Resumen de URLs y puertos

| Servicio | URL | Puerto |
|----------|-----|--------|
| Frontend (UI) | `http://lx-gest01p:3001` | 3001 |
| Backend API | `http://lx-gest01p:3000` | 3000 |
| Backend API (HTTPS) | `https://lx-gest01p:3000` | 3000 |
| PostgreSQL | Solo interno (no expuesto) | — |

---

*Para soporte, consulta [`SECURITY_AUDIT.md`](./SECURITY_AUDIT.md) y el repositorio en GitHub.*
