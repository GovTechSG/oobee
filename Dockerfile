# Use Microsoft Playwright image as base image
# Node version is v22
FROM mcr.microsoft.com/playwright:v1.50.1-noble

# Installation of packages for oobee and runner
RUN apt-get update && apt-get install -y zip git

WORKDIR /app/oobee

# Clone oobee repository
# RUN git clone --branch master https://github.com/GovTechSG/oobee.git /app/oobee

# OR Copy oobee files from local directory
COPY . .

# Environment variables for node and Playwright
ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD="true"

# Install oobee dependencies
RUN npm ci --omit=dev

# Compile TypeScript for oobee
RUN npm run build || true # true exits with code 0 - workaround for TS errors

# Install Playwright browsers
RUN npx playwright install chromium

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
