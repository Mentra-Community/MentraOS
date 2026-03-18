# 📦 MentraOS BLE Packet Format Specification - Protobuf Version (v2.0)

## 🔑 Overview

This specification defines the binary packet format and transport protocol for communication between the MentraOS App (on a phone) and smart glasses via Bluetooth Low Energy (BLE). It uses Protocol Buffers (protobuf) for all control messages and supports high-speed binary data transfers like audio and image streams.

- All messages are sent over **standard BLE characteristics (GATT)**.
- Every BLE packet starts with a **1-byte control header**.
- The control header byte indicates the type of payload.

Protobuf advantages:

- **5-10x smaller** message sizes compared to JSON
- **Forward/backward compatibility** for firmware updates
- **Type safety** and automatic validation
- **Efficient parsing** on resource-constrained MCUs

Binary streaming (audio/images) continues to use raw byte protocol for maximum efficiency.

---

## 🔐 GATT Service & Characteristic Definitions

| Role    | UUID                                   | Description                          |
| ------- | -------------------------------------- | ------------------------------------ |
| Service | `00004860-0000-1000-8000-00805f9b34fb` | MentraOS BLE Service                 |
| TX Char | `000071FF-0000-1000-8000-00805f9b34fb` | Phone (central) → Glasses (write)    |
| RX Char | `000070FF-0000-1000-8000-00805f9b34fb` | Glasses → Phone (notify or indicate) |
| CCCD    | `00002902-0000-1000-8000-00805f9b34fb` | Enable notify on RX Char             |

- The phone acts as **GATT central**, the glasses are **GATT peripheral**.
- Glasses send **notifications** on the RX characteristic.

---

## 🔠 Packet Types

| Control Header Byte | Type             | Payload Format                                                |
| ------------------- | ---------------- | ------------------------------------------------------------- |
| `0x02`              | Protobuf message | Protobuf-encoded control message                              |
| `0xA0`              | Audio chunk      | `[A0][stream_id (1 byte)][LC3 frame data]`                    |
| `0xB0`              | Image chunk      | `[B0][stream_id (2 bytes)][chunk_index (1 byte)][chunk_data]` |
| `0xD0`–`0xFF`       | Reserved         | —                                                             |

---

## 📄 Protobuf Message Format

All protobuf control messages must begin with `0x02`, followed by protobuf-encoded bytes.

### Example:

```
[0x02][protobuf encoded bytes]
```

No length header is needed; BLE characteristic defines packet length.

---

## 🔊 Audio Chunk Format

```
[0xA0][stream_id (1 byte)][LC3 frame data]
```

- `stream_id`: allows multiple audio streams (e.g., mic vs TTS)
- Frame size determined by LC3 codec settings and MTU

---

## 📊 Size Comparison Example

### Device Info Response

**JSON (246 bytes):**

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

**Protobuf (~35 bytes):**

```
[0x02][protobuf bytes: fw_version="1.2.3" hw_model="MentraLive" features{...}]
```

---

## 🖼️ Image Transfer Protocol

Image transfers use a hybrid approach: protobuf for control, binary for data.

### 1. Initiate Transfer (Protobuf)

```
[0x02][PhoneToGlasses { display_image {
  stream_id: "002A"
  x: 0
  y: 0
  width: 128
  height: 64
  encoding: "webp"  // Supported: "webp", "rle", "raw"
  total_chunks: 9
}}]
```

### 2. Send Binary Chunks

```
[0xB0][0x00][0x2A][0x00][chunk_data...]  // chunk 0
[0xB0][0x00][0x2A][0x01][chunk_data...]  // chunk 1
...
[0xB0][0x00][0x2A][0x08][chunk_data...]  // chunk 8
```

- `stream_id`: Same as in protobuf message, 2 bytes
- `chunk_index`: 0–255
- `chunk_data`: Raw image bytes (size ≤ MTU-4)

### 3. Receive Completion (Protobuf)

