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

# --- App code (changes here don't invalidate Chrome layer above) ---

WORKDIR /app/oobee

# Environment variables for node and Playwright
ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD="true"

# Install dependencies first (cached unless package.json/package-lock.json change)
COPY package.json package-lock.json ./
RUN npm install --omit=dev

# Copy source and compile TypeScript
COPY . .
RUN npm run build || true # true exits with code 0 - workaround for TS errors

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

# For oobee to be run from present working directory, comment out as necessary
WORKDIR /app/oobee

# Run everything after as non-privileged user.
USER purple
