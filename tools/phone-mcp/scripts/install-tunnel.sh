#!/usr/bin/env bash
set -euo pipefail
NAME="grok-phone-mcp"
HOST="grok-mcp.freecoffee.dev"
PORT="${GROK_MCP_PORT:-3311}"
CFDIR="${HOME}/.cloudflared"
mkdir -p "$CFDIR"

if ! command -v cloudflared >/dev/null; then
  echo "cloudflared not found" >&2
  exit 1
fi

EXISTING="$(cloudflared tunnel list 2>/dev/null | awk -v n="$NAME" '$2==n {print $1}' | head -1 || true)"
if [[ -z "$EXISTING" ]]; then
  cloudflared tunnel create "$NAME"
  EXISTING="$(cloudflared tunnel list 2>/dev/null | awk -v n="$NAME" '$2==n {print $1}' | head -1)"
fi
if [[ -z "$EXISTING" ]]; then
  echo "failed to create/find tunnel $NAME" >&2
  exit 1
fi
echo "tunnel id: $EXISTING"

CRED=""
for f in "${CFDIR}/${EXISTING}.json" "${CFDIR}/${NAME}.json"; do
  if [[ -f "$f" ]]; then CRED="$f"; break; fi
done
if [[ -z "$CRED" ]]; then
  CRED="$(ls -1 "${CFDIR}"/*.json 2>/dev/null | head -1 || true)"
fi
if [[ -z "$CRED" ]]; then
  echo "no tunnel credentials json in ${CFDIR}" >&2
  exit 1
fi

cat > "${CFDIR}/grok-phone-mcp.yml" <<EOF
tunnel: ${EXISTING}
credentials-file: ${CRED}
ingress:
  - hostname: ${HOST}
    service: http://127.0.0.1:${PORT}
  - service: http_status:404
EOF

cloudflared tunnel route dns "$NAME" "$HOST" || true

LABEL="dev.freecoffee.grok-phone-mcp-tunnel"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOGDIR="${HOME}/Library/Logs/GrokPhoneMcp"
mkdir -p "$LOGDIR"
CFBIN="$(command -v cloudflared)"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${CFBIN}</string>
    <string>tunnel</string>
    <string>--config</string>
    <string>${CFDIR}/grok-phone-mcp.yml</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${LOGDIR}/tunnel.out.log</string>
  <key>StandardErrorPath</key>
  <string>${LOGDIR}/tunnel.err.log</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/${LABEL}"
echo "tunnel hostname: https://${HOST}"
echo "MCP URL: https://${HOST}/mcp"
