#!/bin/bash

set -e

echo "Building OTA Updater..."
./gradlew assembleRelease

echo "Copying to ASG client assets..."
cp app/build/outputs/apk/release/app-release.apk ../app/src/main/assets/ota_updater.apk

echo "Done!"
ls -lh ../app/src/main/assets/ota_updater.apk