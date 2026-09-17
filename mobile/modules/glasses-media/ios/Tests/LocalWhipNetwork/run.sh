#!/bin/bash
# Exercise the production receiver with a default internet path that omits local Wi-Fi.
set -euo pipefail
TEST_DIR="$(cd "$(dirname "$0")" && pwd)"
IOS_DIR="$(cd "$TEST_DIR/../.." && pwd)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mentra-whip-network.XXXXXX")"
SIM_ID="${WHIP_SIMULATOR_ID:-}"
OWN_SIM=0
cleanup() {
  if [ "$OWN_SIM" = 1 ]; then
    xcrun simctl shutdown "$SIM_ID" >/dev/null 2>&1 || true
    xcrun simctl delete "$SIM_ID" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

INTERFACE="${WHIP_TEST_INTERFACE:-en0}"
ADDRESS="$(ipconfig getifaddr "$INTERFACE")"
SDK_VERSION="$(ruby -e 'puts File.read(ARGV[0])[/s.dependency '\''WebRTC-SDK'\'', '\''([^'\'']+)'\''/, 1]' "$IOS_DIR/GlassesMedia.podspec")"
if [ -n "${WHIP_WEBRTC_XCFRAMEWORK:-}" ]; then
  FRAMEWORK="$WHIP_WEBRTC_XCFRAMEWORK/ios-arm64_x86_64-simulator"
else
  curl --fail --location --silent --show-error --retry 3 \
    "https://github.com/webrtc-sdk/Specs/releases/download/$SDK_VERSION/WebRTC.xcframework.zip" \
    -o "$WORK_DIR/WebRTC.zip"
  unzip -q "$WORK_DIR/WebRTC.zip" -d "$WORK_DIR"
  FRAMEWORK="$WORK_DIR/WebRTC.xcframework/ios-arm64_x86_64-simulator"
fi
if [ -z "$SIM_ID" ]; then
  RUNTIME="$(xcrun simctl list runtimes -j | python3 -c 'import json,sys; rs=[r for r in json.load(sys.stdin)["runtimes"] if r["isAvailable"] and ".iOS-" in r["identifier"]]; print(sorted(rs,key=lambda r:tuple(map(int,r["version"].split("."))))[-1]["identifier"])')"
  SIM_ID="$(xcrun simctl create MentraWhipNetworkTest com.apple.CoreSimulator.SimDeviceType.iPhone-16 "$RUNTIME")"
  OWN_SIM=1
  xcrun simctl boot "$SIM_ID"
fi
xcrun simctl bootstatus "$SIM_ID" -b >/dev/null
SDK_PATH="$(xcrun --sdk iphonesimulator --show-sdk-path)"
ARCH="$(uname -m)"
xcrun clang -dynamiclib -arch "$ARCH" -mios-simulator-version-min=15.5 -isysroot "$SDK_PATH" \
  "$TEST_DIR/InternetPathShim.m" -framework Network -o "$WORK_DIR/InternetPathShim.dylib"

# The control changes only the field trial. It must fail on the same real SDK, HTTP server,
# valid offer, and interface; this prevents a nonfunctional shim from yielding a false pass.
sed 's|WebRTC-Network-UseNWPathMonitor/Disabled/|WebRTC-Network-UseNWPathMonitor/Enabled/|' \
  "$IOS_DIR/GlassesPeerFactory.swift" > "$WORK_DIR/ControlFactory.swift"
for MODE in control fixed; do
  FACTORY="$IOS_DIR/GlassesPeerFactory.swift"
  EXPECT_FAILURE=0
  if [ "$MODE" = control ]; then FACTORY="$WORK_DIR/ControlFactory.swift"; EXPECT_FAILURE=1; fi
  xcrun swiftc -target "$ARCH-apple-ios15.5-simulator" -sdk "$SDK_PATH" \
    -F "$FRAMEWORK" -framework WebRTC -Xlinker -rpath -Xlinker "$FRAMEWORK" \
    "$FACTORY" "$IOS_DIR/ReceiveOnlyAudioDevice.swift" "$IOS_DIR/LocalWhipIngestSource.swift" \
    "$IOS_DIR/DecodedGlassesMediaSource.swift" "$IOS_DIR/DecodedPcm.swift" \
    "$IOS_DIR"/CoreKit/Sources/GlassesMediaCore/*.swift "$TEST_DIR/Probe.swift" -o "$WORK_DIR/probe"
  echo "Running $MODE with WebRTC $SDK_VERSION"
  SIMCTL_CHILD_DYLD_INSERT_LIBRARIES="$WORK_DIR/InternetPathShim.dylib" \
    SIMCTL_CHILD_WHIP_TEST_INTERFACE="$INTERFACE" SIMCTL_CHILD_WHIP_TEST_ADDRESS="$ADDRESS" \
    SIMCTL_CHILD_WHIP_TEST_EXPECT_FAILURE="$EXPECT_FAILURE" \
    xcrun simctl spawn "$SIM_ID" "$WORK_DIR/probe"
done
