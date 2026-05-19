# ASG Client Command API

`asg_client` exposes a JSON command API that controls hardware and system features on Mentra Live smart glasses. Every command is a JSON object with a `"type"` field that selects a handler.

This API is reached over two transports:

1. **BLE (primary)** — the Mentra phone app sends commands over BLE.
2. **Intent broadcast (debug/testing)** — the same commands can be sent via Android broadcast intents from a debug APK or `adb shell am broadcast`.

Both paths funnel into `CommandProcessor.processJsonCommand(JSONObject)`, so all command behavior is identical regardless of transport. See [Debug interface](#debug-interface-intent-broadcast) for the intent path.

> This document is the source-of-truth wire reference. Behavioral notes (lifecycle, reconnect, timeouts) live in the corresponding [feature docs](features/).

## Architecture

```
ADB / Debug APK (intent)              Phone app (BLE)
       │                                    │
       ▼                                    ▼
IntentCommandReceiver           K900BluetoothManager
       │                                    │
       └──────────────────┬─────────────────┘
                          ▼
        CommandProcessor.processJsonCommand(JSONObject)
                          │
                          ▼
            CommandHandlerRegistry → ICommandHandler
                          │
                          ▼
      Outbound responses → BLE send + intent broadcast
```

## Common fields

Every command may include:

| Field  | Type   | Required | Description                                                         |
| ------ | ------ | -------- | ------------------------------------------------------------------- |
| `type` | string | yes      | Command identifier (rows below)                                     |
| `mId`  | long   | no       | Message ID. If present, glasses immediately reply with a `msg_ack`. |

### `msg_ack` (auto-response when `mId` is set)

```json
{"type": "msg_ack", "mId": 1234567890, "timestamp": 1708963201234}
```

---

## Command reference

Sources:

- Handler registrations: `app/src/main/java/com/mentra/asg_client/service/core/handlers/*CommandHandler.java`
- Response wire formats: `service/communication/managers/ResponseBuilder.java`, `service/media/managers/MediaManager.java`, `io/media/core/MediaCaptureService.java`

### Photo

#### `take_photo`

Capture a still photo. The handler routes through `transferMethod` to one of three pipelines: direct upload to a webhook, BLE transfer to the phone, or auto (direct with BLE fallback).

```json
{
  "type": "take_photo",
  "requestId": "photo_001",
  "packageName": "com.example.app",
  "webhookUrl": "https://api.example.com/upload",
  "authToken": "Bearer abc123",
  "transferMethod": "auto",
  "bleImgId": "img_001",
  "save": false,
  "size": "medium",
  "compress": "none",
  "flash": true,
  "sound": true
}
```

| Field            | Type    | Default             | Description                                                 |
| ---------------- | ------- | ------------------- | ----------------------------------------------------------- |
| `requestId`      | string  | —                   | Required; correlates request with response                  |
| `packageName`    | string  | resolved by handler | Originating app package                                     |
| `webhookUrl`     | string  | ""                  | HTTPS endpoint for `direct` / `auto` upload                 |
| `authToken`      | string  | ""                  | Bearer token for the webhook                                |
| `transferMethod` | string  | `"direct"`          | One of `direct`, `ble`, `auto`. `auto` requires `bleImgId`. |
| `bleImgId`       | string  | ""                  | Required for `ble` and `auto` transfer methods              |
| `save`           | boolean | `false`             | Also save the photo to local gallery                        |
| `size`           | string  | `"medium"`          | `small`, `medium`, or `large`                               |
| `compress`       | string  | `"none"`            | Compression preset passed to capture pipeline               |
| `flash`          | boolean | `true`              | Fire the privacy LED during capture                         |
| `sound`          | boolean | `true`              | Play shutter sound                                          |

**Constraints (all enforced in `PhotoCommandHandler`):**

- Battery ≥ `BatteryConstants.MIN_BATTERY_LEVEL` (currently 10%)
- No video recording in progress
- No BLE transfer in progress
- No other photo capture in progress

**Responses:** the handler can produce three different response types depending on the path taken.

`photo_response` — direct/auto upload finished:

```json
{
  "type": "photo_response",
  "requestId": "photo_001",
  "success": true,
  "mediaUrl": "/storage/.../IMG_001.jpg"
}
```

`ble_photo_ready` — BLE transfer started successfully:

```json
{"type": "ble_photo_ready", "bleImgId": "img_001", "requestId": "photo_001"}
```

`ble_photo_error` / `photo_error_response` — capture or transfer failed:

```json
{
  "type": "photo_error_response",
  "requestId": "photo_001",
  "error_code": "BATTERY_LOW",
  "error_message": "Battery level too low (8%) - minimum 10% required"
}
```

Error codes the handler can emit: `BATTERY_LOW`, `VIDEO_RECORDING_ACTIVE`, `BLE_TRANSFER_BUSY`, `CAMERA_BUSY`, `INSUFFICIENT_STORAGE`, `UPLOAD_SYSTEM_BUSY`, `CAPTURE_TIMEOUT`, `CAMERA_CAPTURE_FAILED`, `BLE_TRANSFER_BUSY`, `BLE_TRANSFER_FAILED`, `BLE_TRANSFER_FAILED_TO_START`.

---

### Video recording

Wire response type for all video commands: `video_recording_status`.

#### `start_video_recording`

```json
{
  "type": "start_video_recording",
  "requestId": "video_001",
  "settings": {"width": 1280, "height": 720, "fps": 30},
  "save": false,
  "flash": true,
  "sound": true
}
```

| Field             | Type    | Default        | Description                  |
| ----------------- | ------- | -------------- | ---------------------------- |
| `requestId`       | string  | `"video_<ts>"` | Used for stop validation     |
| `settings.width`  | int     | sensor default | Optional capture width       |
| `settings.height` | int     | sensor default | Optional capture height      |
| `settings.fps`    | int     | 30             | Frames per second            |
| `save`            | boolean | `false`        | Save to local gallery        |
| `flash`           | boolean | `true`         | Privacy LED during recording |
| `sound`           | boolean | `true`         | Start/stop tones             |

Same battery constraint as photo. Status values emitted: `recording_started`, `already_recording`, `battery_low`, `service_unavailable`, `missing_request_id`, `error`.

```json
{"type": "video_recording_status", "success": true, "status": "recording_started", "timestamp": 1708963201234}
```

#### `stop_video_recording`

```json
{"type": "stop_video_recording", "requestId": "video_001"}
```

If `requestId` is provided, the capture service validates it matches the active recording. Status values: `recording_stopped`, `not_recording`, `service_unavailable`, `error`.

#### `get_video_recording_status`

```json
{"type": "get_video_recording_status"}
```

Response while recording:

```json
{
  "type": "video_recording_status",
  "success": true,
  "data": {"recording": true, "duration_ms": 15000, "duration_formatted": "00:15"}
}
```

---

### Streaming (RTMP / SRT / WHIP)

The handler is `StreamCommandHandler` (file: `service/core/handlers/StreamCommandHandler.java`). The same four commands handle all three protocols — the protocol is detected from the URL prefix (`rtmp://` / `rtmps://`, `srt://`, `http(s)://` for WHIP).

See [features/rtmp-streaming.md](features/rtmp-streaming.md) for stream lifecycle, reconnect behavior, and the keep-alive/timeout contract.

#### `start_stream`

```json
{
  "type": "start_stream",
  "streamUrl": "rtmp://streaming.example.com/live/stream",
  "streamId": "stream_123",
  "video": {"width": 1280, "height": 720, "fps": 30, "bitrate": 2500},
  "audio": {"sample_rate": 48000, "bitrate": 128},
  "flash": true,
  "sound": true
}
```

| Field       | Type    | Default  | Description                                                                                                                   |
| ----------- | ------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `streamUrl` | string  | —        | Required. Legacy fallbacks: `rtmpUrl`, `srtUrl`, `whipUrl` (any one is accepted).                                             |
| `streamId`  | string  | ""       | Used to validate keep-alives and ACKs                                                                                         |
| `video`     | object  | defaults | `width`, `height`, `fps`, `bitrate`. Compact alias: `v`. Parsed by `RtmpStreamConfig.fromJson` / `WhipStreamConfig.fromJson`. |
| `audio`     | object  | defaults | `sample_rate`, `bitrate`. Compact alias: `a`.                                                                                 |
| `flash`     | boolean | `true`   | Privacy LED during stream                                                                                                     |
| `sound`     | boolean | `true`   | Start/stop tones                                                                                                              |

**Constraints:** battery ≥ 10%, WiFi connected. WHIP streams whose requested resolution exceeds the camera's supported output are rejected (`WhipCameraFormatSelector`).

**Response wire type:** `stream_status` (new universal type from `MediaManager.sendStreamStatusResponse`). Legacy `rtmp_stream_status` is still produced by `ResponseBuilder` in some paths.

```json
{"type": "stream_status", "kind": "lifecycle", "status": "streaming", "timestamp": 1708963201234}
```

#### `stop_stream`

```json
{"type": "stop_stream"}
```

Stops whichever stream service is active. Status: `stopping`; if no stream is active, `status` is `error` with `errorDetails: "not_streaming"`.

#### `get_stream_status`

```json
{"type": "get_stream_status"}
```

Response includes a `streaming` boolean and a `reconnecting` flag. When reconnecting, RTMP/SRT include an `attempt` counter:

```json
{"type": "stream_status", "kind": "snapshot", "status": "streaming", "streaming": true, "reconnecting": false, "timestamp": 1708963201234}
```

#### `keep_stream_alive`

Heartbeat to extend the stream timeout. Both `streamId` and `ackId` are required; missing either is silently ignored.

```json
{"type": "keep_stream_alive", "streamId": "stream_123", "ackId": "ack_456"}
```

ACK response:

```json
{"type": "keep_alive_ack", "streamId": "stream_123", "ackId": "ack_456", "timestamp": 1708963201234}
```

---

### WiFi & hotspot

#### `set_wifi_credentials`

```json
{"type": "set_wifi_credentials", "ssid": "MyNetwork", "password": "password123"}
```

Initiates connection. After ~3s the handler polls connection status up to 4 times and sends a `wifi_status` event when settled.

#### `request_wifi_status`

```json
{"type": "request_wifi_status"}
```

Response:

```json
{"type": "wifi_status", "connected": true}
```

#### `request_wifi_scan`

```json
{"type": "request_wifi_scan"}
```

Streams results back over BLE as they're discovered:

```json
{
  "type": "wifi_scan_result",
  "networks_neo": [{"ssid": "MyNetwork", "signal_strength": -45, "security": "WPA2"}]
}
```

#### `set_hotspot_state`

```json
{"type": "set_hotspot_state", "enabled": true}
```

Response:

```json
{
  "type": "hotspot_status_update",
  "hotspot_enabled": true,
  "hotspot_ssid": "MentraLive_XXXX",
  "hotspot_password": "xxxxxxxx",
  "hotspot_gateway_ip": "192.168.43.1"
}
```

#### `set_system_time`

Sets the glasses system clock from the phone. Sent only when the phone detects clock skew during gallery sync or OTA version checks (not on every BLE connect).

```json
{"type": "set_system_time", "timestamp_ms": 1710000000000}
```

No response is required for V1 (fire-and-forget).

#### `disconnect_wifi`

```json
{"type": "disconnect_wifi"}
```

#### `forget_wifi`

```json
{"type": "forget_wifi", "ssid": "OldNetwork"}
```

`ssid` is required; empty SSID returns `false` without action.

---

### Battery

#### `request_battery_state`

```json
{"type": "request_battery_state"}
```

#### `battery_status`

Update battery state on the glasses (used by the phone to push estimated state, e.g. while charging is detected externally):

```json
{"type": "battery_status", "level": 85, "charging": false, "timestamp": 1708963201234}
```

The glasses also emit `battery_status` outbound:

```json
{"type": "battery_status", "percent": 85, "charging": false}
```

---

### Version / system info

#### `request_version` / `cs_syvr`

```json
{"type": "request_version"}
```

Returns version information chunked across three messages — `version_info_1`, `version_info_2`, `version_info_3` — to fit BLE MTU. Each chunk carries APK build, OS version, MCU/BES firmware version, and serial.

---

### IMU / sensors

Handler: `ImuCommandHandler`. Power-optimized; streaming auto-times out.

#### `imu_single`

```json
{"type": "imu_single"}
```

Response (sample):

```json
{
  "type": "imu_response",
  "timestamp": 1708963201234,
  "accelerometer": {"x": 0.1, "y": 0.2, "z": 9.8},
  "gyroscope": {"x": 0.01, "y": 0.02, "z": 0.03}
}
```

#### `imu_stream_start`

```json
{"type": "imu_stream_start", "rate_hz": 50, "batch_ms": 100}
```

| Field      | Type | Default | Range            |
| ---------- | ---- | ------- | ---------------- |
| `rate_hz`  | int  | 50      | 1-100 (clamped)  |
| `batch_ms` | long | 0       | 0-1000 (clamped) |

#### `imu_stream_stop`

```json
{"type": "imu_stream_stop"}
```

#### `imu_subscribe_gesture` _(under construction)_

> **Under construction.** The handler accepts these commands but the gesture detection itself is not finished — don't rely on this in production code yet.

```json
{"type": "imu_subscribe_gesture", "gestures": ["head_up", "head_down", "nod_yes", "shake_no"]}
```

Acknowledgement:

```json
{"type": "imu_gesture_subscribed", "gestures": ["head_up", "head_down"]}
```

When a subscribed gesture fires:

```json
{"type": "imu_gesture_response", "gesture": "head_up", "timestamp": 1708963201234}
```

#### `imu_unsubscribe_gesture` _(under construction)_

```json
{"type": "imu_unsubscribe_gesture"}
```

---

### I2S audio

Mentra Live routes Android-side audio through the MCU via I2S. The path must be opened before audio can play, and audio must use `AudioManager.STREAM_NOTIFICATION`.

#### `enable_i2s` / `enable_android_audio`

```json
{"type": "enable_i2s"}
```

Both names are aliases; either works. No response.

#### `disable_i2s` / `disable_android_audio`

```json
{"type": "disable_i2s"}
```

No response.

---

### RGB LED control

Controls the RGB LEDs on the glasses themselves (not the local MTK recording LED). See [features/led-control.md](features/led-control.md) for the layered architecture.

#### `rgb_led_control_on`

```json
{
  "type": "rgb_led_control_on",
  "led": 4,
  "ontime": 500,
  "offtime": 500,
  "count": 3,
  "brightness": 200
}
```

| Field        | Type | Default                                           | Range                                     |
| ------------ | ---- | ------------------------------------------------- | ----------------------------------------- |
| `led`        | int  | 0 (red)                                           | 0=red, 1=green, 2=blue, 3=orange, 4=white |
| `ontime`     | int  | 1000                                              | ≥ 0 ms                                    |
| `offtime`    | int  | 1000                                              | ≥ 0 ms                                    |
| `count`      | int  | 1                                                 | ≥ 0 cycles                                |
| `brightness` | int  | `K900RgbLedController.DEFAULT_RGB_LED_BRIGHTNESS` | 0-255                                     |

#### `rgb_led_control_off`

```json
{"type": "rgb_led_control_off"}
```

#### `rgb_led_photo_flash`

```json
{"type": "rgb_led_photo_flash", "duration": 5000, "brightness": 200}
```

White flash for photo capture. `duration` defaults to 5000 ms.

#### `rgb_led_video_solid`

```json
{"type": "rgb_led_video_solid", "brightness": 200}
```

Solid white for video recording. Internal duration is 30 minutes — the recorder turns the LED off explicitly when recording stops.

All four commands respond with either `<command>_response` (success: `true`) or `rgb_led_control_error` if the device doesn't support RGB LEDs or validation fails.

---

### Gallery

#### `query_gallery_status`

```json
{"type": "query_gallery_status"}
```

Returns counts via `FileManager`. If the camera is busy (recording or streaming), the response reports zeros so the phone won't try to sync incomplete files.

```json
{
  "type": "gallery_status",
  "photos": 25,
  "videos": 5,
  "total": 30,
  "total_size": 2147483648,
  "has_content": true
}
```

When the camera is busy, an additional context field appears (`camera_busy`: `"video"` or `"stream"`).

---

### Settings

#### `set_photo_mode`

```json
{"type": "set_photo_mode", "mode": "save_locally"}
```

Response:

```json
{"type": "set_photo_mode_ack", "mode": "save_locally"}
```

#### `button_video_recording_setting`

```json
{"type": "button_video_recording_setting", "params": {"width": 1920, "height": 1080, "fps": 30}}
```

Persists the resolution/fps used when the hardware camera button starts a video.

#### `button_max_recording_time`

```json
{"type": "button_max_recording_time", "minutes": 10}
```

#### `button_photo_setting`

```json
{"type": "button_photo_setting", "size": "large"}
```

`size` is one of `small`, `medium`, `large`.

Enables/disables the privacy LED during button-triggered capture.

#### `button_mode_setting`

```json
{"type": "button_mode_setting", "mode": "normal"}
```

Deprecated/reserved. Current ASG Client does not use this command to switch between photo and video behavior. Use `save_in_gallery_mode` to control whether hardware-button presses also capture locally, and use the photo/video setting commands above to configure short-press photo and long-press video captures.

#### `camera_fov_setting` (Mentra Live / K900-class hardware)

```json
{"type": "camera_fov_setting", "params": {"fov": 118, "roi_position": 0}}
```

Persists the FOV/ROI, applies them to the camera HAL via `DevApi.setCameraFov`, and restarts the HAL. A short cooldown (`CameraRestartCooldown`) blocks immediately-following capture commands. Falls back to persist-only on non-K900 hardware (no `libxydev`).

---

### BLE configuration

#### `set_ble_mtu`

```json
{"type": "set_ble_mtu", "mtu": 244}
```

Adjusts the file packet size to fit the MTU just negotiated by the phone. Effective payload is `mtu - 3` bytes, minus 32 bytes of K900 protocol overhead.

---

### Power

#### `shutdown`

```json
{"type": "shutdown"}
```

Stops any active video recording (to finalize the moov atom) before calling `SysControl.shut()`.

#### `reboot`

```json
{"type": "reboot"}
```

Same active-recording cleanup, then `SysControl.reboot()`.

---

### Session lifecycle (sent by the phone app)

#### `phone_ready`

```json
{"type": "phone_ready"}
```

The phone announces it has connected. Glasses respond with `glasses_ready`, then 500 ms later auto-send WiFi status and hotspot status, and claim RGB LED control authority from the BES chip.

```json
{"type": "glasses_ready", "timestamp": 1708963201234}
```

#### `auth_token`

```json
{"type": "auth_token", "coreToken": "eyJhbGciOiJIUzI1NiJ9..."}
```

Response:

```json
{"type": "token_status", "success": true}
```

Empty token returns `token_status` with `success: false`.

#### `user_email`

Sets user identity for Sentry reporting context. No response.

```json
{"type": "user_email", "email": "user@example.com"}
```

#### `service_heartbeat`

```json
{"type": "service_heartbeat", "timestamp": 1708963201234, "heartbeat_counter": 42}
```

Resets the service heartbeat timeout. No response.

#### `ping`

```json
{"type": "ping"}
```

Also resets the heartbeat timeout. Response:

```json
{"type": "pong"}
```

#### `keep_awake`

No-op keep-alive (used during OTA install windows). No response.

```json
{"type": "keep_awake"}
```

#### `transfer_complete`

Phone confirms a media file BLE transfer finished.

```json
{"type": "transfer_complete", "fileName": "photo_001.jpg", "success": true}
```

`fileName` is required. No response.

#### `save_in_gallery_mode`

Toggles whether hardware-button presses save photos/videos locally (gallery mode). See [features/button-press-system.md](features/button-press-system.md).

```json
{"type": "save_in_gallery_mode", "active": true}
```

Persisted via `AsgSettings.setSaveInGalleryMode`.

#### `upload_incident_logs`

```json
{"type": "upload_incident_logs", "incidentId": "550e8400-e29b-41d4-a716-446655440000", "apiBaseUrl": ""}
```

| Field        | Type   | Required | Description              |
| ------------ | ------ | -------- | ------------------------ |
| `incidentId` | string | yes      | Backend incident id      |
| `apiBaseUrl` | string | no       | Override server base URL |

With WiFi: POSTs the last 600 logcat lines plus BES firmware logs to `<base>/api/incidents/<incidentId>/logs`. Without WiFi: relays the same payloads to the phone over two sequential K900 BLE file transfers; the phone POSTs them.

#### `ota_start`

User accepted an OTA update.

```json
{"type": "ota_start"}
```

If `OtaHelper` isn't initialized yet (can happen right after APK install), the handler retries up to 4 times with 2 s backoff. After exhausting retries it sends:

```json
{
  "type": "ota_progress",
  "stage": "download",
  "status": "FAILED",
  "progress": 0,
  "bytes_downloaded": 0,
  "total_bytes": 0,
  "current_update": "apk",
  "error_message": "OTA service failed to initialize. Please restart glasses and try again."
}
```

#### `ota_update_response` (deprecated)

Legacy accept/reject prompt, kept for older phone app versions. If `accepted` is `true`, delegates to `ota_start`.

```json
{"type": "ota_update_response", "accepted": true}
```

---

### K900 protocol passthroughs

The K900 microcontroller frames messages as `{"C": "<cmd>", "B": {...}, "V": 1}`. These are parsed by `K900CommandHandler` (not registered in `CommandHandlerRegistry` like the others — they're dispatched from the K900 protocol detector). Most are inbound-only and don't accept payloads from the phone, but a few translate to outbound JSON events:

| Inbound `C`           | Meaning                                              | Outbound (if any)                         |
| --------------------- | ---------------------------------------------------- | ----------------------------------------- |
| `cs_pho`              | Camera button short press                            | `button_press`                            |
| `cs_vdo`              | Camera button long press                             | `button_press`                            |
| `hm_htsp` / `mh_htsp` | Hotspot start request                                | (handled internally)                      |
| `hm_batv`             | Battery voltage update                               | `battery_status`                          |
| `cs_flts`             | File-transfer ACK                                    | (handled internally)                      |
| `sr_swst`             | Switch status report                                 | `switch_status`                           |
| `sr_tpevt`            | Touch event report                                   | `touch_event`                             |
| `sr_fbvol`            | Swipe volume status                                  | `swipe_volume_status`                     |
| `hm_ota`              | BES OTA authorization response                       | (handled internally)                      |
| `hs_ntfy`             | Hardware notification (newer firmware button format) | `button_press`                            |
| `sr_vad`              | Voice Activity Detection event                       | (logged only)                             |
| `hs_syvr`             | System version report                                | (cached, triggers `request_version` push) |
| `sr_btaddr`           | BT MAC address                                       | (persisted to system properties)          |
| `sr_keyevt`           | Power button short press                             | (announces battery via audio asset)       |
| `sr_log`              | BES log stream packet                                | (forwarded to upload pipeline)            |
| `cs_shut`             | BES requesting graceful shutdown                     | `sr_shut` ack, then shutdown              |

---

## Debug interface (intent broadcast)

For ADB-based testing and debug APKs.

### Intent actions

| Action                                             | Direction | Extras                                                   |
| -------------------------------------------------- | --------- | -------------------------------------------------------- |
| `com.mentra.asg_client.ACTION_SEND_COMMAND`        | inbound   | `json` (string) — the command JSON                       |
| `com.mentra.asg_client.ACTION_REGISTER_LISTENER`   | inbound   | `packageName` (string) — package to deliver responses to |
| `com.mentra.asg_client.ACTION_UNREGISTER_LISTENER` | inbound   | `packageName` (string)                                   |
| `com.mentra.asg_client.ACTION_COMMAND_RESPONSE`    | outbound  | `json` (string) — the response JSON                      |

The first three actions are declared in `AndroidManifest.xml` with the `IntentCommandReceiver`. `ACTION_COMMAND_RESPONSE` is an outgoing-only action — debug APKs declare a receiver for it themselves.

### ADB examples

```bash
# Ping
adb shell am broadcast -a com.mentra.asg_client.ACTION_SEND_COMMAND \
  --es json '{"type":"ping","mId":12345}'

# Take a photo (direct upload)
adb shell am broadcast -a com.mentra.asg_client.ACTION_SEND_COMMAND \
  --es json '{"type":"take_photo","requestId":"test1","packageName":"com.test","webhookUrl":"https://example.com/upload","authToken":"Bearer xyz"}'

# Start a stream
adb shell am broadcast -a com.mentra.asg_client.ACTION_SEND_COMMAND \
  --es json '{"type":"start_stream","streamUrl":"rtmp://1.2.3.4/live/stream","streamId":"s1"}'

# Enable I2S audio
adb shell am broadcast -a com.mentra.asg_client.ACTION_SEND_COMMAND \
  --es json '{"type":"enable_i2s"}'

# Register a debug listener
adb shell am broadcast -a com.mentra.asg_client.ACTION_REGISTER_LISTENER \
  --es packageName "com.example.testapp"
```

### Receiving responses

```xml
<receiver android:name=".DebugResponseReceiver" android:enabled="true" android:exported="true">
    <intent-filter>
        <action android:name="com.mentra.asg_client.ACTION_COMMAND_RESPONSE" />
    </intent-filter>
</receiver>
```

```java
public class DebugResponseReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        String json = intent.getStringExtra("json");
        Log.d("Debug", "Response: " + json);
    }
}
```

---

## Logcat tags

| Tag                                                                     | Component                     |
| ----------------------------------------------------------------------- | ----------------------------- |
| `IntentCommandReceiver`                                                 | Incoming intent processing    |
| `IntentResponseBroadcaster`                                             | Outgoing response broadcasts  |
| `CommandProcessor`                                                      | Command routing               |
| `CommandHandlerRegistry`                                                | Handler registration / lookup |
| `PhotoCommandHandler`                                                   | Photo capture                 |
| `VideoCommandHandler`                                                   | Video + buffer recording      |
| `StreamCommandHandler`                                                  | Stream start/stop/keep-alive  |
| `RtmpStreamingService` / `SrtStreamingService` / `WhipStreamingService` | Stream lifecycle              |
| `WifiCommandHandler`                                                    | WiFi operations               |
| `RgbLedCommandHandler`                                                  | RGB LED                       |
| `K900CommandHandler`                                                    | K900 protocol passthrough     |
| `OtaCommandHandler`                                                     | OTA                           |
| `UploadIncidentLogsHandler`                                             | Incident log upload           |
