# Use Microsoft Playwright image as base image
# Node version is v22
FROM mcr.microsoft.com/playwright:v1.55.0-noble

# Installation of packages for oobee and runner (locked versions from build log)
RUN apt-get update && apt-get install -y \
    git=1:2.43.0-1ubuntu7.3 \
    git-man=1:2.43.0-1ubuntu7.3 \
    unzip=6.0-28ubuntu4.1 \
    zip=3.0-13ubuntu0.2 \
 && rm -rf /var/lib/apt/lists/*
 
WORKDIR /app/oobee

# Clone oobee repository
# RUN git clone --branch master https://github.com/GovTechSG/oobee.git /app/oobee

# OR Copy oobee files from local directory
COPY . .

# Environment variables for node and Playwright
ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD="true"

# --- OPTIMIZATION SECTION ---

# 1. NETWORK: Fix AWS ECS 5-second DNS Timeout
#    - ipv4first: Skips waiting for IPv6 timeouts on Fargate
#    - no-warnings: Keeps logs clean
ENV NODE_OPTIONS="--dns-result-order=ipv4first --no-warnings"

# 2. STARTUP SPEED: Enable Node 22 Native Compile Cache
ENV NODE_COMPILE_CACHE=/app/oobee/.node_compile_cache

# --- END OPTIMIZATION ---

# Install oobee dependencies
RUN npm ci --omit=dev

# Compile TypeScript for oobee
RUN npm run build || true

# Install Playwright browsers
RUN npx playwright install chromium

# Add non-privileged user
RUN groupadd -r purple && useradd -r -g purple purple
RUN mkdir -p /home/purple && chown -R purple:purple /home/purple

WORKDIR /app

# Set ownership (Critical: must own the cache generated above)
RUN chown -R purple:purple /app

WORKDIR /app/oobee

# Run everything after as non-privileged user
USER purple
