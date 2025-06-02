#!/bin/bash
# Calculate SHA256 hash of update.apk in this directory
APK_FILE="update.apk"
if [ ! -f "$APK_FILE" ]; then
  echo "File $APK_FILE does not exist!"
  exit 1
fi
sha256sum "$APK_FILE" | awk '{print $1}' 