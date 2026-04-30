# ASG Client Overview

## What is ASG Client?

ASG Client is the Android application that runs on Android-based smart glasses (primarily **Mentra Live**). It bridges the physical glasses hardware and the MentraOS ecosystem — handling button presses, the camera and microphone, BLE communication with the phone app, WiFi/hotspot, OTA updates, and media uploads.

## A naming note: K900 = Mentra Live

Throughout the codebase you will see `K900` everywhere — class names (`K900BluetoothManager`, `K900HardwareManager`, `K900LedController`), package paths, command identifiers (`cs_pho`, `hm_batv`), and config keys.

**K900 is the internal codename for Mentra Live**, used during development. There is no separate "K900" device — the codename was kept in the code to avoid a sweeping rename. When you see `K900` in code or in the rest of these docs, read it as "the Mentra Live hardware platform."

The two chips on Mentra Live: **MTK** is the Mediatek SoC running Android (and ASG Client itself). **BES** is the dedicated Bluetooth/audio microcontroller it talks to over UART. You'll see both names in feature docs, especially around LED control where the two chips share a single LED ring.

## Architecture

`AsgClientService` is the main foreground Android service. It owns lifecycle and routes messages between four subsystems:

1. **Bluetooth communication** — receives JSON commands from the phone over BLE, sends status updates and media back. The wire-level command surface is documented in [ASG Client Command API](ASG_CLIENT_API.md).
2. **Hardware integration** — talks to the BES microcontroller over UART for button presses, touch/swipe events, battery voltage, BES OTA, and the LED ring. See [features/button-press-system.md](features/button-press-system.md) and [features/led-control.md](features/led-control.md).
3. **Media** — photo capture, video recording, RTMP/SRT/WHIP streaming, and the local HTTP server for sync. See [features/rtmp-streaming.md](features/rtmp-streaming.md) and [features/camera-web-server.md](features/camera-web-server.md).
4. **Network** — WiFi connect/scan/forget, hotspot, and the heuristics that decide which network manager to use on a given platform.

The handler pattern (see [features/command-processor.md](features/command-processor.md)) keeps each command isolated to its own `*CommandHandler` class, dispatched via `CommandHandlerRegistry`.

## Communication flow

```
Physical hardware → BES MCU (UART) → AsgClientService → BLE → Phone app → MentraOS Cloud
                                          ↓
                                   Local actions
                              (photo, video, stream, LED)
```

### Example: camera button press

1. User presses the camera button on the glasses.
2. BES MCU sends `cs_pho` (short press) or `cs_vdo` (long press) over UART.
3. `K900CommandHandler.processK900Command` routes by button mode:
   - **PHOTO mode** — `MediaCaptureService.takePhoto()` runs locally; the result is queued for sync.
   - **APPS mode** — a `button_press` event is forwarded to the phone, which routes it to subscribed apps.
4. If photo capture happened, it lands in the gallery and is exposed via the [camera web server](features/camera-web-server.md) for the phone to download.
5. The phone uploads the photo to MentraOS Cloud over its own connection.

## Key components

### Bluetooth managers (`io/bluetooth/managers/`)

- `K900BluetoothManager` — primary; used on Mentra Live
- `StandardBluetoothManager` — generic Android BLE fallback
- `NordicBluetoothManager` — Nordic-chipset path

### Hardware managers (`io/hardware/managers/`)

- `K900HardwareManager` — Mentra Live (LED ring, battery, audio assets)
- `StandardHardwareManager` — generic Android fallback

Selected at runtime by `HardwareManagerFactory`.

### Network managers (`io/network/managers/`)

- `K900NetworkManager` — Mentra Live (uses platform-specific WiFi/hotspot APIs)
- `SystemNetworkManager` — newer Android `WifiNetworkSpecifier` path
- `FallbackNetworkManager` — last-resort generic path

### Media (`io/media/`, `io/streaming/`, `camera/`)

- `MediaCaptureService` — photo + video orchestration; handles BLE photo transfer and direct webhook upload
- `RtmpStreamingService` / `SrtStreamingService` / `WhipStreamingService` — protocol-specific streamers
- `CameraNeo` — low-level camera2 wrapper

### Server (`io/server/`)

- `AsgCameraServer` — embedded HTTP server for the phone to enumerate and download captured media (gallery sync, delete, ZIP). Configured via `ServerConfig`, `NetworkProvider`, `CacheManager`, `RateLimiter`, `Logger`, `FileManager`.

### File manager (`io/file/`)

- `FileManager` interface plus `PackageOperations` — namespaces media by requesting app's package name. Both the gallery commands and the camera web server use this.

### OTA (`io/ota/`, `io/bes/`)

- `OtaUpdaterManager` — APK self-update for the ASG client
- `BesOtaManager` — pushes new BES MCU firmware over UART. See [features/bes-ota.md](features/bes-ota.md).

## Configuration

Persisted via `AsgSettings` (SharedPreferences). User-tunable through the phone app:

- Button press behavior (PHOTO, APPS, gallery mode)
- Button-triggered video/photo resolution and FPS
- Maximum recording duration
- Privacy LED behavior
- Camera FOV / ROI (Mentra Live only — applied via `DevApi.setCameraFov`)

## Integration points

1. **Phone app ↔ ASG Client** — BLE GATT, custom characteristics implemented by `K900BluetoothManager`. Wire format documented in [ASG Client Command API](ASG_CLIENT_API.md).
2. **MCU ↔ ASG Client** — UART; framed as `{"C": "<cmd>", "B": {...}, "V": 1}`. Inbound K900 commands are routed by `K900CommandHandler`.
3. **MentraOS Cloud** — indirect; phone app proxies media and events.
