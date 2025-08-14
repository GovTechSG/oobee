FROM mcr.microsoft.com/playwright:v1.50.1-noble

# Install required packages
RUN apt-get update && \
    apt-get install -y zip git clamav clamav-daemon supervisor && \
    rm -rf /var/lib/apt/lists/*

# Update virus definitions
RUN freshclam || true

# Create purple user
RUN groupadd -r purple && \
    useradd -r -g purple purple && \
    mkdir -p /home/purple && chown -R purple:purple /home/purple

# Allow clamav group to access daemon socket
RUN usermod -aG clamav purple

# Copy application code
WORKDIR /app/oobee
COPY . .

# Environment variables
ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD="true"

# Install app dependencies
RUN npm ci --omit=dev
RUN npm run build || true
RUN npx playwright install chromium

# Copy supervisord config
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Run supervisord to start both services
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
