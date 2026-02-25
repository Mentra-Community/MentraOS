# WiFi WebSocket Control for ASG Client

## Overview

This feature adds a WebSocket server to the ASG Client that allows local WiFi-based control of Mentra Live smart glasses. It mirrors the existing BLE API, accepting the same JSON command format, enabling developers and power users to control glasses over their local network without going through the phone app.

## Problem Statement

Currently, all control of Mentra Live glasses flows through:

```
Phone App ──► BLE ──► Glasses
```

This has limitations:

- BLE range (~10m typical)
- BLE bandwidth constraints
- Requires phone app as intermediary
- No direct PC/desktop control

## Solution

Add a parallel WebSocket interface that accepts the same JSON commands:

```
Any Device ──► WiFi/WebSocket ──► Glasses
              (same JSON format)
```

Both interfaces coexist - BLE continues working as normal.

## Architecture

### Current Flow (BLE)

```
Phone App
    │
    ▼ (BLE - K900 Protocol: ##...$$)
K900BluetoothManager.onSerialRead()
    │
    ▼ (K900 unwrap)
AsgClientService.onDataReceived(byte[])
    │
    ▼
CommandProcessor.processCommand(byte[])
    │
    ▼ (parse JSON)
CommandProcessor.processJsonCommand(JSONObject)  ◄── ENTRY POINT
    │
    ├── Send ACK (if mId present)
    ├── Duplicate detection
    └── Route to Handler
            │
            ▼
    Handler executes (photo, video, wifi, etc.)
            │
            ▼
    CommunicationManager.sendResponse()
            │
            ▼
    K900BluetoothManager.sendData()
            │
            ├── K900 wrap (##...$$)
            └── Send to BLE
```

### New Flow (WebSocket + BLE)

```
┌─────────────────────────────────────────────────────────────────────┐
│                         INCOMING COMMANDS                            │
│                                                                      │
│   Phone App (BLE)                    WebSocket Client (WiFi)        │
│        │                                    │                        │
│        ▼                                    ▼                        │
│   K900BluetoothManager              WebSocketCommandServer          │
│        │                                    │                        │
│        ▼ (K900 unwrap)                      │ (already clean JSON)  │
│   processCommand(byte[])                    │                        │
│        │                                    │                        │
│        └──────────────┬─────────────────────┘                        │
│                       ▼                                              │
│           processJsonCommand(JSONObject)   ◄── SHARED ENTRY POINT   │
│                       │                                              │
│                       ├── Send ACK (mId)                            │
│                       ├── Duplicate detection                        │
│                       └── Route to Handler                           │
│                               │                                      │
│                               ▼                                      │
│                       Handler executes                               │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                         OUTGOING RESPONSES                           │
│                                                                      │
│                       Handler Response                               │
│                               │                                      │
│                               ▼                                      │
│                   CommunicationManager                               │
│                               │                                      │
│                               ▼                                      │
│                   K900BluetoothManager.sendData()                    │
│                               │                                      │
│           ┌───────────────────┴───────────────────┐                  │
│           │                                       │                  │
│           ▼                                       ▼                  │
│   WebSocketServer.broadcast()            K900 wrap + BLE send       │
│   (clean JSON, BEFORE wrap)              (to phone app)             │
│           │                                       │                  │
│           ▼                                       ▼                  │
│   WebSocket Clients                        Phone App                │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## JSON Command Format

WebSocket uses the exact same JSON format as BLE (after K900 unwrapping):

### Request Format

```json
{
  "type": "take_photo",
  "mId": 1234567890,
  "requestId": "req_abc123",
  "silent": false,
  "save": true
}
```

### Response Format (ACK)

```json
{
  "type": "msg_ack",
  "mId": 1234567890,
  "timestamp": 1234567890123
}
```

### Response Format (Result)

```json
{
  "type": "photo_response",
  "requestId": "req_abc123",
  "success": true,
  "mediaUrl": "/storage/emulated/0/DCIM/photo_001.jpg"
}
```

## Complete API Reference

All commands work over both BLE and WebSocket (same JSON format).

### Common Fields

Every command can include:

- `mId` (long, optional) - Message ID for ACK tracking. If provided, glasses send `msg_ack` response.
- `type` (string, required) - Command type

### ACK Response

When `mId` is provided, glasses immediately respond:

```json
{
  "type": "msg_ack",
  "mId": 1234567890,
  "timestamp": 1708963201234
}
```

---

### 1. Photo Capture

#### `take_photo`

Capture a photo from the glasses camera.

**Request:**

```json
{
  "type": "take_photo",
  "mId": 1234567890,
  "requestId": "photo_001",
  "packageName": "com.example.app",
  "webhookUrl": "https://api.example.com/upload",
  "authToken": "token_abc123",
  "bleImgId": "img_001",
  "transferMethod": "auto",
  "save": true,
  "size": "medium",
  "compress": "none",
  "silent": false
}
```

**Parameters:**
| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `requestId` | string | Yes | - | Unique identifier for correlation |
| `packageName` | string | Yes | - | Requesting app package |
| `webhookUrl` | string | No | - | URL to upload photo (for "direct" transfer) |
| `authToken` | string | No | - | Auth token for webhook |
| `bleImgId` | string | No | - | Image ID for BLE transfer |
| `transferMethod` | string | No | "direct" | "direct", "ble", or "auto" |
| `save` | boolean | No | false | Save photo locally |
| `size` | string | No | "medium" | "small", "medium", "large" |
| `compress` | string | No | "none" | Compression type |
| `silent` | boolean | No | false | Suppress LED/sound feedback |

**Constraints:**

- Battery must be ≥ 10%
- Cannot capture during video recording
- Cannot capture during active BLE transfer

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

**Error Codes:** `BATTERY_LOW`, `VIDEO_RECORDING_ACTIVE`, `BLE_TRANSFER_BUSY`

---

### 2. Video Recording

#### `start_video_recording`

Start video recording.

**Request:**

```json
{
  "type": "start_video_recording",
  "mId": 1234567890,
  "requestId": "video_001",
  "settings": {
    "width": 1280,
    "height": 720,
    "fps": 30
  },
  "save": true,
  "silent": false
}
```

**Parameters:**
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
{
  "type": "video_recording_status_update",
  "recording": true,
  "status": "recording_started"
}
```

