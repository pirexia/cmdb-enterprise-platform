#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/db-backup.sh
#
# Automated PostgreSQL backup for CMDB Enterprise Platform.
# Connects to the running cmdb-postgres container and runs pg_dump.
# Output: compressed SQL dump in BACKUP_DIR, named backup_YYYYMMDD_HHMMSS.sql.gz
#
# Usage:
#   bash scripts/db-backup.sh
#
# Crontab example (daily at 02:00 AM):
#   0 2 * * * /opt/cmdb/scripts/db-backup.sh >> /var/log/cmdb-backup.log 2>&1
#
# Requirements:
#   - Docker / Podman accessible on this host
#   - The postgres container must be running (docker ps shows cmdb-postgres-prod)
#
# Environment variables (with defaults):
#   BACKUP_DIR          Directory to store backups  (default: /opt/cmdb/backups)
#   PG_CONTAINER        Container name              (default: cmdb-postgres-prod)
#   POSTGRES_DB         Database name               (default: cmdb_db)
#   POSTGRES_USER       Database user               (default: admin)
#   RETENTION_DAYS      Days to keep old backups    (default: 30)
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Config (override via environment or edit defaults below) ──────────────────
BACKUP_DIR="${BACKUP_DIR:-/opt/cmdb/backups}"
PG_CONTAINER="${PG_CONTAINER:-cmdb-postgres-prod}"
POSTGRES_DB="${POSTGRES_DB:-cmdb_db}"
POSTGRES_USER="${POSTGRES_USER:-admin}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

# ── Derived values ────────────────────────────────────────────────────────────
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_FILE="${BACKUP_DIR}/backup_${TIMESTAMP}.sql.gz"
LOG_PREFIX="[CMDB Backup $(date '+%Y-%m-%d %H:%M:%S')]"

# ── Ensure backup directory exists ───────────────────────────────────────────
mkdir -p "${BACKUP_DIR}"

echo "${LOG_PREFIX} Starting pg_dump of '${POSTGRES_DB}' from container '${PG_CONTAINER}'…"

# ── Detect container runtime (docker or podman) ───────────────────────────────
if command -v docker &>/dev/null; then
  RUNTIME="docker"
elif command -v podman &>/dev/null; then
  RUNTIME="podman"
else
  echo "${LOG_PREFIX} ERROR: Neither 'docker' nor 'podman' found on PATH." >&2
  exit 1
fi

# ── Check container is running ────────────────────────────────────────────────
if ! ${RUNTIME} ps --format '{{.Names}}' 2>/dev/null | grep -q "^${PG_CONTAINER}$"; then
  echo "${LOG_PREFIX} ERROR: Container '${PG_CONTAINER}' is not running." >&2
  echo "${LOG_PREFIX} Run: ${RUNTIME} ps -a | grep postgres" >&2
  exit 1
fi

# ── Run pg_dump ───────────────────────────────────────────────────────────────
${RUNTIME} exec "${PG_CONTAINER}" \
  pg_dump -U "${POSTGRES_USER}" "${POSTGRES_DB}" \
  | gzip -9 > "${BACKUP_FILE}"

BACKUP_SIZE="$(du -sh "${BACKUP_FILE}" | cut -f1)"
echo "${LOG_PREFIX} ✅ Backup created: ${BACKUP_FILE} (${BACKUP_SIZE})"

# ── Rotate old backups ────────────────────────────────────────────────────────
echo "${LOG_PREFIX} Rotating backups older than ${RETENTION_DAYS} days…"
DELETED_COUNT=0
while IFS= read -r old_file; do
  rm -f "${old_file}"
  echo "${LOG_PREFIX}   Deleted: ${old_file}"
  DELETED_COUNT=$((DELETED_COUNT + 1))
done < <(find "${BACKUP_DIR}" -name "backup_*.sql.gz" -mtime "+${RETENTION_DAYS}" 2>/dev/null)

if [ "${DELETED_COUNT}" -eq 0 ]; then
  echo "${LOG_PREFIX} No old backups to rotate."
else
  echo "${LOG_PREFIX} Rotated ${DELETED_COUNT} old backup(s)."
fi

# ── Summary ───────────────────────────────────────────────────────────────────
TOTAL_BACKUPS="$(find "${BACKUP_DIR}" -name "backup_*.sql.gz" 2>/dev/null | wc -l | tr -d ' ')"
TOTAL_SIZE="$(du -sh "${BACKUP_DIR}" 2>/dev/null | cut -f1)"
echo "${LOG_PREFIX} Backup directory: ${BACKUP_DIR} | Files: ${TOTAL_BACKUPS} | Total size: ${TOTAL_SIZE}"
echo "${LOG_PREFIX} Done."
