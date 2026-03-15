# ─────────────────────────────────────────────────────────────────────────────
# frontend/Dockerfile  — Multi-stage build (production-hardened)
#
# Stage 1 (deps):    install npm dependencies (cached layer)
# Stage 2 (builder): compile Next.js → standalone output
# Stage 3 (runner):  minimal runtime image — non-root user, no source code
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Deps ────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps

ENV NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

COPY package*.json ./
RUN npm ci

# ── Stage 2: Builder ─────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

ENV NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* vars are baked into the client bundle at build time.
# Pass the public backend URL so the browser can reach the API.
ARG NEXT_PUBLIC_API_URL=http://localhost:3000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

RUN npm run build

# ── Stage 3: Runner ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

RUN apk add --no-cache dumb-init

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001
# Required by Next.js standalone server to bind on all interfaces
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1

# Copy only the standalone bundle (no node_modules, no source code)
COPY --from=builder /app/.next/standalone ./

# Static assets (CSS, JS chunks) — must be served at /.next/static/
COPY --from=builder /app/.next/static ./.next/static

# Public assets (favicon, icons, SVGs)
COPY --from=builder /app/public ./public

# ── Security: run as non-root node user ──────────────────────────────────────
RUN chown -R node:node /app
USER node

EXPOSE 3001

# dumb-init as PID 1 — correct SIGTERM forwarding to Node.js
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "server.js"]
