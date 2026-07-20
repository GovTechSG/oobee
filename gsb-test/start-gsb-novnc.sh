#!/usr/bin/env bash
set -euo pipefail

export DISPLAY=${DISPLAY:-:99}
PROFILE_DIR=${PROFILE_DIR:-/data/chrome-profile}
export OOBEE_CHROME_DATA_DIR="$PROFILE_DIR"
WARMUP_SECONDS=${GSB_WARMUP_SECONDS:-300}
CHROME_URL=${GSB_WARMUP_URL:-https://example.com}

mkdir -p "$PROFILE_DIR/Default"

# Import Cloudflare CA into Chrome's NSS database so HTTPS interception
# by corporate proxies doesn't trigger "connection is not private" errors.
NSS_DB="$PROFILE_DIR/Default"
if [ -f /usr/local/share/ca-certificates/Cloudflare_CA.crt ] && command -v certutil >/dev/null 2>&1; then
  mkdir -p "$NSS_DB"
  if [ ! -d "$NSS_DB" ] || ! certutil -L -d sql:"$NSS_DB" -n "Cloudflare CA" >/dev/null 2>&1; then
    certutil -d sql:"$NSS_DB" -N --empty-password 2>/dev/null || true
    certutil -d sql:"$NSS_DB" -A -t "C,," -n "Cloudflare CA" \
      -i /usr/local/share/ca-certificates/Cloudflare_CA.crt
    echo "[GSB] Cloudflare CA imported into Chrome NSS database"
  fi
fi

# Ensure Safe Browsing is enabled in profile Preferences on first run.
if [ ! -f "$PROFILE_DIR/Default/Preferences" ]; then
  echo '{"safebrowsing":{"enabled":true,"enhanced":true}}' > "$PROFILE_DIR/Default/Preferences"
fi

rm -f /tmp/.X99-lock
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
openbox >/tmp/openbox.log 2>&1 &
x11vnc -display :99 -forever -shared -nopw -listen 0.0.0.0 -rfbport 5900 >/tmp/x11vnc.log 2>&1 &

# Start Chrome and keep it alive in the background for the lifetime of the container.
# This keeps the Safe Browsing real-time OHTTP relay connection warm so the first
# Oobee scan does not have to wait for the ~5 minute cold-start initialization.
CHROME_ARGS=(
  --user-data-dir="$PROFILE_DIR"
  --profile-directory=Default
  --no-sandbox --disable-setuid-sandbox
  --disable-dev-shm-usage --disable-gpu --disable-software-rasterizer
  --in-process-gpu --disable-gpu-compositing --disable-features=VizDisplayCompositor
  --no-zygote --no-first-run --no-default-browser-check
  --enable-features=SafeBrowsingEnhancedProtection
  --ignore-certificate-errors
  --ozone-platform=x11
  --remote-debugging-port=9222
)

if command -v google-chrome >/dev/null 2>&1; then
  rm -f "$PROFILE_DIR/SingletonLock" "$PROFILE_DIR/SingletonCookie" "$PROFILE_DIR/SingletonSocket"
  google-chrome "${CHROME_ARGS[@]}" "$CHROME_URL" >/tmp/chrome-warmup.log 2>&1 &
  CHROME_PID=$!
  echo "[GSB] Chrome started (PID $CHROME_PID) — waiting for OHTTP key (max ${WARMUP_SECONDS}s)..."

  WAITED=0
  ATTEMPT=0
  GSB_READY=0
  MAX_ATTEMPTS=$(( WARMUP_SECONDS / 5 ))
  while [ "$WAITED" -lt "$WARMUP_SECONDS" ]; do
    sleep 5
    WAITED=$((WAITED + 5))
    ATTEMPT=$((ATTEMPT + 1))
    echo "[GSB] Attempt ${ATTEMPT}/${MAX_ATTEMPTS} — checking for OHTTP key (${WAITED}s elapsed)..."
    KEY=$(python3 -c "
import json, sys
try:
    with open('$PROFILE_DIR/Default/Preferences') as f:
        d = json.load(f)
    print(d.get('safebrowsing', {}).get('hash_real_time_ohttp_key', ''))
except Exception:
    print('')
" 2>/dev/null || true)
    if [ -n "$KEY" ]; then
      echo "[GSB] Attempt ${ATTEMPT}/${MAX_ATTEMPTS} — OHTTP key present after ${WAITED}s — Safe Browsing READY"
      GSB_READY=1
      break
    fi
    echo "[GSB] Attempt ${ATTEMPT}/${MAX_ATTEMPTS} — key not yet present, will retry in 5s"
  done

  if [ "$GSB_READY" -eq 0 ]; then
    echo "[GSB] WARNING: OHTTP key not found after ${WARMUP_SECONDS}s — Safe Browsing may not be fully ready"
  fi
  echo "[GSB] Chrome remains running (PID $CHROME_PID)"
fi

if [ -x /usr/share/novnc/utils/novnc_proxy ]; then
  exec /usr/share/novnc/utils/novnc_proxy --listen 6080 --vnc localhost:5900
else
  exec websockify --web=/usr/share/novnc 6080 localhost:5900
fi
