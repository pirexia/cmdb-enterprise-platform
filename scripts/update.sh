#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/update.sh — CMDB Enterprise Platform automated updater
#
# Usage: bash scripts/update.sh [--yes] [--no-cache] [--force] [--dry-run]
#   --yes        Auto-confirm all prompts (unattended mode)
#   --no-cache   Force full Docker rebuild (slower but clean)
#   --force      Skip downgrade guard (recovery use only)
#   --dry-run    Show what would happen without doing it
#
# What it does:
#   1. Guards against downgrade (refuses to go to an older commit)
#   2. Always backs up PostgreSQL before any change
#   3. Shows a changelog since the current version
#   4. Detects if Prisma migrations will run
#   5. Builds new images and redeploys
#   6. Verifies health post-deploy
#   7. Rolls back automatically on failure
#
# Exit codes:
#   0  — Update succeeded (or already up to date, or dry-run completed)
#   1  — Update failed (rollback was performed if possible)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Colour helpers ────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }
step()    { echo -e "\n${BOLD}${CYAN}── $* ──${NC}"; }

# ── Configuration ─────────────────────────────────────────────────────────────
INSTALL_DIR="${CMDB_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
COMPOSE_FILE="${INSTALL_DIR}/docker-compose.prod.yml"
LOG_DIR="${INSTALL_DIR}/logs"
LOG_FILE="${LOG_DIR}/update_$(date +%Y%m%d_%H%M%S).log"

# Globals set during execution — exported so rollback() can access them
BACKUP_FILE=""
ROLLBACK_TAG=""
RUNTIME=""
COMPOSE_CMD=""
COMPOSE_CMD_ARRAY=()
AUTO_YES=false
NO_CACHE=false
FORCE=false
DRY_RUN=false
REINDEX_FLAG=false
RAG_PRESENT=false

# ── ERR trap — catches unexpected failures not handled by explicit rollback ───
trap 'err_handler $LINENO' ERR

err_handler() {
  local lineno="${1:-?}"
  error "Unexpected error at line ${lineno} of $(basename "$0")."
  error "Check the full log for details: ${LOG_FILE}"
  if [ -n "${ROLLBACK_TAG}" ]; then
    warn "Attempting automatic rollback to ${ROLLBACK_TAG}..."
    rollback "Unexpected error at line ${lineno}" || true
  fi
  exit 1
}

# ── Runtime detection ─────────────────────────────────────────────────────────
detect_runtime() {
  step "Detecting container runtime"

  if command -v docker &>/dev/null; then
    RUNTIME="docker"
    # Prefer the Compose V2 plugin; fall back to the legacy standalone binary
    if docker compose version &>/dev/null 2>&1; then
      COMPOSE_CMD="docker compose"
      COMPOSE_CMD_ARRAY=(docker compose)
    elif command -v docker-compose &>/dev/null; then
      COMPOSE_CMD="docker-compose"
      COMPOSE_CMD_ARRAY=(docker-compose)
    else
      error "Docker found but neither 'docker compose' plugin nor 'docker-compose' binary is available."
      exit 1
    fi
  elif command -v podman &>/dev/null; then
    RUNTIME="podman"
    if command -v podman-compose &>/dev/null; then
      COMPOSE_CMD="podman-compose"
      COMPOSE_CMD_ARRAY=(podman-compose)
    else
      error "Podman found but 'podman-compose' is not available. Install it first."
      exit 1
    fi
  else
    error "Neither 'docker' nor 'podman' found on PATH. Cannot continue."
    exit 1
  fi

  success "Runtime: ${RUNTIME} | Compose: ${COMPOSE_CMD}"
}

