#!/usr/bin/env bash
# =============================================================================
# CMDB Enterprise Platform -- Production Installer
#
# Supported platforms:
#   RHEL 8/9, CentOS Stream 9, Rocky/AlmaLinux, Fedora, Ubuntu 22+, Debian 12+,
#   SLES/openSUSE, macOS (Docker Desktop)
#
# Usage (interactive):
#   sudo bash scripts/install.sh
#
# Usage (unattended):
#   sudo bash scripts/install.sh --unattended --config-file ./install.conf
#   sudo bash scripts/install.sh --unattended --config-file ./install.conf \
#       --enable-rag --apply-host-tuning
#
# All output is tee'd to a log file for post-mortem analysis.
# =============================================================================

set -euo pipefail

# =============================================================================
# CLI FLAG PARSING  (must happen before any Phase code runs)
# =============================================================================

UNATTENDED=false
CONFIG_FILE=""
RAG_ENABLED="${RAG_ENABLED:-false}"
RAG_CHAT_MODEL="${RAG_CHAT_MODEL:-qwen2.5:7b-instruct-q4_K_M}"
RAG_EMBED_MODEL="${RAG_EMBED_MODEL:-bge-m3}"
DATA_PATH="${DATA_PATH:-/opt/cmdb-data}"
APPLY_HOST_TUNING="${APPLY_HOST_TUNING:-false}"
FORCE_PODMAN=false

# Flags that feed directly into wizard variables (may already be set via env)
ADMIN_EMAIL="${ADMIN_EMAIL:-}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
# PUBLIC_URL, COMPANY_NAME, INSTALL_DIR etc. may be pre-set by config; leave
# unset here so the wizard can still supply defaults.

print_usage() {
  cat <<'USAGE'
Usage: sudo bash scripts/install.sh [OPTIONS]

Options:
  --unattended              Skip all interactive prompts; values must come from
                            --config-file or other flags.
  --config-file <path>      Load KEY=VALUE pairs from file (root-owned, mode <=600).
  --enable-rag              Enable the RAG subsystem (Phase 10b bootstrap).
  --rag-chat-model <model>  Chat model (default: qwen2.5:7b-instruct-q4_K_M).
  --rag-embed-model <model> Embedding model (default: bge-m3).
  --data-path <path>        Base data directory (default: /opt/cmdb-data).
  --admin-email <email>     First admin account email.
  --admin-password <pw>     First admin account password.
  --public-url <url>        Public URL (e.g. https://cmdb.example.com).
  --company-name <name>     Branding company name.
  --use-podman              Force Podman as container runtime.
  --apply-host-tuning       Apply sysctl, limits, firewalld tuning (Linux only).
  --help                    Print this message and exit.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --unattended)         UNATTENDED=true ;;
    --config-file)        CONFIG_FILE="$2"; shift ;;
    --enable-rag)         RAG_ENABLED=true ;;
    --rag-chat-model)     RAG_CHAT_MODEL="$2"; shift ;;
    --rag-embed-model)    RAG_EMBED_MODEL="$2"; shift ;;
    --data-path)          DATA_PATH="$2"; shift ;;
    --admin-email)        ADMIN_EMAIL="$2"; shift ;;
    --admin-password)     ADMIN_PASSWORD="$2"; shift ;;
    --public-url)         PUBLIC_URL="$2"; shift ;;
    --company-name)       COMPANY_NAME="$2"; shift ;;
    --use-podman)         FORCE_PODMAN=true ;;
    --apply-host-tuning)  APPLY_HOST_TUNING=true ;;
    --help|-h)            print_usage; exit 0 ;;
    *)
      echo "[ERROR] Unknown flag: $1" >&2
      print_usage >&2
      exit 1
      ;;
  esac
  shift
done

