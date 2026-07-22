# Use Microsoft Playwright image as base image
# Node version is v22
FROM mcr.microsoft.com/playwright:v1.61.1-noble


# Installation of packages for oobee
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    unzip \
    zip \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    openbox \
    procps \
    libnss3-tools && \
    rm -rf /var/lib/apt/lists/*

# Install Playwright browsers
RUN npx playwright install chromium

# =============================================================================
# Google Chrome installation for Safe Browsing support
# =============================================================================
# WHY: Chrome downloads local hash-prefix threat databases (UrlSoceng, UrlMalware)
#      at runtime using standard protection mode. These databases enable local URL
#      matching to block phishing/malware pages.
#      This is Chrome-only; Chromium lacks the required proprietary API keys.
#
# ARCHITECTURE LIMITATION:
#   Chrome .deb packages are only available for amd64 (x86_64).
#   On arm64 builds this step is skipped and Safe Browsing will not be available.
#
# TO ENABLE: Set env var GOOGLE_SAFE_BROWSING=1 when running the container.
# =============================================================================
RUN if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
      wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && \
      apt-get update && apt-get install -y --no-install-recommends /tmp/chrome.deb && \
      rm -f /tmp/chrome.deb && rm -rf /var/lib/apt/lists/*; \
    else \
      echo "NOTICE: Skipping Chrome install (Safe Browsing unavailable on $(dpkg --print-architecture))"; \
    fi


# --- noVNC entrypoint ---
EXPOSE 6080 5900

# --- App code (changes here don't invalidate Chrome layers above) ---

# Environment variables for node and Playwright
ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD="true"

# Add non-privileged user before app copy so ownership can be set during COPY.
RUN groupadd -r purple && useradd -r -g purple purple && \
  mkdir -p /home/purple /app/oobee && chown purple:purple /home/purple /app /app/oobee

WORKDIR /app/oobee

# Run app build steps as non-root to avoid a full recursive chown later.
USER purple

# Install dependencies first (cached unless package.json/package-lock.json change)
COPY --chown=purple:purple package.json package-lock.json ./
RUN npm install --omit=dev

# Copy source and compile TypeScript
COPY --chown=purple:purple . .
RUN npm run build || true # true exits with code 0 - workaround for TS errors

# Pre-warm Safe Browsing DB at build time so concurrent scans don't each
# trigger a 180s warmup (or fight over a lock). The DB is baked into the image.
USER root
RUN if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
      GOOGLE_SAFE_BROWSING=1 OOBEE_VERBOSE=1 SB_PROFILE_DIR=/data/chrome-profile node scripts/warmup-safe-browsing.mjs --timeout 300000; \
    else \
      echo "NOTICE: Skipping Safe Browsing warmup (not amd64)"; \
    fi
RUN chown -R purple:purple /data/chrome-profile 2>/dev/null || true
USER purple