**Status Values:** `recording_started`, `already_recording`, `battery_low`, `service_unavailable`, `error`

#### `stop_video_recording`

**Request:**

```json
{
  "type": "stop_video_recording",
  "mId": 1234567890
}
```

**Response:**

```json
{
  "type": "video_recording_status_update",
  "recording": false,
  "status": "recording_stopped"
}
```

#### `get_video_recording_status`

**Request:**

```json
{
  "type": "get_video_recording_status",
  "mId": 1234567890
}
```

**Response (while recording):**

```json
{
  "type": "video_recording_status_update",
  "recording": true,
  "duration_ms": 15000,
  "duration_formatted": "00:15"
}
```

---

### 3. Ping / Keepalive

#### `ping`

Test connectivity and reset heartbeat timeout.

**Request:**

```json
{
  "type": "ping",
  "mId": 1234567890
}
```

**Response:**

```json
{
  "type": "ping_response",
  "timestamp": 1708963201234,
  "status": "pong"
}
```

---

### 4. WiFi Management

#### `set_wifi_credentials`

Connect to a WiFi network.

**Request:**

```json
{
  "type": "set_wifi_credentials",
  "mId": 1234567890,
  "ssid": "MyNetwork",
  "password": "password123"
}
```

**Response (after connection attempt):**

```json
{
  "type": "wifi_status_update",
  "connected": true,
  "ssid": "MyNetwork"
}
```

#### `request_wifi_status`

**Request:**

```json
{
  "type": "request_wifi_status",
  "mId": 1234567890
}
```

#### `request_wifi_scan`

Scan for available networks.

**Request:**

```json
{
  "type": "request_wifi_scan",
  "mId": 1234567890
}
```

**Response:**

```json
{
  "type": "wifi_scan_results_enhanced",
  "networks": [
    {
      "ssid": "MyNetwork",
      "signal_strength": -45,
      "security": "WPA2",
      "frequency": "2.4GHz"
    }
  ]
}
```

#### `set_hotspot_state`

Enable/disable hotspot mode.

**Request:**

