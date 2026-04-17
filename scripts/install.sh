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
# printf + read (no -p) avoids ANSI escape codes shifting the terminal cursor
# on RHEL 9 / some terminal emulators, which caused read -rp to capture
# truncated input (e.g. "/op/..." instead of "/opt/...").
prompt() {
  local var_name="$1" prompt_text="$2" default="$3"
  local input
  printf "${CYAN}?${NC} %s [%s]: " "$prompt_text" "$default"
  read -r input
  printf -v "$var_name" '%s' "${input:-$default}"
}

# ── Helper: yes/no prompt (default no) ───────────────────────────────────────
confirm() {
  local prompt_text="$1" default="${2:-n}"
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
prompt INSTALL_DIR "Install directory" "/opt/cmdb"
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

# ── Company name ──────────────────────────────────────────────────────────────
echo ""
prompt COMPANY_NAME "Company name (shown in the UI)" "CMDB Enterprise"
if ! [[ "${COMPANY_NAME}" =~ ^[A-Za-z0-9\ \.\-]+$ ]]; then
  error "Company name must contain only letters, numbers, spaces, hyphens, and periods."
  exit 1
fi

# ── Database password ─────────────────────────────────────────────────────────
echo ""
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

# ── JWT secret (always auto-generated) ───────────────────────────────────────
JWT_SECRET="$(openssl rand -base64 48)"
success "JWT secret auto-generated."

# ── TLS certificate setup ─────────────────────────────────────────────────────
echo ""
info "TLS certificate — nginx requires server.crt and server.key in ./certs/"
info "  a) Generate self-signed certificate (fine for internal / dev use)"
info "  b) Provide existing certificate and key files"
printf "${CYAN}?${NC} Choose [a]: "; read -r ssl_choice
ssl_choice="${ssl_choice:-a}"

SSL_MODE="self-signed"
SSL_CERT_PATH=""
SSL_KEY_PATH=""

# DN fields for self-signed cert
CERT_CN=""
CERT_O=""
CERT_OU=""
CERT_C=""
CERT_ST=""
CERT_L=""
CERT_SAN=""

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

if confirm "Configure SMTP for email alerts?"; then
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

if confirm "Enable LDAP / Active Directory authentication?"; then
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

if confirm "Enable Microsoft 365 SSO (Azure AD / Entra ID)?"; then
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

if ! confirm "Proceed with installation?" "y"; then
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
mkdir -p "$INSTALL_DIR/certs"          # shared TLS cert directory (nginx + backend)

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
