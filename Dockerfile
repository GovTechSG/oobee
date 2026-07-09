# Use Microsoft Playwright image as base image
# Node version is v22
FROM mcr.microsoft.com/playwright:v1.61.1-noble

# Installation of packages for oobee
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    unzip \
    zip && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app/oobee

# Clone oobee repository
# RUN git clone --branch master https://github.com/GovTechSG/oobee.git /app/oobee

# OR Copy oobee files from local directory
COPY . .

# Environment variables for node and Playwright
ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD="true"

# Install oobee dependencies
# TODO: Move back to npm ci --omit=dev once module package-lock issue vs MacOS is resolved
RUN npm install --omit=dev

# Compile TypeScript for oobee
RUN npm run build || true # true exits with code 0 - workaround for TS errors

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
# HOW IT WORKS (modern Chrome 128+):
#   Chrome no longer downloads a local threat database (UrlSoceng.store.* files).
#   Instead, it performs real-time hash-prefix lookups via the Safe Browsing v5
#   API using OHTTP (Oblivious HTTP) for privacy. This means:
#     - No warmup/pre-seeding of a threat database is needed
#     - Safe Browsing activates immediately on first navigation
#     - The only requirements are: (1) Chrome (not Chromium), (2) safebrowsing
#       enabled in Preferences, (3) network flags not suppressed
#
# ARCHITECTURE LIMITATION:
#   Google Chrome .deb packages are only available for amd64 (x86_64).
#   As of July 2026, Google has announced ARM64 Linux Chrome but has not yet
#   published it to their apt repository or direct download URL.
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

# Pre-seed Safe Browsing threat database into the image.
# Chrome needs to run non-headless to download the hash-prefix DB (UrlSoceng.store.*).
# We use Xvfb to provide a virtual display, then wait up to 180s for the DB to appear.
# The seeded DB at /opt/oobee-safe-browsing/ is copied into browser profiles at runtime.
COPY <<'SEEDSCRIPT' /tmp/seed-safe-browsing.sh
#!/bin/bash
set -e
apt-get update && apt-get install -y --no-install-recommends xvfb && rm -rf /var/lib/apt/lists/*
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
  --window-position=-10000,-10000 --window-size=1,1 \
  about:blank &
CHROME_PID=$!
echo "Waiting for Safe Browsing DB to download..."
WAITED=0
while [ $WAITED -lt 180 ]; do
  if ls /opt/oobee-safe-browsing/Safe\ Browsing/UrlSoceng.store.* >/dev/null 2>&1 || \
     ls /opt/oobee-safe-browsing/Safe\ Browsing/UrlMalware.store.* >/dev/null 2>&1; then
    echo "Safe Browsing DB downloaded successfully (${WAITED}s)"
    break
  fi
  sleep 5
  WAITED=$((WAITED + 5))
done
kill $CHROME_PID 2>/dev/null || true
kill $XVFB_PID 2>/dev/null || true
if ls /opt/oobee-safe-browsing/Safe\ Browsing/UrlSoceng.store.* >/dev/null 2>&1; then
  echo "Safe Browsing DB baked into image"
else
  echo "WARNING: Safe Browsing DB did not populate - will attempt at runtime"
fi
apt-get purge -y xvfb && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
SEEDSCRIPT
RUN if [ "$(dpkg --print-architecture)" = "amd64" ] && command -v google-chrome >/dev/null 2>&1; then \
      bash /tmp/seed-safe-browsing.sh; \
    fi && rm -f /tmp/seed-safe-browsing.sh && \
    chmod -R a+rX /opt/oobee-safe-browsing 2>/dev/null || true

# Add non-privileged user
# Create a group named "purple"
RUN groupadd -r purple

# Create a user named "purple" and assign it to the group "purple"
RUN useradd -r -g purple purple

# Create a dedicated directory for the "purple" user and set permissions
RUN mkdir -p /home/purple && chown -R purple:purple /home/purple

WORKDIR /app

# Set the ownership of the oobee directory to the user "purple"
RUN chown -R purple:purple /app

# Copy any application and support files
# COPY . .

# Install any app dependencies for your application
# RUN npm ci --omit=dev

# For oobee to be run from present working directory, comment out as necessary
WORKDIR /app/oobee

# Run everything after as non-privileged user.
USER purple
