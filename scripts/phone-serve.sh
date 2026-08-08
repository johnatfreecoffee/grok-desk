#!/usr/bin/env bash
# Expose Grok Desk on your Tailscale network for iPhone PWA.
# HTTPS preferred (PWA + push); falls back to HTTP if Serve HTTPS not enabled yet.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8787}"
LABEL="dev.freecoffee.grok-desk"

echo "== Grok Desk → phone (Tailscale) =="

# 1) Always-on engine
if ! launchctl print "gui/$(id -u)/${LABEL}" &>/dev/null; then
  echo "Installing launchd agent…"
  bash "$ROOT/scripts/install-launchd.sh"
else
  launchctl kickstart -k "gui/$(id -u)/${LABEL}" 2>/dev/null || true
fi

# Wait for local engine
for i in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:${PORT}/api/status" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
if ! curl -sf "http://127.0.0.1:${PORT}/api/status" >/dev/null 2>&1; then
  echo "ERROR: daemon not up on 127.0.0.1:${PORT}"
  echo "Logs: $ROOT/data/logs/"
  exit 1
fi
echo "Engine OK on 127.0.0.1:${PORT}"

if ! command -v tailscale >/dev/null 2>&1; then
  echo "ERROR: tailscale CLI not found"
  exit 1
fi

DNS_NAME="$(tailscale status --json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('Self',{}).get('DNSName','').rstrip('.'))" 2>/dev/null || true)"
if [[ -z "$DNS_NAME" ]]; then
  DNS_NAME="YOUR-MAC.tailXXXX.ts.net"
fi

# 2) Prefer HTTPS Serve (needed for real PWA + Web Push)
HTTPS_OK=0
if perl -e 'alarm 12; exec @ARGV' tailscale serve --bg --yes "$PORT" 2>/tmp/grok-desk-serve.err; then
  HTTPS_OK=1
else
  if grep -q "not enabled" /tmp/grok-desk-serve.err 2>/dev/null; then
    echo ""
    echo "HTTPS Serve is not enabled on your tailnet yet (one-time)."
    echo "Open this URL in a browser, click Enable, then re-run this script:"
    grep -o 'https://login.tailscale.com/[^ ]*' /tmp/grok-desk-serve.err 2>/dev/null || true
    echo "  https://login.tailscale.com/admin/dns  (or the link above)"
    # Keep HTTP path working for chat now
    tailscale serve --http=80 --bg --yes "$PORT" 2>/dev/null || true
  else
    cat /tmp/grok-desk-serve.err 2>/dev/null || true
    tailscale serve --http=80 --bg --yes "$PORT" 2>/dev/null || true
  fi
fi

echo ""
echo "Tailscale serve:"
tailscale serve status 2>/dev/null || true
echo ""

if [[ "$HTTPS_OK" == "1" ]]; then
  URL="https://${DNS_NAME}"
  echo "Phone URL (HTTPS — install PWA + push):"
else
  URL="http://${DNS_NAME}"
  echo "Phone URL (HTTP — full chat UI; push needs HTTPS after one-time enable):"
fi
echo "  $URL"
echo ""
echo "iPhone:"
echo "  1. Tailscale app ON"
echo "  2. Safari → open URL above"
echo "  3. Share → Add to Home Screen"
echo "  4. Open Grok Desk icon → same UI as Mac"
echo "  5. Settings → Phone push (after HTTPS)"
echo ""
echo "Mac must stay awake + online. Sleep = phone offline."
