#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/export-bluetooth-sdk-ios-spm.sh [target-dir] [--verify]

Exports the SwiftPM-ready iOS Bluetooth SDK from the MentraOS monorepo into a
standalone package repository. The target defaults to ../mentra-bluetooth-sdk-ios.

Options:
  --target DIR   Export into DIR.
  --verify       Run SwiftPM describe and a generic iOS xcodebuild after export.
  -h, --help     Show this help.
EOF
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sdk_root="$repo_root/mobile/modules/bluetooth-sdk"
target_root="$repo_root/../mentra-bluetooth-sdk-ios"
verify=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      target_root="$2"
      shift 2
      ;;
    --target=*)
      target_root="${1#--target=}"
      shift
      ;;
    --verify)
      verify=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      target_root="$1"
      shift
      ;;
  esac
done

if [[ ! -d "$sdk_root/ios/Source" ]]; then
  echo "Could not find Bluetooth SDK source at $sdk_root" >&2
  exit 1
fi

target_parent="$(dirname "$target_root")"
target_name="$(basename "$target_root")"
mkdir -p "$target_parent"
target_parent="$(cd "$target_parent" && pwd -P)"
target_root="$target_parent/$target_name"

if [[ -z "$target_name" || "$target_name" == "." || "$target_name" == ".." || "$target_root" == "/" ]]; then
  echo "Refusing unsafe SwiftPM export target: $target_root" >&2
  exit 1
fi

