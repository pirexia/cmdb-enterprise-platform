#!/usr/bin/env bash
# Exports GIT_TAG and GIT_COMMIT from the current git repo.
# Usage: source scripts/get-version.sh
# Then: podman-compose up -d --build
set -euo pipefail

export GIT_TAG
GIT_TAG=$(git describe --tags --always 2>/dev/null || echo "unknown")

export GIT_COMMIT
GIT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

echo "[get-version] GIT_TAG=${GIT_TAG}  GIT_COMMIT=${GIT_COMMIT}"
