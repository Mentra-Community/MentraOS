#!/usr/bin/env bash
set -euo pipefail
mobile_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
udp_ios="${UDP_IOS_SOURCE_DIR:-$mobile_dir/node_modules/react-native-udp/ios}"
gcd_dir="$mobile_dir/ios/Pods/CocoaAsyncSocket/Source/GCD"
build_dir="$(mktemp -d)"
trap 'rm -rf "$build_dir"' EXIT
# Only the React callback typedef is stubbed. Compile the installed UDP client
# and real CocoaAsyncSocket; exercise delivery over real loopback UDP sockets.
mkdir -p "$build_dir/React"
printf '#import <Foundation/Foundation.h>\ntypedef void (^RCTResponseSenderBlock)(NSArray *response);\n' > "$build_dir/React/RCTBridgeModule.h"
xcrun clang -fobjc-arc -Dgetaddrinfo=mentra_test_getaddrinfo -I "$gcd_dir" \
  -c "$gcd_dir/GCDAsyncUdpSocket.m" -o "$build_dir/gcd.o"
xcrun clang -fobjc-arc -Wno-incompatible-pointer-types -I "$build_dir" -I "$gcd_dir" \
  -c "$udp_ios/UdpSocketClient.m" -o "$build_dir/client.o"
xcrun clang++ -std=c++17 -fobjc-arc -framework Foundation \
  -I "$build_dir" -I "$gcd_dir" -I "$udp_ios" \
  "$mobile_dir/test/native/AudioUdpTests.mm" "$build_dir/gcd.o" "$build_dir/client.o" \
  -o "$build_dir/audio-udp-test"
"$build_dir/audio-udp-test"
