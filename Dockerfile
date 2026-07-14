# Use Microsoft Playwright image as base image
# Node version is v22
FROM mcr.microsoft.com/playwright:v1.61.1-noble

# Installation of packages for oobee
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    unzip \
    zip \
    xvfb && \
    rm -rf /var/lib/apt/lists/*

# Install Playwright browsers
RUN npx playwright install chromium

# =============================================================================
# Google Chrome installation for Safe Browsing support
# =============================================================================
# WHY: Chrome's Safe Browsing (v5, hash-real-time protocol) protects users by
#      checking URLs against Google's threat database in real-time via OHTTP.
#      This is a Chrome-only feature — Chromium does NOT include it because it
#      requires Google's proprietary API keys baked into the Chrome build.
#
# HOW IT WORKS:
#   Chrome needs a local hash-prefix database (UrlSoceng.store.*) to know which
#   URLs require a real-time lookup via the v5 API. Without this DB, Chrome skips
#   the check entirely. The DB is downloaded by Chrome when Safe Browsing is
#   enabled and the browser runs with network access.
#
# ARCHITECTURE LIMITATION:
#   Google Chrome .deb packages are only available for amd64 (x86_64).
#   On arm64 builds, this step is skipped and Safe Browsing will not be available.
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

# Pre-seed Safe Browsing hash-prefix database into the image.
# Chrome needs Xvfb (virtual display) to run non-headless and download the DB.
# Under emulation this can take several minutes; timeout is set to 1800s.
COPY <<'SEEDSCRIPT' /tmp/seed-safe-browsing.sh
#!/bin/bash
set -e
mkdir -p /opt/oobee-safe-browsing/Default
echo '{"safebrowsing":{"enabled":true,"enhanced":true}}' > /opt/oobee-safe-browsing/Default/Preferences
export DISPLAY=:99
Xvfb :99 -screen 0 1024x768x24 &
XVFB_PID=$!
sleep 2
google-chrome \
  --user-data-dir=/opt/oobee-safe-browsing \
  --no-first-run --no-default-browser-check --disable-extensions \
  --no-sandbox --disable-setuid-sandbox \
  --enable-features=SafeBrowsingEnhancedProtection \
  --window-position=-10000,-10000 --window-size=1,1 \
  about:blank &
CHROME_PID=$!
echo "Waiting for Safe Browsing DB to download (up to 1800s)..."
WAITED=0
while [ $WAITED -lt 1800 ]; do
  if ls /opt/oobee-safe-browsing/Safe\ Browsing/UrlSoceng.store.* >/dev/null 2>&1 || \
     ls /opt/oobee-safe-browsing/Safe\ Browsing/UrlMalware.store.* >/dev/null 2>&1; then
    echo "Safe Browsing DB downloaded successfully (${WAITED}s)"
    break
  fi
  sleep 10
  WAITED=$((WAITED + 10))
  echo "[${WAITED}s] Still waiting... $(ls /opt/oobee-safe-browsing/Safe\ Browsing/ 2>/dev/null | wc -l) files in Safe Browsing dir"
done
kill $CHROME_PID 2>/dev/null || true
kill $XVFB_PID 2>/dev/null || true
if ls /opt/oobee-safe-browsing/Safe\ Browsing/UrlSoceng.store.* >/dev/null 2>&1; then
  echo "Safe Browsing DB baked into image"
else
  echo "WARNING: Safe Browsing DB did not populate - will attempt at runtime"
fi
SEEDSCRIPT
RUN if [ "$(dpkg --print-architecture)" = "amd64" ] && command -v google-chrome >/dev/null 2>&1; then \
      bash /tmp/seed-safe-browsing.sh; \
    fi && rm -f /tmp/seed-safe-browsing.sh && \
    chmod -R a+rX /opt/oobee-safe-browsing 2>/dev/null || true

# --- App code (changes here don't invalidate Chrome/seed layers above) ---

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
