# ASG Client Command API

## Overview

`asg_client` exposes a JSON command API that controls hardware and system features on Mentra Live smart glasses. Every command is a JSON object with a `"type"` field that determines which handler processes it.

This API is used in two ways:

1. **BLE (primary)** — The MentraOS phone app sends commands over BLE to `asg_client`. This is the standard communication path between the phone and the glasses.
2. **Intent (debug/testing)** — The same commands can be sent via Android broadcast intents for development and testing without needing a phone connection. See [Debug Interface](#debug-interface-intent-broadcast) below.

Both paths feed into the same `CommandProcessor.processJsonCommand(JSONObject)`, so all commands and behaviors are identical regardless of transport.

## Architecture

```
ADB / Debug App (Intent)              Phone App (BLE)
     │                                      │
     ▼                                      ▼
IntentCommandReceiver              K900BluetoothManager
     │                                      │
     └──────────────────┬───────────────────┘
                        ▼
        CommandProcessor.processJsonCommand(JSONObject)
                        │
                        ▼
                ICommandHandler (route by "type")
                        │
                        ▼
              BaseBluetoothManager.sendData()
                        │
                ┌───────┴───────┐
                ▼               ▼
        K900 BLE send    Intent broadcast
        (to phone)       (to registered debug listeners)
```

## Common Fields

Every command can include:

- `type` (string, required) — Command type
- `mId` (long, optional) — Message ID for ACK tracking. If provided, glasses send a `msg_ack` response

### ACK Response

When `mId` is provided, glasses immediately respond:

```json
{"type": "msg_ack", "mId": 1234567890, "timestamp": 1708963201234}
```

---

## Command Reference

### 1. I2S Audio Control

Mentra Live routes speaker audio through the MCU via I2S. The I2S path must be explicitly opened before playing audio, and audio must use `AudioManager.STREAM_NOTIFICATION` as the stream type.

#### `enable_i2s` / `enable_android_audio`

Opens the I2S path from the Android SoC to the speaker.

```json
{"type": "enable_i2s"}
```

No response. Fire-and-forget.

#### `disable_i2s` / `disable_android_audio`

Closes the I2S path.

```json
{"type": "disable_i2s"}
```

No response. Fire-and-forget.

---

### 2. Photo Capture

#### `take_photo`

Capture a photo from the glasses camera.

**Request:**

```json
{
  "type": "take_photo",
  "requestId": "photo_001",
  "packageName": "com.example.app",
  "webhookUrl": "https://api.example.com/upload",
  "authToken": "token_abc123",
  "transferMethod": "auto",
  "save": true,
  "size": "medium",
  "silent": false
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `requestId` | string | Yes | - | Unique identifier for correlation |
| `packageName` | string | Yes | - | Requesting app package |
| `webhookUrl` | string | No | - | URL to upload photo |
| `authToken` | string | No | - | Auth token for webhook |
| `transferMethod` | string | No | "direct" | "direct", "ble", or "auto" |
| `save` | boolean | No | false | Save photo locally |
| `size` | string | No | "medium" | "small", "medium", "large" |
| `silent` | boolean | No | false | Suppress LED/sound feedback |

**Constraints:** Battery must be >= 10%. Cannot capture during video recording or active BLE transfer.

**Success Response:**

```json
{
  "type": "photo_response",
  "requestId": "photo_001",
  "success": true,
  "mediaUrl": "/storage/emulated/0/DCIM/photo_001.jpg"
}
```

**Error Response:**

```json
{
  "type": "photo_error_response",
  "requestId": "photo_001",
  "error_code": "BATTERY_LOW",
  "error_message": "Battery level too low (8%) - minimum 10% required"
}
```

Error codes: `BATTERY_LOW`, `VIDEO_RECORDING_ACTIVE`, `BLE_TRANSFER_BUSY`

---

### 3. Video Recording

#### `start_video_recording`

```json
{
  "type": "start_video_recording",
  "requestId": "video_001",
  "settings": {"width": 1280, "height": 720, "fps": 30},
  "save": true,
  "silent": false
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `requestId` | string | Yes | - | Unique identifier |
| `settings.width` | int | No | 1280 | Video width |
| `settings.height` | int | No | 720 | Video height |
| `settings.fps` | int | No | 30 | Frames per second |
| `save` | boolean | No | false | Save video locally |
| `silent` | boolean | No | false | Suppress feedback |

**Response:**

```json
{"type": "video_recording_status_update", "recording": true, "status": "recording_started"}
```

Status values: `recording_started`, `already_recording`, `battery_low`, `service_unavailable`, `error`

#### `stop_video_recording`

```json
{"type": "stop_video_recording"}
```

**Response:**

```json
{"type": "video_recording_status_update", "recording": false, "status": "recording_stopped"}
```

#### `get_video_recording_status`

```json
{"type": "get_video_recording_status"}
```

**Response (while recording):**

```json
{"type": "video_recording_status_update", "recording": true, "duration_ms": 15000, "duration_formatted": "00:15"}
```

---

### 4. Ping

#### `ping`

```json
{"type": "ping"}
```

**Response:**

```json
{"type": "ping_response", "timestamp": 1708963201234, "status": "pong"}
```

---

### 5. WiFi Management

#### `set_wifi_credentials`

```json
{"type": "set_wifi_credentials", "ssid": "MyNetwork", "password": "password123"}
```

#### `request_wifi_status`

```json
{"type": "request_wifi_status"}
```

#### `request_wifi_scan`

```json
{"type": "request_wifi_scan"}
```

**Response:**

```json
{
  "type": "wifi_scan_result",
  "timestamp": 1708963201234,
  "networks": ["MyNetwork", "OtherNetwork"],
  "networks_neo": [{"ssid": "MyNetwork", "signal_strength": -45, "security": "WPA2"}]
}
```

#### `set_hotspot_state`

```json
{"type": "set_hotspot_state", "enabled": true}
```

**Response:**

```json
{
  "type": "hotspot_status_update",
  "hotspot_enabled": true,
  "hotspot_ssid": "MentraLive_XXXX",
  "hotspot_password": "xxxxxxxx",
  "hotspot_gateway_ip": "192.168.43.1"
}
```

#### `disconnect_wifi`

```json
{"type": "disconnect_wifi"}
```

#### `forget_wifi`

```json
{"type": "forget_wifi", "ssid": "OldNetwork"}
```

---

### 6. Battery

#### `request_battery_state`

```json
{"type": "request_battery_state"}
```

#### `battery_status`

Update battery status (usually sent by phone to glasses).

```json
{"type": "battery_status", "level": 85, "charging": false, "timestamp": 1708963201234}
```

---

### 7. Version / System Info

#### `request_version`

```json
{"type": "request_version"}
```

**Response:**

```json
{"type": "version_info_response", "apk_version": "1.2.3", "os_version": "Android 12", "build_number": "20240226"}
```

---

### 8. RTMP Streaming

#### `start_rtmp_stream`

```json
{
  "type": "start_rtmp_stream",
  "rtmpUrl": "rtmp://streaming.example.com/live/stream",
  "streamId": "stream_123",
  "video": {"width": 1280, "height": 720, "fps": 30, "bitrate": 2500},
  "audio": {"sample_rate": 48000, "bitrate": 128}
}
```

**Constraints:** Battery must be >= 10%. WiFi must be connected.

**Response:**

```json
{"type": "rtmp_status_response", "streaming": true, "status": "streaming_started"}
```

#### `stop_rtmp_stream`

```json
{"type": "stop_rtmp_stream"}
```

#### `get_rtmp_status`

```json
{"type": "get_rtmp_status"}
```

**Response:**

```json
{"type": "rtmp_status_response", "streaming": true, "reconnecting": false}
```

#### `keep_rtmp_stream_alive`

```json
{"type": "keep_rtmp_stream_alive", "streamId": "stream_123", "ackId": "ack_456"}
```

---

### 9. IMU / Sensors

#### `imu_single`

```json
{"type": "imu_single"}
```

**Response:**

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

| Field | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `rate_hz` | int | 50 | 1-100 | Sampling rate in Hz |
| `batch_ms` | long | 0 | 0-1000 | Batching window in ms |

#### `imu_stream_stop`

```json
{"type": "imu_stream_stop"}
```

#### `set_mic_state`

```json
{"type": "set_mic_state"}
```

#### `set_mic_vad_state`

```json
{"type": "set_mic_vad_state"}
```

---

### 10. RGB LED Control

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

| Field | Type | Required | Range | Description |
|-------|------|----------|-------|-------------|
| `led` | int | Yes | 0-4 | 0=red, 1=green, 2=blue, 3=orange, 4=white |
| `ontime` | int | Yes | >=0 | On duration in ms |
| `offtime` | int | Yes | >=0 | Off duration in ms |
| `count` | int | Yes | >=0 | Number of cycles |
| `brightness` | int | No | 0-255 | Brightness level |

#### `rgb_led_control_off`

```json
{"type": "rgb_led_control_off"}
```

---

### 11. Gallery

#### `query_gallery_status`

```json
{"type": "query_gallery_status"}
```

**Response:**

```json
{
  "type": "gallery_status",
  "photos": 25,
  "videos": 5,
  "total": 30,
  "total_size": 2147483648,
  "has_content": true,
  "camera_busy": null
}
```

`camera_busy` values: `null`, `"video"`, `"stream"`

---

### 12. Settings

#### `button_video_recording_setting`

```json
{"type": "button_video_recording_setting", "params": {"width": 1920, "height": 1080, "fps": 30}}
```

#### `button_photo_setting`

```json
{"type": "button_photo_setting", "size": "large"}
```

#### `button_mode_setting`

```json
{"type": "button_mode_setting", "mode": "normal"}
```

#### `set_ble_mtu`

```json
{"type": "set_ble_mtu"}
```

---

### 13. Power Control

#### `shutdown`

```json
{"type": "shutdown"}
```

#### `reboot`

```json
{"type": "reboot"}
```

---

### 14. Internal Commands

These are used by the MentraOS phone app for session management.

#### `phone_ready`

Phone app signals it is connected and ready. Glasses respond with their own ready status and current hotspot state.

```json
{"type": "phone_ready"}
```

**Responses:**

```json
{"type": "glasses_ready", "timestamp": 1708963201234}
```

```json
{
  "type": "hotspot_status_update",
  "hotspot_enabled": true,
  "hotspot_ssid": "MentraLive_XXXX",
  "hotspot_password": "xxxxxxxx",
  "hotspot_gateway_ip": "192.168.43.1"
}
```

Also auto-sends WiFi status after 500ms and claims RGB LED control from the BES chip.

#### `auth_token`

Provide authentication token from Mentra app.

```json
{"type": "auth_token", "coreToken": "eyJhbGciOiJIUzI1NiJ9..."}
```

**Response:**

```json
{"type": "token_status", "success": true}
```

No response if token is empty.

#### `user_email`

Set user email for Sentry error reporting context.

```json
{"type": "user_email", "email": "user@example.com"}
```

No response. Fails silently if email is empty.

#### `service_heartbeat`

Keep-alive from the phone app to prevent service timeout.

```json
{"type": "service_heartbeat", "timestamp": 1708963201234, "heartbeat_counter": 42}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `timestamp` | long | No | current time | Heartbeat timestamp |
| `heartbeat_counter` | int | No | - | Sequential counter for tracking |

No response.

#### `keep_awake`

No-op keep-alive signal used to keep SoC awake during OTA updates.

```json
{"type": "keep_awake"}
```

No response.

#### `transfer_complete`

Confirm that a media file transfer from glasses to phone completed.

```json
{"type": "transfer_complete", "fileName": "photo_001.jpg", "success": true}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `fileName` | string | Yes | - | Name of transferred file |
| `success` | boolean | No | false | Whether transfer succeeded |

No response. Fails if `fileName` is empty.

#### `save_in_gallery_mode`

Enable or disable local photo/video capture on hardware button press.

```json
{"type": "save_in_gallery_mode", "active": true}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `active` | boolean | No | false | Enable button-triggered capture |

No response.

#### `upload_incident_logs`

Upload recent logcat logs to the backend for a bug report. Runs asynchronously over WiFi.

```json
{"type": "upload_incident_logs", "incidentId": "550e8400-e29b-41d4-a716-446655440000"}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `incidentId` | string | Yes | Backend incident identifier |

No direct response. Uploads last 400 log lines via HTTP POST and also collects BES firmware logs. Fails if `incidentId` is empty or no auth token is available.

#### `ota_start`

Start an OTA update download and install.

```json
{"type": "ota_start"}
```

**Error Response (if OTA system unavailable after retries):**

```json
{
  "type": "ota_progress",
  "stage": "download",
  "status": "FAILED",
  "progress": 0,
  "bytes_downloaded": 0,
  "total_bytes": 0,
  "current_update": "apk",
  "error_message": "OTA helper not initialized after 4 retries"
}
```

Retries up to 4 times with 2-second delays if OTA system isn't ready.

#### `ota_update_response`

Legacy command for accepting/rejecting an OTA update prompt. Deprecated — use `ota_start` instead.

```json
{"type": "ota_update_response", "accepted": true}
```

If `accepted` is true, delegates to `ota_start`. If false, logs rejection and takes no action.

---

## Debug Interface (Intent Broadcast)

For development and testing, commands can be sent to `asg_client` via Android broadcast intents. This is useful for ADB-based testing, automated test harnesses, and debugging without a phone connection.

### Intent Actions

| Action | Description |
|--------|-------------|
| `com.mentra.asg_client.ACTION_SEND_COMMAND` | Send a JSON command (extra: `json`) |
| `com.mentra.asg_client.ACTION_REGISTER_LISTENER` | Register to receive responses (extra: `packageName`) |
| `com.mentra.asg_client.ACTION_UNREGISTER_LISTENER` | Stop receiving responses (extra: `packageName`) |
| `com.mentra.asg_client.ACTION_COMMAND_RESPONSE` | Response broadcast sent to registered listeners (extra: `json`) |

### ADB Examples

```bash
# Ping
adb shell am broadcast -a com.mentra.asg_client.ACTION_SEND_COMMAND \
  --es json '{"type":"ping","mId":12345}'

# Enable I2S audio
adb shell am broadcast -a com.mentra.asg_client.ACTION_SEND_COMMAND \
  --es json '{"type":"enable_i2s"}'

# Take a photo
adb shell am broadcast -a com.mentra.asg_client.ACTION_SEND_COMMAND \
  --es json '{"type":"take_photo","requestId":"test1","packageName":"com.test"}'

# Register a debug listener
adb shell am broadcast -a com.mentra.asg_client.ACTION_REGISTER_LISTENER \
  --es packageName "com.example.testapp"

# Unregister
adb shell am broadcast -a com.mentra.asg_client.ACTION_UNREGISTER_LISTENER \
  --es packageName "com.example.testapp"
```

### Receiving Responses (for debug apps)

To receive responses in a debug APK, declare a receiver and register as a listener:

```xml
<receiver android:name=".DebugResponseReceiver" android:enabled="true" android:exported="true">
    <intent-filter>
        <action android:name="com.mentra.asg_client.ACTION_COMMAND_RESPONSE" />
    </intent-filter>
</receiver>
```

```java
public class DebugResponseReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String json = intent.getStringExtra("json");
        Log.d("Debug", "Response: " + json);
    }
}
```

## Logcat Tags

| Tag | Component |
|-----|-----------|
| `IntentCommandReceiver` | Incoming intent processing |
| `IntentResponseBroadcaster` | Outgoing response broadcasts |
| `I2SAudioCommandHandler` | I2S audio enable/disable |
| `CommandProcessor` | Command routing and processing |
| `CommunicationManager` | Response sending (BLE) |
| `BaseBluetoothManager` | Outbound data + intent broadcast |
