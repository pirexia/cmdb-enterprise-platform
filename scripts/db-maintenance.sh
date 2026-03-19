#!/bin/bash
# ══════════════════════════════════════════════════════════════════════════════
# CMDB Enterprise Platform — PostgreSQL Maintenance Script
#
# Purpose: Performs routine database optimization (VACUUM ANALYZE + REINDEX)
#          to prevent performance degradation from dead tuples (MVCC bloat).
#
# Recommended schedule: Weekly (Sundays at 03:00 AM) via crontab
# Example crontab entry (as cmdb-admin user):
#   0 3 * * 0 POSTGRES_DB=cmdb_db POSTGRES_USER=cmdb_admin PG_CONTAINER=cmdb-postgres-prod /opt/cmdb-enterprise-platform/scripts/db-maintenance.sh >> /home/cmdb-admin/db-maintenance.log 2>&1
#
# Usage:
#   POSTGRES_DB=cmdb_db POSTGRES_USER=cmdb_admin PG_CONTAINER=cmdb-postgres-prod bash scripts/db-maintenance.sh
#
# ══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ─── Configuration (read from environment variables) ──────────────────────────

PG_CONTAINER="${PG_CONTAINER:-cmdb-postgres-prod}"
POSTGRES_DB="${POSTGRES_DB:-cmdb_db}"
POSTGRES_USER="${POSTGRES_USER:-cmdb_admin}"

# ─── Logging ──────────────────────────────────────────────────────────────────

log() {
  echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"
}

# ─── Preflight checks ─────────────────────────────────────────────────────────

log "Starting PostgreSQL maintenance for database: ${POSTGRES_DB}"

# Check if container exists and is running
if ! podman ps --format "{{.Names}}" | grep -q "^${PG_CONTAINER}$"; then
  log "ERROR: Container '${PG_CONTAINER}' not found or not running"
  log "Hint: Check with: podman ps -a"
  exit 1
fi

# ─── VACUUM ANALYZE ───────────────────────────────────────────────────────────
# Reclaims storage occupied by dead tuples and updates statistics for query planner.
# This operation does NOT lock tables (non-blocking).

log "Running VACUUM ANALYZE (non-blocking)..."
podman exec "${PG_CONTAINER}" psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -c "VACUUM ANALYZE;" 2>&1 | while IFS= read -r line; do
  log "  [VACUUM] ${line}"
done

if [ "${PIPESTATUS[0]}" -eq 0 ]; then
  log "✓ VACUUM ANALYZE completed successfully"
else
  log "✗ VACUUM ANALYZE failed"
  exit 1
fi

# ─── REINDEX DATABASE ─────────────────────────────────────────────────────────
# Rebuilds all indexes to remove bloat and improve query performance.
# This operation is blocking but typically fast on databases < 50GB.

log "Running REINDEX DATABASE (blocking — avoid during business hours)..."
podman exec "${PG_CONTAINER}" psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -c "REINDEX DATABASE ${POSTGRES_DB};" 2>&1 | while IFS= read -r line; do
  log "  [REINDEX] ${line}"
done

if [ "${PIPESTATUS[0]}" -eq 0 ]; then
  log "✓ REINDEX DATABASE completed successfully"
else
  log "✗ REINDEX DATABASE failed"
  exit 1
fi

# ─── Database statistics ──────────────────────────────────────────────────────

log "Fetching database size and table statistics..."
podman exec "${PG_CONTAINER}" psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -c "
  SELECT
    pg_size_pretty(pg_database_size('${POSTGRES_DB}')) AS db_size,
    (SELECT count(*) FROM configuration_items) AS total_cis,
    (SELECT count(*) FROM audit_logs) AS total_audit_logs;
" 2>&1 | while IFS= read -r line; do
  log "  [STATS] ${line}"
done

log "Maintenance completed successfully"
log ""
log "════════════════════════════════════════════════════════════════════════════"
log "IMPORTANT NOTES:"
log "  - VACUUM ANALYZE: Non-blocking, safe to run anytime"
log "  - REINDEX DATABASE: Locks tables during execution — schedule during low traffic"
log "  - VACUUM FULL: NOT included (requires table-level locks and significant downtime)"
log "                 Only run VACUUM FULL manually during planned maintenance windows"
log "                 Example: podman exec ${PG_CONTAINER} psql -U ${POSTGRES_USER} -d ${POSTGRES_DB} -c 'VACUUM FULL;'"
log "════════════════════════════════════════════════════════════════════════════"
