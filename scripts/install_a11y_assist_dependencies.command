#!/bin/bash

NODE_VERSION="22.19.0"

# Get current shell command
SHELL_COMMAND=$(ps -o comm= -p $$)
SHELL_NAME="${SHELL_COMMAND#-}"

cd "$(dirname "${BASH_SOURCE[0]}")"
__dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CURR_FOLDERNAME="$(basename "$PWD")"
if [ "$CURR_FOLDERNAME" = "scripts" ]; then
  cd ..
  CURR_FOLDERNAME="$(basename "$PWD")"
fi

if ! [ -f nodejs-mac-arm64/bin/node ]; then
  echo "Downloading NodeJS LTS (ARM64)"
  curl -o ./nodejs-mac-arm64.tar.gz --create-dirs https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-arm64.tar.gz  
  mkdir nodejs-mac-arm64
  tar -xzf nodejs-mac-arm64.tar.gz -C nodejs-mac-arm64 --strip-components=1 && rm ./nodejs-mac-arm64.tar.gz
  rm nodejs-mac-arm64.tar.gz
fi

if ! [ -f nodejs-mac-x64/bin/node ]; then
  echo "Downloading NodeJS LTS (x64)"
  curl -o ./nodejs-mac-x64.tar.gz --create-dirs https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-x64.tar.gz     
  mkdir nodejs-mac-x64
  tar -xzf nodejs-mac-x64.tar.gz -C nodejs-mac-x64 --strip-components=1 && rm ./nodejs-mac-x64.tar.gz
  rm node-*-darwin-x64.tar.gz
fi

export CORRETTO_BASEDIR="$HOME/Library/Application Support/A11y Assist"
mkdir -p "$CORRETTO_BASEDIR" 

echo "INFO: Set path to Corretto-11 JDK"
export JAVA_HOME="$CORRETTO_BASEDIR/amazon-corretto-11.jdk.x64/Contents/Home"
export PATH="$JAVA_HOME/bin:$PATH"

if ! [ -f jre/bin/java ]; then
  cd "$CORRETTO_BASEDIR" 
  if ! [ -f amazon-corretto-11.jdk.x64/Contents/Home/bin/java ]; then
      echo "Downloading Corretto (x64)"
      curl -L -o ./corretto-11.tar.gz "https://corretto.aws/downloads/latest/amazon-corretto-11-x64-macos-jdk.tar.gz"
      tar -zxf ./corretto-11.tar.gz
      rm -f ./corretto-11.tar.gz
      mv amazon-corretto-11.jdk amazon-corretto-11.jdk.x64
  else
    echo "Found Corretto (x64)"
  fi

  echo "INFO: Build JRE SE"
  cd "$__dir"
  jlink --output jre --add-modules java.se

fi

if ! [ -f verapdf/verapdf ]; then
  echo "Downloading VeraPDF"
  if [ -d "./verapdf" ]; then rm -Rf ./verapdf; fi
  if [ -d "./verapdf-installer" ]; then rm -Rf ./verapdf-installer; fi
  curl -L -o ./verapdf-installer.zip https://github.com/GovTechSG/a11y-assist/releases/download/cache/verapdf-installer.zip
  unzip -j ./verapdf-installer.zip -d ./verapdf-installer
  ./verapdf-installer/verapdf-install "${__dir}/verapdf-auto-install-macos.xml"
  cp -r /tmp/verapdf .
  rm -rf ./verapdf-installer.zip ./verapdf-installer /tmp/verapdf
  
fi

if [ -d "/Applications/Cloudflare WARP.app" ]; then
  curl -sSLJ -o "/tmp/Cloudflare_CA.pem" "https://developers.cloudflare.com/cloudflare-one/static/documentation/connections/Cloudflare_CA.pem"
  export NODE_EXTRA_CA_CERTS="/tmp/Cloudflare_CA.pem"
fi

source "${__dir}/a11y_assist_shell.sh"

if ! [ -f package.json ] && [ -d a11y-assist ]; then
  cd a11y-assist
fi

if [ -d "node_modules" ]; then
  echo "Deleting node_modules before installation"
  rm -rf node_modules 
fi

echo "Installing Node dependencies to $PWD"
npm install --force --omit=dev

# Add additional canvas dependency in x64 mode
if [ "$(uname -m)" = "arm64" ] && /usr/bin/pgrep oahd >/dev/null 2>&1; then
    if [ -f package.json ]; then
      export PATH="$(dirname "$PWD")/nodejs-mac-x64/bin:$PATH"
    else
      export PATH="$PWD/nodejs-mac-x64/bin:$PATH"
    fi
    arch -x86_64 npm install @napi-rs/canvas-darwin-x64@0.1.53 --force --omit=dev
fi

echo "Build TypeScript"
npm run build || true