```
[0x02][GlassesToPhone { image_transfer_complete {
  stream_id: "002A"
  status: OK
}}]
```

Or if incomplete:

```
[0x02][GlassesToPhone { image_transfer_complete {
  stream_id: "002A"
  status: INCOMPLETE
  missing_chunks: [3, 4, 6]
}}]
```

### 4. Optional Retry

If any image chunks are missing (as indicated in the `missing_chunks` list from the receiver), the sender may retry those chunks individually:

```text
[0xB0][0x00][0x2A][0x03][...]  // Retry chunk 3
[0xB0][0x00][0x2A][0x04][...]  // Retry chunk 4
[0xB0][0x00][0x2A][0x06][...]  // Retry chunk 6
```

This can be repeated until all chunks are acknowledged or a timeout is reached.

---

## 🔊 Audio Streaming Protocol

Audio uses the same hybrid approach.

### 1. Configure Audio (Protobuf)

```
[0x02][PhoneToGlasses { mic_state { enabled: true }}]
```

### 2. Stream LC3 Audio (Binary)

```
[0xA0][0x01][LC3 frame data...]  // stream_id = 0x01 for microphone
[0xA0][0x01][LC3 frame data...]
[0xA0][0x01][LC3 frame data...]
```

- Frame size determined by LC3 codec settings and MTU
- Stream continuously while mic is enabled

---

## 📀 Connection Management Commands

All commands and responses use protobuf messages starting with `0x02` header.

### Disconnect

Terminate connection and clean up resources.

| Phone → Glasses                                               | Glasses → Phone |
| ------------------------------------------------------------- | --------------- |
| `[0x02][PhoneToGlasses { disconnect { msg_id: "disc_001" }}]` | _(none)_        |

---

### Get Battery Level

Report current battery percentage, and whether charging now or not.

| Phone → Glasses                                                            | Glasses → Phone                                                           |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `[0x02][PhoneToGlasses { request_battery_state { msg_id: "battery123" }}]` | `[0x02][GlassesToPhone { battery_status { level: 82, charging: false }}]` |

---

### Charging State Changed Event

Emitted when glasses detect they are charging.

| Phone → Glasses | Glasses → Phone                                                |
| --------------- | -------------------------------------------------------------- |
| _(none)_        | `[0x02][GlassesToPhone { charging_state { state: CHARGING }}]` |

---

### Get Glasses Info

Query all available runtime capabilities from the glasses, including hardware features, firmware version, display resolution, and supported sensors/audio.

#### 📲 Phone → Glasses

```
[0x02][PhoneToGlasses { request_glasses_info { msg_id: "info_22" }}]
```

#### 👓 Glasses → Phone

```
[0x02][GlassesToPhone { device_info {
  fw_version: "1.2.3"
  hw_model: "MentraLive"
  features {
    camera: true
    display: true
    audio_tx: true
    audio_rx: false
    imu: true
    vad: true
    mic_switching: true
    image_chunk_buffer: 12
  }
}}]
```

---

### Enter Pairing State

Force glasses into pairing mode. This may also happen automatically on boot if no phone has previously been paired.

| Phone → Glasses                                                       | Glasses → Phone |
| --------------------------------------------------------------------- | --------------- |
| `[0x02][PhoneToGlasses { enter_pairing_mode { msg_id: "pair_001" }}]` | _(none)_        |

---

### Get Head Position

Report the wearer's current head tilt angle in degrees.

| Phone → Glasses                                                          | Glasses → Phone                                         |
| ------------------------------------------------------------------------ | ------------------------------------------------------- |
| `[0x02][PhoneToGlasses { request_head_position { msg_id: "head_001" }}]` | `[0x02][GlassesToPhone { head_position { angle: 15 }}]` |

---

### Set Head-Up Angle Threshold

Configure the head-up detection angle (in degrees).

| Phone → Glasses                                                                  | Glasses → Phone                                                 |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `[0x02][PhoneToGlasses { set_head_up_angle { msg_id: "angle_001", angle: 20 }}]` | `[0x02][GlassesToPhone { head_up_angle_set { success: true }}]` |

