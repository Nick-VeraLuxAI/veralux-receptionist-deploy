# VeraLux control plane — container image
# Build context: repo root (set in docker-compose.yml)
# Build: docker compose build control
# Run with docker-compose (app + db + redis).

FROM node:20-alpine AS builder

WORKDIR /app

# 1. Copy workspace root + shared package manifest
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY control-plane/package.json control-plane/package-lock.json* control-plane/

# 2. Install deps (workspace-aware)
RUN npm ci -w control-plane -w @veralux/shared --ignore-scripts

# 3. Build shared package first
COPY shared/ shared/
RUN npm run build -w @veralux/shared

# 4. Copy control plane source and build
COPY control-plane/tsconfig.json control-plane/
COPY control-plane/src control-plane/src/
COPY control-plane/migrations control-plane/migrations/
COPY control-plane/scripts control-plane/scripts/
COPY control-plane/public control-plane/public/

WORKDIR /app/control-plane
RUN npm run build

# ---

FROM node:20-alpine

# Install wget for health check
RUN apk add --no-cache wget

# Create non-root user
RUN addgroup -g 1001 -S veralux && \
    adduser -S veralux -u 1001 -G veralux

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000

# Copy workspace root + shared manifest for production install
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY control-plane/package.json control-plane/

RUN npm ci -w control-plane -w @veralux/shared --omit=dev --ignore-scripts

# Copy built artifacts
COPY --from=builder /app/shared/dist shared/dist/
COPY --from=builder /app/control-plane/dist control-plane/dist/
COPY --from=builder /app/control-plane/migrations control-plane/migrations/
COPY --from=builder /app/control-plane/scripts control-plane/scripts/
COPY --from=builder /app/control-plane/public control-plane/public/

WORKDIR /app/control-plane

RUN chmod +x scripts/docker-entrypoint.sh

# Set ownership and switch to non-root user
RUN chown -R veralux:veralux /app
USER veralux

EXPOSE 4000
STOPSIGNAL SIGTERM

ENTRYPOINT ["/app/control-plane/scripts/docker-entrypoint.sh"]