# ── Load config file (before any variable use) ─────────────────────────────
if [[ -n "$CONFIG_FILE" ]]; then
  if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "[ERROR] Config file not found: $CONFIG_FILE" >&2; exit 1
  fi
  # Security: must be owned by root and permissions <= 600
  _cf_owner="$(stat -c '%U' "$CONFIG_FILE" 2>/dev/null || stat -f '%Su' "$CONFIG_FILE" 2>/dev/null)"
  _cf_perms="$(stat -c '%a' "$CONFIG_FILE" 2>/dev/null || stat -f '%Lp' "$CONFIG_FILE" 2>/dev/null)"
  [[ "$_cf_owner" == "$(id -un)" ]] && _cf_owner=root
  if [[ "$_cf_owner" != "root" ]]; then
    echo "[ERROR] Config file must be owned by root (current owner: $_cf_owner)" >&2; exit 1
  fi
  if [[ "$_cf_perms" -gt 600 ]]; then
    echo "[ERROR] Config file permissions must be <= 600 (current: $_cf_perms). Run: chmod 600 $CONFIG_FILE" >&2; exit 1
  fi
  # Source only KEY=VALUE lines; ignore comments and blank lines
  while IFS= read -r _line || [[ -n "$_line" ]]; do
    # strip leading whitespace
    _line="${_line#"${_line%%[! ]*}"}"
    # skip comments and blank lines
    [[ -z "$_line" || "$_line" == \#* ]] && continue
    # accept only safe KEY=VALUE pairs (KEY must be [A-Z_][A-Z0-9_]*)
    if [[ "$_line" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]]; then
      # Only set if not already set by an explicit CLI flag (flags win over file)
      _key="${BASH_REMATCH[1]}"
      _val="${BASH_REMATCH[2]}"
      # Strip optional surrounding quotes from value
      _val="${_val#\"}" ; _val="${_val%\"}"
      _val="${_val#\'}" ; _val="${_val%\'}"
      # Don't overwrite variables that were explicitly set via CLI flags
      # (RAG_ENABLED, RAG_CHAT_MODEL, RAG_EMBED_MODEL, DATA_PATH,
      #  APPLY_HOST_TUNING already initialised above — only set if empty/default)
      printf -v "$_key" '%s' "$_val"
    fi
  done < "$CONFIG_FILE"
  echo "[INFO]  Config loaded from: $CONFIG_FILE"
fi

# Apply FORCE_PODMAN early so Phase 2 respects it
if [[ "$FORCE_PODMAN" == "true" ]]; then
  RUNTIME="podman"
fi

# ── Helper: prompt_or_default ──────────────────────────────────────────────
# In unattended mode: use pre-set variable or fail if required and empty.
# In interactive mode: behave like the existing prompt() helper.
prompt_or_default() {
  local var_name="$1" prompt_text="$2" default="${3:-}"
  if [[ "$UNATTENDED" == "true" ]]; then
    local current
    current="${!var_name:-}"
    [[ -z "$current" ]] && current="$default"
    if [[ -z "$current" ]]; then
      error "Unattended mode: $var_name is required but not provided"
      exit 1
    fi
    printf -v "$var_name" '%s' "$current"
  else
    # Delegate to the existing prompt() helper (defined just below)
    prompt "$var_name" "$prompt_text" "$default"
  fi
}

# ── Helper: confirm_or_default ────────────────────────────────────────────
# In unattended mode returns false (skip optional sections) unless the
# corresponding variable is already set to "true".
confirm_or_skip() {
  local var_name="$1" prompt_text="$2" default="${3:-n}"
  if [[ "$UNATTENDED" == "true" ]]; then
    local current="${!var_name:-false}"
    [[ "$current" == "true" ]]
    return
  else
    confirm "$prompt_text" "$default"
  fi
}

# ── Colour output helpers ────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }
step()    { echo -e "\n${BOLD}${CYAN}── $* ──${NC}"; }

# ── Logging setup (bootstrap — will be relocated after INSTALL_DIR is known) ─
EARLY_LOG="/tmp/cmdb_install_$(date +%Y%m%d_%H%M%S).log"
LOG_FILE="$EARLY_LOG"
exec > >(tee -a "$LOG_FILE") 2>&1

# ── Error trap ───────────────────────────────────────────────────────────────
cleanup_on_error() {
  error "Installation failed at line $1. See log at: $LOG_FILE"
  exit 1
}
trap 'cleanup_on_error $LINENO' ERR

# ── Helper: prompt with default ──────────────────────────────────────────────
# printf + read (no -p) avoids ANSI escape codes shifting the terminal cursor
# on RHEL 9 / some terminal emulators, which caused read -rp to capture
# truncated input (e.g. "/op/..." instead of "/opt/...").
# In unattended mode: uses the pre-set variable value or the default; fails if
# the variable is required and empty.
prompt() {
  local var_name="$1" prompt_text="$2" default="$3"
  if [[ "$UNATTENDED" == "true" ]]; then
    local current
    current="${!var_name:-}"
    [[ -z "$current" ]] && current="$default"
    if [[ -z "$current" ]]; then
      error "Unattended mode: $var_name is required but not provided (prompt: $prompt_text)"
      exit 1
    fi
    printf -v "$var_name" '%s' "$current"
    return
  fi
  local input
  printf "${CYAN}?${NC} %s [%s]: " "$prompt_text" "$default"
  read -r input
  printf -v "$var_name" '%s' "${input:-$default}"
}

# ── Helper: yes/no prompt (default no) ───────────────────────────────────────
# In unattended mode: returns true if the corresponding env var is "true",
# false otherwise (i.e. optional sections are skipped unless explicitly set).
confirm() {
  local prompt_text="$1" default="${2:-n}"
  if [[ "$UNATTENDED" == "true" ]]; then
    # Unattended: default is always "no" (skip optional sections)
    [[ "$default" == "y" ]]
    return
  fi
  local input
  if [ "$default" = "y" ]; then
    printf "${CYAN}?${NC} %s [Y/n]: " "$prompt_text"
    read -r input
    input="${input:-y}"
  else
    printf "${CYAN}?${NC} %s [y/N]: " "$prompt_text"
    read -r input
    input="${input:-n}"
  fi
  [[ "${input,,}" == "y" || "${input,,}" == "yes" ]]
}

# =============================================================================
# PHASE 1 — OS Detection
# =============================================================================
step "Phase 1: Detecting operating system"

OS_ID="unknown"
OS_LIKE=""
OS_PRETTY="Unknown"
PKG_MGR="unknown"

detect_os() {
  if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS_ID="${ID:-unknown}"
    OS_LIKE="${ID_LIKE:-}"
    OS_PRETTY="${PRETTY_NAME:-$OS_ID}"
  elif [ "$(uname)" = "Darwin" ]; then
    OS_ID="macos"
    OS_PRETTY="macOS $(sw_vers -productVersion 2>/dev/null || echo '')"
  else
    OS_ID="unknown"
    OS_PRETTY="Unknown OS"
  fi

  case "$OS_ID $OS_LIKE" in
    *rhel*|*centos*|*rocky*|*almalinux*|*fedora*) PKG_MGR="dnf" ;;
    *ubuntu*|*debian*)                             PKG_MGR="apt-get" ;;
    *sles*|*opensuse*)                             PKG_MGR="zypper" ;;
    macos*)                                        PKG_MGR="brew" ;;
    *)                                             PKG_MGR="unknown" ;;
  esac
}

detect_os
info "OS detected: $OS_PRETTY (id=$OS_ID, pkg=$PKG_MGR)"

# =============================================================================
# PHASE 2 — Runtime Detection
# =============================================================================
step "Phase 2: Detecting container runtime"

RUNTIME="${RUNTIME:-}"
COMPOSE_CMD=""

detect_runtime() {
  # Honour --use-podman / USE_PODMAN=true from config
  if [[ "$FORCE_PODMAN" == "true" ]] || [[ "${USE_PODMAN:-false}" == "true" ]]; then
    if command -v podman &>/dev/null; then
      RUNTIME="podman"
      return
    else
      error "--use-podman requested but podman is not installed"; exit 1
    fi
  fi
  if command -v podman &>/dev/null; then
    RUNTIME="podman"
  elif command -v docker &>/dev/null; then
    RUNTIME="docker"
  else
    RUNTIME=""
  fi
}

detect_compose() {
  if command -v podman-compose &>/dev/null; then
    COMPOSE_CMD="podman-compose"
  elif command -v docker &>/dev/null && docker compose version &>/dev/null 2>&1; then
    COMPOSE_CMD="docker compose"
  elif command -v docker-compose &>/dev/null; then
    COMPOSE_CMD="docker-compose"
  else
    COMPOSE_CMD=""
  fi
}

# =============================================================================
# PHASE 3 — OpenShift Detection
# =============================================================================
detect_openshift() {
  if command -v oc &>/dev/null && oc whoami &>/dev/null 2>&1; then
    PLATFORM="openshift"
    warn "OpenShift cluster detected. The installer will generate manifests instead of running containers directly."
    warn "Review the generated files in ./openshift/ and apply with: oc apply -f openshift/"
  else
    PLATFORM="compose"
  fi
}

# =============================================================================
# PHASE 4 — Prerequisite Check & Install
# =============================================================================
step "Phase 3: Checking prerequisites"

MISSING_PKGS=()

check_prereq() {
  local name="$1" cmd="$2"
  if command -v "$cmd" &>/dev/null; then
    success "$name found: $(command -v "$cmd")"
    return 0
  else
    warn "$name not found"
    MISSING_PKGS+=("$name")
    return 1
  fi
}

install_package() {
  local pkg="$1"
  info "Installing $pkg via $PKG_MGR ..."
  case "$PKG_MGR" in
    dnf)
      case "$pkg" in
        git)            sudo dnf install -y git ;;
        openssl)        sudo dnf install -y openssl ;;
        docker)
          sudo dnf install -y docker
          sudo systemctl enable --now docker
          success "Docker installed and started"
          ;;
        podman)
          sudo dnf install -y podman podman-compose
          sudo systemctl enable --now podman.socket
          success "Podman installed and socket started"
          ;;
        docker-compose) sudo dnf install -y docker-compose ;;
        podman-compose) sudo dnf install -y podman-compose ;;
        *)              sudo dnf install -y "$pkg" ;;
      esac
      ;;
    apt-get)
      sudo apt-get update -qq
      case "$pkg" in
        git)            sudo apt-get install -y git ;;
        openssl)        sudo apt-get install -y openssl ;;
        docker)
          sudo apt-get install -y docker.io docker-compose-v2
          sudo systemctl enable --now docker
          success "Docker and compose plugin installed"
          ;;
        podman)
          sudo apt-get install -y podman podman-compose
          success "Podman installed"
          ;;
        docker-compose) sudo apt-get install -y docker-compose-v2 ;;
        podman-compose) sudo apt-get install -y podman-compose ;;
        *)              sudo apt-get install -y "$pkg" ;;
      esac
      ;;
    zypper)
      case "$pkg" in
        git)            sudo zypper install -y git ;;
        openssl)        sudo zypper install -y openssl ;;
        docker)
          sudo zypper install -y docker docker-compose
          sudo systemctl enable --now docker
          ;;
        podman)
          sudo zypper install -y podman podman-compose
          ;;
        *)              sudo zypper install -y "$pkg" ;;
      esac
      ;;
    brew)
      case "$pkg" in
        git)            brew install git ;;
        openssl)        brew install openssl ;;
        docker)         brew install docker ;;
        docker-compose) brew install docker-compose ;;
        *)              brew install "$pkg" ;;
      esac
      ;;
    *)
      error "Cannot auto-install on this OS (unknown package manager)."
      error "Please install '$pkg' manually and re-run the installer."
      exit 1
      ;;
  esac
}

