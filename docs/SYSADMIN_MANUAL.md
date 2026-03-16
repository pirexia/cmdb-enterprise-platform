# 🔧 CMDB Enterprise Platform — Manual del Administrador de Sistemas

**Versión:** 1.0.0  
**Público:** Equipo de Sistemas e Infraestructura (RHEL)  
**Fecha:** 2026-03-15

---

## Índice

1. [Requisitos del Sistema](#1-requisitos-del-sistema)
2. [Despliegue Inicial](#2-despliegue-inicial)
3. [Configuración del archivo .env](#3-configuración-del-archivo-env)
4. [Gestión de Certificados SSL/HTTPS](#4-gestión-de-certificados-sslhttps)
5. [Operaciones con Docker Compose](#5-operaciones-con-docker-compose)
6. [Backups y Restauración de la Base de Datos](#6-backups-y-restauración-de-la-base-de-datos)
7. [Gestión de Logs y Monitorización](#7-gestión-de-logs-y-monitorización)
8. [Actualización de la Aplicación](#8-actualización-de-la-aplicación)
9. [Troubleshooting](#9-troubleshooting)
10. [Seguridad y Hardening](#10-seguridad-y-hardening)
11. [Tareas de Mantenimiento Periódico](#11-tareas-de-mantenimiento-periódico)

---

## 1. Requisitos del Sistema

### Hardware mínimo
| Recurso | Mínimo | Recomendado |
|---------|--------|-------------|
| CPU | 2 vCPU | 4 vCPU |
| RAM | 4 GB | 8 GB |
| Disco | 20 GB | 50 GB SSD |
| Red | 100 Mbps | 1 Gbps |

### Software
```bash
# SO recomendado
Red Hat Enterprise Linux 8.x o 9.x
CentOS Stream 9
Rocky Linux 9

# Dependencias obligatorias
Docker Engine >= 24.0
Docker Compose plugin >= 2.0
git >= 2.40
openssl >= 1.1.1 (para generar certificados SSL)
```

### Verificar prerequisitos
```bash
docker --version
docker compose version
git --version
openssl version
```

---

## 2. Despliegue Inicial

### Paso 1: Clonar el repositorio
```bash
sudo mkdir -p /opt/cmdb
sudo chown $USER:$USER /opt/cmdb
cd /opt/cmdb
git clone https://github.com/pirexia/cmdb-enterprise-platform.git .
```

### Paso 2: Configurar variables de entorno
```bash
cp .env.example .env
nano .env               # Editar con valores reales (ver sección 3)
chmod 600 .env          # Restringir lectura al propietario
```

### Paso 3: Generar certificados SSL (si HTTPS_ENABLED=true)
```bash
bash backend/scripts/generate-certs.sh
# Resultado: backend/certs/server.key y server.crt
```

### Paso 4: Preparar volumen TLS
```bash
docker volume create cmdb-tls-certs
docker run --rm \
  -v cmdb-tls-certs:/dest \
  -v $(pwd)/backend/certs:/src:ro \
  alpine sh -c "cp /src/server.key /src/server.crt /dest/ && chmod 600 /dest/server.key"
```

### Paso 5: Levantar los servicios
```bash
# Construcción inicial (puede tardar 3-5 minutos)
docker compose -f docker-compose.prod.yml build --no-cache

# Levantar en segundo plano
docker compose -f docker-compose.prod.yml up -d

# Verificar estado
docker compose -f docker-compose.prod.yml ps
```

### Paso 6: Verificar salud
```bash
curl http://localhost:3000/health
# Respuesta esperada: {"status":"ok","timestamp":"..."}
```

---

## 3. Configuración del archivo .env

### Variables obligatorias en producción

```bash
# ── Base de Datos ──────────────────────────────────────────────────────
POSTGRES_DB=cmdb_db
POSTGRES_USER=cmdb_admin              # ¡Cambiar del default!
POSTGRES_PASSWORD=<min-32-chars>      # Generar: openssl rand -base64 32

# ── Backend ────────────────────────────────────────────────────────────
BACKEND_PORT=3000
JWT_SECRET=<min-48-chars>             # Generar: openssl rand -base64 48

# ── Frontend ───────────────────────────────────────────────────────────
FRONTEND_PORT=3001
NEXT_PUBLIC_API_URL=https://lx-gest01p.tudominio.com:3000

# ── Seguridad ──────────────────────────────────────────────────────────
HTTPS_ENABLED=true
CORS_ORIGINS=https://lx-gest01p.tudominio.com:3001

# ── SMTP / Alertas ─────────────────────────────────────────────────────
SMTP_HOST=smtp.tudominio.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=cmdb-alerts@tudominio.com
SMTP_PASS=<contraseña-smtp>
ALERT_RECIPIENT=it-ops@tudominio.com
ALERT_WARN_DAYS=30
ALERT_CRON_SCHEDULE=30 8 * * *

# ── LDAP (Opcional) ────────────────────────────────────────────────────
USE_LDAP=false
# USE_LDAP=true
# LDAP_URL=ldap://ad.tudominio.com:389
# LDAP_BASE_DN=DC=tudominio,DC=com
# LDAP_BIND_DN=CN=cmdb-svc,OU=Service Accounts,DC=tudominio,DC=com
# LDAP_BIND_PASSWORD=<contraseña-cuenta-servicio>
```

### Generar secretos seguros
```bash
# JWT Secret (mínimo 48 caracteres)
openssl rand -base64 48

# Contraseña de base de datos (32 caracteres)
openssl rand -base64 32
```

---

## 4. Gestión de Certificados SSL/HTTPS

### 4.1 Generar certificado autofirmado (intranet)
```bash
bash backend/scripts/generate-certs.sh
# Crea: backend/certs/server.key (privado) y server.crt (público)
# Validez: 365 días
```

### 4.2 Solicitar certificado de CA corporativa

```bash
# Paso 1: Generar CSR (Certificate Signing Request)
openssl req -new -newkey rsa:2048 -nodes \
  -keyout backend/certs/server.key \
  -out    backend/certs/server.csr \
  -subj   "/C=ES/ST=Madrid/O=TuEmpresa/CN=lx-gest01p.tudominio.com"

# Paso 2: Enviar server.csr a tu CA corporativa
# Paso 3: Guardar el certificado firmado:
cp certificado-firmado.crt backend/certs/server.crt

# Paso 4: Verificar que clave y certificado coinciden (mismo hash MD5)
openssl x509 -noout -modulus -in backend/certs/server.crt | md5sum
openssl rsa  -noout -modulus -in backend/certs/server.key | md5sum
```

### 4.3 Renovar certificados

```bash
# 1. Generar nuevos certificados (no borrar los antiguos hasta verificar)
bash backend/scripts/generate-certs.sh

# 2. Actualizar el volumen Docker
docker run --rm \
  -v cmdb-tls-certs:/dest \
  -v $(pwd)/backend/certs:/src:ro \
  alpine sh -c "cp /src/server.key /src/server.crt /dest/ && chmod 600 /dest/server.key"

# 3. Reiniciar el backend para que cargue los nuevos certificados
docker compose -f docker-compose.prod.yml restart backend

# 4. Verificar
curl -k https://localhost:3000/health
openssl s_client -connect localhost:3000 -showcerts 2>/dev/null | openssl x509 -noout -dates
```

### 4.4 Verificar caducidad del certificado actual
```bash
docker run --rm -v cmdb-tls-certs:/certs alpine \
  sh -c "openssl x509 -noout -dates -in /certs/server.crt"
# notBefore: fecha de inicio
# notAfter:  fecha de expiración  ← comprobar > hoy + 30 días
```

---

## 5. Operaciones con Docker Compose

### Comandos básicos
```bash
# Ver estado de todos los contenedores
docker compose -f docker-compose.prod.yml ps

# Ver logs en tiempo real (Ctrl+C para salir)
docker compose -f docker-compose.prod.yml logs -f

# Ver logs de un servicio específico
docker compose -f docker-compose.prod.yml logs -f backend
docker compose -f docker-compose.prod.yml logs -f postgres
docker compose -f docker-compose.prod.yml logs -f frontend

# Reiniciar un servicio (sin rebuild)
docker compose -f docker-compose.prod.yml restart backend

# Parar todos los servicios (los datos persisten en volúmenes)
docker compose -f docker-compose.prod.yml down

# Parar y eliminar volúmenes (¡DESTRUCTIVO - borra la BD!)
docker compose -f docker-compose.prod.yml down -v

# Actualizar con rebuild
docker compose -f docker-compose.prod.yml build --no-cache
docker compose -f docker-compose.prod.yml up -d
```

### Conectarse a un contenedor
```bash
# Shell en el backend
docker exec -it cmdb-backend-prod sh

# Consola PostgreSQL
docker exec -it cmdb-postgres-prod psql -U cmdb_admin -d cmdb_db

# Ejecutar migrate deploy manualmente
docker exec cmdb-backend-prod npx prisma migrate deploy
```

### Ver uso de recursos
```bash
docker stats --no-stream
# CONTAINER           CPU %    MEM USAGE / LIMIT
# cmdb-backend-prod   0.12%    180MiB / 7.8GiB
# cmdb-postgres-prod  0.04%    140MiB / 7.8GiB
# cmdb-frontend-prod  0.01%    95MiB / 7.8GiB
```

---

## 6. Backups y Restauración de la Base de Datos

### 6.1 Backup manual
```bash
# Variables de entorno (o leer del .env)
export PG_CONTAINER=cmdb-postgres-prod
export POSTGRES_DB=cmdb_db
export POSTGRES_USER=cmdb_admin
export BACKUP_DIR=/opt/cmdb/backups

# Ejecutar backup
bash /opt/cmdb/scripts/db-backup.sh

# Verificar resultado
ls -lh /opt/cmdb/backups/
# → backup_20260315_020000.sql.gz (comprimido con gzip -9)
```

### 6.2 Configurar backup automático (cron)
```bash
# Crear directorio de backups
sudo mkdir -p /opt/cmdb/backups
sudo chown $USER:$USER /opt/cmdb/backups

# Editar crontab del sistema
sudo crontab -e
```

Añadir la siguiente línea:
```cron
# CMDB Backup diario a las 02:00 AM
0 2 * * * BACKUP_DIR=/opt/cmdb/backups PG_CONTAINER=cmdb-postgres-prod POSTGRES_DB=cmdb_db POSTGRES_USER=cmdb_admin /opt/cmdb/scripts/db-backup.sh >> /var/log/cmdb-backup.log 2>&1
```

```bash
# Verificar que el cron está configurado
sudo crontab -l | grep cmdb

# Crear archivo de log
sudo touch /var/log/cmdb-backup.log
sudo chown $USER:$USER /var/log/cmdb-backup.log
```

### 6.3 Restaurar un backup
```bash
# Listar backups disponibles
ls -lht /opt/cmdb/backups/

# PRECAUCIÓN: La restauración sobreescribe los datos actuales
# Restaurar el backup del 2026-03-15
gunzip -c /opt/cmdb/backups/backup_20260315_020000.sql.gz \
  | docker exec -i cmdb-postgres-prod psql -U cmdb_admin -d cmdb_db

# Verificar que la restauración fue correcta
docker exec cmdb-postgres-prod psql -U cmdb_admin -d cmdb_db \
  -c "SELECT COUNT(*) FROM configuration_items;"
```

### 6.4 Retención de backups
El script `db-backup.sh` elimina automáticamente backups más antiguos que `RETENTION_DAYS` (30 días por defecto). Para cambiar la retención:
```bash
# En el crontab o en una llamada manual:
RETENTION_DAYS=60 bash /opt/cmdb/scripts/db-backup.sh
```

---

## 7. Gestión de Logs y Monitorización

### Logs de aplicación
```bash
# Logs del backend (incluye errores, accesos, cron)
docker logs cmdb-backend-prod --tail 200 -f

# Logs del frontend
docker logs cmdb-frontend-prod --tail 50 -f

# Logs de PostgreSQL
docker logs cmdb-postgres-prod --tail 100 -f

# Logs del script de backup
tail -f /var/log/cmdb-backup.log
```

### Endpoint de health check
```bash
# Salud del backend
curl http://localhost:3000/health
# {"status":"ok","timestamp":"2026-03-15T08:30:00.000Z"}

# Headers de seguridad (verificar Helmet)
curl -sI http://localhost:3000/health | grep -i "x-frame\|x-content\|x-xss"
```

### Logrotate para logs de backup
```bash
sudo tee /etc/logrotate.d/cmdb-backup << 'EOF'
/var/log/cmdb-backup.log {
    weekly
    rotate 12
    compress
    missingok
    notifempty
    create 0640 root root
}
EOF
```

### Alertas y métricas clave a monitorizar
| Métrica | Umbral de alerta | Acción |
|---------|-----------------|--------|
| Espacio en /opt/cmdb/backups | > 80% disco | Reducir RETENTION_DAYS |
| Tiempo de respuesta API /health | > 2s | Revisar logs backend |
| Memoria contenedor backend | > 1.5 GB | Reiniciar backend |
| Error rate en logs | > 10 errores/min | Revisar logs |
| Certificado SSL expiry | < 30 días | Renovar (sección 4.3) |

---

## 8. Actualización de la Aplicación

### Actualización estándar (zero-downtime)
```bash
cd /opt/cmdb

# 1. Crear backup antes de actualizar
bash scripts/db-backup.sh

# 2. Obtener cambios del repositorio
git pull origin main

# 3. Revisar el CHANGELOG o commits
git log --oneline -10

# 4. Reconstruir imágenes
docker compose -f docker-compose.prod.yml build --no-cache

# 5. Reemplazar contenedores (Docker reinicia uno a uno)
docker compose -f docker-compose.prod.yml up -d

# 6. Verificar que todo está correcto
docker compose -f docker-compose.prod.yml ps
curl http://localhost:3000/health
```

### Rollback si algo falla
```bash
cd /opt/cmdb

# Ver historial de commits
git log --oneline -10

# Volver al commit anterior
git checkout <hash-anterior>

# Reconstruir con la versión anterior
docker compose -f docker-compose.prod.yml build --no-cache
docker compose -f docker-compose.prod.yml up -d

# Restaurar backup de BD si fue necesario
gunzip -c /opt/cmdb/backups/backup_<fecha-anterior>.sql.gz \
  | docker exec -i cmdb-postgres-prod psql -U cmdb_admin -d cmdb_db
```

---

## 9. Troubleshooting

### El contenedor de backend no arranca
```bash
# Ver logs de arranque
docker logs cmdb-backend-prod --tail 50

# Causas comunes:
# 1. JWT_SECRET no definido → Error: "JWT_SECRET is required"
#    Solución: Añadir JWT_SECRET al .env y reiniciar

# 2. Error de conexión a PostgreSQL
#    Solución: Verificar que postgres está healthy:
docker compose -f docker-compose.prod.yml ps
docker logs cmdb-postgres-prod --tail 20

# 3. Puerto 3000 ocupado
ss -tlnp | grep :3000
# Solución: Matar el proceso o cambiar BACKEND_PORT en .env
```

### El frontend muestra "Error de red" o "No se puede conectar"
```bash
# Verificar que NEXT_PUBLIC_API_URL es accesible desde el navegador
# (No desde dentro de Docker, sino desde el PC del usuario)
curl http://lx-gest01p:3000/health

# Si usa HTTPS, verificar el certificado
curl -k https://lx-gest01p:3000/health

# Verificar CORS_ORIGINS incluye la URL del frontend
grep CORS_ORIGINS .env
```

### La base de datos no arranca
```bash
docker logs cmdb-postgres-prod --tail 50

# Si aparece "Permission denied" en el volumen (SELinux)
# El docker-compose.prod.yml ya usa :Z para SELinux
# Si persiste, verificar el contexto:
ls -laZ /var/lib/docker/volumes/cmdb-postgres-data-prod/

# Alternativa: deshabilitar SELinux temporalmente para diagnóstico (NO en producción)
# sudo setenforce 0
```

### Las alertas de email no se envían
```bash
# Verificar configuración SMTP
grep SMTP .env
grep ALERT .env

# Probar envío manualmente via API
curl -X POST http://localhost:3000/api/admin/test-email \
  -H "Authorization: Bearer <token-admin>"

# Ver logs del backend para errores SMTP
docker logs cmdb-backend-prod 2>&1 | grep -i "smtp\|email\|alert"
```

### Migración de base de datos falla al reiniciar
```bash
# Ejecutar migrate deploy manualmente
docker exec cmdb-backend-prod npx prisma migrate deploy

# Si hay conflictos de migración
docker exec -it cmdb-postgres-prod psql -U cmdb_admin -d cmdb_db
# Dentro de psql:
SELECT * FROM "_prisma_migrations" ORDER BY finished_at DESC LIMIT 10;
\q
```

### Error "EADDRINUSE" (puerto en uso)
```bash
# Encontrar qué proceso usa el puerto
ss -tlnp | grep :3000
lsof -i :3000

# Parar el proceso o cambiar BACKEND_PORT en .env
```

---

## 10. Seguridad y Hardening

### Firewall (firewalld en RHEL)
```bash
# Abrir puertos de la aplicación
sudo firewall-cmd --permanent --add-port=3000/tcp   # API Backend
sudo firewall-cmd --permanent --add-port=3001/tcp   # Frontend
sudo firewall-cmd --reload

# Verificar (5432 PostgreSQL NO debe aparecer)
sudo firewall-cmd --list-ports
# Correcto: 3000/tcp 3001/tcp
# Incorrecto: 5432/tcp (la BD no debe ser accesible externamente)
```

### Rotación de JWT_SECRET
```bash
# 1. Generar nuevo secreto
NEW_SECRET=$(openssl rand -base64 48)
echo "Nuevo JWT_SECRET: $NEW_SECRET"

# 2. Actualizar .env
nano .env  # Cambiar JWT_SECRET=<nuevo valor>

# 3. Reiniciar backend (invalida todos los tokens existentes — usuarios tendrán que volver a logarse)
docker compose -f docker-compose.prod.yml restart backend

# IMPORTANTE: La rotación del JWT_SECRET cierra todas las sesiones activas
```

### Rotación de contraseña de base de datos
```bash
# 1. Conectarse a PostgreSQL
docker exec -it cmdb-postgres-prod psql -U cmdb_admin -d cmdb_db

# Dentro de psql:
ALTER USER cmdb_admin WITH PASSWORD 'nueva-contraseña-segura';
\q

# 2. Actualizar .env con la nueva contraseña
nano .env   # POSTGRES_PASSWORD=nueva-contraseña

# 3. Reiniciar todos los servicios
docker compose -f docker-compose.prod.yml down
docker compose -f docker-compose.prod.yml up -d
```

---

## 11. Tareas de Mantenimiento Periódico

| Frecuencia | Tarea | Comando / Acción |
|------------|-------|-----------------|
| Diario (automático) | Backup BD | Cron 02:00 AM |
| Diario (automático) | Alertas email | Cron 08:30 AM |
| Semanal | Revisar logs de backup | `tail -n 50 /var/log/cmdb-backup.log` |
| Mensual | `npm audit` en backend/frontend | `docker exec cmdb-backend-prod npm audit` |
| Mensual | Verificar caducidad SSL | `openssl x509 -noout -dates -in backend/certs/server.crt` |
| Mensual | Limpieza de imágenes Docker | `docker image prune -f` |
| Trimestral | Rotación de JWT_SECRET | Ver sección 10 |
| Anual | Renovación certificado SSL | Ver sección 4.3 |
| Anual | Revisión de usuarios activos | Pestaña Configuración → Usuarios |
