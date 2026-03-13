#!/bin/sh
# Entrypoint for the CMDB backend container.
# Runs Prisma migrations before starting the API server.
set -e

echo "=========================================="
echo "  CMDB Enterprise Platform — Backend"
echo "=========================================="

echo ""
echo "▶  Running Prisma migrations (migrate deploy)..."
npx prisma migrate deploy

echo ""
echo "▶  Starting API server on port ${PORT:-3000}..."
exec node dist/src/index.js
