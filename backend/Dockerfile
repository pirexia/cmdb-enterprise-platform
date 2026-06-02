# ─────────────────────────────────────────────────────────────────────────────
# backend/Dockerfile  — Multi-stage build (production-hardened)
#
# Stage 1 (builder): full dev-deps + tsc + prisma generate
# Stage 2 (runner):  only production deps + compiled output — non-root user
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Builder ─────────────────────────────────────────────────────────
FROM docker.io/library/node:22-alpine AS builder

# openssl: Prisma query engine. tesseract-ocr + poppler-utils: OCR build-time tools
# (needed so node-tesseract-ocr can locate the binary path during npm ci)
RUN apk add --no-cache openssl tesseract-ocr poppler-utils

ENV NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

# Install ALL deps (devDeps needed for tsc + prisma generate)
COPY package*.json ./
RUN npm ci && npm cache clean --force

COPY . .

# Generate Prisma client
RUN npx prisma generate

# Compile TypeScript → dist/
RUN npm run build

# ── Stage 2: Runner ──────────────────────────────────────────────────────────
FROM docker.io/library/node:22-alpine AS runner

# openssl: Prisma. dumb-init: PID 1 signal handling.
# tesseract-ocr + language packs: OCR for scanned PDFs (fallback in docParser).
# poppler-utils: pdftoppm to rasterise PDF pages before Tesseract.
RUN apk add --no-cache \
      openssl \
      dumb-init \
      tesseract-ocr=5.5.1-r0 \
      tesseract-ocr-data-eng=5.5.1-r0 \
      tesseract-ocr-data-spa=5.5.1-r0 \
      tesseract-ocr-data-deu=5.5.1-r0 \
      tesseract-ocr-data-por=5.5.1-r0 \
      tesseract-ocr-data-fra=5.5.1-r0 \
      tesseract-ocr-data-ita=5.5.1-r0 \
      tesseract-ocr-data-osd=5.5.1-r0 \
      poppler-utils=25.12.0-r0

ENV NPM_CONFIG_UPDATE_NOTIFIER=false
ENV NODE_ENV=production

WORKDIR /app

# Install production + prisma CLI deps (prisma migrate deploy runs at startup)
COPY package*.json ./
RUN npm ci --omit=dev && npm install prisma && npm cache clean --force

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