---

### Heartbeat / Ping

Verify that connection is still alive.

| Phone → Glasses                                         | Glasses → Phone                       |
| ------------------------------------------------------- | ------------------------------------- |
| `[0x02][PhoneToGlasses { ping { msg_id: "ping_001" }}]` | `[0x02][GlassesToPhone { pong {} }}]` |

---

## 🔉 Audio System Commands

### Enable Microphone

Turn onboard microphone on or off.

#### 📲 Phone → Glasses

```
[0x02][PhoneToGlasses { set_mic_state { msg_id: "mic_001", enabled: true }}]
```

#### 👓 Glasses → Phone

_(none)_

---

### Enable or Disable VAD

Enable or disable Voice Activity Detection.

#### 📲 Phone → Glasses

```
[0x02][PhoneToGlasses { set_vad_enabled { msg_id: "vad_001", enabled: true }}]
```

#### 👓 Glasses → Phone

_(none)_

---

### Configure VAD Sensitivity

Adjust VAD sensitivity threshold (0–100).

#### 📲 Phone → Glasses

```
[0x02][PhoneToGlasses { configure_vad { msg_id: "vad_002", sensitivity: 75 }}]
```

#### 👓 Glasses → Phone

_(none)_

---

### VAD Event Notification

Triggered when voice activity is detected or stops.

#### 👓 Glasses → Phone

```
[0x02][GlassesToPhone { vad_event { state: ACTIVE }}]
```

---

## 🖥️ Display System Commands

### Display Text

Show text at coordinates with size.

#### 📲 Phone → Glasses

```
[0x02][PhoneToGlasses { display_text {
  msg_id: "txt_001"
  text: "Hello World"
  color: 0xF800  // 16-bit RGB565
  font_code: 0x11
  x: 10
  y: 20
  size: 2
}}]
```

#### 👓 Glasses → Phone

_(none)_

---

### Display Bitmap

