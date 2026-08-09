#!/usr/bin/env bash
# Optional local backup: run daily digest on this Mac at 8:05 local time.
# Prefer GitHub Actions (works when Mac is asleep). This is a belt-and-suspenders.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="dev.freecoffee.grok-desk-daily"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
NODE="$(command -v node || true)"
for c in /usr/local/bin/node /opt/homebrew/bin/node; do
  [[ -x "$c" ]] && NODE="$c" && break
done
[[ -n "$NODE" ]] || { echo "node not found"; exit 1; }

LOG_DIR="$HOME/Library/Logs/GrokDesk"
mkdir -p "$LOG_DIR"

# Wrapper script so PATH includes gh
WRAP="$ROOT/scripts/run-daily-digest.sh"
cat > "$WRAP" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:\$HOME/.grok/bin:/usr/bin:/bin:\$PATH"
export REPO="johnatfreecoffee/grok-desk"
export OUT_BODY="/tmp/gd-daily-body.txt"
export OUT_SUBJECT="/tmp/gd-daily-subject.txt"
cd "$ROOT"
"$NODE" scripts/daily-repo-digest.mjs
export NOTIFY_FROM="\${NOTIFY_FROM:-Grok Desk <e.grokdesk@freecoffee.dev>}"
export NOTIFY_TO="\${NOTIFY_TO:-johnfrankromanojr@gmail.com}"
export REPLY_TO="e.grokdesk@freecoffee.dev"
SUBJECT=\$(cat /tmp/gd-daily-subject.txt)
SUBJECT="\$SUBJECT" BODY_FILE=/tmp/gd-daily-body.txt "$NODE" scripts/mail-notify.mjs
EOF
chmod +x "$WRAP"

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
    <string>${WRAP}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>8</integer>
    <key>Minute</key>
    <integer>5</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/daily-digest.out.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/daily-digest.err.log</string>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/${LABEL}" 2>/dev/null || true
echo "Installed ${LABEL} — daily 08:05 local"
echo "Unload: launchctl bootout gui/$(id -u)/${LABEL}"
echo "Note: GitHub Actions Daily digest also runs at 12:00 UTC. Disable one if you get two emails."
