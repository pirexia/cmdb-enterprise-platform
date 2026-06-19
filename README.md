# 🏛️ Enterprise CMDB & GRC Platform

> 🇬🇧 [English version available](README.en.md)

> **Configuration Management Database** — Plataforma integral para la gestión de activos de TI (CIs), contratos de proveedores, análisis de vulnerabilidades y visualización de dependencias, con autenticación JWT, control de acceso basado en roles (RBAC) y soporte multilingüe.

[![Stack](https://img.shields.io/badge/stack-Node.js%20%7C%20Next.js%20%7C%20PostgreSQL-blue)](https://github.com/pirexia/cmdb-enterprise-platform)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![RHEL](https://img.shields.io/badge/tested%20on-RHEL%208%2F9-red)](https://www.redhat.com/en/technologies/linux-platforms/enterprise-linux)
[![Version](https://img.shields.io/badge/version-2.8.7-informational)](https://github.com/pirexia/cmdb-enterprise-platform/releases/tag/v2.8.7)

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
| 🔐 **Seguridad Enterprise** | Autenticación Híbrida LDAP/AD + Local con fail-soft fallback, MFA (TOTP RFC 6238) **obligatorio para admins** y sugerido para usuarios en primer login, dispositivos de confianza con TTL configurable, RBAC tres niveles (Admin/Auditor/Viewer), JWT HS256, bcrypt cost-10, **política de contraseñas configurable** (longitud por rol, complejidad, diccionario, historial de 20), conformidad ISO 27001. |
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
| 📁 **Repositorio Documental** | Gestión segura de documentos con control de versiones, tipos configurables, relaciones entre documentos y asociaciones bidireccionales entre CIs, documentos y contratos. Visor embebido (PDF, imagen, texto), notas inmutables por documento, validación de magic bytes, almacenamiento con UUID y descarga autenticada. Almacenamiento configurable mediante bind mount o NFS (`DOCUMENTS_STORAGE_PATH`). |
| 🔑 **Repositorio de Licencias** | Inventario centralizado de licencias de software con catálogos configurables de tipos (14 predefinidos) y métricas (25 predefinidas). Cada licencia registra proveedor, tipo, métrica de uso, coste, periodo de vigencia y estado automático (Activa / Por vencer / Vencida / Borrador). Asociaciones M:N con CIs y documentos. Gestión de usuarios de licencia (nombre, DNI, email) sin dependencia del directorio de usuarios del sistema. Soporte de jerarquía (licencia padre / sublicencia). |
| 🤖 **Asistente IA local con RAG** | Chat conversacional para buscar información en documentos (contratos, procedimientos, etc.) y en entidades estructuradas (CIs, contratos, licencias, vulnerabilidades) usando un modelo de lenguaje local (Ollama + pgvector). Sin transferencia de datos a servicios externos. Citaciones obligatorias en cada respuesta — los enlaces de citación abren el ítem citado en su listado. Cinco filtros multi-select para acotar las fuentes. Respeta los permisos de visibilidad por rol. **OCR automático para PDFs escaneados** (Tesseract 5, incluido en la imagen Docker). Ver `docs/RAG_HOST_PREPARATION.md` para requisitos del servidor y `docs/SYSADMIN_MANUAL.md §20` para la configuración OCR. |

### Security & Operations

| Feature | Descripción |
|---------|-------------|
| 🔒 **SSL/TLS Management** | Generación de CSR via UI, upload de certificados firmados, TLS fallback automático a HTTP si faltan certificados. |
| 🔑 **LDAP/AD Hybrid Auth** | Pre-check de dominio (@cmdb.local bypasses LDAP), fail-soft fallback a base de datos local ante caídas del AD. |
| 📦 **Database Maintenance** | Purga automática de audit logs (AUDIT_RETENTION_DAYS), script de VACUUM ANALYZE + REINDEX semanal, monitorización de bloat PostgreSQL. |
| 💾 **Capacity Planning** | Documentación LVM dedicado para /home (Podman rootless), tablas de dimensionamiento por volumen de CIs (1K, 5K, 20K+). |
| 🏗️ **ISO 27001 Ready** | Usuario de servicio dedicado, permisos restrictivos (750/600), cgroupfs configuration para estabilidad RHEL/Podman. |
| 🌐 **Dynamic Branding** | White-label: nombre de empresa, logo y colores corporativos configurables vía variables de entorno. |
| 🧩 **Plugin Engine** (v2.8.0+) | Motor de extensiones para ADMIN: instalar/activar/desinstalar plugins de terceros con sandbox `vm.Script`, gate de admisión (firma Ed25519 + checksum SHA-256 + aprobación 4-eyes en prod), 12 endpoints REST, hooks del ciclo de vida del core, migraciones DDL aisladas (rol DB restringido + prefijo `plg_`), UI por iframe en 7 slots, marketplace y panel `/plugins/admin`. Ver [docs/PLUGIN_ENGINE.md](docs/PLUGIN_ENGINE.md). |
| 🛒 **Marketplace de Plugins** (v2.8.5) | Instalación one-click desde un servidor de marketplace configurado: descarga ZIP server-side (SSRF allowlist HTTPS-only, sin IPs privadas), validación magic bytes + manifiesto Zod + checksum SHA-256, pipeline validate+install en una sola request. UI con buscador, filtro de categoría y badge de versión mínima. Ver [docs/PLUGIN_MARKETPLACE.md](docs/PLUGIN_MARKETPLACE.md). |
| ⚡ **Módulo Decomisionado** (v2.8.5) | Gestión de planes de desconexión de sistemas: inventario recursivo via CTE PostgreSQL (hasta 8 niveles, anti-ciclos), Gantt SVG sin dependencias adicionales, CRUD de documentos/contratos/licencias vinculados (AUTO/MANUAL), validación de coherencia de fechas, impresión. Requiere CIType "Sistema" y la fecha `decommission-date` asignada al CI via `CIDate`. |

---

## 🛠️ Stack tecnológico

| Capa | Tecnología |
|------|-----------|
| **Base de datos** | PostgreSQL 16 |
| **ORM** | Prisma 5 |
| **Backend** | Node.js 22 · Express 5 · TypeScript 5 |
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
├── 📄 .env.example              ← Plantilla de variables de entorno (mínimo 6 vars)
├── 📄 .gitignore / .gitattributes
├── 📄 README.md
├── 📂 certs/                    ← Certificados TLS compartidos (nginx + backend)
│   ├── server.crt               ← Certificado (generado por install.sh o Admin UI)
│   └── server.key               ← Clave privada RSA 4096-bit (nunca committear)
├── 📂 nginx/                    ← Configuración del gateway nginx
│   └── conf.d/frontend.conf     ← / → frontend:3001 · /api/* → backend:3000
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

| Documento | 🇪🇸 Español | 🇬🇧 English |
|-----------|------------|------------|
| Manual de Usuario | [USER_MANUAL.md](docs/USER_MANUAL.md) | [USER_MANUAL.en.md](docs/USER_MANUAL.en.md) |
| Manual del Administrador | [SYSADMIN_MANUAL.md](docs/SYSADMIN_MANUAL.md) | [SYSADMIN_MANUAL.en.md](docs/SYSADMIN_MANUAL.en.md) |
| Guía de Despliegue | [DEPLOY.md](DEPLOY.md) | [DEPLOY.en.md](DEPLOY.en.md) |
| Arquitectura Técnica | [ARCHITECTURE.md](docs/ARCHITECTURE.md) | [ARCHITECTURE.en.md](docs/ARCHITECTURE.en.md) |
| Auditoría de Seguridad | [SECURITY_AUDIT.md](SECURITY_AUDIT.md) | [SECURITY_AUDIT.md](SECURITY_AUDIT.md) *(en inglés)* |
| Plugin Engine — Referencia técnica | [PLUGIN_ENGINE.md](docs/PLUGIN_ENGINE.md) | *(bilingüe)* |
| Plugin Engine — Guía de desarrollo | [PLUGIN_DEVELOPMENT_GUIDE.md](docs/PLUGIN_DEVELOPMENT_GUIDE.md) | *(bilingüe)* |
| Plugin Engine — Checklist de seguridad | [PLUGIN_SECURITY_CHECKLIST.md](docs/PLUGIN_SECURITY_CHECKLIST.md) | *(bilingüe)* |

---

## 👨‍💻 Quickstart para Desarrollo

### Instalación en producción (un solo comando)

```bash
bash scripts/install.sh
```

El script interactivo se encarga de todo: detecta el SO, instala dependencias, solicita la URL pública, genera un certificado autofirmado o acepta uno existente, escribe el `.env` mínimo y arranca los contenedores.

Accede en `https://<tu-dominio>/` una vez que el script termine.

---

### Desarrollo local con Docker Compose

1. **Clonar el repositorio:**
   ```bash
   git clone https://github.com/pirexia/cmdb-enterprise-platform.git
   cd cmdb-enterprise-platform
   ```

2. **Configurar variables de entorno:**
   ```bash
   cp .env.example .env
   # Solo 6 variables obligatorias — el resto tiene valores por defecto
   ```

3. **Levantar los servicios:**
   ```bash
   docker compose up -d --build
   ```
   > El backend ejecuta automáticamente las migraciones y el seed inicial en el primer arranque.

4. **Accede a la plataforma:**
   - **Plataforma (via nginx):** `https://localhost` (acepta el aviso de certificado autofirmado)
   - **Adminer (DB UI):** `http://localhost:8080`

   **Credenciales por defecto:**
   - Admin: `admin@cmdb.local` / `Admin1234!`
   - Auditor: `auditor@cmdb.local` / `Audit1234!`
   
   ⚠️ **Cambiar contraseñas inmediatamente tras el primer login en producción.**

---

## 📜 Licencia

MIT — libre para uso personal y comercial.
