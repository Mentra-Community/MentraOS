#!/usr/bin/env bash
set -euo pipefail

# Isolated device test: compiles only the production checker and its regression test, then runs
# them with app_process. Does not install/replace ASG, capture camera media, or change firmware.
asg_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sdk_root="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
android_jar="${ANDROID_JAR:-$sdk_root/platforms/android-34/android.jar}"
d8_bin="${D8:-$sdk_root/build-tools/35.0.0/d8}"
serial="${ADB_SERIAL:?Set ADB_SERIAL to the connected Mentra Live device}"
source_file="$asg_root/app/src/main/java/com/mentra/asg_client/io/media/core/RecordedVideoIntegrityChecker.java"
test_root="$asg_root/tests/video-integrity"
scratch="$(mktemp -d)"
remote="/data/local/tmp/mentra-video-integrity-$(basename "$scratch")"
cleanup() {
    adb -s "$serial" shell "rm -rf '$remote'" >/dev/null 2>&1 || true
    rm -rf "$scratch"
}
trap cleanup EXIT

# Optional immutable baseline, for reproducing the same test failure before the fix.
if [[ -n "${ASG_INTEGRITY_SOURCE_REF:-}" ]]; then
    git -C "$asg_root" show "$ASG_INTEGRITY_SOURCE_REF:asg_client/app/src/main/java/com/mentra/asg_client/io/media/core/RecordedVideoIntegrityChecker.java" \
        > "$scratch/RecordedVideoIntegrityChecker.java"
    source_file="$scratch/RecordedVideoIntegrityChecker.java"
fi

mkdir "$scratch/classes"
javac -source 8 -target 8 -bootclasspath "$android_jar" -d "$scratch/classes" \
    "$source_file" "$test_root/RecordedVideoIntegrityCheckerDeviceTest.java"
jar cf "$scratch/classes.jar" -C "$scratch/classes" .
"$d8_bin" --min-api 28 --lib "$android_jar" --output "$scratch/test.jar" "$scratch/classes.jar"
adb -s "$serial" shell "mkdir -p '$remote'"
adb -s "$serial" push "$scratch/test.jar" "$test_root/fixtures/"*.mp4 "$remote/" >/dev/null
adb -s "$serial" shell "CLASSPATH='$remote/test.jar' app_process / RecordedVideoIntegrityCheckerDeviceTest '$remote'"
