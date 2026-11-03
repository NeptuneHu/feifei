#!/bin/zsh
set -eu
TASK_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$TASK_ROOT/dist/肥肥财经.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/web/assets/pig" "$APP/Contents/Resources/web/data" /private/tmp/feifei-swift-cache
/usr/bin/swiftc "$TASK_ROOT/native/PigPet.swift" -module-cache-path /private/tmp/feifei-swift-cache -framework Cocoa -framework WebKit -framework ServiceManagement -O -o "$APP/Contents/MacOS/Feifei"
cp "$TASK_ROOT/index.html" "$TASK_ROOT/styles.css" "$TASK_ROOT/app.js" "$APP/Contents/Resources/web/"
if [[ -f "$TASK_ROOT/data/brief.js" ]]; then
  cp "$TASK_ROOT/data/brief.js" "$TASK_ROOT/data/brief.json" "$APP/Contents/Resources/web/data/"
fi
cp "$TASK_ROOT"/assets/pig/*.png "$APP/Contents/Resources/web/assets/pig/"
if [[ -d "$TASK_ROOT/assets/AppIcon.iconset" ]]; then
  /usr/bin/iconutil -c icns "$TASK_ROOT/assets/AppIcon.iconset" -o "$APP/Contents/Resources/AppIcon.icns"
fi
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Feifei</string><key>CFBundleIconFile</key><string>AppIcon</string><key>CFBundleIdentifier</key><string>local.feifei.finance.pet</string><key>CFBundleName</key><string>肥肥财经</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>0.3.0</string><key>CFBundleVersion</key><string>3</string><key>LSUIElement</key><true/><key>NSHighResolutionCapable</key><true/><key>LSMinimumSystemVersion</key><string>12.0</string></dict></plist>
PLIST
/usr/bin/codesign --force --sign - "$APP"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$APP" "$TASK_ROOT/dist/肥肥财经-macOS.zip"
echo "Ready: $APP"
