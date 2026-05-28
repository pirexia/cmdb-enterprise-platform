#!/bin/sh
# Entrypoint for the CMDB backend container.
# Runs Prisma migrations, seeds on first deploy, then starts the API server.
set -e

echo "=========================================="
echo "  CMDB Enterprise Platform — Backend"
echo "=========================================="

echo ""
echo "▶  Ensuring document storage directory exists..."
mkdir -p "${DOCUMENTS_DIR:-/app/documents}"
chmod 775 "${DOCUMENTS_DIR:-/app/documents}" 2>/dev/null || true

echo ""
echo "▶  Running Prisma migrations (migrate deploy)..."
npx prisma migrate deploy

echo ""
echo "▶  Checking if initial seed is required..."
USER_COUNT=$(node -e "
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.user.count()
  .then(n => { process.stdout.write(String(n)); return p.\$disconnect(); })
  .catch(() => { process.stdout.write('0'); });
")

if [ "$USER_COUNT" = "0" ]; then
  echo "▶  No users found — running initial seed..."
  node dist/prisma/seed.js
  echo "✅ Seed completed."
else
  echo "   Database already seeded (${USER_COUNT} users) — skipping."
fi

echo ""
echo "▶  Starting API server on port ${PORT:-3000}..."
exec node dist/src/index.js