# ── Step 1: Version guard ─────────────────────────────────────────────────────
version_guard() {
  step "Version check"

  # Verify we are inside a git repository
  if ! git -C "${INSTALL_DIR}" rev-parse --git-dir &>/dev/null; then
    error "The installation directory '${INSTALL_DIR}' is not a git repository."
    error "Automated updates require the platform to be deployed via git clone."
    exit 1
  fi

  local current_commit remote_commit current_short
  current_commit=$(git -C "${INSTALL_DIR}" rev-parse HEAD)
  current_short=$(git -C "${INSTALL_DIR}" describe --tags --always --abbrev=7 2>/dev/null \
                    || git -C "${INSTALL_DIR}" rev-parse --short HEAD)

  info "Current version: ${current_short} (${current_commit})"
  info "Fetching latest refs from origin/main..."

  git -C "${INSTALL_DIR}" fetch origin main --quiet

  remote_commit=$(git -C "${INSTALL_DIR}" rev-parse origin/main)

  # Already up to date?
  if [ "${current_commit}" = "${remote_commit}" ]; then
    success "Already up to date (${current_short}). Nothing to do."
    exit 0
  fi

  # Downgrade guard: is the current commit an ancestor of the remote?
  # If it is NOT an ancestor, remote is behind (or on a diverged branch) → downgrade.
  if ! git -C "${INSTALL_DIR}" merge-base --is-ancestor "${current_commit}" "${remote_commit}" 2>/dev/null; then
    if [ "${FORCE}" = "true" ]; then
      warn "--force passed: skipping downgrade guard. Data integrity is your responsibility."
    else
      error "Remote branch is BEHIND the installed version — this would be a downgrade."
      error "  Installed : ${current_commit}"
      error "  Remote    : ${remote_commit}"
      error "Use --force to override (dangerous; may lose data or break the schema)."
      exit 1
    fi
  fi

  # Show changelog
  step "Changes since last update"
  git -C "${INSTALL_DIR}" log --oneline "${current_commit}..origin/main" | head -30
  local commit_count
  commit_count=$(git -C "${INSTALL_DIR}" rev-list --count "${current_commit}..origin/main")
  if [ "${commit_count}" -gt 30 ]; then
    warn "(showing 30 of ${commit_count} commits)"
  fi
  echo ""
}

# ── Step 2: Pre-update database backup ───────────────────────────────────────
pre_update_backup() {
  step "Pre-update database backup"

  # Source .env so the backup script inherits PG_CONTAINER / POSTGRES_DB / POSTGRES_USER
  set -a
  [ -f "${INSTALL_DIR}/.env" ] && source "${INSTALL_DIR}/.env"
  set +a

  local backup_script="${INSTALL_DIR}/scripts/db-backup.sh"
  if [ ! -f "${backup_script}" ]; then
    error "Backup script not found at '${backup_script}'. Cannot proceed without a backup."
    exit 1
  fi

  # db-backup.sh writes the path in a line like:
  #   [CMDB Backup ...] ✅ Backup created: /opt/cmdb/backups/backup_....sql.gz (4.2M)
  # We capture all output and parse the path.
  local backup_output
  if ! backup_output=$(bash "${backup_script}" 2>&1); then
    error "Backup script exited with a non-zero status."
    echo "${backup_output}" >&2
    exit 1
  fi

  # Echo the backup output so it appears in the log
  echo "${backup_output}"

  # Extract the .sql.gz path — handles both plain and emoji-prefixed lines
  BACKUP_FILE=$(echo "${backup_output}" \
    | grep -E "Backup created:" \
    | grep -oE '/[^ ]+\.sql\.gz' \
    | head -1)

  if [ -z "${BACKUP_FILE}" ]; then
    error "Could not parse backup file path from db-backup.sh output."
    error "Raw output shown above. Refusing to continue without a confirmed backup."
    exit 1
  fi

  if [ ! -f "${BACKUP_FILE}" ]; then
    error "Backup file '${BACKUP_FILE}' does not exist on disk after the backup script ran."
    exit 1
  fi

  success "Database backed up to: ${BACKUP_FILE}"
  export BACKUP_FILE
}

# ── Step 3: Tag current HEAD as rollback point ────────────────────────────────
tag_rollback() {
  step "Tagging rollback point"

  local tag="rollback/$(date +%Y%m%d_%H%M%S)"

  if [ "${DRY_RUN}" = "true" ]; then
    info "[DRY RUN] Would create git tag: ${tag}"
    # Do NOT set ROLLBACK_TAG — the tag is never actually created in dry-run,
    # so setting it would cause the err_handler to attempt a failing checkout.
    return 0
  fi

  git -C "${INSTALL_DIR}" tag "${tag}" HEAD
  ROLLBACK_TAG="${tag}"
  export ROLLBACK_TAG

  success "Rollback point tagged: ${tag}"
}

