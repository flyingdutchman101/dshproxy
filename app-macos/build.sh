#!/bin/bash
# Builds DSHProxy.app in the root of this DSHProxy folder (git-ignored), with the
# Command Line Tools alone: swift build -c release, then the bundle, ad-hoc signed.
# The app's Info.plist records this folder's path (DSHProxyCheckout), so the app
# still finds bin/dshproxy.js when it is moved. Works from any directory; running
# it again replaces the app.
set -euo pipefail

package="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
root="$(cd "$package/.." && pwd -P)"
if [[ ! -f "$root/bin/dshproxy.js" || ! -f "$root/package.json" ]]; then
  echo "build.sh: $root does not look like a DSHProxy folder (no bin/dshproxy.js)." >&2
  exit 1
fi

swift build -c release --package-path "$package"
bin="$(swift build -c release --package-path "$package" --show-bin-path)"
version="$(/usr/bin/plutil -extract version raw -o - "$root/package.json")"

app="${root:?}/DSHProxy.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$bin/DSHProxyApp" "$app/Contents/MacOS/DSHProxy"

xml_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>com.dshproxy.app</string>
	<key>CFBundleName</key>
	<string>DSHProxy</string>
	<key>CFBundleExecutable</key>
	<string>DSHProxy</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleShortVersionString</key>
	<string>$(xml_escape "$version")</string>
	<key>CFBundleVersion</key>
	<string>$(xml_escape "$version")</string>
	<key>LSUIElement</key>
	<true/>
	<key>LSMinimumSystemVersion</key>
	<string>13.0</string>
	<key>DSHProxyCheckout</key>
	<string>$(xml_escape "$root")</string>
</dict>
</plist>
PLIST
/usr/bin/plutil -lint "$app/Contents/Info.plist" >/dev/null

codesign --force -s - "$app"
codesign --verify "$app"

echo "Made $app"
echo "  version    $version"
echo "  executable $app/Contents/MacOS/DSHProxy (from $bin/DSHProxyApp)"
echo "  checkout   $root (Info.plist DSHProxyCheckout)"
echo "  signed     ad hoc (codesign --verify passed)"