offer_install() {
  local name="$1"
  if confirm "Install $name now?"; then
    install_package "$name"
    return 0
  else
    error "$name is required. Please install it manually and re-run."
    exit 1
  fi
}

# Check git
check_prereq "git" "git" || true

# Check openssl
check_prereq "openssl" "openssl" || true

# Detect runtime before checking
detect_runtime
if [ -n "$RUNTIME" ]; then
  success "Container runtime found: $RUNTIME"
else
  warn "No container runtime (docker/podman) found"
  MISSING_PKGS+=("container-runtime")
fi

# Detect compose
detect_compose
if [ -n "$COMPOSE_CMD" ]; then
  success "Compose command found: $COMPOSE_CMD"
else
  warn "No compose command found"
  MISSING_PKGS+=("compose")
fi

# Install missing packages
if [ ${#MISSING_PKGS[@]} -gt 0 ]; then
  step "Installing missing prerequisites"
  for pkg in "${MISSING_PKGS[@]}"; do
    case "$pkg" in
      git)       offer_install "git" ;;
      openssl)   offer_install "openssl" ;;
      container-runtime)
        info "No container runtime found. Choose one to install:"
        if [ "$PKG_MGR" = "dnf" ]; then
          info "  1) podman (recommended for RHEL/CentOS)"
          info "  2) docker"
          printf "${CYAN}?${NC} Select [1]: "; read -r rt_choice
          rt_choice="${rt_choice:-1}"
          if [ "$rt_choice" = "2" ]; then
            offer_install "docker"
            RUNTIME="docker"
          else
            offer_install "podman"
            RUNTIME="podman"
          fi
        else
          offer_install "docker"
          RUNTIME="docker"
        fi
        ;;
      compose)
        if [ "$RUNTIME" = "podman" ]; then
          offer_install "podman-compose"
        else
          offer_install "docker-compose"
        fi
        ;;
    esac
  done

  # Re-detect after installs
  detect_runtime
  detect_compose
fi

# Final validation
if [ -z "$RUNTIME" ]; then
  error "No container runtime available. Cannot continue."
  exit 1
fi
if [ -z "$COMPOSE_CMD" ]; then
  error "No compose command available. Cannot continue."
  exit 1
fi

success "All prerequisites satisfied"
info "Runtime: $RUNTIME | Compose: $COMPOSE_CMD"

# ── Podman policy.json bootstrap ─────────────────────────────────────────────
# On minimal RHEL 9 / rootless Podman installs, neither /etc/containers/policy.json
# nor ~/.config/containers/policy.json exists. Without a policy file Podman refuses
# to pull ANY image with:
#   "no policy.json file found at any of the following: ..."
# We create a permissive default (insecureAcceptAnything, same as Docker's default)
# in the user's config dir ONLY if no policy is present at either location.
ensure_podman_policy() {
  [ "$RUNTIME" = "podman" ] || return 0

  local user_policy="${HOME}/.config/containers/policy.json"
  if [ -f /etc/containers/policy.json ] || [ -f "$user_policy" ]; then
    return 0
  fi

  info "No Podman policy.json found — creating default-accept policy at $user_policy"
  mkdir -p "$(dirname "$user_policy")"
  cat > "$user_policy" <<'POLICY_JSON'
{
    "default": [
        {
            "type": "insecureAcceptAnything"
        }
    ]
}
POLICY_JSON
  success "Podman policy.json created (rootless, default-accept)."
}

ensure_podman_policy

# ── Podman rootless: privileged port access ───────────────────────────────────
# Rootless Podman cannot bind ports < net.ipv4.ip_unprivileged_port_start
# (default 1024 on RHEL 9). nginx requires 80 and 443.
# This sysctl must be set by a root/sudo admin BEFORE running this installer.
# See DEPLOY.md § "Prerrequisitos de root" for the exact commands.
ensure_podman_port_access() {
  [ "$RUNTIME" = "podman" ] || return 0

  # Determine the lowest port we need to bind (known at call time only when
  # NGINX_HTTP_PORT / NGINX_HTTPS_PORT are already set; fall back to 80/443).
  local min_port=80
  if [ -n "${NGINX_HTTP_PORT:-}" ] && [ -n "${NGINX_HTTPS_PORT:-}" ]; then
    min_port=$(( NGINX_HTTP_PORT < NGINX_HTTPS_PORT ? NGINX_HTTP_PORT : NGINX_HTTPS_PORT ))
  fi

  # If both ports are unprivileged (>=1024) no sysctl change is needed.
  if [ "$min_port" -ge 1024 ]; then
    success "Both nginx ports >= 1024 — no sysctl change needed."
    return 0
  fi

  local port_start
  port_start=$(sysctl -n net.ipv4.ip_unprivileged_port_start 2>/dev/null || echo "1024")

  if [ "$port_start" -le "$min_port" ]; then
    success "Unprivileged port start = ${port_start} — OK."
    return 0
  fi

  error "Rootless Podman cannot bind port ${min_port} (current limit: ${port_start})."
  error "A root administrator must run the following ONCE before re-running this installer:"
  error ""
  error "  sudo tee /etc/sysctl.d/99-cmdb-podman.conf <<'EOF'"
  error "  net.ipv4.ip_unprivileged_port_start=${min_port}"
  error "  EOF"
  error "  sudo sysctl --system"
  error ""
  error "Alternatively, choose ports >= 1024 (e.g. HTTPS=8443, HTTP=8080)."
  error "See DEPLOY.md, section \"Prerrequisitos de root (Podman rootless)\", for details."
  exit 1
}

# Note: ensure_podman_port_access is called AFTER the port prompts (below)
# so it knows the actual NGINX_*_PORT values.

# OpenShift detection
detect_openshift
info "Platform mode: $PLATFORM"


# =============================================================================
# PHASE 5 — Configuration Wizard
# =============================================================================
step "Phase 4: Configuration wizard"
echo ""
info "Answer the following questions to configure CMDB Enterprise Platform."
info "Press Enter to accept the default shown in brackets."
echo ""

# ── Install directory ─────────────────────────────────────────────────────────
prompt INSTALL_DIR "Install directory" "/opt/cmdb-enterprise-platform"
INSTALL_DIR="${INSTALL_DIR%/}"   # strip accidental trailing slash

# ── Repository detection ──────────────────────────────────────────────────────
DEFAULT_REPO="https://github.com/pirexia/cmdb-enterprise-platform.git"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

