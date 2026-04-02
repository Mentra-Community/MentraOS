# ASG Client Documentation

Android application that runs on Mentra Live smart glasses, bridging hardware and the MentraOS ecosystem.

## Getting Started

- [Overview](overview.md) — Architecture and core concepts
- [Mentra Live Setup](mentra-live-setup.md) — ADB connection, building, installing, log filtering

## API Reference

- [ASG Client Command API](ASG_CLIENT_API.md) — Full command reference (BLE + intent debug interface)

## Features

- [Button Press System](features/button-press-system.md) — Physical button handling and modes
- [RTMP Streaming](features/rtmp-streaming.md) — Live video streaming
- [Gallery Mode](features/gallery-mode-button-capture.md) — Button-triggered photo/video capture
- [File Manager](features/file-manager-integration.md) — File operations and media management
- [Command Processor](features/command-processor-refactoring.md) — Command routing architecture

## Hardware & Firmware

- [BES OTA Updates](agents/BES_OTA_README.md) — BES2700 firmware OTA system
- [Camera Web Server](agents/CAMERA_WEBSERVER_README.md) — HTTP server for remote photo access
- [Custom GATT Audio](agents/CUSTOM_GATT_AUDIO.md) — LC3 audio streaming implementation
- [K900 LED Control](agents/K900_LED_CONTROL.md) — Native recording LED control
- [RGB LED Control](agents/RGB_LED_CONTROL_IMPLEMENTATION.md) — RGB LED command interface
- [Delete Files Endpoint](agents/DELETE_FILES_ENDPOINT.md) — File deletion API

## Compatibility

- **Mentra Live** (primary supported device)
