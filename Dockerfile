# Use Node.js LTS with Ubuntu as the base image
FROM node:lts-bullseye

# Update system and install required dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    g++ \
    python3 \
    python3-pip \
    zip \
    bash \
    git \
    openjdk-11-jre \
    curl \
    libnss3 \
    libx11-6 \
    libxrender1 \
    libxcomposite1 \
    libxrandr2 \
    libxtst6 \
    libxi6 \
    libxdamage1 \
    libcups2 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libpango-1.0-0 \
    libfreetype6 \
    libxshmfence1 \
    libxkbcommon0 \
    libgbm-dev \
    fontconfig \
    fonts-liberation \
    ca-certificates \
    gnupg \
    wget \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install VeraPDF
RUN echo $'<?xml version="1.0" encoding="UTF-8" standalone="no"?> \n\
<AutomatedInstallation langpack="eng"> \n\
    <com.izforge.izpack.panels.htmlhello.HTMLHelloPanel id="welcome"/> \n\
    <com.izforge.izpack.panels.target.TargetPanel id="install_dir"> \n\
        <installpath>/opt/verapdf</installpath> \n\
    </com.izforge.izpack.panels.target.TargetPanel> \n\
    <com.izforge.izpack.panels.packs.PacksPanel id="sdk_pack_select"> \n\
        <pack index="0" name="veraPDF GUI" selected="true"/> \n\
        <pack index="1" name="veraPDF Batch files" selected="true"/> \n\
        <pack index="2" name="veraPDF Validation model" selected="false"/> \n\
        <pack index="3" name="veraPDF Documentation" selected="false"/> \n\
        <pack index="4" name="veraPDF Sample Plugins" selected="false"/> \n\
    </com.izforge.izpack.panels.packs.PacksPanel> \n\
    <com.izforge.izpack.panels.install.InstallPanel id="install"/> \n\
    <com.izforge.izpack.panels.finish.FinishPanel id="finish"/> \n\
</AutomatedInstallation> ' > /opt/verapdf-auto-install-docker.xml

RUN wget "https://github.com/GovTechSG/oobee/releases/download/cache/verapdf-installer.zip" -P /opt && \
    unzip /opt/verapdf-installer.zip -d /opt && \
    latest_version=$(ls -d /opt/verapdf-greenfield-* | sort -V | tail -n 1) && [ -n "$latest_version" ] && \
    "$latest_version/verapdf-install" "/opt/verapdf-auto-install-docker.xml" && \
    rm -rf /opt/verapdf-installer.zip /opt/verapdf-greenfield-*

# Set VeraPDF in PATH
ENV PATH="/opt/verapdf:${PATH}"

# Set working directory
WORKDIR /app

# Copy package.json and install dependencies
COPY package*.json ./

# Set Playwright environment variables
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD="true"
ENV PLAYWRIGHT_BROWSERS_PATH="/opt/ms-playwright"

# Install Node.js dependencies
RUN npm install --force --omit=dev

# Install Playwright browsers
RUN npx playwright install chromium webkit

# Add a non-privileged user
RUN groupadd -r oobee && useradd -r -g oobee oobee && \
    chown -R oobee:oobee /app

# Switch to the non-privileged user
USER oobee

# Copy the rest of the application
COPY . .

# Compile TypeScript (if necessary)
RUN npm run build || true  # Temporarily ignore build errors
