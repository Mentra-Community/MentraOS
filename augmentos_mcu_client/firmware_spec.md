# 📦 AugmentOS BLE Packet Format Specification (v1.1)

## 🔑 Overview

This specification defines the binary packet format and transport protocol for communication between AugmentOS Core (on a phone) and smart glasses via Bluetooth Low Energy (BLE). It supports both JSON control messages and high-speed binary data transfers like audio and image streams.

* All messages are sent over **standard BLE characteristics (GATT)**.
* Every BLE packet starts with a **1-byte control header**.
* The control header byte indicates the type of payload.

---

## 🔐 GATT Service & Characteristic Definitions

| Role    | UUID                                   | Description                          |
| ------- | -------------------------------------- | ------------------------------------ |
| Service | `00004860-0000-1000-8000-00805f9b34fb` | AugmentOS BLE Service                |
| TX Char | `000071FF-0000-1000-8000-00805f9b34fb` | Phone (central) → Glasses (write)    |
| RX Char | `000070FF-0000-1000-8000-00805f9b34fb` | Glasses → Phone (notify or indicate) |
| CCCD    | `00002902-0000-1000-8000-00805f9b34fb` | Enable notify on RX Char             |

* The phone acts as **GATT central**, the glasses are **GATT peripheral**.
* Glasses send **notifications** on the RX characteristic.

---

## 🔠 Packet Types

| Control Header Byte   | Type           | Payload Format                                                |
| ------------- | -------------- | ------------------------------------------------------------- |
| `0x01`        | JSON message   | UTF-8 encoded JSON                                            |
| `0xA0`        | Audio chunk    | `[A0][stream_id (1 byte)][frame data]`                        |
| `0xB0`        | Image chunk    | `[B0][stream_id (2 bytes)][chunk_index (1 byte)][chunk_data]` |
| `0xD0`–`0xFF` | Reserved       | —                                                             |

---

## 📄 JSON Message

All JSON messages must begin with `0x01`, followed by UTF-8 encoded JSON bytes.

### Example:

```
[0x01]{"type":"ping","msg_id":"abc123"}
```

No length header is needed; BLE characteristic defines packet length.

---

## 🔊 Audio Chunk Format

```
[0xA0][stream_id (1 byte)][LC3 frame data]
```

* `stream_id`: allows multiple audio streams (e.g., mic vs TTS)
* Frame size determined by LC3 codec settings and MTU

---

## 🖼️ Image Transfer Format

### 1. JSON Metadata (Initiation)

```json
{
  "type": "display_image",
  "msg_id": "img_start_1",
  "stream_id": "002A",
  "x": 0,
  "y": 0,
  "width": 128,
  "height": 64,
  "encoding": "webp",  
  "total_chunks": 9
}
```

### 2. Chunk Packets

```
[0xB0][stream_id_hi][stream_id_lo][chunk_index][chunk_data]
```

* `stream_id`: same as in JSON, 2 bytes
* `chunk_index`: 0–255
* `chunk_data`: raw image bytes (size ≤ MTU-4)

### 3. Transfer Completion Response

**Success:**

```json
{
  "type": "image_transfer_complete",
  "stream_id": "002A",
  "status": "ok"
}
```

**Missing chunks:**

```json
{
  "type": "image_transfer_complete",
  "stream_id": "002A",
  "status": "incomplete",
  "missing_chunks": [3, 4, 6]
}
```

### 4. Optional Retry

If any image chunks are missing (as indicated in the `missing_chunks` list from the receiver), the sender may retry those chunks individually:

```text
[0xB0][0x00][0x2A][0x03][...]
[0xB0][0x00][0x2A][0x04][...]
[0xB0][0x00][0x2A][0x06][...]
```

This can be repeated until all chunks are acknowledged or a timeout is reached.

---

## 📀 Connection Management JSON Commands

### Disconnect

Terminate connection and clean up resources.

| Phone → Glasses                                  | Glasses → Phone |
| ------------------------------------------------ | --------------- |
| `{ "type": "disconnect", "msg_id": "disc_001" }` | *(none)*        |

---

### Get Battery Level

Report current battery percentage, and whether charging now or not.

| Phone → Glasses                                               | Glasses → Phone                                                |
| ------------------------------------------------------------- | -------------------------------------------------------------- |
| `{ "type": "request_battery_state", "msg_id": "battery123" }` | `{ "type": "battery_status", "level": 82, "charging": false }` |

---

### Charging State Changed Event

Emitted when glasses detect they are charging.

