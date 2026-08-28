#!/usr/bin/env bash
# Build Windows / Linux (or mac) installers with electron-builder.
# Usage: scripts/pack.sh [linux|win|mac]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-linux}"
cd "$ROOT"

case "$TARGET" in
  linux|win|mac) ;;
  *)
    echo "usage: $0 linux|win|mac" >&2
    exit 2
    ;;
esac

npm install --prefix web
npm run build --prefix web
if [[ ! -d node_modules/electron ]]; then
  npm install
fi

npx --yes electron-builder --"$TARGET" --publish never
echo "Artifacts in $ROOT/dist-electron"
