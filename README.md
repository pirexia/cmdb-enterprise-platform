# 🏛️ Enterprise CMDB & GRC Platform

> **Configuration Management Database** — Plataforma integral para la gestión de activos de TI (CIs), contratos de proveedores, análisis de vulnerabilidades y visualización de dependencias, con autenticación JWT y control de acceso basado en roles (RBAC).

[![Stack](https://img.shields.io/badge/stack-Node.js%20%7C%20Next.js%20%7C%20PostgreSQL-blue)](https://github.com/pirexia/cmdb-enterprise-platform)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![RHEL](https://img.shields.io/badge/tested%20on-RHEL%208%2F9-red)](https://www.redhat.com/en/technologies/linux-platforms/enterprise-linux)

---

## 📋 Tabla de contenidos

1. [Características](#-características)
2. [Stack tecnológico](#-stack-tecnológico)
3. [Estructura del proyecto](#-estructura-del-proyecto)
4. [Instalación en RHEL (Recomendado para producción)](#-instalación-en-rhel-recomendado-para-producción)
5. [Despliegue con Docker](#-despliegue-con-docker)
6. [Variables de entorno](#-variables-de-entorno)
7. [Tabla de puertos](#-tabla-de-puertos)
8. [Arquitectura y flujo de datos](#-arquitectura-y-flujo-de-datos)
9. [Credenciales por defecto](#-credenciales-por-defecto)
10. [API Reference](#-api-reference)
11. [Desarrollo local (sin Docker)](#-desarrollo-local-sin-docker)

---

## ✨ Características

| Módulo | Descripción |
|--------|-------------|
| 📊 **Dashboard** | Resumen ejecutivo: totales por tipo, entorno, criticidad y estado de seguridad global |
| 🖥️ **Inventario de CIs** | CRUD completo de Configuration Items (Hardware / Software / Otro) con jerarquía padre-hijo |
| 🕸️ **Mapa de Dependencias** | Canvas interactivo (React Flow) con layout jerárquico automático, alertas de contratos próximos a vencer y vulnerabilidades críticas parpadeantes |
| 📜 **Contratos y Adendas** | Gestión de contratos M:N vinculados a CIs, soporte de adendas y semáforo de vencimiento |
| 🛡️ **Gestión de Vulnerabilidades** | Escáner simulado por CI con CVEs reales (CVSS 2023-2024), clasificación por severidad y persistencia JSON en BD |
| 🔌 **Conectores de Seguridad** | Ingesta de reportes Greenbone OpenVAS (CVEs) y estado de agentes CrowdStrike Falcon EDR |
| 🗂️ **Gestión de Vulnerabilidades** | Vista centralizada de todos los hallazgos con ciclo de vida: NUEVO → ASIGNADO → EN_CURSO → PARADO → RESUELTO |
| 🔐 **IAM / RBAC** | Autenticación JWT con roles **ADMIN** (escritura total) y **VIEWER** (solo lectura) |

---

## 🛠️ Stack tecnológico

| Capa | Tecnología |
|------|-----------|
| **Base de datos** | PostgreSQL 15 |
| **ORM** | Prisma 5 |
| **Backend** | Node.js 20 · Express 4 · TypeScript 5 |
| **Auth** | JWT (jsonwebtoken) · bcrypt |
| **Frontend** | Next.js 15 (App Router) · React 19 |
| **Estilos** | Tailwind CSS v4 |
| **Visualización** | React Flow 11 · Lucide React |
| **Contenedores** | Docker CE / Podman · Docker Compose v3.9 |

---

## 🖥️ Requisitos del sistema

| Recurso | Mínimo recomendado | Notas |
|---------|-------------------|-------|
| **CPU** | 2 vCPUs | 4+ vCPUs para entornos con carga |
| **RAM** | 4 GB | 8 GB recomendados en producción |
| **Espacio en disco** | **10 GB libres en `/var`** | Las capas de imágenes Docker/Podman se almacenan en `/var/lib/docker` o `/var/lib/containers`. Un build completo ocupa ~5-8 GB. Se recomienda al menos **10 GB libres** para evitar errores durante la construcción. |
| **Sistema Operativo** | RHEL 8/9, CentOS Stream 9, Ubuntu 22.04+ | |
| **Docker/Podman** | Docker CE 24+ ó Podman 4+ | |
| **Git** | 2.x | |

> ⚠️ **Antes de hacer el build**, verifica el espacio disponible en la partición de almacenamiento de contenedores:
> ```bash
> df -h /var          # Docker: /var/lib/docker
> df -h /home         # Podman (rootless): ~/.local/share/containers
> ```

---

## 📁 Estructura del proyecto

```
cmdb-enterprise-platform/
│
├── 📄 docker-compose.yml      ← Orquestación de los 4 servicios
├── 📄 .env.example            ← Plantilla de variables de entorno
├── 📄 .gitignore / .gitattributes
├── 📄 README.md
│
├── 📂 backend/                ← Motor de la API (Express + Prisma)
│   ├── Dockerfile             ← Build multi-stage Node.js
│   ├── entrypoint.sh          ← Ejecuta migraciones + arranca el servidor
│   ├── src/
│   │   └── index.ts           ← Servidor Express: rutas, auth JWT, CORS
│   └── prisma/
│       ├── schema.prisma      ← Modelos de datos (CI, User, Contract, Vendor…)
│       ├── seed.ts            ← Datos iniciales (usuarios, CIs, contratos)
│       └── migrations/        ← Historial de migraciones SQL
│
└── 📂 frontend/               ← Interfaz web (Next.js)
    ├── Dockerfile             ← Build multi-stage Next.js standalone
    ├── next.config.ts         ← output: standalone (para Docker)
    ├── app/                   ← Páginas (App Router)
    │   ├── page.tsx           ── Dashboard
    │   ├── inventory/         ── Inventario de CIs
    │   ├── contracts/         ── Contratos y Adendas
    │   ├── map/               ── Mapa de Dependencias (React Flow)
    │   └── login/             ── Autenticación
    ├── components/            ← Componentes reutilizables
    │   ├── Sidebar.tsx        ── Menú lateral con info de usuario
    │   ├── AppShell.tsx       ── Route guard + layout
    │   ├── AddCIModal.tsx     ── Modal crear CI
    │   └── AddContractModal.tsx
    ├── contexts/
    │   └── AuthContext.tsx    ← Estado global de autenticación (JWT)
    └── lib/
        └── apiFetch.ts        ← Fetch autenticado (inyecta Bearer token)
```

---

## 🔴 Instalación en RHEL (Recomendado para producción)

Esta sección cubre los pasos específicos para **Red Hat Enterprise Linux 8 / 9** (también aplica a CentOS Stream 9, Rocky Linux 8/9).

### Opción A — Docker CE (motor oficial)

```bash
# 1. Instalar utilidades y repositorio de Docker
sudo dnf install -y yum-utils
sudo yum-config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo

# 2. Instalar Docker Engine y el plugin de Compose
sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# 3. Habilitar e iniciar el servicio
sudo systemctl enable --now docker

# 4. Añadir tu usuario al grupo docker (evita usar sudo en cada comando)
sudo usermod -aG docker $USER
newgrp docker   # aplica el cambio sin cerrar sesión
```

### Opción B — Podman (preinstalado en RHEL 8/9, recomendado por Red Hat)

```bash
# Podman está disponible por defecto en RHEL 8+
sudo dnf install -y podman podman-docker

# Instalar docker-compose (compatible con Podman)
sudo dnf install -y python3-pip
pip3 install docker-compose

# Activar el socket de Podman (emula la API de Docker)
sudo systemctl enable --now podman.socket
export DOCKER_HOST=unix:///run/podman/podman.sock
```

---

### 🔒 SELinux — Permisos de volúmenes

Si SELinux está en modo **Enforcing** (configuración corporativa habitual en RHEL), los contenedores no podrán escribir en volúmenes sin el etiquetado correcto.

El `docker-compose.yml` ya incluye el sufijo `:Z` en los volúmenes:

```yaml
volumes:
  - postgres-data:/var/lib/postgresql/data:Z
```

| Sufijo | Significado |
|--------|-------------|
| `:Z`   | El contenido del volumen se etiqueta como **privado** para este contenedor. Usar cuando solo un contenedor monta el volumen. |
| `:z`   | El contenido se etiqueta como **compartido** (varios contenedores pueden acceder). |

> ⚠️ Si al arrancar PostgreSQL ves errores como `Permission denied` en los logs, verifica el modo SELinux con `getenforce`. Si devuelve `Enforcing`, el sufijo `:Z` lo soluciona automáticamente.

**Verificar el estado de SELinux:**
```bash
getenforce          # Enforcing | Permissive | Disabled
sestatus            # detalle completo
```

---

### 🔥 Firewall — Abrir puertos en RHEL

RHEL usa `firewalld` por defecto. Ejecuta estos comandos para permitir el tráfico a los contenedores:

```bash
# Abrir puertos requeridos por la plataforma
sudo firewall-cmd --permanent --add-port=3000/tcp   # Backend API
sudo firewall-cmd --permanent --add-port=3001/tcp   # Frontend web
sudo firewall-cmd --permanent --add-port=8080/tcp   # Adminer (DB UI)

# Aplicar los cambios
sudo firewall-cmd --reload

# Verificar que los puertos están abiertos
sudo firewall-cmd --list-ports
```

Salida esperada:
```
3000/tcp 3001/tcp 8080/tcp
```

> 💡 Si usas una nube (AWS, Azure, GCP), además abre los mismos puertos en el **Security Group** o **Network Security Group** correspondiente.

---

## 🚀 Despliegue con Docker

### Prerrequisitos

- Docker CE o Podman instalados (ver sección anterior)
- Git
- Puertos **3000**, **3001**, **5432** y **8080** abiertos en el firewall

### Paso 1 — Clonar el repositorio

```bash
git clone https://github.com/pirexia/cmdb-enterprise-platform.git
cd cmdb-enterprise-platform
```

### Paso 2 — Configurar las variables de entorno

```bash
cp .env.example .env
vi .env   # o nano .env
```

**Variables mínimas a cambiar en producción:**

```bash
POSTGRES_PASSWORD=contraseña_segura_aqui

# Genera una clave JWT fuerte:
# openssl rand -base64 48
JWT_SECRET=clave_jwt_muy_larga_y_aleatoria

# URL del backend como la verá el navegador del usuario
# Usa la IP pública o el nombre DNS del servidor:
NEXT_PUBLIC_API_URL=http://192.168.1.100:3000
```

### Paso 3 — Construir imágenes y levantar los contenedores

**Docker (Ubuntu / macOS / Windows):**
```bash
docker compose up -d --build
```

**Podman (RHEL / CentOS — recomendado en entornos Red Hat):**
```bash
# Instala podman-compose si aún no está disponible:
pip3 install podman-compose

podman-compose up -d --build
```

> 💡 En RHEL/CentOS, Red Hat recomienda **Podman** sobre Docker CE. El archivo `docker-compose.yml` es 100% compatible con `podman-compose` sin ningún cambio.

La primera vez tarda ~3-5 minutos mientras se compilan las imágenes.

**Verificar que todos los contenedores están en marcha:**
```bash
docker compose ps
```

Salida esperada:
```
NAME              IMAGE             STATUS          PORTS
cmdb-postgres     postgres:15-alpine  healthy       0.0.0.0:5432->5432/tcp
cmdb-adminer      adminer:latest      running       0.0.0.0:8080->8080/tcp
cmdb-backend      cmdb-backend        running       0.0.0.0:3000->3000/tcp
cmdb-frontend     cmdb-frontend       running       0.0.0.0:3001->3001/tcp
```

### Paso 4 — Cargar datos iniciales (seed)

```bash
docker exec cmdb-backend npx ts-node prisma/seed.ts
```

Resultado esperado:
```
✅ User created: admin [ADMIN] (admin@cmdb.local)
✅ User created: auditor [VIEWER] (auditor@cmdb.local)
✅ Vendor: Dell Technologies
✅ CI: PROD-SRV-01 Web Server
✅ Contract: CONT-DELL-2024-001
🎉 Seed complete!
   admin@cmdb.local   / admin123  [ADMIN]
   auditor@cmdb.local / audit123  [VIEWER]
```

### ¡Listo! Accede a la plataforma

| Servicio | URL |
|----------|-----|
| 🖥️ Dashboard web | http://\<servidor\>:3001 |
| 🔌 API REST | http://\<servidor\>:3000/health |
| 🗄️ Adminer (DB) | http://\<servidor\>:8080 |

---

## ⚙️ Variables de entorno

### Base de datos (PostgreSQL)

| Variable | Por defecto | Descripción |
|----------|-------------|-------------|
| `POSTGRES_DB` | `cmdb_db` | Nombre de la base de datos |
| `POSTGRES_USER` | `admin` | Usuario de PostgreSQL |
| `POSTGRES_PASSWORD` | `cmdb_pass123` | Contraseña — **cambia en producción** |
| `POSTGRES_PORT` | `5432` | Puerto del host mapeado al contenedor DB |

### Backend (API Express)

| Variable | Por defecto | Descripción |
|----------|-------------|-------------|
| `BACKEND_PORT` | `3000` | Puerto del host para la API REST |
| `JWT_SECRET` | *(requerido)* | Clave para firmar los tokens JWT. Mínimo 32 caracteres. Genera con `openssl rand -base64 48` |

> La `DATABASE_URL` de Prisma se construye automáticamente en el `docker-compose.yml`. **No necesitas definirla manualmente.**

### Frontend (Next.js)

| Variable | Por defecto | Descripción |
|----------|-------------|-------------|
| `FRONTEND_PORT` | `3001` | Puerto del host para la web |
| `NEXT_PUBLIC_API_URL` | `http://localhost:3000` | URL del backend **vista desde el navegador del usuario**. En producción debe ser la IP o dominio público del servidor. **Se graba en el bundle en tiempo de build** — cambiarla requiere reconstruir la imagen. |

> **Diferencia clave entre `NEXT_PUBLIC_*` y variables de servidor:**
> - `NEXT_PUBLIC_*` → accesibles en el **navegador** (código JavaScript del cliente). Se graban al compilar. No contienen secretos.
> - Variables sin ese prefijo → solo accesibles en el **servidor** (Node.js). Seguras para secretos como `JWT_SECRET`.

### Adminer

| Variable | Por defecto | Descripción |
|----------|-------------|-------------|
| `ADMINER_PORT` | `8080` | Puerto para la interfaz de gestión de la BD |

---

## 🔌 Tabla de puertos

| Puerto | Contenedor | Protocolo | Descripción | Abrir en firewall |
|--------|------------|-----------|-------------|-------------------|
| **3001** | `cmdb-frontend` | TCP | Interfaz web del CMDB (Next.js) | ✅ Sí |
| **3000** | `cmdb-backend` | TCP | API REST + autenticación JWT | ✅ Sí |
| **8080** | `cmdb-adminer` | TCP | Adminer — gestión visual de la BD | ⚠️ Solo redes internas |
| **5432** | `cmdb-postgres` | TCP | PostgreSQL — acceso directo a la BD | 🔒 Solo si es necesario |

---

## 🏗️ Arquitectura y flujo de datos

```
╔═══════════════════════════════════════════════════════════════════╗
║                    RHEL Server / Docker Host                       ║
║                                                                    ║
║   ┌──────────────────┐   NEXT_PUBLIC_API_URL   ┌────────────────┐ ║
║   │  cmdb-frontend   │──────────────────────────▶ cmdb-backend  │ ║
║   │  Next.js :3001   │    HTTP (JWT Bearer)     │ Express :3000  │ ║
║   └──────────────────┘                          └───────┬────────┘ ║
║           ▲                                             │          ║
║           │ HTTP :3001                          Prisma ORM         ║
║           │                                             │          ║
╚═══════════│═════════════════════════════════════════════│══════════╝
            │                                             ▼
    ┌───────┴────────┐                         ┌──────────────────┐
    │  User Browser  │                         │  cmdb-postgres   │
    │  (Chrome, etc) │                         │  PostgreSQL :5432│
    └────────────────┘                         │  Volume: :Z      │
                                               └──────────────────┘
                                                        ▲
                                               ┌────────┴─────────┐
                                               │  cmdb-adminer    │
                                               │  Adminer :8080   │
                                               └──────────────────┘

Comunicación interna Docker (red cmdb-network):
  frontend  ──▶  backend:3000    (service name, no IP needed)
  backend   ──▶  postgres:5432   (service name, no IP needed)
  adminer   ──▶  postgres:5432   (service name, no IP needed)

Comunicación externa (desde el navegador del usuario):
  browser   ──▶  <server-ip>:3001   (frontend)
  browser   ──▶  <server-ip>:3000   (API calls via NEXT_PUBLIC_API_URL)
```

**Flujo de una petición típica:**

```
1. Usuario abre http://<server>:3001
2. Next.js sirve la aplicación React desde cmdb-frontend
3. El navegador hace POST http://<server>:3000/api/auth/login
4. cmdb-backend verifica credenciales en cmdb-postgres (bcrypt)
5. cmdb-backend devuelve JWT token al navegador
6. Todas las peticiones siguientes incluyen el token: Authorization: Bearer <jwt>
7. cmdb-backend valida el token y consulta cmdb-postgres vía Prisma
8. Los datos se muestran en el dashboard
```

---

## 🔑 Credenciales por defecto

> Creadas al ejecutar el seed: `docker exec cmdb-backend npx ts-node prisma/seed.ts`

### Acceso web (http://\<servidor\>:3001)

| Email | Contraseña | Rol | Permisos |
|-------|-----------|-----|----------|
| `admin@cmdb.local` | `admin123` | **ADMIN** | Crear CIs, contratos, lanzar scans, ver todo |
| `auditor@cmdb.local` | `audit123` | **VIEWER** | Solo lectura — no crea ni modifica |

### Acceso Adminer (http://\<servidor\>:8080)

| Campo | Valor |
|-------|-------|
| Sistema | `PostgreSQL` |
| Servidor | `postgres` |
| Usuario | `admin` (o el valor de `POSTGRES_USER`) |
| Contraseña | `cmdb_pass123` (o el valor de `POSTGRES_PASSWORD`) |
| Base de datos | `cmdb_db` (o el valor de `POSTGRES_DB`) |

> ⚠️ Cambia todas las contraseñas por defecto antes de exponer el sistema a redes no confiables.

---

## 🔌 Conectores de Seguridad

Los conectores permiten importar datos de herramientas de seguridad externas para enriquecer el inventario.

### Flujo de trabajo

```
1. Exporta el reporte desde Greenbone / CrowdStrike
2. Ve a Conectores en el sidebar
3. Pega el JSON o carga el .json con el botón "Cargar archivo"
4. Pulsa "Procesar Datos"
5. El sistema hace matching de hosts → CIs por nombre (ILIKE)
6. Las vulnerabilidades se almacenan en el CI con status = NUEVO
7. Ve a Vulnerabilidades para gestionar el ciclo de vida
```

### Formato Greenbone

```json
{
  "scanner": "Greenbone Security Manager",
  "scan_date": "2026-03-13T18:00:00Z",
  "results": [
    {
      "host": { "hostname": "PROD-SRV-01 Web Server", "ip": "10.0.1.10" },
      "vulnerabilities": [
        { "cve": "CVE-2024-21413", "severity": "CRITICAL", "name": "...", "cvss_score": 9.8, "description": "..." }
      ]
    }
  ]
}
```

### Formato CrowdStrike

```json
{
  "platform": "CrowdStrike Falcon",
  "export_date": "2026-03-13T19:00:00Z",
  "devices": [
    { "hostname": "PROD-SRV-01", "agent_id": "abc123", "agent_version": "7.14.17706.0",
      "status": "normal", "prevention_policy": "active", "last_seen": "...", "detections": [] }
  ]
}
```

> 📁 Archivos de ejemplo disponibles en [`docs/mocks/`](docs/mocks/)

---

## 🗂️ Ciclo de Vida de Vulnerabilidades

Cada vulnerabilidad importada vía Greenbone tiene un estado que puede gestionar el equipo de seguridad:

```
NUEVO ──▶ ASIGNADO ──▶ EN_CURSO ──▶ RESUELTO
                          │
                          ▼
                        PARADO
```

| Estado | Color | Descripción |
|--------|-------|-------------|
| **NUEVO** | 🔵 Azul | Recién importado, pendiente de revisión |
| **ASIGNADO** | 🟣 Morado | Asignado a un equipo para análisis |
| **EN_CURSO** | 🟡 Amarillo | Mitigación en progreso |
| **PARADO** | 🟠 Naranja | Bloqueado por dependencia externa |
| **RESUELTO** | 🟢 Verde | Vulnerabilidad corregida y verificada |

El estado se puede cambiar directamente desde la tabla en **Vulnerabilidades** usando el dropdown por fila.

---

## 📡 API Reference

Todos los endpoints excepto `/api/auth/login` y `/health` requieren:
```
Authorization: Bearer <token>
```

| Método | Endpoint | Rol mínimo | Descripción |
|--------|----------|-----------|-------------|
| `POST` | `/api/auth/login` | — público — | Obtener token JWT |
| `GET` | `/health` | — público — | Health check |
| `GET` | `/api/cis` | VIEWER | Listar todos los CIs con relaciones y vulnerabilidades |
| `POST` | `/api/cis` | **ADMIN** | Crear nuevo CI (hardware/software) |
| `PATCH` | `/api/vulnerabilities` | VIEWER | Actualizar estado de una vulnerabilidad (`{ ciId, cve, status }`) |
| `GET` | `/api/contracts` | VIEWER | Listar contratos con CIs y proveedor |
| `POST` | `/api/contracts` | **ADMIN** | Crear contrato o adenda |
| `GET` | `/api/vendors` | VIEWER | Listar proveedores |
| `GET` | `/api/users` | VIEWER | Listar usuarios (para selectors de formularios) |
| `POST` | `/api/integrations/greenbone` | **ADMIN** | Importar reporte Greenbone OpenVAS |
| `POST` | `/api/integrations/crowdstrike` | **ADMIN** | Importar estado de agentes CrowdStrike Falcon |

**Ejemplo de login:**
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@cmdb.local","password":"admin123"}'
```

---

## 💻 Desarrollo local (sin Docker)

Si prefieres ejecutar el proyecto sin Docker para desarrollo:

### Base de datos

```bash
# Levanta solo PostgreSQL
docker compose up -d postgres
```

### Backend

```bash
cd backend
cp .env.example .env      # ajusta DATABASE_URL si es necesario
npm install
npx prisma migrate dev    # aplica migraciones en dev
npx ts-node prisma/seed.ts
npm run dev               # http://localhost:3000
```

### Frontend

```bash
cd frontend
npm install
npm run dev               # http://localhost:3001
```

---

## 🔧 Comandos útiles de mantenimiento

```bash
# Ver logs de todos los contenedores
docker compose logs -f

# Ver logs de un contenedor específico
docker compose logs -f backend

# Reiniciar un contenedor sin reconstruir
docker compose restart backend

# Reconstruir solo el backend (tras cambios de código)
docker compose up -d --build backend

# Parar todo sin borrar volúmenes
docker compose down

# Parar y borrar volúmenes (¡BORRA LA BASE DE DATOS!)
docker compose down -v

# Ejecutar migraciones manualmente
docker exec cmdb-backend npx prisma migrate deploy

# Ver el estado de las migraciones
docker exec cmdb-backend npx prisma migrate status
```

---

## 📜 Licencia

MIT — libre para uso personal y comercial.

---

> Desarrollado como plataforma de referencia para equipos de IT Operations, Compliance y Ciberseguridad.
> Testado en RHEL 8/9, CentOS Stream 9, Ubuntu 22.04 y macOS con Docker Desktop.