```json
{
  "type": "set_hotspot_state",
  "mId": 1234567890,
  "enabled": true
}
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

**Request:**

```json
{
  "type": "disconnect_wifi",
  "mId": 1234567890
}
```

#### `forget_wifi`

**Request:**

```json
{
  "type": "forget_wifi",
  "mId": 1234567890,
  "ssid": "OldNetwork"
}
```

---

### 5. Battery Status

#### `battery_status`

Report battery status (usually sent by phone to glasses).

**Request:**

```json
{
  "type": "battery_status",
  "mId": 1234567890,
  "level": 85,
  "charging": false,
  "timestamp": 1708963201234
}
```

#### `request_battery_state`

**Request:**

```json
{
  "type": "request_battery_state",
  "mId": 1234567890
}
```

---

### 6. Version / System Info

#### `request_version`

**Request:**

```json
{
  "type": "request_version",
  "mId": 1234567890
}
```

**Response:**

```json
{
  "type": "version_info_response",
  "apk_version": "1.2.3",
  "os_version": "Android 12",
  "build_number": "20240226"
}
```

---

### 7. RTMP Streaming

#### `start_rtmp_stream`

Start live streaming to RTMP server.

**Request:**

```json
{
  "type": "start_rtmp_stream",
  "mId": 1234567890,
  "rtmpUrl": "rtmp://streaming.example.com/live/stream",
  "streamId": "stream_123",
  "video": {
    "width": 1280,
    "height": 720,
    "fps": 30,
    "bitrate": 2500
  },
  "audio": {
    "sample_rate": 48000,
    "bitrate": 128
  },
  "silent": false
}
```

**Constraints:**

- Battery must be ≥ 10%
- WiFi must be connected

**Response:**

```json
{
  "type": "rtmp_status_response",
  "streaming": true,
  "status": "streaming_started"
}
```

#### `stop_rtmp_stream`

**Request:**

```json
{
  "type": "stop_rtmp_stream",
  "mId": 1234567890
}
```

#### `get_rtmp_status`

**Request:**

```json
{
  "type": "get_rtmp_status",
  "mId": 1234567890
}
```

**Response:**

```json
{
  "type": "rtmp_status_response",
  "streaming": true,
  "reconnecting": false
}
```

#### `keep_rtmp_stream_alive`

**Request:**

```json
{
  "type": "keep_rtmp_stream_alive",
  "mId": 1234567890,
  "streamId": "stream_123",
  "ackId": "ack_456"
}
```

---

### 8. IMU / Sensors

#### `imu_single`

Get single IMU reading.

**Request:**

```json
{
  "type": "imu_single",
  "mId": 1234567890
}
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

Start continuous IMU streaming.

**Request:**

```json
{
  "type": "imu_stream_start",
  "mId": 1234567890,
  "rate_hz": 50,
  "batch_ms": 100
}
```

**Parameters:**
| Field | Type | Default | Range | Description |
|-------|------|---------|-------|-------------|
| `rate_hz` | int | 50 | 1-100 | Sampling rate in Hz |
| `batch_ms` | long | 0 | 0-1000 | Batching window in ms |

#### `imu_stream_stop`

**Request:**

```json
{
  "type": "imu_stream_stop",
  "mId": 1234567890
}
```

#### `imu_subscribe_gesture`

Subscribe to gesture detection.

**Request:**

```json
{
  "type": "imu_subscribe_gesture",
  "mId": 1234567890,
  "gestures": ["nod_yes", "shake_no", "head_up", "head_down"]
}
```

**Response:**

```json
{
  "type": "imu_gesture_subscribed",
  "gestures": ["nod_yes", "shake_no", "head_up", "head_down"]
}
```

**Gesture Events (when detected):**

```json
{
  "type": "imu_gesture_detected",
  "gesture": "nod_yes",
  "timestamp": 1708963201234
}
```

#### `imu_unsubscribe_gesture`

**Request:**

```json
{
  "type": "imu_unsubscribe_gesture",
  "mId": 1234567890
}
```

---

### 9. Gallery / Media Status

#### `query_gallery_status`

Get gallery contents summary.

**Request:**