| Phone → Glasses | Glasses → Phone                                     |
| --------------- | --------------------------------------------------- |
| *(none)*        | `{ "type": "charging_state", "state": "charging" }` |

---

### Get Glasses Info

Query all available runtime capabilities from the glasses, including hardware features, firmware version, display resolution, and supported sensors/audio.

#### 📲 Phone → Glasses

```json
{
  "type": "request_glasses_info",
  "msg_id": "info_22"
}
```

#### 👓 Glasses → Phone

```json
{
  "type": "device_info",
  "fw": "1.2.3",
  "hw": "MentraLive",
  "features": {
    "camera": true,
    "display": true,
    "audio_tx": true,
    "audio_rx": false,
    "imu": true,
    "vad": true,
    "mic_switching": true,
    "image_chunk_buffer": 12
  }
}
```

---

### Enter Pairing State

Force glasses into pairing mode. This may also happen automatically on boot if no phone has previously been paired.

| Phone → Glasses                                          | Glasses → Phone |
| -------------------------------------------------------- | --------------- |
| `{ "type": "enter_pairing_mode", "msg_id": "pair_001" }` | *(none)*        |

---

### Get Head Position

Report the wearer's current head tilt angle in degrees.

| Phone → Glasses                                             | Glasses → Phone                            |
| ----------------------------------------------------------- | ------------------------------------------ |
| `{ "type": "request_head_position", "msg_id": "head_001" }` | `{ "type": "head_position", "angle": 15 }` |

---

### Set Head-Up Angle Threshold

Configure the head-up detection angle (in degrees).

| Phone → Glasses                                                       | Glasses → Phone                                    |
| --------------------------------------------------------------------- | -------------------------------------------------- |
| `{ "type": "set_head_up_angle", "msg_id": "angle_001", "angle": 20 }` | `{ "type": "head_up_angle_set", "success": true }` |

---

### Heartbeat / Ping

Verify that connection is still alive.

| Phone → Glasses                            | Glasses → Phone      |
| ------------------------------------------ | -------------------- |
| `{ "type": "ping", "msg_id": "ping_001" }` | `{ "type": "pong" }` |

---

## 🔉 Audio System JSON Commands

### Enable Microphone

Turn onboard microphone on or off.

#### 📲 Phone → Glasses

```json
{
  "type": "set_mic_state",
  "msg_id": "mic_001",
  "enabled": true
}
```

#### 👓 Glasses → Phone

*(none)*

---

### Enable or Disable VAD

Enable or disable Voice Activity Detection.

#### 📲 Phone → Glasses

```json
{
  "type": "set_vad_enabled",
  "msg_id": "vad_001",
  "enabled": true
}
```

#### 👓 Glasses → Phone

*(none)*

---

### Configure VAD Sensitivity

Adjust VAD sensitivity threshold (0–100).

#### 📲 Phone → Glasses

```json
{
  "type": "configure_vad",
  "msg_id": "vad_002",
  "sensitivity": 75
}
```

#### 👓 Glasses → Phone

*(none)*

---

---

### VAD Event Notification

Triggered when voice activity is detected or stops.

#### 👓 Glasses → Phone

```json
{
  "type": "vad_event",
  "state": "active"
}
```

---

## 🖥️ Display System JSON Commands

### Display Text

Show text at coordinates with size.

#### 📲 Phone → Glasses

```json
{
  "type": "display_text",
  "msg_id": "txt_001",
  "text": "Hello World",
  "color": "0xF800",
  "font_code": "0x11",
  "x": 10,
  "y": 20,
  "size": 2
}
```

#### 👓 Glasses → Phone

*(none)*

---

### Display Bitmap

