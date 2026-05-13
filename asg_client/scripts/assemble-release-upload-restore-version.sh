#!/usr/bin/env bash
#
# 1) Set app version to 28 (versionCode + versionName) in app/build.gradle
# 2) ./gradlew assembleRelease (from asg_client/)
# 3) Upload release APK via upload-asg-client-github-release.sh
# 4) Restore version to 26 in build.gradle
#
# If the script fails after step 1, an EXIT trap still restores 26 so the tree
# does not stay on 28.
#
# Usage (from repo root or asg_client):
#   ./asg_client/scripts/assemble-release-upload-restore-version.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$ASG_DIR/.." && pwd)"
GRADLE_FILE="$ASG_DIR/app/build.gradle"
UPLOAD_SCRIPT="$SCRIPT_DIR/upload-asg-client-github-release.sh"

# Build and upload with this version; then restore below.
BUILD_VERSION_CODE=38
BUILD_VERSION_NAME="38.0"
RESTORE_VERSION_CODE=36
RESTORE_VERSION_NAME="36.0"

MODIFIED=0

set_app_version() {
  local code="$1" name="$2"
  if ! grep -q '^        versionCode ' "$GRADLE_FILE"; then
    echo "error: could not find defaultConfig versionCode in $GRADLE_FILE" >&2
    exit 1
  fi
  if ! grep -q '^        versionName "' "$GRADLE_FILE"; then
    echo "error: could not find defaultConfig versionName in $GRADLE_FILE" >&2
    exit 1
  fi
  sed -i '' "s/^        versionCode .*/        versionCode ${code}/" "$GRADLE_FILE"
  sed -i '' "s/^        versionName \".*\"/        versionName \"${name}\"/" "$GRADLE_FILE"
}

restore_version_if_needed() {
  if [[ "$MODIFIED" -eq 1 ]]; then
    echo "Restoring app version to ${RESTORE_VERSION_CODE} (${RESTORE_VERSION_NAME}) in build.gradle..."
    set_app_version "$RESTORE_VERSION_CODE" "$RESTORE_VERSION_NAME"
  fi
}

trap restore_version_if_needed EXIT

echo "Setting app version to ${BUILD_VERSION_CODE} (${BUILD_VERSION_NAME}) in build.gradle..."
set_app_version "$BUILD_VERSION_CODE" "$BUILD_VERSION_NAME"
MODIFIED=1

echo "Running assembleRelease..."
(cd "$ASG_DIR" && ./gradlew assembleRelease)

echo "Uploading to GitHub release..."
"$UPLOAD_SCRIPT"

echo "Done (version will be restored to ${RESTORE_VERSION_CODE} on exit)."
