# 🚀 CMDB Enterprise Platform — Production Deployment Runbook

**Target server:** `cmdb-server` (Red Hat Enterprise Linux 8/9)
**Document version:** 1.0
**Date:** 2026-03-15
**Prerequisites:** Docker Engine 24+ or Podman 4+ with Docker Compose plugin

---

## Table of Contents

1. [System Preparation (ISO 27001 Compliance)](#1-system-preparation-iso-27001-compliance)
2. [Prerequisites on the RHEL Server](#2-prerequisites-on-the-rhel-server)
3. [Clone the Repository](#3-clone-the-repository)
4. [Configure the Environment (.env)](#4-configure-the-environment-env)
5. [Generate SSL Certificates](#5-generate-ssl-certificates)
6. [Prepare TLS Volumes](#6-prepare-tls-volumes)
7. [Build and Start the Services](#7-build-and-start-the-services)
8. [Verify the Deployment](#8-verify-the-deployment)
9. [Configure Automated Backup (cron)](#9-configure-automated-backup-cron)
10. [Configure the Firewall (firewalld)](#10-configure-the-firewall-firewalld)
11. [Application Update](#11-application-update)
12. [Quick Rollback](#12-quick-rollback)
13. [Diagnostics and Troubleshooting](#13-diagnostics-and-troubleshooting)

---

## 1. System Preparation (ISO 27001 Compliance)

> **⚠️ MANDATORY:** This section implements ISO 27001 security requirements for production environments.
> **Applied principles:** Zero Trust, Least Privilege, Service Isolation, Process Persistence.

### 1.1 Create a Dedicated Service User

**Never run containers in production as root or with personal user accounts.** Create a dedicated user to isolate the application:

```bash
# Create a service user with no interactive shell access
sudo useradd -m -s /bin/bash cmdb-admin
sudo passwd cmdb-admin
# Enter a strong password (minimum 16 characters)

# Verify creation
id cmdb-admin
# uid=1001(cmdb-admin) gid=1001(cmdb-admin) groups=1001(cmdb-admin)
```

### 1.2 Enable Container Persistence (Linger)

**CRITICAL:** Without this configuration, rootless Podman containers stop when the user logs out or the server reboots.

```bash
# Enable persistence for the service user
sudo loginctl enable-linger cmdb-admin

# Verify that linger is active
loginctl show-user cmdb-admin | grep Linger
# Linger=yes
```

> **What does `enable-linger` do?**
> It allows the `cmdb-admin` user's services to keep running even when there is no active session. This ensures that Podman containers survive system reboots and SSH logouts.

### 1.3 Verify Storage Sizing (LVM)

> **⚠️ CRITICAL — Podman Rootless and /home usage**
>
> Unlike traditional Docker, **Podman Rootless stores ALL images, containers, and persistent volumes in the service user's home directory**, specifically at:
>
> ```
> /home/cmdb-admin/.local/share/containers/
>   ├── storage/           (images and container layers)
>   └── volumes/           (persistent PostgreSQL data)
> ```
>
> **Risk:** If `/home` does not have enough space or shares the same partition as `/` (root), the platform may fill the disk and cause:
> - Operating system crash
> - PostgreSQL database corruption
> - Inability to create new containers
>
> **Mandatory solution:** Create a dedicated LVM volume for `/home` (or specifically for `/home/cmdb-admin`) with adequate sizing.

#### Recommended Sizing

Refer to the full capacity planning table in [`docs/ARCHITECTURE.md - Section 11`](docs/ARCHITECTURE.md#11-capacity-planning-y-dimensionamiento-de-hardware).

**Quick summary:**

| CI Volume | Minimum space in /home |
|-----------|------------------------|
| Up to 1,000 | 15 GB |
| 1,000 to 5,000 | 30 GB |
| 5,000 to 20,000+ | 60 GB+ |

#### Verify Available Space in /home

```bash
# Verify available space in /home
df -h /home
# Filesystem      Size  Used Avail Use% Mounted on
# /dev/mapper/vg0-home   50G  2.0G   48G   4% /home

# If /home is not a dedicated volume or has less than 30 GB, creating one is CRITICAL

# Verify whether /home is on an independent LVM volume
lsblk
lvs
```

#### Create an LVM Volume for /home (if it does not exist)

If `/home` is not on a separate LVM volume or does not have enough space, run:

```bash
# CAUTION: These commands require LVM knowledge and can cause data loss
# Perform a full backup before proceeding

# 1. Create the logical volume (adjust size according to your capacity planning table)
sudo lvcreate -L 50G -n lv_home vg0

# 2. Format with XFS (recommended for databases)
sudo mkfs.xfs /dev/vg0/lv_home

# 3. Mount temporarily and copy existing data
sudo mkdir /mnt/new_home
sudo mount /dev/vg0/lv_home /mnt/new_home
sudo rsync -avxHAX /home/ /mnt/new_home/

# 4. Update /etc/fstab
sudo nano /etc/fstab
# Add: /dev/mapper/vg0-lv_home  /home  xfs  defaults  0 0

# 5. Reboot or remount
sudo umount /mnt/new_home
sudo mount -a
```

> **Production recommendation:** Plan the sizing of `/home` during the initial RHEL server installation, not after deployment.

### 1.4 Prepare the Installation Directory with Restrictive Permissions

```bash
# Create the installation directory
sudo mkdir -p /opt/cmdb-enterprise-platform

# Assign ownership to the service user
sudo chown -R cmdb-admin:cmdb-admin /opt/cmdb-enterprise-platform

# Set restrictive permissions (read/write/execute only for the owner)
sudo chmod -R 750 /opt/cmdb-enterprise-platform

# Verify permissions
ls -ld /opt/cmdb-enterprise-platform
# drwxr-x--- 2 cmdb-admin cmdb-admin 4096 ... /opt/cmdb-enterprise-platform
```

### 1.5 Switch to the Service User

**All subsequent operations must be run as `cmdb-admin`:**

```bash
# Switch to the service user
sudo su - cmdb-admin

# Verify you are the correct user
whoami
# cmdb-admin

# Verify available space in your home directory
df -h ~
# Filesystem      Size  Used Avail Use% Mounted on
# /dev/mapper/vg0-lv_home   50G  2.0G   48G   4% /home

# Navigate to the installation directory
cd /opt/cmdb-enterprise-platform
```

> **Security note:** From this point on, NEVER run Podman/Docker commands as root. Everything must be run as `cmdb-admin`.

---

## 2. Prerequisites on the RHEL Server

### Option A: Podman Rootless (RECOMMENDED — ISO 27001)

**Podman Rootless** allows containers to run without root privileges, complying with the principle of least privilege.

```bash
# Verify OS version
cat /etc/redhat-release

# Install Podman and podman-compose (RHEL 8/9 — already pre-installed on RHEL 9)
sudo dnf install -y podman podman-compose

# Verify installation
podman --version
# Podman version 4.x.x or higher

# Create alias for docker-compose compatibility (OPTIONAL)
echo 'alias docker-compose="podman-compose"' >> ~/.bashrc
echo 'alias docker="podman"' >> ~/.bashrc
source ~/.bashrc

# Install git if not available
sudo dnf install -y git

# Install openssl (for generating certificates and JWT secret)
sudo dnf install -y openssl
```

> **Important note:** In Podman Rootless, it is NOT required to add the user to any privileged group.
> Containers run in user space without requiring `sudo`.

### Option B: Docker Engine (Alternative)

```bash
# Verify OS version
cat /etc/redhat-release

# Install Docker Engine (RHEL 8/9)
sudo dnf install -y dnf-plugins-core
sudo dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo
sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Start and enable Docker
sudo systemctl enable --now docker

# Add the service user to the docker group
sudo usermod -aG docker cmdb-admin
newgrp docker

# Verify installation
docker --version
docker compose version

# Install git and openssl
sudo dnf install -y git openssl
```

### SELinux Configuration (RHEL)

```bash
# Verify SELinux status
getenforce
# Enforcing (correct)

# Volumes in docker-compose.prod.yml already include the :Z suffix
# which relabels files for SELinux in Enforcing mode.
# It is NOT necessary to disable SELinux.
```

---

## 3. Clone the Repository

> **Important:** Run these commands as the `cmdb-admin` user (see section 1.4).

```bash
# Verify you are cmdb-admin
whoami
# cmdb-admin

# Navigate to the installation directory (already created in section 1.3)
cd /opt/cmdb-enterprise-platform

# Clone the repository
git clone https://github.com/pirexia/cmdb-enterprise-platform.git .

# Verify contents and permissions
ls -la
# Files must belong to cmdb-admin:cmdb-admin

# Verify parent directory permissions
ls -ld /opt/cmdb-enterprise-platform
# drwxr-x--- ... cmdb-admin cmdb-admin
```

---

## 4. Configure the Environment (.env)

```bash
# Copy the template
cp .env.example .env

# Edit with production values
nano .env

# Restrict .env file permissions (read/write for owner only)
chmod 600 .env

# Verify permissions
ls -l .env
# -rw------- 1 cmdb-admin cmdb-admin ... .env
```

### Mandatory Variables in Production

Only **6 variables** are required — everything else has secure code-level defaults.

```bash
# ── Database ───────────────────────────────────────────────────────────────
POSTGRES_PASSWORD=<secure-password-32-chars>     # openssl rand -base64 32

# ── Security ───────────────────────────────────────────────────────────────
JWT_SECRET=<min-48-chars>            # openssl rand -base64 48

# ── URLs (nginx serves frontend AND API on the same host/port) ─────────────
# nginx listens on :443 — no port suffix in the URL
NEXT_PUBLIC_API_URL=https://cmdb.yourdomain.com
FRONTEND_URL=https://cmdb.yourdomain.com

# ⚠️ NEXT_PUBLIC_API_URL is baked into the frontend image at BUILD time.
# If you change it, you MUST rebuild: docker compose -f docker-compose.prod.yml build frontend --no-cache

# ── Branding ───────────────────────────────────────────────────────────────
NEXT_PUBLIC_COMPANY_NAME=My Company

# ── Document Storage ───────────────────────────────────────────────────────
DOCUMENTS_STORAGE_PATH=./document-storage

# ── SMTP / Alerts (optional — leave empty to disable) ─────────────────────
SMTP_HOST=smtp.yourdomain.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=cmdb-alerts@yourdomain.com
SMTP_PASS=<smtp-password>
ALERT_RECIPIENT=it-ops@yourdomain.com
```

> **Security:** The `.env` file must never be committed. It is listed in `.gitignore`.

```bash
# Restrict .env permissions
chmod 600 .env
```

### Generate JWT_SECRET Securely

```bash
openssl rand -base64 48
# Example output: abc123...48chars...XYZ=
# Copy that value into JWT_SECRET in .env
```

---

## 5. Generate SSL Certificates

Certificates are stored in **`./certs/`** (project root) and mounted by nginx.

### Option A — Self-signed certificate (development/intranet)

```bash
# Using the script included in the project (RSA 4096-bit, 10-year validity)
bash backend/scripts/generate-certs.sh

# Certificates are generated in ./certs/
ls -la certs/
# → server.key   (RSA 4096-bit private key — NEVER share or commit)
# → server.crt   (self-signed certificate — 10 years)
```

**Alternative via UI:** Admin → Certificates → «Generate CSR» (generates key + CSR directly from the browser).

### Option B — Certificate from a Corporate CA (recommended for production)

```bash
# 1. Generate a CSR (Certificate Signing Request) — RSA 4096-bit
openssl req -new -newkey rsa:4096 -nodes \
  -keyout certs/server.key \
  -out    certs/server.csr \
  -subj   "/C=ES/ST=Madrid/O=YourCompany/CN=cmdb.yourdomain.com" \
  -addext "subjectAltName=DNS:cmdb.yourdomain.com,DNS:localhost"

# 2. Send certs/server.csr to your corporate CA
# 3. When you receive the signed certificate, save it as:
cp signed-certificate.crt certs/server.crt

# 4. Verify that the key and certificate match
openssl x509 -noout -modulus -in certs/server.crt | md5sum
openssl rsa  -noout -modulus -in certs/server.key | md5sum
# Both lines must show the same MD5 hash
```

---

## 6. Prepare TLS Volumes

Certificates must be copied to the Docker named volume `cmdb-tls-certs` (used by `docker-compose.prod.yml`):

```bash
# Create the volume (if it does not exist)
docker volume create cmdb-tls-certs

# Copy the certificates into the volume
docker run --rm \
  -v cmdb-tls-certs:/dest \
  -v $(pwd)/certs:/src:ro \
  alpine sh -c "cp /src/server.key /src/server.crt /dest/ && chmod 600 /dest/server.key"

# Verify
docker run --rm -v cmdb-tls-certs:/certs alpine ls -la /certs
```

---

## 7. Build and Start the Services

```bash
# Make sure you are in the correct directory and as cmdb-admin
cd /opt/cmdb-enterprise-platform
whoami  # Must show: cmdb-admin

# Build the images (multi-stage, takes ~3 minutes the first time)
docker compose -f docker-compose.prod.yml build --no-cache

# Start all services in the background
docker compose -f docker-compose.prod.yml up -d

# Watch logs in real time (ctrl+C to exit)
docker compose -f docker-compose.prod.yml logs -f
```

> **Note for Podman Rootless:** If you use Podman, replace `docker compose` with `podman-compose` or use the alias configured in section 2.

### Verify That All Containers Are Healthy

```bash
docker compose -f docker-compose.prod.yml ps
```

Expected output:

```
NAME                  STATUS            PORTS
cmdb-postgres-prod    running (healthy)
cmdb-backend-prod     running (healthy) 3000/tcp
cmdb-frontend-prod    running           3001/tcp
cmdb-nginx-prod       running           0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp
```

> Only nginx exposes ports to the host (443 and 80). Backend and frontend are internal.

---

## 8. Verify the Deployment

```bash
# 1. Backend health check (through nginx)
curl -sk https://localhost/api/health
# Response: {"status":"ok","timestamp":"..."}

# 2. HTTP → HTTPS redirect
curl -sI http://localhost | grep -i location
# Response: Location: https://localhost/

# 3. Frontend accessible (through nginx)
curl -skI https://localhost | head -3
# Response: HTTP/2 200

# 4. Verify TLS certificate
openssl s_client -connect localhost:443 -showcerts 2>/dev/null | openssl x509 -noout -subject -dates

# 5. First login
# Open in browser: https://cmdb-server
# Default admin credentials: admin@cmdb.local / Admin1234!
# (Change the password immediately after the first login)
```

---

## 9. Configure Automated Backup (cron)

```bash
# Make the script executable
chmod +x /opt/cmdb-enterprise-platform/scripts/db-backup.sh

# Create the backups directory (as cmdb-admin)
mkdir -p /opt/cmdb-enterprise-platform/backups
chmod 750 /opt/cmdb-enterprise-platform/backups

# Test the backup manually (must create a .sql.gz file)
BACKUP_DIR=/opt/cmdb-enterprise-platform/backups \
PG_CONTAINER=cmdb-postgres-prod \
POSTGRES_DB=cmdb_db \
POSTGRES_USER=cmdb_admin \
  bash /opt/cmdb-enterprise-platform/scripts/db-backup.sh

ls -lh /opt/cmdb-enterprise-platform/backups/

# Add to the cmdb-admin user's crontab (do NOT use sudo crontab)
crontab -e
```

Add this line to the crontab:

```cron
# CMDB Enterprise Platform — Daily database backup at 02:00 AM
0 2 * * * BACKUP_DIR=/opt/cmdb-enterprise-platform/backups PG_CONTAINER=cmdb-postgres-prod POSTGRES_DB=cmdb_db POSTGRES_USER=cmdb_admin /opt/cmdb-enterprise-platform/scripts/db-backup.sh >> /home/cmdb-admin/cmdb-backup.log 2>&1
```

```bash
# Verify the cron entry was registered (as cmdb-admin)
crontab -l | grep cmdb

# Create the log file
touch /home/cmdb-admin/cmdb-backup.log
chmod 640 /home/cmdb-admin/cmdb-backup.log

# Rotate backup logs (logrotate) - requires root permissions
sudo tee /etc/logrotate.d/cmdb-backup << 'EOF'
/home/cmdb-admin/cmdb-backup.log {
    weekly
    rotate 12
    compress
    missingok
    notifempty
    su cmdb-admin cmdb-admin
}
EOF
```

---

## 10. Configure the Firewall (firewalld)

Only nginx exposes ports to the host. Backend, frontend, and PostgreSQL are internal containers.

```bash
# Allow HTTPS (443) and HTTP (80 — redirect to 443)
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --reload

# Verify
sudo firewall-cmd --list-services
# Must show: dhcpv6-client http https ssh (or similar)

# Confirm ports 3000 and 3001 are NOT open — backend/frontend are internal only
sudo firewall-cmd --list-ports
# Must be empty (or not show 3000/3001)

# Note: Port 5432 (PostgreSQL) must NOT be opened — the DB is internal only
```

---

## 11. Application Update

### Option A — Automated (recommended)

```bash
# Run as cmdb-admin from the installation directory
cd /opt/cmdb-enterprise-platform
bash scripts/update.sh
# The script pulls the latest code, migrates certs if needed,
# rebuilds images, restarts containers, and verifies the health check.
```

### Option B — Manual

```bash
# Run as cmdb-admin
whoami  # cmdb-admin
cd /opt/cmdb-enterprise-platform

# 1. Pull changes from the repository
git pull origin main

# 2. Rebuild images with the changes
docker compose -f docker-compose.prod.yml build --no-cache

# 3. Restart with zero downtime (replaces containers one by one)
docker compose -f docker-compose.prod.yml up -d

# 4. Verify everything is correct
docker compose -f docker-compose.prod.yml ps
curl -sk https://localhost/api/health
# Response: {"status":"ok","timestamp":"..."}
```

---

## 12. Quick Rollback

If the deployment fails, revert to the previous commit:

```bash
# Run as cmdb-admin
cd /opt/cmdb-enterprise-platform

# View the commit history
git log --oneline -10

# Revert to the previous commit
git checkout <previous-commit-hash>

# Rebuild with the previous version
docker compose -f docker-compose.prod.yml build --no-cache
docker compose -f docker-compose.prod.yml up -d
```

---

## 13. Diagnostics and Troubleshooting

### View Logs for a Specific Service

```bash
docker logs cmdb-nginx-prod    --tail 100 -f
docker logs cmdb-backend-prod  --tail 100 -f
docker logs cmdb-postgres-prod --tail 50  -f
docker logs cmdb-frontend-prod --tail 50  -f
```

### Connect to the Database (debugging)

```bash
docker exec -it cmdb-postgres-prod psql -U cmdb_admin -d cmdb_db
# Inside psql:
\dt                    # list tables
SELECT COUNT(*) FROM configuration_items;
\q                     # quit
```

### Restore a Backup

```bash
# List available backups
ls -lh /opt/cmdb/backups/

# Restore a specific backup
gunzip -c /opt/cmdb/backups/backup_20260315_020000.sql.gz \
  | docker exec -i cmdb-postgres-prod psql -U cmdb_admin -d cmdb_db
```

### Restart a Service Without Stopping Others

```bash
docker compose -f docker-compose.prod.yml restart nginx
docker compose -f docker-compose.prod.yml restart backend
docker compose -f docker-compose.prod.yml restart frontend
```

> **Note:** After replacing TLS certificates in `./certs/`, restart nginx (not backend) for the new certificate to take effect.

### Stop the Entire Platform (maintenance)

```bash
docker compose -f docker-compose.prod.yml down
# Data persists in volumes (postgres-data, tls-certs)
```

### Clean Up Old Images (free disk space)

```bash
docker image prune -f
docker system prune -f --volumes
```

---

## URL and Port Summary

| Service | URL / Access | Port (host) | Notes |
|---------|-------------|-------------|-------|
| Platform (UI + API) | `https://cmdb-server` | **443** | nginx TLS gateway |
| HTTP redirect | `http://cmdb-server` | **80** | Redirects to 443 |
| Backend API | Internal only | — | Routed via `/api/*` through nginx |
| Frontend | Internal only | — | Routed via `/` through nginx |
| PostgreSQL | Internal only | — | Not exposed to host |

All traffic enters through nginx. No other ports need to be open in the firewall.

---

*For support, refer to [`SECURITY_AUDIT.md`](./SECURITY_AUDIT.md) and the repository on GitHub.*
