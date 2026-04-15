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

# ─── Container runtime detection (Docker or Podman) ───────────────────────────
# Mirrors the same auto-detection used in install.sh and update.sh.

if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
  RUNTIME="docker"
elif command -v podman &>/dev/null; then
  RUNTIME="podman"
else
  log "ERROR: Neither 'docker' nor 'podman' found on PATH."
  exit 1
fi

log "Using container runtime: ${RUNTIME}"

# ─── Preflight checks ─────────────────────────────────────────────────────────

log "Starting PostgreSQL maintenance for database: ${POSTGRES_DB}"

# Check if container exists and is running
if ! ${RUNTIME} ps --format "{{.Names}}" 2>/dev/null | grep -q "^${PG_CONTAINER}$"; then
  log "ERROR: Container '${PG_CONTAINER}' not found or not running"
  log "Hint: Check with: ${RUNTIME} ps -a"
  exit 1
fi

# ─── Helper: run psql and capture exit code correctly ─────────────────────────
# Avoids the PIPESTATUS-in-subshell problem: capturing output to a temp file
# lets us check the real exit code of the container exec command.

run_psql() {
  local label="$1"
  local sql="$2"
  local tmp
  tmp="$(mktemp)"

  ${RUNTIME} exec "${PG_CONTAINER}" psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
    -c "${sql}" >"${tmp}" 2>&1
  local exit_code=$?

  while IFS= read -r line; do
    log "  [${label}] ${line}"
  done < "${tmp}"
  rm -f "${tmp}"

  return ${exit_code}
}

# ─── VACUUM ANALYZE ───────────────────────────────────────────────────────────
# Reclaims storage occupied by dead tuples and updates statistics for query planner.
# This operation does NOT lock tables (non-blocking).

log "Running VACUUM ANALYZE (non-blocking)..."
if run_psql "VACUUM" "VACUUM ANALYZE;"; then
  log "✓ VACUUM ANALYZE completed successfully"
else
  log "✗ VACUUM ANALYZE failed"
  exit 1
fi

# ─── REINDEX DATABASE ─────────────────────────────────────────────────────────
# Rebuilds all indexes to remove bloat and improve query performance.
# This operation is blocking but typically fast on databases < 50GB.
# DB name is double-quoted to handle names with special characters safely.

log "Running REINDEX DATABASE (blocking — avoid during business hours)..."
if run_psql "REINDEX" "REINDEX DATABASE \"${POSTGRES_DB}\";"; then
  log "✓ REINDEX DATABASE completed successfully"
else
  log "✗ REINDEX DATABASE failed"
  exit 1
fi

# ─── Database statistics ──────────────────────────────────────────────────────

log "Fetching database size and table statistics..."
run_psql "STATS" "
  SELECT
    pg_size_pretty(pg_database_size('${POSTGRES_DB}')) AS db_size,
    (SELECT count(*) FROM configuration_items) AS total_cis,
    (SELECT count(*) FROM audit_logs) AS total_audit_logs;
" || log "  (Stats query failed — non-fatal)"

log "Maintenance completed successfully"
log ""
log "════════════════════════════════════════════════════════════════════════════"
log "IMPORTANT NOTES:"
log "  - VACUUM ANALYZE: Non-blocking, safe to run anytime"
log "  - REINDEX DATABASE: Locks tables during execution — schedule during low traffic"
log "  - VACUUM FULL: NOT included (requires table-level locks and significant downtime)"
log "                 Only run VACUUM FULL manually during planned maintenance windows"
log "                 Example: ${RUNTIME} exec ${PG_CONTAINER} psql -U ${POSTGRES_USER} -d ${POSTGRES_DB} -c 'VACUUM FULL;'"
log "════════════════════════════════════════════════════════════════════════════"
