# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — Build: install all deps, generate Prisma client, compile TypeScript
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install deps (including devDeps — needed for tsc + prisma generate)
COPY package*.json ./
RUN npm ci

COPY . .

# Generate Prisma client (writes to node_modules/.prisma/)
RUN npx prisma generate

# Compile TypeScript → dist/   (outDir = "dist" per tsconfig.json)
RUN npm run build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — Runner: lean production image
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Install ALL deps again in the runner so that:
#   • prisma CLI is available for `migrate deploy` in the entrypoint
#   • @prisma/client (runtime dep) is present
COPY package*.json ./
RUN npm ci

# Overwrite .prisma with the generated client from the build stage
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# Compiled application code (dist/src/index.js)
COPY --from=builder /app/dist ./dist

# Prisma schema + migration files (required by `prisma migrate deploy`)
COPY --from=builder /app/prisma ./prisma

# Startup script
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["./entrypoint.sh"]
