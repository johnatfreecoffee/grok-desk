#!/usr/bin/env bash
# Install Grok Folders to ~/Applications, unique launchd name, launch it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="dev.freecoffee.GrokFolders"
DEST="$HOME/Applications/Grok Folders.app"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$HOME/Library/Logs/GrokFolders"

echo "Building Grok Folders…"
APP="$("$ROOT/scripts/build.sh")"

mkdir -p "$HOME/Applications" "$LOG_DIR"

# Stop a running copy so we can replace the bundle.
pkill -f '/Grok Folders.app/Contents/MacOS/GrokFolders' 2>/dev/null || true
sleep 0.3

rm -rf "$DEST"
cp -R "$APP" "$DEST"
codesign --force --deep --sign - "$DEST" >/dev/null

# Unique launchd agent so Login Items / launchctl never show as "node".
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${DEST}/Contents/MacOS/GrokFolders</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>3</integer>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/out.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${HOME}</string>
    <key>PATH</key>
    <string>/usr/bin:/bin:/usr/sbin:/sbin:${HOME}/.grok/bin</string>
  </dict>
  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl kickstart -k "gui/$(id -u)/${LABEL}"

echo "Installed: $DEST"
echo "LaunchAgent: ${LABEL}"
echo "Click the Grok comet in the menu bar."
