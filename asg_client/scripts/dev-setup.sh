#!/bin/bash
#
# dev-setup.sh - Prepare Mentra Live glasses for development
#
# This script uninstalls the factory-signed asg_client app and grants
# all required permissions to your development build.
#
# IMPORTANT: Mentra Live glasses ship with com.mentra.asg_client signed
# with our release key. Since you don't have access to that key, you must
# uninstall the factory app before installing your own debug build.
#
# Usage:
#   1. Connect to your Mentra Live via ADB (see README.md)
#   2. Run: ./scripts/dev-setup.sh
#   3. Build and install your debug APK: ./gradlew installDebug
#

set -e

PKG="com.mentra.asg_client"

echo "=== Mentra Live Development Setup ==="
echo ""

# Check for ADB connection
if ! adb devices | grep -q "device$"; then
    echo "ERROR: No ADB device connected."
    echo ""
    echo "To connect to your Mentra Live:"
    echo "  1. Pair your glasses in the MentraOS app"
    echo "  2. Connect glasses to your WiFi network"
    echo "  3. Get the IP from the 'Glasses' screen in the app"
    echo "  4. Run: adb connect <IP_ADDRESS>:5555"
    echo ""
    exit 1
fi

echo "Connected device:"
adb devices | grep "device$"
echo ""

# Check if factory app is installed
if adb shell pm list packages | grep -q "$PKG"; then
    echo "Found factory app ($PKG). Uninstalling..."
    adb uninstall "$PKG" || true
    echo "Factory app uninstalled."
else
    echo "Factory app not installed (already removed or fresh device)."
fi

echo ""
echo "=== Granting Permissions ==="
echo ""
echo "Note: Some permissions may fail to grant (this is normal for"
echo "permissions that aren't runtime permissions or don't exist"
echo "on this Android version)."
echo ""

# Permissions that can be granted via adb
# Based on AndroidManifest.xml declarations
PERMISSIONS=(
    "android.permission.ACCESS_FINE_LOCATION"
    "android.permission.ACCESS_COARSE_LOCATION"
    "android.permission.ACCESS_BACKGROUND_LOCATION"
    "android.permission.BLUETOOTH"
    "android.permission.BLUETOOTH_ADMIN"
    "android.permission.BLUETOOTH_CONNECT"
    "android.permission.BLUETOOTH_SCAN"
    "android.permission.BLUETOOTH_ADVERTISE"
    "android.permission.RECORD_AUDIO"
    "android.permission.CAMERA"
    "android.permission.READ_EXTERNAL_STORAGE"
    "android.permission.WRITE_EXTERNAL_STORAGE"
    "android.permission.READ_MEDIA_IMAGES"
    "android.permission.READ_MEDIA_VIDEO"
    "android.permission.POST_NOTIFICATIONS"
    "android.permission.READ_PHONE_STATE"
)

# First, install your debug build if it exists
APK_PATH="app/build/outputs/apk/debug/app-debug.apk"
if [ -f "$APK_PATH" ]; then
    echo "Found debug APK. Installing..."
    adb install -r "$APK_PATH"
    echo "Debug APK installed."
    echo ""
fi

# Check if package is now installed
if ! adb shell pm list packages | grep -q "$PKG"; then
    echo "WARNING: $PKG is not installed."
    echo "Build and install your APK first, then run this script again"
    echo "to grant permissions, or run:"
    echo "  ./gradlew installDebug && ./scripts/dev-setup.sh --grant-only"
    echo ""
    exit 0
fi

# Grant permissions
for perm in "${PERMISSIONS[@]}"; do
    echo -n "Granting $perm... "
    if adb shell pm grant "$PKG" "$perm" 2>/dev/null; then
        echo "OK"
    else
        echo "skipped (not a runtime permission or N/A)"
    fi
done

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Your Mentra Live is ready for development!"
echo ""
echo "Next steps:"
echo "  1. If you haven't already: ./gradlew installDebug"
echo "  2. The app should auto-start, or launch it manually"
echo "  3. View logs: adb logcat -s ASGClient"
echo ""
