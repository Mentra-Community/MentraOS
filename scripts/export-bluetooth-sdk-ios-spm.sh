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

mkdir -p "$target_root"
find "$target_root" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +

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
  from: "0.1.7"
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

This Swift package contains the core iOS Bluetooth SDK. It intentionally excludes optional MentraOS-internal code paths for local STT, Nex/SwiftProtobuf, Vuzix/Ultralite, and tar.bz2 extraction.
EOF

cp "$repo_root/LICENSE" "$target_root/LICENSE"

swift_sources=(
  "ios/Source/Audio/AudioModels.swift"
  "ios/Source/Bridge.swift"
  "ios/Source/Camera/CameraModels.swift"
  "ios/Source/Connection/ScanSession.swift"
  "ios/Source/DeviceManager.swift"
  "ios/Source/DeviceStore.swift"
  "ios/Source/Errors/BluetoothError.swift"
  "ios/Source/Events/BluetoothEvents.swift"
  "ios/Source/Internal/BluetoothAvailability.swift"
  "ios/Source/Internal/ValueParsing.swift"
  "ios/Source/MentraBluetoothSDK.swift"
  "ios/Source/ObservableStore.swift"
  "ios/Source/PrivacyInfo.xcprivacy"
  "ios/Source/Requests/DisplayRequests.swift"
  "ios/Source/Status/DeviceStatus.swift"
  "ios/Source/Status/RuntimeState.swift"
  "ios/Source/Status/WifiHotspotStatus.swift"
  "ios/Source/Streaming/StreamModels.swift"
  "ios/Source/Types/DeviceModels.swift"
  "ios/Source/controllers/ControllerManager.swift"
  "ios/Source/controllers/R1.swift"
  "ios/Source/services/PhoneMic.swift"
  "ios/Source/sgcs/Frame.swift"
  "ios/Source/sgcs/G1.swift"
  "ios/Source/sgcs/G2.swift"
  "ios/Source/sgcs/MentraLive.swift"
  "ios/Source/sgcs/SGCManager.swift"
  "ios/Source/sgcs/Simulated.swift"
  "ios/Source/utils/AudioSessionMonitor.swift"
  "ios/Source/utils/Constants.swift"
  "ios/Source/utils/Enums.swift"
  "ios/Source/utils/G1Text.swift"
  "ios/Source/utils/JSCExperiment.swift"
  "ios/Source/utils/MemoryMonitor.swift"
  "ios/Source/utils/MessageChunkReassembler.swift"
  "ios/Source/utils/MessageChunker.swift"
  "ios/Source/utils/Models.swift"
  "ios/Source/utils/PhoneAudioMonitor.swift"
)

for rel_path in "${swift_sources[@]}"; do
  mkdir -p "$target_root/$(dirname "$rel_path")"
  cp "$sdk_root/$rel_path" "$target_root/$rel_path"
done

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
