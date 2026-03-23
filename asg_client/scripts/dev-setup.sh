#!/bin/bash
#
# dev-setup.sh - Install your custom asg_client on Mentra Live
#
# This script builds your fork of asg_client, disables the stock app,
# and installs your version as the default launcher.
#
# How it works:
#   - Stock asg_client is a system app signed with Mentra's key
#   - Your build uses package name com.mentra.asg_client.thirdparty
#   - Stock app is disabled (not deleted) so your app becomes the launcher
#   - To restore stock: ./scripts/restore-stock.sh
#
# Usage:
#   1. Connect to your Mentra Live via ADB (Infinity Cable)
#   2. Run: ./scripts/dev-setup.sh
#

set -e

STOCK_PKG="com.mentra.asg_client"
DEV_PKG="com.mentra.asg_client.thirdparty"
APK_PATH="app/build/outputs/apk/debug/app-debug.apk"

echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                         ⚠️  WARNING                            ║"
echo "╠════════════════════════════════════════════════════════════════╣"
echo "║  This script will:                                             ║"
echo "║    • Disable Mentra's stock asg_client                         ║"
echo "║    • Install your build as com.mentra.asg_client.thirdparty    ║"
echo "║    • Set your build as the default launcher                    ║"
echo "║                                                                ║"
echo "║  After running this:                                           ║"
echo "║    • You will NOT receive OTA updates from Mentra              ║"
echo "║    • You are responsible for your own builds                   ║"
echo "║                                                                ║"
echo "║  DO NOT interrupt this script once it starts.                  ║"
echo "║                                                                ║"
echo "║  To restore stock firmware later:                              ║"
echo "║    ./scripts/restore-stock.sh                                  ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
read -p "Proceed? [y/N] " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
fi

echo ""
echo "=== Mentra Live Development Setup ==="
echo ""

# Check for ADB connection
if ! adb devices | grep -q "device$"; then
    echo "ERROR: No ADB device connected."
    echo ""
    echo "Connect your Mentra Live using the Infinity Cable and try again."
    echo ""
    exit 1
fi

echo "Connected device:"
adb devices | grep "device$"
echo ""

# Step 1: Build the debug APK
echo "=== Building Debug APK ==="
echo ""
echo "Building... (this may take a minute)"
if ./gradlew assembleDebug; then
    echo ""
    echo "Build succeeded."
else
    echo ""
    echo "ERROR: Build failed. Stock app NOT modified."
    echo "Fix build errors and try again."
    exit 1
fi

# Verify APK exists
if [ ! -f "$APK_PATH" ]; then
    echo "ERROR: APK not found at $APK_PATH"
    echo "Build may have failed silently. Stock app NOT modified."
    exit 1
fi

echo ""

# Step 2: Disable stock app
echo "=== Disabling Stock App ==="
echo ""
echo "Disabling $STOCK_PKG..."
adb shell pm disable-user --user 0 "$STOCK_PKG" 2>/dev/null || true
echo "Stock app disabled."

echo ""

# Step 3: Uninstall any previous dev build
echo "=== Removing Previous Dev Build (if any) ==="
echo ""
adb shell pm uninstall "$DEV_PKG" 2>/dev/null || true

# Step 4: Install new build
echo "=== Installing Your Build ==="
echo ""
echo "Installing $APK_PATH..."
if adb install -g "$APK_PATH"; then
    echo "Install succeeded."
else
    echo ""
    echo "ERROR: Install failed."
    exit 1
fi

echo ""

# Step 5: Grant additional permissions
echo "=== Granting Permissions ==="
echo ""

PERMISSIONS=(
    "android.permission.CAMERA"
    "android.permission.RECORD_AUDIO"
    "android.permission.ACCESS_FINE_LOCATION"
    "android.permission.ACCESS_COARSE_LOCATION"
    "android.permission.ACCESS_BACKGROUND_LOCATION"
    "android.permission.BLUETOOTH"
    "android.permission.BLUETOOTH_ADMIN"
    "android.permission.BLUETOOTH_CONNECT"
    "android.permission.BLUETOOTH_SCAN"
    "android.permission.BLUETOOTH_ADVERTISE"
    "android.permission.READ_EXTERNAL_STORAGE"
    "android.permission.WRITE_EXTERNAL_STORAGE"
    "android.permission.READ_MEDIA_IMAGES"
    "android.permission.READ_MEDIA_VIDEO"
    "android.permission.POST_NOTIFICATIONS"
    "android.permission.READ_PHONE_STATE"
)

for perm in "${PERMISSIONS[@]}"; do
    if adb shell pm grant "$DEV_PKG" "$perm" 2>/dev/null; then
        echo "Granted: $perm"
    fi
done

echo ""

# Step 6: Launch the app
echo "=== Launching App ==="
adb shell am start -n "$DEV_PKG/.MainActivity" 2>/dev/null || true

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Your build ($DEV_PKG) is now the active launcher."
echo ""
echo "Useful commands:"
echo "  View logs:        adb logcat -s ASGClient"
echo "  Reinstall:        adb install -r -g $APK_PATH"
echo "  Restore stock:    ./scripts/restore-stock.sh"
echo ""
