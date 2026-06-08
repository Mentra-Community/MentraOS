#!/bin/bash
# Build and install ASG + recovery worker on a connected Mentra Live (ADB).
# Uses production signing from asg_client/credentials/asg-keystore.jks so
# signature permissions work between com.mentra.asg_client and com.mentra.recovery.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RECOVERY_DIR="$ROOT/recovery_worker"
ASG_APK="$ROOT/app/build/outputs/apk/debug/app-debug.apk"
RECOVERY_APK="$RECOVERY_DIR/app/build/outputs/apk/release/app-release.apk"

if ! adb devices | awk 'NR>1 && $2 ~ /^device/{found=1; exit} END{exit !found}'; then
  echo "ERROR: No ADB device. Connect glasses with Infinity Cable, then retry." >&2
  exit 1
fi

echo "=== Build recovery worker (release, ASG cert) and bundle into ASG assets ==="
cd "$RECOVERY_DIR"
chmod +x ./build_and_deploy.sh
./build_and_deploy.sh

echo "=== Build ASG debug APK (com.mentra.asg_client when production keystore present) ==="
cd "$ROOT"
./gradlew assembleDebug

echo "=== Install ASG + recovery sidecar ==="
adb install -r -d "$ASG_APK"
adb install -r "$RECOVERY_APK"

echo "=== Installed packages ==="
adb shell pm list packages | rg "com.mentra.asg_client|com.mentra.recovery|otaupdater" || true

echo ""
echo "Done. RecoveryWorkerManager will start the sidecar on next ASG boot."
echo "Quick checks:"
echo "  adb shell dumpsys activity services | rg com.mentra.recovery"
echo "  adb logcat | rg 'RecoveryWorker|RecoveryService|ServiceHeartbeat'"
