# ─────────────────────────────────────────────────────────────────────────────
# backend/Dockerfile  — Multi-stage build (production-hardened)
#
# Stage 1 (builder): full dev-deps + tsc + prisma generate
# Stage 2 (runner):  only production deps + compiled output — non-root user
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

# openssl is required by Prisma query engine on Alpine
RUN apk add --no-cache openssl

ENV NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

# Install ALL deps (devDeps needed for tsc + prisma generate)
COPY package*.json ./
RUN npm ci

COPY . .

# Generate Prisma client
RUN npx prisma generate

# Compile TypeScript → dist/
RUN npm run build

# ── Stage 2: Runner ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

# openssl required by Prisma query engine at runtime
RUN apk add --no-cache openssl dumb-init

ENV NPM_CONFIG_UPDATE_NOTIFIER=false
ENV NODE_ENV=production

WORKDIR /app

# Install production + prisma CLI deps (prisma migrate deploy runs at startup)
COPY package*.json ./
RUN npm ci --omit=dev && npm install prisma

# Copy Prisma generated client from builder
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# Compiled application
COPY --from=builder /app/dist ./dist

# Prisma schema + migrations (for migrate deploy)
COPY --from=builder /app/prisma ./prisma

# Startup script
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

# ── Security: run as non-root node user ──────────────────────────────────────
# node:alpine ships with a pre-created "node" user (uid 1000)
RUN chown -R node:node /app
USER node

EXPOSE 3000

# dumb-init as PID 1 for correct signal handling (SIGTERM → graceful shutdown)
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["./entrypoint.sh"]
