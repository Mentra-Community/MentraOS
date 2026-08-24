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

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ASG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$ASG_DIR/.." && pwd)"
source "$REPO_DIR/scripts/lib/glasses-device.sh"

STOCK_PKG="com.mentra.asg_client"
DEV_PKG="com.mentra.asg_client.thirdparty"
RECOVERY_PKG="com.mentra.recovery"
LEGACY_UPDATER_PKG="com.augmentos.otaupdater"
LEGACY_STOCK_FILES="/storage/emulated/0/Android/data/$STOCK_PKG/files"
LEGACY_STOCK_PARENT="/storage/emulated/0/Android/data/$STOCK_PKG"
LEGACY_STOCK_BACKUP="/storage/emulated/0/asg/dev_setup_stock_files_backup"
OTA_URL="https://ota.mentraglass.com/prod_live_version_v2.json"

echo "=== Restore Stock MentraOS ==="
echo ""

if [ -n "${ANDROID_SERIAL:-}" ] && [ -z "${ADB_SERIAL:-}" ]; then
    ADB_SERIAL="$ANDROID_SERIAL"
    export ADB_SERIAL
fi
resolve_serial
export ANDROID_SERIAL="$SERIAL"
echo ""

# Recover stock data staged outside the package-owned tree by an interrupted
# ASG bridge removal before doing any further package operations.
if adb shell test -d "$LEGACY_STOCK_BACKUP"; then
    echo "=== Restoring Preserved Stock Data ==="
    adb shell mkdir -p "$LEGACY_STOCK_PARENT"
    adb shell rmdir "$LEGACY_STOCK_FILES" >/dev/null 2>&1 || true
    if adb shell test -e "$LEGACY_STOCK_FILES"; then
        echo "ERROR: Both preserved and live stock-data trees exist." >&2
        echo "Preserved data remains at $LEGACY_STOCK_BACKUP" >&2
        exit 1
    fi
    # -T prevents a concurrently recreated files directory from turning the
    # restore into files/dev_setup_stock_files_backup. Fall back for old
    # Toybox builds, but detect and undo that nesting race before continuing.
    if ! adb shell mv -T "$LEGACY_STOCK_BACKUP" "$LEGACY_STOCK_FILES" >/dev/null 2>&1; then
        NESTED_BACKUP="$LEGACY_STOCK_FILES/${LEGACY_STOCK_BACKUP##*/}"
        if ! adb shell test -d "$LEGACY_STOCK_BACKUP"; then
            echo "ERROR: Could not verify the preserved stock-data location." >&2
            exit 1
        fi
        if adb shell test -e "$LEGACY_STOCK_FILES"; then
            echo "ERROR: The stock-data directory was recreated during restore." >&2
            echo "Preserved data remains at $LEGACY_STOCK_BACKUP" >&2
            exit 1
        fi
        adb shell mv "$LEGACY_STOCK_BACKUP" "$LEGACY_STOCK_FILES"
        if adb shell test -d "$NESTED_BACKUP"; then
            if adb shell mv "$NESTED_BACKUP" "$LEGACY_STOCK_BACKUP"; then
                echo "ERROR: The stock-data directory was recreated during restore." >&2
                echo "Preserved data was moved back to $LEGACY_STOCK_BACKUP" >&2
            else
                echo "ERROR: Preserved data remains safe at $NESTED_BACKUP" >&2
            fi
            exit 1
        fi
    fi
    if adb shell test -e "$LEGACY_STOCK_BACKUP"; then
        echo "ERROR: The preserved stock-data restore did not complete." >&2
        echo "Preserved data remains at $LEGACY_STOCK_BACKUP" >&2
        exit 1
    fi
    echo "Preserved stock data restored."
    echo ""
fi

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
adb shell pm enable "$RECOVERY_PKG" 2>/dev/null || true
adb shell pm enable "$LEGACY_UPDATER_PKG" 2>/dev/null || true
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
CURRENT_VERSION=$(adb shell dumpsys package "$STOCK_PKG" \
    | grep "versionCode=" \
    | head -1 \
    | sed 's/.*versionCode=//' \
    | cut -d' ' -f1 \
    || true)
echo "Current installed version: ${CURRENT_VERSION:-unknown}"

# Fetch latest version info from OTA server
if command -v curl &> /dev/null; then
    OTA_JSON=$(curl -s "$OTA_URL" 2>/dev/null || echo "")
    if [ -n "$OTA_JSON" ]; then
        LATEST_VERSION=$(echo "$OTA_JSON" \
            | grep -o '"versionCode": *[0-9]*' \
            | head -1 \
            | grep -o '[0-9]*' \
            || true)
        APK_URL=$(echo "$OTA_JSON" \
            | grep -o '"apkUrl": *"[^"]*"' \
            | head -1 \
            | sed 's/"apkUrl": *"//' \
            | sed 's/"$//' \
            || true)

        if [ -n "$CURRENT_VERSION" ] && [ -n "$LATEST_VERSION" ] && [ -n "$APK_URL" ]; then
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

# Step 5: Restore stock as default launcher
echo "=== Setting Stock as Default Launcher ==="
echo ""
# Clear any stale chooser-cached preferences left over from the dev build
# so Android doesn't show the "which launcher?" popup.
adb shell pm clear-package-preferred-activities "$STOCK_PKG" 2>/dev/null || true
adb shell pm clear-package-preferred-activities "$DEV_PKG" 2>/dev/null || true
adb shell cmd package set-home-activity --user 0 "$STOCK_PKG/com.mentra.asg_client.MainActivity" 2>/dev/null || true
echo "Default launcher set to stock."

echo ""

# Step 6: Launch stock app
echo "=== Launching Stock App ==="
adb shell am start -a android.intent.action.MAIN -c android.intent.category.HOME 2>/dev/null || true
adb shell am start -n "$STOCK_PKG/.MainActivity" 2>/dev/null || true

echo ""
echo "=== Stock Firmware Restored ==="
echo ""
echo "The stock MentraOS app is now active."
echo ""
