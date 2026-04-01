# 🏛️ Enterprise CMDB & GRC Platform

> **Configuration Management Database** — Plataforma integral para la gestión de activos de TI (CIs), contratos de proveedores, análisis de vulnerabilidades y visualización de dependencias, con autenticación JWT, control de acceso basado en roles (RBAC) y soporte multilingüe.

[![Stack](https://img.shields.io/badge/stack-Node.js%20%7C%20Next.js%20%7C%20PostgreSQL-blue)](https://github.com/pirexia/cmdb-enterprise-platform)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![RHEL](https://img.shields.io/badge/tested%20on-RHEL%208%2F9-red)](https://www.redhat.com/en/technologies/linux-platforms/enterprise-linux)
[![Version](https://img.shields.io/badge/version-1.3.0-informational)](https://github.com/pirexia/cmdb-enterprise-platform/releases/tag/v1.3.0)

---

## 📋 Tabla de contenidos

1. [Características](#-características)
2. [Stack tecnológico](#-stack-tecnológico)
3. [Estructura del proyecto](#-estructura-del-proyecto)
4. [Documentación Oficial](#-documentación-oficial)
5. [Quickstart para Desarrollo](#-quickstart-para-desarrollo)

---

## ✨ Características Enterprise

### Core Features

| Módulo | Descripción |
|--------|-------------|
| 🌍 **Soporte Multilingüe (i18n)** | Interfaz completa en Español e Inglés con selector de idioma persistente y contextos compartidos. |
| 🔐 **Seguridad Enterprise** | Autenticación Híbrida LDAP/AD + Local con fail-soft fallback, MFA (TOTP RFC 6238) **obligatorio para admins** y sugerido para usuarios en primer login, dispositivos de confianza con TTL configurable, RBAC tres niveles (Admin/Auditor/Viewer), JWT HS256, bcrypt cost-10, conformidad ISO 27001. |
| 📡 **Inteligencia de Ciclo de Vida** | Integración con endoflife.date API para automatización de EOL/EOSL, centro de consulta de hardware/software, verificación manual con fuentes externas. |
| 📧 **Proactividad (Alertas)** | Motor de alertas diarias (cron) con informes personalizados por email sobre vencimientos de contratos, CIs próximos a EoL/EoS y vulnerabilidades críticas/altas. |
| 🕸️ **Topología y Dependencias** | Relaciones N:M entre CIs con 5 tipos (HOSTS, DEPENDS_ON, CONNECTED_TO, PROVIDES_SERVICE, BACKED_UP_BY), análisis de impacto, mapa de dependencias por CI con grafo enfocado e interactivo (React Flow). |
| 🐳 **Infraestructura Production-Ready** | Despliegue Podman Rootless en RHEL con persistencia (loginctl enable-linger), imágenes multi-stage, usuario de servicio dedicado, conformidad Zero Trust. |

### CMDB Core

| Módulo | Descripción |
|--------|-------------|
| 📊 **Dashboard** | Resumen ejecutivo interactivo de CIs, vulnerabilidades, contratos y estado de seguridad en tiempo real. |
| 🖥️ **Inventario de CIs** | Gestión completa (CRUD) de Configuration Items con taxonomía dinámica y extensible agrupada por categorías (Infraestructura, Dispositivos Usuario, Movilidad/IoT, Salas de Reunión, Software, Licencias), criticidad, entorno y metadatos hardware/software. |
| 📜 **Contratos y Adendas** | Gestión de contratos M:N vinculados a CIs, soporte de adendas jerárquicas y monitoreo automático de vencimientos. |
| 🛡️ **Gestión de Vulnerabilidades** | Vista centralizada de CVEs, ciclo de vida (Nuevo → Asignado → En Curso → Resuelto), integración con Greenbone OpenVAS y CrowdStrike Falcon. |
| 📋 **Centro de Reportes** | Generación de informes en PDF/CSV: obsolescencia, contratos próximos a vencer, informe ejecutivo de seguridad. |
| 🗂️ **Datos Maestros** | CRUD completo de tablas auxiliares: **Tipos de CI** (con categorías configurables), Áreas de Soporte, Sedes, Fabricantes, Modelos de Dispositivos, Proveedores. Navegación vertical en barra lateral. |
| 🕵️ **Registro de Auditoría** | Trazabilidad completa de todas las acciones administrativas con purga automático de registros antiguos (retención configurable). |

### Security & Operations

| Feature | Descripción |
|---------|-------------|
| 🔒 **SSL/TLS Management** | Generación de CSR via UI, upload de certificados firmados, TLS fallback automático a HTTP si faltan certificados. |
| 🔑 **LDAP/AD Hybrid Auth** | Pre-check de dominio (@cmdb.local bypasses LDAP), fail-soft fallback a base de datos local ante caídas del AD. |
| 📦 **Database Maintenance** | Purga automática de audit logs (AUDIT_RETENTION_DAYS), script de VACUUM ANALYZE + REINDEX semanal, monitorización de bloat PostgreSQL. |
| 💾 **Capacity Planning** | Documentación LVM dedicado para /home (Podman rootless), tablas de dimensionamiento por volumen de CIs (1K, 5K, 20K+). |
| 🏗️ **ISO 27001 Ready** | Usuario de servicio dedicado, permisos restrictivos (750/600), cgroupfs configuration para estabilidad RHEL/Podman. |
| 🌐 **Dynamic Branding** | White-label: nombre de empresa, logo y colores corporativos configurables vía variables de entorno. |

---

## 🛠️ Stack tecnológico

| Capa | Tecnología |
|------|-----------|
| **Base de datos** | PostgreSQL 16 |
| **ORM** | Prisma 5 |
| **Backend** | Node.js 20 · Express 5 · TypeScript 5 |
| **Auth** | JWT (jsonwebtoken) · bcrypt · speakeasy (MFA) · ldap-authentication |
| **Frontend** | Next.js 16 (App Router) · React 19 · Tailwind CSS 4 |
| **Visualización** | React Flow 11 · Lucide React |
| **Contenedores** | Docker CE / Podman · Docker Compose v2 |
| **Seguridad** | Helmet 8 · HTTPS/TLS (Node.js nativo) |
| **Automatización** | node-cron · nodemailer |

---

## 📁 Estructura del proyecto

```
cmdb-enterprise-platform/
│
├── 📄 docker-compose.yml        ← Orquestación para DESARROLLO (con Adminer)
├── 📄 docker-compose.prod.yml   ← Orquestación para PRODUCCIÓN (optimizada, sin Adminer)
├── 📄 .env.example              ← Plantilla de variables de entorno
├── 📄 .gitignore / .gitattributes
├── 📄 README.md
│
├── 📂 backend/                  ← Motor de la API (Express + Prisma)
│   ├── Dockerfile               ← Build multi-stage Node.js
│   ├── entrypoint.sh            ← Ejecuta migraciones + arranca el servidor
│   ├── src/
│   │   └── index.ts             ← Servidor Express: rutas, auth JWT, CORS, cron jobs
│   │   └── services/            ← Lógica de negocio: LDAP, EoL, emailService
│   ├── prisma/
│   │   ├── schema.prisma        ← Modelos de datos (CI, User, Contract, Vendor…)
│   │   ├── seed.ts              ← Datos iniciales (usuarios, CIs, contratos)
│   │   └── migrations/          ← Historial de migraciones SQL
│   └── scripts/                 ← generate-certs.sh/ps1, resetVulnerabilities.ts
│
├── 📂 frontend/                 ← Interfaz web (Next.js)
│   ├── Dockerfile               ← Build multi-stage Next.js standalone
│   ├── next.config.ts           ← output: standalone (para Docker), headers de seguridad
│   ├── app/                     ← Páginas (App Router): inventory, contracts, map, settings…
│   ├── components/              ← Componentes reutilizables: Sidebar, AppShell, AddCIModal…
│   ├── contexts/                ← AuthContext, LanguageContext
│   ├── lib/                     ← apiFetch, csvExport, printReport
│   ├── locales/                 ← es.json, en.json (diccionarios i18n)
│   └── public/                  ← Assets estáticos
│
└── 📂 docs/                    ← Documentación oficial de la plataforma
    ├── ARCHITECTURE.md          ← Arquitectura técnica y topología
    ├── SYSADMIN_MANUAL.md       ← Guía para administradores de sistemas
    └── USER_MANUAL.md           ← Manual de usuario final
```

---

## 📚 Documentación Oficial

Para una comprensión completa del sistema, su despliegue y uso, consulta la documentación oficial:

- **📖 [Manual de Usuario](docs/USER_MANUAL.md)**: Guía completa para operadores y administradores de la CMDB, incluyendo gestión de perfiles, roles, inventario, vulnerabilidades, contratos, reportes y el centro de consulta de ciclo de vida.

- **🛠️ [Manual del Administrador de Sistemas](docs/SYSADMIN_MANUAL.md)**: Instrucciones detalladas para el despliegue, configuración (`.env`, SSL/HTTPS), gestión de backups, monitorización y troubleshooting en entornos de producción RHEL/Podman.

- **🚀 [Guía de Despliegue en Producción](DEPLOY.md)**: Comandos exactos y consideraciones para el despliegue optimizado en un servidor Red Hat, incluyendo SELinux y `firewalld`.

- **🏗️ [Arquitectura Técnica](docs/ARCHITECTURE.md)**: Descripción profunda del stack tecnológico, la topología de red, flujos de tráfico y el modelo de datos de la plataforma.

---

## 👨‍💻 Quickstart para Desarrollo

Para poner el proyecto en marcha rápidamente en un entorno de desarrollo local con Docker Compose (usando `docker-compose.yml`):

1. **Clonar el repositorio:**
   ```bash
   git clone https://github.com/pirexia/cmdb-enterprise-platform.git
   cd cmdb-enterprise-platform
   ```

2. **Configurar variables de entorno:**
   Copia el archivo de ejemplo y edítalo con tus valores (especialmente las contraseñas de la BD y `JWT_SECRET`)
   ```bash
   cp .env.example .env
   # edita .env con tu editor favorito
   ```

3. **Levantar los servicios:**
   ```bash
   docker compose up -d --build
   ```
   > El backend ejecuta automáticamente las migraciones y el seed inicial (usuarios, CIs y contratos de ejemplo) en el primer arranque. No es necesario ningún paso adicional.

4. **Accede a la plataforma:**
   - **Frontend (UI):** `http://localhost:3001`
   - **Backend (API):** `http://localhost:3000/health`
   - **Adminer (DB UI):** `http://localhost:8080` (usuario `admin`, contraseña de `.env`)

   **Credenciales por defecto (desarrollo):**
   - Admin: `admin@cmdb.local` / `Admin1234!`
   - Auditor: `auditor@cmdb.local` / `Audit1234!`
   
   ⚠️ **Cambiar contraseñas inmediatamente tras el primer login en producción.**

---

## 📜 Licencia

MIT — libre para uso personal y comercial.
