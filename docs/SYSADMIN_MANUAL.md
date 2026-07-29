# 🔧 CMDB Enterprise Platform — Manual del Administrador de Sistemas

**Versión:** 1.2.0
**Público:** Equipo de Sistemas e Infraestructura (RHEL) — incluye `scripts/install.sh`, `scripts/update.sh`
**Fecha:** 2026-04-07

---

## Índice

0. [Inicio Rápido (3 comandos)](#0-inicio-rápido-3-comandos)
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
14. [Despliegue en OpenShift / Kubernetes](#14-despliegue-en-openshift--kubernetes)
15. [Configuración de SSO con Microsoft 365 (Azure AD)](#15-configuración-de-sso-con-microsoft-365-azure-ad)
16. [Borrado de Usuarios (GDPR Art. 17)](#16-borrado-de-usuarios-gdpr-art-17)
17. [LDAP_STRICT_MODE](#17-ldap_strict_mode)
18. [Aviso de Privacidad y Obligaciones GDPR Art. 13/14](#18-aviso-de-privacidad-y-obligaciones-gdpr-art-1314)
19. [Subsistema RAG — Operación y mantenimiento](#19-subsistema-rag--operación-y-mantenimiento)
20. [Backups — consideraciones de cifrado para RAG](#20-backups--consideraciones-de-cifrado-para-rag)
21. [RAG — Rendimiento e inferencia con GPU (opcional)](#21-rag--rendimiento-e-inferencia-con-gpu-opcional)

---

## 0. Inicio Rápido (3 comandos)

Para la mayoría de las instalaciones nuevas, tres comandos son suficientes:

```bash
# 1. Clonar el repositorio
git clone https://github.com/pirexia/cmdb-enterprise-platform.git /opt/cmdb && cd /opt/cmdb

# 2. Ejecutar el instalador guiado
#    (detecta el SO, verifica requisitos, solicita URL/contraseñas/TLS y arranca la plataforma)
bash scripts/install.sh

# 3. Abrir el navegador
# Plataforma (frontend + API via nginx): https://<tu-servidor>/
# Login por defecto: admin@cmdb.local / Admin1234! — CAMBIAR INMEDIATAMENTE
```

> **Arquitectura:** nginx en `:443` actúa como gateway único. Enruta `/` → frontend y `/api/*` → backend. Solo nginx expone puertos al host (443 y 80). Frontend y backend son contenedores internos de Docker.

> Para control detallado sobre cada paso, o para entornos con requisitos especiales, consulta la [Sección 2](#2-despliegue-inicial).

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

### Versiones del stack de la plataforma

| Componente | Versión | EOL          | Licencia            |
|------------|---------|--------------|---------------------|
| Node.js    | 22 LTS  | Abr 2027     | MIT                 |
| PostgreSQL | 15/16   | Nov 2027/28  | PostgreSQL License  |
| nginx      | 1.30    | —            | BSD-2-Clause        |
| Next.js    | 16      | —            | MIT                 |
| Express    | 5       | —            | MIT                 |
| Prisma     | 5       | —            | Apache 2.0          |

### Configuración nginx

El gateway TLS nginx se configura en:
- **Configuración principal:** `nginx/nginx.conf`
- **Virtual hosts:** `nginx/conf.d/`
- **Certificados TLS:** `./certs/` (montado en solo lectura para nginx, lectura-escritura para el backend)
- La variable `NGINX_VERSION` en docker-compose alimenta el panel de Información del Sistema en la UI.

---

## 2. Despliegue Inicial

> **Recomendado: Instalación automatizada**
> Ejecuta `sudo bash scripts/install.sh` — detecta el SO, verifica requisitos, lanza el asistente de configuración y arranca la plataforma automáticamente. El instalador registra todo en `/opt/cmdb/logs/install_<timestamp>.log`.

Los pasos siguientes documentan el **despliegue manual avanzado** para entornos con requisitos específicos o donde no se pueda usar el instalador interactivo.

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

### Paso 3: Generar certificados SSL
```bash
bash backend/scripts/generate-certs.sh
# Resultado: certs/server.key y certs/server.crt (RSA 4096-bit, en la raíz del proyecto)
```

### Paso 4: Preparar volumen TLS (producción)
```bash
docker volume create cmdb-tls-certs
docker run --rm \
  -v cmdb-tls-certs:/dest \
  -v $(pwd)/certs:/src:ro \
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
curl -sk https://localhost/api/health
# Respuesta esperada: {"status":"ok","timestamp":"..."}
# La petición pasa por nginx (puerto 443) → backend (puerto 3000 interno)
```

### Credenciales por defecto tras el seed
| Email | Contraseña | Rol |
|-------|-----------|-----|
| `admin@cmdb.local` | `Admin1234!` | ADMIN |
| `auditor@cmdb.local` | `Audit1234!` | AUDITOR |

> ⚠️ Cambia las contraseñas inmediatamente tras el primer login en producción.

---

## 3. Configuración del archivo .env

### Variables obligatorias en producción

El `.env` solo requiere **6 variables obligatorias**. Todo lo demás tiene valores por defecto seguros en el código.

```bash
# ── Base de Datos ──────────────────────────────────────────────────────
POSTGRES_PASSWORD=<min-32-chars>      # Generar: openssl rand -base64 32

# ── Seguridad ──────────────────────────────────────────────────────────
JWT_SECRET=<min-48-chars>             # Generar: openssl rand -base64 48

# ── URLs (nginx sirve frontend Y API en el mismo host/puerto) ──────────
NEXT_PUBLIC_API_URL=https://cmdb.tudominio.com   # URL pública (sin puerto, nginx usa 443)
FRONTEND_URL=https://cmdb.tudominio.com          # Misma URL — usada para SSO y CORS

# ── Marca ──────────────────────────────────────────────────────────────
NEXT_PUBLIC_COMPANY_NAME=Mi Empresa

# ── Almacenamiento Documental ──────────────────────────────────────────
DOCUMENTS_STORAGE_PATH=./document-storage

# ── SMTP / Alertas (Opcional — dejar vacío para deshabilitar) ──────────
SMTP_HOST=smtp.tudominio.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=cmdb-alerts@tudominio.com
SMTP_PASS=<contraseña-smtp>
ALERT_RECIPIENT=it-ops@tudominio.com

# ── LDAP / Active Directory (Opcional) ────────────────────────────────
USE_LDAP=false
LDAP_URL=
LDAP_BASE_DN=
LDAP_BIND_DN=
LDAP_BIND_PASSWORD=
```

> **Nota (v2.2.0+):** El tema visual (colores de sidebar y acento, logo, nombre de empresa) se configura desde el panel de administración en **Ajustes → Apariencia**. La variable `NEXT_PUBLIC_COMPANY_NAME` sigue siendo el valor inicial usado durante la primera instalación, pero todos los cambios posteriores se realizan desde la interfaz sin necesidad de rebuild.

### Puertos de nginx (variables opcionales)

Por defecto nginx escucha en los puertos estándar 443 (HTTPS) y 80 (HTTP→redirect). Si el servidor ya tiene otra aplicación en esos puertos, se pueden cambiar añadiendo estas variables al `.env`:

```bash
# ── Puertos nginx (host → contenedor) ────────────────────────────────
# El puerto interno del contenedor no cambia (siempre 443/80).
# Solo se modifica el puerto expuesto en el host.
NGINX_HTTPS_PORT=8443   # Ejemplo: acceso en https://cmdb.ejemplo.com:8443
NGINX_HTTP_PORT=8080    # Ejemplo: redirect HTTP en puerto 8080

# Si se usan puertos no estándar, actualizar también PUBLIC_URL:
# NEXT_PUBLIC_API_URL=https://cmdb.ejemplo.com:8443
# FRONTEND_URL=https://cmdb.ejemplo.com:8443
```

> **Nota Podman rootless:** Si los puertos elegidos son < 1024, el kernel de RHEL 9 requiere `net.ipv4.ip_unprivileged_port_start` ajustado. El instalador detecta este caso y guía al administrador. Usar puertos ≥ 1024 (ej. 8443/8080) evita este requisito.

### Variables opcionales — Repositorio Documental

El Repositorio Documental almacena **todos los tipos de fichero** gestionados por la plataforma: contratos, adendas, licencias, documentos técnicos, ofertas y cualquier tipo personalizado. Todos comparten el mismo directorio de almacenamiento en disco.

```bash
# ── Almacenamiento de Documentos ──────────────────────────────────────
# Ruta en el host donde se almacenan los archivos subidos.
# Valor por defecto: ./document-storage (relativo al directorio del proyecto).
# Puede apuntar a una ruta local absoluta o a un montaje NFS/CIFS.
DOCUMENTS_STORAGE_PATH=./document-storage
# DOCUMENTS_STORAGE_PATH=/data/cmdb/documents      # ruta absoluta local
# DOCUMENTS_STORAGE_PATH=/mnt/nfs/cmdb-docs        # montaje NFS
```

> **Importante:** El directorio debe existir en el host antes de arrancar los servicios y debe ser accesible (lectura/escritura) para el UID `1000` (usuario `node` de las imágenes Alpine). El contenedor **no** crea el directorio padre automáticamente.

#### Carga masiva de documentos (staging + análisis IA)

La carga masiva permite subir varios documentos a la vez; un *worker* en segundo plano (sobre el mismo cron RAG, cada 30 s) los analiza con Ollama para sugerir tipo, fechas de vigencia, proveedor, número y CIs asociados antes de que el usuario los confirme. Los ficheros subidos se guardan **temporalmente** en un subdirectorio de staging (`_staging/` dentro del almacenamiento de documentos) y **solo** se materializan como documentos/contratos/licencias reales al confirmar cada línea.

```bash
# ── Carga masiva (bulk import) ────────────────────────────────────────
# BULK_MAX_FILES=20         # nº máx. de ficheros por lote
# BULK_MAX_TOTAL_MB=200     # tamaño total máx. por lote (MB). Cada fichero mantiene MAX_DOCUMENT_SIZE_MB.
# BULK_BATCH_TTL_HOURS=24   # antigüedad tras la cual un lote abandonado se descarta automáticamente
# BULK_ANALYZE_BUDGET=2     # documentos analizados por IA por ciclo (30 s); bajo = no satura la cola RAG en CPU
# BULK_STAGING_DIR=/app/documents/_staging   # ubicación del área temporal (por defecto, subdir de DOCUMENTS_DIR)

# ── Carga masiva de CIs (XLSX) — análisis concurrente ─────────────────
# CI_BULK_CONCURRENCY=3      # nº de items CI analizados en paralelo (1..5). Default 3.
                              # El análisis CI es ligero (sin OCR); 3 hilos saturan Ollama
                              # sin afectar al resto. Subir a 5 solo con >=8 cores.
```

> **Limpieza automática:** un cron horario descarta los lotes con antigüedad superior a `BULK_BATCH_TTL_HOURS` y borra sus ficheros de staging, evitando que el área temporal crezca sin control (ISO 22301 / NIS2). Los documentos ya confirmados (materializados) **no** se ven afectados.
>
> **Rendimiento documentos:** el análisis IA de documentos es secuencial y limitado por CPU (uno a la vez para evitar saturar Ollama con OCR + Ollama simultáneos). Un lote grande puede tardar varios minutos por documento. Con GPU la latencia baja drásticamente (ver §21 — RAG / GPU). `BULK_ANALYZE_BUDGET` controla cuántos documentos compiten por Ollama en cada ciclo frente a la indexación RAG normal.
>
> **Rendimiento CIs:** la importación masiva de CIs procesa hasta `CI_BULK_CONCURRENCY` filas en paralelo (default 3). Cuando un análisis termina, el siguiente arranca de inmediato (no en lotes), lo que reduce drásticamente el tiempo total para lotes grandes.
>
> **OCR para escaneados:** los PDFs escaneados (sin texto digital) se reconocen automáticamente por OCR (Tesseract), igual que en la subida individual — el worker usa el mismo `parseDocument`. El OCR rasteriza cada página (`OCR_DPI`) y la pasa por Tesseract (`OCR_LANGUAGES`), lo que **suma tiempo** por documento en CPU (p. ej. ~3-4 min para un PDF escaneado de 20+ páginas). Requiere `tesseract-ocr` + `poppler-utils` en la imagen del backend (ya incluidos). Ajusta `OCR_ENABLED`/`OCR_DPI`/`OCR_LANGUAGES`/`OCR_TIMEOUT_MS` según necesidad.

#### Preparar el directorio en instalación nueva

```bash
# Opción A — ruta local
sudo mkdir -p /data/cmdb/documents
sudo chown 1000:1000 /data/cmdb/documents
sudo chmod 750 /data/cmdb/documents

# Añadir al .env
echo "DOCUMENTS_STORAGE_PATH=/data/cmdb/documents" >> .env
```

#### Configurar un montaje NFS

```bash
# 1. Crear el punto de montaje
sudo mkdir -p /mnt/nfs/cmdb-docs

# 2. Montar el share (añadir a /etc/fstab para persistencia al reinicio)
#    nfs-server.corp.local:/exports/cmdb-docs  /mnt/nfs/cmdb-docs  nfs  defaults,_netdev  0  0
sudo mount -t nfs nfs-server.corp.local:/exports/cmdb-docs /mnt/nfs/cmdb-docs

# 3. Asignar permisos al UID del contenedor
sudo chown 1000:1000 /mnt/nfs/cmdb-docs

# 4. Configurar en .env
echo "DOCUMENTS_STORAGE_PATH=/mnt/nfs/cmdb-docs" >> .env

# 5. Reiniciar el backend para que tome el nuevo bind mount
docker compose -f docker-compose.prod.yml up -d backend
```

#### Migrar a un nuevo volumen (post-instalación)

Cuando se decide mover el almacenamiento a una ruta diferente (p.ej. de local a NFS):

```bash
# 1. Detener el backend (evitar escrituras durante la copia)
docker compose -f docker-compose.prod.yml stop backend

# 2. Copiar todos los ficheros al nuevo destino preservando permisos
sudo rsync -av --progress \
  "${DOCUMENTS_STORAGE_PATH:-./document-storage}/" \
  /ruta/nueva/

# 3. Verificar recuento de ficheros (deben coincidir)
find "${DOCUMENTS_STORAGE_PATH:-./document-storage}" -type f | wc -l
find /ruta/nueva -type f | wc -l

# 4. Ajustar permisos en el destino
sudo chown -R 1000:1000 /ruta/nueva

# 5. Actualizar .env
sed -i "s|^DOCUMENTS_STORAGE_PATH=.*|DOCUMENTS_STORAGE_PATH=/ruta/nueva|" .env

# 6. Arrancar el backend con el nuevo bind mount
docker compose -f docker-compose.prod.yml up -d backend

# 7. Verificar carga de un documento en la UI antes de eliminar la ruta anterior
# 8. Una vez confirmado, eliminar la ruta antigua (solo si era local):
#    sudo rm -rf /ruta/antigua
```

> El directorio de almacenamiento debe incluirse en la estrategia de backup junto con el volumen de PostgreSQL. Ver sección 6 para el procedimiento de backup.

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
| `LDAP_UPN_SUFFIX` | Opcional | Sufijo UPN del dominio AD (habilita login `usuario@sufijo`) | `azkar.com` |
| `LDAP_NETBIOS_DOMAIN` | Opcional | Nombre NetBIOS del dominio (solo informativo, no bloquea el login) | `AZKARAD` |

### Formatos de login soportados (desde v3.5.6)

Un usuario de AD puede autenticarse con cualquiera de estos formatos; el sistema resuelve siempre la misma fila de base de datos, indexada internamente por el `sAMAccountName` que devuelve el propio directorio tras el bind (nunca por lo que el usuario tecleó):

| Formato | Ejemplo | Atributo LDAP consultado |
|---------|---------|---------------------------|
| sAMAccountName (usuario AD) | `andres.matias` | `sAMAccountName` |
| UPN | `andres.matias@azkar.com` | `userPrincipalName` (requiere `LDAP_UPN_SUFFIX`) |
| NetBIOS | `AZKARAD\andres.matias` | `sAMAccountName` (la parte tras la `\`) |
| Email (retrocompatible) | `andres.matias@dachser.com` | `mail` |
| Cuenta local CMDB | `admin@cmdb.local` | — (bcrypt local, no consulta AD) |

Si `LDAP_UPN_SUFFIX` no está configurado, el formato `usuario@dominio-ad` se trata como email (`mail`) en vez de UPN.

### Estrategias de autenticación

El sistema aplica automáticamente la estrategia más segura disponible:

**Estrategia 1 — Admin bind + search (recomendada para AD corporativo):**
Se activa cuando `LDAP_BIND_DN` está configurado. La cuenta de servicio hace bind primero, luego busca al usuario por el atributo LDAP correspondiente al formato tecleado (`sAMAccountName`, `userPrincipalName` o `mail` — ver tabla anterior), y finalmente re-hace bind como ese usuario para verificar la contraseña.

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

> Los certificados TLS los gestiona **nginx**. Se almacenan en `./certs/` (raíz del proyecto) y se montan en el volumen Docker `cmdb-tls-certs`. La UI de administración en **Admin → Certificados** permite generar CSR y subir certificados firmados directamente desde el navegador.

### 4.1 Generar certificado autofirmado (intranet)
```bash
bash backend/scripts/generate-certs.sh
# Crea: certs/server.key (privado, RSA 4096-bit) y certs/server.crt (público)
# Validez: 10 años
```

### 4.2 Solicitar certificado de CA corporativa

**Opción A — Via UI (recomendado):** Admin → Certificados → «Generar CSR». Rellena los campos DN y SAN. Descarga el `.csr`, envíalo a tu CA, y sube el `.crt` firmado en la misma pantalla.

**Opción B — Via línea de comandos:**
```bash
# Paso 1: Generar CSR (Certificate Signing Request)
openssl req -new -newkey rsa:4096 -nodes \
  -keyout certs/server.key \
  -out    certs/server.csr \
  -subj   "/C=ES/ST=Madrid/O=TuEmpresa/CN=cmdb.tudominio.com" \
  -addext "subjectAltName=DNS:cmdb.tudominio.com,DNS:localhost"

# Paso 2: Enviar certs/server.csr a tu CA corporativa
# Paso 3: Guardar el certificado firmado:
cp certificado-firmado.crt certs/server.crt

# Paso 4: Verificar que clave y certificado coinciden (mismo hash MD5)
openssl x509 -noout -modulus -in certs/server.crt | md5sum
openssl rsa  -noout -modulus -in certs/server.key | md5sum
```

### 4.3 Renovar certificados

```bash
# 1. Generar nuevos certificados o subirlos via UI (Admin → Certificados)
bash backend/scripts/generate-certs.sh

# 2. Actualizar el volumen Docker
docker run --rm \
  -v cmdb-tls-certs:/dest \
  -v $(pwd)/certs:/src:ro \
  alpine sh -c "cp /src/server.key /src/server.crt /dest/ && chmod 600 /dest/server.key"

# 3. Reiniciar nginx para que cargue los nuevos certificados
docker compose -f docker-compose.prod.yml restart nginx

# 4. Verificar
curl -sk https://localhost/api/health
openssl s_client -connect localhost:443 -showcerts 2>/dev/null | openssl x509 -noout -dates
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
docker compose -f docker-compose.prod.yml logs -f nginx
docker compose -f docker-compose.prod.yml logs -f backend
docker compose -f docker-compose.prod.yml logs -f postgres
docker compose -f docker-compose.prod.yml logs -f frontend

# Reiniciar un servicio (sin rebuild)
docker compose -f docker-compose.prod.yml restart nginx   # Tras actualizar certificados
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
| **Espacio en DOCUMENTS_STORAGE_PATH** | **> 70% del filesystem** | **Ampliar volumen / mover a NFS** |
| Tiempo de respuesta API /health | > 2s | Revisar logs backend |
| Memoria contenedor backend | > 1.5 GB | Reiniciar backend |
| Error rate en logs | > 10 errores/min | Revisar logs |
| Certificado SSL expiry | < 30 días | Renovar (sección 4.3) |

#### Monitorizar el volumen de documentos

```bash
# Ver uso actual del directorio de documentos
du -sh "${DOCUMENTS_STORAGE_PATH:-./document-storage}"

# Ver uso del filesystem donde está montado
df -h "${DOCUMENTS_STORAGE_PATH:-./document-storage}"

# Alerta cuando supere el 70 % (añadir a crontab para ejecución diaria)
DOCS_PATH="${DOCUMENTS_STORAGE_PATH:-/opt/cmdb/document-storage}"
USAGE=$(df --output=pcent "$DOCS_PATH" | tail -1 | tr -d ' %')
if [ "$USAGE" -gt 70 ]; then
  echo "ALERTA: Volumen de documentos al ${USAGE}% en $(hostname)" \
    | mail -s "[CMDB] Almacenamiento documentos crítico" admin@tudominio.com
fi
```

**Script de monitorización completo** — guardar en `/opt/cmdb/scripts/check-docs-storage.sh`:

```bash
#!/bin/bash
# check-docs-storage.sh — Monitoriza el volumen del repositorio documental
set -e

DOCS_PATH="${DOCUMENTS_STORAGE_PATH:-/opt/cmdb/document-storage}"
WARN_PCT=70
CRIT_PCT=85
RECIPIENT="${ALERT_RECIPIENT:-admin@tudominio.com}"

USAGE=$(df --output=pcent "$DOCS_PATH" 2>/dev/null | tail -1 | tr -d ' %')

if [ -z "$USAGE" ]; then
  echo "ERROR: No se puede leer el uso de disco en $DOCS_PATH" >&2
  exit 1
fi

FILE_COUNT=$(find "$DOCS_PATH" -type f 2>/dev/null | wc -l)
TOTAL_SIZE=$(du -sh "$DOCS_PATH" 2>/dev/null | cut -f1)

if [ "$USAGE" -ge "$CRIT_PCT" ]; then
  echo "[CMDB][CRÍTICO] Almacenamiento de documentos al ${USAGE}% (${TOTAL_SIZE}, ${FILE_COUNT} ficheros) en $(hostname)" \
    | mail -s "[CMDB][CRÍTICO] Almacenamiento documentos" "$RECIPIENT"
elif [ "$USAGE" -ge "$WARN_PCT" ]; then
  echo "[CMDB][AVISO] Almacenamiento de documentos al ${USAGE}% (${TOTAL_SIZE}, ${FILE_COUNT} ficheros) en $(hostname)" \
    | mail -s "[CMDB][AVISO] Almacenamiento documentos" "$RECIPIENT"
fi
```

```bash
# Hacer ejecutable y añadir al crontab (comprobación diaria a las 08:00)
chmod +x /opt/cmdb/scripts/check-docs-storage.sh

# Añadir a crontab (como root o el usuario que gestiona los contenedores)
(crontab -l 2>/dev/null; echo "0 8 * * * /opt/cmdb/scripts/check-docs-storage.sh") | crontab -
```

> Para instalaciones con NFS, monitoriza también la disponibilidad del share: `mountpoint -q /mnt/nfs/cmdb-docs || echo "NFS no montado"`. Incluye esta comprobación en el script de health-check de tu sistema de monitorización (Zabbix, Nagios, Prometheus, etc.).

---

## 8. Actualización de la Aplicación

### 8.1 Actualización automatizada (recomendada)

El script `scripts/update.sh` gestiona el ciclo completo de actualización con garantías de seguridad integradas.

```bash
cd /opt/cmdb
bash scripts/update.sh
```

#### Flags disponibles

| Flag | Descripción | Caso de uso |
|------|-------------|-------------|
| `--dry-run` | Muestra el changelog y detecta migraciones sin tocar nada | Revisar antes de actualizar en producción |
| `--yes` | Modo desatendido — confirma todos los prompts automáticamente | Cron nocturno, CI/CD |
| `--no-cache` | Fuerza rebuild completo de Docker sin caché | Tras cambios de dependencias (`package.json`) |
| `--force` | Omite la protección contra downgrade | Solo para recuperación — usar con precaución |

#### Ejemplos de uso

```bash
# Revisar qué pasaría sin ejecutar nada
bash scripts/update.sh --dry-run

# Actualizar sin preguntas (modo cron)
bash scripts/update.sh --yes

# Rebuild completo tras actualizar dependencias
bash scripts/update.sh --no-cache

# Forzar actualización ignorando el guard de downgrade (recuperación)
bash scripts/update.sh --force --yes
```

#### Cron para actualizaciones nocturnas desatendidas

```bash
# Actualización automática diaria a las 03:00
0 3 * * * cd /opt/cmdb && bash scripts/update.sh --yes >> /var/log/cmdb-update.log 2>&1
```

#### Garantías de seguridad del actualizador

El script implementa cinco capas de protección antes y durante la actualización:

1. **Protección contra downgrade:** Compara el commit remoto con el instalado. Si el remoto es más antiguo, aborta. Usar `--force` solo en escenarios de recuperación controlada.

2. **Backup obligatorio previo:** Ejecuta `scripts/db-backup.sh` antes de cualquier cambio. Si el backup falla, el script aborta sin tocar el código ni los contenedores.

3. **Punto de rollback etiquetado:** Crea un tag git `rollback/<timestamp>` con el HEAD actual antes de hacer `git pull`. Este tag permite restaurar el código exacto de la versión anterior.

> **v2.3.0 — RAG sobre entidades estructuradas (CIs, contratos, licencias, vulnerabilidades):**
> - **Indexación de entidades:** El subsistema RAG ya no se limita a documentos. Los CIs, contratos (raíz, los anexos se serializan dentro), licencias (mismo patrón raíz/anexos) y vulnerabilidades (identificadas por UUID v5 sintético sobre `(ciId, cve)`) se indexan automáticamente. La activación es transparente cuando `RAG_ENABLED=true`.
> - **Chips de filtro en el chat:** Cinco chips (Documentos, CIs, Contratos, Licencias, Vulnerabilidades) permiten acotar las fuentes consultadas. Persistencia por sesión del navegador. Selección vacía = todas las fuentes.
> - **Citaciones enlazables:** Cada cita devuelta por el asistente lleva ahora `entityType` + `entityId`. Hacer clic en una cita abre el ítem citado en su listado (`/inventory?focus=<id>` abre el modal del CI; `/contracts?focus=<id>` despliega la fila; igual con licencias; `/vulnerabilities?cve=<CVE-ID>` pre-filtra la lista).
> - **Worker priorizado:** El cron de 30 s usa un presupuesto de 3 huecos por tick con prioridad vulnerabilidad > contrato/licencia > CI. Preserva la latencia de subida de documentos y prioriza la señal de seguridad.
> - **Backfill multi-tipo:** `POST /api/admin/rag/backfill` ahora acepta `{ "entityTypes": [...] }`. Body vacío indexa todos los tipos.
> - **Auditoría agregada:** Nueva acción `INDEX_BATCH` (un evento por tick del worker, no por entidad) y `ASK_RAG_VULN` (trazabilidad fina para queries que incluyen vulnerabilidades). `audit_logs.details` formalizada como `jsonb` con índice `(action, created_at DESC)`.
> - **Mitigaciones anti-injection:** Bloques `<ENTITY_DATA>` en el prompt + REGLAS 5–7 reforzadas + `stripInjectionTokens()` en el serializador. `scrubPII()` (email, DNI/NIE, teléfono) sobre todo el texto libre antes de embedding. Allowlist estricto en serializador de vulnerabilidades (CVE-ID + severity + CVSS band + status + importedAt — sin description, sin source).
> - **Compliance:** DPIA v1.1 con 8 entradas STRIDE adicionales (ENT-01..08) y checklist de sign-off DPO+CISO (10 ítems). Mandato de cifrado de backups para `rag_chunks` (NIS2 Art.21.2.h / ISO 22301).
> - **Operaciones:** `scripts/update.sh --reindex` ahora también encola CIs / contratos / licencias para reindexación. Nuevo runbook `docs/RAG_V2_DEPLOY_RUNBOOK.md` con smoke checklist copy-paste, rollback, sign-off worksheet y monitoring post-deploy.

> **v2.2.3 — Rediseño UI Corporate Dark, theming dinámico y navegación responsive:**
> - **Theming dinámico en base de datos:** Nueva tabla `app_settings` almacena color de sidebar, color de acento, nombre de empresa y logo. Sin rebuild para cambiar la apariencia.
> - **Panel de Apariencia (Admin):** Nueva pestaña "Apariencia" en Ajustes con selector de color en vivo, subida de logo (PNG/JPEG/WebP, máx. 2 MB, validación magic bytes) y nombre de empresa configurable.
> - **CSS Custom Properties:** `--sidebar-bg` y `--accent` inyectados en `<head>` en tiempo de ejecución vía `ThemeContext`. El tema se aplica sin recarga de página.
> - **Endpoints públicos de tema:** `GET /api/settings/theme` y `GET /api/settings/logo` no requieren autenticación (necesarios para la página de login).
> - **Navegación responsive:** TopBar móvil con botón hamburguesa. Sidebar se despliega como overlay con backdrop a < 768px.
> - **Eliminación de border-radius excesivo:** Esquinas cuadradas en cards, widgets, tablas, inputs y botones en toda la aplicación (estilo Corporate Dark).
> - **Migración de colores:** Todos los colores `indigo-*` hardcodeados reemplazados por `var(--accent)` — el color de acento cambia globalmente al modificar el ajuste de branding.
> - **Seguridad logo:** Validación de tipo MIME + magic bytes en backend; SVG rechazado (riesgo XSS); base64 en BD, sin rutas de fichero.
> - **Auditoría:** Cada cambio de tema o logo genera un registro en `AuditLog` (`UPDATE_THEME`, `UPDATE_LOGO`, `DELETE_LOGO`).

> **v2.0.1 — Upgrade del stack, panel de sistema dinámico, cabeceras fijas:**
> - **nginx 1.30 (stable):** Actualización desde nginx 1.27; EOL abierta.
> - **Panel de sistema dinámico:** Nuevo endpoint `GET /api/system-info` (solo ADMIN) con tabla de 5 columnas que muestra versiones del stack y fechas EOL via endoflife.date con caché 24h.
> - **Cabeceras de página fijas:** Todos los encabezados de página permanecen visibles al hacer scroll (`sticky top-0 z-10`).
> - **Upgrade de dependencias:** Node.js 22-alpine, Prisma, Next.js 15, y dependencias backend/frontend actualizadas a versiones estables más recientes.
> - **Corrección de condición de carrera:** Panel de información del sistema: corregida condición de carrera en reintento automático.

> **v1.7.1 — Hardening de seguridad + correcciones de esquema e i18n:**
> - **Seguridad:** Validación del claim `use` en JWKS (SSO Microsoft); `FRONTEND_URL` validada y normalizada al origen en el arranque; validación de `COMPANY_NAME` con allowlist para evitar inyección DN en el certificado TLS; `.env` creado con `umask 0077` (sin ventana world-readable); inyección HTML corregida en plantillas de email EOL.
> - **Scripts:** `db-maintenance.sh` — auto-detección Docker/Podman, captura fiable del exit code vía fichero temporal, nombre de BD entrecomillado en `REINDEX`; `update.sh` — el rollback en dry-run ya no intenta `git checkout` sobre un tag inexistente.
> - **Esquema:** Constraints `UNIQUE` añadidos a `Vendor.name`, `CostCenter.name`, `Branch.name`; índices compuestos `(root_id, is_latest)` y `(root_id, version_number)` para consultas de versionado de documentos.
> - **i18n:** Todas las cadenas hardcodeadas en la página de perfil, callback SSO y AppShell reemplazadas por llamadas `t()`; 25 nuevas claves añadidas a los 6 ficheros de localización.
> - **Docker:** `NEXT_PUBLIC_COMPANY_NAME` cableada como ARG de build para que el nombre de empresa configurado durante la instalación se muestre correctamente en el frontend.
> - **Branding en runtime:** Los colores de sidebar (`sidebar_bg`), acento (`accent_color`), nombre de empresa (`company_name`) y logo (`logo_data`, `logo_mime`) se almacenan en la tabla `app_settings` de PostgreSQL y se sirven en tiempo real a través de `GET /api/settings/theme` y `GET /api/settings/logo` (endpoints públicos, sin autenticación).
> - **Docs:** Usuario seed `auditor@cmdb.local` documentado correctamente como `AUDITOR` (no `VIEWER`); versiones y changelog actualizados.

> **v1.7.0 — SSO Microsoft 365 + i18n 6 idiomas** *(sustituido por v1.7.1)*:
> - **SSO Microsoft 365 (Azure AD / Entra ID):** Nuevo flujo de autenticación OAuth2 + PKCE. Nuevas variables de entorno: `USE_MICROSOFT_SSO`, `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_REDIRECT_URI`, `AZURE_ALLOWED_DOMAIN`, `AZURE_AUTO_PROVISION`, `FRONTEND_URL`. Los usuarios SSO se almacenan con `sso_provider = 'microsoft'` y reciben automáticamente un token de dispositivo de confianza (sin MFA requerido en sesiones SSO). Nueva migración: columnas `sso_provider` y `sso_external_id` en la tabla `users`.
> - **i18n 6 idiomas:** El frontend incluye español, inglés, alemán, portugués, francés e italiano. Los usuarios pueden cambiar el idioma desde su perfil. Todas las cadenas de interfaz se sirven desde archivos JSON de localización — sin cambios en el backend.

> **v1.6.4 — Corrección de word-splitting en `update.sh`:** Todas las referencias a la variable `COMPOSE_CMD` (que puede contener `docker compose` — dos palabras) se reemplazaron por el array `COMPOSE_CMD_ARRAY[@]` y se eliminó el comentario `# shellcheck disable=SC2086`. Esto evita comportamientos inesperados cuando rutas o valores contienen espacios.

4. **Auto-rollback en caso de fallo:** Si el build de Docker falla o el health check no responde en 120 segundos, el script restaura automáticamente el tag de rollback, reconstruye la imagen anterior y reinicia los servicios.

5. **Confirmación de migraciones:** Detecta nuevos archivos de migración Prisma y muestra su lista antes de continuar. En modo interactivo solicita confirmación explícita.

#### Log de la actualización

Cada ejecución guarda su log completo en:
```
logs/update_<timestamp>.log
```

---

### 8.2 Rollback manual

Si la actualización automatizada no pudo completar el rollback, o si necesitas volver a una versión específica:

```bash
cd /opt/cmdb

# Ver tags de rollback disponibles (creados por update.sh)
git tag -l "rollback/*" | sort -r | head -10

# Ver historial de commits
git log --oneline -10

# Restaurar al tag de rollback más reciente
git checkout rollback/<timestamp>

# O restaurar a un commit específico
git checkout <hash-anterior>

# Reconstruir con la versión anterior
docker compose -f docker-compose.prod.yml build --no-cache
docker compose -f docker-compose.prod.yml up -d

# Verificar que los servicios están operativos
docker compose -f docker-compose.prod.yml ps
curl http://localhost:3000/health
```

---

### 8.3 Restaurar base de datos tras rollback

Si la actualización aplicó migraciones de base de datos que necesitas revertir, restaura el backup creado automáticamente por `update.sh`:

```bash
# El path del backup se imprime en el log de update.sh. También puedes listarlo:
ls -lht /opt/cmdb/backups/ | head -5

# Restaurar (PRECAUCIÓN: sobreescribe los datos actuales)
gunzip -c /opt/cmdb/backups/backup_<timestamp>.sql.gz \
  | docker exec -i cmdb-postgres-prod psql -U cmdb_admin -d cmdb_db

# Verificar que la restauración fue correcta
docker exec cmdb-postgres-prod psql -U cmdb_admin -d cmdb_db \
  -c "SELECT COUNT(*) FROM configuration_items;"
```

> Prisma no soporta rollback automático de migraciones DDL. Si la migración fue destructiva (DROP COLUMN, DROP TABLE), la única forma de recuperar los datos es restaurar el backup.

---

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
ls -laZ /var/lib/docker/volumes/cmdb-postgres-prod-data-prod/

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

> **v3.0.0:** Las tareas marcadas como "n8n" las gestiona automáticamente el workflow
> correspondiente. Para revisar ejecuciones: UI n8n → Executions.

| Frecuencia | Tarea | Método | Comando / Acción |
|------------|-------|--------|-----------------|
| Diario 02:00 (automático) | Backup BD + docs | **n8n** workflow "Backup CMDB" | Logs en UI n8n + audit_logs |
| Diario 08:30 (automático) | Alertas email EOL/EOS | **n8n** workflow "Alertas CMDB" | Logs en UI n8n |
| Diario 03:00 (automático) | Purga audit_logs > retención | **n8n** workflow "Mantenimiento" | `POST /api/internal/maintenance/purge-audit-logs` |
| Diario 02:00 (automático) | Limpieza trusted devices | **n8n** workflow "Mantenimiento" | `POST /api/internal/maintenance/cleanup-trusted-devices` |
| Cada hora (automático) | Limpieza bulk staging | **n8n** workflow "Mantenimiento" | `POST /api/internal/maintenance/cleanup-bulk-staging` |
| Cada 30 s (automático) | RAG indexing queue | **n8n** workflow "RAG Indexing" | `POST /api/internal/rag/process-batch` |
| Semanal | Revisar ejecuciones fallidas n8n | Manual | UI n8n → Executions → filter Error |
| Semanal | Verificar backups locales | Manual | `ls -lh /var/backups/cmdb/` |
| Mensual | `npm audit` en backend/frontend | Manual | `podman exec cmdb-backend-prod npm audit` |
| Mensual | Verificar caducidad SSL | Manual | `openssl x509 -noout -dates -in certs/server.crt` |
| Mensual | Limpieza de imágenes container | Manual | `podman image prune -f` |
| Trimestral | Rotación de JWT_SECRET | Manual | Ver sección 10 |
| Trimestral | Rotación CMDB_SERVICE_TOKEN | Manual | Ver docs/n8n/ADMIN_GUIDE.md |
| Anual | Renovación certificado SSL | Manual | Ver sección 4.3 |
| Anual | Revisión de usuarios activos | Manual | Configuración → Usuarios |

### Verificación rápida del estado n8n/Redis

```bash
# Redis sano
REDIS_PASS=$(grep REDIS_PASSWORD .env | cut -d= -f2)
podman exec cmdb-redis redis-cli -a "$REDIS_PASS" ping  # → PONG

# n8n-main sano
curl -sk https://localhost/n8n/healthz  # → {"status":"ok"}

# Endpoint M2M activo
TOKEN=$(grep CMDB_SERVICE_TOKEN .env | cut -d= -f2)
curl -s -H "X-CMDB-Service-Token: $TOKEN" http://localhost:3000/api/internal/ping
# → {"pong":true,...}

# Aprovisionamiento n8n (v3.2.0+) — verificar que N8N_API_KEY está poblada
grep N8N_API_KEY .env | grep -v "^N8N_API_KEY=$" && echo "OK" || echo "VACÍA — ver docs/n8n/ADMIN_GUIDE.md § Aprovisionamiento automático"

# Re-forzar aprovisionamiento (ADMIN JWT requerido)
# curl -sk -X POST https://localhost/api/admin/n8n/resync -H "Authorization: Bearer $JWT" | python3 -m json.tool

# Backups recientes
curl -s -H "X-CMDB-Service-Token: $TOKEN" \
  http://localhost:3000/api/internal/backup/list | python3 -m json.tool
```

> **v3.2.0+:** `N8N_API_KEY` la genera automáticamente `install.sh` (Phase 10d) o `update.sh` (`ensure_n8n_api_key`). Si está vacía tras una actualización, ejecutar manualmente:
> ```bash
> source scripts/lib/n8n-bootstrap.sh
> KEY=$(n8n_ensure_owner_and_key)
> sed -i "s|^N8N_API_KEY=.*|N8N_API_KEY=$KEY|" .env
> unset KEY
> podman-compose -f docker-compose.prod.yml restart cmdb-backend-prod
> ```

> **v3.3.0 — Variables adicionales del módulo n8n-provisioning:**
>
> | Variable | Por defecto | Descripción |
> |----------|-------------|-------------|
> | `N8N_INTERNAL_URL` | `http://n8n-main:5678` | URL interna de n8n para el backend. Cambiar solo si el servicio n8n tiene un nombre de contenedor distinto |
> | `LDAP_ALLOW_UNAUTHORIZED_CERTS` | `false` | Poner `true` SOLO en dev con LDAP/ldaps y certificado autofirmado. Aplica a la credencial n8n LDAP; desactiva verificación TLS del servidor LDAP en los workflows |
>
> Si los workflows n8n dan error tras actualizar, consultar **`docs/n8n/TROUBLESHOOTING.md`** — documenta las tres incidencias más comunes (INC-001: aprovisionamiento omitido, INC-002: 502 nginx, INC-003: ejecuciones acumuladas).

---

## 14. Despliegue en OpenShift / Kubernetes

> Esta sección cubre entornos empresariales donde ya existe una plataforma de contenedores (OpenShift, OKD, Kubernetes). El instalador detecta automáticamente si el CLI `oc` está autenticado y ajusta su comportamiento.

### 14.1 Detección automática

El `install.sh` detecta OpenShift si el comando `oc whoami` tiene éxito antes de iniciar el asistente de configuración. En ese caso, el instalador no ejecuta `docker-compose` y en su lugar genera el archivo `.env` correctamente configurado y muestra instrucciones para el despliegue manual en el clúster.

### 14.2 Convertir docker-compose a manifiestos OpenShift

```bash
# Instalar kompose (conversor docker-compose → Kubernetes/OpenShift)
curl -L https://github.com/kubernetes/kompose/releases/latest/download/kompose-linux-amd64 \
  -o /usr/local/bin/kompose
chmod +x /usr/local/bin/kompose

# Convertir el archivo de producción a manifiestos OpenShift
kompose convert -f docker-compose.prod.yml -o openshift/
```

Los manifiestos generados se guardarán en el directorio `openshift/` y requerirán ajustes específicos detallados en la sección siguiente.

### 14.3 Ajustes específicos para OpenShift

- **SecurityContextConstraints:** Los contenedores de la plataforma corren como usuario no root (`node`, UID 1000). Esto es compatible con el SCC `restricted` de OpenShift sin necesidad de privilegios adicionales.
- **Routes:** Crear una Route para el frontend (puerto 3001) y otra para el backend (puerto 3000). OpenShift gestiona el TLS terminación en el router.
- **ConfigMaps y Secrets:** Las variables del archivo `.env` deben migrarse a Secrets de OpenShift. No almacenar credenciales en ConfigMaps.
- **PersistentVolumeClaims:** Reemplazar los volúmenes Docker (`cmdb-postgres-prod-data-prod`, `cmdb-tls-certs`, `document-storage`) por PVCs con la clase de almacenamiento adecuada del clúster.

### 14.4 Ejemplo de Secret para OpenShift

```bash
# Crear un Secret con todas las variables del .env
oc create secret generic cmdb-env \
  --from-env-file=.env \
  --namespace cmdb-prod

# Verificar que el Secret se creó correctamente
oc get secret cmdb-env -n cmdb-prod -o yaml
```

> El Secret debe referenciar las variables en los Deployments mediante `envFrom.secretRef` o `env[].valueFrom.secretKeyRef`. Nunca inyectar el archivo `.env` directamente como volumen.

### 14.5 Actualización en OpenShift

El script `update.sh` no es compatible directamente con OpenShift (requiere `docker-compose`). Para actualizar en un entorno OpenShift:

```bash
# 1. Obtener el nuevo código
git pull origin main

# 2. Rebuild de la imagen (si usas un registry interno corporativo)
podman build -t registry.corp.local/cmdb/backend:$(git rev-parse --short HEAD) ./backend
podman push registry.corp.local/cmdb/backend:$(git rev-parse --short HEAD)

podman build -t registry.corp.local/cmdb/frontend:$(git rev-parse --short HEAD) ./frontend
podman push registry.corp.local/cmdb/frontend:$(git rev-parse --short HEAD)

# 3. Actualizar la imagen en el Deployment y hacer rollout
oc set image deployment/cmdb-backend-prod \
  backend=registry.corp.local/cmdb/backend:$(git rev-parse --short HEAD) \
  -n cmdb-prod

oc rollout restart deployment/cmdb-frontend-prod -n cmdb-prod

# 4. Verificar el estado del rollout
oc rollout status deployment/cmdb-backend-prod -n cmdb-prod
oc rollout status deployment/cmdb-frontend-prod -n cmdb-prod
```

---

## 15. Configuración de SSO con Microsoft 365 (Azure AD)

El Single Sign-On (SSO) con Microsoft 365 permite a los usuarios autenticarse en la plataforma usando sus credenciales corporativas de Azure Active Directory (Entra ID) mediante el protocolo OAuth 2.0 Authorization Code + PKCE. Esto elimina la necesidad de gestionar contraseñas adicionales y delega la autenticación (incluido el MFA corporativo y las políticas de Acceso Condicional) a Microsoft. Para el usuario, el proceso es un solo clic en la pantalla de login.

> Esta funcionalidad es opcional. La autenticación local (bcrypt) y la integración LDAP siguen funcionando con independencia de si SSO está activo.

---

### Paso 1: Registrar la aplicación en Azure AD

1. Accede a [portal.azure.com](https://portal.azure.com) con una cuenta de administrador del tenant.
2. Navega a **Azure Active Directory → Registros de aplicaciones → + Nueva aplicación**.
3. Rellena el formulario:
   - **Nombre:** `CMDB Enterprise Platform` (o el nombre que prefiera tu organización)
   - **Tipos de cuenta admitidos:** selecciona **"Solo las cuentas de este directorio organizativo (inquilino único)"** — esto es importante para no aceptar cuentas externas.
   - **URI de redireccionamiento:** selecciona la plataforma **Web** e introduce:
     ```
     https://TU_DOMINIO/api/auth/sso/microsoft/callback
     ```
     Reemplaza `TU_DOMINIO` por el dominio real de tu instalación (por ejemplo, `app.empresa.com`).
4. Haz clic en **Registrar**.
5. En la página de información general del registro, anota:
   - **ID de aplicación (cliente)** → valor de `AZURE_CLIENT_ID`
   - **ID de directorio (inquilino)** → valor de `AZURE_TENANT_ID`

---

### Paso 2: Crear un secreto de cliente

1. Dentro del registro de aplicación, ve a **Certificados y secretos → Secretos de cliente → + Nuevo secreto**.
2. Rellena los campos:
   - **Descripción:** `CMDB SSO`
   - **Expiración:** `24 meses` (recomendado; anota la fecha de caducidad para planificar la renovación)
3. Haz clic en **Agregar**.
4. **Copia el valor del secreto inmediatamente** — Azure solo lo muestra una vez. Este valor es `AZURE_CLIENT_SECRET`.

> El valor del secreto tiene el formato `~xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`. Si navegas fuera de la página antes de copiarlo, deberás crear uno nuevo.

---

### Paso 3: Permisos de API

Los permisos necesarios son permisos delegados estándar de Microsoft Graph. No es necesario el consentimiento del administrador para ninguno de ellos.

1. Ve a **Permisos de API → + Agregar un permiso → Microsoft Graph → Permisos delegados**.
2. Selecciona los siguientes permisos:

   | Permiso | Propósito |
   |---------|-----------|
   | `openid` | Emitir un id_token al completar la autenticación |
   | `profile` | Acceder al nombre de pila y apellidos del usuario |
   | `email` | Acceder a la dirección de email principal del usuario |
   | `User.Read` | Leer el perfil básico del usuario autenticado |

3. Haz clic en **Agregar permisos**.
4. No es necesario pulsar "Conceder consentimiento del administrador" para estos cuatro permisos.

---

### Paso 4: Configurar las variables de entorno

Edita el fichero `backend/.env` y añade (o descomenta) las siguientes variables:

```env
# ── SSO Microsoft 365 / Azure AD (Opcional) ───────────────────────────
USE_MICROSOFT_SSO=true
# true activa el botón "Iniciar sesión con Microsoft" en el login.
# false (valor por defecto) deshabilita el flujo SSO por completo.

AZURE_TENANT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
# ID de directorio (inquilino) copiado del paso 1.

AZURE_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
# ID de aplicación (cliente) copiado del paso 1.

AZURE_CLIENT_SECRET=your-client-secret-value
# Valor del secreto de cliente creado en el paso 2.

AZURE_REDIRECT_URI=https://app.empresa.com/api/auth/sso/microsoft/callback
# Debe coincidir exactamente con el URI registrado en Azure AD (paso 1).
# Incluye el esquema https:// y sin barra final.

AZURE_ALLOWED_DOMAIN=empresa.com
# Solo los usuarios cuyo email pertenezca a este dominio podrán usar SSO.
# Si el email del token no termina en @empresa.com, la autenticación se rechaza
# aunque el usuario haya iniciado sesión correctamente en Microsoft.
# Deja vacío para no restringir por dominio (no recomendado en producción).

FRONTEND_URL=https://app.empresa.com
# URL raíz del frontend. Se usa para construir la URL de redirección final
# tras completar el flujo OAuth. Debe incluir el esquema y sin barra final.

AZURE_AUTO_PROVISION=true
# true (recomendado): si el usuario de Microsoft no existe en la BD local,
#   se crea automáticamente con rol VIEWER y estado activo.
# false: el usuario debe existir previamente en la plataforma
#   (creado manualmente o mediante sincronización LDAP). Si no existe, se
#   rechaza el login aunque la autenticación Microsoft sea válida.
```

---

### Paso 5: Aplicar la migración de base de datos

El SSO requiere que la tabla `users` tenga los campos `sso_provider` y `sso_external_id`. Aplica la migración correspondiente dentro del contenedor del backend:

```bash
podman exec cmdb-backend-prod npx prisma migrate deploy
```

Verifica que la migración se haya aplicado correctamente:

```bash
podman exec cmdb-postgres-prod psql -U cmdb_db_user -d cmdb_db -c '\d users' | grep sso
```

Deberías ver las columnas `sso_provider` y `sso_external_id` en la salida.

---

### Paso 6: Reiniciar el backend

Después de actualizar el `.env`, reconstruye e inicia el contenedor del backend para que los cambios surtan efecto:

```bash
podman-compose -f docker-compose.prod.yml up -d --build backend
```

Comprueba que el backend arranca sin errores:

```bash
podman logs cmdb-backend-prod --tail 30
```

Deberías ver en los logs una línea similar a:
```
[SSO] Microsoft SSO habilitado — tenant: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

---

### Comportamiento esperado

Una vez configurado correctamente:

- **Pantalla de login:** aparece el botón "Iniciar sesión con Microsoft" debajo del formulario de credenciales habitual.
- **Flujo de autenticación:**
  1. El usuario hace clic en el botón → el backend redirige a la página de autenticación de Microsoft.
  2. Microsoft autentica al usuario (con las políticas corporativas: MFA, Acceso Condicional, etc.).
  3. Microsoft redirige al endpoint de callback con un código de autorización.
  4. El backend valida el `id_token`, verifica que el email pertenezca al dominio permitido, y crea o recupera el usuario en la BD.
  5. El dispositivo queda registrado como **dispositivo de confianza** automáticamente — no se solicita TOTP propio de la plataforma.
  6. El frontend recibe el JWT y el usuario accede directamente a la aplicación.
- **Aprovisionamiento:** si `AZURE_AUTO_PROVISION=true` y el usuario no existe, se crea con rol `VIEWER`. Un administrador puede cambiar el rol desde **Configuración → Usuarios**.
- **Vinculación de cuentas LDAP:** los usuarios que ya existen en la plataforma (ya sea por login local o por sincronización LDAP) y tienen el mismo email que su cuenta Microsoft quedan vinculados automáticamente al hacer SSO por primera vez.

---

### Coexistencia con LDAP

SSO con Microsoft y la autenticación LDAP son rutas de autenticación completamente independientes y pueden coexistir:

| Variable | Efecto |
|----------|--------|
| `USE_LDAP=false` · `USE_MICROSOFT_SSO=false` | Solo autenticación local (bcrypt) |
| `USE_LDAP=true` · `USE_MICROSOFT_SSO=false` | Autenticación local + LDAP |
| `USE_LDAP=false` · `USE_MICROSOFT_SSO=true` | Autenticación local + SSO Microsoft |
| `USE_LDAP=true` · `USE_MICROSOFT_SSO=true` | Autenticación local + LDAP + SSO Microsoft |

Cuando ambos están activos, el formulario tradicional sigue usando LDAP y el botón de Microsoft usa el flujo OAuth. Un mismo usuario puede usar cualquiera de los dos caminos siempre que el email coincida con la cuenta registrada en la plataforma.

Las cuentas con dominio `@cmdb.local` o `@cmdb.internal` siempre se autentican localmente, con independencia de la configuración de LDAP o SSO.

---

### Renovación del secreto de cliente

Los secretos de Azure AD tienen una fecha de caducidad. Si el secreto expira, el flujo SSO deja de funcionar y los usuarios verán un error al intentar autenticarse con Microsoft (la autenticación local/LDAP no se ve afectada).

**Procedimiento de renovación:**

1. Accede al portal de Azure → registro de la aplicación → **Certificados y secretos**.
2. Crea un **nuevo** secreto antes de que caduque el actual (mantén los dos activos en paralelo durante la transición).
3. Copia el nuevo valor del secreto.
4. Actualiza `AZURE_CLIENT_SECRET` en `backend/.env`.
5. Reinicia el backend:
   ```bash
   podman-compose -f docker-compose.prod.yml up -d --build backend
   ```
6. Verifica que el SSO sigue funcionando haciendo un login de prueba.
7. Una vez confirmado, elimina el secreto antiguo en el portal de Azure.

> Se recomienda crear una alerta en el calendario del equipo de sistemas 30 días antes de la fecha de caducidad del secreto.

---

### Verificación del estado SSO (endpoint público)

El endpoint `GET /api/auth/sso/status` devuelve el estado de la configuración SSO sin requerir autenticación. Es útil para diagnóstico desde el navegador o con `curl`:

```bash
curl -sk https://app.empresa.com/api/auth/sso/status | python3 -m json.tool
```

Respuesta esperada cuando SSO está activo:

```json
{
  "microsoft": {
    "enabled": true,
    "tenantId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "clientId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "allowedDomain": "empresa.com"
  }
}
```

Si `enabled` es `false`, verifica que `USE_MICROSOFT_SSO=true` está en el `.env` y que el backend se reinició después del cambio.

> Las migraciones de Prisma en OpenShift deben ejecutarse manualmente o como un Job de Kubernetes antes del rollout: `oc run prisma-migrate --image=... --restart=Never -- npx prisma migrate deploy`

---

## 16. Borrado de Usuarios (GDPR Art. 17)

Para eliminar un usuario y cumplir con el derecho de supresión del RGPD:

```http
DELETE /api/admin/users/:id
Authorization: Bearer <admin-token>
```

**Comportamiento:**
1. Las entradas en `audit_logs` con el email del usuario se pseudonomizan a `[deleted-{hash16}]`. El hash es SHA-256(email + JWT_SECRET) truncado — estable e irreversible.
2. El registro de usuario se elimina permanentemente (cascada a `trusted_devices` y `password_history`).
3. Se registra una entrada `GDPR_ERASURE` en `audit_logs` bajo el email del administrador.

**Restricciones:** Un administrador no puede borrar su propia cuenta. Los administradores SSO deben revocar el acceso también en Azure AD / LDAP.

**Conflicto GDPR Art.17 / ISO 27001 A.8.15:** La pseudonimización conserva la integridad cronológica de la pista de auditoría (requisito ISO 27001) mientras elimina el identificador personal directo (requisito GDPR). Este enfoque está amparado en el Art. 17(3)(b) del RGPD (obligación legal de conservación).

La tabla `audit_logs` tiene habilitada Row-Level Security (RLS) con `FORCE` — el borrado de filas está bloqueado a nivel de base de datos para todos los roles incluido el propietario de la tabla.

---

## 17. LDAP_STRICT_MODE

Por defecto, si el servidor LDAP no está disponible, la autenticación LDAP falla y el sistema intenta autenticación local. Los usuarios shadow LDAP tienen un hash de contraseña aleatorio que no puede usarse para login local, por lo que el fallback es seguro por diseño.

Para entornos de alta seguridad que requieren bloqueo explícito del fallback:

```env
LDAP_STRICT_MODE=true
```

Con esta opción, si el servidor LDAP no responde, los usuarios LDAP reciben `Invalid credentials` en lugar de intentar autenticación local. **No afecta a las cuentas locales** (emails que terminan en `@cmdb.local` o `@cmdb.internal`).

**Impacto:** Si el servidor LDAP cae, ningún usuario LDAP podrá autenticarse hasta que LDAP se recupere. Mantén siempre al menos una cuenta ADMIN local activa.

---

## 18. Aviso de Privacidad y Obligaciones GDPR Art. 13/14

La plataforma incluye una página de aviso de privacidad en `/privacy`. Los campos marcados como `[REPLACE: ...]` deben ser completados por la organización antes del despliegue en producción:

- **Nombre y datos del responsable del tratamiento** (Art. 13.1.a RGPD)
- **Datos de contacto del Delegado de Protección de Datos** (Art. 13.1.b RGPD)
- **Email de contacto para ejercicio de derechos**

**Usuarios auto-provisionados (SSO/LDAP):** La plataforma crea cuentas automáticamente para usuarios de Microsoft Azure AD y LDAP sin interacción directa. Esto activa la obligación del Art. 14 RGPD (información indirecta). La organización debe informar a estos usuarios mediante comunicación interna (RRHH, correo corporativo) ya que la aplicación no envía correos de bienvenida.

---

## 19. Subsistema RAG — Operación y mantenimiento

### 19.1 Variables de entorno del subsistema RAG

Tabla de todas las variables nuevas en `.env`:

| Variable | Defecto | Descripción |
|---|---|---|
| `RAG_ENABLED` | `true` | Activa/desactiva el subsistema RAG completo |
| `OLLAMA_BASE_URL` | `http://ollama:11434` | URL interna del servicio Ollama (no exponer al exterior) |
| `RAG_EMBED_MODEL` | `bge-m3` | Modelo de embeddings (multilingüe, 1024 dimensiones) |
| `RAG_CHAT_MODEL` | `qwen2.5:7b-instruct-q4_K_M` | Modelo LLM para generación de respuestas |
| `RAG_CHAT_TEMPERATURE` | `0.1` | Temperatura del LLM (bajo = más determinista y fiel al documento) |
| `RAG_TOP_K` | `6` | Número de fragmentos recuperados por consulta |
| `RAG_RATE_LIMIT_PER_MIN` | `10` | Peticiones de chat por usuario por minuto |
| `OLLAMA_MODELS_PATH` | `/opt/cmdb-data/ollama-models` | Ruta donde se almacenan los modelos descargados |

### 19.2 Descarga inicial de modelos

```bash
# Verificar que el servicio ollama está corriendo
podman ps | grep ollama

# Descargar modelos (primera vez; ~7 GB en total)
podman exec cmdb-ollama-prod ollama pull bge-m3
podman exec cmdb-ollama-prod ollama pull qwen2.5:7b-instruct-q4_K_M

# Verificar modelos disponibles
podman exec cmdb-ollama-prod ollama list
```

Nota: los modelos se almacenan en el volumen `ollama-models` (bind-mount en `/opt/cmdb-data/ollama-models`). Persisten entre reinicios del contenedor.

### 19.3 Verificación del servicio

```bash
# Estado del contenedor Ollama
podman ps --filter name=cmdb-ollama-prod

# Uso de recursos en tiempo real
podman stats cmdb-ollama-prod --no-stream

# Logs del servicio
podman logs --tail 50 cmdb-ollama-prod

# Modelo actualmente cargado en memoria
podman exec cmdb-ollama-prod ollama ps

# Test de conectividad backend → Ollama
podman exec cmdb-backend-prod curl -s http://ollama:11434/api/version
```

### 19.4 Indexación del corpus documental

#### Primera indexación (backfill)
Tras el primer despliegue, indexar todos los documentos existentes:

```bash
# Obtener token de ADMIN
TOKEN=$(curl -sk -X POST https://localhost/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@cmdb.local","password":"<ADMIN_PASSWORD>"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

# Lanzar backfill (proceso asíncrono; puede tardar minutos según corpus)
curl -sk -X POST -H "Authorization: Bearer $TOKEN" \
  https://localhost/api/admin/rag/backfill

# Monitorizar progreso en la BD
podman exec cmdb-postgres-prod psql -U admin -d cmdb_db \
  -c "SELECT status, COUNT(*) FROM rag_document_index GROUP BY status;"
```

#### Reindexar un documento concreto
```bash
curl -sk -X POST -H "Authorization: Bearer $TOKEN" \
  https://localhost/api/documents/<DOCUMENT_ID>/reindex
```

#### Estado del índice
```bash
podman exec cmdb-postgres-prod psql -U admin -d cmdb_db -c "
  SELECT
    status,
    COUNT(*) as count,
    MIN(updated_at) as oldest,
    MAX(updated_at) as newest
  FROM rag_document_index
  GROUP BY status
  ORDER BY status;"
```

### 19.5 Backup y restauración

#### Backup (incluir tablas RAG en el dump habitual)
```bash
# Backup completo incluyendo pgvector y tablas RAG
podman exec cmdb-postgres-prod pg_dump -U admin cmdb_db \
  > /opt/cmdb-data/backups/backup_$(date +%F_%H%M).sql

# Backup solo tablas RAG (ligero, para migraciones de modelo)
podman exec cmdb-postgres-prod pg_dump -U admin cmdb_db \
  --table=rag_document_index \
  --table=rag_chunks \
  --table=rag_chat_sessions \
  --table=rag_chat_messages \
  > /opt/cmdb-data/backups/rag_only_$(date +%F_%H%M).sql
```

#### Restauración de tablas RAG
```bash
podman exec -i cmdb-postgres-prod psql -U admin -d cmdb_db \
  < /opt/cmdb-data/backups/rag_only_<FECHA>.sql
```

#### Backup de modelos Ollama
Los modelos están en `/opt/cmdb-data/ollama-models`. Se pueden archivar:
```bash
tar -czf /opt/cmdb-data/backups/ollama_models_$(date +%F).tar.gz \
  -C /opt/cmdb-data ollama-models
```
O bien volver a descargarlos con `ollama pull` (más sencillo si hay acceso a internet).

### 19.6 Actualización de modelos

Para cambiar el modelo LLM (por ejemplo, a una versión nueva):
```bash
# 1. Descargar nuevo modelo
podman exec cmdb-ollama-prod ollama pull qwen2.5:14b-instruct-q4_K_M

# 2. Actualizar .env
sed -i 's/RAG_CHAT_MODEL=.*/RAG_CHAT_MODEL=qwen2.5:14b-instruct-q4_K_M/' .env

# 3. Reiniciar backend (recarga variables de entorno)
podman-compose -f docker-compose.prod.yml restart backend

# 4. Verificar
curl -sk -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"question":"test"}' \
  https://localhost/api/chat/ask | python3 -m json.tool
```

Para cambiar el modelo de embeddings se requiere **reindexar todo el corpus** (los vectores son incompatibles entre modelos):
```bash
sed -i 's/RAG_EMBED_MODEL=.*/RAG_EMBED_MODEL=nomic-embed-text/' .env
podman-compose -f docker-compose.prod.yml restart backend
# Lanzar backfill completo
curl -sk -X POST -H "Authorization: Bearer $TOKEN" \
  https://localhost/api/admin/rag/backfill
```

### 19.7 Monitorización y métricas

```bash
# Uso de RAM/CPU de todos los contenedores
podman stats --no-stream

# Espacio ocupado por modelos
du -sh /opt/cmdb-data/ollama-models/

# Espacio ocupado por vectores en PostgreSQL
podman exec cmdb-postgres-prod psql -U admin -d cmdb_db -c "
  SELECT
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS total_size
  FROM pg_tables
  WHERE tablename LIKE 'rag_%'
  ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;"

# Últimas consultas al asistente IA (audit log)
podman exec cmdb-postgres-prod psql -U admin -d cmdb_db -c "
  SELECT user_email, created_at
  FROM audit_logs
  WHERE action = 'ASK_RAG'
  ORDER BY created_at DESC
  LIMIT 20;"
```

### 19.8 Desactivar/activar el subsistema RAG

Para deshabilitar temporalmente sin eliminar datos:
```bash
# En .env
RAG_ENABLED=false
# Reiniciar backend
podman-compose -f docker-compose.prod.yml restart backend
```
Con RAG desactivado, los endpoints `/api/chat/*` devuelven HTTP 503. El resto de la aplicación funciona con normalidad.

### 19.9 Troubleshooting

| Síntoma | Diagnóstico | Solución |
|---|---|---|
| `/api/chat/ask` devuelve 503 | `RAG_ENABLED=false` o Ollama caído | Verificar `.env` y `podman ps` |
| Respuestas muy lentas (>60 s) | Modelo no cargado en RAM / AMX inactivo | `ollama ps`; verificar `grep amx_tile /proc/cpuinfo` |
| `rag_document_index` con estado ERROR | Error de parsing en el documento | `podman logs cmdb-backend-prod \| grep INDEX_DOC` |
| Respuestas incorrectas / alucinaciones | Temperatura alta o corpus indexado desactualizado | Verificar `RAG_CHAT_TEMPERATURE=0.1`; lanzar reindex |
| "no space left on device" | LV llena | `df -h /var/lib/containers /opt/cmdb-data` |
| Embeddings lentos al indexar | Modelo bge-m3 no cargado | `ollama pull bge-m3`; reiniciar backend |

### 19.10 Indexación de entidades (CIs, contratos, licencias, vulnerabilidades)

> Para el procedimiento operativo completo (smoke checklist + sign-off DPO/CISO + reindex post-update de corpus pre-existente), consulta `docs/RAG_V2_DEPLOY_RUNBOOK.md`. Esta sección documenta sólo el comportamiento estable; el runbook cubre la ejecución one-off al pasar de v1 a v2.

A partir de v2.3, el subsistema RAG indexa también entidades estructuradas además de documentos. No requiere una variable adicional: se activa automáticamente cuando `RAG_ENABLED=true`.

**Worker de indexación.** El cron de 30 s reparte un presupuesto de 3 huecos por tick entre entidades, con prioridad vulnerabilidad > contrato/licencia > CI. Si hay 3 vulns en cola, consumen todo el presupuesto y los contratos / CIs esperan al siguiente ciclo. Esto preserva la latencia de subida de documentos y prioriza la seguridad operativa. Ver `docs/RAG_ENTITIES_INDEXING_PLAN.md` §10 para el detalle.

**Reindex completo.** Para reindexar todas las entidades sin reiniciar:

```bash
TOKEN=$(curl -sk -X POST https://localhost/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"...","password":"..."}' | jq -r .token)
curl -sk -X POST https://localhost/api/admin/rag/backfill \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"entityTypes":["document","ci","contract","license","vulnerability"]}'
```

Body vacío `{}` o sin body equivale a indexar todos los tipos.

**Observabilidad.** Estado de cola por tipo:

```sql
SELECT entity_type, status, COUNT(*) FROM rag_entity_index GROUP BY 1,2 ORDER BY 1,2;
```

Auditoría agregada (1 evento por tick del worker, no por entidad):

```sql
SELECT created_at, details->>'cycle_at' AS cycle, details
FROM audit_logs WHERE action = 'INDEX_BATCH' ORDER BY created_at DESC LIMIT 10;
```

Otros eventos relevantes: `RAG_BACKFILL_ENTITIES` (reindex manual) y `ASK_RAG_VULN` (queries que incluyen vulnerabilidades).

**Troubleshooting de filas atascadas.** Una fila puede quedar en `INDEXING` si el worker cae mientras procesa. Reiniciar el backend NO la libera (el guard ARCH-3 protege contra carrera). Liberar manualmente:

```sql
UPDATE rag_entity_index
   SET status = 'PENDING', updated_at = now()
 WHERE status = 'INDEXING' AND updated_at < now() - interval '5 minutes';
```

**Lock-in de UUID de vulnerabilidades.** El namespace `RAG_VULN_NAMESPACE` en `backend/src/services/entitySerializer.ts` (`6c8b1a3e-9d4f-4a2b-8c7d-1e2f3a4b5c6d`) es inmutable. Cambiarlo invalidaría todos los chunks de vulnerabilidades existentes y requeriría un reindex completo, además de romper la trazabilidad histórica de las citaciones.

---

## 20. Backups — consideraciones de cifrado para RAG

Las tablas `rag_chunks` y `rag_entity_index` almacenan en texto plano fragmentos de documentos y entidades indexadas. Aunque el serializador aplica `scrubPII()` (email, DNI/NIE, teléfono) antes de generar embeddings, **siempre puede quedar PII residual** en notas libres y descripciones. Esto eleva la sensibilidad de los backups que incluyan estas tablas.

El cifrado de backups en producción es **obligatorio**. Recomendado: cifrar con `openssl` (AES-256-CBC con clave en KMS o HSM) directamente en la pipe de `pg_dump`, nunca en disco:

```bash
pg_dump -U admin -h localhost cmdb_db \
  | openssl enc -aes-256-cbc -salt -pbkdf2 -pass file:/secure/backup.key \
  > backup_$(date +%F).sql.enc
```

Restauración:

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -pass file:/secure/backup.key \
  -in backup_2026-05-21.sql.enc \
  | psql -U admin -d cmdb_db_restore
```

Política operativa:

- La clave de cifrado y los backups deben residir en sistemas con ACL separadas.
- Rotación de la clave: cada 12 meses o tras incidente con sospecha de exposición.
- Verificar restore con un sample mensual (test `pg_restore --list`).

Referencia: ENT-08 en `docs/security/rag-dpia.md` §A1.4.

---

## 21. RAG — Rendimiento e inferencia con GPU (opcional)

### 21.1 Por qué la GPU importa

El modelo de chat `qwen2.5:7b-instruct-q4_K_M` ejecutado en **CPU pura** produce latencias de 40-120 segundos por consulta (medido en Xeon Gold 6526Y, 12 vCPU, 31 GB RAM). Una GPU de gama media (RTX 4060 Ti 16 GB, L4, A10) acelera la inferencia **20-40×**, reduciendo el tiempo típico a 2-5 segundos.

El modelo de embedding `bge-m3` es más ligero (1,2 GB) y tolerable en CPU, pero también se beneficia de GPU.

### 21.2 Tuning de software (sin GPU)

Ajustables en `.env` o `install.conf`:

| Variable | Por defecto | Efecto |
|---|---|---|
| `RAG_NUM_PREDICT` | `768` | Tokens máx por respuesta. Reducir a 512 acelera ~25% en CPU con respuestas más cortas. `0` = sin límite. |
| `RAG_CHAT_TIMEOUT_MS` | `180000` | Timeout de chat (ms). Subir si el hardware es más lento. |
| `OLLAMA_KEEP_ALIVE` | `-1` | `-1` = modelo siempre cargado en RAM (elimina cold-load de ~20-30 s). `0` = descargar tras cada petición. |
| `RAG_CHAT_MODEL` | `qwen2.5:7b-instruct-q4_K_M` | Cambiar a `qwen2.5:3b-instruct-q4_K_M` para ~2× más velocidad en CPU (menor calidad de respuesta). |

### 21.3 Añadir una GPU NVIDIA (RHEL 9)

#### Requisitos previos en el host

```bash
# 1. Instalar el driver NVIDIA (versión ≥ 525)
sudo dnf install -y kernel-devel kernel-headers
# Descarga desde https://www.nvidia.com/en-us/drivers/ o usar CUDA repo de NVIDIA

# 2. Instalar NVIDIA Container Toolkit (CDI provider)
curl -s -L https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo \
  | sudo tee /etc/yum.repos.d/nvidia-container-toolkit.repo
sudo dnf install -y nvidia-container-toolkit

# 3. Configurar CDI para Podman
sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
sudo nvidia-ctk runtime configure --runtime=crio  # o docker según el runtime

# 4. Verificar
nvidia-smi
podman run --rm --device nvidia.com/gpu=all nvidia/cuda:12.2-base-ubuntu22.04 nvidia-smi
```

#### Modificar `docker-compose.prod.yml`

Añadir el bloque `devices` al servicio `ollama`:

```yaml
  ollama:
    image: docker.io/ollama/ollama:latest
    container_name: cmdb-ollama-prod
    restart: unless-stopped
    environment:
      OLLAMA_MODELS: /root/.ollama/models
      OLLAMA_KEEP_ALIVE: ${OLLAMA_KEEP_ALIVE:-30m}   # con GPU, 30 min es suficiente
    devices:
      - nvidia.com/gpu=all                           # CDI — RHEL 9 / Podman 4+
    volumes:
      - ${OLLAMA_MODELS_PATH:-/opt/cmdb-data/ollama-models}:/root/.ollama/models:Z
```

> **Nota Docker:** con Docker Engine en lugar de Podman, usar `deploy.resources.reservations.devices` con `driver: nvidia` en lugar del bloque `devices`.

#### Verificar que Ollama detecta la GPU

```bash
# Tras reiniciar los contenedores
podman exec cmdb-ollama-prod nvidia-smi
podman exec cmdb-ollama-prod ollama run qwen2.5:7b-instruct-q4_K_M "hola" 2>&1 | grep -i "gpu\|cuda"
```

Si la GPU está activa, Ollama muestra en sus logs: `llm server loaded in X.XXs with GPU layers`.

### 21.4 Modelos alternativos más rápidos (CPU o GPU ligera)

| Modelo | Tamaño | CPU (12 vCPU) | GPU RTX 4060 Ti | Notas |
|---|---|---|---|---|
| `qwen2.5:7b-instruct-q4_K_M` | 4,7 GB | ~45 s | ~3 s | Actual por defecto |
| `qwen2.5:3b-instruct-q4_K_M` | 2,0 GB | ~20 s | ~1,5 s | Menor calidad |
| `llama3.2:3b-instruct-q4_K_M` | 2,0 GB | ~18 s | ~1,5 s | Alternativa 3B |
| `qwen2.5:14b-instruct-q4_K_M` | 9,0 GB | ~90 s | ~6 s | Mayor calidad (requiere ≥16 GB VRAM) |

Para cambiar de modelo:

```bash
# 1. Descargar el nuevo modelo en Ollama
podman exec cmdb-ollama-prod ollama pull qwen2.5:3b-instruct-q4_K_M

# 2. Actualizar la variable en .env
RAG_CHAT_MODEL=qwen2.5:3b-instruct-q4_K_M

# 3. Reiniciar el backend (no requiere rebuild de imagen)
podman-compose -f docker-compose.prod.yml restart backend
```

### 21.5 Impacto en seguridad y continuidad

- **A08 — Integridad:** el bloque CDI `devices: nvidia.com/gpu=all` concede acceso al dispositivo GPU al contenedor Ollama únicamente; los demás contenedores no tienen acceso al hardware.
- **ISO 22301 / RTO:** una GPU dedicada al contenedor `ollama` se convierte en un componente de disponibilidad. Documentar el procedimiento de arranque sin GPU (fallback a CPU) como modo degradado aceptable.
- **Drivers:** mantener el driver NVIDIA actualizado. Los CVE de drivers de kernel con acceso DMA son de alta severidad.

---

## 22. Plugin Engine (v2.8.0) — instalación y operación

Esta sección cubre la puesta en marcha y operación del Motor de Plugins desde el punto de vista del administrador de sistemas. Para la arquitectura interna, ver [`docs/PLUGIN_ENGINE.md`](PLUGIN_ENGINE.md); para el procedimiento de aprobación, [`docs/PLUGIN_SECURITY_CHECKLIST.md`](PLUGIN_SECURITY_CHECKLIST.md).

### 22.1 Variables de entorno `PLUGIN_*`

Configurables en `.env` (valores por defecto entre paréntesis):

| Variable | Default | Descripción |
|----------|---------|-------------|
| `PLUGIN_STORAGE_PATH` | `/var/lib/cmdb/plugins` | Directorio persistente de bundles, backups y ficheros instalados |
| `PLUGIN_MAX_SIZE_MB` | `50` | Tamaño máximo del bundle subido (MB) |
| `PLUGIN_DATABASE_URL` | (requerida) | Conexión con el rol restringido `cmdb_plugin` para ejecutar migraciones DDL. **Obligatoria** — `docker-compose.prod.yml` la exige con `:?...` |
| `PLUGIN_REQUIRE_APPROVAL_PROD` | `true` | Exige aprobación 4-eyes de un segundo ADMIN para activar plugins |
| `PLUGIN_ENABLE_MARKETPLACE` | `true` | Habilita la consulta al marketplace |
| `PLUGIN_MARKETPLACE_URL` | (vacío) | URL del repositorio del marketplace (puede ser privado) |
| `PLUGIN_SIGNING_PUBLIC_KEY` | (no presente) | **Clave pública Ed25519 (base64 SPKI/DER)** para verificar firmas. **No** está en `.env.example` ni en los compose por defecto — añádela manualmente si vas a usar plugins firmados. Si un manifest declara firma y esta variable no está configurada, la validación falla |

> `docker-compose.prod.yml` marca `PLUGIN_DATABASE_URL` como requerida (`:?...`) y `PLUGIN_REQUIRE_APPROVAL_PROD` por defecto `true`. Ambas deben configurarse en `.env` antes del primer arranque.

### 22.2 Crear el rol de base de datos `cmdb_plugin`

Las migraciones de plugins se ejecutan con un rol PostgreSQL **restringido** que solo puede crear objetos nuevos (prefijo `plg_*`) y **no** tiene acceso a las tablas core. Créalo **una vez** como superusuario:

```bash
# Aplicar el script de bootstrap (incluido en el repo)
podman exec -i cmdb-postgres-prod psql -U admin -d cmdb_db < scripts/create-plugin-db-role.sql
```

El script (`scripts/create-plugin-db-role.sql`):
- Crea el rol `cmdb_plugin` con `LOGIN` (cambia la contraseña — el placeholder es `CHANGE_ME_IN_PRODUCTION`).
- `REVOKE ALL` sobre el esquema `public`, luego `GRANT USAGE` + `GRANT CREATE` (solo crear objetos nuevos, sin acceso a los existentes).
- `ALTER DEFAULT PRIVILEGES` para que gestione sus propios objetos (necesario para down-migrations).
- `GRANT CONNECT` a la base de datos.

Después, ajusta la contraseña real y refléjala en `PLUGIN_DATABASE_URL`:

```sql
ALTER ROLE cmdb_plugin PASSWORD 'una-contraseña-fuerte';
```

```bash
# .env
PLUGIN_DATABASE_URL=postgresql://cmdb_plugin:una-contraseña-fuerte@postgres:5432/cmdb_db
```

> **Defensa en profundidad:** el `MigrationRunner` valida el SQL (allowlist DDL + prefijo `plg_`) **antes** de ejecutarlo, y usa `execFile('psql')` (no `exec`, sin inyección de shell). El rol restringido es la segunda barrera a nivel de base de datos.

### 22.3 Volumen `cmdb-plugins`

El almacenamiento de plugins se persiste en un volumen Docker dedicado, declarado en `docker-compose.prod.yml`:

- Volumen `cmdb-plugins-prod`, montado en `/var/lib/cmdb/plugins`.

Estructura interna: `staging/` (bundles subidos), `installed/<uuid>/` (ficheros extraídos), `backups/` (backups JSON pre-uninstall).

### 22.4 Backup y restauración del storage de plugins

El storage de plugins **no** lo cubre el `pg_dump` de la base de datos (son ficheros). Inclúyelo en tu rutina de backup:

```bash
# Backup del volumen de plugins (ficheros: bundles, instalados, backups JSON)
podman run --rm -v cmdb-plugins-prod:/data -v $(pwd):/backup alpine \
  tar czf /backup/plugins_storage_$(date +%F).tar.gz -C /data .

# Las tablas plg_* viven en PostgreSQL y SÍ las cubre el pg_dump habitual:
podman exec cmdb-postgres-prod pg_dump -U admin cmdb_db > backup_$(date +%F).sql
```

Para una recuperación completa necesitas **ambos**: el dump de PostgreSQL (registro de plugins + tablas `plg_*`) y el tar del volumen (ficheros instalados + backups). Restaura el volumen con el `tar` inverso y la BD con `psql`.

> **NIS2 / cadena de suministro:** cada plugin es un proveedor externo. Mantén un inventario de plugins instalados (consultable vía `GET /api/plugins` o el panel) y asegúrate de poder **desactivar** cualquiera de forma independiente sin afectar al core.

### 22.5 CSP y iframe

La UI de los plugins se sirve en iframes del mismo origen. La política CSP de nginx (`frame-src 'self'`) ya es compatible y **no requirió cambios**; no relajes `frame-src` a orígenes externos para plugins.

---

## 23. v2.8.2 — Ciclo de vida de activos (DateType + migraciones)

### 23.1 Migraciones aplicadas en v2.8.2

Esta versión aplica dos migraciones Prisma nuevas al arrancar el contenedor backend:

| Migración | Descripción |
|---|---|
| `20260614100000_date_types` | Crea el enum `"DateTypeCategory"` y la tabla `date_types`; siembra 16 tipos canónicos |
| `20260614120000_date_associations` | Crea `ci_dates`, `operating_system_dates`, `base_software_dates`, `device_model_dates`; crea 4 disparadores espejo; backfill idempotente desde columnas `eol_date`/`eos_date` existentes |

Las migraciones son **idempotentes** (usan `IF NOT EXISTS` y `ON CONFLICT DO NOTHING`) y se aplican automáticamente en el arranque mediante `prisma migrate deploy`.

### 23.2 Verificación post-despliegue

```bash
# Comprobar que las tablas existen
podman exec cmdb-postgres-prod psql -U admin cmdb_db -c '\dt date_types ci_dates operating_system_dates base_software_dates device_model_dates'

# Comprobar que los triggers existen
podman exec cmdb-postgres-prod psql -U admin cmdb_db -c "\
SELECT trigger_name, event_manipulation, event_object_table \
FROM information_schema.triggers \
WHERE trigger_name LIKE 'trg_sync_%' ORDER BY 1;"

# Comprobar seed de DateTypes
podman exec cmdb-postgres-prod psql -U admin cmdb_db -c 'SELECT code, category, is_system FROM date_types ORDER BY sort_order;'
```

### 23.3 Rollback manual (si es necesario)

```sql
-- Eliminar triggers primero
DROP TRIGGER IF EXISTS trg_sync_ci_eol_eos ON ci_dates;
DROP TRIGGER IF EXISTS trg_sync_ci_eol_eos_del ON ci_dates;
DROP TRIGGER IF EXISTS trg_sync_dm_eol_eos ON device_model_dates;
DROP TRIGGER IF EXISTS trg_sync_dm_eol_eos_del ON device_model_dates;

-- Eliminar tablas de asociaciones
DROP TABLE IF EXISTS ci_dates, operating_system_dates, base_software_dates, device_model_dates;

-- Eliminar DateTypes y enum (solo si no hay dependencias)
DROP TABLE IF EXISTS date_types;
DROP TYPE IF EXISTS "DateTypeCategory";
```

> Las columnas espejo `eol_date`/`eos_date` en `configuration_items` y `device_models` **no se tocan** en el rollback — siguen funcionando como antes de v2.8.2.

---

## 24. Módulo de Alertas Email (v2.8.4)

### 24.1 Variables de entorno SMTP

Las variables de entorno SMTP son las mismas que en versiones anteriores; el módulo de alertas las lee en tiempo de llamada (no en inicio de aplicación), por lo que un cambio en `.env` + reinicio de contenedor es suficiente para actualizarlas:

```env
# ── SMTP / Alertas ───────────────────────────────────────────────────────────
SMTP_HOST=smtp.tudominio.com
SMTP_PORT=587
SMTP_SECURE=false          # true para puerto 465 (TLS directo)
SMTP_USER=cmdb-alerts@tudominio.com
SMTP_PASS=<contraseña-smtp>
SMTP_FROM=CMDB Alertas <cmdb-alerts@tudominio.com>
```

No se requiere `CRON_SCHEDULE` — la hora de envío se configura desde la UI (**Configuración → Alertas**) y se persiste en la tabla `alert_config`.

### 24.2 Tablas de base de datos

La migración `20260615120000_alert_module` crea tres tablas nuevas:

| Tabla | Descripción |
|-------|-------------|
| `alert_config` | Singleton (id = `"default"`) con la configuración global del motor |
| `alert_rules` | Una fila por categoría (7 categorías); contiene `enabled`, `warn_days`, `recipients` |
| `alert_runs` | Historial de ejecuciones; insert-only; indexado por `started_at DESC` |

#### Campos relevantes de `alert_config`

| Columna | Tipo | Valor por defecto | Descripción |
|---------|------|-------------------|-------------|
| `enabled` | boolean | `true` | Activa/desactiva todo el motor |
| `send_time_hour` | int | `8` | Hora de envío (0–23) |
| `send_time_minute` | int | `30` | Minuto de envío (0–59) |
| `timezone` | varchar(64) | `UTC` | Identificador IANA |
| `locale` | varchar(10) | `es` | Idioma del email |
| `recipients` | text[] | `{}` | Destinatarios globales |
| `send_all_clear` | boolean | `false` | Notificar cuando no hay alertas |
| `suppress_unchanged` | boolean | `true` | Dedup por fingerprint SHA-256 |

#### Categorías en `alert_rules`

`eol`, `eos`, `warranty`, `maintenance`, `contract`, `vulnerability`, `license`

### 24.3 Scheduler

El scheduler arranca con la aplicación (`startAlertScheduler(prisma)` desde `index.ts`) y usa `node-cron` con tick de un minuto (`* * * * *`). En cada tick:

1. Lee `alert_config` desde la BD (caché de 5 minutos).
2. Obtiene la hora y minuto actual en la zona horaria configurada mediante `Intl.DateTimeFormat`.
3. Si coincide con `send_time_hour:send_time_minute`, comprueba si ya hubo una ejecución exitosa hoy (guard idempotente).
4. Si no hubo ejecución, lanza el pipeline completo.

El pipeline (`runAlertsPipeline`) ejecuta el escaneo de las 7 categorías, calcula el fingerprint SHA-256, aplica la dedup si `suppress_unchanged = true`, construye el email HTML en el idioma configurado, lo envía y registra el resultado en `alert_runs`.

### 24.4 Verificación post-despliegue

```bash
# Comprobar que las tablas existen
podman exec cmdb-postgres-prod psql -U admin cmdb_db -c '\dt alert_config alert_rules alert_runs'

# Verificar la configuración sembrada
podman exec cmdb-postgres-prod psql -U admin cmdb_db -c 'SELECT id, enabled, send_time_hour, send_time_minute, timezone, locale FROM alert_config;'

# Verificar las 7 reglas
podman exec cmdb-postgres-prod psql -U admin cmdb_db -c 'SELECT category, enabled, warn_days FROM alert_rules ORDER BY category;'

# Ver el historial de ejecuciones
podman exec cmdb-postgres-prod psql -U admin cmdb_db -c 'SELECT trigger, status, total_alerts, started_at FROM alert_runs ORDER BY started_at DESC LIMIT 10;'

# Forzar envío de prueba desde la API
TOKEN=$(curl -sk -X POST https://localhost/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@cmdb.local","password":"<admin-password>"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
curl -sk -X POST https://localhost/api/alerts/test \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

### 24.5 Troubleshooting

**Las alertas no se envían:**

```bash
# Ver logs del scheduler
podman logs cmdb-backend-prod 2>&1 | grep -i 'alert\|smtp\|scheduler' | tail -30

# Comprobar que la última ejecución fue exitosa
podman exec cmdb-postgres-prod psql -U admin cmdb_db -c \
  "SELECT status, error_msg, total_alerts, started_at FROM alert_runs ORDER BY started_at DESC LIMIT 5;"
```

**El email llega a deshora:**

Verifica que la zona horaria en `alert_config` sea correcta. La aplicación usa `Intl.DateTimeFormat` con el identificador IANA — no depende del TZ del contenedor. Ejemplo:

```bash
podman exec cmdb-postgres-prod psql -U admin cmdb_db -c \
  "UPDATE alert_config SET timezone = 'Europe/Madrid' WHERE id = 'default';"
```

(O usa la UI: **Configuración → Alertas → Configuración Global**.)

**Se envían emails duplicados:**

Comprueba que `suppress_unchanged = true` en `alert_config`. Si quieres forzar siempre el envío independientemente de cambios, ponlo en `false`.

### 24.6 Rollback manual

```sql
-- Eliminar tablas del módulo de alertas
DROP TABLE IF EXISTS alert_runs;
DROP TABLE IF EXISTS alert_rules;
DROP TABLE IF EXISTS alert_config;
```

Después de eliminar las tablas, restaurar el shim de scheduler legado en `index.ts` si es necesario. Las tablas de `configuration_items`, `contracts`, `licenses` y `vulnerabilities` no se ven afectadas.


## LDAP: grupo de acceso y sincronización de usuarios (v3.5.10)

### Restringir el login a un grupo de seguridad

Añada al `.env`:

```bash
LDAP_REQUIRED_GROUP=GS-CMDB-Iberia-Access   # CN corto o DN completo
LDAP_GROUP_NESTED=true                       # false = solo miembros directos
LDAP_GROUP_SEARCH_BASE=                      # opcional; cae a LDAP_SEARCH_BASE
```

**Requiere `LDAP_BIND_DN` y `LDAP_BIND_PASSWORD`**: la pertenencia se consulta con la cuenta de servicio. Sin ella, ningún login LDAP prosperará mientras el grupo esté configurado — es deliberado (ver más abajo).

Con la variable **vacía**, el login LDAP se comporta exactamente como antes de v3.5.10. Es el valor por defecto, para que una actualización no deje a nadie fuera.

Tras editar el `.env`, **redespliegue el stack completo**. Una recreación selectiva de un contenedor no recoge de forma fiable el `.env` editado:

```bash
podman-compose -f docker-compose.prod.yml down
podman-compose -f docker-compose.prod.yml up -d --build
```

### Comportamiento ante fallos

| Situación | Qué ocurre |
|---|---|
| Usuario fuera del grupo | `401`, cuenta desactivada, entrada `LDAP_GROUP_DENIED` en `audit_logs` |
| Directorio caído o sin `LDAP_BIND_DN` | `401` para todo login LDAP; log `LDAP_GROUP_CHECK_UNAVAILABLE` |
| Cuentas locales (`@cmdb.local`) | **No afectadas** en ningún caso |

La última fila es la garantía operativa importante: aunque el controlador de dominio esté caído, el administrador local sigue pudiendo entrar. Si ve `LDAP_GROUP_CHECK_UNAVAILABLE` en los logs, revise conectividad al DC y las credenciales de la cuenta de servicio antes que ninguna otra cosa.

### Sincronización de usuarios

Dos disparadores, una sola lógica:

- **Manual**: Configuración → Integraciones → «Sincronizar ahora» (solo ADMIN).
- **Automático**: workflow n8n `LDAP Group Sync`, diario a las 03:00 (`LDAP_SYNC_CRON`). Se activa solo si `USE_LDAP=true` y hay grupo configurado.

```bash
LDAP_SYNC_DEFAULT_ROLE=VIEWER   # rol de alta; nunca se reaplica a los existentes
LDAP_SYNC_MAX_MEMBERS=5000      # tope duro por pasada
LDAP_SYNC_CRON=0 3 * * *
```

Nunca borra usuarios: los que salen del grupo quedan `active=false`. Los usuarios creados a mano (sin `sso_external_id`) son intocables. El rol de un usuario existente **nunca** se sobrescribe, de modo que una promoción manual sobrevive a la pasada nocturna.

Verificación rápida desde el host:

```bash
podman exec cmdb-postgres-prod psql -U admin -d cmdb_db -c \
  "SELECT action, count(*) FROM audit_logs WHERE action LIKE 'LDAP_%' GROUP BY action;"
```

### Variables obsoletas

`LDAP_SYNC_GROUP_DN` y `LDAP_SYNC_DOMAIN` ya no se usan: alimentaban el workflow anterior, que consultaba el directorio desde n8n. Pueden eliminarse del `.env`.

---

## Importación de vulnerabilidades Greenbone — staging y revisión (v3.6.0)

> **Estado en el momento de escribir esta sección: rama `develop`, sin tag ni merge a `main`.** No la trate como release en producción hasta que la entrada correspondiente de "Plan Activo" en `CLAUDE.md` diga lo contrario.

Ver `docs/INTEGRATIONS.md` § 9 para la arquitectura completa (modelo de identidad, cascada de emparejamiento de CI, flujo de staging). Esta sección cubre solo lo operativo/sysadmin.

### Tablas nuevas y backups

El módulo añade dos tablas a la base de datos: `vuln_import_batches` y `vuln_import_entries`. **No requieren ningún procedimiento de backup nuevo** — quedan cubiertas por el volcado `pg_dump` habitual descrito en la [§6](#6-backups-y-restauración-de-la-base-de-datos), igual que cualquier otra tabla de `cmdb_db`. No es necesario ajustar `db-backup.sh` ni ningún script de retención.

### Backfill de `key` en vulnerabilidades preexistentes

Toda entrada de vulnerabilidad almacenada **antes** de este release solo tiene `cve` (nunca `key`, un campo que no existía todavía). `PATCH /api/vulnerabilities` ya resuelve identidad como `key ?? cve`, así que el sistema funciona sin backfill — pero para que las entradas antiguas tengan `key` poblado de forma consistente con las nuevas, existe `backend/scripts/backfill-vuln-keys.js`: rellena `key = cve` en cualquier entrada que aún no tenga `key`. Es **idempotente** (ejecutarlo dos veces no duplica ni corrompe nada) y soporta `--dry-run` para ver qué tocaría sin escribir.

Sigue el mismo patrón ya documentado en este manual para ejecutar un script Node.js dentro del contenedor backend (necesita Prisma en scope):

```bash
# Modo de prueba — solo informa, no escribe
podman cp backend/scripts/backfill-vuln-keys.js cmdb-backend-prod:/app/backfill-vuln-keys.js \
  && podman exec -w /app cmdb-backend-prod node backfill-vuln-keys.js --dry-run \
  && podman exec cmdb-backend-prod rm /app/backfill-vuln-keys.js

# Aplicar de verdad
podman cp backend/scripts/backfill-vuln-keys.js cmdb-backend-prod:/app/backfill-vuln-keys.js \
  && podman exec -w /app cmdb-backend-prod node backfill-vuln-keys.js \
  && podman exec cmdb-backend-prod rm /app/backfill-vuln-keys.js
```

No es necesario ejecutarlo antes de habilitar el módulo — es una limpieza de consistencia, no un requisito funcional. Ejecútelo una vez tras desplegar esta versión si quiere que las vulnerabilidades antiguas tengan `key` poblado explícitamente en vez de depender del fallback `?? cve` en cada lectura.

### Carencia conocida: batches `PENDING` sin purgar

Un lote de importación (`VulnImportBatch`) que se sube y **nunca se acepta ni se descarta** queda indefinidamente en estado `PENDING`. La especificación de este release proponía incorporar la purga de batches `PENDING` abandonados al cron de mantenimiento ya existente (el mismo que limpia dispositivos de confianza expirados y el almacén de estado SSO), pero **no se implementó en esta versión** — no dé por hecho que existe. Un batch `PENDING` antiguo no supone un riesgo de datos (no ha tocado ningún CI), solo acumula filas en `vuln_import_batches`/`vuln_import_entries` y aparece en el listado `/vulnerabilities/imports` hasta que alguien lo acepte o lo descarte manualmente.
