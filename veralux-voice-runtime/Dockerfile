# syntax=docker/dockerfile:1
# VeraLux voice runtime — container image
# Build context: repo root (set in docker-compose.yml)
# Build: docker compose build runtime

FROM node:20-bookworm-slim AS base

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app

# Install build/runtime dependencies required by native modules (wrtc, onnxruntime, opus, etc.)
# wget is needed for Docker health checks
# libspeexdsp-dev provides SpeexDSP for Acoustic Echo Cancellation (AEC)
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
      pkg-config \
      libopus0 \
      libgomp1 \
      libspeexdsp-dev \
      ffmpeg \
      wget && \
    rm -rf /var/lib/apt/lists/*

FROM base AS deps

# Copy workspace root + shared package manifest
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY veralux-voice-runtime/package.json veralux-voice-runtime/package-lock.json* veralux-voice-runtime/

# Install all dependencies (including devDependencies for build)
RUN npm ci -w veralux-voice-runtime -w @veralux/shared

FROM deps AS build

# Build shared package first
COPY shared/ shared/
RUN npm run build -w @veralux/shared

# Copy runtime source and build
COPY veralux-voice-runtime/ veralux-voice-runtime/
WORKDIR /app/veralux-voice-runtime
RUN npm run build

# Copy Silero VAD model into dist/ so the runtime can find it at runtime
RUN mkdir -p dist/stt/vad/models && \
    cp -f src/stt/vad/models/silero_vad.onnx dist/stt/vad/models/silero_vad.onnx 2>/dev/null || true

# Strip devDependencies after the build completes to shrink the final image.
WORKDIR /app
RUN npm prune -w veralux-voice-runtime -w @veralux/shared --omit=dev

FROM base AS runner

# Create non-root user
RUN groupadd -g 1001 veralux && \
    useradd -u 1001 -g veralux -s /bin/sh -m veralux

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/shared/dist shared/dist/
COPY --from=build /app/shared/package.json shared/
COPY --from=build /app/veralux-voice-runtime/node_modules ./veralux-voice-runtime/node_modules
COPY --from=build /app/veralux-voice-runtime/dist ./veralux-voice-runtime/dist
COPY --from=build /app/veralux-voice-runtime/public ./veralux-voice-runtime/public
COPY veralux-voice-runtime/package.json veralux-voice-runtime/
COPY package.json ./

# Create audio storage directory and set ownership
RUN mkdir -p /app/audio && chown -R veralux:veralux /app

# Switch to non-root user
USER veralux

WORKDIR /app/veralux-voice-runtime

EXPOSE 4001

CMD ["node", "dist/index.js"]
