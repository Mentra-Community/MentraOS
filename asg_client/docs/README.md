# ASG Client documentation

Android application that runs on Mentra Live smart glasses, bridging hardware and the MentraOS ecosystem.

## Getting started

- [Overview](overview.md) — architecture, K900/Mentra Live naming, key components
- [Top-level README](../README.md) — environment setup, ADB (USB + WiFi), building and installing your fork

## API reference

- [ASG Client Command API](ASG_CLIENT_API.md) — full BLE + intent JSON command surface (the source-of-truth wire reference)

## Features

- [Button press system](features/button-press-system.md) — camera button, gallery-mode gate, video/photo dispatch
- [Live streaming (RTMP / SRT / WHIP)](features/rtmp-streaming.md) — protocols, lifecycle, keep-alive, reconnect
- [Camera web server](features/camera-web-server.md) — embedded HTTP server for gallery sync, downloads, deletion
- [LED control](features/led-control.md) — local MTK recording LED + RGB ring (BES authority handoff)
- [Command processor](features/command-processor.md) — handler registry, protocol detection, ACK/dedup
- [File manager integration](features/file-manager-integration.md) — package-namespaced media storage
- [BES MCU firmware OTA](features/bes-ota.md) — pushing new BES firmware over UART

## Compatibility

- **Mentra Live** is the only officially supported device. The codebase uses `K900` as the internal codename for Mentra Live's hardware platform — see [overview.md → K900 = Mentra Live](overview.md#a-naming-note-k900--mentra-live).

## Internal scratchpad

The [`agents/`](agents/) folder is an LLM planning scratchpad. **It is not part of the public docs** — see [`agents/README.md`](agents/README.md) for the policy.
