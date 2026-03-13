# 🏛️ Enterprise CMDB & GRC Platform

> **Configuration Management Database** — Plataforma integral para la gestión de activos de TI (CIs), contratos de proveedores, análisis de vulnerabilidades y visualización de dependencias, con autenticación JWT y control de acceso basado en roles (RBAC).

[![Stack](https://img.shields.io/badge/stack-Node.js%20%7C%20Next.js%20%7C%20PostgreSQL-blue)](https://github.com/pirexia/cmdb-enterprise-platform)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

---

## 📋 Tabla de contenidos

1. [Características](#-características)
2. [Stack tecnológico](#-stack-tecnológico)
3. [Estructura del proyecto](#-estructura-del-proyecto)
4. [Despliegue con Docker (recomendado)](#-despliegue-con-docker-recomendado)
5. [Variables de entorno](#-variables-de-entorno)
6. [Tabla de puertos](#-tabla-de-puertos)
7. [Credenciales por defecto](#-credenciales-por-defecto)
8. [API Reference](#-api-reference)
9. [Desarrollo local (sin Docker)](#-desarrollo-local-sin-docker)

---

## ✨ Características

| Módulo | Descripción |
|--------|-------------|
| 📊 **Dashboard** | Resumen ejecutivo: totales por tipo, entorno, criticidad y estado de seguridad global |
| 🖥️ **Inventario de CIs** | CRUD completo de Configuration Items (Hardware / Software / Otro) con jerarquía padre-hijo |
| 🕸️ **Mapa de Dependencias** | Canvas interactivo (React Flow) con layout jerárquico automático, alertas de contratos próximos a vencer y vulnerabilidades críticas parpadeantes |
| 📜 **Contratos y Adendas** | Gestión de contratos M:N vinculados a CIs, soporte de adendas y semáforo de vencimiento |
| 🛡️ **Gestión de Vulnerabilidades** | Escáner simulado por CI con CVEs reales (CVSS 2023-2024), clasificación por severidad y persistencia JSON en BD |
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
| **Contenedores** | Docker · Docker Compose v3.9 |

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

## 🚀 Despliegue con Docker (recomendado)

### Prerrequisitos

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (o Docker Engine + Compose plugin en Linux)
- Git
- Puerto **3000**, **3001**, **5432** y **8080** libres en el servidor

### Paso 1 — Clonar el repositorio

```bash
git clone https://github.com/pirexia/cmdb-enterprise-platform.git
cd cmdb-enterprise-platform
```

### Paso 2 — Configurar las variables de entorno

```bash
cp .env.example .env
```

Edita `.env` con tu editor favorito y **como mínimo** cambia:

```bash
# Contraseña de la base de datos
POSTGRES_PASSWORD=cambia_esto_en_produccion

# Clave secreta para los tokens JWT — usa una cadena larga y aleatoria
# Genera una con:  openssl rand -base64 48
JWT_SECRET=cambia_esto_por_una_clave_larga_y_aleatoria

# URL del backend tal como la verá el NAVEGADOR del usuario
# En un servidor remoto, usa la IP o dominio público:
NEXT_PUBLIC_API_URL=http://<IP_DEL_SERVIDOR>:3000
```

> ⚠️ **Importante:** `NEXT_PUBLIC_API_URL` se **integra en el bundle de JavaScript** en el momento del build. Si la cambias después del build, debes reconstruir la imagen del frontend.

### Paso 3 — Construir imágenes y levantar los contenedores

```bash
docker compose up -d --build
```

La primera vez tarda ~3-5 minutos mientras se construyen las imágenes. En ejecuciones posteriores (sin `--build`) arranca en segundos.

Una vez completado verás los 4 contenedores corriendo:

```
✔ Container cmdb-postgres   Started
✔ Container cmdb-adminer    Started
✔ Container cmdb-backend    Started  (ejecuta migraciones automáticamente)
✔ Container cmdb-frontend   Started
```

### Paso 4 — Cargar datos iniciales (seed)

El seed crea los usuarios de prueba, CIs de ejemplo y un contrato:

```bash
docker exec cmdb-backend npx ts-node prisma/seed.ts
```

> El resultado mostrará los usuarios creados con sus roles y las credenciales de acceso.

### ¡Listo! Accede a la plataforma

| Servicio | URL |
|----------|-----|
| 🖥️ Dashboard web | http://localhost:3001 |
| 🔌 API REST | http://localhost:3000 |
| 🗄️ Adminer (DB) | http://localhost:8080 |

---

## ⚙️ Variables de entorno

Todas las variables se configuran en el archivo `.env` de la raíz (copia de `.env.example`).

### Base de datos (PostgreSQL)

| Variable | Por defecto | Descripción |
|----------|-------------|-------------|
| `POSTGRES_DB` | `cmdb_db` | Nombre de la base de datos |
| `POSTGRES_USER` | `admin` | Usuario de PostgreSQL |
| `POSTGRES_PASSWORD` | `cmdb_pass123` | Contraseña — **cambia en producción** |
| `POSTGRES_PORT` | `5432` | Puerto del host mapeado al contenedor |

### Backend (API Express)

| Variable | Por defecto | Descripción |
|----------|-------------|-------------|
| `BACKEND_PORT` | `3000` | Puerto del host para la API |
| `JWT_SECRET` | *(requerido)* | Clave para firmar los tokens JWT. Mínimo 32 caracteres aleatorios |

> La `DATABASE_URL` de Prisma se construye automáticamente en el `docker-compose.yml` usando las variables `POSTGRES_*`. No necesitas definirla.

### Frontend (Next.js)

| Variable | Por defecto | Descripción |
|----------|-------------|-------------|
| `FRONTEND_PORT` | `3001` | Puerto del host para la web |
| `NEXT_PUBLIC_API_URL` | `http://localhost:3000` | URL del backend **vista desde el navegador**. En producción usa la IP pública o dominio del servidor. Se graba en el bundle en tiempo de build. |

> **Diferencia clave entre variables `NEXT_PUBLIC_*` y el resto:**
> - Las variables `NEXT_PUBLIC_*` son accesibles desde el código JavaScript del navegador. Se graban en el bundle al construir la imagen Docker y **no se pueden cambiar en tiempo de ejecución** sin reconstruir.
> - Las variables sin ese prefijo (`JWT_SECRET`, `DATABASE_URL`, etc.) solo son accesibles en el servidor (backend) y son seguras.

### Adminer

| Variable | Por defecto | Descripción |
|----------|-------------|-------------|
| `ADMINER_PORT` | `8080` | Puerto para la interfaz de gestión de la BD |

---

## 🔌 Tabla de puertos

| Puerto | Servicio | Descripción |
|--------|----------|-------------|
| **3001** | Frontend (Next.js) | Interfaz web del CMDB |
| **3000** | Backend (Express API) | API REST + autenticación JWT |
| **8080** | Adminer | Gestión visual de la base de datos |
| **5432** | PostgreSQL | Base de datos (acceso directo, solo si necesario) |

---

## 🔑 Credenciales por defecto

Creadas automáticamente al ejecutar el seed (`docker exec cmdb-backend npx ts-node prisma/seed.ts`):

| Email | Contraseña | Rol | Permisos |
|-------|-----------|-----|----------|
| `admin@cmdb.local` | `admin123` | **ADMIN** | Crear CIs, crear contratos, lanzar scans, ver todo |
| `auditor@cmdb.local` | `audit123` | **VIEWER** | Solo lectura — no puede crear ni modificar nada |

> Cambia estas contraseñas después del primer acceso en un entorno de producción.

**Acceso a Adminer:**
- URL: http://localhost:8080
- Sistema: `PostgreSQL`
- Servidor: `postgres`
- Usuario: valor de `POSTGRES_USER` (por defecto `admin`)
- Contraseña: valor de `POSTGRES_PASSWORD`
- Base de datos: valor de `POSTGRES_DB` (por defecto `cmdb_db`)

---

## 📡 API Reference

Todos los endpoints excepto `/api/auth/login` requieren el header:
```
Authorization: Bearer <token>
```

| Método | Endpoint | Rol mínimo | Descripción |
|--------|----------|-----------|-------------|
| `POST` | `/api/auth/login` | — público — | Obtener token JWT |
| `GET` | `/api/cis` | VIEWER | Listar todos los CIs con relaciones |
| `POST` | `/api/cis` | **ADMIN** | Crear nuevo CI (hardware/software) |
| `POST` | `/api/cis/:id/scan` | **ADMIN** | Lanzar escaneo de vulnerabilidades |
| `GET` | `/api/contracts` | VIEWER | Listar contratos con CIs y proveedor |
| `POST` | `/api/contracts` | **ADMIN** | Crear contrato o adenda |
| `GET` | `/api/vendors` | VIEWER | Listar proveedores |
| `GET` | `/api/users` | VIEWER | Listar usuarios (para selectors) |
| `GET` | `/health` | — público — | Health check del servidor |

**Ejemplo de login:**
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@cmdb.local","password":"admin123"}'
```

---

## 💻 Desarrollo local (sin Docker)

Si prefieres ejecutar el proyecto sin Docker:

### Base de datos

```bash
# Levanta solo PostgreSQL con Docker
docker compose up -d postgres
```

### Backend

```bash
cd backend
cp .env.example .env        # ajusta DATABASE_URL si es necesario
npm install
npx prisma migrate dev      # aplica migraciones
npx ts-node prisma/seed.ts  # carga datos iniciales
npm run dev                 # arranca en http://localhost:3000
```

### Frontend

```bash
cd frontend
npm install
npm run dev                 # arranca en http://localhost:3001
```

---

## 📜 Licencia

MIT — libre para uso personal y comercial.

---

> Desarrollado como plataforma de referencia para equipos de IT Operations, Compliance y Ciberseguridad.