```json
{
  "type": "query_gallery_status",
  "mId": 1234567890
}
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

### 10. RGB LED Control

#### `rgb_led_control_on`

Turn on LED with pattern.

**Request:**

```json
{
  "type": "rgb_led_control_on",
  "mId": 1234567890,
  "led": 4,
  "ontime": 500,
  "offtime": 500,
  "count": 3,
  "brightness": 200
}
```

**Parameters:**
| Field | Type | Required | Range | Description |
|-------|------|----------|-------|-------------|
| `led` | int | Yes | 0-4 | LED index: 0=red, 1=green, 2=blue, 3=orange, 4=white |
| `ontime` | int | Yes | ≥0 | On duration in ms |
| `offtime` | int | Yes | ≥0 | Off duration in ms |
| `count` | int | Yes | ≥0 | Number of cycles |
| `brightness` | int | No | 0-255 | Brightness level |

#### `rgb_led_control_off`

**Request:**

```json
{
  "type": "rgb_led_control_off",
  "mId": 1234567890
}
```

#### `rgb_led_photo_flash`

White flash for photo feedback.

**Request:**

```json
{
  "type": "rgb_led_photo_flash",
  "mId": 1234567890,
  "duration": 5000,
  "brightness": 255
}
```

#### `rgb_led_video_solid`

Solid white for video recording.

**Request:**

```json
{
  "type": "rgb_led_video_solid",
  "mId": 1234567890,
  "brightness": 200
}
```

---

### 11. Settings

#### `button_video_recording_setting`

Configure hardware button video settings.

**Request:**

```json
{
  "type": "button_video_recording_setting",
  "mId": 1234567890,
  "params": {
    "width": 1920,
    "height": 1080,
    "fps": 30
  }
}
```

#### `button_max_recording_time`

**Request:**

```json
{
  "type": "button_max_recording_time",
  "mId": 1234567890,
  "minutes": 10
}
```

#### `button_photo_setting`

**Request:**

```json
{
  "type": "button_photo_setting",
  "mId": 1234567890,
  "size": "large"
}
```

#### `button_camera_led`

**Request:**

```json
{
  "type": "button_camera_led",
  "mId": 1234567890,
  "enabled": true
}
```

#### `button_mode_setting`

**Request:**

```json
{
  "type": "button_mode_setting",
  "mId": 1234567890,
  "mode": "normal"
}
```

---

### 12. Power Control

#### `shutdown`

**Request:**

```json
{
  "type": "shutdown",
  "mId": 1234567890
}
```

#### `reboot`

**Request:**

```json
{
  "type": "reboot",
  "mId": 1234567890
}
```

---

### 13. OTA Updates

#### `ota_start`

Start OTA update (user approved).

**Request:**

```json
{
  "type": "ota_start",
  "mId": 1234567890
}
```

**Progress Events:**

```json
{
  "type": "ota_progress",
  "stage": "download",
  "status": "IN_PROGRESS",
  "progress": 45,
  "bytes_downloaded": 4500000,
  "total_bytes": 10000000
}
```

---

### 14. Authentication

#### `auth_token`

Set authentication token.

**Request:**

```json
{
  "type": "auth_token",
  "mId": 1234567890,
  "coreToken": "eyJhbGciOiJIUzI1NiIs..."
}
```

**Response:**

```json
{
  "type": "token_status_response",
  "success": true
}
```

---

### 15. User Identification

#### `user_email`

Set user email for identification/crash reporting.

**Request:**

```json
{
  "type": "user_email",
  "mId": 1234567890,
  "email": "user@example.com"
}
```

---

### 16. Phone Ready / Initialization

#### `phone_ready`

Phone connected and ready.

**Request:**

```json
{
  "type": "phone_ready",
  "mId": 1234567890
}
```

**Response:**

```json
{
  "type": "glasses_ready",
  "device": "MentraLive",
  "capabilities": ["photo", "video", "rtmp", "imu"]
}
```

---

### 17. BLE Configuration

#### `set_ble_mtu`

Configure BLE packet size.

**Request:**

```json
{
  "type": "set_ble_mtu",
  "mId": 1234567890,
  "mtu": 515
}
```

---

### 18. File Transfer

#### `transfer_complete`

Notify glasses that file transfer completed.

**Request:**

```json
{
  "type": "transfer_complete",
  "mId": 1234567890,
  "fileName": "IMG_20240226_123456.jpg",
  "success": true
}
```

---

### 19. Gallery Mode

#### `save_in_gallery_mode`

Toggle gallery/camera mode for button presses.

**Request:**

```json
{
  "type": "save_in_gallery_mode",
  "mId": 1234567890,
  "active": true
}
```

---

### 20. Service Heartbeat

#### `service_heartbeat`

Service keepalive signal.

**Request:**

```json
{
  "type": "service_heartbeat",
  "mId": 1234567890,
  "timestamp": 1708963201234,
  "heartbeat_counter": 42
}
```

---

## Existing HTTP Server

The glasses also run an HTTP camera server (AsgCameraServer) for direct photo access:

| Endpoint                 | Method | Description            |
| ------------------------ | ------ | ---------------------- |
| `/api/take-picture`      | POST   | Trigger photo capture  |
| `/api/latest-photo`      | GET    | Get most recent photo  |
| `/api/gallery`           | GET    | List photos            |
| `/api/download?file=...` | GET    | Download specific file |

**Default Port:** 8080

The WebSocket server (port 9091) and HTTP server (port 8080) coexist independently.

---

## Behavior Notes

### Duplicate Detection

Commands with the same `mId` within 10 seconds are considered duplicates. The glasses will send an ACK but skip processing.

### Battery Protection

Commands that use significant power (photo, video, RTMP) require battery ≥ 10%. Below that threshold, commands are rejected with `battery_low` error.

### Async Operations

Some commands operate asynchronously:

- `take_photo` - Response comes via callback after capture
- `request_wifi_scan` - Results come after scan completes
- `ota_start` - Progress events stream over time

### BLE + WebSocket Coexistence

When both are connected:

- Both can send commands (processed by same handler)
- Both receive ALL responses (broadcast pattern)
- Duplicate detection prevents double-processing if same `mId` sent via both

---

## Implementation Plan

### Phase 1: Core Infrastructure

#### 1.1 Make processJsonCommand Public

**File:** `service/core/processors/CommandProcessor.java`

Change visibility from `private` to `public`:

```java
// Before:
private void processJsonCommand(JSONObject json) { ... }

