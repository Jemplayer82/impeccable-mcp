FROM node:22-trixie-slim

# Chromium + the runtime lib list proven by gsd-browser-mcp (same job shape:
# headless Chrome behind an MCP server, same base for GLIBC 2.39 parity).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    curl \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libxss1 \
    && rm -rf /var/lib/apt/lists/*

# Use the apt-installed Chromium instead of letting puppeteer download its own
# Chrome-for-Testing binary — smaller image, one browser to keep patched.
# Unlike gsd-browser-mcp (which shells out to a CLI with no args passthrough
# and needs a chromium-wrapper shim for --no-sandbox), this server drives
# puppeteer directly and passes launch args itself (see src/scan.mjs), so no
# wrapper script is needed here.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src

# Non-root, with a real home dir — puppeteer/Chromium write cache/profile
# data under $HOME at runtime.
RUN useradd --create-home --shell /bin/bash impeccable \
    && chown -R impeccable:impeccable /app
USER impeccable

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=20s \
    CMD curl -sf http://localhost:8000/healthz || exit 1

# No dumb-init/tini binary baked in here: this server spawns Chromium as a
# child process, so *something* needs to reap zombies as PID 1. That's
# provided at the container-runtime level instead — `init: true` in compose
# (Docker's built-in tini) — not inside the image. Running this image with
# `docker run` directly (no --init) will leak zombie processes.
CMD ["node", "src/server.mjs"]
