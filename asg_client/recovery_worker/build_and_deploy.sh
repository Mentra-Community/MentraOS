#!/bin/bash

set -e

CREDS="${HOME}/.mentra/credentials"
mkdir -p credentials
if [ ! -f credentials/recovery-keystore.jks ] && [ -f "${CREDS}/recovery-keystore.jks" ]; then
  ln -sf "${CREDS}/recovery-keystore.jks" credentials/recovery-keystore.jks
fi

if [ -f credentials/recovery-keystore.jks ]; then
  echo "Building recovery worker (release)..."
  ./gradlew assembleRelease
  APK=app/build/outputs/apk/release/app-release.apk
else
  echo "No release keystore; building debug APK for asset bundle..."
  ./gradlew assembleDebug
  APK=app/build/outputs/apk/debug/app-debug.apk
fi

echo "Copying to ASG client assets..."
cp "${APK}" ../app/src/main/assets/recovery_worker.apk

echo "Done!"
ls -lh ../app/src/main/assets/recovery_worker.apk