# ── Step 4: Pull latest code and detect migrations ────────────────────────────
pull_and_detect() {
  step "Pulling latest code"

  if [ "${DRY_RUN}" = "true" ]; then
    info "[DRY RUN] Would run: git -C ${INSTALL_DIR} pull --ff-only origin main"
    info "[DRY RUN] Would check backend/prisma/migrations/ for new files."
    return 0
  fi

  git -C "${INSTALL_DIR}" pull --ff-only origin main
  success "Code updated to $(git -C "${INSTALL_DIR}" describe --tags --always --abbrev=7 2>/dev/null \
             || git -C "${INSTALL_DIR}" rev-parse --short HEAD)"

  # Detect new migration files between the previous HEAD (ORIG_HEAD) and the new HEAD
  local migration_count=0
  if git -C "${INSTALL_DIR}" rev-parse ORIG_HEAD &>/dev/null; then
    migration_count=$(
      git -C "${INSTALL_DIR}" diff ORIG_HEAD..HEAD \
        --name-only -- backend/prisma/migrations/ 2>/dev/null \
      | grep -c "backend/prisma/migrations/" || true
    )
  fi

  if [ "${migration_count}" -gt 0 ]; then
    warn "${migration_count} new Prisma migration file(s) detected."
    warn "Database schema will be updated automatically when containers start."
    warn "Pre-update backup is available at: ${BACKUP_FILE}"
    echo ""
    # Show which migration files are new
    git -C "${INSTALL_DIR}" diff ORIG_HEAD..HEAD --name-only -- backend/prisma/migrations/ 2>/dev/null \
      | sed 's/^/  + /' || true
    echo ""
    if [ "${AUTO_YES}" != "true" ]; then
      read -r -p "Continue with schema migration? [Y/n] " confirm
      if ! [[ "${confirm:-Y}" =~ ^[Yy]$ ]]; then
        error "Update cancelled by user at migration prompt."
        # Reset the pull so the system is back at the tagged rollback point
        git -C "${INSTALL_DIR}" checkout "${ROLLBACK_TAG}" --quiet
        exit 1
      fi
    fi
  else
    info "No Prisma migration changes detected in this update."
  fi
}

# ── Step 5: Build new images ──────────────────────────────────────────────────
build_images() {
  step "Building new images"

  local -a build_args=()
  [ "${NO_CACHE}" = "true" ] && build_args+=("--no-cache")

  # Pass current git commit so version.json (T9) embeds the right hash.
  local git_commit
  git_commit=$(git -C "${INSTALL_DIR}" rev-parse --short HEAD 2>/dev/null || echo "unknown")
  build_args+=("--build-arg" "GIT_COMMIT=${git_commit}")

  if [ "${DRY_RUN}" = "true" ]; then
    info "[DRY RUN] Would run: ${COMPOSE_CMD} -f ${COMPOSE_FILE} build${build_args[*]:+ ${build_args[*]}}"
    return 0
  fi

  "${COMPOSE_CMD_ARRAY[@]}" -f "${COMPOSE_FILE}" build "${build_args[@]}"
  success "Images built successfully."
}

# ── Step 6: Deploy and health-check ──────────────────────────────────────────
deploy() {
  step "Deploying new version"

  if [ "${DRY_RUN}" = "true" ]; then
    info "[DRY RUN] Would run: ${COMPOSE_CMD} -f ${COMPOSE_FILE} up -d"
    info "[DRY RUN] Would poll /api/health until backend responds."
    return 0
  fi

  "${COMPOSE_CMD_ARRAY[@]}" -f "${COMPOSE_FILE}" up -d
  success "Containers started."

  # nginx caches the upstream backend IP; restart it after backend recreation
  # so requests are not routed to a stale container address (502/504 prevention).
  info "Restarting nginx to refresh upstream backend IP…"
  "${COMPOSE_CMD_ARRAY[@]}" -f "${COMPOSE_FILE}" restart nginx 2>/dev/null || true

  # Health check — goes through nginx (same public URL as the frontend).
  # FRONTEND_URL is sourced from .env by pre_update_backup(); default to https://localhost.
  local health_base="${FRONTEND_URL:-https://localhost}"
  local health_url="${health_base}/api/health"

  info "Waiting for backend health check at ${health_url}"
  echo -n "  "

  local i=0
  local max=120   # 120 seconds total (60 × 2 s)
  while [ "${i}" -lt "${max}" ]; do
    if curl -sk "${health_url}" 2>/dev/null | grep -q '"ok"'; then
      echo ""
      success "Backend is healthy at ${health_url}"
      return 0
    fi
    echo -n "."
    sleep 2
    i=$((i + 2))
  done

  echo ""
  error "Backend health check timed out after ${max} seconds."
  error "Container logs:"
  "${COMPOSE_CMD_ARRAY[@]}" -f "${COMPOSE_FILE}" logs --tail=40 backend 2>/dev/null || true
  return 1
}

