# ESP32-S3 BLE Glasses Simulator

This project simulates smart glasses that communicate with a mobile app using the MentraOS BLE protocol v2.0 (Protobuf).

## Features

- **Full Protobuf Support**: Handles MentraOS BLE v2.0 protocol with protobuf messages
- **Bidirectional Communication**: Phone → Glasses and Glasses → Phone
- **Multiple Message Types**: 
  - Device info requests/responses
  - Battery status monitoring
  - Ping/Pong heartbeat
  - Display commands (text, images)
  - Audio streaming support
  - Image chunk transfer support
- **Automatic Reconnection**: Restarts advertising when client disconnects
- **Simulated Sensor Data**: Periodic battery level updates and heartbeats

## Protocol Support

The simulator implements the MentraOS BLE Packet Format v2.0:

- **Control Header 0x02**: Protobuf messages
- **Control Header 0xA0**: Audio chunks
- **Control Header 0xB0**: Image chunks

## Supported Protobuf Messages

### Phone → Glasses (Incoming)
- `GlassesInfoRequest` → Returns device capabilities
- `BatteryStateRequest` → Returns current battery level
- `PingRequest` → Returns pong response
- `DisplayText` → Simulates text display
- `DisplayImage` → Prepares for image transfer

### Glasses → Phone (Outgoing)
- `DeviceInfo` with full feature set
- `BatteryStatus` with current level and charging state
- `PongResponse` for heartbeat
- Periodic status updates

## Hardware Requirements

- ESP32-S3 development board
- USB cable for programming and serial monitoring

## Software Requirements

- PlatformIO (recommended) or Arduino IDE
- ESP32 board support

## Quick Start

### Using PlatformIO (Recommended)

1. Install PlatformIO extension in VS Code
2. Open this folder in VS Code
3. Build and upload:
   ```bash
   pio run --target upload
   ```
4. Monitor serial output:
   ```bash
   pio device monitor
   ```

### Using Arduino IDE

1. Install ESP32 board support in Arduino IDE
2. Install required libraries:
   - ESP32 BLE Arduino library (built-in)
3. Open `esp32s3_ble_glasses_sim_bidirectional.ino`
4. Select board: "ESP32S3 Dev Module"
5. Upload and open Serial Monitor (115200 baud)

## Testing with Mobile App

1. Upload the code to your ESP32-S3
2. The device will advertise as "MentraGlassesSim"
3. Connect from your MentraOS mobile app
4. The simulator will respond to:
   - Device info queries
   - Battery status requests
   - Ping requests
   - Display commands
   - Image/audio streaming

## Serial Output Example

```
Starting BLE Smart Glasses Simulator (bidirectional)...
Protocol: MentraOS BLE v2.0 (Protobuf)
BLE GATT service started. Waiting for connection...
Service UUID: 00004860-0000-1000-8000-00805f9b34fb
Device name: MentraGlassesSim

[ESP32-S3] Client connected!

[ESP32-S3] Received BLE data:
0x02 0x0A 0x00 0x62 0x00 

[ESP32-S3] Protobuf message detected
[ESP32-S3] Detected GlassesInfoRequest - sending DeviceInfo
```

## Configuration

You can modify the simulated device characteristics in the code:

- **Battery Level**: Initial level and drain rate
- **Device Info**: Firmware version, hardware model, feature flags
- **Heartbeat Interval**: How often to send periodic updates

## Protocol Details

See the documentation in `mcu_client/` folder:
- `mentraos_ble.proto` - Protobuf message definitions
- `firmware_spec_protobuf.md` - Complete protocol specification
- `firmware_spec.md` - Legacy JSON protocol (not used)

## Troubleshooting

1. **Connection Issues**: Make sure the ESP32-S3 is properly powered and the serial monitor shows "BLE GATT service started"
2. **Build Errors**: Ensure PlatformIO or Arduino IDE has ESP32 support installed
3. **No Response**: Check that the mobile app is using the correct service UUID and characteristics
4. **Memory Issues**: The ESP32-S3 has plenty of RAM for this application, but if you add more features, monitor heap usage

## Development Notes

This simulator uses pre-encoded protobuf responses for simplicity. In a production environment, you would:

1. Use a proper protobuf library (like nanopb) for encoding/decoding
2. Implement actual hardware interfaces (display, IMU, microphone, etc.)
3. Add proper error handling and state management
4. Implement secure pairing and authentication

The current implementation focuses on protocol compatibility and is perfect for testing mobile app integration without requiring actual smart glasses hardware.
