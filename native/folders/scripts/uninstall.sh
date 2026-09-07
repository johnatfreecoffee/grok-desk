#!/usr/bin/env bash
set -euo pipefail
LABEL="dev.freecoffee.GrokFolders"
DEST="$HOME/Applications/Grok Folders.app"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
pkill -f '/Grok Folders.app/Contents/MacOS/GrokFolders' 2>/dev/null || true
rm -f "$PLIST"
rm -rf "$DEST"
echo "Removed Grok Folders ($LABEL)."
echo "Login item (if present) can be unchecked in System Settings → General → Login Items."
