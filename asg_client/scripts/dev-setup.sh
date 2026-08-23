#!/bin/bash
#
# dev-setup.sh - Install your custom asg_client on Mentra Live
#
# This script builds your fork of asg_client, disables the stock app,
# and installs your version as the default launcher.
#
# How it works:
#   - Updates stock ASG/BES/MTK from one latest-staging manifest snapshot
#   - Stock asg_client is a system app signed with Mentra's key
#   - Your build uses package name com.mentra.asg_client.thirdparty
#   - Stock app is disabled (not deleted) so your app becomes the launcher
#   - To restore stock: ./scripts/restore-stock.sh
#
# Usage:
#   1. Connect to your Mentra Live via ADB (Infinity Cable)
#   2. Run: ./scripts/dev-setup.sh
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
APK_PATH="$ASG_DIR/app/build/outputs/apk/debug/app-debug.apk"

echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                         ⚠️  WARNING                            ║"
echo "╠════════════════════════════════════════════════════════════════╣"
echo "║  This script will:                                             ║"
echo "║    • Update stock ASG, BES, and MTK from latest staging        ║"
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

resolve_serial
ADB=(adb -s "$SERIAL")
export ANDROID_SERIAL="$SERIAL"
SETUP_MUTATED=false

restore_stock_after_failure() {
    local status=$?
    trap - EXIT
    if [ "$status" -ne 0 ] && [ "$SETUP_MUTATED" = true ] && "${ADB[@]}" get-state >/dev/null 2>&1; then
        echo ""
        echo "Setup failed; restoring the stock launcher..." >&2
        "${ADB[@]}" shell cmd package install-existing "$STOCK_PKG" >/dev/null 2>&1 || true
        "${ADB[@]}" shell pm enable "$STOCK_PKG" >/dev/null 2>&1 || true
        "${ADB[@]}" shell pm enable "$RECOVERY_PKG" >/dev/null 2>&1 || true
        "${ADB[@]}" shell cmd package set-home-activity --user 0 \
            "$STOCK_PKG/com.mentra.asg_client.MainActivity" >/dev/null 2>&1 || true
        "${ADB[@]}" shell am start -n \
            "$STOCK_PKG/com.mentra.asg_client.MainActivity" >/dev/null 2>&1 || true
    elif [ "$status" -ne 0 ] && [ "$SETUP_MUTATED" = true ]; then
        echo "Setup failed while ADB was offline." >&2
        echo "Reconnect the Infinity Cable, then run ./scripts/restore-stock.sh." >&2
    fi
    exit "$status"
}
trap restore_stock_after_failure EXIT
echo ""

# Step 1: Build the debug APK
echo "=== Building Debug APK ==="
echo ""
echo "Building... (this may take a minute)"
if (cd "$ASG_DIR" && ./gradlew assembleDebug); then
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

# Step 2: Put the stock firmware on a known-compatible staging baseline.
echo "=== Updating Mentra Live Firmware ==="
echo ""
ADB_SERIAL="$SERIAL" "$SCRIPT_DIR/update-stock-for-dev.sh"
SETUP_MUTATED=true

# Step 3: Disable stock and its recovery agents.
echo "=== Disabling Stock App ==="
echo ""
echo "Disabling stock recovery agents..."
"${ADB[@]}" shell am force-stop "$RECOVERY_PKG" 2>/dev/null || true
"${ADB[@]}" shell pm disable-user --user 0 "$RECOVERY_PKG" 2>/dev/null || true
"${ADB[@]}" shell am force-stop "$LEGACY_UPDATER_PKG" 2>/dev/null || true
"${ADB[@]}" shell pm disable-user --user 0 "$LEGACY_UPDATER_PKG" 2>/dev/null || true
echo "Disabling $STOCK_PKG..."
"${ADB[@]}" shell pm disable-user --user 0 "$STOCK_PKG" 2>/dev/null || true
echo "Stock app disabled."

echo ""

# Step 4: Uninstall any previous dev build
echo "=== Removing Previous Dev Build (if any) ==="
echo ""
"${ADB[@]}" shell pm uninstall "$DEV_PKG" 2>/dev/null || true

# Step 5: Install new build
echo "=== Installing Your Build ==="
echo ""
echo "Installing $APK_PATH..."
if "${ADB[@]}" install -g "$APK_PATH"; then
    echo "Install succeeded."
else
    echo ""
    echo "ERROR: Install failed."
    exit 1
fi

echo ""

# Step 6: Grant additional permissions
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
    if "${ADB[@]}" shell pm grant "$DEV_PKG" "$perm" 2>/dev/null; then
        echo "Granted: $perm"
    fi
done

echo ""

# Step 7: Set as default home launcher
echo "=== Setting as Default Launcher ==="
echo ""
# Clear any stale chooser-cached preferences for both packages so the
# "which launcher?" popup doesn't reappear.
"${ADB[@]}" shell pm clear-package-preferred-activities "$STOCK_PKG" 2>/dev/null || true
"${ADB[@]}" shell pm clear-package-preferred-activities "$DEV_PKG" 2>/dev/null || true
"${ADB[@]}" shell cmd package set-home-activity --user 0 "$DEV_PKG/com.mentra.asg_client.MainActivity" 2>/dev/null || true
# Force the resolver to re-evaluate HOME so the new default takes effect now.
"${ADB[@]}" shell am start -a android.intent.action.MAIN -c android.intent.category.HOME 2>/dev/null || true
echo "Default launcher set."

echo ""

# Step 8: Launch the app
echo "=== Launching App ==="
"${ADB[@]}" shell am start -n "$DEV_PKG/com.mentra.asg_client.MainActivity" 2>/dev/null || true

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Your build ($DEV_PKG) is now the active launcher."
echo ""
echo "Useful commands:"
echo "  View logs:        adb logcat -s ASGClient"
echo "  Reinstall:        adb -s $SERIAL install -r -g $APK_PATH"
echo "  Restore stock:    ./scripts/restore-stock.sh"
echo ""
