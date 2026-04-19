#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/docs-backup.sh
#
# Backup for CMDB Enterprise Platform document storage (DOCUMENTS_STORAGE_PATH).
# Creates a compressed tar archive of all uploaded documents.
#
# Usage:
#   bash scripts/docs-backup.sh
#
# Crontab example (daily at 02:30 AM, 30 min after db-backup.sh):
#   30 2 * * * /opt/cmdb/scripts/docs-backup.sh >> /var/log/cmdb-backup.log 2>&1
#
# Environment variables (with defaults):
#   DOCS_SOURCE_DIR     Directory to backup  (default: /opt/cmdb/documents)
#   BACKUP_DIR          Output directory      (default: /opt/cmdb/backups)
#   RETENTION_DAYS      Days to keep backups  (default: 30)
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

DOCS_SOURCE_DIR="${DOCS_SOURCE_DIR:-/opt/cmdb/documents}"
BACKUP_DIR="${BACKUP_DIR:-/opt/cmdb/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_FILE="${BACKUP_DIR}/docs_${TIMESTAMP}.tar.gz"
LOG_PREFIX="[CMDB Docs Backup $(date '+%Y-%m-%d %H:%M:%S')]"

mkdir -p "${BACKUP_DIR}"

if [ ! -d "${DOCS_SOURCE_DIR}" ]; then
  echo "${LOG_PREFIX} WARNING: DOCS_SOURCE_DIR '${DOCS_SOURCE_DIR}' does not exist. Skipping." >&2
  exit 0
fi

echo "${LOG_PREFIX} Starting backup of '${DOCS_SOURCE_DIR}'…"

tar -czf "${BACKUP_FILE}" -C "$(dirname "${DOCS_SOURCE_DIR}")" "$(basename "${DOCS_SOURCE_DIR}")"

BACKUP_SIZE="$(du -sh "${BACKUP_FILE}" | cut -f1)"
echo "${LOG_PREFIX} ✅ Backup created: ${BACKUP_FILE} (${BACKUP_SIZE})"

# ── Verify integrity ──────────────────────────────────────────────────────────
echo "${LOG_PREFIX} Verifying backup integrity…"
if ! tar -tzf "${BACKUP_FILE}" > /dev/null 2>&1; then
  echo "${LOG_PREFIX} ❌ INTEGRITY CHECK FAILED: ${BACKUP_FILE} is corrupt." >&2
  rm -f "${BACKUP_FILE}"
  exit 1
fi
echo "${LOG_PREFIX} ✅ Integrity check passed."

# ── Rotate old backups ────────────────────────────────────────────────────────
echo "${LOG_PREFIX} Rotating backups older than ${RETENTION_DAYS} days…"
DELETED_COUNT=0
while IFS= read -r old_file; do
  rm -f "${old_file}"
  echo "${LOG_PREFIX}   Deleted: ${old_file}"
  DELETED_COUNT=$((DELETED_COUNT + 1))
done < <(find "${BACKUP_DIR}" -name "docs_*.tar.gz" -mtime "+${RETENTION_DAYS}" 2>/dev/null)

if [ "${DELETED_COUNT}" -eq 0 ]; then
  echo "${LOG_PREFIX} No old doc backups to rotate."
else
  echo "${LOG_PREFIX} Rotated ${DELETED_COUNT} old doc backup(s)."
fi

TOTAL_BACKUPS="$(find "${BACKUP_DIR}" -name "docs_*.tar.gz" 2>/dev/null | wc -l | tr -d ' ')"
echo "${LOG_PREFIX} Done. Total doc backups: ${TOTAL_BACKUPS}"
