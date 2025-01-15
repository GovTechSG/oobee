# Use Node LTS alpine distribution
FROM node:lts-alpine3.18

# Install required packages, including gcompat and nss for compatibility
RUN apk add --no-cache \
    build-base \
    gcompat \
    g++ \
    make \
    python3 \
    zip \
    bash \
    git \
    chromium \
    openjdk11-jre \
    curl \
    libstdc++ \
    libx11 \
    libxrender \
    libxcomposite \
    libxrandr \
    libxtst \
    libxi \
    libxdamage \
    nss \
    libc6-compat \
    ca-certificates \
    glib \
    gtk+3.0 \
    pango \
    freetype \
    harfbuzz \
    alsa-lib

# Install glibc for better compatibility
# Define glibc version
ENV GLIBC_VERSION="2.34-r0"

# Remove conflicting packages and install glibc, ignoring file conflicts
RUN apk del --no-cache gcompat && \
    curl -Lo /etc/apk/keys/sgerrand.rsa.pub https://alpine-pkgs.sgerrand.com/sgerrand.rsa.pub && \
    curl -Lo /tmp/glibc-${GLIBC_VERSION}.apk https://github.com/sgerrand/alpine-pkg-glibc/releases/download/${GLIBC_VERSION}/glibc-${GLIBC_VERSION}.apk && \
    apk add --no-cache --force-overwrite /tmp/glibc-${GLIBC_VERSION}.apk && \
    rm -rf /tmp/*

# Installation of VeraPDF
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
</AutomatedInstallation> ' >> /opt/verapdf-auto-install-docker.xml

RUN wget "https://github.com/GovTechSG/oobee/releases/download/cache/verapdf-installer.zip" -P /opt
RUN unzip /opt/verapdf-installer.zip -d /opt
RUN latest_version=$(ls -d /opt/verapdf-greenfield-* | sort -V | tail -n 1) && [ -n "$latest_version" ] && \
    "$latest_version/verapdf-install" "/opt/verapdf-auto-install-docker.xml"
RUN rm -rf /opt/verapdf-installer.zip /opt/verapdf-greenfield-*

# Set oobee directory
WORKDIR /app

# Copy package.json to working directory, perform npm install before copying the remaining files
COPY package*.json ./

# Environment variables for node and Playwright
ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD="true"
ENV PLAYWRIGHT_BROWSERS_PATH="/opt/ms-playwright"
ENV PATH="/opt/verapdf:${PATH}"

# Install dependencies
RUN npm install --force --omit=dev

# Install Playwright browsers
RUN npx playwright install chromium webkit

# Add non-privileged user
RUN addgroup -S oobee && adduser -S -G oobee oobee
RUN chown -R oobee:oobee ./

# Run everything after as non-privileged user.
USER oobee

# Copy application and support files
COPY . .

# Compile TypeScript
RUN npm run build || true  # true exits with code 0 - temp workaround until errors are resolved