// After:
public void processJsonCommand(JSONObject json) { ... }
```

This is the shared entry point for both BLE and WebSocket.

#### 1.2 Create WebSocket Server

**File:** `io/server/websocket/WebSocketCommandServer.java` (NEW)

```java
package com.mentra.asg_client.io.server.websocket;

import android.util.Log;
import org.java_websocket.WebSocket;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.server.WebSocketServer;
import org.json.JSONObject;
import java.net.InetSocketAddress;
import java.util.Collections;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

public class WebSocketCommandServer extends WebSocketServer {
    private static final String TAG = "WebSocketCommandServer";
    private static final int DEFAULT_PORT = 9091;

    private final Set<WebSocket> connectedClients = Collections.newSetFromMap(new ConcurrentHashMap<>());
    private CommandProcessor commandProcessor;
    private boolean isRunning = false;

    public WebSocketCommandServer() {
        this(DEFAULT_PORT);
    }

    public WebSocketCommandServer(int port) {
        super(new InetSocketAddress(port));
        setReuseAddr(true);
        Log.i(TAG, "WebSocket server created on port " + port);
    }

    public void setCommandProcessor(CommandProcessor processor) {
        this.commandProcessor = processor;
    }

    @Override
    public void onOpen(WebSocket conn, ClientHandshake handshake) {
        connectedClients.add(conn);
        Log.i(TAG, "Client connected: " + conn.getRemoteSocketAddress() +
                   " (total: " + connectedClients.size() + ")");

        // Send welcome message
        JSONObject welcome = new JSONObject();
        try {
            welcome.put("type", "connected");
            welcome.put("message", "MentraLive WebSocket API");
            welcome.put("version", "1.0");
            conn.send(welcome.toString());
        } catch (Exception e) {
            Log.e(TAG, "Error sending welcome message", e);
        }
    }

    @Override
    public void onClose(WebSocket conn, int code, String reason, boolean remote) {
        connectedClients.remove(conn);
        Log.i(TAG, "Client disconnected: " + conn.getRemoteSocketAddress() +
                   " (reason: " + reason + ", total: " + connectedClients.size() + ")");
    }

    @Override
    public void onMessage(WebSocket conn, String message) {
        Log.d(TAG, "Received message: " + message);

        if (commandProcessor == null) {
            Log.e(TAG, "CommandProcessor not set - cannot process message");
            sendError(conn, "Server not ready");
            return;
        }

        try {
            JSONObject json = new JSONObject(message);

            // Process command through same path as BLE
            // This handles ACK, duplicate detection, and routing
            commandProcessor.processJsonCommand(json);

        } catch (Exception e) {
            Log.e(TAG, "Error processing WebSocket message", e);
            sendError(conn, "Invalid JSON: " + e.getMessage());
        }
    }

    @Override
    public void onError(WebSocket conn, Exception ex) {
        Log.e(TAG, "WebSocket error" + (conn != null ? " for " + conn.getRemoteSocketAddress() : ""), ex);
    }

    @Override
    public void onStart() {
        isRunning = true;
        Log.i(TAG, "WebSocket server started on port " + getPort());
    }

    /**
     * Broadcast a message to all connected clients.
     * Called from K900BluetoothManager before K900 wrapping.
     */
    public void broadcast(String message) {
        if (connectedClients.isEmpty()) {
            return;
        }

        Log.d(TAG, "Broadcasting to " + connectedClients.size() + " clients: " +
                   message.substring(0, Math.min(100, message.length())) + "...");

        for (WebSocket client : connectedClients) {
            try {
                if (client.isOpen()) {
                    client.send(message);
                }
            } catch (Exception e) {
                Log.e(TAG, "Error broadcasting to client", e);
            }
        }
    }

