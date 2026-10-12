# Use Microsoft Playwright image as base image
# Node version is v22
FROM mcr.microsoft.com/playwright:v1.61.1-noble


# Installation of packages for oobee.
# Also upgrade all pre-installed packages from the Playwright base image to pick
# up security fixes available in the Ubuntu archive (remediates the bulk of
# category-A CVEs surfaced by Trivy).
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    git \
    unzip \
    zip \
    && rm -rf /var/lib/apt/lists/*

# =============================================================================
# Google Chrome installation for Safe Browsing support
# =============================================================================
# WHY: Chrome downloads local hash-prefix threat databases (UrlSoceng, UrlMalware)
#      at runtime using standard protection mode. These databases enable local URL
#      matching to block phishing/malware pages.
#      This is Chrome-only; Chromium lacks the required proprietary API keys.
#
# SUPPORTED ARCHITECTURES:
#   Chrome .deb packages are available for amd64 (x86_64) and arm64 (aarch64).
#   Other architectures will skip this step and Safe Browsing will not be available.
#
# TO ENABLE: Set env var GOOGLE_SAFE_BROWSING=1 when running the container.
# =============================================================================
# INTEGRITY (asgard-0006, 2026-10-09 scan): Chrome is installed from Google's
# signed apt repository, so apt verifies the package's GPG signature. The
# signing key itself is pinned by fingerprint: the build fails if the key
# served by dl.google.com is not Google's Linux package signing key.
ARG GOOGLE_LINUX_SIGNING_KEY_FPR=EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796
RUN ARCH="$(dpkg --print-architecture)"; \
    if [ "$ARCH" = "amd64" ] || [ "$ARCH" = "arm64" ]; then \
      set -e; \
      apt-get update && apt-get install -y --no-install-recommends gnupg ca-certificates && \
      wget -q -O /tmp/google.pub https://dl.google.com/linux/linux_signing_key.pub && \
      FPR="$(gpg --show-keys --with-colons /tmp/google.pub | awk -F: '$1=="fpr"{print $10; exit}')" && \
      if [ "$FPR" != "$GOOGLE_LINUX_SIGNING_KEY_FPR" ]; then \
        echo "ERROR: unexpected Google signing key fingerprint: $FPR"; exit 1; \
      fi && \
      gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg /tmp/google.pub && \
      echo "deb [arch=${ARCH} signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
        > /etc/apt/sources.list.d/google-chrome.list && \
      apt-get update && apt-get install -y --no-install-recommends google-chrome-stable && \
      rm -f /tmp/google.pub && rm -rf /var/lib/apt/lists/*; \
    else \
      echo "NOTICE: Skipping Chrome install (Safe Browsing unavailable on $ARCH)"; \
    fi

# =============================================================================
# Purge unused media / codec stacks pulled in by the Playwright base image.
# Oobee scans with Chrome (bundled codecs) and does not use Playwright's video
# recorder or ffmpeg pipeline, so these libraries are dead weight and account
# for roughly half of the CVEs surfaced by Trivy (incl. the sole HIGH from
# gstreamer-plugins-bad, CVE-2025-3887). "|| true" so a missing package on a
# future base image bump doesn't fail the build.
# =============================================================================
RUN apt-get update && \
    apt-get purge -y --auto-remove \
      'libavcodec*' 'libavformat*' 'libavfilter*' 'libavutil*' \
      'libswresample*' 'libswscale*' 'libpostproc*' \
      'libgstreamer-plugins-bad*' 'gstreamer1.0-plugins-bad*' \
      'libde265-0' 'libopenexr*' 'libwavpack*' \
      'libx264-*' 'libvo-amrwbenc*' 'libopenh264-*' \
      'libzvbi0*' 'libsndfile1' \
      'libsoup-3.0-*' 'libduktape*' \
      || true; \
    rm -rf /var/lib/apt/lists/*

# Update system npm to the latest release. The bundled npm under
# /usr/lib/node_modules/npm ships older copies of tar, undici, brace-expansion,
# and sigstore that Trivy flags; upgrading npm replaces all of them in one shot.
RUN npm install -g npm@latest && npm cache clean --force

# --- App code (changes here don't invalidate Chrome layers above) ---

# Environment variables for node and Playwright
ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD="true"
# npm >=12 changed the default of `allow-git` from "all" to "none" as a
# hardening. Oobee has one legitimate git dep (pdfjs-dist -> veraPDF fork), so
# opt back in with "root" — only git deps declared in this project's own
# package.json are permitted; transitive git deps remain blocked.
ENV NPM_CONFIG_ALLOW_GIT=root

# Add non-privileged user before app copy so ownership can be set during COPY.
# Also pre-create the Safe Browsing profile directory owned by `purple` so the
# warmup step below (which runs Chrome — Chrome refuses to launch as root
# without --no-sandbox) can write to it without a later root switch.
RUN groupadd -r purple && useradd -r -g purple purple && \
  mkdir -p /home/purple /app/oobee /data/chrome-profile && \
  chown purple:purple /home/purple /app /app/oobee /data /data/chrome-profile

WORKDIR /app/oobee

# Run app build steps as non-root to avoid a full recursive chown later.
USER purple

# Install dependencies first (cached unless package.json/package-lock.json change)
COPY --chown=purple:purple package.json package-lock.json ./
RUN npm install --omit=dev

# git is only needed at build time to resolve the pdfjs-dist git dependency
# above. Removing it after `npm install` drops CVE-2024-52005 (sideband payload)
# without affecting runtime — oobee does not shell out to git.
USER root
RUN apt-get purge -y --auto-remove git git-man || true; \
    rm -rf /var/lib/apt/lists/*
USER purple

# Install Playwright browsers no longer needed since we are using Google Chrome for Safe Browsing
# RUN npx playwright install chromium

# Copy source and compile TypeScript
COPY --chown=purple:purple . .
RUN npm run build || true # true exits with code 0 - workaround for TS errors

# Pre-warm Safe Browsing DB at build time so concurrent scans don't each
# trigger a 10 minutes warmup (or fight over a lock). The DB is baked into the image.
# Runs as `purple` (not root) so Chrome will launch — Chrome refuses to run as
# root without --no-sandbox, which we intentionally dropped from the warmup args.
RUN ARCH="$(dpkg --print-architecture)"; \
    if [ "$ARCH" = "amd64" ] || [ "$ARCH" = "arm64" ]; then \
      GOOGLE_SAFE_BROWSING=1 SB_PROFILE_DIR=/data/chrome-profile node scripts/warmup-safe-browsing.mjs --timeout 1200000; \
    else \
      echo "NOTICE: Skipping Safe Browsing warmup (unsupported architecture: $ARCH)"; \
    fi
