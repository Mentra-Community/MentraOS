#!/bin/bash
#
# restore-stock.sh - Restore stock MentraOS on Mentra Live
#
# This script removes your third-party asg_client build, re-enables the
# stock app, and optionally updates it to the latest version from Mentra.
#
# Usage:
#   ./scripts/restore-stock.sh
#

set -e

STOCK_PKG="com.mentra.asg_client"
DEV_PKG="com.mentra.asg_client.thirdparty"
OTA_URL="https://ota.mentraglass.com/prod_live_version.json"

echo "=== Restore Stock MentraOS ==="
echo ""

# Check for ADB connection
if ! adb devices | grep -q "device$"; then
    echo "ERROR: No ADB device connected."
    echo ""
    echo "Connect your Mentra Live using the Infinity Cable and try again."
    exit 1
fi

echo "Connected device:"
adb devices | grep "device$"
echo ""

# Step 1: Uninstall third-party build
echo "=== Removing Third-Party Build ==="
echo ""
if adb shell pm uninstall "$DEV_PKG" 2>&1 | grep -q "Success"; then
    echo "Third-party build removed."
else
    echo "No third-party build installed (or already removed)."
fi

echo ""

# Step 2: Re-enable stock app
echo "=== Re-enabling Stock App ==="
echo ""
adb shell pm enable "$STOCK_PKG" 2>/dev/null || true
adb shell cmd package install-existing "$STOCK_PKG" 2>/dev/null || true
echo "Stock app enabled."

echo ""

# Step 3: Grant permissions (failsafe)
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
    adb shell pm grant "$STOCK_PKG" "$perm" 2>/dev/null || true
done
echo "Permissions granted."

echo ""

# Step 4: Check for updates
echo "=== Checking for Updates ==="
echo ""

# Get current installed version
CURRENT_VERSION=$(adb shell dumpsys package "$STOCK_PKG" | grep "versionCode=" | head -1 | sed 's/.*versionCode=//' | cut -d' ' -f1)
echo "Current installed version: $CURRENT_VERSION"

# Fetch latest version info from OTA server
if command -v curl &> /dev/null; then
    OTA_JSON=$(curl -s "$OTA_URL" 2>/dev/null || echo "")
    if [ -n "$OTA_JSON" ]; then
        LATEST_VERSION=$(echo "$OTA_JSON" | grep -o '"versionCode": *[0-9]*' | head -1 | grep -o '[0-9]*')
        APK_URL=$(echo "$OTA_JSON" | grep -o '"apkUrl": *"[^"]*"' | head -1 | sed 's/"apkUrl": *"//' | sed 's/"$//')

        if [ -n "$LATEST_VERSION" ] && [ -n "$APK_URL" ]; then
            echo "Latest available version: $LATEST_VERSION"

            if [ "$CURRENT_VERSION" -lt "$LATEST_VERSION" ] 2>/dev/null; then
                echo ""
                read -p "Update available! Download and install v$LATEST_VERSION? [y/N] " -n 1 -r
                echo ""
                if [[ $REPLY =~ ^[Yy]$ ]]; then
                    echo ""
                    echo "Downloading latest asg_client..."
                    TEMP_APK="/tmp/asg_client_latest.apk"
                    if curl -L -o "$TEMP_APK" "$APK_URL" 2>/dev/null; then
                        echo "Installing..."
                        if adb install -r "$TEMP_APK" 2>/dev/null; then
                            echo "Updated to v$LATEST_VERSION successfully!"
                            rm -f "$TEMP_APK"
                        else
                            echo "Install failed. Stock app is still enabled at v$CURRENT_VERSION."
                            rm -f "$TEMP_APK"
                        fi
                    else
                        echo "Download failed. Stock app is still enabled at v$CURRENT_VERSION."
                    fi
                else
                    echo "Skipping update."
                fi
            else
                echo "Already on latest version."
            fi
        fi
    else
        echo "Could not check for updates (no network or server unavailable)."
    fi
else
    echo "curl not found, skipping update check."
fi

echo ""

# Step 5: Launch stock app
echo "=== Launching Stock App ==="
adb shell am start -n "$STOCK_PKG/.MainActivity" 2>/dev/null || true

echo ""
echo "=== Stock Firmware Restored ==="
echo ""
echo "The stock MentraOS app is now active."
echo ""
