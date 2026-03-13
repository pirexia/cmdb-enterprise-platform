# 🏛️ Enterprise CMDB & GRC Platform

> **Configuration Management Database** — Plataforma integral para la gestión de activos de TI, contratos de proveedores, análisis de vulnerabilidades y visualización de dependencias, con control de acceso basado en roles (RBAC).

---

## ✨ Características principales

| Módulo | Descripción |
|--------|-------------|
| 📊 **Dashboard** | Resumen ejecutivo con totales por tipo, entorno, criticidad y estado de seguridad global |
| 🖥️ **Inventario de CIs** | CRUD completo de Configuration Items (Hardware, Software, Otro) con relaciones padre/hijo |
| 🕸️ **Mapa de Dependencias** | Canvas interactivo (React Flow) con layout jerárquico automático, alertas de contratos vencidos y vulnerabilidades CRITICAL |
| 📜 **Contratos y Adendas** | Gestión de contratos M:N con CIs, soporte de adendas y semáforo de vencimiento |
| 🛡️ **Gestión de Vulnerabilidades** | Escáner simulado por CI con CVEs reales, clasificación CVSS y persistencia en base de datos |
| 🔐 **IAM / RBAC** | Autenticación JWT, roles ADMIN/VIEWER, rutas protegidas en frontend y backend |

---

## 🛠️ Stack Tecnológico

```
Backend                         Frontend
────────────────────────────    ────────────────────────────
Node.js 20 + TypeScript         Next.js 15 (App Router)
Express 4                       React 19
Prisma ORM 5                    Tailwind CSS v4
PostgreSQL 15                   React Flow (dependency map)
bcrypt + jsonwebtoken           Lucide React (icons)
```

---

## 📁 Estructura del proyecto

```
cmdb-enterprise-platform/
├── backend/                    # API REST con Express + Prisma
│   ├── prisma/
│   │   ├── schema.prisma       # Modelos de datos
│   │   ├── seed.ts             # Datos iniciales (usuarios, CIs, contratos)
│   │   └── migrations/         # Historial de migraciones SQL
│   └── src/
│       └── index.ts            # Servidor Express con todas las rutas
│
├── frontend/                   # Dashboard Next.js
│   ├── app/                    # Pages (App Router)
│   │   ├── page.tsx            # Dashboard
│   │   ├── inventory/          # Inventario de CIs
│   │   ├── contracts/          # Contratos y Adendas
│   │   ├── map/                # Mapa de Dependencias
│   │   ├── login/              # Página de acceso
│   │   └── ...
│   ├── components/             # Componentes reutilizables
│   ├── contexts/               # AuthContext (JWT + RBAC)
│   └── lib/                    # apiFetch (fetch autenticado)
│
├── docker-compose.yml          # PostgreSQL + pgAdmin
└── README.md
```

---

## 🚀 Instalación rápida

### Prerrequisitos

- [Node.js 20+](https://nodejs.org/)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- [Git](https://git-scm.com/)

### 1 · Clonar el repositorio

```bash
git clone https://github.com/<your-org>/cmdb-enterprise-platform.git
cd cmdb-enterprise-platform
```

### 2 · Levantar la base de datos (PostgreSQL)

```bash
docker compose up -d
```

> Esto inicia PostgreSQL en `localhost:5432` y pgAdmin en `http://localhost:5050`.

### 3 · Configurar el backend

```bash
cd backend
cp .env.example .env
# Edita .env si necesitas cambiar credenciales o el JWT_SECRET
```

```bash
npm install
npx prisma migrate deploy   # aplica todas las migraciones
npx ts-node prisma/seed.ts  # carga datos de ejemplo
```

### 4 · Arrancar el backend

```bash
npm run dev
# → API disponible en http://localhost:3000
```

### 5 · Arrancar el frontend

```bash
cd ../frontend
npm install
npm run dev
# → Dashboard disponible en http://localhost:3001
```

---

## 🔑 Credenciales de prueba

| Email | Contraseña | Rol |
|-------|-----------|-----|
| `admin@cmdb.local` | `admin123` | **ADMIN** — acceso completo |
| `auditor@cmdb.local` | `audit123` | **VIEWER** — solo lectura |

---

## 🌐 Endpoints de la API

| Método | Ruta | Acceso | Descripción |
|--------|------|--------|-------------|
| `POST` | `/api/auth/login` | Público | Obtener JWT |
| `GET` | `/api/cis` | Cualquier rol | Listar todos los CIs |
| `POST` | `/api/cis` | ADMIN | Crear CI |
| `POST` | `/api/cis/:id/scan` | ADMIN | Escanear vulnerabilidades |
| `GET` | `/api/contracts` | Cualquier rol | Listar contratos |
| `POST` | `/api/contracts` | ADMIN | Crear contrato/adenda |
| `GET` | `/api/vendors` | Cualquier rol | Listar proveedores |
| `GET` | `/api/users` | Cualquier rol | Listar usuarios |

---

## 🗃️ Modelo de datos (simplificado)

```
User ──────────── CI ──── HardwareCI
(ADMIN/VIEWER)     │ └─── SoftwareCI
                   │
                   ├── parentCI (jerarquía)
                   └── contracts ──── Contract ──── Vendor
                                          └── addendums (adendas)
```

---

## 📜 Licencia

MIT — libre para uso personal y comercial.

---

> Desarrollado como plataforma de referencia para equipos de IT Operations, Compliance y Ciberseguridad.
