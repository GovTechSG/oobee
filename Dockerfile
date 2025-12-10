# Use Microsoft Playwright image as base image
FROM mcr.microsoft.com/playwright:v1.55.0-noble

# 1. Install System Deps & dumb-init
RUN apt-get update && apt-get install -y \
    git=1:2.43.0-1ubuntu7.3 \
    unzip=6.0-28ubuntu4.1 \
    zip=3.0-13ubuntu0.2 \
 && rm -rf /var/lib/apt/lists/*

# 2. Setup User & Directories FIRST
# We create the directory structure now so we can use it for COPY later
RUN groupadd -r purple && useradd -r -g purple purple \
    && mkdir -p /app/oobee /home/purple \
    && chown -R purple:purple /home/purple /app

WORKDIR /app/oobee

# --- OPTIMIZATION: Early Environment Setup ---
# Must be set BEFORE 'npm run' commands for caching to work
ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD="true"
ENV NODE_OPTIONS="--dns-result-order=ipv4first --no-warnings --max-old-space-size=4096"
ENV NODE_COMPILE_CACHE=/app/oobee/.node_compile_cache

# --- OPTIMIZATION: Docker Layer Caching ---
# Copy ONLY package files first.
# If package.json hasn't changed, Docker uses the cached layer for 'npm ci'
COPY --chown=purple:purple package*.json ./

# Switch to user purple NOW to avoid 'chown' issues later
USER purple

# Install dependencies
RUN npm ci --omit=dev

# --- OPTIMIZATION: Copy Source Code ---
# Now copy the rest. We use --chown to prevent doubling image size
COPY --chown=purple:purple . .

# Compile TypeScript
RUN npm run build || true

# Install Playwright browsers
# Note: Since the base image already has browsers, this might be redundant 
# unless Oobee requires a strictly different version.
# RUN npx playwright install chromium

# --- OPTIMIZATION: Correct Cache Warming ---
# 1. We create a local dummy file to scan (tech.gov.sg might be slow/blocked in build env)
# 2. The NODE_COMPILE_CACHE env var is now active, so this run actually saves the cache.
RUN echo '<html><body><h1>Warmup</h1></body></html>' > warmup.html && \
    OOBEE_SENTRY_DSN=http://localhost npm run cli -- -c 5 -u file:///app/oobee/warmup.html -a none -k 'Build:41898282+github-actions[bot]@users.noreply.github.com' && \
    rm warmup.html

# Cleanup results from warmup
RUN rm -rf /app/oobee/results
