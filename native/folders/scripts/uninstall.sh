#!/usr/bin/env bash
# Remove leftover standalone Grok Folders.app / launchd.
# Does not kill the comet helper owned by Grok Desk.
set -euo pipefail
LABEL="dev.freecoffee.GrokFolders"
DEST="$HOME/Applications/Grok Folders.app"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
rm -f "$PLIST"
rm -rf "$DEST"
echo "Removed leftover standalone Grok Folders ($LABEL)."
echo "The comet is part of Grok Desk.app — quit Grok Desk to hide it."