# ── Step 7: Automatic rollback ────────────────────────────────────────────────
rollback() {
  local reason="${1:-unknown reason}"

  # In dry-run mode no real state was changed and no rollback tag was created,
  # so attempting a git checkout would fail with 'reference is not a tree'.
  if [ "${DRY_RUN}" = "true" ]; then
    warn "[DRY RUN] Skipping rollback — no real state was modified."
    return 0
  fi

  error ""
  error "╔══════════════════════════════════════════╗"
  error "║           ROLLBACK TRIGGERED             ║"
  error "╚══════════════════════════════════════════╝"
  error "Reason   : ${reason}"
  warn  "Target   : ${ROLLBACK_TAG}"

  # Restore the previous code
  git -C "${INSTALL_DIR}" checkout "${ROLLBACK_TAG}" --quiet

  # Rebuild and restart from the previous state
  # Use --quiet to keep noise low; errors here are secondary
  "${COMPOSE_CMD_ARRAY[@]}" -f "${COMPOSE_FILE}" build --quiet 2>/dev/null || \
    warn "Rebuild during rollback produced warnings — check container state manually."

  "${COMPOSE_CMD_ARRAY[@]}" -f "${COMPOSE_FILE}" up -d 2>/dev/null || \
    warn "Could not restart containers during rollback — manual intervention required."

  error ""
  error "Rollback complete. System is running the previous version."
  error ""
  error "Database backup : ${BACKUP_FILE:-not available}"
  error ""
  error "To restore the database manually if needed:"
  error "  zcat \"${BACKUP_FILE:-<backup.sql.gz>}\" | \\"
  error "    ${RUNTIME} exec -i cmdb-postgres-prod \\"
  error "    psql -U \"\${POSTGRES_USER}\" \"\${POSTGRES_DB}\""
  error ""
  error "Update log : ${LOG_FILE}"
  return 1
}

# ── Step 7b: Migrate certs from legacy ./backend/certs/ to ./certs/ ──────────
migrate_certs() {
  local old_dir="${INSTALL_DIR}/backend/certs"
  local new_dir="${INSTALL_DIR}/certs"

  # Nothing to do if the old directory doesn't exist or is empty
  if [ ! -d "${old_dir}" ]; then
    return 0
  fi
  if [ -z "$(ls -A "${old_dir}" 2>/dev/null | grep -v '\.gitkeep')" ]; then
    return 0
  fi

  # Only migrate if the new directory is empty (non-destructive)
  if [ -n "$(ls -A "${new_dir}" 2>/dev/null | grep -v '\.gitkeep')" ]; then
    info "Cert migration skipped — ${new_dir}/ already has files."
    return 0
  fi

  step "Migrating TLS certificates to project root"
  info "Moving certs from ${old_dir}/ → ${new_dir}/"

  if [ "${DRY_RUN}" = "true" ]; then
    info "[DRY RUN] Would copy: ${old_dir}/server.{crt,key} → ${new_dir}/"
    return 0
  fi

  mkdir -p "${new_dir}"
  for f in server.crt server.key; do
    if [ -f "${old_dir}/${f}" ]; then
      cp "${old_dir}/${f}" "${new_dir}/${f}"
      info "  Copied ${f}"
    fi
  done
  chmod 600 "${new_dir}/server.key" 2>/dev/null || true
  chmod 644 "${new_dir}/server.crt" 2>/dev/null || true

  # Re-populate the named Docker volume so nginx picks up the certs
  if [ -f "${new_dir}/server.crt" ] && [ -f "${new_dir}/server.key" ]; then
    info "Refreshing named volume cmdb-tls-certs from ${new_dir}/"
    "${RUNTIME}" volume create cmdb-tls-certs 2>/dev/null || true
    "${RUNTIME}" run --rm \
      -v cmdb-tls-certs:/dst \
      -v "${new_dir}":/src:ro \
      alpine sh -c "cp /src/server.key /src/server.crt /dst/ && chmod 600 /dst/server.key" 2>/dev/null || true
    success "TLS volume updated."
  fi

  success "Certificates migrated to ${new_dir}/"
  warn "The files in ${old_dir}/ were NOT removed. You may delete them manually."
}

