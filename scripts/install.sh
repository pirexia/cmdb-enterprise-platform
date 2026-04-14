#!/usr/bin/env bash
# =============================================================================
# CMDB Enterprise Platform -- Interactive Production Installer
#
# Supported platforms:
#   RHEL 8/9, CentOS Stream 9, Rocky/AlmaLinux, Fedora, Ubuntu 22+, Debian 12+,
#   SLES/openSUSE, macOS (Docker Desktop)
#
# Usage:
#   sudo bash scripts/install.sh
#
# The script is fully interactive and will guide you through configuration.
# All output is tee'd to a log file for post-mortem analysis.
# =============================================================================

set -euo pipefail

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
prompt() {
  local var_name="$1" prompt_text="$2" default="$3"
  local input
  read -rp "$(echo -e "${CYAN}?${NC} ${prompt_text} [${default}]: ")" input
  printf -v "$var_name" '%s' "${input:-$default}"
}

# ── Helper: yes/no prompt (default no) ───────────────────────────────────────
confirm() {
  local prompt_text="$1" default="${2:-n}"
  local input
  if [ "$default" = "y" ]; then
    read -rp "$(echo -e "${CYAN}?${NC} ${prompt_text} [Y/n]: ")" input
    input="${input:-y}"
  else
    read -rp "$(echo -e "${CYAN}?${NC} ${prompt_text} [y/N]: ")" input
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

RUNTIME=""
COMPOSE_CMD=""

detect_runtime() {
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
          read -rp "$(echo -e "${CYAN}?${NC} Select [1]: ")" rt_choice
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

# OpenShift detection
detect_openshift
info "Platform mode: $PLATFORM"

# =============================================================================
# PHASE 5 — Configuration Wizard
# =============================================================================
step "Phase 4: Configuration wizard"
echo ""
info "Answer the following questions to configure CMDB Enterprise Platform."
info "Press Enter to accept the default value shown in brackets."
echo ""

# 1. Install directory
prompt INSTALL_DIR "Install directory" "/opt/cmdb"

# 2. Git repo URL
DEFAULT_REPO="https://github.com/pirexia/cmdb-enterprise-platform.git"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

SKIP_CLONE="false"
if [ -f "$REPO_ROOT/docker-compose.prod.yml" ] && [ -f "$REPO_ROOT/.env.example" ]; then
  info "Detected existing repository at: $REPO_ROOT"
  if [ "$INSTALL_DIR" = "$REPO_ROOT" ] || [ "$INSTALL_DIR" = "$(pwd)" ]; then
    SKIP_CLONE="true"
    info "Install directory matches current repo -- skipping clone."
  fi
fi

if [ "$SKIP_CLONE" = "false" ]; then
  prompt GIT_REPO "Git repository URL" "$DEFAULT_REPO"
fi

# 3. Database password (validated)
while true; do
  echo ""
  read -srp "$(echo -e "${CYAN}?${NC} Database password (min 16 chars, upper+lower+digit+special): ")" DB_PASSWORD
  echo ""

  if [ ${#DB_PASSWORD} -lt 16 ]; then
    error "Password must be at least 16 characters."
    continue
  fi
  if ! echo "$DB_PASSWORD" | grep -qP '[A-Z]'; then
    error "Password must contain at least one uppercase letter."
    continue
  fi
  if ! echo "$DB_PASSWORD" | grep -qP '[a-z]'; then
    error "Password must contain at least one lowercase letter."
    continue
  fi
  if ! echo "$DB_PASSWORD" | grep -qP '[0-9]'; then
    error "Password must contain at least one digit."
    continue
  fi
  if ! echo "$DB_PASSWORD" | grep -qP '[^A-Za-z0-9]'; then
    error "Password must contain at least one special character."
    continue
  fi

  read -srp "$(echo -e "${CYAN}?${NC} Confirm database password: ")" DB_PASSWORD_CONFIRM
  echo ""
  if [ "$DB_PASSWORD" != "$DB_PASSWORD_CONFIRM" ]; then
    error "Passwords do not match. Try again."
    continue
  fi

  success "Database password accepted."
  break
done

# 4. Backend port
prompt BACKEND_PORT "Backend API port" "3000"

# 5. Frontend port
prompt FRONTEND_PORT "Frontend port" "3001"

# 6. Public API URL
DEFAULT_HOST="$(hostname -f 2>/dev/null || hostname)"
DEFAULT_API_URL="http://${DEFAULT_HOST}:${BACKEND_PORT}"
prompt API_URL "Public API URL (as seen from browser)" "$DEFAULT_API_URL"

# 7. HTTPS
HTTPS_ENABLED="false"
SSL_MODE="none"
SSL_CERT_PATH=""
SSL_KEY_PATH=""

if confirm "Enable HTTPS?"; then
  HTTPS_ENABLED="true"
  echo ""
  info "  a) Generate self-signed certificate"
  info "  b) Provide existing certificate paths"
  read -rp "$(echo -e "${CYAN}?${NC} Choose [a]: ")" ssl_choice
  ssl_choice="${ssl_choice:-a}"

  if [ "$ssl_choice" = "b" ]; then
    SSL_MODE="provided"
    read -rp "$(echo -e "${CYAN}?${NC} Path to SSL certificate (.crt): ")" SSL_CERT_PATH
    read -rp "$(echo -e "${CYAN}?${NC} Path to SSL private key (.key): ")" SSL_KEY_PATH
    if [ ! -f "$SSL_CERT_PATH" ]; then
      error "Certificate file not found: $SSL_CERT_PATH"
      exit 1
    fi
    if [ ! -f "$SSL_KEY_PATH" ]; then
      error "Key file not found: $SSL_KEY_PATH"
      exit 1
    fi
    success "Using provided certificates."
  else
    SSL_MODE="self-signed"
    info "Self-signed certificate will be generated during installation."
  fi

  # Update API URL to https if user left default
  if echo "$API_URL" | grep -q "^http://"; then
    NEW_API_URL="${API_URL/http:\/\//https:\/\/}"
    if confirm "Update API URL to $NEW_API_URL?"; then
      API_URL="$NEW_API_URL"
    fi
  fi
fi

# 8. Company name
prompt COMPANY_NAME "Company name" "CMDB Enterprise"

# 9. LDAP
USE_LDAP="false"
LDAP_URL=""
LDAP_BASE_DN=""
LDAP_BIND_DN=""
LDAP_BIND_PASSWORD=""
LDAP_TLS_REJECT_UNAUTHORIZED="1"

if confirm "Enable LDAP/Active Directory authentication?"; then
  USE_LDAP="true"
  prompt LDAP_URL "LDAP URL (e.g. ldap://dc.corp.local:389)" "ldap://dc.corp.local:389"
  prompt LDAP_BASE_DN "LDAP search base (e.g. dc=corp,dc=local)" "dc=corp,dc=local"
  prompt LDAP_BIND_DN "LDAP bind DN (leave empty for direct bind)" ""
  if [ -n "$LDAP_BIND_DN" ]; then
    read -srp "$(echo -e "${CYAN}?${NC} LDAP bind password: ")" LDAP_BIND_PASSWORD
    echo ""
  fi
  if confirm "Accept self-signed / corporate CA certificates for LDAPS?" "y"; then
    LDAP_TLS_REJECT_UNAUTHORIZED="0"
  fi
fi

# 10. Microsoft 365 SSO
USE_MICROSOFT_SSO="false"
AZURE_TENANT_ID=""
AZURE_CLIENT_ID=""
AZURE_CLIENT_SECRET=""
AZURE_ALLOWED_DOMAIN=""
AZURE_AUTO_PROVISION="false"

if confirm "Enable Microsoft 365 SSO (Azure AD / Entra ID)?"; then
  USE_MICROSOFT_SSO="true"
  prompt AZURE_TENANT_ID "Azure Tenant ID (from Azure Portal → Entra ID → Overview)" ""
  if [ -z "$AZURE_TENANT_ID" ]; then
    error "Tenant ID is required for SSO. You can add it manually to .env later."
    USE_MICROSOFT_SSO="false"
  else
    prompt AZURE_CLIENT_ID "App Registration Client ID" ""
    read -srp "$(echo -e "${CYAN}?${NC} App Registration Client Secret: ")" AZURE_CLIENT_SECRET
    echo ""
    prompt AZURE_ALLOWED_DOMAIN "Corporate email domain (e.g. empresa.com)" ""
    if confirm "Auto-provision VIEWER accounts for new SSO users?" "y"; then
      AZURE_AUTO_PROVISION="true"
    fi
  fi
fi

# Compute AZURE_REDIRECT_URI from the backend API URL
AZURE_REDIRECT_URI="${API_URL}/api/auth/sso/microsoft/callback"

# 11. Summary table
CORS_ORIGINS="${API_URL},http://${DEFAULT_HOST}:${FRONTEND_PORT}"
if [ "$HTTPS_ENABLED" = "true" ]; then
  CORS_ORIGINS="${API_URL},https://${DEFAULT_HOST}:${FRONTEND_PORT},http://${DEFAULT_HOST}:${FRONTEND_PORT}"
fi

step "Configuration Summary"
echo ""
printf "  ${BOLD}%-28s${NC} %s\n" "Install directory:" "$INSTALL_DIR"
if [ "$SKIP_CLONE" = "false" ]; then
  printf "  ${BOLD}%-28s${NC} %s\n" "Git repository:" "$GIT_REPO"
else
  printf "  ${BOLD}%-28s${NC} %s\n" "Git repository:" "(using existing repo)"
fi
printf "  ${BOLD}%-28s${NC} %s\n" "Database password:" "********"
printf "  ${BOLD}%-28s${NC} %s\n" "Backend port:" "$BACKEND_PORT"
printf "  ${BOLD}%-28s${NC} %s\n" "Frontend port:" "$FRONTEND_PORT"
printf "  ${BOLD}%-28s${NC} %s\n" "Public API URL:" "$API_URL"
printf "  ${BOLD}%-28s${NC} %s\n" "HTTPS:" "$HTTPS_ENABLED ($SSL_MODE)"
printf "  ${BOLD}%-28s${NC} %s\n" "Company name:" "$COMPANY_NAME"
printf "  ${BOLD}%-28s${NC} %s\n" "LDAP:" "$USE_LDAP"
printf "  ${BOLD}%-28s${NC} %s\n" "Microsoft 365 SSO:" "$USE_MICROSOFT_SSO"
if [ "$USE_MICROSOFT_SSO" = "true" ]; then
  printf "  ${BOLD}%-28s${NC} %s\n" "SSO domain:" "$AZURE_ALLOWED_DOMAIN"
  printf "  ${BOLD}%-28s${NC} %s\n" "SSO redirect URI:" "$AZURE_REDIRECT_URI"
fi
printf "  ${BOLD}%-28s${NC} %s\n" "Container runtime:" "$RUNTIME"
printf "  ${BOLD}%-28s${NC} %s\n" "Compose command:" "$COMPOSE_CMD"
printf "  ${BOLD}%-28s${NC} %s\n" "Platform:" "$PLATFORM"
echo ""

if ! confirm "Proceed with installation?" "y"; then
  info "Installation cancelled by user."
  exit 0
fi

# =============================================================================
# PHASE 6 — Prepare Install Directory
# =============================================================================
step "Phase 5: Preparing install directory"

# Relocate log file to final destination
mkdir -p "$INSTALL_DIR/logs"
FINAL_LOG="$INSTALL_DIR/logs/install_$(date +%Y%m%d_%H%M%S).log"
if [ -f "$LOG_FILE" ]; then
  cp "$LOG_FILE" "$FINAL_LOG"
fi
LOG_FILE="$FINAL_LOG"
info "Log file: $LOG_FILE"

# Clone or copy repository
if [ "$SKIP_CLONE" = "false" ]; then
  if [ -d "$INSTALL_DIR/.git" ]; then
    info "Repository already exists at $INSTALL_DIR -- pulling latest changes."
    git -C "$INSTALL_DIR" pull --ff-only
  elif [ -d "$INSTALL_DIR" ] && [ "$(ls -A "$INSTALL_DIR" 2>/dev/null | grep -cv '^logs$')" -gt 0 ]; then
    warn "Directory $INSTALL_DIR is not empty. Cloning into it."
    git clone "$GIT_REPO" "$INSTALL_DIR.tmp"
    # Move git content into install dir (preserve logs)
    cp -rT "$INSTALL_DIR.tmp" "$INSTALL_DIR"
    rm -rf "$INSTALL_DIR.tmp"
  else
    info "Cloning repository into $INSTALL_DIR ..."
    git clone "$GIT_REPO" "$INSTALL_DIR"
    # Ensure logs directory survives the clone
    mkdir -p "$INSTALL_DIR/logs"
  fi
elif [ "$INSTALL_DIR" != "$REPO_ROOT" ]; then
  info "Copying repository to $INSTALL_DIR ..."
  mkdir -p "$INSTALL_DIR"
  rsync -a --exclude='node_modules' --exclude='.next' "$REPO_ROOT/" "$INSTALL_DIR/"
fi

# Ensure we are in the install directory for all remaining operations
cd "$INSTALL_DIR"
success "Working directory: $(pwd)"

# Create required directories
mkdir -p "$INSTALL_DIR/logs"
mkdir -p "$INSTALL_DIR/backups"
mkdir -p "$INSTALL_DIR/document-storage"
mkdir -p "$INSTALL_DIR/backend/certs"

# =============================================================================
# PHASE 7 — Generate .env
# =============================================================================
step "Phase 6: Generating .env configuration"

JWT_SECRET="$(openssl rand -base64 48)"

cat > "$INSTALL_DIR/.env" <<ENVEOF
# =============================================================================
# CMDB Enterprise Platform -- Generated by install.sh
# Generated: $(date '+%Y-%m-%d %H:%M:%S')
# =============================================================================

# -- PostgreSQL ---------------------------------------------------------------
POSTGRES_DB=cmdb_db
POSTGRES_USER=cmdb_db_user
POSTGRES_PASSWORD=${DB_PASSWORD}
POSTGRES_PORT=5432

# -- Backend API --------------------------------------------------------------
BACKEND_PORT=${BACKEND_PORT}
JWT_SECRET=${JWT_SECRET}

# -- Frontend (Next.js) -------------------------------------------------------
FRONTEND_PORT=${FRONTEND_PORT}
NEXT_PUBLIC_API_URL=${API_URL}

# -- Security / TLS -----------------------------------------------------------
HTTPS_ENABLED=${HTTPS_ENABLED}
CORS_ORIGINS=${CORS_ORIGINS}

# -- LDAP / Active Directory --------------------------------------------------
USE_LDAP=${USE_LDAP}
LDAP_URL=${LDAP_URL}
LDAP_BASE_DN=${LDAP_BASE_DN}
LDAP_BIND_DN=${LDAP_BIND_DN}
LDAP_BIND_PASSWORD=${LDAP_BIND_PASSWORD}
LDAP_TLS_REJECT_UNAUTHORIZED=${LDAP_TLS_REJECT_UNAUTHORIZED}

# -- Microsoft 365 SSO (Azure AD / Entra ID) ----------------------------------
# Set USE_MICROSOFT_SSO=true and fill the values below to enable SSO.
USE_MICROSOFT_SSO=${USE_MICROSOFT_SSO}
AZURE_TENANT_ID=${AZURE_TENANT_ID}
AZURE_CLIENT_ID=${AZURE_CLIENT_ID}
AZURE_CLIENT_SECRET=${AZURE_CLIENT_SECRET}
# Redirect URI must be registered exactly in your Azure App Registration
AZURE_REDIRECT_URI=${AZURE_REDIRECT_URI}
AZURE_ALLOWED_DOMAIN=${AZURE_ALLOWED_DOMAIN}
# Frontend URL — used by backend to redirect users after SSO (no trailing slash)
FRONTEND_URL=${API_URL/\/api/}
AZURE_AUTO_PROVISION=${AZURE_AUTO_PROVISION}

# -- Corporate Branding -------------------------------------------------------
NEXT_PUBLIC_COMPANY_NAME=${COMPANY_NAME}
NEXT_PUBLIC_LOGO_URL=/logo.png
NEXT_PUBLIC_THEME_COLOR=#4f46e5

# -- Application Environment --------------------------------------------------
APP_ENV=prod
NEXT_PUBLIC_APP_ENV=prod

# -- Alert Engine / Email Notifications ----------------------------------------
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
ALERT_RECIPIENT=admin@yourdomain.com
ALERT_WARN_DAYS=30
ALERT_CRON_SCHEDULE=30 8 * * *

# -- Database Maintenance ------------------------------------------------------
AUDIT_RETENTION_DAYS=365

# -- MFA / Trusted Devices ----------------------------------------------------
TRUSTED_DEVICE_TTL_DAYS=30
NEXT_PUBLIC_TRUSTED_DEVICE_TTL_DAYS=30

# -- Password Policy -----------------------------------------------------------
PASSWORD_MIN_LENGTH_ADMIN=16
PASSWORD_MIN_LENGTH_VIEWER=12
PASSWORD_HISTORY_COUNT=20

# -- Document Repository -------------------------------------------------------
MAX_DOCUMENT_SIZE_MB=50
DOCUMENTS_STORAGE_PATH=./document-storage
ENVEOF

chmod 600 "$INSTALL_DIR/.env"
success ".env generated at $INSTALL_DIR/.env (permissions: 600)"

# =============================================================================
# PHASE 8 — SSL Certificate Generation
# =============================================================================
step "Phase 7: SSL certificate setup"

if [ "$HTTPS_ENABLED" = "true" ]; then
  if [ "$SSL_MODE" = "self-signed" ]; then
    info "Generating self-signed TLS certificate (RSA 2048, 10 years) ..."

    CERT_HOST="$(hostname -f 2>/dev/null || hostname)"
    CERT_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
    # Fallback if hostname -I is unavailable (macOS)
    if [ -z "$CERT_IP" ]; then
      CERT_IP="$(ipconfig getifaddr en0 2>/dev/null || echo '127.0.0.1')"
    fi

    SAN="DNS:${CERT_HOST}"
    if [ -n "$CERT_IP" ] && [ "$CERT_IP" != "127.0.0.1" ]; then
      SAN="${SAN},IP:${CERT_IP}"
    fi
    SAN="${SAN},DNS:localhost,IP:127.0.0.1"

    openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
      -keyout "$INSTALL_DIR/backend/certs/server.key" \
      -out "$INSTALL_DIR/backend/certs/server.crt" \
      -subj "/CN=${CERT_HOST}/O=${COMPANY_NAME}/C=ES" \
      -addext "subjectAltName=${SAN}"

    chmod 600 "$INSTALL_DIR/backend/certs/server.key"
    chmod 644 "$INSTALL_DIR/backend/certs/server.crt"
    success "Self-signed certificate generated in $INSTALL_DIR/backend/certs/"

  elif [ "$SSL_MODE" = "provided" ]; then
    info "Copying provided certificates ..."
    cp "$SSL_CERT_PATH" "$INSTALL_DIR/backend/certs/server.crt"
    cp "$SSL_KEY_PATH" "$INSTALL_DIR/backend/certs/server.key"
    chmod 600 "$INSTALL_DIR/backend/certs/server.key"
    chmod 644 "$INSTALL_DIR/backend/certs/server.crt"
    success "Certificates installed in $INSTALL_DIR/backend/certs/"
  fi
else
  info "HTTPS disabled -- skipping certificate setup."
fi

# =============================================================================
# PHASE 9 — Populate TLS Volume (production compose uses a named volume)
# =============================================================================
step "Phase 8: Preparing TLS volume for production compose"

if [ "$HTTPS_ENABLED" = "true" ] && [ -f "$INSTALL_DIR/backend/certs/server.crt" ]; then
  info "Creating named volume cmdb-tls-certs and copying certificates ..."
  $RUNTIME volume create cmdb-tls-certs 2>/dev/null || true
  $RUNTIME run --rm \
    -v cmdb-tls-certs:/certs \
    -v "$INSTALL_DIR/backend/certs":/src:ro \
    alpine sh -c "cp /src/server.key /src/server.crt /certs/ && chmod 600 /certs/server.key"
  success "TLS certificates loaded into volume cmdb-tls-certs"
else
  info "No TLS certificates to load into volume."
fi

# =============================================================================
# PHASE 10 — Build & Start (compose mode only)
# =============================================================================
if [ "$PLATFORM" = "compose" ]; then
  step "Phase 9: Building and starting containers"

  cd "$INSTALL_DIR"

  info "Building images (this may take several minutes) ..."
  $COMPOSE_CMD -f docker-compose.prod.yml build --no-cache

  info "Starting services ..."
  $COMPOSE_CMD -f docker-compose.prod.yml up -d

  success "Containers started."

  # ── Health check ───────────────────────────────────────────────────────────
  step "Phase 10: Verifying health"

  HEALTH_PROTO="http"
  if [ "$HTTPS_ENABLED" = "true" ]; then
    HEALTH_PROTO="https"
  fi
  HEALTH_URL="${HEALTH_PROTO}://localhost:${BACKEND_PORT}"

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

  if wait_healthy "$HEALTH_URL"; then
    success "Backend is healthy and responding at ${HEALTH_URL}/api/health"
  else
    warn "Backend did not respond within 120 seconds."
    warn "Check logs with: $COMPOSE_CMD -f docker-compose.prod.yml logs backend"
  fi

  # Quick check on frontend
  echo -n "  Checking frontend "
  FRONTEND_OK="false"
  for attempt in $(seq 1 30); do
    if curl -sk "http://localhost:${FRONTEND_PORT}" &>/dev/null; then
      FRONTEND_OK="true"
      break
    fi
    echo -n "."
    sleep 2
  done
  echo ""

  if [ "$FRONTEND_OK" = "true" ]; then
    success "Frontend is responding at http://localhost:${FRONTEND_PORT}"
  else
    warn "Frontend did not respond within 60 seconds."
    warn "Check logs with: $COMPOSE_CMD -f docker-compose.prod.yml logs frontend"
  fi

elif [ "$PLATFORM" = "openshift" ]; then
  step "Phase 9: OpenShift deployment"
  warn "Container build and deployment skipped for OpenShift."
  warn "Review the docker-compose.prod.yml and generated .env, then deploy using:"
  warn "  oc new-app --file=openshift/deployment.yaml"
  info "Alternatively, use kompose to convert the compose file:"
  info "  kompose convert -f docker-compose.prod.yml -o openshift/"
fi

# =============================================================================
# PHASE 11 — Post-install Summary
# =============================================================================
step "Installation Complete"

FRONTEND_URL="http://${DEFAULT_HOST}:${FRONTEND_PORT}"
if [ "$HTTPS_ENABLED" = "true" ]; then
  FRONTEND_URL="https://${DEFAULT_HOST}:${FRONTEND_PORT}"
fi

echo ""
echo -e "${BOLD}${GREEN}+----------------------------------------------------------+${NC}"
echo -e "${BOLD}${GREEN}|          CMDB Enterprise Platform - Installed             |${NC}"
echo -e "${BOLD}${GREEN}+----------------------------------------------------------+${NC}"
echo ""
printf "  ${BOLD}%-24s${NC} %s\n" "Frontend URL:" "$FRONTEND_URL"
printf "  ${BOLD}%-24s${NC} %s\n" "Backend API URL:" "$API_URL"
printf "  ${BOLD}%-24s${NC} %s\n" "Default admin user:" "admin@cmdb.local"
printf "  ${BOLD}%-24s${NC} %s\n" "Default admin password:" "Admin1234!"
echo ""
echo -e "  ${RED}${BOLD}>> IMPORTANT: Change the default password immediately! <<${NC}"
echo ""
printf "  ${BOLD}%-24s${NC} %s\n" ".env file:" "$INSTALL_DIR/.env"
printf "  ${BOLD}%-24s${NC} %s\n" "Install log:" "$LOG_FILE"
printf "  ${BOLD}%-24s${NC} %s\n" "Container runtime:" "$RUNTIME"
printf "  ${BOLD}%-24s${NC} %s\n" "Compose command:" "$COMPOSE_CMD"
echo ""
echo -e "${BOLD}${CYAN}  Next steps:${NC}"
echo "    1. Log in and change the default admin password"
echo "    2. Configure LDAP/AD integration (if not done during install)"
if [ "$USE_MICROSOFT_SSO" = "true" ]; then
echo "    3. Register the redirect URI in Azure App Registration:"
echo "       ${AZURE_REDIRECT_URI}"
echo "    4. Set up email alerts (edit SMTP_* values in .env)"
echo "    5. Schedule database backups:"
echo "       0 2 * * * $INSTALL_DIR/scripts/db-backup.sh >> /var/log/cmdb-backup.log 2>&1"
echo "    6. Review container logs:"
echo "       $COMPOSE_CMD -f $INSTALL_DIR/docker-compose.prod.yml logs -f"
else
echo "    3. Set up email alerts (edit SMTP_* values in .env)"
echo "    4. To enable Microsoft 365 SSO later, edit .env and set USE_MICROSOFT_SSO=true"
echo "       See Section 15 of the Sysadmin Manual for Azure Portal configuration steps"
echo "    5. Schedule database backups:"
echo "       0 2 * * * $INSTALL_DIR/scripts/db-backup.sh >> /var/log/cmdb-backup.log 2>&1"
echo "    6. Review container logs:"
echo "       $COMPOSE_CMD -f $INSTALL_DIR/docker-compose.prod.yml logs -f"
fi
echo ""
echo -e "${BOLD}${GREEN}+----------------------------------------------------------+${NC}"
echo ""

success "Installation finished. Log saved to: $LOG_FILE"
