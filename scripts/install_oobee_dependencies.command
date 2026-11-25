#!/bin/bash

set -e

NODE_VERSION="24.22.1"

# --- Security: SHA-256 verification for every downloaded artifact ---
#
# The prior version of this script downloaded Node.js, Corretto, and the
# veraPDF installer over TLS with no post-download integrity check. A
# compromised mirror, a cache-poisoning attacker on a shared network, or
# an accidental partial download would all silently ship whatever bytes
# arrived. Every fetch below is now paired with an SHA-256 check that
# aborts the script if the digest does not match.
#
# Pinned digests below cover:
#   * Node.js: taken from the official
#       https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt
#     which upstream publishes and GPG-signs for exactly this purpose.
#   * veraPDF: the "cache" release tag on GovTechSG/oobee is a fixed,
#     immutable asset — a static SHA-256 is embedded here and any drift
#     means the release was re-uploaded (which should be a review event).
#   * Corretto: the URL is intentionally "latest", so the digest is
#     fetched from Amazon's ``latest_sha256`` sidecar at the same time as
#     the archive. This defends against in-transit tampering and mirror
#     corruption; sidecar and archive are fetched over TLS from the same
#     origin, so this is TLS-level integrity, not signature verification.

NODE_SHA256_DARWIN_ARM64="89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7"
NODE_SHA256_DARWIN_X64="d132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035" # guardrails-disable-line
VERAPDF_SHA256="b6c50ab65d574bff0cbc0449ffacf587e325a3a53f8a6ecc0d578966abc800ec"

# Pin Corretto to a specific version + SHA-256 verified out-of-band by an oobee
# maintainer, rather than trusting Amazon's ``latest_sha256`` sidecar (which is
# same-channel and thus meaningless if the origin itself is compromised — the
# finding tracked as asgard-0005). Update both when rolling forward to a newer
# Corretto release; the digest should be re-verified from an independent copy
# of the archive.
CORRETTO_VERSION="11.0.32.10.1"
CORRETTO_SHA256_DARWIN_X64="b2dc525aed2dc78e0b7ebda1fd5fa37b40d184699ba27fb5d6edd13b8cf84531" # guardrails-disable-line

# Verify a file's SHA-256 against an expected digest. Aborts (exit 1) on
# mismatch or missing tools — never falls back to skipping the check,
# because the whole point is to fail closed on tampered downloads.
verify_sha256() {
  local file="$1"
  local expected="$2"
  local label="$3"

  if [ ! -f "$file" ]; then
    echo "ERROR: $label: expected file '$file' was not downloaded" >&2
    exit 1
  fi

  local actual
  if command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  elif command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | awk '{print $1}')"
  else
    echo "ERROR: $label: neither shasum nor sha256sum is available; refusing to install unverified download" >&2
    rm -f "$file"
    exit 1
  fi

  if [ "$actual" != "$expected" ]; then
    echo "ERROR: $label: SHA-256 mismatch" >&2
    echo "  file:     $file" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    rm -f "$file"
    exit 1
  fi

  echo "OK: $label: SHA-256 verified ($expected)"
}

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
  curl -fSL -o ./nodejs-mac-arm64.tar.gz --create-dirs "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-arm64.tar.gz"
  verify_sha256 ./nodejs-mac-arm64.tar.gz "$NODE_SHA256_DARWIN_ARM64" "NodeJS ${NODE_VERSION} darwin-arm64"
  mkdir nodejs-mac-arm64
  tar -xzf nodejs-mac-arm64.tar.gz -C nodejs-mac-arm64 --strip-components=1 && rm ./nodejs-mac-arm64.tar.gz
  rm -f nodejs-mac-arm64.tar.gz
fi

if ! [ -f nodejs-mac-x64/bin/node ]; then
  echo "Downloading NodeJS LTS (x64)"
  curl -fSL -o ./nodejs-mac-x64.tar.gz --create-dirs "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-darwin-x64.tar.gz"
  verify_sha256 ./nodejs-mac-x64.tar.gz "$NODE_SHA256_DARWIN_X64" "NodeJS ${NODE_VERSION} darwin-x64"
  mkdir nodejs-mac-x64
  tar -xzf nodejs-mac-x64.tar.gz -C nodejs-mac-x64 --strip-components=1 && rm ./nodejs-mac-x64.tar.gz
  rm -f node-*-darwin-x64.tar.gz