SKIP_CLONE="false"
if [ -f "$REPO_ROOT/docker-compose.prod.yml" ] && [ -f "$REPO_ROOT/.env.example" ]; then
  info "Detected existing repository at: $REPO_ROOT"
  if [ "$INSTALL_DIR" = "$REPO_ROOT" ] || [ "$INSTALL_DIR" = "$(pwd)" ] || \
     [ "$INSTALL_DIR" = "${REPO_ROOT%/}" ]; then
    SKIP_CLONE="true"
    info "Install directory matches current repo -- skipping clone."
  fi
fi

if [ "$SKIP_CLONE" = "false" ]; then
  prompt GIT_REPO "Git repository URL" "$DEFAULT_REPO"
fi

# ── Public URL / domain ───────────────────────────────────────────────────────
# nginx serves BOTH frontend and API on the same host:port (443).
echo ""
info "Public URL — the address users type in their browser (e.g. https://cmdb.example.com)."
info "For local/dev: https://localhost"
DEFAULT_HOST="$(hostname -f 2>/dev/null || hostname)"
DEFAULT_URL="https://${DEFAULT_HOST}"
prompt PUBLIC_URL "Public URL (https://...)" "$DEFAULT_URL"
# Normalise: strip trailing slash
PUBLIC_URL="${PUBLIC_URL%/}"
# Ensure it starts with https://
if ! echo "$PUBLIC_URL" | grep -q "^https://"; then
  if echo "$PUBLIC_URL" | grep -q "^http://"; then
    PUBLIC_URL="${PUBLIC_URL/http:\/\//https:\/\/}"
    info "Auto-corrected to: $PUBLIC_URL"
  else
    PUBLIC_URL="https://${PUBLIC_URL}"
    info "Auto-added https://: $PUBLIC_URL"
  fi
fi

# ── nginx listen ports ────────────────────────────────────────────────────────
echo ""
info "nginx listen ports — change if 80/443 are already in use on this host."
prompt NGINX_HTTPS_PORT "HTTPS port" "443"
prompt NGINX_HTTP_PORT  "HTTP port (redirect → HTTPS)" "80"
# Validate: must be numeric 1-65535
for _p in "$NGINX_HTTPS_PORT" "$NGINX_HTTP_PORT"; do
  if ! [[ "$_p" =~ ^[0-9]+$ ]] || [ "$_p" -lt 1 ] || [ "$_p" -gt 65535 ]; then
    error "Invalid port: $_p (must be 1-65535)"; exit 1
  fi
done
# If HTTPS port is non-standard, append it to PUBLIC_URL (if not already there)
if [ "$NGINX_HTTPS_PORT" != "443" ]; then
  _host_only="$(echo "$PUBLIC_URL" | sed 's|https://||;s|/.*||;s|:[0-9]*$||')"
  PUBLIC_URL="https://${_host_only}:${NGINX_HTTPS_PORT}"
  info "Public URL updated to include custom port: $PUBLIC_URL"
fi

# Port access check now that we know the actual port values
ensure_podman_port_access

# ── Company name ──────────────────────────────────────────────────────────────
echo ""
prompt COMPANY_NAME "Company name (shown in the UI)" "CMDB Enterprise"
if ! [[ "${COMPANY_NAME}" =~ ^[A-Za-z0-9\ \.\-]+$ ]]; then
  error "Company name must contain only letters, numbers, spaces, hyphens, and periods."
  exit 1
fi

# ── Database password ─────────────────────────────────────────────────────────
echo ""
if [[ "$UNATTENDED" == "true" ]]; then
  # In unattended mode: use pre-set DB_PASSWORD from config/flags, or auto-generate
  if [[ -z "${DB_PASSWORD:-}" ]]; then
    DB_PASSWORD="$(openssl rand -base64 24 | tr '+/=' 'ABC' | head -c 24)Aa1!"
    success "Auto-generated database password."
  else
    success "Database password provided via config."
  fi
