#!/usr/bin/env bash
# Install a user launchd agent so Grok Desk stays running on this Mac.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="dev.freecoffee.grok-desk"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
NODE="$(command -v node)"
if [[ -z "$NODE" || ! -x "$NODE" ]]; then
  for c in /usr/local/bin/node /opt/homebrew/bin/node; do
    if [[ -x "$c" ]]; then NODE="$c"; break; fi
  done
fi
if [[ -z "$NODE" || ! -x "$NODE" ]]; then
  echo "ERROR: node not found"
  exit 1
fi

LOG_DIR="$HOME/Library/Logs/GrokDesk"
mkdir -p "$LOG_DIR"
mkdir -p "$ROOT/web/dist" 2>/dev/null || true

# Ensure UI is built
if [[ ! -f "$ROOT/web/dist/index.html" ]]; then
  echo "Building web UI…"
  (cd "$ROOT" && npm run build --prefix web)
fi

# Invoke node directly (avoid bash start.sh + Documents TCC denials)
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE}</string>
    <string>${ROOT}/daemon/index.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/desk.out.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/desk.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${HOME}</string>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${HOME}/.grok/bin</string>
    <key>PORT</key>
    <string>8787</string>
  </dict>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/${LABEL}" 2>/dev/null || true
# Don't kickstart if something already healthy on the port
if curl -sf "http://127.0.0.1:8787/api/status" >/dev/null 2>&1; then
  echo "Engine already up on :8787 — launchd installed for next boot / crash recovery"
else
  launchctl kickstart -k "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  sleep 1
fi

echo "Installed ${LABEL}"
echo "  node: $NODE"
echo "  Open http://127.0.0.1:8787"
echo "  Logs: ${LOG_DIR}/"
echo "  Unload: launchctl bootout gui/$(id -u)/${LABEL}"
