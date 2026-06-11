#!/usr/bin/env bash
# Build MentraBLE.app — a minimal wrapper bundle so node can use CoreBluetooth.
#
# Modern macOS aborts (TCC SIGABRT) any process that touches Bluetooth unless its
# main bundle's Info.plist declares NSBluetoothAlwaysUsageDescription. A bare node
# CLI has no bundle, so we run a COPY of node from inside this .app: when argv[0]
# lives in Contents/MacOS, [NSBundle mainBundle] resolves to the .app and macOS
# reads the usage description, then shows the normal one-time Bluetooth prompt.
#
# Idempotent: re-run any time. Safe to commit (it builds the bundle from the
# host's own node binary; the binary itself is gitignored).
set -euo pipefail
cd "$(dirname "$0")"

APP="MentraBLE.app"
NODE_BIN="$(command -v node)"
# resolve symlinks (nvm/volta/homebrew) to the real mach-o
NODE_REAL="$(node -e 'process.stdout.write(process.execPath)')"

echo "[make-app] host node: $NODE_REAL"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>MentraBLE</string>
  <key>CFBundleDisplayName</key><string>Mentra BLE Bridge</string>
  <key>CFBundleIdentifier</key><string>glass.mentra.ble-bridge</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>node</string>
  <key>LSUIElement</key><true/>
  <key>NSBluetoothAlwaysUsageDescription</key>
  <string>The MentraOS test harness uses Bluetooth to connect directly to Even Realities glasses for development and QA.</string>
  <key>NSBluetoothPeripheralUsageDescription</key>
  <string>The MentraOS test harness uses Bluetooth to connect directly to Even Realities glasses for development and QA.</string>
</dict>
</plist>
PLIST

cp "$NODE_REAL" "$APP/Contents/MacOS/node"

# Copying invalidates node's signature on arm64; ad-hoc re-sign so it launches.
codesign --force --sign - --identifier glass.mentra.ble-bridge "$APP/Contents/MacOS/node" 2>/dev/null || true
codesign --force --sign - "$APP" 2>/dev/null || true

echo "[make-app] built $APP — run BLE scripts via: $APP/Contents/MacOS/node <script.mjs>"
