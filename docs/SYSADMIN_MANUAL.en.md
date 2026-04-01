# 🔧 CMDB Enterprise Platform — System Administrator Manual

**Version:** 1.1.0
**Audience:** Systems and Infrastructure Team (RHEL)
**Date:** 2026-03-31

---

## Table of Contents

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

---

## 2. Initial Deployment

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

### Step 3: Generate SSL certificates (if HTTPS_ENABLED=true)
```bash
bash backend/scripts/generate-certs.sh
# Output: backend/certs/server.key and server.crt
```

### Step 4: Prepare the TLS volume
```bash
docker volume create cmdb-tls-certs
docker run --rm \
  -v cmdb-tls-certs:/dest \
  -v $(pwd)/backend/certs:/src:ro \
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
curl http://localhost:3000/health
# Expected response: {"status":"ok","timestamp":"..."}
```

### Default credentials after seeding
| Email | Password | Role |
|-------|----------|------|
| `admin@cmdb.local` | `Admin1234!` | ADMIN |
| `auditor@cmdb.local` | `Audit1234!` | VIEWER |

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

### Optional variables — Document Repository

```bash
# ── Document Storage ───────────────────────────────────────────────────
# Host path where uploaded files are stored.
# If not set, the named Docker volume 'cmdb-documents' is used.
# Can point to a local path or an NFS mount.
DOCUMENTS_STORAGE_PATH=/var/lib/cmdb/documents
# DOCUMENTS_STORAGE_PATH=/mnt/nfs/cmdb-docs
```

> **Important:** If `DOCUMENTS_STORAGE_PATH` is defined, the directory must exist on the host before starting the services and must be readable and writable by the UID of the `node` process inside the container (`UID 1000` in standard Alpine images).

**Example with NFS mount:**
```bash
# 1. Mount the NFS share (add to /etc/fstab for persistence)
sudo mkdir -p /mnt/nfs/cmdb-docs
sudo mount -t nfs nfs-server.corp.local:/exports/cmdb-docs /mnt/nfs/cmdb-docs

# 2. Assign permissions to the container UID
sudo chown 1000:1000 /mnt/nfs/cmdb-docs

# 3. Configure in .env
echo "DOCUMENTS_STORAGE_PATH=/mnt/nfs/cmdb-docs" >> .env
```

> The storage directory (bind mount or named volume) must be included in the backup strategy alongside the PostgreSQL volume. See section 6 for the backup procedure.

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
| API /health response time | > 2s | Review backend logs |
| Backend container memory | > 1.5 GB | Restart backend |
| Error rate in logs | > 10 errors/min | Review logs |
| SSL certificate expiry | < 30 days | Renew (section 4.3) |

---

## 8. Application Updates

### Standard update (zero-downtime)
```bash
cd /opt/cmdb

# 1. Create a backup before updating
bash scripts/db-backup.sh

# 2. Fetch changes from the repository
git pull origin main

# 3. Review the CHANGELOG or commits
git log --oneline -10

# 4. Rebuild images
docker compose -f docker-compose.prod.yml build --no-cache

# 5. Replace containers (Docker restarts them one by one)
docker compose -f docker-compose.prod.yml up -d

# 6. Verify everything is correct
docker compose -f docker-compose.prod.yml ps
curl http://localhost:3000/health
```

### Rollback if something fails
```bash
cd /opt/cmdb

# View commit history
git log --oneline -10

# Revert to the previous commit
git checkout <previous-hash>

# Rebuild with the previous version
docker compose -f docker-compose.prod.yml build --no-cache
docker compose -f docker-compose.prod.yml up -d

# Restore the database backup if necessary
gunzip -c /opt/cmdb/backups/backup_<previous-date>.sql.gz \
  | docker exec -i cmdb-postgres-prod psql -U cmdb_admin -d cmdb_db
```

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
