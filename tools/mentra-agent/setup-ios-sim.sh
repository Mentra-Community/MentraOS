#!/usr/bin/env bash
# Prepare an iOS Simulator for unattended harness runs — the simctl sibling of
# setup-emulator.sh.
#
# The iOS Simulator shares the Mac's network, so unlike the Android emulator it
# needs NO port tunnels: the bundled agentBridge reaches the harness server at
# localhost:8787 directly, and RemoteHarness.swift reaches the glasses daemon at
# 127.0.0.1:8802 directly. This script just boots a sim, pre-grants the
# privacy permissions whose SYSTEM dialogs the app's React tree can't see
# (mic/camera/location), and optionally launches the app.
#
#   tools/mentra-agent/setup-ios-sim.sh ["iPhone 16"] [launch]
#
# Pass "launch" as the 2nd arg to also boot the app (it must already be
# installed — build/install once with `bun ios` or the xcodebuild + simctl
# install flow). Bundle id: com.mentra.mentra.
set -euo pipefail

DEVICE="${1:-iPhone 16}"
DO_LAUNCH="${2:-}"
BUNDLE="com.mentra.mentra"

echo "preparing iOS Simulator \"$DEVICE\" for harness runs..."

# Boot (no-op if already booted).
xcrun simctl boot "$DEVICE" 2>/dev/null || true
xcrun simctl bootstatus "$DEVICE" -b >/dev/null 2>&1 || true
open -a Simulator 2>/dev/null || true

# Pre-grant privacy permissions so first mic/camera/location use shows no
# blocking system dialog. `simctl privacy grant` is idempotent; tolerate
# unknown-service errors across iOS versions.
for svc in microphone camera location location-always photos contacts; do
  xcrun simctl privacy "$DEVICE" grant "$svc" "$BUNDLE" 2>/dev/null \
    && echo "  granted $svc" || true
done

if [ "$DO_LAUNCH" = "launch" ]; then
  echo "launching $BUNDLE..."
  xcrun simctl terminate "$DEVICE" "$BUNDLE" 2>/dev/null || true
  xcrun simctl launch "$DEVICE" "$BUNDLE" 2>/dev/null \
    && echo "  launched" \
    || echo "  launch failed — is the app installed? (bun ios, or xcodebuild + simctl install)"
fi

echo
echo "iOS sim ready. No tunnels needed (sim shares the Mac network):"
echo "  - agentBridge -> harness server at localhost:8787 (localhost is its first candidate)"
echo "  - RemoteHarness.swift -> glasses daemon at 127.0.0.1:8802"
echo "Pair the harness glasses from the app's dev menu (Remote Glasses (Harness))"
echo "or via the agent bridge: bun cli.ts rpc connectRemoteGlasses '{}'"
