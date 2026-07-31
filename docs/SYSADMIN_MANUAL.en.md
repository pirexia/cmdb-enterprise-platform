# 🔧 CMDB Enterprise Platform — System Administrator Manual

**Version:** 1.2.0
**Audience:** Systems and Infrastructure Team (RHEL) — includes `scripts/install.sh`, `scripts/update.sh`
**Date:** 2026-04-07

---

## Table of Contents

0. [Quick Start (3 commands)](#0-quick-start-3-commands)
1. [System Requirements](#1-system-requirements)
2. [Initial Deployment](#2-initial-deployment)
3. [.env File Configuration](#3-env-file-configuration)
   - [3b. LDAP / Active Directory Configuration](#3b-ldap--active-directory-configuration)
4. [SSL/HTTPS Certificate Management](#4-sslhttps-certificate-management)
5. [Docker Compose Operations](#5-docker-compose-operations)
6. [Database Backup and Restore](#6-database-backup-and-restore)
7. [Log Management and Monitoring](#7-log-management-and-monitoring)
8. [Application Updates](#8-application-updates)
9. [Troubleshooting](#9-troubleshooting)
10. [Advanced Podman Configuration (RHEL)](#10-advanced-podman-configuration-rhel)
11. [Database Maintenance](#11-database-maintenance)
12. [Security and Hardening](#12-security-and-hardening)
13. [Periodic Maintenance Tasks](#13-periodic-maintenance-tasks)
14. [OpenShift / Kubernetes Deployment](#14-openshift--kubernetes-deployment)
15. [Microsoft 365 SSO Configuration (Azure AD)](#15-microsoft-365-sso-configuration-azure-ad--entra-id)
16. [User Erasure (GDPR Art. 17)](#16-user-erasure-gdpr-art-17)
17. [LDAP_STRICT_MODE](#17-ldap_strict_mode)
18. [Privacy Notice and GDPR Art. 13/14 Obligations](#18-privacy-notice-and-gdpr-art-1314-obligations)
19. [RAG Subsystem — Operation and Maintenance](#19-rag-subsystem--operation-and-maintenance)
20. [Backups — RAG encryption considerations](#20-backups--rag-encryption-considerations)
21. [RAG — Performance and GPU-accelerated inference (optional)](#21-rag--performance-and-gpu-accelerated-inference-optional)

---

## 0. Quick Start (3 commands)

For most new installations, three commands are sufficient:

```bash
# 1. Clone the repository
git clone https://github.com/pirexia/cmdb-enterprise-platform.git /opt/cmdb && cd /opt/cmdb

# 2. Run the guided installer
#    (detects OS, verifies prerequisites, prompts for URL/passwords/TLS, starts the platform)
bash scripts/install.sh

# 3. Open the browser
# Platform (frontend + API via nginx): https://<your-server>/
# Default login: admin@cmdb.local / Admin1234! — CHANGE IMMEDIATELY
```

> **Architecture:** nginx on `:443` is the single entry point. It routes `/` → frontend and `/api/*` → backend. Only nginx exposes ports to the host (443 and 80). Frontend and backend are internal Docker containers.

> For detailed control over each step, or for environments with special requirements, see [Section 2](#2-initial-deployment).

---

## 1. System Requirements

### Minimum Hardware
| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU | 2 vCPU | 4 vCPU |
| RAM | 4 GB | 8 GB |
| Disk | 20 GB | 50 GB SSD |
| Network | 100 Mbps | 1 Gbps |

### Software
```bash
# Recommended OS
Red Hat Enterprise Linux 8.x or 9.x
CentOS Stream 9
Rocky Linux 9

# Required dependencies
Docker Engine >= 24.0
Docker Compose plugin >= 2.0
git >= 2.40
openssl >= 1.1.1 (for generating SSL certificates)
```

### Verify Prerequisites
```bash
docker --version
docker compose version
git --version
openssl version
```

### Platform stack versions

| Component  | Version | EOL          | License             |
|------------|---------|--------------|---------------------|
| Node.js    | 22 LTS  | Apr 2027     | MIT                 |
| PostgreSQL | 15/16   | Nov 2027/28  | PostgreSQL License  |
| nginx      | 1.30    | —            | BSD-2-Clause        |
| Next.js    | 16      | —            | MIT                 |
| Express    | 5       | —            | MIT                 |
| Prisma     | 5       | —            | Apache 2.0          |

### nginx configuration

The nginx TLS gateway is configured in:
- **Main configuration:** `nginx/nginx.conf`
- **Virtual hosts:** `nginx/conf.d/`
- **TLS certificates:** `./certs/` (mounted read-only to nginx, read-write to the backend)
- The `NGINX_VERSION` env var in docker-compose feeds the System Information panel in the UI.

---

## 2. Initial Deployment

> **Recommended: Automated installation**
> Run `sudo bash scripts/install.sh` — detects the OS, verifies prerequisites, launches the configuration wizard, and starts the platform automatically. The installer logs everything to `/opt/cmdb/logs/install_<timestamp>.log`.

The steps below document the **advanced manual deployment** for environments with specific requirements or where the interactive installer cannot be used.

### Step 1: Clone the repository
```bash
sudo mkdir -p /opt/cmdb
sudo chown $USER:$USER /opt/cmdb
cd /opt/cmdb
git clone https://github.com/pirexia/cmdb-enterprise-platform.git .
```

### Step 2: Configure environment variables
```bash
cp .env.example .env
nano .env               # Edit with real values (see section 3)
chmod 600 .env          # Restrict read access to the owner
```

### Step 3: Generate SSL certificates
```bash
bash backend/scripts/generate-certs.sh
# Output: certs/server.key and certs/server.crt (RSA 4096-bit, project root)
```

### Step 4: Prepare the TLS volume (production)
```bash
docker volume create cmdb-tls-certs
docker run --rm \
  -v cmdb-tls-certs:/dest \
  -v $(pwd)/certs:/src:ro \
  alpine sh -c "cp /src/server.key /src/server.crt /dest/ && chmod 600 /dest/server.key"
```

### Step 5: Start the services
```bash
# Initial build (may take 3-5 minutes)
docker compose -f docker-compose.prod.yml build --no-cache

# Start in the background
docker compose -f docker-compose.prod.yml up -d

# Check status
docker compose -f docker-compose.prod.yml ps
```

> **Automatic seed:** On the first startup, the backend entrypoint runs `prisma migrate deploy` and, if no users exist in the database, automatically launches the initial seed (default users, sample CIs and contracts). On subsequent restarts, the presence of existing users is detected and the seed is skipped. No manual data-loading step is required.

### Step 6: Verify health
```bash
curl -sk https://localhost/api/health
# Expected response: {"status":"ok","timestamp":"..."}
# Request goes through nginx (port 443) → backend (internal port 3000)
```

### Default credentials after seeding
| Email | Password | Role |
|-------|----------|------|
| `admin@cmdb.local` | `Admin1234!` | ADMIN |
| `auditor@cmdb.local` | `Audit1234!` | AUDITOR |

> ⚠️ Change these passwords immediately after the first login in production.

---

## 3. .env File Configuration

### Mandatory variables in production

```bash
# ── Database ───────────────────────────────────────────────────────────
POSTGRES_DB=cmdb_db
POSTGRES_USER=cmdb_admin              # Change from default!
POSTGRES_PASSWORD=<min-32-chars>      # Generate: openssl rand -base64 32

# ── Backend ────────────────────────────────────────────────────────────
BACKEND_PORT=3000
JWT_SECRET=<min-48-chars>             # Generate: openssl rand -base64 48

# ── Frontend ───────────────────────────────────────────────────────────
FRONTEND_PORT=3001
NEXT_PUBLIC_API_URL=https://cmdb.yourdomain.com:3000

# ── Branding ───────────────────────────────────────────────────────────
NEXT_PUBLIC_COMPANY_NAME=My Company

# ── Security ───────────────────────────────────────────────────────────
HTTPS_ENABLED=true
CORS_ORIGINS=https://cmdb.yourdomain.com:3001

# ── SMTP / Alerts ──────────────────────────────────────────────────────
SMTP_HOST=smtp.yourdomain.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=cmdb-alerts@yourdomain.com
SMTP_PASS=<smtp-password>
ALERT_RECIPIENT=it-ops@yourdomain.com
ALERT_WARN_DAYS=30
ALERT_CRON_SCHEDULE=30 8 * * *

# ── LDAP / Active Directory (Optional) ────────────────────────────────
USE_LDAP=false
# USE_LDAP=true
# LDAP_URL=ldap://ad.yourdomain.com:389
# LDAP_BIND_DN=CN=cmdb-svc,OU=Service Accounts,DC=yourdomain,DC=com
# LDAP_BIND_PASSWORD=<service-account-password>
# LDAP_SEARCH_BASE=DC=yourdomain,DC=com
# LDAP_TLS_REJECT_UNAUTHORIZED=0    # Only if using an internal self-signed cert
```

> **Note (v2.2.0+):** Visual theming (sidebar and accent colors, logo, company name) is configured from the admin panel at **Settings → Appearance**. The `NEXT_PUBLIC_COMPANY_NAME` variable is still the initial value used during first installation, but all subsequent changes are made from the UI without a rebuild.

### nginx ports (optional variables)

By default nginx listens on the standard ports 443 (HTTPS) and 80 (HTTP→redirect). If the server already has another application on those ports, override them in `.env`:

```bash
# ── nginx ports (host → container) ──────────────────────────────────
# The container-internal port does not change (always 443/80).
# Only the host-side port mapping is affected.
NGINX_HTTPS_PORT=8443   # e.g. access via https://cmdb.example.com:8443
NGINX_HTTP_PORT=8080    # e.g. HTTP redirect on port 8080

# When using non-standard ports, also update the public URL:
# NEXT_PUBLIC_API_URL=https://cmdb.example.com:8443
# FRONTEND_URL=https://cmdb.example.com:8443
```

> **Rootless Podman note:** If the chosen ports are < 1024, the RHEL 9 kernel requires `net.ipv4.ip_unprivileged_port_start` to be lowered. The installer detects this and guides the administrator. Using ports ≥ 1024 (e.g. 8443/8080) avoids this requirement entirely.

### Optional variables — Document Repository

The Document Repository stores **all file types** managed by the platform: contracts, addendums, licences, technical documents, quotes, and any custom type. All share the same storage directory on disk.

```bash
# ── Document Storage ───────────────────────────────────────────────────
# Host path where uploaded files are stored.
# Default: ./document-storage (relative to the compose file directory).
# Can point to a local absolute path or an NFS/CIFS mount.
DOCUMENTS_STORAGE_PATH=./document-storage
# DOCUMENTS_STORAGE_PATH=/data/cmdb/documents      # absolute local path
# DOCUMENTS_STORAGE_PATH=/mnt/nfs/cmdb-docs        # NFS mount point
```

> **Important:** The directory must exist on the host before starting the services and must be readable and writable by UID `1000` (the `node` user in Alpine images). The container does **not** create the parent directory automatically.

#### Bulk document import (staging + AI analysis)

Bulk import lets users upload several documents at once; a background worker (on the same RAG cron, every 30 s) analyses them with Ollama to suggest type, validity dates, vendor, number and associated CIs before the user confirms them. Uploaded files are kept **temporarily** in a staging subdirectory (`_staging/` inside the document storage) and are **only** materialized into real documents/contracts/licences when each line is confirmed.

```bash
# ── Bulk import ───────────────────────────────────────────────────────
# BULK_MAX_FILES=20         # max files per batch
# BULK_MAX_TOTAL_MB=200     # max total batch size (MB). Each file still obeys MAX_DOCUMENT_SIZE_MB.
# BULK_BATCH_TTL_HOURS=24   # age after which an abandoned batch is discarded automatically
# BULK_ANALYZE_BUDGET=2     # documents analysed by AI per cycle (30 s); low = won't starve the RAG queue on CPU
# BULK_STAGING_DIR=/app/documents/_staging   # staging area location (defaults to a subdir of DOCUMENTS_DIR)

# ── CI bulk import (XLSX) — concurrent analysis ───────────────────────
# CI_BULK_CONCURRENCY=3      # CI items analysed in parallel (1..5). Default 3.
                              # CI analysis is light (no OCR); 3 workers saturate
                              # Ollama without starving the rest. Raise to 5 only
                              # with >=8 cores.
```

> **Automatic cleanup:** an hourly cron discards batches older than `BULK_BATCH_TTL_HOURS` and deletes their staged files, preventing the staging area from growing unbounded (ISO 22301 / NIS2). Already-confirmed (materialized) documents are **not** affected.
>
> **Document performance:** AI analysis of documents is sequential and CPU-bound (one at a time to avoid saturating Ollama with simultaneous OCR + LLM). A large batch can take several minutes per document. With a GPU, latency drops dramatically (see §21 — RAG / GPU). `BULK_ANALYZE_BUDGET` controls how many documents compete for Ollama each cycle against normal RAG indexing.
>
> **CI performance:** the CI bulk import processes up to `CI_BULK_CONCURRENCY` rows in parallel (default 3). As soon as one analysis finishes, the next one starts immediately (not in batches), drastically reducing total processing time for large batches.
>
> **OCR for scanned files:** scanned PDFs (no digital text) are recognized automatically via OCR (Tesseract), same as single upload — the worker uses the same `parseDocument`. OCR rasterizes each page (`OCR_DPI`) and runs Tesseract (`OCR_LANGUAGES`), which **adds time** per document on CPU (e.g. ~3-4 min for a 20+ page scanned PDF). Requires `tesseract-ocr` + `poppler-utils` in the backend image (already included). Tune `OCR_ENABLED`/`OCR_DPI`/`OCR_LANGUAGES`/`OCR_TIMEOUT_MS` as needed.

#### Prepare the directory for a new installation

```bash
# Option A — local path
sudo mkdir -p /data/cmdb/documents
sudo chown 1000:1000 /data/cmdb/documents
sudo chmod 750 /data/cmdb/documents

# Add to .env
echo "DOCUMENTS_STORAGE_PATH=/data/cmdb/documents" >> .env
```

#### Configure an NFS mount

```bash
# 1. Create the mount point
sudo mkdir -p /mnt/nfs/cmdb-docs

# 2. Mount the share (add to /etc/fstab for persistence on reboot)
#    nfs-server.corp.local:/exports/cmdb-docs  /mnt/nfs/cmdb-docs  nfs  defaults,_netdev  0  0
sudo mount -t nfs nfs-server.corp.local:/exports/cmdb-docs /mnt/nfs/cmdb-docs

# 3. Assign permissions to the container UID
sudo chown 1000:1000 /mnt/nfs/cmdb-docs

# 4. Configure in .env
echo "DOCUMENTS_STORAGE_PATH=/mnt/nfs/cmdb-docs" >> .env

# 5. Restart the backend to pick up the new bind mount
docker compose -f docker-compose.prod.yml up -d backend
```

#### Migrate to a new volume (post-installation)

When moving storage to a different path (e.g. from local to NFS):

```bash
# 1. Stop the backend to prevent writes during the copy
docker compose -f docker-compose.prod.yml stop backend

# 2. Copy all files to the new destination, preserving permissions
sudo rsync -av --progress \
  "${DOCUMENTS_STORAGE_PATH:-./document-storage}/" \
  /new/path/

# 3. Verify file count matches
find "${DOCUMENTS_STORAGE_PATH:-./document-storage}" -type f | wc -l
find /new/path -type f | wc -l

# 4. Fix permissions on the destination
sudo chown -R 1000:1000 /new/path

# 5. Update .env
sed -i "s|^DOCUMENTS_STORAGE_PATH=.*|DOCUMENTS_STORAGE_PATH=/new/path|" .env

# 6. Start the backend with the new bind mount
docker compose -f docker-compose.prod.yml up -d backend

# 7. Verify a document loads correctly in the UI before removing the old path
# 8. Once confirmed, remove the old path (only if it was local):
#    sudo rm -rf /old/path
```

> The storage directory must be included in the backup strategy alongside the PostgreSQL volume. See section 6 for the backup procedure.

### Generating secure secrets
```bash
# JWT Secret (minimum 48 characters)
openssl rand -base64 48

# Database password (32 characters)
openssl rand -base64 32
```

---

## 3b. LDAP / Active Directory Configuration

> This section expands on the LDAP configuration in section 3. It is only required when `USE_LDAP=true`.

### Environment variables

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `USE_LDAP` | ✅ | Enables the LDAP connector | `true` |
| `LDAP_URL` | ✅ | URL of the LDAP or LDAPS server | `ldap://dc.corp.local:389` |
| `LDAP_SEARCH_BASE` | ✅ | Base DN where users are searched | `dc=corp,dc=local` |
| `LDAP_BIND_DN` | Recommended | DN of the service account | `cn=svc-cmdb,ou=ServiceAccounts,dc=corp,dc=local` |
| `LDAP_BIND_PASSWORD` | Recommended | Password of the service account | — |
| `LDAP_TLS_REJECT_UNAUTHORIZED` | Optional | Set to `0` only if the DC certificate is self-signed | `0` |
| `LDAP_UPN_SUFFIX` | Optional | AD domain UPN suffix (enables login as `user@suffix`) | `azkar.com` |
| `LDAP_NETBIOS_DOMAIN` | Optional | NetBIOS domain name (informational only, never blocks login) | `AZKARAD` |

### Supported login formats (since v3.5.6)

An AD user can authenticate with any of the following formats; the system always resolves the same database row, keyed internally by the `sAMAccountName` returned by the directory itself after the bind (never by what the user typed):

| Format | Example | LDAP attribute queried |
|--------|---------|--------------------------|
| sAMAccountName (AD username) | `andres.matias` | `sAMAccountName` |
| UPN | `andres.matias@azkar.com` | `userPrincipalName` (requires `LDAP_UPN_SUFFIX`) |
| NetBIOS | `AZKARAD\andres.matias` | `sAMAccountName` (the part after `\`) |
| Email (retrocompatible) | `andres.matias@dachser.com` | `mail` |
| Local CMDB account | `admin@cmdb.local` | — (local bcrypt, no AD lookup) |

If `LDAP_UPN_SUFFIX` is not configured, the `user@ad-domain` format is treated as an email (`mail`) instead of a UPN.

### Authentication strategies

The system automatically applies the most secure available strategy:

**Strategy 1 — Admin bind + search (recommended for corporate AD):**
Activated when `LDAP_BIND_DN` is configured. The service account performs the initial bind, then searches for the user by the LDAP attribute matching the typed format (`sAMAccountName`, `userPrincipalName`, or `mail` — see the table above), and finally re-binds as that user to verify the password.

```bash
# Example for Active Directory
USE_LDAP=true
LDAP_URL=ldap://dc01.corp.local:389
LDAP_BIND_DN=CN=svc-cmdb,OU=Service Accounts,DC=corp,DC=local
LDAP_BIND_PASSWORD=P@ssw0rd_Seguro
LDAP_SEARCH_BASE=OU=Empleados,DC=corp,DC=local
```

**Strategy 2 — Direct user bind (fallback):**
Used when `LDAP_BIND_DN` is empty. The system binds directly using the user's email as a UPN (`user@corp.local`), which is compatible with Active Directory. For OpenLDAP it constructs `uid=<user>,<LDAP_SEARCH_BASE>`.

```bash
# Minimal example (UPN direct bind only)
USE_LDAP=true
LDAP_URL=ldap://dc01.corp.local:389
LDAP_SEARCH_BASE=DC=corp,DC=local
```

### Configuration with LDAPS (TLS on port 636)

```bash
LDAP_URL=ldaps://dc01.corp.local:636
# If the DC certificate is signed by a private corporate CA:
LDAP_TLS_REJECT_UNAUTHORIZED=0
```

> ⚠️ `LDAP_TLS_REJECT_UNAUTHORIZED=0` disables verification of the LDAP server's certificate. Use it only in controlled environments with an internal CA. It is not required in production with a public CA.

### Fail-safe behaviour and timeout

- The LDAP connector has a **5-second timeout**. If the AD server does not respond within that time, authentication automatically falls back to the local path (bcrypt) with no impact on the user.
- Accounts with `@cmdb.local` and `@cmdb.internal` domains are **always** authenticated locally, bypassing the LDAP server entirely.
- If LDAP fails and the user does not exist in the local database, the login returns `Invalid credentials`.

### Automatic provisioning of LDAP users

On the first successful login of a corporate user:
1. A record is created in the `users` table with the `VIEWER` role.
2. The `sso_external_id` field stores the corporate email — this identifies the account as being of LDAP origin.
3. The record's password is an unusable random hash (local login with it is not possible).

To promote an LDAP user to `ADMIN`, go to **Settings → Users** in the web interface.

### Verifying the LDAP integration

```bash
# Test basic connectivity to the DC from the host
ldapsearch -x -H ldap://dc01.corp.local:389 \
  -D "CN=svc-cmdb,OU=Service Accounts,DC=corp,DC=local" \
  -w "P@ssw0rd_Seguro" \
  -b "DC=corp,DC=local" \
  "(mail=usuario@corp.local)"

# Verify from inside the backend container
docker exec cmdb-backend-prod node -e "
  process.env.LDAP_URL='ldap://dc01.corp.local:389';
  const {authenticateLDAP} = require('./dist/src/services/ldap');
  authenticateLDAP('usuario@corp.local','contraseña')
    .then(() => console.log('OK'))
    .catch(e => console.error('FAIL:', e.message));
"
```

---

## 4. SSL/HTTPS Certificate Management

### 4.1 Generate a self-signed certificate (intranet)
```bash
bash backend/scripts/generate-certs.sh
# Creates: backend/certs/server.key (private) and server.crt (public)
# Validity: 365 days
```

### 4.2 Request a certificate from a corporate CA

```bash
# Step 1: Generate a CSR (Certificate Signing Request)
openssl req -new -newkey rsa:2048 -nodes \
  -keyout backend/certs/server.key \
  -out    backend/certs/server.csr \
  -subj   "/C=ES/ST=Madrid/O=YourCompany/CN=cmdb.yourdomain.com"

# Step 2: Submit server.csr to your corporate CA
# Step 3: Save the signed certificate:
cp signed-certificate.crt backend/certs/server.crt

# Step 4: Verify that the key and certificate match (same MD5 hash)
openssl x509 -noout -modulus -in backend/certs/server.crt | md5sum
openssl rsa  -noout -modulus -in backend/certs/server.key | md5sum
```

### 4.3 Renewing certificates

```bash
# 1. Generate new certificates (do not delete the old ones until verified)
bash backend/scripts/generate-certs.sh

# 2. Update the Docker volume
docker run --rm \
  -v cmdb-tls-certs:/dest \
  -v $(pwd)/backend/certs:/src:ro \
  alpine sh -c "cp /src/server.key /src/server.crt /dest/ && chmod 600 /dest/server.key"

# 3. Restart the backend to load the new certificates
docker compose -f docker-compose.prod.yml restart backend

# 4. Verify
curl -k https://localhost:3000/health
openssl s_client -connect localhost:3000 -showcerts 2>/dev/null | openssl x509 -noout -dates
```

### 4.4 Check current certificate expiry
```bash
docker run --rm -v cmdb-tls-certs:/certs alpine \
  sh -c "openssl x509 -noout -dates -in /certs/server.crt"
# notBefore: start date
# notAfter:  expiry date  ← verify it is > today + 30 days
```

---

## 5. Docker Compose Operations

### Basic commands
```bash
# View the status of all containers
docker compose -f docker-compose.prod.yml ps

# Stream logs in real time (Ctrl+C to exit)
docker compose -f docker-compose.prod.yml logs -f

# View logs for a specific service
docker compose -f docker-compose.prod.yml logs -f backend
docker compose -f docker-compose.prod.yml logs -f postgres
docker compose -f docker-compose.prod.yml logs -f frontend

# Restart a service (without rebuild)
docker compose -f docker-compose.prod.yml restart backend

# Stop all services (data persists in volumes)
docker compose -f docker-compose.prod.yml down

# Stop and remove volumes (DESTRUCTIVE — deletes the database!)
docker compose -f docker-compose.prod.yml down -v

# Update with rebuild
docker compose -f docker-compose.prod.yml build --no-cache
docker compose -f docker-compose.prod.yml up -d
```

### Connect to a container
```bash
# Shell into the backend
docker exec -it cmdb-backend-prod sh

# PostgreSQL console
docker exec -it cmdb-postgres-prod psql -U cmdb_admin -d cmdb_db

# Run migrate deploy manually
docker exec cmdb-backend-prod npx prisma migrate deploy
```

### View resource usage
```bash
docker stats --no-stream
# CONTAINER           CPU %    MEM USAGE / LIMIT
# cmdb-backend-prod   0.12%    180MiB / 7.8GiB
# cmdb-postgres-prod  0.04%    140MiB / 7.8GiB
# cmdb-frontend-prod  0.01%    95MiB / 7.8GiB
```

---

## 6. Database Backup and Restore

### 6.1 Manual backup
```bash
# Environment variables (or read from .env)
export PG_CONTAINER=cmdb-postgres-prod
export POSTGRES_DB=cmdb_db
export POSTGRES_USER=cmdb_admin
export BACKUP_DIR=/opt/cmdb/backups

# Run backup
bash /opt/cmdb/scripts/db-backup.sh

# Verify the result
ls -lh /opt/cmdb/backups/
# → backup_20260315_020000.sql.gz (compressed with gzip -9)
```

### 6.2 Configure automatic backup (cron)
```bash
# Create the backups directory
sudo mkdir -p /opt/cmdb/backups
sudo chown $USER:$USER /opt/cmdb/backups

# Edit the system crontab
sudo crontab -e
```

Add the following line:
```cron
# CMDB Daily backup at 02:00 AM
0 2 * * * BACKUP_DIR=/opt/cmdb/backups PG_CONTAINER=cmdb-postgres-prod POSTGRES_DB=cmdb_db POSTGRES_USER=cmdb_admin /opt/cmdb/scripts/db-backup.sh >> /var/log/cmdb-backup.log 2>&1
```

```bash
# Verify that the cron is configured
sudo crontab -l | grep cmdb

# Create the log file
sudo touch /var/log/cmdb-backup.log
sudo chown $USER:$USER /var/log/cmdb-backup.log
```

### 6.3 Restore a backup
```bash
# List available backups
ls -lht /opt/cmdb/backups/

# CAUTION: Restoring will overwrite current data
# Restore the backup from 2026-03-15
gunzip -c /opt/cmdb/backups/backup_20260315_020000.sql.gz \
  | docker exec -i cmdb-postgres-prod psql -U cmdb_admin -d cmdb_db

# Verify that the restore was successful
docker exec cmdb-postgres-prod psql -U cmdb_admin -d cmdb_db \
  -c "SELECT COUNT(*) FROM configuration_items;"
```

### 6.4 Backup retention
The `db-backup.sh` script automatically deletes backups older than `RETENTION_DAYS` (30 days by default). To change the retention period:
```bash
# In the crontab or in a manual call:
RETENTION_DAYS=60 bash /opt/cmdb/scripts/db-backup.sh
```

---

## 7. Log Management and Monitoring

### Application logs
```bash
# Backend logs (includes errors, access, cron)
docker logs cmdb-backend-prod --tail 200 -f

# Frontend logs
docker logs cmdb-frontend-prod --tail 50 -f

# PostgreSQL logs
docker logs cmdb-postgres-prod --tail 100 -f

# Backup script logs
tail -f /var/log/cmdb-backup.log
```

### Health check endpoint
```bash
# Backend health
curl http://localhost:3000/health
# {"status":"ok","timestamp":"2026-03-15T08:30:00.000Z"}

# Security headers (verify Helmet)
curl -sI http://localhost:3000/health | grep -i "x-frame\|x-content\|x-xss"
```

### Logrotate for backup logs
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

### Key alerts and metrics to monitor
| Metric | Alert threshold | Action |
|--------|----------------|--------|
| Disk usage at /opt/cmdb/backups | > 80% of disk | Reduce RETENTION_DAYS |
| **Disk usage at DOCUMENTS_STORAGE_PATH** | **> 70% of filesystem** | **Expand volume / move to NFS** |
| API /health response time | > 2s | Review backend logs |
| Backend container memory | > 1.5 GB | Restart backend |
| Error rate in logs | > 10 errors/min | Review logs |
| SSL certificate expiry | < 30 days | Renew (section 4.3) |

#### Monitoring the document volume

```bash
# Current directory usage
du -sh "${DOCUMENTS_STORAGE_PATH:-./document-storage}"

# Filesystem usage for the mount
df -h "${DOCUMENTS_STORAGE_PATH:-./document-storage}"
```

**Full monitoring script** — save to `/opt/cmdb/scripts/check-docs-storage.sh`:

```bash
#!/bin/bash
# check-docs-storage.sh — Monitors the document repository volume
set -e

DOCS_PATH="${DOCUMENTS_STORAGE_PATH:-/opt/cmdb/document-storage}"
WARN_PCT=70
CRIT_PCT=85
RECIPIENT="${ALERT_RECIPIENT:-admin@yourdomain.com}"

USAGE=$(df --output=pcent "$DOCS_PATH" 2>/dev/null | tail -1 | tr -d ' %')

if [ -z "$USAGE" ]; then
  echo "ERROR: Cannot read disk usage for $DOCS_PATH" >&2
  exit 1
fi

FILE_COUNT=$(find "$DOCS_PATH" -type f 2>/dev/null | wc -l)
TOTAL_SIZE=$(du -sh "$DOCS_PATH" 2>/dev/null | cut -f1)

if [ "$USAGE" -ge "$CRIT_PCT" ]; then
  echo "[CMDB][CRITICAL] Document storage at ${USAGE}% (${TOTAL_SIZE}, ${FILE_COUNT} files) on $(hostname)" \
    | mail -s "[CMDB][CRITICAL] Document storage" "$RECIPIENT"
elif [ "$USAGE" -ge "$WARN_PCT" ]; then
  echo "[CMDB][WARNING] Document storage at ${USAGE}% (${TOTAL_SIZE}, ${FILE_COUNT} files) on $(hostname)" \
    | mail -s "[CMDB][WARNING] Document storage" "$RECIPIENT"
fi
```

```bash
# Make executable and add to crontab (daily check at 08:00)
chmod +x /opt/cmdb/scripts/check-docs-storage.sh
(crontab -l 2>/dev/null; echo "0 8 * * * /opt/cmdb/scripts/check-docs-storage.sh") | crontab -
```

> For NFS installations, also monitor share availability: `mountpoint -q /mnt/nfs/cmdb-docs || echo "NFS not mounted"`. Include this check in your monitoring system's health-check scripts (Zabbix, Nagios, Prometheus, etc.).

---

## 8. Application Updates

### 8.1 Automated update (recommended)

The `scripts/update.sh` script manages the complete update cycle with built-in safety guarantees.

```bash
cd /opt/cmdb
bash scripts/update.sh
```

#### Available flags

| Flag | Description | Use case |
|------|-------------|----------|
| `--dry-run` | Shows the changelog and detects migrations without touching anything | Review before updating in production |
| `--yes` | Unattended mode — auto-confirms all prompts | Nightly cron, CI/CD |
| `--no-cache` | Forces a full Docker rebuild without cache | After dependency changes (`package.json`) |
| `--force` | Skips the downgrade guard | Recovery use only — use with caution |

#### Usage examples

```bash
# Preview what would happen without executing anything
bash scripts/update.sh --dry-run

# Update without prompts (cron mode)
bash scripts/update.sh --yes

# Full rebuild after updating dependencies
bash scripts/update.sh --no-cache

# Force update ignoring the downgrade guard (recovery)
bash scripts/update.sh --force --yes
```

#### Cron for nightly unattended updates

```bash
# Automatic daily update at 03:00
0 3 * * * cd /opt/cmdb && bash scripts/update.sh --yes >> /var/log/cmdb-update.log 2>&1
```

#### Safety guarantees of the updater

The script implements five layers of protection before and during the update:

1. **Downgrade guard:** Compares the remote commit with the installed one. If the remote is older, the update is aborted. Use `--force` only in controlled recovery scenarios.

2. **Mandatory pre-update backup:** Runs `scripts/db-backup.sh` before any change. If the backup fails, the script aborts without touching code or containers.

3. **Tagged rollback point:** Creates a git tag `rollback/<timestamp>` pointing at the current HEAD before running `git pull`. This tag allows restoring the exact code of the previous version.

4. **Auto-rollback on failure:** If the Docker build fails or the health check does not respond within 120 seconds, the script automatically restores the rollback tag, rebuilds the previous image, and restarts the services.

> **v2.3.0 — RAG over structured entities (CIs, contracts, licenses, vulnerabilities):**
> - **Entity indexing:** The RAG subsystem no longer covers documents only. CIs, contracts (roots — addenda are serialised inside the root's text), licenses (same root/addenda pattern) and vulnerabilities (identified by a synthetic UUID v5 derived from `(ciId, cve)`) are indexed automatically. Activation is transparent when `RAG_ENABLED=true`.
> - **Source filter chips in chat:** Five chips (Documents, CIs, Contracts, Licenses, Vulnerabilities) let users narrow the assistant's sources. Session-scoped persistence in the browser. Empty selection = all sources.
> - **Deep-linkable citations:** Every citation now carries `entityType` + `entityId`. Clicking a citation opens the cited item in its listing (`/inventory?focus=<id>` opens the CI detail modal; `/contracts?focus=<id>` expands the row; same for licenses; `/vulnerabilities?cve=<CVE-ID>` pre-fills the filter).
> - **Priority worker:** The 30-second cron uses a 3-slot budget per tick with vulnerability > contract/license > CI priority. Preserves document upload latency and prioritises security signal.
> - **Multi-type backfill:** `POST /api/admin/rag/backfill` now accepts `{ "entityTypes": [...] }`. An empty body reindexes all types.
> - **Aggregated audit:** New `INDEX_BATCH` action (one event per worker tick, not per entity) and `ASK_RAG_VULN` (fine-grained traceability for queries that include vulnerabilities). `audit_logs.details` formalised as `jsonb` with an index on `(action, created_at DESC)`.
> - **Anti-injection mitigations:** `<ENTITY_DATA>` blocks in the prompt + reinforced REGLAS 5–7 + `stripInjectionTokens()` in the serializer. `scrubPII()` (email, ES-DNI/NIE, phone) runs over all free text before embedding. Strict allowlist in the vulnerability serializer (CVE-ID + severity + CVSS band + status + importedAt — no description, no source).
> - **Compliance:** DPIA v1.1 with 8 additional STRIDE entries (ENT-01..08) and a 10-item DPO+CISO sign-off checklist. Backup-encryption mandate for `rag_chunks` (NIS2 Art.21.2.h / ISO 22301).
> - **Operations:** `scripts/update.sh --reindex` now also queues CIs / contracts / licenses for re-indexing. New runbook `docs/RAG_V2_DEPLOY_RUNBOOK.md` with copy-paste smoke checklist, rollback matrix, sign-off worksheet and post-deploy monitoring.

> **v2.2.3 — Corporate Dark UI redesign, dynamic theming, and responsive navigation:**
> - **Database-driven theming:** New `app_settings` table stores sidebar color, accent color, company name, and logo. No rebuild required to change the appearance.
> - **Branding panel (Admin):** New "Appearance" tab in Settings with live color pickers, logo upload (PNG/JPEG/WebP, max 2 MB, magic bytes validated), and company name configuration.
> - **CSS Custom Properties:** `--sidebar-bg` and `--accent` injected into `<head>` at runtime via `ThemeContext`. Theme applies without page reload.
> - **Public theme endpoints:** `GET /api/settings/theme` and `GET /api/settings/logo` require no authentication (needed by the login page before auth context is available).
> - **Responsive navigation:** Mobile TopBar with hamburger button. Sidebar slides in as an overlay with backdrop at < 768px.
> - **Border-radius removal:** Sharp corners on cards, widgets, tables, inputs, and buttons throughout the application (Corporate Dark aesthetic).
> - **Color migration:** All hardcoded `indigo-*` colors replaced by `var(--accent)` — accent color changes globally when the branding setting is updated.
> - **Logo security:** MIME type + magic bytes validation in backend; SVG rejected (XSS risk); stored as base64 in DB, no file paths.
> - **Audit logging:** Every theme or logo change creates an `AuditLog` record (`UPDATE_THEME`, `UPDATE_LOGO`, `DELETE_LOGO`).

> **v2.0.1 — Stack upgrade, dynamic system info panel, sticky headers:**
> - **nginx 1.30 (stable):** Upgraded from nginx 1.27; EOL open.
> - **Dynamic system info panel:** New `GET /api/system-info` endpoint (admin only) with a 5-column table showing stack versions and EOL dates via endoflife.date with 24h cache.
> - **Sticky page headers:** All page header bars remain visible when scrolling (`sticky top-0 z-10`).
> - **Dependency upgrades:** Node.js 22-alpine, Prisma, Next.js 15, and all backend/frontend packages updated to latest stable.
> - **Race condition fix:** System info panel: fixed retry race condition on auto-refresh.

> **v1.7.1 — Security hardening + schema & i18n fixes:**
> - **Security:** JWKS `use` claim validation in Microsoft SSO; `FRONTEND_URL` validated and normalised to origin at startup; `COMPANY_NAME` allowlist check prevents DN injection in TLS cert generation; `.env` created with `umask 0077` (no world-readable window); HTML injection fixed in EOL email templates.
> - **Scripts:** `db-maintenance.sh` — Docker/Podman auto-detection, reliable exit-code capture via temp file, quoted DB name in `REINDEX`; `update.sh` — dry-run rollback no longer attempts `git checkout` on a tag that was never created.
> - **Schema:** Unique constraints added to `Vendor.name`, `CostCenter.name`, `Branch.name`; compound indexes on `(root_id, is_latest)` and `(root_id, version_number)` for document versioning queries.
> - **i18n:** All hardcoded strings in the profile page, SSO callback, and AppShell replaced with `t()` calls; 25 new keys added to all 6 locale files.
> - **Docker:** `NEXT_PUBLIC_COMPANY_NAME` wired as a build ARG so the company name set during installation is actually rendered by the frontend.
> - **Runtime branding:** Sidebar color (`sidebar_bg`), accent color (`accent_color`), company name (`company_name`), and logo (`logo_data`, `logo_mime`) are stored in the PostgreSQL `app_settings` table and served in real time through `GET /api/settings/theme` and `GET /api/settings/logo` (public endpoints, no authentication required).
> - **Docs:** `auditor@cmdb.local` seed user correctly documented as `AUDITOR` (not `VIEWER`); version numbers and changelog updated.

> **v1.7.0 — Microsoft 365 SSO + 6-language i18n** *(superseded by v1.7.1)*:
> - **Microsoft 365 SSO (Azure AD / Entra ID):** New OAuth2 + PKCE authentication flow. New environment variables: `USE_MICROSOFT_SSO`, `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_REDIRECT_URI`, `AZURE_ALLOWED_DOMAIN`, `AZURE_AUTO_PROVISION`, `FRONTEND_URL`. SSO users are stored with `sso_provider = 'microsoft'` and automatically receive a trusted device token (MFA not required for SSO sessions). New migration: `sso_provider` and `sso_external_id` columns on the `users` table.
> - **6-language i18n:** The frontend now ships with Spanish, English, German, Portuguese, French, and Italian. Users can switch language from their profile page. All UI strings are served from locale JSON files — no backend changes required.

> **v1.6.4 — Word-splitting fix in `update.sh`:** All references to the `COMPOSE_CMD` variable (which may hold `docker compose` — two words) were replaced with the `COMPOSE_CMD_ARRAY[@]` array and the `# shellcheck disable=SC2086` suppression comment was removed. This prevents unexpected behaviour when paths or values contain spaces.

5. **Migration confirmation:** Detects new Prisma migration files and displays the list before proceeding. In interactive mode it requests explicit confirmation.

#### Update log

Each run saves its full log to:
```
logs/update_<timestamp>.log
```

---

### 8.2 Manual rollback

If the automated updater could not complete the rollback, or if you need to return to a specific version:

```bash
cd /opt/cmdb

# List available rollback tags (created by update.sh)
git tag -l "rollback/*" | sort -r | head -10

# View commit history
git log --oneline -10

# Restore to the most recent rollback tag
git checkout rollback/<timestamp>

# Or restore to a specific commit
git checkout <previous-hash>

# Rebuild with the previous version
docker compose -f docker-compose.prod.yml build --no-cache
docker compose -f docker-compose.prod.yml up -d

# Verify that services are operational
docker compose -f docker-compose.prod.yml ps
curl http://localhost:3000/health
```

---

### 8.3 Restore the database after a rollback

If the update applied Prisma migrations that need to be reverted, restore the backup automatically created by `update.sh`:

```bash
# The backup path is printed in the update.sh log. You can also list it:
ls -lht /opt/cmdb/backups/ | head -5

# Restore (CAUTION: this overwrites current data)
gunzip -c /opt/cmdb/backups/backup_<timestamp>.sql.gz \
  | docker exec -i cmdb-postgres-prod psql -U cmdb_admin -d cmdb_db

# Verify that the restore was successful
docker exec cmdb-postgres-prod psql -U cmdb_admin -d cmdb_db \
  -c "SELECT COUNT(*) FROM configuration_items;"
```

> Prisma does not support automatic rollback of DDL migrations. If the migration was destructive (DROP COLUMN, DROP TABLE), the only way to recover the data is to restore the backup.

---

### Changing the Public Domain and URL

This procedure is required when the organisation decides to migrate the CMDB to a new domain (e.g. `cmdb.company.com` → `assets.company.com`) or to switch from HTTP to HTTPS.

> **⚠️ CRITICAL:** `NEXT_PUBLIC_*` variables in Next.js are **baked** (injected) into the frontend code at build time. Changing these values in `.env` without recompiling the frontend **has no effect**.

#### Step 1: Generate a certificate for the new domain (via the UI)

If the change involves a new domain with an SSL certificate:

```bash
# 1. Access the platform using the old URL
https://old-domain.com:3001

# 2. Navigate to the Administration panel → SSL/TLS Certificates

# 3. Generate a new CSR:
#    - Common Name (CN): new-domain.company.com
#    - Organization, Country, etc.

# 4. Download the generated CSR

# 5. Submit the CSR to your corporate CA for signing

# 6. When you receive the signed certificate (.crt/.pem), return to the panel

# 7. Upload the signed certificate using the upload form

# 8. Note the restart command (you will execute it in Step 4)
```

#### Step 2: Update DNS records

Modify your organisation's DNS records so that the new domain points to the IP address of the RHEL server:

```bash
# Example (depends on your DNS provider):
# Type: A
# Name: new-domain.company.com
# Value: 192.168.1.100 (IP of cmdb-server)

# Verify DNS propagation
dig new-domain.company.com +short
# Should show: 192.168.1.100

nslookup new-domain.company.com
```

#### Step 3: Modify environment variables

Log in to the server via SSH as `cmdb-admin`:

```bash
# Connect to the server
ssh cmdb-admin@cmdb-server

# Navigate to the installation directory
cd /opt/cmdb-enterprise-platform

# Edit the .env file
nano .env
```

Mandatorily update the following variables:

```bash
# ── Frontend ──────────────────────────────────────────────────────────
# URL of the backend as seen by the user's BROWSER
NEXT_PUBLIC_API_URL=https://new-domain.company.com:3000

# ── Security ──────────────────────────────────────────────────────────
# List of allowed CORS origins — comma-separated
CORS_ORIGINS=https://new-domain.company.com:3001,https://new-domain.company.com:3000
```

Save and exit (Ctrl+O, Enter, Ctrl+X).

#### Step 4: Rebuild the frontend container

> **MANDATORY:** Next.js injects `NEXT_PUBLIC_*` variables at **build time**, not at runtime. Without a rebuild, the frontend will continue using the old URL.

```bash
# As cmdb-admin, from /opt/cmdb-enterprise-platform

# 1. Rebuild only the frontend (includes the new .env variables)
docker compose -f docker-compose.prod.yml build frontend --no-cache

# 2. Restart the backend to load the new CORS_ORIGINS
docker compose -f docker-compose.prod.yml restart backend

# 3. Restart the frontend with the rebuilt image
docker compose -f docker-compose.prod.yml up -d frontend

# 4. Verify that the containers are running
docker compose -f docker-compose.prod.yml ps
```

#### Step 5: Post-migration verification

```bash
# 1. Verify that the backend responds from the new URL
curl -k https://new-domain.company.com:3000/health
# Expected response: {"status":"ok","timestamp":"..."}

# 2. Verify security headers
curl -sI https://new-domain.company.com:3000/health | grep -i "x-frame\|cors"

# 3. Verify the SSL certificate
openssl s_client -connect new-domain.company.com:3000 -showcerts 2>/dev/null | openssl x509 -noout -subject -dates
# Verify that the CN matches the new domain
```

#### Step 6: Browser access

1. **Clear the browser cache** (Ctrl+Shift+Delete or Cmd+Shift+Delete)
2. Navigate to the new URL: `https://new-domain.company.com:3001`
3. Log in normally
4. Verify that all functions operate correctly (inventory, integrations, etc.)

#### Domain migration checklist

- [ ] SSL certificate generated for the new domain and uploaded
- [ ] DNS records updated and propagated (verify with `dig`)
- [ ] `NEXT_PUBLIC_API_URL` and `CORS_ORIGINS` updated in `.env`
- [ ] Frontend rebuilt with `--no-cache`
- [ ] Backend restarted to load new CORS
- [ ] Containers verified (`docker compose ps`)
- [ ] Health check successful from the new URL
- [ ] SSL certificate verified (correct CN)
- [ ] Browser cache cleared
- [ ] Login and critical functions tested
- [ ] End users notified of the URL change

> **Estimated downtime:** 2-5 minutes (frontend rebuild time). Plan within a maintenance window or outside business hours.

---

## 9. Troubleshooting

### The backend container fails to start
```bash
# View startup logs
docker logs cmdb-backend-prod --tail 50

# Common causes:
# 1. JWT_SECRET not defined → Error: "JWT_SECRET is required"
#    Solution: Add JWT_SECRET to .env and restart

# 2. PostgreSQL connection error
#    Solution: Verify that postgres is healthy:
docker compose -f docker-compose.prod.yml ps
docker logs cmdb-postgres-prod --tail 20

# 3. Port 3000 already in use
ss -tlnp | grep :3000
# Solution: Kill the process or change BACKEND_PORT in .env
```

### The frontend shows "Network Error" or "Cannot connect"
```bash
# Verify that NEXT_PUBLIC_API_URL is reachable from the browser
# (Not from inside Docker, but from the user's PC)
curl http://cmdb-server:3000/health

# If using HTTPS, verify the certificate
curl -k https://cmdb-server:3000/health

# Verify CORS_ORIGINS includes the frontend URL
grep CORS_ORIGINS .env
```

### The database fails to start
```bash
docker logs cmdb-postgres-prod --tail 50

# If "Permission denied" appears on the volume (SELinux)
# The docker-compose.prod.yml already uses :Z for SELinux
# If it persists, check the context:
ls -laZ /var/lib/docker/volumes/cmdb-postgres-prod-data-prod/

# Alternative: temporarily disable SELinux for diagnostics (NOT in production)
# sudo setenforce 0
```

### Email alerts are not being sent
```bash
# Verify SMTP configuration
grep SMTP .env
grep ALERT .env

# Test sending manually via API
curl -X POST http://localhost:3000/api/admin/test-email \
  -H "Authorization: Bearer <admin-token>"

# View backend logs for SMTP errors
docker logs cmdb-backend-prod 2>&1 | grep -i "smtp\|email\|alert"
```

### Database migration fails on restart
```bash
# Run migrate deploy manually
docker exec cmdb-backend-prod npx prisma migrate deploy

# If there are migration conflicts
docker exec -it cmdb-postgres-prod psql -U cmdb_admin -d cmdb_db
# Inside psql:
SELECT * FROM "_prisma_migrations" ORDER BY finished_at DESC LIMIT 10;
\q
```

### "EADDRINUSE" error (port already in use)
```bash
# Find which process is using the port
ss -tlnp | grep :3000
lsof -i :3000

# Kill the process or change BACKEND_PORT in .env
```

---

## 10. Advanced Podman Configuration (RHEL)

This section documents Podman Rootless-specific configurations on RHEL environments that may be required to resolve stability issues.

### 10.1 Cgroup manager: cgroupfs vs systemd

By default, Podman on RHEL uses `systemd` as the cgroup manager. However, on specific RHEL/Podman version combinations (particularly RHEL 8.x with Podman 3.x-4.x), hanging issues can occur when trying to remove or restart containers that have active network dependencies.

**Common symptoms:**
- `podman rm` or `podman-compose down` commands hang indefinitely
- Containers stuck in "stopping" state that never terminate
- Errors related to `cni` or `netavark` when managing networks
- Timeouts when trying to remove containers with `podman-compose`

**Solution:** Force the use of `cgroupfs` as the cgroup manager.

### 10.2 Configure cgroupfs in Podman Rootless

```bash
# Create the Podman configuration directory if it does not exist
mkdir -p ~/.config/containers

# Create or edit the configuration file
nano ~/.config/containers/containers.conf
```

Add or modify the following lines in the file:

```ini
[engine]
# Force the use of cgroupfs instead of systemd
cgroup_manager = "cgroupfs"

# Optional: Adjust the number of events Podman can process
# Useful if you have many containers
events_logger = "file"

# Optional: Timeout for stopping containers (seconds)
stop_timeout = 30
```

Save the file and verify the configuration:

```bash
# Verify current configuration
podman info | grep -i cgroup
# Should show: cgroupManager: cgroupfs

# If the changes are not applied, restart the Podman service
podman system reset --force  # ⚠️ WARNING: This deletes all containers and images
# Alternative: log out and log back in
```

### 10.3 Recommended complete configuration

Full `~/.config/containers/containers.conf` file for production environments:

```ini
[containers]
# Default log driver (json-file, journald, k8s-file)
log_driver = "journald"

# Maximum log size per container (e.g. 10mb, 100mb)
log_size_max = "50mb"

[engine]
# Cgroup manager (cgroupfs recommended for RHEL 8.x with Podman < 4.5)
cgroup_manager = "cgroupfs"

# Network backend (cni or netavark)
# netavark is more modern but may have issues on RHEL 8.x
network_backend = "cni"

# Event logger
events_logger = "file"

# Timeout for stopping containers (seconds)
stop_timeout = 30

# Default runtime (crun is faster than runc)
runtime = "crun"

[network]
# Default subnet range for Podman networks
default_subnet = "10.89.0.0/16"
```

### 10.4 Verify and apply changes

```bash
# View active Podman configuration
podman info --format json | jq '.host.cgroupManager, .host.networkBackend'

# Restart Podman services without deleting data (Podman 4.3+)
systemctl --user restart podman.socket

# If changes are not applied, full reset (deletes containers)
podman system reset --force
# Then redeploy from docker-compose.prod.yml
```

### 10.5 Troubleshooting: Stuck containers

If after switching to `cgroupfs` you still have containers that cannot be removed:

```bash
# List containers in all states
podman ps -a

# Force removal of a specific container
podman rm -f <container-id>

# If the hang persists, kill the container process
podman inspect <container-id> | grep Pid
kill -9 <pid>

# Last resort: clean the entire Podman system
podman system prune -a --volumes --force
podman system reset --force
```

### 10.6 When to use cgroupfs vs systemd

| Manager | Advantages | Disadvantages | When to use |
|---------|-----------|---------------|-------------|
| **systemd** | systemd integration, better for system services | Can cause hangs on RHEL 8.x, requires cgroups v2 | RHEL 9+ with Podman 4.5+ |
| **cgroupfs** | Better compatibility, fewer network-related hangs | No systemd integration, less "clean" | RHEL 8.x, Podman < 4.5, stability issues |

**Recommendation for ISO 27001 production:**
- **RHEL 8.x with Podman 3.x-4.4:** Use `cgroupfs`
- **RHEL 9.x with Podman 4.5+:** Use `systemd` (default)
- **If you experience frequent hangs:** Switch to `cgroupfs` regardless of version

---

## 11. Database Maintenance

PostgreSQL uses MVCC (Multi-Version Concurrency Control), which generates "dead tuples" with every UPDATE/DELETE operation. Without regular maintenance, the database can suffer performance degradation and excessive disk consumption.

### 11.1 Automatic audit log purge (Backend)

The backend automatically runs a daily purge of old audit records to prevent unbounded growth of the `audit_logs` table.

**Configuration:**

```bash
# In .env or as an environment variable
AUDIT_RETENTION_DAYS=365    # Default: 365 days (1 year)
                            # Set to 0 to disable automatic purge
```

**Backend internal cron:**
- **Schedule:** 03:00 AM daily (timezone: Europe/Madrid)
- **Action:** Deletes records with `created_at` older than `AUDIT_RETENTION_DAYS`
- **Sample log entry:**
  ```
  [AuditPurgeCron] [INFO] Deleted 1523 audit log record(s) older than 365 days
  ```

**Verify purge status:**

```bash
# View backend logs
docker logs cmdb-backend-prod --tail 100 | grep AuditPurgeCron

# Check records in the audit_logs table
docker exec cmdb-postgres-prod psql -U cmdb_admin -d cmdb_db -c "
  SELECT COUNT(*) AS total,
         MIN(created_at) AS oldest,
         MAX(created_at) AS newest
  FROM audit_logs;
"
```

### 11.2 Database optimisation (Maintenance script)

The `scripts/db-maintenance.sh` script runs PostgreSQL optimisation routines:

- **VACUUM ANALYZE** (non-blocking): Reclaims space from dead tuples and updates planner statistics
- **REINDEX DATABASE** (blocking): Rebuilds indexes to eliminate bloat

**Manual execution:**

```bash
# As the cmdb-admin user
POSTGRES_DB=cmdb_db \
POSTGRES_USER=cmdb_admin \
PG_CONTAINER=cmdb-postgres-prod \
  bash /opt/cmdb-enterprise-platform/scripts/db-maintenance.sh
```

**Expected output:**

```
[2026-03-19 03:00:15] Starting PostgreSQL maintenance for database: cmdb_db
[2026-03-19 03:00:15] Running VACUUM ANALYZE (non-blocking)...
[2026-03-19 03:00:18] ✓ VACUUM ANALYZE completed successfully
[2026-03-19 03:00:18] Running REINDEX DATABASE (blocking — avoid during business hours)...
[2026-03-19 03:00:22] ✓ REINDEX DATABASE completed successfully
[2026-03-19 03:00:22] Maintenance completed successfully
```

### 11.3 Schedule automatic maintenance (Crontab)

**Recommendation:** Run the script weekly (Sundays at 03:00 AM) when there is no user activity.

```bash
# Edit the crontab for the cmdb-admin user
crontab -e
```

Add the following entry:

```cron
# CMDB Database Maintenance — Sundays at 03:00 AM
0 3 * * 0 POSTGRES_DB=cmdb_db POSTGRES_USER=cmdb_admin PG_CONTAINER=cmdb-postgres-prod /opt/cmdb-enterprise-platform/scripts/db-maintenance.sh >> /home/cmdb-admin/db-maintenance.log 2>&1
```

**Verify that the cron was registered correctly:**

```bash
crontab -l | grep db-maintenance

# View execution logs
tail -f /home/cmdb-admin/db-maintenance.log
```

### 11.4 VACUUM FULL (Maintenance windows only)

> **⚠️ WARNING: VACUUM FULL completely locks tables during execution.**

The `db-maintenance.sh` script does NOT include `VACUUM FULL` automatically because:
- It requires exclusive locks (READ and WRITE are blocked)
- It can take hours on large databases (> 20,000 CIs)
- It is only necessary if bloat exceeds 50% of the table size

**When to run VACUUM FULL:**

```bash
# Check table bloat (% of wasted space)
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

**Run VACUUM FULL manually (during a scheduled maintenance window):**

```bash
# 1. Announce downtime to users
# 2. Stop the frontend (prevents new connections)
docker compose -f docker-compose.prod.yml stop frontend

# 3. Run VACUUM FULL
docker exec cmdb-postgres-prod psql -U cmdb_admin -d cmdb_db -c "VACUUM FULL VERBOSE;"

# 4. Restart services
docker compose -f docker-compose.prod.yml start frontend
```

### 11.5 Performance monitoring

```bash
# Database size
docker exec cmdb-postgres-prod psql -U cmdb_admin -d cmdb_db -c "
  SELECT pg_size_pretty(pg_database_size('cmdb_db')) AS db_size;
"

# Largest tables
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

# VACUUM and ANALYZE activity
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

### 11.6 Maintenance checklist

| Task | Frequency | Automated | Command |
|------|-----------|-----------|---------|
| Audit log purge | Daily (03:00 AM) | ✅ Yes (backend cron) | Automatic via `AUDIT_RETENTION_DAYS` |
| VACUUM ANALYZE | Weekly (Sundays 03:00 AM) | ⚠️ Configure crontab | `bash scripts/db-maintenance.sh` |
| REINDEX DATABASE | Weekly (Sundays 03:00 AM) | ⚠️ Configure crontab | Included in `db-maintenance.sh` |
| VACUUM FULL | Annual (maintenance window) | ❌ Manual | `VACUUM FULL;` |
| Check bloat | Monthly | ❌ Manual | Query in section 11.4 |
| DB Backup | Daily (02:00 AM) | ✅ Yes (if configured) | See section 6 |

---

## 12. Security and Hardening

### Firewall (firewalld on RHEL)
```bash
# Open application ports
sudo firewall-cmd --permanent --add-port=3000/tcp   # API Backend
sudo firewall-cmd --permanent --add-port=3001/tcp   # Frontend
sudo firewall-cmd --reload

# Verify (5432 PostgreSQL should NOT appear)
sudo firewall-cmd --list-ports
# Correct:   3000/tcp 3001/tcp
# Incorrect: 5432/tcp (the database must not be externally accessible)
```

### JWT_SECRET rotation
```bash
# 1. Generate a new secret
NEW_SECRET=$(openssl rand -base64 48)
echo "New JWT_SECRET: $NEW_SECRET"

# 2. Update .env
nano .env  # Change JWT_SECRET=<new value>

# 3. Restart the backend (invalidates all existing tokens — users will need to log in again)
docker compose -f docker-compose.prod.yml restart backend

# IMPORTANT: Rotating JWT_SECRET terminates all active sessions
```

### Database password rotation
```bash
# 1. Connect to PostgreSQL
docker exec -it cmdb-postgres-prod psql -U cmdb_admin -d cmdb_db

# Inside psql:
ALTER USER cmdb_admin WITH PASSWORD 'new-secure-password';
\q

# 2. Update .env with the new password
nano .env   # POSTGRES_PASSWORD=new-password

# 3. Restart all services
docker compose -f docker-compose.prod.yml down
docker compose -f docker-compose.prod.yml up -d
```

### Dedicated service user (ISO 27001)

**Principle of Least Privilege:** Never run production services as root or under personal user accounts.

```bash
# Verify that containers run as an unprivileged user
podman ps --format "{{.ID}} {{.Names}}" | while read id name; do
  echo "Container: $name"
  podman inspect $id | jq -r '.HostConfig.UsernsMode'
done

# Verify that the user has linger enabled (persistence)
loginctl show-user cmdb-admin | grep Linger
# Should show: Linger=yes

# If not enabled, activate it
sudo loginctl enable-linger cmdb-admin
```

### File and directory permissions

```bash
# Verify permissions on the installation directory
ls -ld /opt/cmdb-enterprise-platform
# Correct: drwxr-x--- ... cmdb-admin cmdb-admin

# Verify permissions on the .env file (must be 600)
ls -l /opt/cmdb-enterprise-platform/.env
# Correct: -rw------- ... cmdb-admin cmdb-admin

# Verify permissions on the backups directory
ls -ld /opt/cmdb-enterprise-platform/backups
# Correct: drwxr-x--- ... cmdb-admin cmdb-admin

# Fix permissions if necessary
sudo chown -R cmdb-admin:cmdb-admin /opt/cmdb-enterprise-platform
sudo chmod 750 /opt/cmdb-enterprise-platform
chmod 600 /opt/cmdb-enterprise-platform/.env
```

---

## 13. Periodic Maintenance Tasks

> **v3.0.0:** Tasks marked as "n8n" are managed automatically by the corresponding workflow.
> Review executions in the n8n UI → Executions.

| Frequency | Task | Method | Command / Action |
|-----------|------|--------|-----------------|
| Daily 02:00 (automatic) | DB + docs backup | **n8n** "Backup CMDB" | Logs in n8n UI + audit_logs |
| Daily 08:30 (automatic) | EOL/EOS email alerts | **n8n** "Alertas CMDB" | Logs in n8n UI |
| Daily 03:00 (automatic) | Purge audit_logs > retention | **n8n** "Mantenimiento" | `POST /api/internal/maintenance/purge-audit-logs` |
| Daily 02:00 (automatic) | Cleanup trusted devices | **n8n** "Mantenimiento" | `POST /api/internal/maintenance/cleanup-trusted-devices` |
| Hourly (automatic) | Bulk staging cleanup | **n8n** "Mantenimiento" | `POST /api/internal/maintenance/cleanup-bulk-staging` |
| Every 30 s (automatic) | RAG indexing queue | **n8n** "RAG Indexing" | `POST /api/internal/rag/process-batch` |
| Weekly | Review failed n8n runs | Manual | n8n UI → Executions → filter Error |
| Weekly | Verify local backups exist | Manual | `ls -lh /var/backups/cmdb/` |
| Monthly | `npm audit` on backend/frontend | Manual | `podman exec cmdb-backend-prod npm audit` |
| Monthly | Verify SSL expiry | Manual | `openssl x509 -noout -dates -in certs/server.crt` |
| Monthly | Container image cleanup | Manual | `podman image prune -f` |
| Quarterly | JWT_SECRET rotation | Manual | See section 10 |
| Quarterly | CMDB_SERVICE_TOKEN rotation | Manual | See docs/n8n/ADMIN_GUIDE.md |
| Annual | SSL certificate renewal | Manual | See section 4.3 |
| Annual | Review active users | Manual | Settings → Users |

### Quick health check (n8n / Redis)

```bash
REDIS_PASS=$(grep REDIS_PASSWORD .env | cut -d= -f2)
podman exec cmdb-redis redis-cli -a "$REDIS_PASS" ping          # → PONG

TOKEN=$(grep CMDB_SERVICE_TOKEN .env | cut -d= -f2)
curl -s -H "X-CMDB-Service-Token: $TOKEN" \
  http://localhost:3000/api/internal/ping                        # → {"pong":true}
```

> **v3.3.0 — Additional n8n-provisioning environment variables:**
>
> | Variable | Default | Description |
> |----------|---------|-------------|
> | `N8N_INTERNAL_URL` | `http://n8n-main:5678` | Internal URL used by the backend to reach n8n. Change only if the n8n container has a different name |
> | `LDAP_ALLOW_UNAUTHORIZED_CERTS` | `false` | Set `true` ONLY in dev environments with ldaps:// and a self-signed certificate. Controls TLS certificate verification in the n8n LDAP workflow credential |
>
> If n8n workflows fail after an update, consult **`docs/n8n/TROUBLESHOOTING.md`** — it documents the three most common issues (INC-001: provisioning skipped, INC-002: 502 nginx, INC-003: execution accumulation).

---

## 14. OpenShift / Kubernetes Deployment

> This section covers enterprise environments where a container platform (OpenShift, OKD, Kubernetes) already exists. The installer automatically detects whether the `oc` CLI is authenticated and adjusts its behaviour accordingly.

### 14.1 Automatic detection

The `install.sh` script detects OpenShift if the command `oc whoami` succeeds before the configuration wizard starts. In that case, the installer does not run `docker-compose` and instead generates a correctly configured `.env` file and displays instructions for manual deployment to the cluster.

### 14.2 Convert docker-compose to OpenShift manifests

```bash
# Install kompose (docker-compose → Kubernetes/OpenShift converter)
curl -L https://github.com/kubernetes/kompose/releases/latest/download/kompose-linux-amd64 \
  -o /usr/local/bin/kompose
chmod +x /usr/local/bin/kompose

# Convert the production compose file to OpenShift manifests
kompose convert -f docker-compose.prod.yml -o openshift/
```

The generated manifests will be placed in the `openshift/` directory and will require the adjustments described in the next section.

### 14.3 OpenShift-specific adjustments

- **SecurityContextConstraints:** Platform containers run as a non-root user (`node`, UID 1000). This is compatible with the OpenShift `restricted` SCC without requiring additional privileges.
- **Routes:** Create a Route for the frontend (port 3001) and another for the backend (port 3000). OpenShift handles TLS termination at the router level.
- **ConfigMaps and Secrets:** Variables from the `.env` file must be migrated to OpenShift Secrets. Never store credentials in ConfigMaps.
- **PersistentVolumeClaims:** Replace Docker volumes (`cmdb-postgres-prod-data-prod`, `cmdb-tls-certs`, `document-storage`) with PVCs using the appropriate storage class for the cluster.

### 14.4 OpenShift Secret example

```bash
# Create a Secret from all variables in the .env file
oc create secret generic cmdb-env \
  --from-env-file=.env \
  --namespace cmdb-prod

# Verify the Secret was created correctly
oc get secret cmdb-env -n cmdb-prod -o yaml
```

> The Secret must be referenced in Deployments via `envFrom.secretRef` or `env[].valueFrom.secretKeyRef`. Never inject the `.env` file directly as a volume.

### 14.5 Updating in OpenShift

The `update.sh` script is not directly compatible with OpenShift (it requires `docker-compose`). To update in an OpenShift environment:

```bash
# 1. Pull the new code
git pull origin main

# 2. Rebuild the image (using an internal corporate registry)
podman build -t registry.corp.local/cmdb/backend:$(git rev-parse --short HEAD) ./backend
podman push registry.corp.local/cmdb/backend:$(git rev-parse --short HEAD)

podman build -t registry.corp.local/cmdb/frontend:$(git rev-parse --short HEAD) ./frontend
podman push registry.corp.local/cmdb/frontend:$(git rev-parse --short HEAD)

# 3. Update the image in the Deployment and trigger a rollout
oc set image deployment/cmdb-backend-prod \
  backend=registry.corp.local/cmdb/backend:$(git rev-parse --short HEAD) \
  -n cmdb-prod

oc rollout restart deployment/cmdb-frontend-prod -n cmdb-prod

# 4. Check rollout status
oc rollout status deployment/cmdb-backend-prod -n cmdb-prod
oc rollout status deployment/cmdb-frontend-prod -n cmdb-prod
```

> Prisma migrations in OpenShift must be run manually or as a Kubernetes Job before the rollout: `oc run prisma-migrate --image=... --restart=Never -- npx prisma migrate deploy`

---

## 15. Microsoft 365 SSO Configuration (Azure AD / Entra ID)

Single Sign-On (SSO) with Microsoft 365 lets users authenticate to the platform using their corporate Azure Active Directory (Entra ID) credentials via OAuth 2.0 Authorization Code + PKCE. This eliminates additional password management and delegates authentication — including corporate MFA and Conditional Access policies — to Microsoft. For users, the process is a single click on the login screen.

> This feature is optional. Local (bcrypt) authentication and LDAP integration continue to work regardless of whether SSO is enabled.

---

### Step 1: Register the Application in Azure AD

1. Go to [portal.azure.com](https://portal.azure.com) using a tenant administrator account.
2. Navigate to **Azure Active Directory → App registrations → + New registration**.
3. Fill in the form:
   - **Name:** `CMDB Enterprise Platform` (or any name your organization prefers)
   - **Supported account types:** select **"Accounts in this organizational directory only (Single tenant)"** — this is critical to prevent external accounts.
   - **Redirect URI:** select platform **Web** and enter:
     ```
     https://YOUR_DOMAIN/api/auth/sso/microsoft/callback
     ```
     Replace `YOUR_DOMAIN` with your actual installation domain (e.g., `app.company.com`).
4. Click **Register**.
5. On the app registration overview page, note:
   - **Application (client) ID** → value for `AZURE_CLIENT_ID`
   - **Directory (tenant) ID** → value for `AZURE_TENANT_ID`

---

### Step 2: Create a Client Secret

1. Inside the app registration, go to **Certificates & secrets → Client secrets → + New client secret**.
2. Fill in the fields:
   - **Description:** `CMDB SSO`
   - **Expires:** `24 months` (recommended; note the expiry date for renewal planning)
3. Click **Add**.
4. **Copy the secret value immediately** — Azure only shows it once. This value is `AZURE_CLIENT_SECRET`.

> The secret value looks like `~xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`. If you navigate away before copying it, you must create a new one.

---

### Step 3: API Permissions

The required permissions are standard delegated Microsoft Graph permissions. Admin consent is not required for any of them.

1. Go to **API permissions → + Add a permission → Microsoft Graph → Delegated permissions**.
2. Select the following permissions:

   | Permission | Purpose |
   |------------|---------|
   | `openid` | Issue an id_token on authentication completion |
   | `profile` | Access the user's first and last name |
   | `email` | Access the user's primary email address |
   | `User.Read` | Read the authenticated user's basic profile |

3. Click **Add permissions**.
4. No need to click "Grant admin consent" for these four permissions.

---

### Step 4: Configure Environment Variables

Edit the `backend/.env` file and add (or uncomment) the following variables:

```env
# ── Microsoft 365 SSO / Azure AD (Optional) ───────────────────────────
USE_MICROSOFT_SSO=true
# true enables the "Sign in with Microsoft" button on the login screen.
# false (default) disables the SSO flow entirely.

AZURE_TENANT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
# Directory (tenant) ID copied from Step 1.

AZURE_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
# Application (client) ID copied from Step 1.

AZURE_CLIENT_SECRET=your-client-secret-value
# Client secret value created in Step 2.

AZURE_REDIRECT_URI=https://app.company.com/api/auth/sso/microsoft/callback
# Must match exactly the URI registered in Azure AD (Step 1).
# Include the https:// scheme and no trailing slash.

AZURE_ALLOWED_DOMAIN=company.com
# Only users whose email belongs to this domain can use SSO.
# If the token email does not end in @company.com, authentication is rejected
# even if the user successfully signed into Microsoft.
# Leave empty to skip domain restriction (not recommended in production).

FRONTEND_URL=https://app.company.com
# Root URL of the frontend. Used to build the final redirect URL after the
# OAuth flow completes. Must include the scheme and no trailing slash.

AZURE_AUTO_PROVISION=true
# true (recommended): if the Microsoft user does not exist in the local DB,
#   they are automatically created with VIEWER role and active status.
# false: the user must already exist in the platform (created manually or
#   via LDAP sync). If not found, login is rejected even with valid Microsoft auth.
```

---

### Step 5: Apply the Database Migration

SSO requires the `users` table to have the `sso_provider` and `sso_external_id` columns. Apply the corresponding migration inside the backend container:

```bash
podman exec cmdb-backend-prod npx prisma migrate deploy
```

Verify the migration applied correctly:

```bash
podman exec cmdb-postgres-prod psql -U cmdb_db_user -d cmdb_db -c '\d users' | grep sso
```

You should see the `sso_provider` and `sso_external_id` columns in the output.

---

### Step 6: Restart the Backend

After updating `.env`, rebuild and restart the backend container for the changes to take effect:

```bash
podman-compose -f docker-compose.prod.yml up -d --build backend
```

Check that the backend starts without errors:

```bash
podman logs cmdb-backend-prod --tail 30
```

---

### Expected Behavior

Once configured correctly:

- **Login screen:** the "Sign in with Microsoft" button appears below the standard credentials form.
- **Authentication flow:**
  1. User clicks the button → backend redirects to Microsoft's authentication page.
  2. Microsoft authenticates the user (with corporate policies: MFA, Conditional Access, etc.).
  3. Microsoft redirects to the callback endpoint with an authorization code.
  4. Backend validates the `id_token`, verifies the email belongs to the allowed domain, and creates or retrieves the user in the database.
  5. The device is automatically registered as a **trusted device** — no TOTP from the platform is ever requested.
  6. The frontend receives the JWT and the user accesses the application directly.
- **Provisioning:** if `AZURE_AUTO_PROVISION=true` and the user does not exist, they are created with `VIEWER` role. An administrator can change the role from **Settings → Users**.
- **LDAP account linking:** users already in the platform (via local login or LDAP sync) with the same email as their Microsoft account are automatically linked on their first SSO login.

---

### Coexistence with LDAP

Microsoft SSO and LDAP authentication are completely independent auth paths and can coexist:

| Configuration | Effect |
|---------------|--------|
| `USE_LDAP=false` · `USE_MICROSOFT_SSO=false` | Local (bcrypt) authentication only |
| `USE_LDAP=true` · `USE_MICROSOFT_SSO=false` | Local + LDAP authentication |
| `USE_LDAP=false` · `USE_MICROSOFT_SSO=true` | Local + Microsoft SSO |
| `USE_LDAP=true` · `USE_MICROSOFT_SSO=true` | Local + LDAP + Microsoft SSO |

When both are active, the traditional form continues using LDAP and the Microsoft button uses the OAuth flow. A user can use either path as long as their email matches the account registered in the platform.

Accounts with the domain `@cmdb.local` or `@cmdb.internal` always authenticate locally, regardless of LDAP or SSO configuration.

---

### Client Secret Renewal

Azure AD client secrets have an expiry date. If the secret expires, the SSO flow stops working and users will see an error when attempting Microsoft authentication (local/LDAP authentication is unaffected).

**Renewal procedure:**

1. Go to the Azure portal → app registration → **Certificates & secrets**.
2. Create a **new** secret before the current one expires (keep both active in parallel during the transition).
3. Copy the new secret value.
4. Update `AZURE_CLIENT_SECRET` in `backend/.env`.
5. Restart the backend:
   ```bash
   podman-compose -f docker-compose.prod.yml up -d --build backend
   ```
6. Verify SSO still works by performing a test login.
7. Once confirmed, delete the old secret in the Azure portal.

> It is recommended to add a calendar reminder for the systems team 30 days before the secret expiry date.

---

### SSO Status Check (Public Endpoint)

The `GET /api/auth/sso/status` endpoint returns the SSO configuration status without requiring authentication. Useful for diagnostics from a browser or with `curl`:

```bash
curl -sk https://app.company.com/api/auth/sso/status | python3 -m json.tool
```

Expected response when SSO is active:

```json
{
  "enabled": true,
  "domain": "company.com"
}
```

If `enabled` is `false`, verify that `USE_MICROSOFT_SSO=true` is in `.env` and that the backend was restarted after the change.

---

## 16. User Erasure (GDPR Art. 17)

To erase a user and fulfill a GDPR right-to-erasure request:

```http
DELETE /api/admin/users/:id
Authorization: Bearer <admin-token>
```

**Behavior:**
1. Audit log entries matching the user's email are pseudonymised to `[deleted-{hash16}]`. The hash is SHA-256(email + JWT_SECRET) truncated — stable and irreversible.
2. The user record is permanently deleted (trusted_devices and password_history cascade automatically).
3. A `GDPR_ERASURE` entry is inserted into audit_logs under the admin's email.

**Restrictions:** An admin cannot erase their own account. SSO admin accounts must also be revoked in Azure AD / LDAP.

**GDPR Art.17 / ISO 27001 A.8.15 conflict resolution:** Pseudonymisation preserves audit trail chronological integrity (ISO 27001 requirement) while removing the direct personal identifier (GDPR requirement). This approach is defensible under Art.17(3)(b) (legal obligation compliance).

The `audit_logs` table has Row-Level Security (RLS) with `FORCE` enabled — row deletion is blocked at the database level for all roles including the table owner.

---

## 17. LDAP_STRICT_MODE

By default, if the LDAP server is unavailable, the system falls back to local authentication. LDAP shadow users have a random bcrypt hash (not usable for real login), so the fallback is safe by design.

For high-security deployments requiring explicit policy enforcement:

```env
LDAP_STRICT_MODE=true
```

With this setting, if the LDAP server does not respond, LDAP users receive `Invalid credentials` instead of attempting local auth. **Does not affect local accounts** (emails ending in `@cmdb.local` or `@cmdb.internal`).

**Impact:** If the LDAP server goes down, no LDAP users can authenticate until it recovers. Always maintain at least one active local ADMIN account.

---

## 18. Privacy Notice and GDPR Art. 13/14 Obligations

The platform includes a privacy notice page at `/privacy`. Fields marked `[REPLACE: ...]` must be completed by the organisation before production deployment:

- **Name and contact details of the data controller** (Art. 13(1)(a) GDPR)
- **Data Protection Officer contact details** (Art. 13(1)(b) GDPR)
- **Contact email for data subject rights requests**

**Auto-provisioned users (SSO/LDAP):** The platform automatically creates accounts for Microsoft Azure AD and LDAP users without direct interaction. This triggers the Art. 14 GDPR obligation (indirect collection notice). The organisation must inform these users via internal communication (HR, corporate email) as the application does not send welcome emails.

---

## 19. RAG Subsystem — Operation and Maintenance

### 19.1 RAG subsystem environment variables

All new variables added to `.env`:

| Variable | Default | Description |
|---|---|---|
| `RAG_ENABLED` | `true` | Enables or disables the entire RAG subsystem |
| `OLLAMA_BASE_URL` | `http://ollama:11434` | Internal URL of the Ollama service (do not expose externally) |
| `RAG_EMBED_MODEL` | `bge-m3` | Embeddings model (multilingual, 1024 dimensions) |
| `RAG_CHAT_MODEL` | `qwen2.5:7b-instruct-q4_K_M` | LLM used for answer generation |
| `RAG_CHAT_TEMPERATURE` | `0.1` | LLM temperature (lower = more deterministic and faithful to the document) |
| `RAG_TOP_K` | `6` | Number of document chunks retrieved per query |
| `RAG_RATE_LIMIT_PER_MIN` | `10` | Chat requests per user per minute |
| `OLLAMA_MODELS_PATH` | `/opt/cmdb-data/ollama-models` | Path where downloaded models are stored |

### 19.2 Initial model download

```bash
# Verify the ollama service is running
podman ps | grep ollama

# Download models (first time; approximately 7 GB total)
podman exec cmdb-ollama-prod ollama pull bge-m3
podman exec cmdb-ollama-prod ollama pull qwen2.5:7b-instruct-q4_K_M

# List available models
podman exec cmdb-ollama-prod ollama list
```

Note: models are stored in the `ollama-models` volume (bind-mounted at `/opt/cmdb-data/ollama-models`). They persist across container restarts.

### 19.3 Service verification

```bash
# Ollama container status
podman ps --filter name=cmdb-ollama-prod

# Real-time resource usage
podman stats cmdb-ollama-prod --no-stream

# Service logs
podman logs --tail 50 cmdb-ollama-prod

# Model currently loaded in memory
podman exec cmdb-ollama-prod ollama ps

# Connectivity test backend → Ollama
podman exec cmdb-backend-prod curl -s http://ollama:11434/api/version
```

### 19.4 Document corpus indexing

#### First-time indexing (backfill)
After the first deployment, index all existing documents:

```bash
# Obtain an ADMIN token
TOKEN=$(curl -sk -X POST https://localhost/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@cmdb.local","password":"<ADMIN_PASSWORD>"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

# Start backfill (asynchronous process; may take several minutes depending on corpus size)
curl -sk -X POST -H "Authorization: Bearer $TOKEN" \
  https://localhost/api/admin/rag/backfill

# Monitor progress in the database
podman exec cmdb-postgres-prod psql -U admin -d cmdb_db \
  -c "SELECT status, COUNT(*) FROM rag_document_index GROUP BY status;"
```

#### Re-index a specific document
```bash
curl -sk -X POST -H "Authorization: Bearer $TOKEN" \
  https://localhost/api/documents/<DOCUMENT_ID>/reindex
```

#### Index status
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

### 19.5 Backup and restore

#### Backup (include RAG tables in the standard dump)
```bash
# Full backup including pgvector and RAG tables
podman exec cmdb-postgres-prod pg_dump -U admin cmdb_db \
  > /opt/cmdb-data/backups/backup_$(date +%F_%H%M).sql

# RAG-only backup (lightweight, useful for model migrations)
podman exec cmdb-postgres-prod pg_dump -U admin cmdb_db \
  --table=rag_document_index \
  --table=rag_chunks \
  --table=rag_chat_sessions \
  --table=rag_chat_messages \
  > /opt/cmdb-data/backups/rag_only_$(date +%F_%H%M).sql
```

#### Restoring RAG tables
```bash
podman exec -i cmdb-postgres-prod psql -U admin -d cmdb_db \
  < /opt/cmdb-data/backups/rag_only_<DATE>.sql
```

#### Ollama model backup
Models are stored at `/opt/cmdb-data/ollama-models`. They can be archived as follows:
```bash
tar -czf /opt/cmdb-data/backups/ollama_models_$(date +%F).tar.gz \
  -C /opt/cmdb-data ollama-models
```
Alternatively, re-download them with `ollama pull` (simpler when internet access is available).

### 19.6 Model updates

To change the LLM (for example, to a newer version):
```bash
# 1. Download the new model
podman exec cmdb-ollama-prod ollama pull qwen2.5:14b-instruct-q4_K_M

# 2. Update .env
sed -i 's/RAG_CHAT_MODEL=.*/RAG_CHAT_MODEL=qwen2.5:14b-instruct-q4_K_M/' .env

# 3. Restart the backend (reloads environment variables)
podman-compose -f docker-compose.prod.yml restart backend

# 4. Verify
curl -sk -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"question":"test"}' \
  https://localhost/api/chat/ask | python3 -m json.tool
```

Changing the embeddings model requires **re-indexing the entire corpus** (vectors are incompatible across models):
```bash
sed -i 's/RAG_EMBED_MODEL=.*/RAG_EMBED_MODEL=nomic-embed-text/' .env
podman-compose -f docker-compose.prod.yml restart backend
# Start a full backfill
curl -sk -X POST -H "Authorization: Bearer $TOKEN" \
  https://localhost/api/admin/rag/backfill
```

### 19.7 Monitoring and metrics

```bash
# RAM/CPU usage for all containers
podman stats --no-stream

# Disk space used by models
du -sh /opt/cmdb-data/ollama-models/

# Disk space used by vectors in PostgreSQL
podman exec cmdb-postgres-prod psql -U admin -d cmdb_db -c "
  SELECT
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS total_size
  FROM pg_tables
  WHERE tablename LIKE 'rag_%'
  ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;"

# Most recent AI assistant queries (audit log)
podman exec cmdb-postgres-prod psql -U admin -d cmdb_db -c "
  SELECT user_email, created_at
  FROM audit_logs
  WHERE action = 'ASK_RAG'
  ORDER BY created_at DESC
  LIMIT 20;"
```

### 19.8 Disabling and re-enabling the RAG subsystem

To disable the subsystem temporarily without deleting data:
```bash
# In .env
RAG_ENABLED=false
# Restart the backend
podman-compose -f docker-compose.prod.yml restart backend
```
When RAG is disabled, the `/api/chat/*` endpoints return HTTP 503. The rest of the application continues to operate normally.

### 19.9 Troubleshooting

| Symptom | Diagnosis | Resolution |
|---|---|---|
| `/api/chat/ask` returns 503 | `RAG_ENABLED=false` or Ollama is down | Check `.env` and `podman ps` |
| Very slow responses (> 60 s) | Model not loaded in RAM / AMX inactive | Run `ollama ps`; verify `grep amx_tile /proc/cpuinfo` |
| `rag_document_index` rows in ERROR status | Parsing failure in the document | `podman logs cmdb-backend-prod \| grep INDEX_DOC` |
| Incorrect responses / hallucinations | High temperature or stale index | Verify `RAG_CHAT_TEMPERATURE=0.1`; trigger a reindex |
| "no space left on device" | Logical volume full | `df -h /var/lib/containers /opt/cmdb-data` |
| Slow embeddings during indexing | bge-m3 model not loaded | `ollama pull bge-m3`; restart backend |

### 19.10 Entity indexing (CIs, contracts, licenses, vulnerabilities)

> For the full operational procedure (smoke checklist + DPO/CISO sign-off + re-indexing of pre-existing corpora when upgrading from v1), see `docs/RAG_V2_DEPLOY_RUNBOOK.md`. This section documents the steady-state behaviour only; the runbook covers the one-off execution when moving from v1 to v2.

Starting with v2.3, the RAG subsystem indexes structured entities in addition to documents. No extra flag is needed — it activates automatically when `RAG_ENABLED=true`.

**Indexing worker.** The 30 s cron splits a 3-slot budget per tick across entities with priority vulnerability > contract/license > CI. If three vulnerabilities are pending, they consume the whole budget and contracts / CIs wait for the next cycle. This preserves document upload latency and prioritises security signal. See `docs/RAG_ENTITIES_INDEXING_PLAN.md` §10 for full details.

**Full reindex.** To reindex every entity type without restarting:

```bash
TOKEN=$(curl -sk -X POST https://localhost/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"...","password":"..."}' | jq -r .token)
curl -sk -X POST https://localhost/api/admin/rag/backfill \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"entityTypes":["document","ci","contract","license","vulnerability"]}'
```

An empty body `{}` (or no body) is equivalent to reindexing all types.

**Observability.** Queue state per type:

```sql
SELECT entity_type, status, COUNT(*) FROM rag_entity_index GROUP BY 1,2 ORDER BY 1,2;
```

Aggregated audit (one event per worker tick — not per entity):

```sql
SELECT created_at, details->>'cycle_at' AS cycle, details
FROM audit_logs WHERE action = 'INDEX_BATCH' ORDER BY created_at DESC LIMIT 10;
```

Other relevant events: `RAG_BACKFILL_ENTITIES` (manual reindex) and `ASK_RAG_VULN` (queries including vulnerabilities).

**Stuck-row troubleshooting.** A row may stay in `INDEXING` if the worker crashes mid-processing. Restarting the backend does NOT release it (the ARCH-3 guard prevents accidental overwrites). Release manually:

```sql
UPDATE rag_entity_index
   SET status = 'PENDING', updated_at = now()
 WHERE status = 'INDEXING' AND updated_at < now() - interval '5 minutes';
```

**Vulnerability UUID lock-in.** The `RAG_VULN_NAMESPACE` constant in `backend/src/services/entitySerializer.ts` (`6c8b1a3e-9d4f-4a2b-8c7d-1e2f3a4b5c6d`) is immutable. Changing it would invalidate every existing vulnerability chunk and require a full reindex, in addition to breaking the historical traceability of citations.

---

## 20. Backups — RAG encryption considerations

The `rag_chunks` and `rag_entity_index` tables store plaintext fragments of indexed documents and entities. Even though the serializer applies `scrubPII()` (email, Spanish DNI/NIE, phone) before embeddings are computed, **residual PII can always remain** in free-text notes and descriptions. This raises the sensitivity of any backup that includes these tables.

Encrypted backups are **mandatory in production**. Recommended approach: encrypt with `openssl` (AES-256-CBC, key in KMS or HSM) directly in the `pg_dump` pipe — never write plaintext to disk:

```bash
pg_dump -U admin -h localhost cmdb_db \
  | openssl enc -aes-256-cbc -salt -pbkdf2 -pass file:/secure/backup.key \
  > backup_$(date +%F).sql.enc
```

Restore:

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -pass file:/secure/backup.key \
  -in backup_2026-05-21.sql.enc \
  | psql -U admin -d cmdb_db_restore
```

Operational policy:

- The encryption key and the backup files must live on systems with separate ACLs.
- Key rotation: every 12 months, or immediately after any incident with suspected key exposure.
- Monthly restore sample test (`pg_restore --list`).

Reference: ENT-08 in `docs/security/rag-dpia.md` §A1.4.

---

## 21. RAG — Performance and GPU-accelerated inference (optional)

### 21.1 Why GPU matters

The `qwen2.5:7b-instruct-q4_K_M` chat model running on **CPU only** produces latencies of 40-120 seconds per query (measured on Xeon Gold 6526Y, 12 vCPU, 31 GB RAM). A mid-range GPU (RTX 4060 Ti 16 GB, L4, A10) accelerates inference **20-40×**, reducing typical response time to 2-5 seconds.

The `bge-m3` embedding model (1.2 GB) is lighter and tolerable on CPU, but also benefits from GPU.

### 21.2 Software tuning (no GPU required)

Configurable via `.env` or `install.conf`:

| Variable | Default | Effect |
|---|---|---|
| `RAG_NUM_PREDICT` | `768` | Max tokens per response. Reduce to 512 for ~25% faster on CPU with shorter answers. `0` = unlimited. |
| `RAG_CHAT_TIMEOUT_MS` | `180000` | Chat timeout (ms). Increase on slower hardware. |
| `OLLAMA_KEEP_ALIVE` | `-1` | `-1` = keep model loaded in RAM (eliminates ~20-30 s cold-load). `0` = unload after each request. |
| `RAG_CHAT_MODEL` | `qwen2.5:7b-instruct-q4_K_M` | Switch to `qwen2.5:3b-instruct-q4_K_M` for ~2× faster on CPU (lower response quality). |

### 21.3 Adding an NVIDIA GPU (RHEL 9)

#### Host prerequisites

```bash
# 1. Install NVIDIA driver (version ≥ 525)
sudo dnf install -y kernel-devel kernel-headers
# Download from https://www.nvidia.com/en-us/drivers/ or use NVIDIA's CUDA repo

# 2. Install NVIDIA Container Toolkit (CDI provider)
curl -s -L https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo \
  | sudo tee /etc/yum.repos.d/nvidia-container-toolkit.repo
sudo dnf install -y nvidia-container-toolkit

# 3. Configure CDI for Podman
sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
sudo nvidia-ctk runtime configure --runtime=crio   # or docker depending on runtime

# 4. Verify
nvidia-smi
podman run --rm --device nvidia.com/gpu=all nvidia/cuda:12.2-base-ubuntu22.04 nvidia-smi
```

#### Modify `docker-compose.prod.yml`

Add the `devices` block to the `ollama` service:

```yaml
  ollama:
    image: docker.io/ollama/ollama:latest
    container_name: cmdb-ollama-prod
    restart: unless-stopped
    environment:
      OLLAMA_MODELS: /root/.ollama/models
      OLLAMA_KEEP_ALIVE: ${OLLAMA_KEEP_ALIVE:-30m}   # 30 min is enough with GPU
    devices:
      - nvidia.com/gpu=all                           # CDI — RHEL 9 / Podman 4+
    volumes:
      - ${OLLAMA_MODELS_PATH:-/opt/cmdb-data/ollama-models}:/root/.ollama/models:Z
```

> **Docker Engine note:** with Docker instead of Podman, use `deploy.resources.reservations.devices` with `driver: nvidia` instead of the `devices` block.

#### Verify Ollama detects the GPU

```bash
# After restarting containers
podman exec cmdb-ollama-prod nvidia-smi
podman exec cmdb-ollama-prod ollama run qwen2.5:7b-instruct-q4_K_M "hello" 2>&1 | grep -i "gpu\|cuda"
```

If the GPU is active, Ollama logs show: `llm server loaded in X.XXs with GPU layers`.

### 21.4 Alternative faster models (CPU or light GPU)

| Model | Size | CPU (12 vCPU) | GPU RTX 4060 Ti | Notes |
|---|---|---|---|---|
| `qwen2.5:7b-instruct-q4_K_M` | 4.7 GB | ~45 s | ~3 s | Current default |
| `qwen2.5:3b-instruct-q4_K_M` | 2.0 GB | ~20 s | ~1.5 s | Lower quality |
| `llama3.2:3b-instruct-q4_K_M` | 2.0 GB | ~18 s | ~1.5 s | 3B alternative |
| `qwen2.5:14b-instruct-q4_K_M` | 9.0 GB | ~90 s | ~6 s | Higher quality (requires ≥16 GB VRAM) |

To change the model:

```bash
# 1. Pull the new model in Ollama
podman exec cmdb-ollama-prod ollama pull qwen2.5:3b-instruct-q4_K_M

# 2. Update the variable in .env
RAG_CHAT_MODEL=qwen2.5:3b-instruct-q4_K_M

# 3. Restart the backend (no image rebuild needed)
podman-compose -f docker-compose.prod.yml restart backend
```

### 21.5 Security and continuity impact

- **A08 — Integrity:** the CDI `devices: nvidia.com/gpu=all` block grants GPU device access to the Ollama container only; other containers have no hardware access.
- **ISO 22301 / RTO:** a GPU dedicated to the `ollama` container becomes an availability component. Document the procedure for starting without GPU (CPU fallback) as an acceptable degraded mode.
- **Drivers:** keep the NVIDIA driver updated. Kernel driver CVEs with DMA access are high severity.

---

## 22. Plugin Engine (v2.8.0) — installation and operation

This section covers bringing up and operating the Plugin Engine from the system administrator's point of view. For internal architecture, see [`docs/PLUGIN_ENGINE.md`](PLUGIN_ENGINE.md); for the approval procedure, [`docs/PLUGIN_SECURITY_CHECKLIST.md`](PLUGIN_SECURITY_CHECKLIST.md).

### 22.1 `PLUGIN_*` environment variables

Configurable in `.env` (defaults in parentheses):

| Variable | Default | Description |
|----------|---------|-------------|
| `PLUGIN_STORAGE_PATH` | `/var/lib/cmdb/plugins` | Persistent directory for bundles, backups and installed files |
| `PLUGIN_MAX_SIZE_MB` | `50` | Maximum uploaded bundle size (MB) |
| `PLUGIN_DATABASE_URL` | (required) | Connection using the restricted `cmdb_plugin` role to run DDL migrations. **Required** — `docker-compose.prod.yml` enforces it with `:?...` |
| `PLUGIN_REQUIRE_APPROVAL_PROD` | `true` | Requires 4-eyes approval from a second ADMIN to activate plugins |
| `PLUGIN_ENABLE_MARKETPLACE` | `true` | Enables marketplace queries |
| `PLUGIN_MARKETPLACE_URL` | (empty) | Marketplace repository URL (may be private) |
| `PLUGIN_SIGNING_PUBLIC_KEY` | (not present) | **Ed25519 public key (base64 SPKI/DER)** to verify signatures. It is **not** in `.env.example` nor in the default compose file — add it manually if you will use signed plugins. If a manifest declares a signature and this variable is not set, validation fails |

> `docker-compose.prod.yml` marks `PLUGIN_DATABASE_URL` as required (`:?...`) and `PLUGIN_REQUIRE_APPROVAL_PROD` defaults to `true`. Both must be configured in `.env` before first boot.

### 22.2 Create the `cmdb_plugin` database role

Plugin migrations run with a **restricted** PostgreSQL role that can only create new objects (prefix `plg_*`) and has **no** access to core tables. Create it **once** as a superuser:

```bash
# Apply the bootstrap script (included in the repo)
podman exec -i cmdb-postgres-prod psql -U admin -d cmdb_db < scripts/create-plugin-db-role.sql
```

The script (`scripts/create-plugin-db-role.sql`):
- Creates the `cmdb_plugin` role with `LOGIN` (change the password — the placeholder is `CHANGE_ME_IN_PRODUCTION`).
- `REVOKE ALL` on the `public` schema, then `GRANT USAGE` + `GRANT CREATE` (create new objects only, no access to existing ones).
- `ALTER DEFAULT PRIVILEGES` so it manages its own objects (needed for down-migrations).
- `GRANT CONNECT` to the database.

Then set the real password and reflect it in `PLUGIN_DATABASE_URL`:

```sql
ALTER ROLE cmdb_plugin PASSWORD 'a-strong-password';
```

```bash
# .env
PLUGIN_DATABASE_URL=postgresql://cmdb_plugin:a-strong-password@postgres:5432/cmdb_db
```

> **Defense in depth:** the `MigrationRunner` validates the SQL (DDL allowlist + `plg_` prefix) **before** executing it, and uses `execFile('psql')` (not `exec`, no shell injection). The restricted role is the second barrier at the database level.

### 22.3 The `cmdb-plugins-prod` volume

Plugin storage is persisted in a dedicated Docker volume, declared in `docker-compose.prod.yml`:

- Volume `cmdb-plugins-prod`, mounted at `/var/lib/cmdb/plugins`.

Internal layout: `staging/` (uploaded bundles), `installed/<uuid>/` (extracted files), `backups/` (pre-uninstall JSON backups).

### 22.4 Backup and restore of plugin storage

Plugin storage is **not** covered by the database `pg_dump` (these are files). Include it in your backup routine:

```bash
# Back up the plugins volume (files: bundles, installed, JSON backups)
podman run --rm -v cmdb-plugins-prod:/data -v $(pwd):/backup alpine \
  tar czf /backup/plugins_storage_$(date +%F).tar.gz -C /data .

# The plg_* tables live in PostgreSQL and ARE covered by the regular pg_dump:
podman exec cmdb-postgres-prod pg_dump -U admin cmdb_db > backup_$(date +%F).sql
```

For a full recovery you need **both**: the PostgreSQL dump (plugin registry + `plg_*` tables) and the volume tar (installed files + backups). Restore the volume with the reverse `tar` and the DB with `psql`.

> **NIS2 / supply chain:** each plugin is an external supplier. Keep an inventory of installed plugins (queryable via `GET /api/plugins` or the panel) and make sure you can **deactivate** any of them independently without affecting the core.

### 22.5 CSP and iframe

Plugin UIs are served in same-origin iframes. The nginx CSP policy (`frame-src 'self'`) is already compatible and **required no changes**; do not relax `frame-src` to external origins for plugins.

---

## 23. Email Alerts Module (v2.8.4)

### 23.1 SMTP environment variables

The SMTP variables are the same as in previous versions; the alerts module reads them at call time (not at application start-up), so updating `.env` and restarting the container is sufficient:

```env
# ── SMTP / Alerts ─────────────────────────────────────────────────────────────
SMTP_HOST=smtp.yourdomain.com
SMTP_PORT=587
SMTP_SECURE=false          # true for port 465 (direct TLS)
SMTP_USER=cmdb-alerts@yourdomain.com
SMTP_PASS=<smtp-password>
SMTP_FROM=CMDB Alerts <cmdb-alerts@yourdomain.com>
```

`CRON_SCHEDULE` is no longer required — the send time is configured from the UI (**Settings → Alerts**) and persisted in the `alert_config` table.

### 23.2 Database tables

Migration `20260615120000_alert_module` creates three new tables:

| Table | Description |
|-------|-------------|
| `alert_config` | Singleton (id = `"default"`) holding the global engine configuration |
| `alert_rules` | One row per category (7 categories); contains `enabled`, `warn_days`, `recipients` |
| `alert_runs` | Run history; insert-only; indexed by `started_at DESC` |

#### Key columns in `alert_config`

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Master on/off switch |
| `send_time_hour` | int | `8` | Send hour (0–23) |
| `send_time_minute` | int | `30` | Send minute (0–59) |
| `timezone` | varchar(64) | `UTC` | IANA timezone identifier |
| `locale` | varchar(10) | `es` | Email language |
| `recipients` | text[] | `{}` | Global recipient list |
| `send_all_clear` | boolean | `false` | Notify when no alerts exist |
| `suppress_unchanged` | boolean | `true` | SHA-256 fingerprint dedup |

#### Categories in `alert_rules`

`eol`, `eos`, `warranty`, `maintenance`, `contract`, `vulnerability`, `license`

### 23.3 Scheduler

The scheduler starts with the application (`startAlertScheduler(prisma)` called from `index.ts`) and uses `node-cron` with a one-minute tick (`* * * * *`). On each tick it:

1. Reads `alert_config` from the DB (5-minute cache).
2. Gets the current hour and minute in the configured timezone using `Intl.DateTimeFormat`.
3. If it matches `send_time_hour:send_time_minute`, checks whether a successful run already occurred today (idempotent guard).
4. If not, launches the full pipeline.

The pipeline (`runAlertsPipeline`) scans all 7 categories, computes the SHA-256 fingerprint, applies dedup if `suppress_unchanged = true`, builds the HTML email in the configured language, sends it, and records the result in `alert_runs`.

### 23.4 Post-deployment verification

```bash
# Verify tables exist
podman exec cmdb-postgres-prod psql -U admin cmdb_db -c '\dt alert_config alert_rules alert_runs'

# Check seeded configuration
podman exec cmdb-postgres-prod psql -U admin cmdb_db -c \
  'SELECT id, enabled, send_time_hour, send_time_minute, timezone, locale FROM alert_config;'

# Verify the 7 rules
podman exec cmdb-postgres-prod psql -U admin cmdb_db -c \
  'SELECT category, enabled, warn_days FROM alert_rules ORDER BY category;'

# View run history
podman exec cmdb-postgres-prod psql -U admin cmdb_db -c \
  'SELECT trigger, status, total_alerts, started_at FROM alert_runs ORDER BY started_at DESC LIMIT 10;'

# Force a test send via API
TOKEN=$(curl -sk -X POST https://localhost/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@cmdb.local","password":"<admin-password>"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
curl -sk -X POST https://localhost/api/alerts/test \
  -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

### 23.5 Troubleshooting

**Alerts are not being sent:**

```bash
# Check scheduler logs
podman logs cmdb-backend-prod 2>&1 | grep -i 'alert\|smtp\|scheduler' | tail -30

# Check the last run outcome
podman exec cmdb-postgres-prod psql -U admin cmdb_db -c \
  "SELECT status, error_msg, total_alerts, started_at FROM alert_runs ORDER BY started_at DESC LIMIT 5;"
```

**Emails arrive at the wrong time:**

Verify the timezone in `alert_config`. The application uses `Intl.DateTimeFormat` with the IANA identifier — it does not depend on the container's TZ environment variable:

```bash
podman exec cmdb-postgres-prod psql -U admin cmdb_db -c \
  "UPDATE alert_config SET timezone = 'Europe/London' WHERE id = 'default';"
```

(Or use the UI: **Settings → Alerts → Global Configuration**.)

**Duplicate emails being sent:**

Verify that `suppress_unchanged = true` in `alert_config`. Setting it to `false` forces a send on every scheduled run regardless of changes.

### 23.6 Manual rollback

```sql
-- Remove alerts module tables
DROP TABLE IF EXISTS alert_runs;
DROP TABLE IF EXISTS alert_rules;
DROP TABLE IF EXISTS alert_config;
```

After removing the tables, restore the legacy scheduler block in `index.ts` if needed. The `configuration_items`, `contracts`, `licenses`, and `vulnerabilities` tables are not affected.


## LDAP: access group and user synchronisation (v3.5.10)

### Restricting login to a security group

Add to `.env`:

```bash
LDAP_REQUIRED_GROUP=GS-CMDB-Iberia-Access   # short CN or full DN
LDAP_GROUP_NESTED=true                       # false = direct members only
LDAP_GROUP_SEARCH_BASE=                      # optional; falls back to LDAP_SEARCH_BASE
```

**Requires `LDAP_BIND_DN` and `LDAP_BIND_PASSWORD`**: membership is queried with the service account. Without it, no LDAP login will succeed while the group is configured — this is deliberate (see below).

With the variable **empty**, LDAP login behaves exactly as before v3.5.10. That is the default, so an upgrade never locks anyone out.

After editing `.env`, **redeploy the whole stack**. Selectively recreating a single container does not reliably pick up an edited `.env`:

```bash
podman-compose -f docker-compose.prod.yml down
podman-compose -f docker-compose.prod.yml up -d --build
```

### Failure behaviour

| Situation | What happens |
|---|---|
| User not in the group | `401`, account deactivated, `LDAP_GROUP_DENIED` entry in `audit_logs` |
| Directory down, or no `LDAP_BIND_DN` | `401` for every LDAP login; `LDAP_GROUP_CHECK_UNAVAILABLE` in the log |
| Local accounts (`@cmdb.local`) | **Unaffected** in all cases |

That last row is the operational guarantee that matters: even with the domain controller down, the local administrator can still log in. If you see `LDAP_GROUP_CHECK_UNAVAILABLE` in the logs, check DC connectivity and the service account credentials before anything else.

### User synchronisation

Two triggers, one implementation:

- **Manual**: Settings → Integrations → "Sync now" (ADMIN only).
- **Automatic**: n8n workflow `LDAP Group Sync`, daily at 03:00 (`LDAP_SYNC_CRON`). Activated only when `USE_LDAP=true` and a group is configured.

```bash
LDAP_SYNC_DEFAULT_ROLE=VIEWER   # role on creation; never reapplied to existing users
LDAP_SYNC_MAX_MEMBERS=5000      # hard cap per run
LDAP_SYNC_CRON=0 3 * * *
```

It never deletes users: those who leave the group are set to `active=false`. Manually created users (no `sso_external_id`) are untouchable. An existing user's role is **never** overwritten, so a manual promotion survives the nightly run.

Quick check from the host:

```bash
podman exec cmdb-postgres-prod psql -U admin -d cmdb_db -c \
  "SELECT action, count(*) FROM audit_logs WHERE action LIKE 'LDAP_%' GROUP BY action;"
```

### Deprecated variables

`LDAP_SYNC_GROUP_DN` and `LDAP_SYNC_DOMAIN` are no longer used: they fed the previous workflow, which queried the directory from n8n. They can be removed from `.env`.

---

## Greenbone vulnerability import — staging and review (v3.6.0)

> **Status as of writing this section: `develop` branch, not yet tagged or merged to `main`.** Do not treat this as a production release until the corresponding "Plan Activo" entry in `CLAUDE.md` says otherwise.

See `docs/INTEGRATIONS.md` § 9 for the full architecture (identity model, CI-matching cascade, staging workflow). This section covers only the sysadmin/operational side.

### New tables and backups

The module adds two tables to the database: `vuln_import_batches` and `vuln_import_entries`. **They require no new backup procedure** — they're covered by the regular `pg_dump` dump described in [§6](#6-database-backup-and-restore), same as any other table in `cmdb_db`. No adjustment to `db-backup.sh` or any retention script is needed.

### Backfilling `key` on pre-existing vulnerabilities

Every vulnerability entry stored **before** this release only has `cve` (never `key` — a field that didn't exist yet). `PATCH /api/vulnerabilities` already resolves identity as `key ?? cve`, so the system works without a backfill — but to have old entries carry `key` populated consistently with new ones, use `backend/scripts/backfill-vuln-keys.js`: it sets `key = cve` on any entry that doesn't already have `key`. It is **idempotent** (running it twice never duplicates or corrupts anything) and supports `--dry-run` to preview what it would touch without writing.

It follows the same pattern already documented in this manual for running a Node.js script inside the backend container (needs Prisma in scope):

```bash
# Dry run — reports only, writes nothing
podman cp backend/scripts/backfill-vuln-keys.js cmdb-backend-prod:/app/backfill-vuln-keys.js \
  && podman exec -w /app cmdb-backend-prod node backfill-vuln-keys.js --dry-run \
  && podman exec cmdb-backend-prod rm /app/backfill-vuln-keys.js

# Apply for real
podman cp backend/scripts/backfill-vuln-keys.js cmdb-backend-prod:/app/backfill-vuln-keys.js \
  && podman exec -w /app cmdb-backend-prod node backfill-vuln-keys.js \
  && podman exec cmdb-backend-prod rm /app/backfill-vuln-keys.js
```

Running it before enabling the module is not required — it's a consistency clean-up, not a functional prerequisite. Run it once after deploying this version if you want old vulnerabilities to carry `key` explicitly instead of relying on the `?? cve` fallback on every read.

### Known gap: stale `PENDING` batches are not purged

An import batch (`VulnImportBatch`) that gets uploaded and is **never accepted or discarded** stays in `PENDING` state indefinitely. This release's spec proposed folding the purge of abandoned `PENDING` batches into the existing maintenance cron (the same one that cleans up expired trusted devices and the SSO state store), but **it was not implemented in this version** — do not assume it exists. A stale `PENDING` batch carries no data-integrity risk (it never touched any CI); it only accumulates rows in `vuln_import_batches`/`vuln_import_entries` and stays visible in the `/vulnerabilities/imports` list until someone accepts or discards it manually.

### Second source: CrowdStrike Spotlight (same branch, not yet tagged)

> See `docs/INTEGRATIONS.md` § 9.12 for the full architecture (identity model, merge-by-`vulnerability_id`, CISA KEV / active-exploitation premarking, CrowdStrike's own reopen-signal path). This section covers only the sysadmin/operational side.

**New columns, no new backup procedure.** `vuln_import_entries` gains 8 nullable columns (`products`, `exprt_rating`, `cisa_kev`, `cisa_due_date`, `exploit_status`, `days_open`, `external_status`, `cvss_version`) for CrowdStrike Spotlight-specific signals. Same as the Greenbone-specific columns added in v3.6.0, **they require no new backup procedure** — they're covered by the regular `pg_dump` dump described in [§6](#6-database-backup-and-restore).

**Nullability change on `oid`/`port`.** These two columns, previously always populated in practice (Greenbone's NVT-and-port identity), are now nullable: a CrowdStrike entry has neither an NVT nor a port, so both are `NULL` on those rows. If you have any ad-hoc SQL queries or custom reporting tooling against `vuln_import_entries` that assume `oid`/`port` are always populated, review them — any row with `source='crowdstrike'` will have them `NULL`.

**20MB limit now also on `/api/integrations/crowdstrike`.** The 20MB body-size override (vs. the app-wide 2MB limit), already applied to `/api/vuln-import/upload` in v3.6.0, is now also applied to the legacy `/api/integrations/crowdstrike` endpoint, which as of this round can also receive a real Spotlight export (in addition to the original agent/EDR shape, which still works unchanged). A real single-host Spotlight export is around 686KB in the test fixture — a multi-host export can easily approach or exceed the previous 2MB limit. No configuration action is needed: the override is already registered in `index.ts` in the correct order (ahead of the global parser) for both routes.
