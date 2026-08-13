# syntax=docker/dockerfile:1

# ---------- build ----------
FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src

RUN npm run build

# Drop dev dependencies from the tree we copy into the runtime image.
RUN npm prune --omit=dev

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    WORK_DIR=/tmp/clipit

# ffmpeg brings ffprobe with it. ca-certificates + curl are needed to fetch
# yt-dlp; python3 is yt-dlp's runtime for the non-static builds.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        ca-certificates \
        curl \
        python3 \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp ships standalone binaries; pick the one matching the build platform.
ARG TARGETARCH=amd64
ARG YTDLP_VERSION=2025.01.26
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) asset="yt-dlp_linux" ;; \
      arm64) asset="yt-dlp_linux_aarch64" ;; \
      *) asset="yt-dlp" ;; \
    esac; \
    curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${asset}" -o /usr/local/bin/yt-dlp; \
    chmod +x /usr/local/bin/yt-dlp; \
    yt-dlp --version; \
    ffmpeg -version | head -1; \
    ffprobe -version | head -1

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# Transient ffmpeg / yt-dlp scratch space; nothing durable is kept here.
RUN mkdir -p /tmp/clipit && chown -R node:node /tmp/clipit /app

USER node

EXPOSE 3000

# Overridden per Railway service: the API service runs start:api, the worker
# service runs start:worker, from this same image.
CMD ["npm", "run", "start:api"]