Send a bitmap image to be rendered on the display.
This command uses the binary transfer protocol defined in the [🖼️ Image Transfer Format](#️-image-transfer-format) section.

#### 📲 Phone → Glasses (JSON Initiation)

```json
{
  "type": "display_image",
  "msg_id": "img_start_1",
  "stream_id": "002A",
  "x": 0,
  "y": 0,
  "width": 128,
  "height": 64,
  "encoding": "rle",
  "total_chunks": 9
}
```

#### 📲 Phone → Glasses (Binary Chunks)

```
[0xB0][stream_id_hi][stream_id_lo][chunk_index][chunk_data]
```

#### 👓 Glasses → Phone (Completion)

```json
{
  "type": "image_transfer_complete",
  "stream_id": "002A",
  "status": "ok"
}
```

Or if incomplete:

```json
{
  "type": "image_transfer_complete",
  "stream_id": "002A",
  "status": "incomplete",
  "missing_chunks": [3, 4, 6]
}
```

---

### Preload Bitmap

Preload an image into memory for later use. Uses same binary chunking as `display_image`, but with an image ID instead of direct display coordinates.

#### 📲 Phone → Glasses (JSON Initiation)

```json
{
  "type": "preload_image",
  "msg_id": "preload_01",
  "stream_id": "003B",
  "image_id": 42,
  "width": 128,
  "height": 64,
  "encoding": "rle",
  "total_chunks": 6
}
```

#### 📲 Phone → Glasses (Binary Chunks)

```
[0xB0][stream_id_hi][stream_id_lo][chunk_index][chunk_data]
```

#### 👓 Glasses → Phone (Completion)

```json
{
  "type": "image_transfer_complete",
  "stream_id": "003B",
  "status": "ok"
}
```

Or if incomplete:

```json
{
  "type": "image_transfer_complete",
  "stream_id": "003B",
  "status": "incomplete",
  "missing_chunks": [1, 2]
}
```

---

### Display Cached Bitmap

Display a previously cached bitmap image using its ID.

#### 📲 Phone → Glasses

```json
{
  "type": "display_cached_image",
  "msg_id": "disp_cache_01",
  "image_id": 42,
  "x": 10,
  "y": 20,
  "width": 128,
  "height": 64
}
```

#### 👓 Glasses → Phone

*(none)*

---

### Clear Cached Bitmap

Delete a cached bitmap image from memory.

#### 📲 Phone → Glasses

```json
{
  "type": "clear_cached_image",
  "msg_id": "clear_cache_01",
  "image_id": 42
}
```

#### 👓 Glasses → Phone

*(none)*

---

### Display Scrolling Text Box

Displays a scrolling text box

#### 📲 Phone → Glasses

```json
{
  "type": "display_vertical_scrolling_text",
  "msg_id": "vscroll_001",
  "text": "Line 1\nLine 2\nLine 3\nLine 4",
  "color": "0xF800",
  "font_code": "0x11",
  "x": 0,
  "y": 0,
  "width": 128,
  "height": 64,
  "align": "left",      // Or "center", "right"
  "line_spacing": 2,    // optional: pixels between lines
  "speed": 20,          // optional: pixels/sec (scrolling up)
  "size": 1,            // optional: font size multiplier
  "loop": false,        // optional: if true, wraps to top when finished
  "pause_ms": 1000,     // optional: delay (in ms) before restarting loop
}
```

#### 👓 Glasses → Phone

*(none)*

---

### Turn Off Display

Turns off the screen entirely.

#### 📲 Phone → Glasses

```json
{
  "type": "turn_off_display",
  "msg_id": "disp_off_001"
}
```

#### 👓 Glasses → Phone

*(none)*

---

### Turn On Display

Turns the display back on.

#### 📲 Phone → Glasses

```json
{
  "type": "turn_on_display",
  "msg_id": "disp_on_001"
}
```

#### 👓 Glasses → Phone

*(none)*

---

### Set Display Brightness

Sets display brightness to a value between 0–100.

#### 📲 Phone → Glasses

```json
{
  "type": "set_brightness",
  "msg_id": "bright_001",
  "value": 80
}
```

#### 👓 Glasses → Phone

*(none)*

---

### Enable or Disable Auto-Brightness

Enable or disable ambient-based brightness control.

#### 📲 Phone → Glasses

```json
{
  "type": "set_auto_brightness",
  "msg_id": "auto_bright_001",
  "enabled": true
}
```

#### 👓 Glasses → Phone

*(none)*

---

### Set Auto-Brightness Multiplier

Apply a multiplier to scale auto-brightness (e.g. 0.8 = 80%).

#### 📲 Phone → Glasses

```json
{
  "type": "set_auto_brightness_multiplier",
  "msg_id": "auto_bright_mult_001",
  "multiplier": 0.8
}
```

#### 👓 Glasses → Phone

*(none)*

---

### Draw Line

Draw a line on the screen.

#### 📲 Phone → Glasses

```json
{
  "type": "draw_line",
  "msg_id": "drawline_001",
  "color": "0xF800",
  "stroke": 1,
  "x1": 0,
  "y1": 0,
  "x2": 100,
  "y2": 50
}
```

#### 👓 Glasses → Phone

*(none)*

---

### Draw Rectangle

Draw a rectangle on the display.

#### 📲 Phone → Glasses

```json
{
  "type": "draw_rect",
  "msg_id": "rect_001",
  "color": "0xF800",
  "stroke": 1,
  "x": 10,
  "y": 10,
  "width": 60,
  "height": 40
}
```

#### 👓 Glasses → Phone

*(none)*

---

### Draw Circle

Draw a circle on the display.

#### 📲 Phone → Glasses

```json
{
  "type": "draw_circle",
  "msg_id": "circle_001",
  "color": "0xF800",
  "stroke": 1,
  "x": 64,
  "y": 32,
  "radius": 20
}
```

#### 👓 Glasses → Phone

*(none)*

---

### Commit

Apply all previous draw commands to the display in one atomic update.

#### 📲 Phone → Glasses

```json
{
  "type": "commit",
  "msg_id": "commit_001"
}
```

#### 👓 Glasses → Phone

*(none)*

---

### Set Display Distance

Update virtual projection distance used for display effects.

#### 📲 Phone → Glasses

```json
{
  "type": "set_display_distance",
  "msg_id": "dist_001",
  "distance_cm": 50
}
```

#### 👓 Glasses → Phone

*(none)*

---

### Set Display Height

Set vertical alignment or offset for display rendering.

#### 📲 Phone → Glasses

```json
{
  "type": "set_display_height",
  "msg_id": "height_001",
  "height": 120
}
```

#### 👓 Glasses → Phone

*(none)*

---

## 🎮 User Input (Button/IMU)

### Enable IMU

Phone requests the glasses to enable the onboard IMU.

#### 📲 Phone → Glasses

```json
{
  "type": "request_enable_imu",
  "msg_id": "imu_001",
  "enabled": true
}
```

* `gesture`: Type of gesture to listen for.
* `enabled`: `true` to enable IMU, `false` to disable.

---

### Get IMU Data Once

Phone requests the IMU data once.

#### 📲 Phone → Glasses

```json
{
  "type": "request_imu_single",
  "msg_id": "imu_001",
}
```

#### 👓 Glasses → Phone

```json
{
  "type": "imu_data",
  "msg_id": "imu_001",
  "accel": { "x": 0.02, "y": -9.81, "z": 0.15 },
  "gyro": { "x": 0.01, "y": 0.02, "z": 0.00 },
  "mag":  { "x": -10.2, "y": 2.1, "z": 41.9 }
}
```

---

### Request IMU Stream

Phone requests the glasses start streaming IMU data.

#### 📲 Phone → Glasses

```json
{
  "type": "request_imu_stream",
  "msg_id": "imu_stream_01",
  "enabled": true
}
```

Then, the glasses can emit:

#### 👓 Glasses → Phone

```json
{
  "type": "imu_data",
  "accel": { "x": 0.02, "y": -9.81, "z": 0.15 },
  "gyro": { "x": 0.01, "y": 0.02, "z": 0.00 },
  "mag":  { "x": -10.2, "y": 2.1, "z": 41.9 }
}
```

---

### Button Event

Triggered by hardware button press or release.

#### 👓 Glasses → Phone

```json
{
  "type": "button_event",
  "button": "center",
  "state": "down"
}
```

* `button`: `"center"`, `"left"`, `"right"`, etc. — based on physical layout.
* `state`: `"down"` or `"up"` — pressed or released.

---

### Emit Head Gesture Event

Triggered by head movement gesture recognition (e.g., nod or shake).

#### 👓 Glasses → Phone

```json
{
  "type": "head_gesture",
  "gesture": "head_up"
}
```

* `gesture`: One of `"nod"`, `"shake"`, `"head_up"`, etc.

---

### Request Head Gesture Listening

Phone requests the glasses to begin or stop listening for a particular gesture.

#### 📲 Phone → Glasses

```json
{
  "type": "request_head_gesture_event",
  "msg_id": "gesture_001",
  "gesture": "head_up",
  "enabled": true
}
```

* `gesture`: Type of gesture to listen for.
* `enabled`: `true` to start listening, `false` to stop.

---

## 🧰 System Control JSON Commands

### Restart Device

Reboot the glasses device.

#### 📲 Phone → Glasses

```json
{
  "type": "restart_device",
  "msg_id": "restart_001"
}
```

#### 👓 Glasses → Phone

*(none)*

---

### Factory Reset

Reset device to factory defaults. This clears all settings and cached data.

#### 📲 Phone → Glasses

```json
{
  "type": "factory_reset",
  "msg_id": "factory_001"
}
```

#### 👓 Glasses → Phone

*(none)*

---

###
