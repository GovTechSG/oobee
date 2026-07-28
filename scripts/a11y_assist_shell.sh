#!/bin/bash

echo "A11y Assist Shell - Created By younglim - NO WARRANTY PROVIDED"
echo "================================================================"
echo ""

__dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORIGINAL_DIR="$PWD"

CURR_FOLDERNAME="$(basename "$PWD")"

if [ "$CURR_FOLDERNAME" = "scripts" ]; then
  cd ..
  CURR_FOLDERNAME="$(basename "$PWD")"
fi

# Get current shell command
SHELL_COMMAND=$(ps -o comm= -p $$)
SHELL_NAME="${SHELL_COMMAND#-}"

if [[ $(uname -m) == 'arm64' ]]; then
    echo "INFO: Setting path to node arm64 for this session"
    export PATH_TO_NODE="$PWD/nodejs-mac-arm64/bin"

else
    echo "INFO: Setting path to node x64 for this session"
    export PATH_TO_NODE="$PWD/nodejs-mac-x64/bin"
fi


export PATH="$PATH_TO_NODE:$PATH"

echo "INFO: Set path to node_modules for this session"
if find ./a11y-assist -name "node_modules" -maxdepth 1 -type l -ls &> /dev/null; then
    export PATH="$PWD/a11y-assist/node_modules/.bin:$PATH"
else
    export PATH="$PWD/node_modules/.bin:$PATH"
fi

echo "INFO: Set path to Java JRE"
export JAVA_HOME="$PWD/jre"
export PATH="$JAVA_HOME/bin:$PATH"

echo "INFO: Set path to VeraPDF"
export PATH="$PWD/verapdf:$PATH"

echo "INFO: Set path to Playwright cache for this session"
export PLAYWRIGHT_BROWSERS_PATH="$PWD/ms-playwright"
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD="true"

echo "INFO: Removing com.apple.quarantine attributes for required binaries to run"
xattr -rd com.apple.quarantine . &>/dev/null

cd "$ORIGINAL_DIR"
$@