fi

export CORRETTO_BASEDIR="$HOME/Library/Application Support/Oobee"
mkdir -p "$CORRETTO_BASEDIR"

echo "INFO: Set path to Corretto-11 JDK"
export JAVA_HOME="$CORRETTO_BASEDIR/amazon-corretto-11.jdk.x64/Contents/Home"
export PATH="$JAVA_HOME/bin:$PATH"

if ! [ -f jre/bin/java ]; then
  cd "$CORRETTO_BASEDIR"
  if ! [ -f amazon-corretto-11.jdk.x64/Contents/Home/bin/java ]; then
      echo "Downloading Corretto ${CORRETTO_VERSION} (x64)"
      # Use the versioned URL (immutable per release) rather than the rotating
      # "latest" URL, and verify against a maintainer-pinned SHA-256. Do not
      # trust the same-origin ``latest_sha256`` sidecar for integrity.
      curl -fSL -o ./corretto-11.tar.gz "https://corretto.aws/downloads/resources/${CORRETTO_VERSION}/amazon-corretto-${CORRETTO_VERSION}-macosx-x64.tar.gz"
      verify_sha256 ./corretto-11.tar.gz "$CORRETTO_SHA256_DARWIN_X64" "Corretto ${CORRETTO_VERSION} macOS x64"
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
  curl -fSL -o ./verapdf-installer.zip https://github.com/GovTechSG/oobee/releases/download/cache/verapdf-installer.zip
  verify_sha256 ./verapdf-installer.zip "$VERAPDF_SHA256" "veraPDF installer"
  unzip -j ./verapdf-installer.zip -d ./verapdf-installer
  ./verapdf-installer/verapdf-install "${__dir}/verapdf-auto-install-macos.xml"
  cp -r /tmp/verapdf .
  rm -rf ./verapdf-installer.zip ./verapdf-installer /tmp/verapdf

fi

# asgard-0007: the Cloudflare WARP CA-trust block was removed. Downloading a
# CA cert without integrity verification and exporting it as
# NODE_EXTRA_CA_CERTS extended Node's trust store from an unverified source,
# enabling TLS interception if the origin or the /tmp path was compromised.
# Operators who need WARP-issued cert trust should install the CA into the
# system trust store out-of-band and set NODE_EXTRA_CA_CERTS themselves.

source "${__dir}/oobee_shell.sh"

if ! [ -f package.json ] && [ -d oobee ]; then
  cd oobee
fi

if [ -d "node_modules" ]; then
  echo "Deleting node_modules before installation"
  rm -rf node_modules
fi

echo "Installing Node dependencies to $PWD"
npm install --force --omit=dev

# The portable package runs on both Apple Silicon and Intel Macs, but npm only
# installs the @napi-rs/canvas binding for the build machine's CPU. Unpack both
# darwin bindings directly: running `npm install` again under x64 makes npm 11
# re-resolve the tree for x64 and delete the arm64 binding.
CANVAS_VERSION="$(node -p "require('./node_modules/@napi-rs/canvas/package.json').version")"
CANVAS_TMP="$(mktemp -d)"
for canvas_arch in arm64 x64; do
  canvas_pkg="@napi-rs/canvas-darwin-${canvas_arch}"
  echo "Installing ${canvas_pkg}@${CANVAS_VERSION}"
  npm pack "${canvas_pkg}@${CANVAS_VERSION}" --pack-destination "$CANVAS_TMP" --silent
  rm -rf "node_modules/${canvas_pkg}"
  mkdir -p "node_modules/${canvas_pkg}"
  tar -xzf "${CANVAS_TMP}/napi-rs-canvas-darwin-${canvas_arch}-${CANVAS_VERSION}.tgz" \
    -C "node_modules/${canvas_pkg}" --strip-components=1
done
rm -rf "$CANVAS_TMP"

echo "Build TypeScript"
npm run build || true