    /**
     * Check if any clients are connected.
     */
    public boolean hasClients() {
        return !connectedClients.isEmpty();
    }

    /**
     * Get number of connected clients.
     */
    public int getClientCount() {
        return connectedClients.size();
    }

    /**
     * Check if server is running.
     */
    public boolean isRunning() {
        return isRunning;
    }

    /**
     * Stop the server gracefully.
     */
    public void stopServer() {
        try {
            isRunning = false;
            for (WebSocket client : connectedClients) {
                client.close(1000, "Server shutting down");
            }
            connectedClients.clear();
            stop(1000); // 1 second timeout
            Log.i(TAG, "WebSocket server stopped");
        } catch (Exception e) {
            Log.e(TAG, "Error stopping WebSocket server", e);
        }
    }

    private void sendError(WebSocket conn, String errorMessage) {
        try {
            JSONObject error = new JSONObject();
            error.put("type", "error");
            error.put("message", errorMessage);
            conn.send(error.toString());
        } catch (Exception e) {
            Log.e(TAG, "Error sending error message", e);
        }
    }
}
```

#### 1.3 Add Gradle Dependency

**File:** `app/build.gradle`

Add Java-WebSocket library:

```gradle
dependencies {
    // ... existing dependencies ...

    // WebSocket server
    implementation 'org.java-websocket:Java-WebSocket:1.5.4'
}
```

### Phase 2: Response Broadcasting

#### 2.1 Add WebSocket Reference to BluetoothManager

**File:** `io/bluetooth/k900/K900BluetoothManager.java`

Add WebSocket server reference and intercept point:

```java
public class K900BluetoothManager extends BaseBluetoothManager {
    // ... existing fields ...

    // WebSocket server for response broadcasting
    private WebSocketCommandServer webSocketServer;

    /**
     * Set the WebSocket server for response broadcasting.
     */
    public void setWebSocketServer(WebSocketCommandServer server) {
        this.webSocketServer = server;
        Log.i(TAG, "WebSocket server attached for response broadcasting");
    }

    @Override
    public boolean sendData(byte[] data) {
        if (data == null || data.length == 0) {
            return false;
        }

        String originalData = new String(data, StandardCharsets.UTF_8);

        // ═══════════════════════════════════════════════════════════
        // INTERCEPT POINT: Broadcast clean JSON to WebSocket clients
        // This happens BEFORE K900 protocol wrapping
        // ═══════════════════════════════════════════════════════════
        if (webSocketServer != null && webSocketServer.hasClients()) {
            if (originalData.startsWith("{")) {
                // It's JSON - broadcast to WebSocket clients
                webSocketServer.broadcast(originalData);
                Log.d(TAG, "Broadcasted response to WebSocket clients");
            }
        }

        // Continue with existing K900 wrapping and BLE send
        // ... existing sendData implementation ...
    }
}
```

### Phase 3: Service Integration

#### 3.1 Update ServiceContainer

**File:** `service/core/ServiceContainer.java`

Add WebSocket server lifecycle management:

```java
public class ServiceContainer {
    // ... existing fields ...

    private WebSocketCommandServer webSocketServer;
    private static final int WEBSOCKET_PORT = 9091;

    public void initialize(Context context, /* existing params */) {
        // ... existing initialization ...

        // Initialize WebSocket server
        initializeWebSocketServer();
    }

    private void initializeWebSocketServer() {
        try {
            webSocketServer = new WebSocketCommandServer(WEBSOCKET_PORT);
            webSocketServer.setCommandProcessor(commandProcessor);

            // Connect to BluetoothManager for response broadcasting
            if (bluetoothManager instanceof K900BluetoothManager) {
                ((K900BluetoothManager) bluetoothManager).setWebSocketServer(webSocketServer);
            }

            // Start server in background thread
            webSocketServer.start();
            Log.i(TAG, "WebSocket command server started on port " + WEBSOCKET_PORT);

        } catch (Exception e) {
            Log.e(TAG, "Failed to start WebSocket server", e);
        }
    }

    public void shutdown() {
        // ... existing shutdown ...

        if (webSocketServer != null) {
            webSocketServer.stopServer();
            webSocketServer = null;
        }
    }

