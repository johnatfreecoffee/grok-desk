#!/usr/bin/env bash
# Build a double-clickable "Grok Desk.app" that is a real renamed Electron
# bundle (so macOS menu bar / Dock say "Grok Desk", not "Electron").
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="Grok Desk"
APP_DIR="${1:-$ROOT/$APP_NAME.app}"
ELECTRON_APP="$ROOT/node_modules/electron/dist/Electron.app"

cd "$ROOT"

if [[ ! -d web/dist ]]; then
  npm install --prefix web
  npm run build --prefix web
fi
if [[ ! -d node_modules/electron ]]; then
  npm install
fi
if [[ ! -d "$ELECTRON_APP" ]]; then
  echo "Electron.app not found at $ELECTRON_APP — run npm install" >&2
  exit 1
fi

rm -rf "$APP_DIR"
# Real Electron host so process name / menu bar aren't "Electron"
cp -R "$ELECTRON_APP" "$APP_DIR"

CONTENTS="$APP_DIR/Contents"
MACOS="$CONTENTS/MacOS"
RES="$CONTENTS/Resources"

# Rename binary Electron → Grok Desk
if [[ -f "$MACOS/Electron" ]]; then
  mv "$MACOS/Electron" "$MACOS/$APP_NAME"
fi

# App icon
ICNS="$ROOT/assets/GrokDesk.icns"
if [[ -f "$ICNS" ]]; then
  cp "$ICNS" "$RES/GrokDesk.icns"
  # Prefer our icon over Electron's
  rm -f "$RES/electron.icns" 2>/dev/null || true
fi
cp "$ROOT/web/public/icon.svg" "$RES/icon.svg" 2>/dev/null || true

# Point Electron at this project (package.json main → desktop/main.cjs)
rm -rf "$RES/app" "$RES/default_app.asar" 2>/dev/null || true
ln -sfn "$ROOT" "$RES/app"

# Bundle identity — this is what macOS uses for menu bar / About / Force Quit
cat > "$CONTENTS/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Grok Desk</string>
  <key>CFBundleDisplayName</key>
  <string>Grok Desk</string>
  <key>CFBundleIdentifier</key>
  <string>dev.freecoffee.grok-desk</string>
  <key>CFBundleVersion</key>
  <string>0.1.0</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleExecutable</key>
  <string>Grok Desk</string>
  <key>CFBundleIconFile</key>
  <string>GrokDesk</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>Grok Desk uses the microphone for optional voice mode.</string>
  <key>NSSupportsAutomaticGraphicsSwitching</key>
  <true/>
  <key>ElectronTeamID</key>
  <string></string>
</dict>
</plist>
EOF

# Helper that rebuilds UI if missing, then execs the real binary
# (macOS still sees process as Grok Desk because this is only used if needed —
#  we keep the Electron binary as CFBundleExecutable.)
# Ensure PkgInfo
echo -n "APPL????" > "$CONTENTS/PkgInfo" 2>/dev/null || true

xattr -cr "$APP_DIR" 2>/dev/null || true

echo "Created: $APP_DIR"
echo "Double-click to open. Closing the window stops the local engine."

USER_APPS="$HOME/Applications"
mkdir -p "$USER_APPS"
rm -rf "$USER_APPS/$APP_NAME.app"
cp -R "$APP_DIR" "$USER_APPS/$APP_NAME.app"
# Keep Resources/app pointing at source tree (absolute symlink survives copy)
ln -sfn "$ROOT" "$USER_APPS/$APP_NAME.app/Contents/Resources/app"
xattr -cr "$USER_APPS/$APP_NAME.app" 2>/dev/null || true
echo "Also installed: $USER_APPS/$APP_NAME.app"