# ── Step 8: Warn about new env vars missing from existing .env ────────────────
check_new_env_vars() {
  step "Checking .env for new variables"

  local env_file="${INSTALL_DIR}/.env"
  if [ ! -f "${env_file}" ]; then
    warn ".env not found at ${env_file} — skipping new-variable check."
    return 0
  fi

  # List of variables introduced in v1.7.0 that older installs won't have
  local -a NEW_VARS=(
    "USE_MICROSOFT_SSO"
    "AZURE_TENANT_ID"
    "AZURE_CLIENT_ID"
    "AZURE_CLIENT_SECRET"
    "AZURE_REDIRECT_URI"
    "AZURE_ALLOWED_DOMAIN"
    "FRONTEND_URL"
    "AZURE_AUTO_PROVISION"
    "LDAP_TLS_REJECT_UNAUTHORIZED"
  )

  local missing=()
  for var in "${NEW_VARS[@]}"; do
    if ! grep -q "^${var}=" "${env_file}" 2>/dev/null; then
      missing+=("${var}")
    fi
  done

  if [ ${#missing[@]} -eq 0 ]; then
    success "All known env vars are present in .env"
    return 0
  fi

  warn "The following new variables are not in your .env (added defaults where possible):"
  for var in "${missing[@]}"; do
    warn "  • ${var}"
  done

  if [ "${DRY_RUN}" = "true" ]; then
    info "[DRY RUN] Would append the above variables with safe defaults to ${env_file}"
    return 0
  fi

  # Append missing vars with safe defaults
  {
    echo ""
    echo "# ── Added automatically by update.sh ($(date '+%Y-%m-%d')) ──────────────────"
    for var in "${missing[@]}"; do
      case "${var}" in
        USE_MICROSOFT_SSO)         echo "USE_MICROSOFT_SSO=false" ;;
        AZURE_TENANT_ID)           echo "AZURE_TENANT_ID=" ;;
        AZURE_CLIENT_ID)           echo "AZURE_CLIENT_ID=" ;;
        AZURE_CLIENT_SECRET)       echo "AZURE_CLIENT_SECRET=" ;;
        AZURE_REDIRECT_URI)        echo "AZURE_REDIRECT_URI=" ;;
        AZURE_ALLOWED_DOMAIN)      echo "AZURE_ALLOWED_DOMAIN=" ;;
        FRONTEND_URL)              echo "FRONTEND_URL=http://localhost:3001" ;;
        AZURE_AUTO_PROVISION)      echo "AZURE_AUTO_PROVISION=false" ;;
        LDAP_TLS_REJECT_UNAUTHORIZED) echo "LDAP_TLS_REJECT_UNAUTHORIZED=1" ;;
      esac
    done
  } >> "${env_file}"

  warn "Defaults appended to ${env_file}."
  warn "Review and update Microsoft 365 SSO values if you want to enable SSO."
  warn "See Section 15 of the Sysadmin Manual for Azure Portal configuration steps."
}

