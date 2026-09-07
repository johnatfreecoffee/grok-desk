#!/usr/bin/env bash
# Build Grok Folders.app (ad-hoc signed).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT/.build"
APP="$BUILD/Grok Folders.app"
BIN="$APP/Contents/MacOS/GrokFolders"
SDK="$(xcrun --sdk macosx --show-sdk-path)"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

swiftc -O -parse-as-library \
  -target arm64-apple-macosx13.0 \
  -sdk "$SDK" \
  -framework AppKit \
  -o "$BIN" \
  "$ROOT"/Sources/*.swift

cp "$ROOT/Resources/Info.plist" "$APP/Contents/Info.plist"
cp "$ROOT/Resources/GrokFolders.icns" "$APP/Contents/Resources/GrokFolders.icns"
cp "$ROOT"/Resources/GrokComet.svg "$APP/Contents/Resources/"
cp "$ROOT"/Resources/GrokComet-*.png "$APP/Contents/Resources/"
rm -f "$APP/Contents/Resources/GrokComet-preview.png"
echo -n 'APPL????' > "$APP/Contents/PkgInfo"

codesign --force --deep --sign - "$APP" >/dev/null
echo "$APP"
