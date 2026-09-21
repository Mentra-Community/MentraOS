# ASG Client documentation

Android application that runs on Mentra Live smart glasses, bridging hardware and the MentraOS ecosystem.

## Getting started

- [Mentra Live product and platform spec](https://github.com/Mentra-Community/Mentra-Specs/blob/main/hardware/live/product/spec.md) — private reference for Mentra Live behavior when working in `asg_client`
- [Overview](overview.md) — architecture, K900/Mentra Live naming, key components
- [Top-level README](../README.md) — environment setup, ADB (USB + WiFi), building and installing your fork

## API reference

- [ASG Client Command API](ASG_CLIENT_API.md) — full BLE + intent JSON command surface (the source-of-truth wire reference)

## Features

- [Button press system](features/button-press-system.md) — camera button, gallery-mode gate, video/photo dispatch
- [Live streaming (RTMP / SRT / WHIP)](features/rtmp-streaming.md) — protocols, lifecycle, keep-alive, reconnect
- [Camera web server](features/camera-web-server.md) — embedded HTTP server for gallery sync, downloads, deletion
- [LED control](features/led-control.md) — local MTK recording LED, RGB status LED, and charging-case indicator
- [Command processor](features/command-processor.md) — handler registry, protocol detection, ACK/dedup
- [File manager integration](features/file-manager-integration.md) — package-namespaced media storage
- [BES MCU firmware OTA](features/bes-ota.md) — pushing new BES firmware over UART
- [Maintaining customized Mentra Live devices](features/dev-firmware-update.md) — initial setup,
  safe firmware updates, USB reconnect guidance, and recovery

## Testing and characterization

- [Mentra Live WHIP battery and thermal characterization](https://github.com/Mentra-Community/Mentra-Specs/blob/main/hardware/live/streaming/whip-characterization/research.md) — runtime, stability, bitrate, and peak internal-temperature matrix
- [Recording FPS vs. thermals](https://github.com/Mentra-Community/Mentra-Specs/blob/main/hardware/live/recording-thermals/README.md) — controlled local-recording thermal sweep

## Compatibility

- **Mentra Live** is the only officially supported device. The codebase uses `K900` as the internal codename for Mentra Live's hardware platform — see [overview.md → K900 = Mentra Live](overview.md#a-naming-note-k900--mentra-live).

## Internal planning

Specs, design work, investigations, and test evidence live in [Mentra-Specs](https://github.com/Mentra-Community/Mentra-Specs/blob/main/INDEX.md#hardware) (private). Read its [shared workflow](https://github.com/Mentra-Community/Mentra-Specs/blob/main/AGENTS.md) before planning or implementing spec-driven work. Keep public API and contributor references here.

The reproducible recording sweep remains available at [`scripts/recording-thermal-sweep.sh`](../scripts/recording-thermal-sweep.sh).