    public WebSocketCommandServer getWebSocketServer() {
        return webSocketServer;
    }
}
```

### Phase 4: Configuration

#### 4.1 Add Configuration Options

**File:** `service/system/managers/ConfigurationManager.java`

Add WebSocket configuration:

```java
public class ConfigurationManager implements IConfigurationManager {
    // ... existing fields ...

    private static final String KEY_WEBSOCKET_ENABLED = "websocket_enabled";
    private static final String KEY_WEBSOCKET_PORT = "websocket_port";
    private static final int DEFAULT_WEBSOCKET_PORT = 9091;

    public boolean isWebSocketEnabled() {
        return sharedPreferences.getBoolean(KEY_WEBSOCKET_ENABLED, true);
    }

    public void setWebSocketEnabled(boolean enabled) {
        sharedPreferences.edit().putBoolean(KEY_WEBSOCKET_ENABLED, enabled).apply();
    }

    public int getWebSocketPort() {
        return sharedPreferences.getInt(KEY_WEBSOCKET_PORT, DEFAULT_WEBSOCKET_PORT);
    }

    public void setWebSocketPort(int port) {
        sharedPreferences.edit().putInt(KEY_WEBSOCKET_PORT, port).apply();
    }
}
```

#### 4.2 Add WebSocket Settings Command Handler

**File:** `service/core/handlers/WebSocketSettingsCommandHandler.java` (NEW)

```java
package com.mentra.asg_client.service.core.handlers;

import android.util.Log;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import com.mentra.asg_client.io.server.websocket.WebSocketCommandServer;
import org.json.JSONObject;
import java.util.HashSet;
import java.util.Set;

public class WebSocketSettingsCommandHandler implements ICommandHandler {
    private static final String TAG = "WebSocketSettingsHandler";

    private final WebSocketCommandServer webSocketServer;

    public WebSocketSettingsCommandHandler(WebSocketCommandServer server) {
        this.webSocketServer = server;
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        Set<String> types = new HashSet<>();
        types.add("websocket_status");
        return types;
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        if ("websocket_status".equals(commandType)) {
            return handleStatusRequest(data);
        }
        return false;
    }

    private boolean handleStatusRequest(JSONObject data) {
        try {
            JSONObject response = new JSONObject();
            response.put("type", "websocket_status_response");
            response.put("running", webSocketServer != null && webSocketServer.isRunning());
            response.put("port", webSocketServer != null ? webSocketServer.getPort() : 0);
            response.put("clients", webSocketServer != null ? webSocketServer.getClientCount() : 0);

            // Response will be sent via normal response flow
            Log.d(TAG, "WebSocket status: " + response.toString());
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error handling websocket_status", e);
            return false;
        }
    }
}
```

## File Summary

### New Files

| File                                                         | Description                                    |
| ------------------------------------------------------------ | ---------------------------------------------- |
| `io/server/websocket/WebSocketCommandServer.java`            | WebSocket server implementation                |
| `service/core/handlers/WebSocketSettingsCommandHandler.java` | Handler for WebSocket status/settings commands |
| `agents/WIFI_WEBSOCKET_CONTROL.md`                           | This documentation                             |

### Modified Files

| File                                                | Changes                                 |
| --------------------------------------------------- | --------------------------------------- |
| `service/core/processors/CommandProcessor.java`     | Make `processJsonCommand` public        |
| `io/bluetooth/k900/K900BluetoothManager.java`       | Add WebSocket intercept in `sendData()` |
| `service/core/ServiceContainer.java`                | Initialize and wire up WebSocket server |
| `service/system/managers/ConfigurationManager.java` | Add WebSocket config options            |
| `app/build.gradle`                                  | Add Java-WebSocket dependency           |

## Usage Examples

### Connecting from Python

```python
import websocket
import json

ws = websocket.create_connection("ws://192.168.1.100:9091")

# Take a photo
ws.send(json.dumps({
    "type": "take_photo",
    "mId": 12345,
    "requestId": "photo_001"
}))

# Receive ACK
ack = json.loads(ws.recv())
print(f"ACK: {ack}")

# Receive photo response
response = json.loads(ws.recv())
print(f"Photo: {response}")

ws.close()
```

### Connecting from JavaScript

```javascript
const ws = new WebSocket("ws://192.168.1.100:9091")

ws.onopen = () => {
  console.log("Connected to MentraLive")

  // Take a photo
  ws.send(
    JSON.stringify({
      type: "take_photo",
      mId: Date.now(),
      requestId: "photo_001",
    }),
  )
}