# ── Step 9: Ensure Ollama models are present (RAG only) ──────────────────────
ensure_ollama_models() {
  if [[ "${RAG_PRESENT}" != "true" ]]; then
    return 0
  fi

  step "Checking Ollama models"

  if [ "${DRY_RUN}" = "true" ]; then
    info "[DRY RUN] Would verify Ollama embedding and chat models are pulled."
    return 0
  fi

  local embed_model
  local chat_model
  embed_model=$(grep -E '^RAG_EMBED_MODEL=' "${INSTALL_DIR}/.env" | cut -d= -f2 | tr -d '"')
  chat_model=$(grep -E '^RAG_CHAT_MODEL=' "${INSTALL_DIR}/.env" | cut -d= -f2 | tr -d '"')

  if [ -z "${embed_model}" ] || [ -z "${chat_model}" ]; then
    warn "RAG_EMBED_MODEL or RAG_CHAT_MODEL not set in .env — skipping model check."
    return 0
  fi

  # Wait for ollama container to become healthy (max 60s)
  info "Waiting for Ollama (max 60s)..."
  local elapsed=0
  until ${RUNTIME} exec cmdb-ollama curl -fs http://localhost:11434/api/version &>/dev/null; do
    sleep 3; elapsed=$((elapsed + 3))
    if [[ ${elapsed} -ge 60 ]]; then
      warn "Ollama did not become healthy after 60s — skipping model check"
      return 0
    fi
  done

  # Check which models are currently installed
  local installed_models
  installed_models=$(${RUNTIME} exec cmdb-ollama ollama list 2>/dev/null | awk 'NR>1 {print $1}' || true)

  if ! echo "${installed_models}" | grep -qF "${embed_model}"; then
    info "Pulling embedding model: ${embed_model}"
    ${RUNTIME} exec cmdb-ollama ollama pull "${embed_model}"
  else
    success "Embedding model already present: ${embed_model}"
  fi

  if ! echo "${installed_models}" | grep -qF "${chat_model}"; then
    info "Pulling chat model: ${chat_model}"
    ${RUNTIME} exec cmdb-ollama ollama pull "${chat_model}"
  else
    success "Chat model already present: ${chat_model}"
  fi
}

# ── Step 10: Re-index all documents (--reindex flag, RAG only) ────────────────
reindex_documents() {
  if [[ "${REINDEX_FLAG}" != "true" ]] || [[ "${RAG_PRESENT}" != "true" ]]; then
    return 0
  fi

  step "Re-indexing all documents (--reindex flag set)"
  warn "This is a heavy operation; it will take ~30s per document."

  if [ "${DRY_RUN}" = "true" ]; then
    info "[DRY RUN] Would mark all rag_document_index entries as PENDING."
    info "[DRY RUN] Would insert PENDING entries for documents not yet indexed."
    return 0
  fi

  local db_user="${POSTGRES_USER:-admin}"
  local db_name="${POSTGRES_DB:-cmdb_db}"

  # Mark existing index entries as PENDING so the cron worker re-processes them
  ${RUNTIME} exec cmdb-postgres psql -U "${db_user}" -d "${db_name}" -c \
    "UPDATE rag_document_index SET status='PENDING', updated_at=now();"

  # Insert PENDING entries for latest document versions not yet indexed
  ${RUNTIME} exec cmdb-postgres psql -U "${db_user}" -d "${db_name}" -c \
    "INSERT INTO rag_document_index(id, document_id, version_number, status)
       SELECT gen_random_uuid(), d.id, d.version_number, 'PENDING'
       FROM documents d
       LEFT JOIN rag_document_index r ON r.document_id = d.id AND r.version_number = d.version_number
       WHERE d.is_latest = true AND r.id IS NULL;"

  success "All documents queued for re-indexing — the cron worker will process them."
}

