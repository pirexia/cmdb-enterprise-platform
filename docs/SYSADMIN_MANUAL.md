# 🔧 CMDB Enterprise Platform — Manual del Administrador de Sistemas

**Versión:** 1.1.0
**Público:** Equipo de Sistemas e Infraestructura (RHEL)
**Fecha:** 2026-03-31

---

## Índice

1. [Requisitos del Sistema](#1-requisitos-del-sistema)
2. [Despliegue Inicial](#2-despliegue-inicial)
3. [Configuración del archivo .env](#3-configuración-del-archivo-env)
   - [3b. Configuración LDAP / Active Directory](#3b-configuración-ldap--active-directory)
4. [Gestión de Certificados SSL/HTTPS](#4-gestión-de-certificados-sslhttps)
5. [Operaciones con Docker Compose](#5-operaciones-con-docker-compose)
6. [Backups y Restauración de la Base de Datos](#6-backups-y-restauración-de-la-base-de-datos)
7. [Gestión de Logs y Monitorización](#7-gestión-de-logs-y-monitorización)
8. [Actualización de la Aplicación](#8-actualización-de-la-aplicación)
9. [Troubleshooting](#9-troubleshooting)
10. [Configuración Avanzada de Podman (RHEL)](#10-configuración-avanzada-de-podman-rhel)
11. [Mantenimiento de Base de Datos](#11-mantenimiento-de-base-de-datos)
12. [Seguridad y Hardening](#12-seguridad-y-hardening)
13. [Tareas de Mantenimiento Periódico](#13-tareas-de-mantenimiento-periódico)

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

> **Seed automático:** En el primer arranque, el entrypoint del backend ejecuta `prisma migrate deploy` y, si no existe ningún usuario en la base de datos, lanza automáticamente el seed inicial (usuarios por defecto, CIs y contratos de ejemplo). En reinicios posteriores se detecta que ya hay usuarios y se omite el seed. No es necesario ningún paso manual de carga de datos.

### Paso 6: Verificar salud
```bash
curl http://localhost:3000/health
# Respuesta esperada: {"status":"ok","timestamp":"..."}
```

### Credenciales por defecto tras el seed
| Email | Contraseña | Rol |
|-------|-----------|-----|
| `admin@cmdb.local` | `Admin1234!` | ADMIN |
| `auditor@cmdb.local` | `Audit1234!` | VIEWER |

> ⚠️ Cambia las contraseñas inmediatamente tras el primer login en producción.

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
NEXT_PUBLIC_API_URL=https://cmdb.tudominio.com:3000

# ── Seguridad ──────────────────────────────────────────────────────────
HTTPS_ENABLED=true
CORS_ORIGINS=https://cmdb.tudominio.com:3001

# ── SMTP / Alertas ─────────────────────────────────────────────────────
SMTP_HOST=smtp.tudominio.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=cmdb-alerts@tudominio.com
SMTP_PASS=<contraseña-smtp>
ALERT_RECIPIENT=it-ops@tudominio.com
ALERT_WARN_DAYS=30
ALERT_CRON_SCHEDULE=30 8 * * *

# ── LDAP / Active Directory (Opcional) ────────────────────────────────
USE_LDAP=false
# USE_LDAP=true
# LDAP_URL=ldap://ad.tudominio.com:389
# LDAP_BIND_DN=CN=cmdb-svc,OU=Service Accounts,DC=tudominio,DC=com
# LDAP_BIND_PASSWORD=<contraseña-cuenta-servicio>
# LDAP_SEARCH_BASE=DC=tudominio,DC=com
# LDAP_TLS_REJECT_UNAUTHORIZED=0    # Solo si usas cert autofirmado interno
```

### Variables opcionales — Repositorio Documental

```bash
# ── Almacenamiento de Documentos ──────────────────────────────────────
# Ruta en el host donde se almacenan los archivos subidos.
# Si no se define, se usa el volumen Docker nombrado 'cmdb-documents'.
# Puede apuntar a una ruta local o a un montaje NFS.
DOCUMENTS_STORAGE_PATH=/var/lib/cmdb/documents
# DOCUMENTS_STORAGE_PATH=/mnt/nfs/cmdb-docs
```

> **Importante:** Si se define `DOCUMENTS_STORAGE_PATH`, el directorio debe existir en el host antes de arrancar los servicios y debe ser accesible (lectura/escritura) para el UID del proceso `node` dentro del contenedor (`UID 1000` en las imágenes Alpine estándar).

**Ejemplo con montaje NFS:**
```bash
# 1. Montar el share NFS (añadir a /etc/fstab para persistencia)
sudo mkdir -p /mnt/nfs/cmdb-docs
sudo mount -t nfs nfs-server.corp.local:/exports/cmdb-docs /mnt/nfs/cmdb-docs

# 2. Asignar permisos al UID del contenedor
sudo chown 1000:1000 /mnt/nfs/cmdb-docs

# 3. Configurar en .env
echo "DOCUMENTS_STORAGE_PATH=/mnt/nfs/cmdb-docs" >> .env
```

> El directorio de almacenamiento (bind mount o volumen nombrado) debe incluirse en la estrategia de backup junto con el volumen de PostgreSQL. Ver sección 6 para el procedimiento de backup.

### Generar secretos seguros
```bash
# JWT Secret (mínimo 48 caracteres)
openssl rand -base64 48

# Contraseña de base de datos (32 caracteres)
openssl rand -base64 32
```

---

## 3b. Configuración LDAP / Active Directory

> Esta sección amplía la configuración LDAP del apartado 3. Solo es necesaria si `USE_LDAP=true`.

### Variables de entorno

| Variable | Obligatoria | Descripción | Ejemplo |
|----------|-------------|-------------|---------|
| `USE_LDAP` | ✅ | Activa el conector LDAP | `true` |
| `LDAP_URL` | ✅ | URL del servidor LDAP o LDAPS | `ldap://dc.corp.local:389` |
| `LDAP_SEARCH_BASE` | ✅ | Base DN donde se buscan los usuarios | `dc=corp,dc=local` |
| `LDAP_BIND_DN` | Recomendada | DN de la cuenta de servicio | `cn=svc-cmdb,ou=ServiceAccounts,dc=corp,dc=local` |
| `LDAP_BIND_PASSWORD` | Recomendada | Contraseña de la cuenta de servicio | — |
| `LDAP_TLS_REJECT_UNAUTHORIZED` | Opcional | Poner `0` solo si el cert del DC es autofirmado | `0` |

### Estrategias de autenticación

El sistema aplica automáticamente la estrategia más segura disponible:

**Estrategia 1 — Admin bind + search (recomendada para AD corporativo):**
Se activa cuando `LDAP_BIND_DN` está configurado. La cuenta de servicio hace bind primero, luego busca al usuario por atributo `mail` (si el login es un email) o `uid`, y finalmente re-hace bind como ese usuario para verificar la contraseña.

```bash
# Ejemplo para Active Directory
USE_LDAP=true
LDAP_URL=ldap://dc01.corp.local:389
LDAP_BIND_DN=CN=svc-cmdb,OU=Service Accounts,DC=corp,DC=local
LDAP_BIND_PASSWORD=P@ssw0rd_Seguro
LDAP_SEARCH_BASE=OU=Empleados,DC=corp,DC=local
```

**Estrategia 2 — Direct user bind (fallback):**
Se usa cuando `LDAP_BIND_DN` está vacío. El sistema hace bind directamente con el email del usuario como UPN (`user@corp.local`), compatible con Active Directory. Para OpenLDAP construye `uid=<usuario>,<LDAP_SEARCH_BASE>`.

```bash
# Ejemplo mínimo (solo con UPN directo)
USE_LDAP=true
LDAP_URL=ldap://dc01.corp.local:389
LDAP_SEARCH_BASE=DC=corp,DC=local
```

### Configuración con LDAPS (TLS en puerto 636)

```bash
LDAP_URL=ldaps://dc01.corp.local:636
# Si el certificado del DC está firmado por una CA corporativa privada:
LDAP_TLS_REJECT_UNAUTHORIZED=0
```

> ⚠️ `LDAP_TLS_REJECT_UNAUTHORIZED=0` desactiva la verificación del certificado del servidor LDAP. Úsalo solo en entornos controlados con CA interna. En producción con CA pública, no es necesario.

### Comportamiento fail-safe y timeout

- El conector LDAP tiene un **timeout de 5 segundos**. Si el servidor AD no responde en ese tiempo, la autenticación cae automáticamente al path local (bcrypt) sin impacto para el usuario.
- Las cuentas `@cmdb.local` y `@cmdb.internal` **siempre** se autentican localmente, ignorando el servidor LDAP.
- Si LDAP falla y el usuario no existe en BD local, el login devuelve `Invalid credentials`.

### Aprovisionamiento automático de usuarios LDAP

En el primer login exitoso de un usuario corporativo:
1. Se crea un registro en la tabla `users` con rol `VIEWER`
2. El campo `sso_external_id` almacena el email corporativo — esto identifica la cuenta como de origen LDAP
3. La contraseña del registro es un hash aleatorio inutilizable (no es posible hacer login local con ella)

Para promover a un usuario LDAP a `ADMIN`, ve a **Configuración → Usuarios** en la interfaz web.

### Verificar la integración LDAP

```bash
# Probar conexión básica al DC desde el host
ldapsearch -x -H ldap://dc01.corp.local:389 \
  -D "CN=svc-cmdb,OU=Service Accounts,DC=corp,DC=local" \
  -w "P@ssw0rd_Seguro" \
  -b "DC=corp,DC=local" \
  "(mail=usuario@corp.local)"

# Verificar desde dentro del contenedor backend
docker exec cmdb-backend-prod node -e "
  process.env.LDAP_URL='ldap://dc01.corp.local:389';
  const {authenticateLDAP} = require('./dist/src/services/ldap');
  authenticateLDAP('usuario@corp.local','contraseña')
    .then(() => console.log('OK'))
    .catch(e => console.error('FAIL:', e.message));
"
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
  -subj   "/C=ES/ST=Madrid/O=TuEmpresa/CN=cmdb.tudominio.com"

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

### Cambio de Dominio Público y URL

Este procedimiento es necesario cuando la organización decide migrar la CMDB a un nuevo dominio (ej: `cmdb.empresa.com` → `assets.empresa.com`) o cambiar de HTTP a HTTPS.

> **⚠️ CRÍTICO:** Las variables `NEXT_PUBLIC_*` en Next.js se **bake** (inyectan) en el código del frontend durante la compilación. Cambiar estos valores en el `.env` sin recompilar el frontend **no tiene efecto**.

#### Paso 1: Generar certificado para el nuevo dominio (vía UI)

Si el cambio involucra un nuevo dominio con certificado SSL:

```bash
# 1. Acceder a la plataforma con la URL antigua
https://old-domain.com:3001

# 2. Ir al panel de Administración → Certificados SSL/TLS

# 3. Generar nuevo CSR:
#    - Common Name (CN): nuevo-dominio.empresa.com
#    - Organization, Country, etc.

# 4. Descargar el CSR generado

# 5. Enviar el CSR a tu CA corporativa para firma

# 6. Cuando recibas el certificado firmado (.crt/.pem), volver al panel

# 7. Subir el certificado firmado usando el formulario de upload

# 8. Anotar el comando de reinicio (lo ejecutarás en el Paso 4)
```

#### Paso 2: Actualizar registros DNS

Modificar los registros DNS de tu organización para que el nuevo dominio apunte a la IP del servidor RHEL:

```bash
# Ejemplo (depende de tu proveedor DNS):
# Tipo: A
# Nombre: nuevo-dominio.empresa.com
# Valor: 192.168.1.100 (IP del servidor cmdb-server)

# Verificar propagación DNS
dig nuevo-dominio.empresa.com +short
# Debe mostrar: 192.168.1.100

nslookup nuevo-dominio.empresa.com
```

#### Paso 3: Modificar variables de entorno

Acceder al servidor vía SSH como `cmdb-admin`:

```bash
# Conectar al servidor
ssh cmdb-admin@cmdb-server

# Navegar al directorio de instalación
cd /opt/cmdb-enterprise-platform

# Editar el archivo .env
nano .env
```

Actualizar **obligatoriamente** las siguientes variables:

```bash
# ── Frontend ──────────────────────────────────────────────────────────
# URL del backend tal como la ve el NAVEGADOR del usuario
NEXT_PUBLIC_API_URL=https://nuevo-dominio.empresa.com:3000

# ── Seguridad ─────────────────────────────────────────────────────────
# Lista de orígenes permitidos (CORS) — separados por coma
CORS_ORIGINS=https://nuevo-dominio.empresa.com:3001,https://nuevo-dominio.empresa.com:3000
```

Guardar y salir (Ctrl+O, Enter, Ctrl+X).

#### Paso 4: Reconstruir el contenedor del frontend

> **OBLIGATORIO:** Next.js inyecta las variables `NEXT_PUBLIC_*` en **build time**, no en runtime. Sin rebuild, el frontend seguirá usando la URL antigua.

```bash
# Como cmdb-admin, desde /opt/cmdb-enterprise-platform

# 1. Reconstruir solo el frontend (incluye las nuevas variables del .env)
docker compose -f docker-compose.prod.yml build frontend --no-cache

# 2. Reiniciar el backend para cargar el nuevo CORS_ORIGINS
docker compose -f docker-compose.prod.yml restart backend

# 3. Reiniciar el frontend con la imagen reconstruida
docker compose -f docker-compose.prod.yml up -d frontend

# 4. Verificar que los contenedores están corriendo
docker compose -f docker-compose.prod.yml ps
```

#### Paso 5: Verificación post-migración

```bash
# 1. Verificar que el backend responde desde la nueva URL
curl -k https://nuevo-dominio.empresa.com:3000/health
# Respuesta esperada: {"status":"ok","timestamp":"..."}

# 2. Verificar headers de seguridad
curl -sI https://nuevo-dominio.empresa.com:3000/health | grep -i "x-frame\|cors"

# 3. Verificar el certificado SSL
openssl s_client -connect nuevo-dominio.empresa.com:3000 -showcerts 2>/dev/null | openssl x509 -noout -subject -dates
# Verificar que el CN coincide con el nuevo dominio
```

#### Paso 6: Acceso desde el navegador

1. **Limpiar la caché del navegador** (Ctrl+Shift+Delete o Cmd+Shift+Delete)
2. Acceder a la nueva URL: `https://nuevo-dominio.empresa.com:3001`
3. Iniciar sesión normalmente
4. Verificar que todas las funciones operan correctamente (inventario, integraciones, etc.)

#### Checklist de migración de dominio

- [ ] Certificado SSL generado para el nuevo dominio y subido
- [ ] Registros DNS actualizados y propagados (verificar con `dig`)
- [ ] Variables `NEXT_PUBLIC_API_URL` y `CORS_ORIGINS` actualizadas en `.env`
- [ ] Frontend reconstruido con `--no-cache`
- [ ] Backend reiniciado para cargar nuevo CORS
- [ ] Contenedores verificados (`docker compose ps`)
- [ ] Health check exitoso desde la nueva URL
- [ ] Certificado SSL verificado (CN correcto)
- [ ] Caché del navegador limpiada
- [ ] Login y funciones críticas testeadas
- [ ] Usuarios finales notificados del cambio de URL

> **Downtime estimado:** 2-5 minutos (tiempo de rebuild del frontend). Planificar en ventana de mantenimiento o fuera de horario laboral.

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
curl http://cmdb-server:3000/health

# Si usa HTTPS, verificar el certificado
curl -k https://cmdb-server:3000/health

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

## 10. Configuración Avanzada de Podman (RHEL)

Esta sección documenta configuraciones específicas de Podman Rootless en entornos RHEL que pueden ser necesarias para resolver problemas de estabilidad.

### 10.1 Gestor de cgroups: cgroupfs vs systemd

Por defecto, Podman en RHEL utiliza `systemd` como gestor de cgroups. Sin embargo, en versiones específicas de RHEL/Podman (especialmente RHEL 8.x con Podman 3.x-4.x), se pueden presentar problemas de bloqueo al intentar eliminar o reiniciar contenedores cuando hay dependencias de red activas.

**Síntomas comunes:**
- Comandos `podman rm` o `podman-compose down` se quedan colgados indefinidamente
- Contenedores en estado "stopping" que nunca terminan
- Errores relacionados con `cni` o `netavark` al gestionar redes
- Timeouts al intentar eliminar contenedores con `podman-compose`

**Solución:** Forzar el uso de `cgroupfs` como gestor de cgroups.

### 10.2 Configurar cgroupfs en Podman Rootless

```bash
# Crear el directorio de configuración de Podman si no existe
mkdir -p ~/.config/containers

# Crear o editar el archivo de configuración
nano ~/.config/containers/containers.conf
```

Añade o modifica las siguientes líneas en el archivo:

```ini
[engine]
# Forzar el uso de cgroupfs en lugar de systemd
cgroup_manager = "cgroupfs"

# Opcional: Ajustar el número de eventos que Podman puede procesar
# Útil si tienes muchos contenedores
events_logger = "file"

# Opcional: Tiempo de espera para detener contenedores (segundos)
stop_timeout = 30
```

Guarda el archivo y verifica la configuración:

```bash
# Verificar configuración actual
podman info | grep -i cgroup
# Debe mostrar: cgroupManager: cgroupfs

# Si los cambios no se aplican, reinicia el servicio de Podman
podman system reset --force  # ⚠️ ADVERTENCIA: Esto elimina todos los contenedores e imágenes
# Alternativa: cerrar sesión y volver a iniciar
```

### 10.3 Configuración recomendada completa

Archivo `~/.config/containers/containers.conf` completo para entornos de producción:

```ini
[containers]
# Logs por defecto (json-file, journald, k8s-file)
log_driver = "journald"

# Tamaño máximo de logs por contenedor (ej: 10mb, 100mb)
log_size_max = "50mb"

[engine]
# Gestor de cgroups (cgroupfs recomendado para RHEL 8.x con Podman < 4.5)
cgroup_manager = "cgroupfs"

# Backend de red (cni o netavark)
# netavark es más moderno pero puede tener issues en RHEL 8.x
network_backend = "cni"

# Logger de eventos
events_logger = "file"

# Tiempo de espera para detener contenedores (segundos)
stop_timeout = 30

# Runtime por defecto (crun es más rápido que runc)
runtime = "crun"

[network]
# Rango de subnet por defecto para redes de Podman
default_subnet = "10.89.0.0/16"
```

### 10.4 Verificar y aplicar cambios

```bash
# Ver configuración activa de Podman
podman info --format json | jq '.host.cgroupManager, .host.networkBackend'

# Reiniciar servicios de Podman sin eliminar datos (Podman 4.3+)
systemctl --user restart podman.socket

# Si los cambios no se aplican, reset completo (elimina contenedores)
podman system reset --force
# Luego volver a desplegar desde docker-compose.prod.yml
```

### 10.5 Troubleshooting: Contenedores bloqueados

Si después de cambiar a `cgroupfs` sigues teniendo contenedores que no se eliminan:

```bash
# Listar contenedores en todos los estados
podman ps -a

# Forzar eliminación de un contenedor específico
podman rm -f <container-id>

# Si persiste el bloqueo, matar el proceso del contenedor
podman inspect <container-id> | grep Pid
kill -9 <pid>

# Última opción: limpiar todo el sistema de Podman
podman system prune -a --volumes --force
podman system reset --force
```

### 10.6 Cuándo usar cgroupfs vs systemd

| Gestor | Ventajas | Desventajas | Cuándo usar |
|--------|----------|-------------|-------------|
| **systemd** | Integración con systemd, mejor para servicios del sistema | Puede causar bloqueos en RHEL 8.x, requiere cgroups v2 | RHEL 9+ con Podman 4.5+ |
| **cgroupfs** | Mayor compatibilidad, menos bloqueos en redes | No integra con systemd, menos "limpio" | RHEL 8.x, Podman < 4.5, problemas de estabilidad |

**Recomendación para producción ISO 27001:**
- **RHEL 8.x con Podman 3.x-4.4:** Usar `cgroupfs`
- **RHEL 9.x con Podman 4.5+:** Usar `systemd` (default)
- **Si tienes bloqueos frecuentes:** Cambiar a `cgroupfs` independientemente de la versión

---

## 11. Mantenimiento de Base de Datos

PostgreSQL utiliza MVCC (Multi-Version Concurrency Control) que genera "tuplas muertas" con cada UPDATE/DELETE. Sin mantenimiento regular, la base de datos puede sufrir degradación de rendimiento y consumo excesivo de disco.

### 11.1 Purgado automático de audit logs (Backend)

El backend ejecuta automáticamente un purge diario de registros de auditoría antiguos para evitar crecimiento infinito de la tabla `audit_logs`.

**Configuración:**

```bash
# En .env o como variable de entorno
AUDIT_RETENTION_DAYS=365    # Default: 365 días (1 año)
                            # Set a 0 para deshabilitar el purge automático
```

**Cron interno del backend:**
- **Horario:** 03:00 AM diario (timezone: Europe/Madrid)
- **Acción:** Elimina registros con `created_at` anterior a `AUDIT_RETENTION_DAYS`
- **Log de ejemplo:**
  ```
  [AuditPurgeCron] [INFO] Deleted 1523 audit log record(s) older than 365 days
  ```

**Verificar estado del purge:**

```bash
# Ver logs del backend
docker logs cmdb-backend-prod --tail 100 | grep AuditPurgeCron

# Verificar registros en la tabla audit_logs
docker exec cmdb-postgres-prod psql -U cmdb_admin -d cmdb_db -c "
  SELECT COUNT(*) AS total,
         MIN(created_at) AS oldest,
         MAX(created_at) AS newest
  FROM audit_logs;
"
```

### 11.2 Optimización de base de datos (Script de mantenimiento)

El script `scripts/db-maintenance.sh` ejecuta rutinas de optimización PostgreSQL:

- **VACUUM ANALYZE** (no bloqueante): Recupera espacio de tuplas muertas y actualiza estadísticas del planificador
- **REINDEX DATABASE** (bloqueante): Reconstruye índices para eliminar bloat

**Ejecución manual:**

```bash
# Como usuario cmdb-admin
POSTGRES_DB=cmdb_db \
POSTGRES_USER=cmdb_admin \
PG_CONTAINER=cmdb-postgres-prod \
  bash /opt/cmdb-enterprise-platform/scripts/db-maintenance.sh
```

**Salida esperada:**

```
[2026-03-19 03:00:15] Starting PostgreSQL maintenance for database: cmdb_db
[2026-03-19 03:00:15] Running VACUUM ANALYZE (non-blocking)...
[2026-03-19 03:00:18] ✓ VACUUM ANALYZE completed successfully
[2026-03-19 03:00:18] Running REINDEX DATABASE (blocking — avoid during business hours)...
[2026-03-19 03:00:22] ✓ REINDEX DATABASE completed successfully
[2026-03-19 03:00:22] Maintenance completed successfully
```

### 11.3 Programar mantenimiento automático (Crontab)

**Recomendación:** Ejecutar el script semanalmente (domingos a las 03:00 AM) cuando no hay actividad de usuarios.

```bash
# Editar crontab del usuario cmdb-admin
crontab -e
```

Añadir la siguiente entrada:

```cron
# CMDB Database Maintenance — Domingos a las 03:00 AM
0 3 * * 0 POSTGRES_DB=cmdb_db POSTGRES_USER=cmdb_admin PG_CONTAINER=cmdb-postgres-prod /opt/cmdb-enterprise-platform/scripts/db-maintenance.sh >> /home/cmdb-admin/db-maintenance.log 2>&1
```

**Verificar que el cron se registró correctamente:**

```bash
crontab -l | grep db-maintenance

# Ver logs de ejecución
tail -f /home/cmdb-admin/db-maintenance.log
```

### 11.4 VACUUM FULL (Solo en ventanas de mantenimiento)

> **⚠️ ADVERTENCIA: VACUUM FULL bloquea completamente las tablas durante su ejecución.**

El script `db-maintenance.sh` NO incluye `VACUUM FULL` automáticamente porque:
- Requiere locks exclusivos (READ y WRITE bloqueados)
- Puede tardar horas en bases de datos grandes (> 20,000 CIs)
- Solo es necesario si el bloat es > 50% del tamaño de la tabla

**Cuándo ejecutar VACUUM FULL:**

```bash
# Verificar bloat de tablas (% de espacio desperdiciado)
docker exec cmdb-postgres-prod psql -U cmdb_admin -d cmdb_db -c "
  SELECT
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename) - pg_relation_size(schemaname||'.'||tablename)) AS bloat
  FROM pg_tables
  WHERE schemaname = 'public'
  ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
  LIMIT 10;
"
```

**Ejecutar VACUUM FULL manualmente (durante ventana de mantenimiento programada):**

```bash
# 1. Anunciar downtime a usuarios
# 2. Detener el frontend (evita nuevas conexiones)
docker compose -f docker-compose.prod.yml stop frontend

# 3. Ejecutar VACUUM FULL
docker exec cmdb-postgres-prod psql -U cmdb_admin -d cmdb_db -c "VACUUM FULL VERBOSE;"

# 4. Reiniciar servicios
docker compose -f docker-compose.prod.yml start frontend
```

### 11.5 Monitorización de rendimiento

```bash
# Tamaño de la base de datos
docker exec cmdb-postgres-prod psql -U cmdb_admin -d cmdb_db -c "
  SELECT pg_size_pretty(pg_database_size('cmdb_db')) AS db_size;
"

# Tablas más grandes
docker exec cmdb-postgres-prod psql -U cmdb_admin -d cmdb_db -c "
  SELECT
    tablename,
    pg_size_pretty(pg_total_relation_size('public.'||tablename)) AS total_size,
    pg_size_pretty(pg_relation_size('public.'||tablename)) AS table_size,
    pg_size_pretty(pg_indexes_size('public.'||tablename)) AS indexes_size
  FROM pg_tables
  WHERE schemaname = 'public'
  ORDER BY pg_total_relation_size('public.'||tablename) DESC
  LIMIT 10;
"

# Actividad de VACUUM y ANALYZE
docker exec cmdb-postgres-prod psql -U cmdb_admin -d cmdb_db -c "
  SELECT
    schemaname,
    relname,
    last_vacuum,
    last_autovacuum,
    last_analyze,
    last_autoanalyze
  FROM pg_stat_user_tables
  ORDER BY last_vacuum DESC NULLS LAST
  LIMIT 10;
"
```

### 11.6 Checklist de mantenimiento

| Tarea | Frecuencia | Automatizado | Comando |
|-------|-----------|--------------|---------|
| Audit log purge | Diario (03:00 AM) | ✅ Sí (backend cron) | Automático via `AUDIT_RETENTION_DAYS` |
| VACUUM ANALYZE | Semanal (domingos 03:00 AM) | ⚠️ Configurar crontab | `bash scripts/db-maintenance.sh` |
| REINDEX DATABASE | Semanal (domingos 03:00 AM) | ⚠️ Configurar crontab | Incluido en `db-maintenance.sh` |
| VACUUM FULL | Anual (ventana mantenimiento) | ❌ Manual | `VACUUM FULL;` |
| Verificar bloat | Mensual | ❌ Manual | Query en sección 11.4 |
| Backup BD | Diario (02:00 AM) | ✅ Sí (si configurado) | Ver sección 6 |

---

## 12. Seguridad y Hardening

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

### Usuario de servicio dedicado (ISO 27001)

**Principio de mínimo privilegio:** Nunca ejecutar servicios de producción como root o con usuarios personales.

```bash
# Verificar que los contenedores se ejecutan como usuario no privilegiado
podman ps --format "{{.ID}} {{.Names}}" | while read id name; do
  echo "Container: $name"
  podman inspect $id | jq -r '.HostConfig.UsernsMode'
done

# Verificar que el usuario tiene linger habilitado (persistencia)
loginctl show-user cmdb-admin | grep Linger
# Debe mostrar: Linger=yes

# Si no está habilitado, activarlo
sudo loginctl enable-linger cmdb-admin
```

### Permisos de archivos y directorios

```bash
# Verificar permisos del directorio de instalación
ls -ld /opt/cmdb-enterprise-platform
# Correcto: drwxr-x--- ... cmdb-admin cmdb-admin

# Verificar permisos del archivo .env (debe ser 600)
ls -l /opt/cmdb-enterprise-platform/.env
# Correcto: -rw------- ... cmdb-admin cmdb-admin

# Verificar permisos del directorio de backups
ls -ld /opt/cmdb-enterprise-platform/backups
# Correcto: drwxr-x--- ... cmdb-admin cmdb-admin

# Corregir permisos si es necesario
sudo chown -R cmdb-admin:cmdb-admin /opt/cmdb-enterprise-platform
sudo chmod 750 /opt/cmdb-enterprise-platform
chmod 600 /opt/cmdb-enterprise-platform/.env
```

---

## 13. Tareas de Mantenimiento Periódico

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