else
  info "Database password — must be at least 16 chars with upper+lower+digit+special."
  info "Press Enter to auto-generate a secure password."
  while true; do
    printf "${CYAN}?${NC} Database password [auto-generate]: "
    read -sr DB_PASSWORD
    echo ""

    if [ -z "$DB_PASSWORD" ]; then
      DB_PASSWORD="$(openssl rand -base64 24 | tr '+/=' 'ABC' | head -c 24)Aa1!"
      success "Auto-generated database password."
      break
    fi

    if [ ${#DB_PASSWORD} -lt 16 ]; then
      error "Password must be at least 16 characters."; continue
    fi
    if ! echo "$DB_PASSWORD" | grep -qP '[A-Z]'; then
      error "Must contain at least one uppercase letter."; continue
    fi
    if ! echo "$DB_PASSWORD" | grep -qP '[a-z]'; then
      error "Must contain at least one lowercase letter."; continue
    fi
    if ! echo "$DB_PASSWORD" | grep -qP '[0-9]'; then
      error "Must contain at least one digit."; continue
    fi
    if ! echo "$DB_PASSWORD" | grep -qP '[^A-Za-z0-9]'; then
      error "Must contain at least one special character."; continue
    fi

    printf "${CYAN}?${NC} Confirm database password: "
    read -sr DB_PASSWORD_CONFIRM
    echo ""
    if [ "$DB_PASSWORD" != "$DB_PASSWORD_CONFIRM" ]; then
      error "Passwords do not match. Try again."; continue
    fi

    success "Database password accepted."
    break
  done
fi

# ── JWT secret (always auto-generated) ───────────────────────────────────────
JWT_SECRET="$(openssl rand -base64 48)"
success "JWT secret auto-generated."

# ── TLS certificate setup ─────────────────────────────────────────────────────
echo ""
info "TLS certificate — nginx requires server.crt and server.key in ./certs/"
info "  a) Generate self-signed certificate (fine for internal / dev use)"
info "  b) Provide existing certificate and key files"
ssl_choice="${SSL_CHOICE:-}"
if [[ "$UNATTENDED" == "true" ]]; then
  # In unattended mode: use SSL_CHOICE from config, or default to self-signed
  ssl_choice="${ssl_choice:-a}"
  info "Unattended: TLS mode = ${ssl_choice} (set SSL_CHOICE=b to use provided certs)"
else
  printf "${CYAN}?${NC} Choose [a]: "; read -r ssl_choice
  ssl_choice="${ssl_choice:-a}"
fi

SSL_MODE="self-signed"
SSL_CERT_PATH=""
SSL_KEY_PATH=""

# DN fields for self-signed cert
CERT_CN="${CERT_CN:-}"
CERT_O="${CERT_O:-}"
CERT_OU="${CERT_OU:-}"
CERT_C="${CERT_C:-}"
CERT_ST="${CERT_ST:-}"
CERT_L="${CERT_L:-}"
CERT_SAN="${CERT_SAN:-}"

if [ "$ssl_choice" = "b" ]; then
  SSL_MODE="provided"
  printf "${CYAN}?${NC} Path to certificate file (.crt / .pem): "; read -r SSL_CERT_PATH
  printf "${CYAN}?${NC} Path to private key file (.key): "; read -r SSL_KEY_PATH
  if [ ! -f "$SSL_CERT_PATH" ]; then
    error "Certificate file not found: $SSL_CERT_PATH"; exit 1
  fi
  if [ ! -f "$SSL_KEY_PATH" ]; then
    error "Private key file not found: $SSL_KEY_PATH"; exit 1
  fi
  success "Using provided certificates."
else
  SSL_MODE="self-signed"
  echo ""
  info "Certificate details (Distinguished Name). Press Enter to accept defaults."

  # Derive default CN from the public URL hostname
  DEFAULT_CN="${PUBLIC_URL#https://}"
  DEFAULT_CN="${DEFAULT_CN%%/*}"
  DEFAULT_CN="${DEFAULT_CN%%:*}"  # strip port if any

  prompt CERT_CN "Common Name (CN) — server hostname / FQDN" "$DEFAULT_CN"
  prompt CERT_O  "Organization (O)" "$COMPANY_NAME"
  prompt CERT_OU "Organizational Unit (OU)" "IT"
  prompt CERT_C  "Country (C) — 2-letter ISO code" "ES"
  prompt CERT_ST "State / Province (ST)" ""
  prompt CERT_L  "Locality / City (L)" ""

  # Auto-build SAN from CN; user can extend
  DEFAULT_SAN="DNS:${CERT_CN},DNS:localhost,IP:127.0.0.1"
  CERT_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  if [ -n "$CERT_IP" ] && [ "$CERT_IP" != "127.0.0.1" ]; then
    DEFAULT_SAN="${DEFAULT_SAN},IP:${CERT_IP}"
  fi
  prompt CERT_SAN "Subject Alternative Names (SAN)" "$DEFAULT_SAN"

  info "Self-signed certificate will be generated with RSA 4096-bit key."
fi

# ── Optional: SMTP ────────────────────────────────────────────────────────────
echo ""
USE_SMTP="false"
SMTP_HOST=""; SMTP_PORT="587"; SMTP_SECURE="false"
SMTP_USER=""; SMTP_PASS=""; ALERT_RECIPIENT=""

# In unattended mode, check if SMTP settings were pre-loaded from config
if [[ "$UNATTENDED" == "true" ]]; then
  if [[ -n "${SMTP_HOST:-}" ]]; then
    USE_SMTP="true"
    SMTP_PORT="${SMTP_PORT:-587}"
    SMTP_SECURE="${SMTP_SECURE:-false}"
    SMTP_USER="${SMTP_USER:-}"
    SMTP_PASS="${SMTP_PASS:-}"
    ALERT_RECIPIENT="${ALERT_RECIPIENT:-admin@$(echo "$PUBLIC_URL" | sed 's|https://||;s|/.*||')}"
    info "Unattended: SMTP configured (host=$SMTP_HOST)"
  fi
elif confirm "Configure SMTP for email alerts?"; then
  USE_SMTP="true"
  prompt SMTP_HOST "SMTP host" "smtp.gmail.com"
  prompt SMTP_PORT "SMTP port" "587"
  if confirm "Use SMTP over TLS (port 465)?" "n"; then SMTP_SECURE="true"; fi
  prompt SMTP_USER "SMTP username / email" ""
  printf "${CYAN}?${NC} SMTP password: "; read -sr SMTP_PASS; echo ""
  prompt ALERT_RECIPIENT "Alert recipient email" "admin@$(echo "$PUBLIC_URL" | sed 's|https://||;s|/.*||')"
fi

# ── Optional: LDAP ────────────────────────────────────────────────────────────
echo ""
USE_LDAP="false"
LDAP_URL=""; LDAP_BASE_DN=""; LDAP_BIND_DN=""; LDAP_BIND_PASSWORD=""
LDAP_TLS_REJECT_UNAUTHORIZED="1"

# In unattended mode, check if LDAP settings were pre-loaded from config
if [[ "$UNATTENDED" == "true" ]]; then
  if [[ "${USE_LDAP:-false}" == "true" ]]; then
    LDAP_URL="${LDAP_URL:-}"
    LDAP_BASE_DN="${LDAP_BASE_DN:-}"
    LDAP_BIND_DN="${LDAP_BIND_DN:-}"
    LDAP_BIND_PASSWORD="${LDAP_BIND_PASSWORD:-}"
    LDAP_TLS_REJECT_UNAUTHORIZED="${LDAP_TLS_REJECT_UNAUTHORIZED:-1}"
    info "Unattended: LDAP configured (url=${LDAP_URL:-<not set>})"
  fi
elif confirm "Enable LDAP / Active Directory authentication?"; then
  USE_LDAP="true"
  prompt LDAP_URL      "LDAP URL" "ldap://dc.corp.local:389"
  prompt LDAP_BASE_DN  "Search base DN" "dc=corp,dc=local"
  prompt LDAP_BIND_DN  "Bind DN (empty for direct bind)" ""
  if [ -n "$LDAP_BIND_DN" ]; then
    printf "${CYAN}?${NC} Bind password: "; read -sr LDAP_BIND_PASSWORD; echo ""
  fi
  if confirm "Accept self-signed / internal CA certificates for LDAPS?" "y"; then
    LDAP_TLS_REJECT_UNAUTHORIZED="0"
  fi
fi

# ── Optional: Microsoft 365 SSO ───────────────────────────────────────────────
echo ""
USE_MICROSOFT_SSO="false"
AZURE_TENANT_ID=""; AZURE_CLIENT_ID=""; AZURE_CLIENT_SECRET=""
AZURE_ALLOWED_DOMAIN=""; AZURE_AUTO_PROVISION="false"
AZURE_REDIRECT_URI="${PUBLIC_URL}/api/auth/sso/microsoft/callback"

# In unattended mode, check if SSO settings were pre-loaded from config
if [[ "$UNATTENDED" == "true" ]]; then
  if [[ "${USE_MICROSOFT_SSO:-false}" == "true" ]] || [[ "${SSO_ENABLED:-false}" == "true" ]]; then
    USE_MICROSOFT_SSO="true"
    AZURE_TENANT_ID="${AZURE_TENANT_ID:-${MS365_TENANT_ID:-}}"
    AZURE_CLIENT_ID="${AZURE_CLIENT_ID:-${MS365_CLIENT_ID:-}}"
    AZURE_CLIENT_SECRET="${AZURE_CLIENT_SECRET:-${MS365_CLIENT_SECRET:-}}"
    AZURE_ALLOWED_DOMAIN="${AZURE_ALLOWED_DOMAIN:-${MS365_ALLOWED_DOMAIN:-}}"
    AZURE_AUTO_PROVISION="${AZURE_AUTO_PROVISION:-false}"
    AZURE_REDIRECT_URI="${PUBLIC_URL}/api/auth/sso/microsoft/callback"
    info "Unattended: Microsoft 365 SSO configured (tenant=${AZURE_TENANT_ID:-<not set>})"
  fi
elif confirm "Enable Microsoft 365 SSO (Azure AD / Entra ID)?"; then
  USE_MICROSOFT_SSO="true"
  prompt AZURE_TENANT_ID      "Azure Tenant ID" ""
  prompt AZURE_CLIENT_ID      "App Registration Client ID" ""
  printf "${CYAN}?${NC} App Registration Client Secret: "; read -sr AZURE_CLIENT_SECRET; echo ""
  prompt AZURE_ALLOWED_DOMAIN "Allowed corporate email domain (e.g. empresa.com)" ""
  if confirm "Auto-provision VIEWER accounts for new SSO users?" "y"; then
    AZURE_AUTO_PROVISION="true"
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────
step "Configuration Summary"
echo ""
printf "  ${BOLD}%-30s${NC} %s\n" "Install directory:"  "$INSTALL_DIR"
printf "  ${BOLD}%-30s${NC} %s\n" "Public URL:"         "$PUBLIC_URL"
printf "  ${BOLD}%-30s${NC} %s\n" "nginx HTTPS port:"   "$NGINX_HTTPS_PORT"
printf "  ${BOLD}%-30s${NC} %s\n" "nginx HTTP port:"    "$NGINX_HTTP_PORT"
printf "  ${BOLD}%-30s${NC} %s\n" "Company name:"       "$COMPANY_NAME"
printf "  ${BOLD}%-30s${NC} %s\n" "DB password:"        "****"
printf "  ${BOLD}%-30s${NC} %s\n" "TLS certificate:"    "$SSL_MODE"
if [ "$SSL_MODE" = "self-signed" ]; then
  printf "  ${BOLD}%-30s${NC} %s\n" "  CN:"             "$CERT_CN"
  printf "  ${BOLD}%-30s${NC} %s\n" "  SAN:"            "$CERT_SAN"
fi
printf "  ${BOLD}%-30s${NC} %s\n" "SMTP alerts:"        "$( [ "$USE_SMTP" = "true" ] && echo "yes ($SMTP_USER → $ALERT_RECIPIENT)" || echo "disabled" )"
printf "  ${BOLD}%-30s${NC} %s\n" "LDAP:"               "$USE_LDAP"
printf "  ${BOLD}%-30s${NC} %s\n" "Microsoft 365 SSO:"  "$USE_MICROSOFT_SSO"
printf "  ${BOLD}%-30s${NC} %s\n" "Runtime:"            "$RUNTIME"
echo ""

if [[ "$UNATTENDED" == "true" ]]; then
  info "Unattended mode — proceeding automatically."
elif ! confirm "Proceed with installation?" "y"; then
  info "Installation cancelled."; exit 0
fi

# =============================================================================
# PHASE 6 — Prepare Install Directory
# =============================================================================
step "Phase 5: Preparing install directory"

mkdir -p "$INSTALL_DIR/logs"
FINAL_LOG="$INSTALL_DIR/logs/install_$(date +%Y%m%d_%H%M%S).log"
[ -f "$LOG_FILE" ] && cp "$LOG_FILE" "$FINAL_LOG"
LOG_FILE="$FINAL_LOG"
info "Log file: $LOG_FILE"

# Clone or copy repository
if [ "$SKIP_CLONE" = "false" ]; then
  if [ -d "$INSTALL_DIR/.git" ]; then
    info "Repository already exists at $INSTALL_DIR -- pulling latest."
    git -C "$INSTALL_DIR" pull --ff-only
  elif [ -d "$INSTALL_DIR" ] && [ "$(ls -A "$INSTALL_DIR" 2>/dev/null | grep -cv '^logs$')" -gt 0 ]; then
    warn "Directory $INSTALL_DIR is not empty. Cloning alongside existing content."
    git clone "$GIT_REPO" "$INSTALL_DIR.tmp"
    cp -rT "$INSTALL_DIR.tmp" "$INSTALL_DIR"
    rm -rf "$INSTALL_DIR.tmp"
  else
    info "Cloning repository into $INSTALL_DIR ..."
    git clone "$GIT_REPO" "$INSTALL_DIR"
    mkdir -p "$INSTALL_DIR/logs"
  fi
elif [ "$INSTALL_DIR" != "$REPO_ROOT" ]; then
  info "Copying repository to $INSTALL_DIR ..."
  mkdir -p "$INSTALL_DIR"
  rsync -a --exclude='node_modules' --exclude='.next' "$REPO_ROOT/" "$INSTALL_DIR/"
fi

cd "$INSTALL_DIR"
success "Working directory: $(pwd)"

mkdir -p "$INSTALL_DIR/logs"
mkdir -p "$INSTALL_DIR/backups"
mkdir -p "$INSTALL_DIR/document-storage"
chmod 777 "$INSTALL_DIR/document-storage"
mkdir -p "$INSTALL_DIR/certs"          # shared TLS cert directory (nginx + backend)
mkdir -p "${DATA_PATH:-/opt/cmdb-data}/ollama-models"

# =============================================================================
# PHASE 5b — Host Tuning (Linux only, optional)
# =============================================================================
if [[ "${APPLY_HOST_TUNING:-false}" == "true" ]]; then
  if [[ "$(uname -s)" == "Linux" ]]; then
    step "Phase 5b: Applying host tuning (sysctl, limits, firewalld, AMX)"

    # sysctl — vm.max_map_count is required by Elasticsearch/OpenSearch; also
    # raises file-descriptor limits and listen backlog for RAG/nginx.
    cat > /etc/sysctl.d/99-cmdb-rag.conf <<'EOF'
# CMDB Enterprise Platform — RAG subsystem tuning
vm.max_map_count=262144
fs.file-max=1048576
net.core.somaxconn=4096
EOF
    sysctl --system >/dev/null
    success "sysctl: vm.max_map_count=262144, fs.file-max=1048576, net.core.somaxconn=4096"

    # limits — raise nofile / nproc for container processes
    cat > /etc/security/limits.d/99-cmdb.conf <<'EOF'
*  soft  nofile  1048576
*  hard  nofile  1048576
*  soft  nproc   65536
*  hard  nproc   65536
EOF
    success "limits.d: nofile=1048576, nproc=65536"

    # firewalld — open http/https only if firewalld is running
    if systemctl is-active --quiet firewalld; then
      firewall-cmd --permanent --add-service=https >/dev/null
      firewall-cmd --permanent --add-service=http >/dev/null
      firewall-cmd --reload >/dev/null
      success "firewalld: http/https opened"
    else
      warn "firewalld inactive — skipping firewall rules"
    fi

    # AMX / AVX-512 check (informational only)
    if grep -q -E '\b(amx_tile|amx_bf16|amx_int8)\b' /proc/cpuinfo 2>/dev/null; then
      success "AMX detected — RAG inference will use Intel AMX acceleration"
    elif grep -q -E '\bavx512' /proc/cpuinfo 2>/dev/null; then
      warn "AVX-512 detected but no AMX — RAG inference will be slower (consider AMX-capable VM)"
    else
      warn "Neither AMX nor AVX-512 detected — RAG inference may be very slow"
    fi

    success "Host tuning applied"
  else
    warn "Host tuning is Linux-only — skipping (detected: $(uname -s))"
  fi
fi

# =============================================================================
# PHASE 7 — Generate .env
# =============================================================================
step "Phase 6: Generating .env configuration"

(
umask 0077
cat > "$INSTALL_DIR/.env" <<ENVEOF
# ==============================================================================
# CMDB Enterprise Platform — Configuration
# Generated: $(date '+%Y-%m-%d %H:%M:%S') by install.sh
# ==============================================================================

# ── Database ──────────────────────────────────────────────────────────────────
POSTGRES_DB=cmdb_db
POSTGRES_USER=admin
POSTGRES_PASSWORD=${DB_PASSWORD}

# ── Security ──────────────────────────────────────────────────────────────────
JWT_SECRET=${JWT_SECRET}

# ── URLs ──────────────────────────────────────────────────────────────────────
# nginx serves frontend (/) and API (/api/*) on the same public URL.
NEXT_PUBLIC_API_URL=${PUBLIC_URL}
FRONTEND_URL=${PUBLIC_URL}

# ── Branding ──────────────────────────────────────────────────────────────────
NEXT_PUBLIC_COMPANY_NAME=${COMPANY_NAME}

# ── Document storage ──────────────────────────────────────────────────────────
DOCUMENTS_STORAGE_PATH=./document-storage

# ── SMTP / Email alerts ───────────────────────────────────────────────────────
SMTP_HOST=${SMTP_HOST}
SMTP_PORT=${SMTP_PORT}
SMTP_SECURE=${SMTP_SECURE}
SMTP_USER=${SMTP_USER}
SMTP_PASS=${SMTP_PASS}
ALERT_RECIPIENT=${ALERT_RECIPIENT}

# ── LDAP / Active Directory ───────────────────────────────────────────────────
USE_LDAP=${USE_LDAP}
LDAP_URL=${LDAP_URL}
LDAP_BASE_DN=${LDAP_BASE_DN}
LDAP_BIND_DN=${LDAP_BIND_DN}
LDAP_BIND_PASSWORD=${LDAP_BIND_PASSWORD}

# ── Microsoft 365 SSO ─────────────────────────────────────────────────────────
USE_MICROSOFT_SSO=${USE_MICROSOFT_SSO}
AZURE_TENANT_ID=${AZURE_TENANT_ID}
AZURE_CLIENT_ID=${AZURE_CLIENT_ID}
AZURE_CLIENT_SECRET=${AZURE_CLIENT_SECRET}
AZURE_REDIRECT_URI=${AZURE_REDIRECT_URI}
AZURE_ALLOWED_DOMAIN=${AZURE_ALLOWED_DOMAIN}
AZURE_AUTO_PROVISION=${AZURE_AUTO_PROVISION}

# ── nginx listen ports ────────────────────────────────────────────────────────
# Host ports mapped to the nginx container (container-internal ports are fixed).
# Change these if 80 or 443 are already in use on this host.
NGINX_HTTPS_PORT=${NGINX_HTTPS_PORT}
NGINX_HTTP_PORT=${NGINX_HTTP_PORT}

# ── RAG / AI Assistant ────────────────────────────────────────────────────────
RAG_ENABLED=${RAG_ENABLED}
OLLAMA_BASE_URL=http://ollama:11434
RAG_EMBED_MODEL=${RAG_EMBED_MODEL}
RAG_CHAT_MODEL=${RAG_CHAT_MODEL}
RAG_CHAT_TEMPERATURE=0.1
RAG_TOP_K=6
RAG_RATE_LIMIT_PER_MIN=10
OLLAMA_MODELS_PATH=${DATA_PATH}/ollama-models
ENVEOF
)

chmod 600 "$INSTALL_DIR/.env"
success ".env generated at $INSTALL_DIR/.env (mode 600)"

# =============================================================================
# PHASE 8 — TLS Certificate Setup
# =============================================================================
step "Phase 7: TLS certificate setup"

CERT_DIR="$INSTALL_DIR/certs"

if [ "$SSL_MODE" = "self-signed" ]; then
  info "Generating self-signed RSA 4096-bit certificate (valid 10 years) ..."

  # Sanitise DN fields (strip chars that would break the openssl -subj string)
  _san_cert_cn() { echo "$1" | tr -d '/"\\'; }
  SAFE_CN="$(_san_cert_cn "$CERT_CN")"
  SAFE_O="$(_san_cert_cn "$CERT_O")"
  SAFE_OU="$(_san_cert_cn "$CERT_OU")"
  SAFE_C="$(echo "$CERT_C" | tr -dc 'A-Za-z' | head -c 2)"
  SAFE_ST="$(_san_cert_cn "$CERT_ST")"
  SAFE_L="$(_san_cert_cn "$CERT_L")"

  SUBJECT="/CN=${SAFE_CN}"
  [ -n "$SAFE_C"  ] && SUBJECT="${SUBJECT}/C=${SAFE_C}"
  [ -n "$SAFE_ST" ] && SUBJECT="${SUBJECT}/ST=${SAFE_ST}"
  [ -n "$SAFE_L"  ] && SUBJECT="${SUBJECT}/L=${SAFE_L}"
  [ -n "$SAFE_O"  ] && SUBJECT="${SUBJECT}/O=${SAFE_O}"
  [ -n "$SAFE_OU" ] && SUBJECT="${SUBJECT}/OU=${SAFE_OU}"

  openssl req -x509 -nodes -days 3650 -newkey rsa:4096 \
    -keyout "${CERT_DIR}/server.key" \
    -out    "${CERT_DIR}/server.crt" \
    -subj   "${SUBJECT}" \
    -addext "subjectAltName=${CERT_SAN}" 2>/dev/null

  chmod 600 "${CERT_DIR}/server.key"
  chmod 644 "${CERT_DIR}/server.crt"
  success "Self-signed certificate generated in ${CERT_DIR}/"
  info "  Subject:  ${SUBJECT}"
  info "  SAN:      ${CERT_SAN}"
  info "  Key size: RSA 4096-bit"

elif [ "$SSL_MODE" = "provided" ]; then
  info "Copying provided certificates ..."
  cp "$SSL_CERT_PATH" "${CERT_DIR}/server.crt"
  cp "$SSL_KEY_PATH"  "${CERT_DIR}/server.key"
  chmod 600 "${CERT_DIR}/server.key"
  chmod 644 "${CERT_DIR}/server.crt"
  success "Certificates installed in ${CERT_DIR}/"
fi

# =============================================================================
# PHASE 9 — Populate TLS Named Volume (docker-compose.prod.yml uses tls-certs)
# =============================================================================
step "Phase 8: Preparing TLS volume for production compose"

if [ -f "${CERT_DIR}/server.crt" ] && [ -f "${CERT_DIR}/server.key" ]; then
  info "Populating named Docker volume cmdb-tls-certs ..."
  $RUNTIME volume create cmdb-tls-certs 2>/dev/null || true
  if [ "$RUNTIME" = "podman" ]; then
    # Podman exposes volume mountpoint directly — avoids short-name resolution
    # failures on RHEL 9 where containers-registries.conf may not be present.
    VOLUME_MP="$($RUNTIME volume inspect cmdb-tls-certs --format '{{.Mountpoint}}')"
    cp "${CERT_DIR}/server.key" "${CERT_DIR}/server.crt" "$VOLUME_MP/"
    chmod 600 "${VOLUME_MP}/server.key"
  else
    $RUNTIME run --rm \
      -v cmdb-tls-certs:/dst \
      -v "${CERT_DIR}":/src:ro \
      docker.io/library/alpine sh -c "cp /src/server.key /src/server.crt /dst/ && chmod 600 /dst/server.key"
  fi
  success "TLS certificates loaded into volume cmdb-tls-certs"
else
  warn "No certificates found in ${CERT_DIR}/ — skipping volume population."
  warn "You can generate or install certs later via the Admin → Certificates UI."
fi

# =============================================================================
# PHASE 10 — Build & Start
# =============================================================================
if [ "$PLATFORM" = "compose" ]; then
  step "Phase 9: Building and starting containers"

  cd "$INSTALL_DIR"

  info "Building container images (this may take several minutes) ..."
  $COMPOSE_CMD -f docker-compose.prod.yml build --no-cache

  info "Starting services ..."
  $COMPOSE_CMD -f docker-compose.prod.yml down --remove-orphans 2>/dev/null || true
  $COMPOSE_CMD -f docker-compose.prod.yml up -d

  success "Containers started."

  # ── Health check ─────────────────────────────────────────────────────────────
  step "Phase 10: Verifying health"

  wait_healthy() {
    local url="$1" max=120 i=0
    echo -n "  Waiting for backend "
    while [ "$i" -lt "$max" ]; do
      if curl -sk "${url}/api/health" 2>/dev/null | grep -q '"ok"'; then
        echo ""
        return 0
      fi
      echo -n "."
      sleep 2
      i=$((i + 2))
    done
    echo ""
    return 1
  }

  # Health check goes through nginx (same public URL)
  HEALTH_URL="${PUBLIC_URL}"

  if wait_healthy "$HEALTH_URL"; then
    success "Platform is healthy — backend responding at ${HEALTH_URL}/api/health"
  else
    warn "Health check timed out (120 s)."
    warn "Check logs: $COMPOSE_CMD -f docker-compose.prod.yml logs"
  fi

  # Quick check on nginx / frontend
  echo -n "  Checking frontend "
  FRONTEND_OK="false"
  for attempt in $(seq 1 30); do
    if curl -sk "${PUBLIC_URL}" &>/dev/null; then
      FRONTEND_OK="true"
      break
    fi
    echo -n "."
    sleep 2
  done
  echo ""

  if [ "$FRONTEND_OK" = "true" ]; then
    success "Frontend accessible at ${PUBLIC_URL}"
  else
    warn "Frontend did not respond within 60 s."
    warn "Check logs: $COMPOSE_CMD -f docker-compose.prod.yml logs nginx"
  fi

elif [ "$PLATFORM" = "openshift" ]; then
  step "Phase 9: OpenShift deployment"
  warn "Container build and deployment skipped for OpenShift."
  warn "Apply manifests: oc apply -f openshift/"
fi

# =============================================================================
# PHASE 10b — RAG Bootstrap (skipped unless RAG_ENABLED=true)
# =============================================================================
if [[ "${RAG_ENABLED:-false}" == "true" ]] && [[ "$PLATFORM" == "compose" ]]; then
  step "Phase 10b: RAG bootstrap"

  # ── Capacity check (informational) ───────────────────────────────────────────
  _total_ram_gb=0
  _cpu_count=0
  if [[ "$(uname -s)" == "Linux" ]]; then
    _total_ram_gb=$(free -g 2>/dev/null | awk '/^Mem:/{print $2}' || echo 0)
    _cpu_count=$(nproc 2>/dev/null || echo 0)
    if [[ "$_total_ram_gb" -lt 16 ]] || [[ "$_cpu_count" -lt 8 ]]; then
      warn "Low capacity (${_total_ram_gb}GB RAM / ${_cpu_count} vCPU). RAG will work but be slow."
      warn "Consider using qwen2.5:3b instead of 7b on this host."
    else
      info "Capacity OK: ${_total_ram_gb}GB RAM / ${_cpu_count} vCPU"
    fi
  fi

  # ── Wait for Ollama to become healthy (max 90 s) ───────────────────────────
  info "Waiting for Ollama service to become healthy (max 90s)..."
  _ollama_container="cmdb-ollama"
  _elapsed=0
  until $RUNTIME exec "$_ollama_container" curl -fs http://localhost:11434/api/version &>/dev/null; do
    sleep 3
    _elapsed=$((_elapsed + 3))
    if [[ "$_elapsed" -ge 90 ]]; then
      error "Ollama did not become healthy after 90s. Check logs: $RUNTIME logs $_ollama_container"
      exit 1
    fi
  done
  success "Ollama is healthy"

  # ── Pull models ────────────────────────────────────────────────────────────
  info "Pulling embedding model: ${RAG_EMBED_MODEL} (~600 MB) — this may take a few minutes ..."
  $RUNTIME exec "$_ollama_container" ollama pull "${RAG_EMBED_MODEL}"
  info "Pulling chat model: ${RAG_CHAT_MODEL} (~4 GB) — this may take several minutes ..."
  $RUNTIME exec "$_ollama_container" ollama pull "${RAG_CHAT_MODEL}"
  success "RAG models downloaded"

  # ── Apply RAG database migrations ─────────────────────────────────────────
  info "Applying RAG database migrations..."
  $RUNTIME exec cmdb-backend npx prisma migrate deploy
  success "RAG migrations applied"

  # ── Embedding smoke test ───────────────────────────────────────────────────
  info "Smoke testing the embedding service..."
  if $RUNTIME exec "$_ollama_container" \
      curl -fs -X POST http://localhost:11434/api/embeddings \
        -H "Content-Type: application/json" \
        -d "{\"model\":\"${RAG_EMBED_MODEL}\",\"prompt\":\"smoke test\"}" \
      | grep -q '"embedding"'; then
    success "Embedding endpoint OK"
  else
    error "Embedding smoke test failed. Check Ollama logs: $RUNTIME logs $_ollama_container"
    exit 1
  fi

  success "Phase 10b complete — RAG subsystem ready"
fi

# =============================================================================
# PHASE 11 — Post-install Summary
# =============================================================================
step "Installation Complete"
echo ""
echo -e "${BOLD}${GREEN}+----------------------------------------------------------+${NC}"
echo -e "${BOLD}${GREEN}|       CMDB Enterprise Platform — Installed                |${NC}"
echo -e "${BOLD}${GREEN}+----------------------------------------------------------+${NC}"
echo ""
printf "  ${BOLD}%-26s${NC} %s\n" "Platform URL:"        "$PUBLIC_URL"
printf "  ${BOLD}%-26s${NC} %s\n" "Default admin user:"  "admin@cmdb.local"
printf "  ${BOLD}%-26s${NC} %s\n" "Default admin pass:"  "Admin1234!"
echo ""
echo -e "  ${RED}${BOLD}>> IMPORTANT: Change the default password immediately! <<${NC}"
echo ""
printf "  ${BOLD}%-26s${NC} %s\n" ".env file:"     "$INSTALL_DIR/.env"
printf "  ${BOLD}%-26s${NC} %s\n" "TLS certs:"     "$INSTALL_DIR/certs/"
printf "  ${BOLD}%-26s${NC} %s\n" "Install log:"   "$LOG_FILE"
printf "  ${BOLD}%-26s${NC} %s\n" "Runtime:"       "$RUNTIME"
printf "  ${BOLD}%-26s${NC} %s\n" "RAG subsystem:" "$( [[ "${RAG_ENABLED:-false}" == "true" ]] && echo "enabled (chat=${RAG_CHAT_MODEL})" || echo "disabled" )"
echo ""
echo -e "${BOLD}${CYAN}  Next steps:${NC}"
echo "    1. Open ${PUBLIC_URL} in your browser (accept the self-signed cert warning if applicable)"
echo "    2. Log in with admin@cmdb.local / Admin1234! and change the password immediately"
echo "    3. Upload a CA-signed certificate via Admin → Certificates, then: docker compose restart nginx"
if [ "$USE_MICROSOFT_SSO" = "true" ]; then
echo "    4. Register SSO redirect URI in Azure Portal App Registration:"
echo "       ${AZURE_REDIRECT_URI}"
fi
if [ "$USE_SMTP" = "false" ]; then
echo "    5. Configure SMTP for email alerts by editing SMTP_* in $INSTALL_DIR/.env"
fi
echo "    6. Schedule daily backups:"
echo "       0 2 * * * $INSTALL_DIR/scripts/db-backup.sh >> /var/log/cmdb-backup.log 2>&1"
echo "    7. View container logs:"
echo "       $COMPOSE_CMD -f $INSTALL_DIR/docker-compose.prod.yml logs -f"
echo ""
echo -e "${BOLD}${GREEN}+----------------------------------------------------------+${NC}"
echo ""
