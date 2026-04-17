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
docker compose up -d backend
```

#### Migrate to a new volume (post-installation)

When moving storage to a different path (e.g. from local to NFS):

```bash
# 1. Stop the backend to prevent writes during the copy
docker compose stop backend

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
docker compose up -d backend

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

### Authentication strategies

The system automatically applies the most secure available strategy:

**Strategy 1 — Admin bind + search (recommended for corporate AD):**
Activated when `LDAP_BIND_DN` is configured. The service account performs the initial bind, then searches for the user by the `mail` attribute (if the login is an email address) or `uid`, and finally re-binds as that user to verify the password.

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
ls -laZ /var/lib/docker/volumes/cmdb-postgres-data-prod/

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

| Frequency | Task | Command / Action |
|-----------|------|-----------------|
| Daily (automatic) | DB Backup | Cron 02:00 AM |
| Daily (automatic) | Email alerts | Cron 08:30 AM |
| Weekly | Review backup logs | `tail -n 50 /var/log/cmdb-backup.log` |
| Monthly | `npm audit` on backend/frontend | `docker exec cmdb-backend-prod npm audit` |
| Monthly | Verify SSL expiry | `openssl x509 -noout -dates -in backend/certs/server.crt` |
| Monthly | Docker image cleanup | `docker image prune -f` |
| Quarterly | JWT_SECRET rotation | See section 10 |
| Annual | SSL certificate renewal | See section 4.3 |
| Annual | Review active users | Settings tab → Users |

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
- **PersistentVolumeClaims:** Replace Docker volumes (`cmdb-postgres-data-prod`, `cmdb-tls-certs`, `document-storage`) with PVCs using the appropriate storage class for the cluster.

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
oc set image deployment/cmdb-backend \
  backend=registry.corp.local/cmdb/backend:$(git rev-parse --short HEAD) \
  -n cmdb-prod

oc rollout restart deployment/cmdb-frontend -n cmdb-prod

# 4. Check rollout status
oc rollout status deployment/cmdb-backend -n cmdb-prod
oc rollout status deployment/cmdb-frontend -n cmdb-prod
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
sg docker -c "docker exec cmdb-backend npx prisma migrate deploy"
```

Verify the migration applied correctly:

```bash
sg docker -c "docker exec cmdb-postgres psql -U cmdb_db_user -d cmdb_db -c '\d users'" | grep sso
```

You should see the `sso_provider` and `sso_external_id` columns in the output.

---

### Step 6: Restart the Backend

After updating `.env`, rebuild and restart the backend container for the changes to take effect:

```bash
sg docker -c "docker compose up -d --build backend"
```

Check that the backend starts without errors:

```bash
sg docker -c "docker logs cmdb-backend --tail 30"
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
   sg docker -c "docker compose up -d --build backend"
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
