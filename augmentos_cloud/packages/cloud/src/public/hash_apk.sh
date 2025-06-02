#!/bin/bash
# Calculate SHA256 hash of update.apk in this directory and update version.json
APK_FILE="update.apk"
VERSION_JSON="version.json"

if [ ! -f "$APK_FILE" ]; then
  echo "File $APK_FILE does not exist!"
  exit 1
fi

HASH=$(sha256sum "$APK_FILE" | awk '{print $1}')

if [ ! -f "$VERSION_JSON" ]; then
  echo "File $VERSION_JSON does not exist!"
  exit 1
fi

# Use jq if available, else fallback to sed
if command -v jq > /dev/null 2>&1; then
  jq --arg hash "$HASH" '.sha256 = $hash' "$VERSION_JSON" > tmp.$$.json && mv tmp.$$.json "$VERSION_JSON"
  echo "Updated sha256 in $VERSION_JSON to $HASH (using jq)"
else
  # Fallback: sed (assumes sha256 is on its own line)
  sed -i '' "s/\("sha256":\s*\)\"[a-f0-9]*\"/\1\"$HASH\"/" "$VERSION_JSON"
  echo "Updated sha256 in $VERSION_JSON to $HASH (using sed)"
fi

echo "SHA256: $HASH" 