# ── Step 10b: Re-index structured entities (--reindex flag, RAG v2 only) ──────
# CIs / contract roots / license roots / vulnerabilities. Vulnerabilities are
# enumerated as the JSON entries of configuration_items.vulnerabilities; the
# rag_entity_index UPSERT for vulns is done from the backend's
# /api/admin/rag/backfill endpoint because it needs the uuid_v5 derivation
# which lives in TypeScript — we trigger that endpoint here once the deploy
# is healthy. CIs / contracts / licenses can be queued via plain SQL.
reindex_entities() {
  if [[ "${REINDEX_FLAG}" != "true" ]] || [[ "${RAG_PRESENT}" != "true" ]]; then
    return 0
  fi

  step "Re-indexing structured entities (CIs, contracts, licenses, vulnerabilities)"
  warn "Vulnerabilities are enqueued via /api/admin/rag/backfill (needs admin token)."

  if [ "${DRY_RUN}" = "true" ]; then
    info "[DRY RUN] Would mark rag_entity_index rows as PENDING and enqueue missing CIs/contract-roots/license-roots."
    info "[DRY RUN] Would invoke POST /api/admin/rag/backfill with entityTypes=['vulnerability']."
    return 0
  fi

  local db_user="${POSTGRES_USER:-admin}"
  local db_name="${POSTGRES_DB:-cmdb_db}"

  # Mark every existing entity_index row as PENDING (skipping any actively INDEXING).
  ${RUNTIME} exec cmdb-postgres psql -U "${db_user}" -d "${db_name}" -c \
    "UPDATE rag_entity_index SET status='PENDING', updated_at=now() WHERE status != 'INDEXING';"

  # Enqueue every CI that has no entity_index row yet.
  ${RUNTIME} exec cmdb-postgres psql -U "${db_user}" -d "${db_name}" -c \
    "INSERT INTO rag_entity_index(id, entity_type, entity_id, status, created_at, updated_at)
       SELECT gen_random_uuid(), 'ci', c.id, 'PENDING', now(), now()
       FROM configuration_items c
       LEFT JOIN rag_entity_index r ON r.entity_type='ci' AND r.entity_id=c.id
       WHERE r.id IS NULL
     ON CONFLICT (entity_type, entity_id) DO NOTHING;"

  # Enqueue every contract ROOT (parent_contract_id IS NULL) that has no row yet.
  ${RUNTIME} exec cmdb-postgres psql -U "${db_user}" -d "${db_name}" -c \
    "INSERT INTO rag_entity_index(id, entity_type, entity_id, status, created_at, updated_at)
       SELECT gen_random_uuid(), 'contract', c.id, 'PENDING', now(), now()
       FROM contracts c
       LEFT JOIN rag_entity_index r ON r.entity_type='contract' AND r.entity_id=c.id
       WHERE c.parent_contract_id IS NULL AND r.id IS NULL
     ON CONFLICT (entity_type, entity_id) DO NOTHING;"

  # Same for license roots.
  ${RUNTIME} exec cmdb-postgres psql -U "${db_user}" -d "${db_name}" -c \
    "INSERT INTO rag_entity_index(id, entity_type, entity_id, status, created_at, updated_at)
       SELECT gen_random_uuid(), 'license', l.id, 'PENDING', now(), now()
       FROM licenses l
       LEFT JOIN rag_entity_index r ON r.entity_type='license' AND r.entity_id=l.id
       WHERE l.parent_license_id IS NULL AND r.id IS NULL
     ON CONFLICT (entity_type, entity_id) DO NOTHING;"

  # Vulnerabilities — invoke the backend endpoint so uuid_v5 is computed in TS.
  # We use the seed admin if RAG_BACKFILL_TOKEN is provided in env, otherwise
  # skip with a guidance message (the operator can run it later from the UI).
  if [ -n "${RAG_BACKFILL_TOKEN:-}" ]; then
    local health_base="${FRONTEND_URL:-https://localhost}"
    info "POST ${health_base}/api/admin/rag/backfill (entityTypes=['vulnerability'])"
    curl -sk -X POST "${health_base}/api/admin/rag/backfill" \
      -H "Authorization: Bearer ${RAG_BACKFILL_TOKEN}" \
      -H 'Content-Type: application/json' \
      -d '{"entityTypes":["vulnerability"]}' \
      | sed 's/^/  /'
    echo ""
  else
    warn "RAG_BACKFILL_TOKEN not set in environment — vulnerabilities will NOT be re-indexed automatically."
    warn "Run manually after login as an ADMIN user:"
    warn "  TOKEN=\$(curl -sk -X POST ${FRONTEND_URL:-https://localhost}/api/auth/login -H 'Content-Type: application/json' -d '{\"email\":\"...\",\"password\":\"...\"}' | jq -r .token)"
    warn "  curl -sk -X POST ${FRONTEND_URL:-https://localhost}/api/admin/rag/backfill -H \"Authorization: Bearer \$TOKEN\" -H 'Content-Type: application/json' -d '{\"entityTypes\":[\"vulnerability\"]}'"
  fi

  success "Entities queued for re-indexing — the cron worker will process them (3-slot priority budget per tick)."
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
  # Parse flags
  for arg in "$@"; do
    case "${arg}" in
      --yes)      AUTO_YES=true     ;;
      --no-cache) NO_CACHE=true     ;;
      --force)    FORCE=true        ;;
      --dry-run)  DRY_RUN=true      ;;
      --reindex)  REINDEX_FLAG=true ;;
      *)
        error "Unknown flag: ${arg}"
        echo "Usage: bash scripts/update.sh [--yes] [--no-cache] [--force] [--dry-run] [--reindex]" >&2
        exit 1
        ;;
    esac
  done

  # Ensure log directory exists and tee all output to the log file
  mkdir -p "${LOG_DIR}"
  exec > >(tee -a "${LOG_FILE}") 2>&1

  echo ""
  echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}${CYAN}║  CMDB Enterprise Platform — Updater      ║${NC}"
  echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════╝${NC}"
  echo ""
  info "Date        : $(date '+%Y-%m-%d %H:%M:%S %Z')"
  info "Install dir : ${INSTALL_DIR}"
  info "Compose     : ${COMPOSE_FILE}"
  info "Log file    : ${LOG_FILE}"
  [ "${DRY_RUN}"  = "true" ] && warn "DRY-RUN mode — no changes will be made."
  [ "${NO_CACHE}" = "true" ] && warn "NO-CACHE mode — full image rebuild."
  [ "${FORCE}"    = "true" ] && warn "FORCE mode    — downgrade guard bypassed."

  # Verify compose file exists
  if [ ! -f "${COMPOSE_FILE}" ]; then
    error "Production compose file not found: ${COMPOSE_FILE}"
    error "Set CMDB_DIR to your installation root or run from within the project directory."
    exit 1
  fi

  detect_runtime
  version_guard         # exits cleanly if already up to date

  pre_update_backup

  # ── RAG subsystem detection (requires .env sourced by pre_update_backup) ──────
  local rag_detected
  rag_detected=$(grep -E '^RAG_ENABLED=' "${INSTALL_DIR}/.env" 2>/dev/null | cut -d= -f2 | tr -d '"' || echo "false")
  if [[ "${rag_detected}" == "true" ]]; then
    info "RAG subsystem detected — additional steps will run during update"
    RAG_PRESENT=true
  else
    RAG_PRESENT=false
  fi

  tag_rollback

  # Final confirmation before destructive operations
  if [ "${AUTO_YES}" != "true" ] && [ "${DRY_RUN}" != "true" ]; then
    echo ""
    read -r -p "Proceed with the update? [Y/n] " confirm
    if ! [[ "${confirm:-Y}" =~ ^[Yy]$ ]]; then
      info "Update cancelled by user."
      exit 0
    fi
  fi

  migrate_certs
  pull_and_detect
  build_images          || rollback "Image build failed"
  deploy                || rollback "Health check failed after deploy"
  ensure_ollama_models

  if [ "${DRY_RUN}" = "true" ]; then
    check_new_env_vars
    reindex_documents
    reindex_entities
    echo ""
    echo -e "${BOLD}${YELLOW}╔══════════════════════════════════════════╗${NC}"
    echo -e "${BOLD}${YELLOW}║  DRY RUN complete — no changes made      ║${NC}"
    echo -e "${BOLD}${YELLOW}╚══════════════════════════════════════════╝${NC}"
    success "Log saved to: ${LOG_FILE}"
    exit 0
  fi

  # ── Step 8: Check for new env vars not present in existing .env ──────────────
  check_new_env_vars
  reindex_documents
  reindex_entities

  # Success summary
  local new_version
  new_version=$(git -C "${INSTALL_DIR}" describe --tags --always --abbrev=7 2>/dev/null \
                  || git -C "${INSTALL_DIR}" rev-parse --short HEAD)

  echo ""
  echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}${GREEN}║  Update complete!                        ║${NC}"
  printf  "${BOLD}${GREEN}║  Version: %-31s║${NC}\n" "${new_version}"
  echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════╝${NC}"
  success "Log saved to: ${LOG_FILE}"
}

main "$@"
