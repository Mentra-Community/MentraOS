#!/bin/bash

set -e

# Link keystore from shared credentials directory if not already present.
# ASG and recovery are signed with the same production cert, so asg-keystore.jks
# is accepted as a fallback when a dedicated recovery-keystore.jks is absent.
CREDS="${HOME}/.mentra/credentials"
mkdir -p credentials
if [ ! -f credentials/recovery-keystore.jks ] && [ -f "${CREDS}/recovery-keystore.jks" ]; then
  ln -sf "${CREDS}/recovery-keystore.jks" credentials/recovery-keystore.jks
elif [ ! -f credentials/recovery-keystore.jks ] && [ -f "${CREDS}/asg-keystore.jks" ]; then
  ln -sf "${CREDS}/asg-keystore.jks" credentials/recovery-keystore.jks
elif [ ! -f credentials/recovery-keystore.jks ] && [ -f "../../credentials/asg-keystore.jks" ]; then
  ln -sf "../../credentials/asg-keystore.jks" credentials/recovery-keystore.jks
fi

if [ -f credentials/recovery-keystore.jks ]; then
  echo "Building recovery worker (release)..."
  ./gradlew assembleRelease
  APK=app/build/outputs/apk/release/app-release.apk
elif [ "${BUILD_DEBUG:-0}" = "1" ]; then
  echo "BUILD_DEBUG=1: building debug recovery worker (local dev only — NOT for release)..."
  ./gradlew assembleDebug
  APK=app/build/outputs/apk/debug/app-debug.apk
else
  echo "ERROR: Release keystore not found at credentials/recovery-keystore.jks" >&2
  echo "  Place the keystore there, or link it from ${CREDS}/recovery-keystore.jks" >&2
  echo "  For local dev without a keystore, set BUILD_DEBUG=1." >&2
  exit 1
fi

echo "Copying to ASG client assets..."
cp "${APK}" ../app/src/main/assets/recovery_worker.apk

echo "Done!"
ls -lh ../app/src/main/assets/recovery_worker.apk