case "$target_root" in
  "$repo_root"|"$repo_root"/*)
    echo "Refusing to export inside the MentraOS source checkout: $target_root" >&2
    exit 1
    ;;
esac

if [[ -d "$target_root" && ! -d "$target_root/.git" ]] && find "$target_root" -mindepth 1 -maxdepth 1 | read -r _; then
  echo "Refusing to overwrite non-empty non-git directory: $target_root" >&2
  exit 1
fi

sdk_version="$(
  node -e '
    const fs = require("fs")
    const packageJson = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    if (!packageJson.version) {
      throw new Error("Missing version in Bluetooth SDK package.json")
    }
    process.stdout.write(packageJson.version)
  ' "$sdk_root/package.json"
)"

mkdir -p "$target_root"
find "$target_root" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf -- {} +

mkdir -p "$target_root/ios/Source" "$target_root/ios/Packages/CoreObjC"

cat > "$target_root/Package.swift" <<'EOF'
// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "MentraBluetoothSDK",
  platforms: [
    .iOS("15.1")
  ],
  products: [
    .library(
      name: "MentraBluetoothSDK",
      targets: ["MentraBluetoothSDK"]
    )
  ],
  targets: [
    .target(
      name: "MentraBluetoothSDK",
      dependencies: [
        "MentraBluetoothSDKCoreObjC"
      ],
      path: "ios/Source",
      resources: [
        .process("PrivacyInfo.xcprivacy")
      ]
    ),
    .target(
      name: "MentraBluetoothSDKCoreObjC",
      path: "ios/Packages/CoreObjC",
      publicHeadersPath: "include",
      cSettings: [
        .headerSearchPath(".")
      ]
    )
  ]
)
EOF

cat > "$target_root/.gitignore" <<'EOF'
.DS_Store
.build/
.swiftpm/
DerivedData/
*.xcuserdata
*.xcuserstate
EOF

cat > "$target_root/README.md" <<'EOF'
# Mentra Bluetooth SDK for iOS

Native Swift package for building iOS apps that connect directly to Mentra smart glasses over Bluetooth.

## Installation

Add this repository in Xcode with Swift Package Manager:

```text
https://github.com/Mentra-Community/mentra-bluetooth-sdk-ios.git
```

Then add the `MentraBluetoothSDK` product to your app target.

For `Package.swift` consumers:

```swift
.package(
  url: "https://github.com/Mentra-Community/mentra-bluetooth-sdk-ios.git",
  from: "__SDK_VERSION__"
)
```

```swift
.product(name: "MentraBluetoothSDK", package: "mentra-bluetooth-sdk-ios")
```

## Requirements

- iOS 15.1 or newer
- Xcode 15 or newer
- A physical iPhone for Bluetooth testing

## Usage

```swift
import MentraBluetoothSDK

@MainActor
final class GlassesController: NSObject, MentraBluetoothSDKDelegate {
  private let sdk = MentraBluetoothSDK()
  private var selectedDevice: Device?

  override init() {
    super.init()
    sdk.delegate = self
  }

  func scan() throws {
    try sdk.scan(model: .mentraLive, timeout: 10) { devices in
      self.selectedDevice = devices.first
    }
  }

  func connect() throws {
    guard let selectedDevice else { return }
    try sdk.connect(to: selectedDevice)
  }

  func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didUpdateGlasses glasses: GlassesRuntimeState) {
    print("Glasses changed: \(glasses)")
  }
}
```

## Permissions

Add Bluetooth usage text to your app's `Info.plist`:

```xml
<key>NSBluetoothAlwaysUsageDescription</key>
<string>This app connects to your smart glasses over Bluetooth.</string>
```

If your app uses microphone features, also add:

```xml
<key>NSMicrophoneUsageDescription</key>
<string>This app uses the microphone when you enable audio features.</string>
```

To keep the BLE link alive while the app is backgrounded, enable Core Bluetooth background mode:

```xml
<key>UIBackgroundModes</key>
<array>
  <string>bluetooth-central</string>
</array>
```

## Scope

This Swift package contains the core iOS Bluetooth SDK. It intentionally excludes optional MentraOS-internal code paths for local STT, offline TTS, Nex/SwiftProtobuf, Vuzix/Ultralite, and tar.bz2 extraction.
EOF
perl -0pi -e "s/__SDK_VERSION__/${sdk_version}/g" "$target_root/README.md"

cp "$repo_root/LICENSE" "$target_root/LICENSE"

# Keep this list limited to optional/internal code paths that need dependencies
# not exported in the public SwiftPM package.
source_excludes=(
  "/Bridging-Header.h"
  "/sgcs/Mach1.swift"
  "/sgcs/MentraNex.swift"
  "/sgcs/mentraos_ble.pb.swift"
  "/stt/***"
  "/tts/***"
  "/utils/TarBz2Extractor.swift"
)

source_rsync_args=(-a)
for exclude_path in "${source_excludes[@]}"; do
  source_rsync_args+=(--exclude="$exclude_path")
done

rsync "${source_rsync_args[@]}" \
  "$sdk_root/ios/Source/" \
  "$target_root/ios/Source/"

perl -0pi -e "s/__MENTRA_BLUETOOTH_SDK_VERSION__/${sdk_version}/g" \
  "$target_root/ios/Source/BluetoothSdkDefaults.swift"

if grep -R "__MENTRA_BLUETOOTH_SDK_VERSION__" "$target_root/ios/Source" >/dev/null; then
  echo "SwiftPM export still contains the Bluetooth SDK version placeholder." >&2
  exit 1
fi

rsync -a \
  --exclude='CoreObjC.xcodeproj' \
  --exclude='makefile.mk' \
  --exclude='meson.build' \
  "$sdk_root/ios/Packages/CoreObjC/" \
  "$target_root/ios/Packages/CoreObjC/"

find "$target_root" -name '.DS_Store' -delete

if [[ "$verify" -eq 1 ]]; then
  (
    cd "$target_root"
    xcrun swift package describe >/dev/null
    xcodebuild \
      -scheme MentraBluetoothSDK \
      -destination 'generic/platform=iOS' \
      -sdk iphoneos \
      CODE_SIGNING_ALLOWED=NO \
      build >/dev/null
  )
fi

echo "Exported MentraBluetoothSDK Swift package to $target_root"
