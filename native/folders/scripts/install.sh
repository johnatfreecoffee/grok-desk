#!/usr/bin/env bash
# Build the Folders helper. Grok Desk.app starts it — no standalone app / launchd.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "Building Grok Folders helper…"
APP="$("$ROOT/scripts/build.sh")"
echo "Built: $APP"
echo "Open Grok Desk to show the comet in the menu bar."