ws.onmessage = (event) => {
  const data = JSON.parse(event.data)
  console.log("Received:", data)
}
```

### Connecting from curl (for testing)

```bash
# Using websocat
websocat ws://192.168.1.100:9091

# Then type JSON commands:
{"type": "ping", "mId": 123}
{"type": "battery_status", "mId": 124}
{"type": "take_photo", "mId": 125, "requestId": "test"}
```

## WebSocket Connection Lifecycle

### On Connect

When a client connects, the server sends a welcome message:

```json
{
  "type": "connected",
  "message": "MentraLive WebSocket API",
  "version": "1.0",
  "device": "MentraLive",
  "capabilities": ["photo", "video", "rtmp", "imu", "wifi", "led"]
}
```

### On Disconnect

Server logs disconnection. No cleanup needed - stateless design.

### Keepalive

For long-lived connections, send periodic `ping` commands:

```json
{"type": "ping", "mId": 1234567890}
```

Recommended interval: 30 seconds

### Error Handling

Invalid JSON or processing errors return:

```json
{
  "type": "error",
  "message": "Invalid JSON: Unterminated string at position 42"
}
```

---

## Discovery / Status

### Get Device Status

Send `ping` for basic connectivity, or use these for detailed status:

**Battery:**

```json
{"type": "request_battery_state", "mId": 1}
```

**WiFi:**

```json
{"type": "request_wifi_status", "mId": 2}
```

**Recording:**

```json
{"type": "get_video_recording_status", "mId": 3}
```

**Streaming:**

```json
{"type": "get_rtmp_status", "mId": 4}
```

**Gallery:**

```json
{"type": "query_gallery_status", "mId": 5}
```

### WebSocket Server Status (New Command)

Check WebSocket server itself:

```json
{"type": "websocket_status", "mId": 6}
```

**Response:**

```json
{
  "type": "websocket_status_response",
  "running": true,
  "port": 9091,
  "clients": 2
}
```

---

## Security Considerations

### Current Scope (Local Network Only)

This implementation is designed for **local network use only**:

- WebSocket server binds to device's WiFi IP
- No authentication (trusted local network assumed)
- No encryption (plain WebSocket, not WSS)

### Future Enhancements (Not in Scope)

For production/public use, consider:

1. **Authentication**: API key or token-based auth
2. **TLS/SSL**: Use WSS instead of WS
3. **Rate Limiting**: Prevent abuse
4. **IP Whitelisting**: Restrict to known clients

## Testing Plan

### Unit Tests

1. **WebSocketCommandServer**
   - Server starts on correct port
   - Clients can connect/disconnect
   - Messages are parsed and forwarded to CommandProcessor
   - Broadcast reaches all connected clients

2. **Response Interception**
   - JSON responses are broadcast before K900 wrapping
   - Non-JSON data is not broadcast
   - Empty client list doesn't cause errors

### Integration Tests

1. **End-to-End Command Flow**
   - WebSocket client sends `ping` → receives ACK + pong response
   - WebSocket client sends `take_photo` → receives ACK + photo response
   - BLE and WebSocket can send commands simultaneously

2. **Coexistence with BLE**
   - BLE commands still work when WebSocket is connected
   - WebSocket commands don't interfere with BLE responses
   - Both receive responses for their respective commands

### Manual Testing

1. Connect to glasses WiFi or same network
2. Use websocat or Python script to connect
3. Send various commands and verify responses
4. Verify BLE still works via phone app simultaneously

## Rollout Plan

### Phase 1: Internal Testing

- Build and deploy to test devices
- Verify basic functionality
- Test coexistence with BLE

### Phase 2: Developer Preview

- Document API in developer portal
- Provide example clients (Python, JS)
- Gather feedback

### Phase 3: General Availability

- Enable by default
- Add to MentraOS SDK documentation
- Consider authentication for public networks

## FAQ

**Q: Will this break existing BLE functionality?**
A: No. BLE flow is unchanged. WebSocket is a parallel path that joins at `processJsonCommand()`.

**Q: Do I need to be on the same WiFi network?**
A: Yes, for now. The WebSocket server binds to the glasses' WiFi IP.

**Q: What happens if both BLE and WebSocket send the same command?**
A: Duplicate detection (10-second window by mId) will prevent double-processing.

**Q: Can I use this without the phone app?**
A: Yes, if glasses are already connected to WiFi. Otherwise you need the phone app to configure WiFi first.

**Q: What port does it use?**
A: Default is 9091. Configurable via settings.

**Q: Is it secure?**
A: For local network use, it's as secure as your WiFi. No auth/encryption currently.
