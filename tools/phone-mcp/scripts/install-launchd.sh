#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="dev.freecoffee.grok-phone-mcp"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOGDIR="${HOME}/Library/Logs/GrokPhoneMcp"
APP="${HOME}/.grok/phone-mcp/app"
mkdir -p "$LOGDIR" "${HOME}/.grok/phone-mcp/jobs" "$APP"
if [[ ! -f "${HOME}/.grok/phone-mcp/token" ]]; then
  openssl rand -hex 24 > "${HOME}/.grok/phone-mcp/token"
  chmod 600 "${HOME}/.grok/phone-mcp/token"
fi
if [[ ! -d "$ROOT/node_modules/@modelcontextprotocol" ]]; then
  (cd "$ROOT" && npm install --omit=dev)
fi
rsync -a "$ROOT/server.mjs" "$ROOT/package.json" "$APP/"
rsync -a "$ROOT/node_modules/" "$APP/node_modules/"
cp "$ROOT/start.sh" "${HOME}/.grok/phone-mcp/start-repo.sh" 2>/dev/null || true
cat > "${HOME}/.grok/phone-mcp/start.sh" <<'START'
#!/usr/bin/env bash
set -euo pipefail
STATE="${HOME}/.grok/phone-mcp"
APP="${STATE}/app"
mkdir -p "${STATE}/jobs"
export GROK_MCP_TOKEN="$(tr -d '[:space:]' < "${STATE}/token")"
export GROK_MCP_PORT="${GROK_MCP_PORT:-3311}"
export GROK_MCP_ROOTS="${GROK_MCP_ROOTS:-${HOME}/Documents}"
export GROK_MCP_ALLOW_AUTO="${GROK_MCP_ALLOW_AUTO:-1}"
export PATH="${HOME}/.grok/bin:/usr/local/bin:/opt/homebrew/bin:${PATH}"
cd "$APP"
exec /usr/bin/caffeinate -s /usr/local/bin/node server.mjs
START
chmod +x "${HOME}/.grok/phone-mcp/start.sh"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${HOME}/.grok/phone-mcp/start.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${APP}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${LOGDIR}/out.log</string>
  <key>StandardErrorPath</key>
  <string>${LOGDIR}/err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${HOME}</string>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${HOME}/.grok/bin</string>
    <key>GROK_MCP_PORT</key>
    <string>3311</string>
    <key>GROK_MCP_ROOTS</key>
    <string>${HOME}/Documents</string>
    <key>GROK_MCP_ALLOW_AUTO</key>
    <string>1</string>
  </dict>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/${LABEL}"
echo "installed ${LABEL}"
echo "plist: ${PLIST}"
echo "url: https://grok-mcp.freecoffee.dev/mcp"
