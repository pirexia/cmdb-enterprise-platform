# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — Dependencies: cache npm install layer separately
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps

# Silence npm update advertisements
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

COPY package*.json ./
RUN npm ci

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — Builder: compile Next.js (standalone mode)
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

# Silence npm update advertisements
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_* variables are baked into the client-side JS bundle at build time.
# Pass the public API URL so the browser knows where to reach the backend.
ARG NEXT_PUBLIC_API_URL=http://localhost:3000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

RUN npm run build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 3 — Runner: minimal production image using Next.js standalone output
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001
# Required by Next.js standalone server to listen on all interfaces
ENV HOSTNAME=0.0.0.0

# The standalone build is a self-contained Node.js server
COPY --from=builder /app/.next/standalone ./

# Static assets must be copied separately
COPY --from=builder /app/.next/static ./.next/static

# Public assets (favicon, SVGs, etc.)
COPY --from=builder /app/public ./public

EXPOSE 3001

# Next.js standalone server entry point
CMD ["node", "server.js"]
