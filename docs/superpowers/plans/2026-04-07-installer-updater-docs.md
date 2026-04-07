# Installer, Updater & Documentation Refresh — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Provide a fully guided OS-agnostic interactive installer, a safe automated updater with version guards and DB backup, and refresh all documentation to reflect current features.

**Architecture:** Three independent deliverables — `scripts/install.sh` (interactive guided setup), `scripts/update.sh` (idempotent updater with rollback), and documentation rewrites. Scripts detect Docker/Podman and OS family; the updater always backs up PostgreSQL before touching code and refuses downgrades.

**Tech Stack:** Bash 4+, Docker/Podman, docker-compose / podman-compose, git, openssl, Prisma migrate deploy.

---

## Subsystem A — scripts/install.sh

**Files:**
- Create: `scripts/install.sh`

### Task A1 — OS detection + prerequisite installer

- [ ] Detect OS family via `/etc/os-release` (`ID_LIKE` / `ID`) → set `PKG_MGR` to `dnf`, `yum`, `apt-get`, `zypper`, or `brew`
- [ ] Detect container runtime: prefer `podman` if present (RHEL default), fall back to `docker`
- [ ] Detect compose command: `podman-compose`, `docker compose` (plugin), or `docker-compose` (standalone)
- [ ] Detect OpenShift: `oc` CLI present + `oc whoami` succeeds → set `PLATFORM=openshift`
- [ ] Print colour-coded status for each check: `[OK]` / `[MISSING]` / `[INSTALLING]`
- [ ] For each missing prerequisite, ask user: "Install <pkg> now? [Y/n]" → run install command with sudo

### Task A2 — Configuration wizard

- [ ] Print welcome banner with ASCII art / version
- [ ] Prompt for install directory (default `/opt/cmdb`) — create if missing
- [ ] Clone repo if not already cloned (ask for git URL, default `https://github.com/pirexia/cmdb-enterprise-platform.git`)
- [ ] Prompt DB password (min 16 chars, re-enter to confirm; auto-validate complexity)
- [ ] Auto-generate JWT secret with `openssl rand -base64 48`
- [ ] Prompt backend port (default 3000), frontend port (default 3001)
- [ ] Prompt public API URL (pre-fill with `http://<detected-hostname>:3000`)
- [ ] Ask HTTPS? [y/N] → if yes, offer: (1) Generate self-signed, (2) Provide cert paths
- [ ] Ask company name for branding (default `CMDB Enterprise`)
- [ ] Ask LDAP? [y/N] → if yes, prompt LDAP_URL, LDAP_SEARCH_BASE, LDAP_BIND_DN, LDAP_BIND_PASSWORD
- [ ] Show full summary of all values and ask "Proceed with these settings? [Y/n]"

### Task A3 — Environment file + cert generation

- [ ] Write `.env` from template, substituting all wizard values; `chmod 600 .env`
- [ ] If HTTPS: run `bash backend/scripts/generate-certs.sh` (or call openssl directly if script missing)
- [ ] Create docker volume `cmdb-tls-certs` and copy certs in (Docker path) — or skip for Podman rootless
- [ ] For OpenShift: output `oc` commands instead of running docker/compose commands, and pause

### Task A4 — Build, start, verify

- [ ] Run `$COMPOSE build --no-cache` with progress output
- [ ] Run `$COMPOSE up -d`
- [ ] Poll `/api/health` on backend port until HTTP 200 or timeout 120s (print dots)
- [ ] Print final summary: URLs, default credentials reminder, next steps
- [ ] Log full install to `/opt/cmdb/logs/install_<timestamp>.log`

---

## Subsystem B — scripts/update.sh

**Files:**
- Create: `scripts/update.sh`

### Task B1 — Version guard

- [ ] Read current version: `git -C "$INSTALL_DIR" describe --tags --always` (fallback: commit hash)
- [ ] `git fetch origin`
- [ ] Compare current commit with `origin/main` — if current is AHEAD of remote, abort with error
- [ ] Show `git log --oneline HEAD..origin/main` as changelog
- [ ] If `--force` flag passed, skip guard (for recovery scenarios)

### Task B2 — Pre-update backup

- [ ] Run `bash scripts/db-backup.sh` and capture exit code; abort update if backup fails
- [ ] Store backup path in `BACKUP_FILE` variable for rollback message
- [ ] Tag current commit locally as `rollback/<timestamp>` so it's easy to find

### Task B3 — Pull and build

- [ ] `git -C "$INSTALL_DIR" pull --ff-only origin main`
- [ ] Detect migration changes: `git diff HEAD@{1}..HEAD -- backend/prisma/migrations/ | grep "^+" | wc -l`
- [ ] If migrations detected, warn user and ask confirmation (or auto-confirm with `--yes` flag)
- [ ] Run `$COMPOSE build` (not `--no-cache` for speed, but support `--no-cache` flag)

### Task B4 — Deploy with health check + rollback

- [ ] `$COMPOSE up -d` — entrypoint runs `prisma migrate deploy` automatically
- [ ] Poll health endpoint for up to 120s
- [ ] If health check fails → run rollback:
  - `git -C "$INSTALL_DIR" checkout rollback/<timestamp>`
  - `$COMPOSE build && $COMPOSE up -d`
  - Print restore instructions referencing `$BACKUP_FILE`
- [ ] On success: print new version, changelog, and confirmation

---

## Subsystem C — Documentation refresh

**Files:**
- Modify: `docs/SYSADMIN_MANUAL.md`
- Modify: `docs/SYSADMIN_MANUAL.en.md`
- Modify: `docs/USER_MANUAL.md`
- Modify: `docs/USER_MANUAL.en.md`
- Modify: `DEPLOY.md` and `DEPLOY.en.md` (merge content into SYSADMIN_MANUAL, keep as pointer)

### Task C1 — SYSADMIN_MANUAL.md rewrite

Add/update sections:
- Section 0: Quick-start (3 commands: clone, run install.sh, open browser)
- Section 2 (Installation): full install.sh guide with OS-specific notes table
- New section: OpenShift / Kubernetes deployment notes
- Section 8 (Updates): update.sh guide, flags, rollback procedure
- Section 11 (DB): note that migrations run automatically on start; manual override with `prisma migrate deploy`

### Task C2 — USER_MANUAL.md rewrite

Goals: plain language, no terminal commands, focus on workflows.
- Rewrite intro: what CMDB is, who it's for, how to log in
- Section 16 (Audit Log): already updated; verify matches current UI
- New section: License Masters management (create/edit/delete metrics and types)
- Sidebar navigation section: update to reflect new order
- General tone pass: replace technical jargon with plain Spanish

### Task C3 — English equivalents

- Mirror C1 changes into `SYSADMIN_MANUAL.en.md`
- Mirror C2 changes into `USER_MANUAL.en.md`
