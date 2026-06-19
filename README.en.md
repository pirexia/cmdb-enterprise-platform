# 🏛️ Enterprise CMDB & GRC Platform

> 🇪🇸 [Versión en Español](README.md)

> **Configuration Management Database** — A comprehensive platform for managing IT assets (CIs), vendor contracts, vulnerability analysis and dependency visualisation, with JWT authentication, role-based access control (RBAC) and multilingual support.

[![Stack](https://img.shields.io/badge/stack-Node.js%20%7C%20Next.js%20%7C%20PostgreSQL-blue)](https://github.com/pirexia/cmdb-enterprise-platform)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![RHEL](https://img.shields.io/badge/tested%20on-RHEL%208%2F9-red)](https://www.redhat.com/en/technologies/linux-platforms/enterprise-linux)
[![Version](https://img.shields.io/badge/version-2.8.7-informational)](https://github.com/pirexia/cmdb-enterprise-platform/releases/tag/v2.8.7)

---

## 📋 Table of Contents

1. [Features](#-enterprise-features)
2. [Technology Stack](#️-technology-stack)
3. [Project Structure](#-project-structure)
4. [Official Documentation](#-official-documentation)
5. [Development Quickstart](#-development-quickstart)

---

## ✨ Enterprise Features

### Core Features

| Module | Description |
|--------|-------------|
| 🌍 **Multilingual Support (i18n)** | Full interface in Spanish and English with a persistent language selector and shared contexts. |
| 🔐 **Enterprise Security** | Hybrid LDAP/AD + Local authentication with fail-soft fallback, MFA (TOTP RFC 6238) **mandatory for admins** and suggested for users on first login, trusted devices with configurable TTL, three-level RBAC (Admin/Auditor/Viewer), JWT HS256, bcrypt cost-10, **configurable password policy** (length by role, complexity, dictionary, 20-entry history), ISO 27001 compliance. |
| 📡 **Lifecycle Intelligence** | Integration with the endoflife.date API for EOL/EOSL automation, hardware/software lookup centre, manual verification with external sources. |
| 📧 **Proactive Alerts** | Daily alert engine (cron) with personalised email reports on contract expiry, CIs approaching EoL/EoS, and critical/high vulnerabilities. |
| 🕸️ **Topology and Dependencies** | N:M relationships between CIs with 5 types (HOSTS, DEPENDS_ON, CONNECTED_TO, PROVIDES_SERVICE, BACKED_UP_BY), impact analysis, per-CI dependency map with a focused, interactive graph (React Flow). |
| 🐳 **Production-Ready Infrastructure** | Podman Rootless deployment on RHEL with persistence (loginctl enable-linger), multi-stage images, dedicated service user, Zero Trust compliance. |

### CMDB Core

| Module | Description |
|--------|-------------|
| 📊 **Dashboard** | Interactive executive summary of CIs, vulnerabilities, contracts and real-time security status. |
| 🖥️ **CI Inventory** | Full CRUD management of Configuration Items with a dynamic and extensible taxonomy grouped by category (Infrastructure, User Devices, Mobility/IoT, Meeting Rooms, Software, Licences), criticality, environment and hardware/software metadata. |
| 📜 **Contracts and Addenda** | M:N contract management linked to CIs, support for hierarchical addenda and automatic expiry monitoring. |
| 🛡️ **Vulnerability Management** | Centralised CVE view, lifecycle tracking (New → Assigned → In Progress → Resolved), integration with Greenbone OpenVAS and CrowdStrike Falcon. |
| 📋 **Reports Centre** | PDF/CSV report generation: obsolescence, upcoming contract expiry, executive security report. |
| 🗂️ **Master Data** | Full CRUD for auxiliary tables: **CI Types** (with configurable categories), Support Areas, Sites, Manufacturers, Device Models, Vendors. Vertical navigation in the sidebar. |
| 🕵️ **Audit Log** | Complete traceability of all administrative actions with automatic purging of old records (configurable retention). |
| 📁 **Document Repository** | Secure document management with version control, configurable types, document relationships, and bidirectional associations between CIs, documents, and contracts. Embedded viewer (PDF, image, plain text), immutable per-document notes, magic bytes validation, UUID storage, and authenticated download. Configurable storage via bind mount or NFS (`DOCUMENTS_STORAGE_PATH`). |
| 🔑 **Licence Repository** | Centralised software licence inventory with configurable catalogues of types (14 predefined) and metrics (25 predefined). Each licence records vendor, type, usage metric, cost, validity period and automatic status (Active / Expiring / Expired / Draft). M:N associations with CIs and documents. Licence user management (name, ID, email) independent of the system user directory. Hierarchy support (parent licence / sub-licence). |
| 🤖 **Local AI Assistant with RAG** | Conversational chat to search information across documents (contracts, procedures, etc.) and structured entities (CIs, contracts, licences, vulnerabilities) using a local language model (Ollama + pgvector). No data is transferred to external services. Every answer includes mandatory source citations. Five multi-select filters to narrow sources. Respects per-role visibility permissions. **Automatic OCR for scanned PDFs** (Tesseract 5, bundled in the Docker image). See `docs/RAG_HOST_PREPARATION.md` for server requirements and `docs/SYSADMIN_MANUAL.en.md §20` for OCR configuration. |

### Security & Operations

| Feature | Description |
|---------|-------------|
| 🔒 **SSL/TLS Management** | CSR generation via UI, upload of signed certificates, automatic TLS fallback to HTTP if certificates are missing. |
| 🔑 **LDAP/AD Hybrid Auth** | Domain pre-check (@cmdb.local bypasses LDAP), fail-soft fallback to local database on AD outages. |
| 📦 **Database Maintenance** | Automatic audit log purging (AUDIT_RETENTION_DAYS), weekly VACUUM ANALYZE + REINDEX script, PostgreSQL bloat monitoring. |
| 💾 **Capacity Planning** | Dedicated LVM documentation for /home (Podman rootless), sizing tables by CI volume (1K, 5K, 20K+). |
| 🏗️ **ISO 27001 Ready** | Dedicated service user, restrictive permissions (750/600), cgroupfs configuration for RHEL/Podman stability. |
| 🌐 **Dynamic Branding** | White-label: company name, logo and corporate colours configurable via environment variables. |
| 🧩 **Plugin Engine** (v2.8.0) | Extension engine for ADMIN: install/activate/uninstall third-party plugins with a `vm.Script` sandbox, admission gate (Ed25519 signature + SHA-256 checksum + 4-eyes approval in prod), 12 REST endpoints, core lifecycle hooks, isolated DDL migrations (restricted DB role + `plg_` prefix), iframe UI in 7 slots, marketplace and `/plugins/admin` panel. See [docs/PLUGIN_ENGINE.md](docs/PLUGIN_ENGINE.md). |

---

## 🛠️ Technology Stack

| Layer | Technology |
|-------|-----------|
| **Database** | PostgreSQL 16 |
| **ORM** | Prisma 5 |
| **Backend** | Node.js 22 · Express 5 · TypeScript 5 |
| **Auth** | JWT (jsonwebtoken) · bcrypt · speakeasy (MFA) · ldap-authentication |
| **Frontend** | Next.js 16 (App Router) · React 19 · Tailwind CSS 4 |
| **Visualisation** | React Flow 11 · Lucide React |
| **Containers** | Docker CE / Podman · Docker Compose v2 |
| **Security** | Helmet 8 · HTTPS/TLS (native Node.js) |
| **Automation** | node-cron · nodemailer |

---

## 📁 Project Structure

```
cmdb-enterprise-platform/
│
├── 📄 docker-compose.yml        ← Orchestration for DEVELOPMENT (with Adminer)
├── 📄 docker-compose.prod.yml   ← Orchestration for PRODUCTION (optimised, without Adminer)
├── 📄 .env.example              ← Environment variables template (only 6 required)
├── 📄 .gitignore / .gitattributes
├── 📄 README.md
├── 📂 certs/                    ← Shared TLS certificates (nginx + backend)
│   ├── server.crt               ← Certificate (generated by install.sh or Admin UI)
│   └── server.key               ← RSA 4096-bit private key (never commit)
├── 📂 nginx/                    ← nginx gateway configuration
│   └── conf.d/frontend.conf     ← / → frontend:3001 · /api/* → backend:3000
│
├── 📂 backend/                  ← API engine (Express + Prisma)
│   ├── Dockerfile               ← Multi-stage Node.js build
│   ├── entrypoint.sh            ← Runs migrations + starts the server
│   ├── src/
│   │   └── index.ts             ← Express server: routes, JWT auth, CORS, cron jobs
│   │   └── services/            ← Business logic: LDAP, EoL, emailService
│   ├── prisma/
│   │   ├── schema.prisma        ← Data models (CI, User, Contract, Vendor…)
│   │   ├── seed.ts              ← Initial data (users, CIs, contracts)
│   │   └── migrations/          ← SQL migration history
│   └── scripts/                 ← generate-certs.sh/ps1, resetVulnerabilities.ts
│
├── 📂 frontend/                 ← Web interface (Next.js)
│   ├── Dockerfile               ← Multi-stage Next.js standalone build
│   ├── next.config.ts           ← output: standalone (for Docker), security headers
│   ├── app/                     ← Pages (App Router): inventory, contracts, map, settings…
│   ├── components/              ← Reusable components: Sidebar, AppShell, AddCIModal…
│   ├── contexts/                ← AuthContext, LanguageContext
│   ├── lib/                     ← apiFetch, csvExport, printReport
│   ├── locales/                 ← es.json, en.json (i18n dictionaries)
│   └── public/                  ← Static assets
│
└── 📂 docs/                    ← Official platform documentation
    ├── ARCHITECTURE.md          ← Technical architecture and topology
    ├── SYSADMIN_MANUAL.md       ← Guide for system administrators
    └── USER_MANUAL.md           ← End-user manual
```

---

## 📚 Official Documentation

For a full understanding of the system, its deployment and usage, refer to the official documentation:

| Document | 🇬🇧 English | 🇪🇸 Español |
|----------|------------|------------|
| User Manual | [USER_MANUAL.en.md](docs/USER_MANUAL.en.md) | [USER_MANUAL.md](docs/USER_MANUAL.md) |
| System Administrator Manual | [SYSADMIN_MANUAL.en.md](docs/SYSADMIN_MANUAL.en.md) | [SYSADMIN_MANUAL.md](docs/SYSADMIN_MANUAL.md) |
| Production Deployment Guide | [DEPLOY.en.md](DEPLOY.en.md) | [DEPLOY.md](DEPLOY.md) |
| Technical Architecture | [ARCHITECTURE.en.md](docs/ARCHITECTURE.en.md) | [ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Security Audit | [SECURITY_AUDIT.md](SECURITY_AUDIT.md) | [SECURITY_AUDIT.md](SECURITY_AUDIT.md) *(English only)* |
| Plugin Engine — Technical reference | [PLUGIN_ENGINE.md](docs/PLUGIN_ENGINE.md) | *(bilingual)* |
| Plugin Engine — Development guide | [PLUGIN_DEVELOPMENT_GUIDE.md](docs/PLUGIN_DEVELOPMENT_GUIDE.md) | *(bilingual)* |
| Plugin Engine — Security checklist | [PLUGIN_SECURITY_CHECKLIST.md](docs/PLUGIN_SECURITY_CHECKLIST.md) | *(bilingual)* |

---

## 👨‍💻 Development Quickstart

### Production installation (single command)

```bash
bash scripts/install.sh
```

The interactive script handles everything: OS detection, dependency installation, public URL prompt, self-signed certificate generation (or use existing files), minimal `.env` generation, and container startup.

Access the platform at `https://<your-domain>/` once the script completes.

---

### Local development with Docker Compose

1. **Clone the repository:**
   ```bash
   git clone https://github.com/pirexia/cmdb-enterprise-platform.git
   cd cmdb-enterprise-platform
   ```

2. **Configure environment variables:**
   ```bash
   cp .env.example .env
   # Only 6 required variables — everything else has code-level defaults
   ```

3. **Start the services:**
   ```bash
   docker compose up -d --build
   ```
   > The backend automatically runs migrations and the initial seed on first startup.

4. **Access the platform:**
   - **Platform (via nginx):** `https://localhost` (accept the self-signed cert warning)
   - **Adminer (DB UI):** `http://localhost:8080`

   **Default credentials:**
   - Admin: `admin@cmdb.local` / `Admin1234!`
   - Auditor: `auditor@cmdb.local` / `Audit1234!`

   ⚠️ **Change passwords immediately after the first login in production.**

---

## 📜 Licence

MIT — free for personal and commercial use.
