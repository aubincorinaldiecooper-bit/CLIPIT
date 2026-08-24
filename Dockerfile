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

# ffmpeg brings ffprobe with it. python3 + venv host yt-dlp: the standalone
# binary cannot load plugin packages, and the PO-token provider that gets past
# YouTube's bot check is distributed as one.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        fonts-liberation \
        fonts-dejavu-core \
        ca-certificates \
        curl \
        python3 \
        python3-venv \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp tracks YouTube's changes continuously and YouTube breaks old versions
# deliberately, so expect this pin to move often — a stale yt-dlp fails for
# reasons that were fixed upstream months earlier.
#
# Three packages, each solving a different YouTube obstacle:
#   yt-dlp      the extractor itself
#   yt-dlp-ejs  the JavaScript components that solve YouTube's signature
#               challenges. A pip install does not bundle these the way the
#               official standalone executable does, and without them YouTube
#               extraction fails no matter what else is configured.
#   bgutil-…    mints the Proof-of-Origin tokens YouTube demands from flagged
#               IP ranges, which is most of any cloud host. Inert unless
#               YTDLP_POT_BASE_URL points at a provider server.
ENV YTDLP_HOME=/opt/ytdlp
ARG YTDLP_VERSION=2026.07.04
RUN set -eux; \
    python3 -m venv "${YTDLP_HOME}"; \
    "${YTDLP_HOME}/bin/pip" install --no-cache-dir --upgrade pip; \
    "${YTDLP_HOME}/bin/pip" install --no-cache-dir \
        "yt-dlp==${YTDLP_VERSION}" \
        yt-dlp-ejs \
        bgutil-ytdlp-pot-provider; \
    ln -sf "${YTDLP_HOME}/bin/yt-dlp" /usr/local/bin/yt-dlp; \
    yt-dlp --version; \
    # Assert the pieces are actually wired up, so a broken image fails the
    # build here instead of failing every YouTube job in production. `yt-dlp
    # --version` exits before printing the debug block, and `--simulate` with
    # no URL prints it and then exits non-zero, hence the `|| true`.
    probe="$(yt-dlp --verbose --js-runtimes node --simulate 2>&1 || true)"; \
    echo "${probe}" | grep -q 'yt_dlp_ejs'; \
    echo "${probe}" | grep -q 'JS runtimes: node'; \
    "${YTDLP_HOME}/bin/python" -c 'import yt_dlp_plugins.extractor.getpot_bgutil_http'; \
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
