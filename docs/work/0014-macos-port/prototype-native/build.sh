#!/bin/bash
# Builds "build/DSHProxy Prototype.app" with swiftc from the Command Line Tools.
# No Xcode, no SwiftPM, no packages, no network. Ad-hoc signed.
#   ./build.sh            build the app
#   ./build.sh --render   build, then run the render mode into build/render/
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HERE/build/DSHProxy Prototype.app"
BIN_NAME="DSHProxyPrototype"
ARCH="$(uname -m)"   # arm64 on Apple silicon, x86_64 on Intel

echo "swiftc: $(swiftc --version 2>&1 | head -n 1)"
echo "SDK:    $(xcrun --show-sdk-version 2>/dev/null || echo unknown)"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

swiftc -parse-as-library \
  -target "$ARCH-apple-macos13" \
  -O \
  -module-name DSHProxyPrototype \
  -o "$APP/Contents/MacOS/$BIN_NAME" \
  "$HERE"/Sources/*.swift

# App icon: drawn by the program itself (SwiftUI shapes), turned into .icns by iconutil.
rm -rf "$HERE/build/AppIcon.iconset"
"$APP/Contents/MacOS/$BIN_NAME" --write-iconset "$HERE/build/AppIcon.iconset"
iconutil -c icns -o "$APP/Contents/Resources/AppIcon.icns" "$HERE/build/AppIcon.iconset"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>$BIN_NAME</string>
  <key>CFBundleIdentifier</key><string>com.dshproxy.prototype</string>
  <key>CFBundleName</key><string>DSHProxy Prototype</string>
  <key>CFBundleDisplayName</key><string>DSHProxy Prototype</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleShortVersionString</key><string>0.0.1</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
PLIST

plutil -lint "$APP/Contents/Info.plist"
codesign --force --sign - "$APP"
codesign --verify --verbose=2 "$APP"
echo "Built: $APP"

if [[ "${1:-}" == "--render" ]]; then
  rm -rf "$HERE/build/render"
  "$APP/Contents/MacOS/$BIN_NAME" --render "$HERE/build/render"
fi
