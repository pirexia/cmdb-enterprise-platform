# 🚀 CMDB Enterprise Platform — Runbook de Despliegue en Producción

**Servidor objetivo:** `lx-gest01p` (Red Hat Enterprise Linux 8/9)  
**Versión del documento:** 1.0  
**Fecha:** 2026-03-15  
**Prerrequisitos:** Docker Engine 24+ o Podman 4+ con Docker Compose plugin

---

## Índice

1. [Preparación del Sistema (ISO 27001 Compliance)](#1-preparación-del-sistema-iso-27001-compliance)
2. [Prerequisitos en el servidor RHEL](#2-prerrequisitos-en-el-servidor-rhel)
3. [Clonar el repositorio](#3-clonar-el-repositorio)
4. [Configurar el entorno (.env)](#4-configurar-el-entorno-env)
5. [Generar los certificados SSL](#5-generar-los-certificados-ssl)
6. [Preparar los volúmenes TLS](#6-preparar-los-volúmenes-tls)
7. [Construir y levantar los servicios](#7-construir-y-levantar-los-servicios)
8. [Verificar el despliegue](#8-verificar-el-despliegue)
9. [Configurar el backup automático (cron)](#9-configurar-el-backup-automático-cron)
10. [Configurar firewall (firewalld)](#10-configurar-firewall-firewalld)
11. [Actualización de la aplicación](#11-actualización-de-la-aplicación)
12. [Rollback rápido](#12-rollback-rápido)
13. [Diagnóstico y resolución de problemas](#13-diagnóstico-y-resolución-de-problemas)

---

## 1. Preparación del Sistema (ISO 27001 Compliance)

> **⚠️ OBLIGATORIO:** Esta sección implementa los requisitos de seguridad ISO 27001 para entornos de producción.  
> **Principios aplicados:** Zero Trust, Mínimo Privilegio, Aislamiento de Servicios, Persistencia de Procesos.

### 1.1 Crear usuario de servicio dedicado

**Nunca ejecutar contenedores en producción como root o con usuarios personales.** Crea un usuario dedicado para aislar la aplicación:

```bash
# Crear usuario de servicio sin acceso interactivo por shell
sudo useradd -m -s /bin/bash cmdb-admin
sudo passwd cmdb-admin
# Introduce una contraseña segura (mínimo 16 caracteres)

# Verificar creación
id cmdb-admin
# uid=1001(cmdb-admin) gid=1001(cmdb-admin) groups=1001(cmdb-admin)
```

### 1.2 Habilitar persistencia de contenedores (Linger)

**CRÍTICO:** Sin esta configuración, los contenedores Podman Rootless se detienen cuando el usuario cierra sesión o el servidor se reinicia.

```bash
# Habilitar persistencia para el usuario de servicio
sudo loginctl enable-linger cmdb-admin

# Verificar que el linger está activo
loginctl show-user cmdb-admin | grep Linger
# Linger=yes
```

> **¿Qué hace `enable-linger`?**  
> Permite que los servicios del usuario `cmdb-admin` permanezcan ejecutándose incluso cuando no hay sesión activa. Esto asegura que los contenedores Podman sobreviven a reinicios del sistema y cierres de sesión SSH.

### 1.3 Verificar dimensionamiento de almacenamiento (LVM)

> **⚠️ CRÍTICO - Podman Rootless y uso de /home**
> 
> A diferencia de Docker tradicional, **Podman Rootless almacena TODAS las imágenes, contenedores y volúmenes persistentes en el directorio home del usuario de servicio**, específicamente en:
> 
> ```
> /home/cmdb-admin/.local/share/containers/
>   ├── storage/           (imágenes y capas de contenedores)
>   └── volumes/           (datos persistentes de PostgreSQL)
> ```
> 
> **Riesgo:** Si `/home` no tiene suficiente espacio o está en la misma partición que `/` (raíz), la plataforma puede llenar el disco y provocar:
> - Caída del sistema operativo
> - Corrupción de base de datos PostgreSQL
> - Imposibilidad de crear nuevos contenedores
> 
> **Solución obligatoria:** Crear un volumen LVM dedicado para `/home` (o específicamente para `/home/cmdb-admin`) con dimensionamiento adecuado.

#### Dimensionamiento recomendado

Consulta la tabla completa de capacity planning en [`docs/ARCHITECTURE.md - Sección 11`](docs/ARCHITECTURE.md#11-capacity-planning-y-dimensionamiento-de-hardware).

**Resumen rápido:**

| Volumen de CIs | Espacio mínimo en /home |
|----------------|------------------------|
| Hasta 1.000 | 15 GB |
| 1.000 a 5.000 | 30 GB |
| 5.000 a 20.000+ | 60 GB+ |

#### Verificar espacio disponible en /home

```bash
# Verificar espacio disponible en /home
df -h /home
# Filesystem      Size  Used Avail Use% Mounted on
# /dev/mapper/vg0-home   50G  2.0G   48G   4% /home

# Si /home no es un volumen dedicado o tiene menos de 30 GB, es CRÍTICO crear uno

# Verificar si /home está en un volumen LVM independiente
lsblk
lvs
```

#### Crear volumen LVM para /home (si no existe)

Si `/home` no está en un volumen LVM separado o no tiene suficiente espacio, ejecuta:

```bash
# PRECAUCIÓN: Estos comandos requieren conocimientos de LVM y pueden causar pérdida de datos
# Realiza un backup completo antes de proceder

# 1. Crear el volumen lógico (ajusta el tamaño según tu tabla de capacity planning)
sudo lvcreate -L 50G -n lv_home vg0

# 2. Formatear con XFS (recomendado para bases de datos)
sudo mkfs.xfs /dev/vg0/lv_home

# 3. Montar temporalmente y copiar datos existentes
sudo mkdir /mnt/new_home
sudo mount /dev/vg0/lv_home /mnt/new_home
sudo rsync -avxHAX /home/ /mnt/new_home/

# 4. Actualizar /etc/fstab
sudo nano /etc/fstab
# Añadir: /dev/mapper/vg0-lv_home  /home  xfs  defaults  0 0

# 5. Reiniciar o remontar
sudo umount /mnt/new_home
sudo mount -a
```

> **Recomendación de producción:** Planifica el dimensionamiento de `/home` durante la instalación inicial del servidor RHEL, no después del despliegue.

### 1.4 Preparar directorio de instalación con permisos restrictivos

```bash
# Crear directorio de instalación
sudo mkdir -p /opt/cmdb-enterprise-platform

# Asignar propiedad al usuario de servicio
sudo chown -R cmdb-admin:cmdb-admin /opt/cmdb-enterprise-platform

# Establecer permisos restrictivos (lectura/escritura/ejecución solo para el propietario)
sudo chmod -R 750 /opt/cmdb-enterprise-platform

# Verificar permisos
ls -ld /opt/cmdb-enterprise-platform
# drwxr-x--- 2 cmdb-admin cmdb-admin 4096 ... /opt/cmdb-enterprise-platform
```

### 1.5 Cambiar al usuario de servicio

**Todas las operaciones posteriores deben ejecutarse como `cmdb-admin`:**

```bash
# Cambiar al usuario de servicio
sudo su - cmdb-admin

# Verificar que estás en el usuario correcto
whoami
# cmdb-admin

# Verificar espacio disponible en tu directorio home
df -h ~
# Filesystem      Size  Used Avail Use% Mounted on
# /dev/mapper/vg0-lv_home   50G  2.0G   48G   4% /home

# Navegar al directorio de instalación
cd /opt/cmdb-enterprise-platform
```

> **Nota de seguridad:** A partir de este punto, NUNCA ejecutes comandos de Podman/Docker como root. Todo debe ejecutarse como `cmdb-admin`.

---

## 2. Prerrequisitos en el servidor RHEL

### Opción A: Podman Rootless (RECOMENDADO - ISO 27001)

**Podman Rootless** permite ejecutar contenedores sin privilegios de root, cumpliendo con los principios de mínimo privilegio.

```bash
# Verificar versión del SO
cat /etc/redhat-release

# Instalar Podman y podman-compose (RHEL 8/9 - ya viene preinstalado en RHEL 9)
sudo dnf install -y podman podman-compose

# Verificar instalación
podman --version
# Podman version 4.x.x o superior

# Crear alias para compatibilidad con docker-compose (OPCIONAL)
echo 'alias docker-compose="podman-compose"' >> ~/.bashrc
echo 'alias docker="podman"' >> ~/.bashrc
source ~/.bashrc

# Instalar git si no está disponible
sudo dnf install -y git

# Instalar openssl (para generar certificados y JWT secret)
sudo dnf install -y openssl
```

> **Nota importante:** En Podman Rootless, NO se requiere añadir el usuario a ningún grupo privilegiado.  
> Los contenedores se ejecutan en el espacio de usuario sin necesidad de `sudo`.

### Opción B: Docker Engine (Alternativa)

```bash
# Verificar versión del SO
cat /etc/redhat-release

# Instalar Docker Engine (RHEL 8/9)
sudo dnf install -y dnf-plugins-core
sudo dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo
sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Iniciar y habilitar Docker
sudo systemctl enable --now docker

# Añadir el usuario de servicio al grupo docker
sudo usermod -aG docker cmdb-admin
newgrp docker

# Verificar instalación
docker --version
docker compose version

# Instalar git y openssl
sudo dnf install -y git openssl
```

### Configuración de SELinux (RHEL)

```bash
# Verificar estado de SELinux
getenforce
# Enforcing (correcto)

# Los volúmenes en docker-compose.prod.yml ya incluyen el sufijo :Z
# que relabela los archivos para SELinux en modo Enforcing.
# NO es necesario desactivar SELinux.
```

---

## 3. Clonar el repositorio

> **Importante:** Ejecuta estos comandos como el usuario `cmdb-admin` (ver sección 1.4).

```bash
# Verificar que estás como cmdb-admin
whoami
# cmdb-admin

# Navegar al directorio de instalación (ya creado en sección 1.3)
cd /opt/cmdb-enterprise-platform

# Clonar el repositorio
git clone https://github.com/pirexia/cmdb-enterprise-platform.git .

# Verificar contenido y permisos
ls -la
# Los archivos deben pertenecer a cmdb-admin:cmdb-admin

# Verificar permisos del directorio padre
ls -ld /opt/cmdb-enterprise-platform
# drwxr-x--- ... cmdb-admin cmdb-admin
```

---

## 4. Configurar el entorno (.env)

```bash
# Copiar el template
cp .env.example .env

# Editar con valores de producción
nano .env

# Restringir permisos del archivo .env (solo lectura/escritura para el propietario)
chmod 600 .env

# Verificar permisos
ls -l .env
# -rw------- 1 cmdb-admin cmdb-admin ... .env
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

# ── Entorno de Aplicación ──────────────────────────────────────────────────
# CRÍTICO: Establecer APP_ENV=prod en producción para:
#   - Reducir verbosidad de logs (solo warn/error)
#   - Ocultar helpers de UI (cuentas de prueba en login)
APP_ENV=prod
NEXT_PUBLIC_APP_ENV=prod

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

## 5. Generar los certificados SSL

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

## 6. Preparar los volúmenes TLS

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

## 7. Construir y levantar los servicios

```bash
# Asegúrate de estar en el directorio correcto y como cmdb-admin
cd /opt/cmdb-enterprise-platform
whoami  # Debe mostrar: cmdb-admin

# Construir las imágenes (multi-stage, tarda ~3 minutos la primera vez)
docker compose -f docker-compose.prod.yml build --no-cache

# Levantar todos los servicios en background
docker compose -f docker-compose.prod.yml up -d

# Ver logs en tiempo real (ctrl+C para salir)
docker compose -f docker-compose.prod.yml logs -f
```

> **Nota para Podman Rootless:** Si usas Podman, reemplaza `docker compose` por `podman-compose` o usa el alias configurado en la sección 2.

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

## 8. Verificar el despliegue

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

## 9. Configurar el backup automático (cron)

```bash
# Hacer el script ejecutable
chmod +x /opt/cmdb-enterprise-platform/scripts/db-backup.sh

# Crear directorio de backups (como cmdb-admin)
mkdir -p /opt/cmdb-enterprise-platform/backups
chmod 750 /opt/cmdb-enterprise-platform/backups

# Probar el backup manualmente (debe crear un archivo .sql.gz)
BACKUP_DIR=/opt/cmdb-enterprise-platform/backups \
PG_CONTAINER=cmdb-postgres-prod \
POSTGRES_DB=cmdb_db \
POSTGRES_USER=cmdb_admin \
  bash /opt/cmdb-enterprise-platform/scripts/db-backup.sh

ls -lh /opt/cmdb-enterprise-platform/backups/

# Añadir al crontab del usuario cmdb-admin (NO usar sudo crontab)
crontab -e
```

Añade esta línea al crontab:

```cron
# CMDB Enterprise Platform — Database backup diario a las 02:00 AM
0 2 * * * BACKUP_DIR=/opt/cmdb-enterprise-platform/backups PG_CONTAINER=cmdb-postgres-prod POSTGRES_DB=cmdb_db POSTGRES_USER=cmdb_admin /opt/cmdb-enterprise-platform/scripts/db-backup.sh >> /home/cmdb-admin/cmdb-backup.log 2>&1
```

```bash
# Verificar que el cron quedó registrado (como cmdb-admin)
crontab -l | grep cmdb

# Crear el archivo de log
touch /home/cmdb-admin/cmdb-backup.log
chmod 640 /home/cmdb-admin/cmdb-backup.log

# Rotar los logs de backup (logrotate) - requiere permisos de root
sudo tee /etc/logrotate.d/cmdb-backup << 'EOF'
/home/cmdb-admin/cmdb-backup.log {
    weekly
    rotate 12
    compress
    missingok
    notifempty
    su cmdb-admin cmdb-admin
}
EOF
```

---

## 10. Configurar firewall (firewalld)

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

## 11. Actualización de la aplicación

```bash
# Ejecutar como cmdb-admin
whoami  # cmdb-admin
cd /opt/cmdb-enterprise-platform

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

## 12. Rollback rápido

Si el despliegue falla, vuelve al commit anterior:

```bash
# Ejecutar como cmdb-admin
cd /opt/cmdb-enterprise-platform

# Ver el historial de commits
git log --oneline -10

# Volver al commit anterior
git checkout <hash-del-commit-anterior>

# Reconstruir con la versión anterior
docker compose -f docker-compose.prod.yml build --no-cache
docker compose -f docker-compose.prod.yml up -d
```

---

## 13. Diagnóstico y resolución de problemas

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