Send a bitmap image to be rendered on the display.
This command uses the binary transfer protocol defined in the [🖼️ Image Transfer Protocol](#️-image-transfer-protocol) section.

#### 📲 Phone → Glasses (Protobuf Initiation)

```
[0x02][PhoneToGlasses { display_image {
  msg_id: "img_start_1"
  stream_id: "002A"
  x: 0
  y: 0
  width: 128
  height: 64
  encoding: "rle"  // Options: "raw", "rle", "webp"
  total_chunks: 9
}}]
```

#### 📲 Phone → Glasses (Binary Chunks)

```
[0xB0][stream_id_hi][stream_id_lo][chunk_index][chunk_data]
```

#### 👓 Glasses → Phone (Completion)

```
[0x02][GlassesToPhone { image_transfer_complete {
  stream_id: "002A"
  status: OK
}}]
```

Or if incomplete:

```
[0x02][GlassesToPhone { image_transfer_complete {
  stream_id: "002A"
  status: INCOMPLETE
  missing_chunks: [3, 4, 6]
}}]
```

---

### Preload Bitmap

Preload an image into memory for later use. Uses same binary chunking as `display_image`, but with an image ID instead of direct display coordinates.

#### 📲 Phone → Glasses (Protobuf Initiation)

```
[0x02][PhoneToGlasses { preload_image {
  msg_id: "preload_01"
  stream_id: "003B"
  image_id: 42
  width: 128
  height: 64
  encoding: "rle"
  total_chunks: 6
}}]
```

#### 📲 Phone → Glasses (Binary Chunks)

```
[0xB0][stream_id_hi][stream_id_lo][chunk_index][chunk_data]
```

#### 👓 Glasses → Phone (Completion)

```
[0x02][GlassesToPhone { image_transfer_complete {
  stream_id: "003B"
  status: OK
}}]
```

Or if incomplete:

```
[0x02][GlassesToPhone { image_transfer_complete {
  stream_id: "003B"
  status: INCOMPLETE
  missing_chunks: [1, 2]
}}]
```

---

### Display Cached Bitmap

Display a previously cached bitmap image using its ID.

#### 📲 Phone → Glasses

```
[0x02][PhoneToGlasses { display_cached_image {
  msg_id: "disp_cache_01"
  image_id: 42
  x: 10
  y: 20
  width: 128
  height: 64
}}]
```

#### 👓 Glasses → Phone

_(none)_

---

### Clear Cached Bitmap

Delete a cached bitmap image from memory.

#### 📲 Phone → Glasses

```
[0x02][PhoneToGlasses { clear_cached_image {
  msg_id: "clear_cache_01"
  image_id: 42
}}]
```

#### 👓 Glasses → Phone

_(none)_

---

### Display Scrolling Text Box

Displays a scrolling text box with configurable parameters.

#### 📲 Phone → Glasses

```
[0x02][PhoneToGlasses { display_vertical_scrolling_text {
  msg_id: "vscroll_001"
  text: "Line 1\nLine 2\nLine 3\nLine 4"
  color: 0xF800
  font_code: 0x11
  x: 0
  y: 0
  width: 128
  height: 64
  align: LEFT      // Options: LEFT, CENTER, RIGHT
  line_spacing: 2  // Optional: pixels between lines (default: 0)
  speed: 20        // Optional: pixels/sec scrolling up (default: 10)
  size: 1          // Optional: font size multiplier (default: 1)
  loop: false      // Optional: wraps to top when finished (default: false)
  pause_ms: 1000   // Optional: delay in ms before restarting loop (default: 0)
}}]
```

#### 👓 Glasses → Phone

_(none)_

---

### Turn Off Display

Turns off the screen entirely.

#### 📲 Phone → Glasses

```
[0x02][PhoneToGlasses { turn_off_display { msg_id: "disp_off_001" }}]
```

#### 👓 Glasses → Phone

_(none)_

---

### Turn On Display

Turns the display back on.

#### 📲 Phone → Glasses

```
[0x02][PhoneToGlasses { turn_on_display { msg_id: "disp_on_001" }}]
```

#### 👓 Glasses → Phone

_(none)_

---

### Set Display Brightness

Sets display brightness to a value between 0–100.

#### 📲 Phone → Glasses

```
[0x02][PhoneToGlasses { set_brightness { msg_id: "bright_001", value: 80 }}]
```

#### 👓 Glasses → Phone

_(none)_

---

### Enable or Disable Auto-Brightness

Enable or disable ambient-based brightness control.

#### 📲 Phone → Glasses

```
[0x02][PhoneToGlasses { set_auto_brightness { msg_id: "auto_bright_001", enabled: true }}]
```

#### 👓 Glasses → Phone

_(none)_

---

### Set Auto-Brightness Multiplier

Apply a multiplier to scale auto-brightness (e.g. 0.8 = 80%).

#### 📲 Phone → Glasses

```
[0x02][PhoneToGlasses { set_auto_brightness_multiplier {
  msg_id: "auto_bright_mult_001",
  multiplier: 0.8
}}]
```

#### 👓 Glasses → Phone

_(none)_

---

### Draw Line

Draw a line on the screen.

#### 📲 Phone → Glasses

```
[0x02][PhoneToGlasses { draw_line {
  msg_id: "drawline_001"
  color: 0xF800
  stroke: 1
  x1: 0
  y1: 0
  x2: 100
  y2: 50
}}]
```

#### 👓 Glasses → Phone

_(none)_

---

### Draw Rectangle

Draw a rectangle on the display.

#### 📲 Phone → Glasses

```
[0x02][PhoneToGlasses { draw_rect {
  msg_id: "rect_001"
  color: 0xF800
  stroke: 1
  x: 10
  y: 10
  width: 60
  height: 40
}}]
```

#### 👓 Glasses → Phone

_(none)_

---

### Draw Circle

Draw a circle on the display.

#### 📲 Phone → Glasses

```
[0x02][PhoneToGlasses { draw_circle {
  msg_id: "circle_001"
  color: 0xF800
  stroke: 1
  x: 64      // Center X
  y: 32      // Center Y
  radius: 20
}}]
```

#### 👓 Glasses → Phone

_(none)_

---

### Commit

Apply all previous draw commands to the display in one atomic update.

#### 📲 Phone → Glasses

```
[0x02][PhoneToGlasses { commit { msg_id: "commit_001" }}]
```

#### 👓 Glasses → Phone

_(none)_

---

### Set Display Distance

Update virtual projection distance used for display effects.

#### 📲 Phone → Glasses

```
[0x02][PhoneToGlasses { set_display_distance {
  msg_id: "dist_001",
  distance_cm: 50
}}]
```

#### 👓 Glasses → Phone

_(none)_

---

### Set Display Height

Set vertical alignment or offset for display rendering.

#### 📲 Phone → Glasses

```
[0x02][PhoneToGlasses { set_display_height {
  msg_id: "height_001",
  height: 120
}}]
```

#### 👓 Glasses → Phone

_(none)_

---

## 🎮 User Input (Button/IMU)

### Enable IMU

Phone requests the glasses to enable the onboard IMU.

#### 📲 Phone → Glasses

```
[0x02][PhoneToGlasses { request_enable_imu {
  msg_id: "imu_001",
  enabled: true
}}]
```

- `enabled`: `true` to enable IMU, `false` to disable.

---

### Get IMU Data Once

Phone requests the IMU data once.

#### 📲 Phone → Glasses

```
[0x02][PhoneToGlasses { request_imu_single { msg_id: "imu_001" }}]
```

#### 👓 Glasses → Phone

```
[0x02][GlassesToPhone { imu_data {
  msg_id: "imu_001"
  accel { x: 0.02, y: -9.81, z: 0.15 }
  gyro { x: 0.01, y: 0.02, z: 0.00 }
  mag { x: -10.2, y: 2.1, z: 41.9 }
}}]
```

---

### Request IMU Stream

Phone requests the glasses start streaming IMU data.

#### 📲 Phone → Glasses

```
[0x02][PhoneToGlasses { request_imu_stream {
  msg_id: "imu_stream_01",
  enabled: true
}}]
```

Then, the glasses can emit:

#### 👓 Glasses → Phone

```
[0x02][GlassesToPhone { imu_data {
  accel { x: 0.02, y: -9.81, z: 0.15 }
  gyro { x: 0.01, y: 0.02, z: 0.00 }
  mag { x: -10.2, y: 2.1, z: 41.9 }
}}]
```

---

### Button Event

Triggered by hardware button press or release.

#### 👓 Glasses → Phone

```
[0x02][GlassesToPhone { button_event {
  button: CENTER  // Options: CENTER, LEFT, RIGHT
  state: DOWN     // Options: DOWN, UP
}}]
```

- `button`: Based on physical layout.
- `state`: Pressed (`DOWN`) or released (`UP`).

---

### Emit Head Gesture Event

Triggered by head movement gesture recognition (e.g., nod or shake).

#### 👓 Glasses → Phone

```
[0x02][GlassesToPhone { head_gesture {
  gesture: HEAD_UP  // Options: NOD, SHAKE, HEAD_UP
}}]
```

---

### Request Head Gesture Listening

Phone requests the glasses to begin or stop listening for a particular gesture.

#### 📲 Phone → Glasses

```
[0x02][PhoneToGlasses { request_head_gesture_event {
  msg_id: "gesture_001"
  gesture: HEAD_UP  // Options: NOD, SHAKE, HEAD_UP
  enabled: true
}}]
```

- `gesture`: Type of gesture to listen for.
- `enabled`: `true` to start listening, `false` to stop.

---

## 🧰 System Control Commands

### Restart Device

Reboot the glasses device.

#### 📲 Phone → Glasses

```
[0x02][PhoneToGlasses { restart_device { msg_id: "restart_001" }}]
```

#### 👓 Glasses → Phone

_(none)_

---

### Factory Reset

Reset device to factory defaults. This clears all settings and cached data.

#### 📲 Phone → Glasses

```
[0x02][PhoneToGlasses { factory_reset { msg_id: "factory_001" }}]
```

#### 👓 Glasses → Phone

_(none)_

---

## 💾 MCU Implementation Notes

### Recommended Protobuf Library

- **nanopb**: ~10KB footprint, perfect for MCUs
- Static memory allocation
- No dynamic memory required

### Example MCU Code

```c
// Receive and parse protobuf message
uint8_t buffer[256];
uint16_t len = ble_read_characteristic(buffer, sizeof(buffer));

if (buffer[0] == 0x02) {  // Protobuf message
    PhoneToGlasses msg = PhoneToGlasses_init_zero;
    pb_istream_t stream = pb_istream_from_buffer(buffer + 1, len - 1);

    if (pb_decode(&stream, PhoneToGlasses_fields, &msg)) {
        // Handle message based on which field is set
        if (msg.has_display_text) {
            display_text(msg.display_text.text,
                        msg.display_text.x,
                        msg.display_text.y);
        }
    }
}
```

### Error Handling

1. **Invalid Message Format**: If protobuf decode fails, ignore message
2. **Unknown Fields**: Forward compatibility - ignore unknown fields
3. **Resource Constraints**: Return error status for operations that exceed memory/display limits
4. **Timeout Handling**:
   - Image transfers: 5 second timeout per chunk
   - Command responses: 1 second timeout
5. **Connection Loss**: Clean up all pending operations and reset state

---

## 🚀 Benefits Over JSON

1. **Size**: 35 bytes vs 246 bytes (7x reduction)
2. **Speed**: Binary parsing is much faster than JSON
3. **Memory**: No string allocation or parsing buffers needed
4. **Evolution**: Add new fields without breaking old firmware
5. **Validation**: Type checking at compile time

## 📈 Performance Considerations

### MTU and Packet Sizes

- Standard BLE MTU: 23 bytes (20 bytes payload)
- Extended MTU (negotiated): Up to 512 bytes
- Image chunks should be sized to fit within negotiated MTU minus headers
- Audio frames must fit within single packet

### Timing Requirements

- Audio streaming: 10ms frame intervals for LC3
- Display updates: <50ms latency for responsive UI
- IMU streaming: Configurable 10-100Hz
- Command acknowledgments: Within 1 second

### Buffer Management

- Image chunk buffer: Typically 12 chunks (configurable)
- Audio buffer: 3-5 frames for jitter handling
- Command queue: Support at least 10 pending commands

---

## 📝 Protobuf Schema

See `mentraos_ble.proto` for the complete message definitions. Key design principles:

- **Field numbers never change** (for compatibility)
- **Optional fields** for backward compatibility
- **Enums** for type safety
- **Oneof** for message type discrimination
- **Repeated fields** for arrays (like missing_chunks)

### Message Structure Example

```protobuf
message PhoneToGlasses {
  oneof message {
    DisplayText display_text = 1;
    DisplayImage display_image = 2;
    SetMicState set_mic_state = 3;
    // ... other message types
  }
}

message DisplayText {
  string msg_id = 1;
  string text = 2;
  uint32 color = 3;     // RGB565 format
  uint32 font_code = 4;
  int32 x = 5;
  int32 y = 6;
  uint32 size = 7;      // Font size multiplier
}
```

## 🔐 Security Considerations

1. **Authentication**: Implement pairing/bonding at BLE level
2. **Encryption**: Use BLE encryption for all characteristics
3. **Message Validation**: Validate all input parameters
4. **Resource Limits**: Enforce maximum sizes for strings, arrays
5. **Rate Limiting**: Prevent DoS via excessive commands

This approach gives us the efficiency needed for MCU deployment while maintaining the flexibility and safety of a proper protocol definition.
