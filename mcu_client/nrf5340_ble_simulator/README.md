# nRF5340 DK BLE Glasses Protobuf Simulator (Bidirectional)

## Overview

This project is a **nRF5340 DK** port of the ESP32-C3 BLE glasses simulator, designed to simulate MentraOS smart glasses functionality for development and testing purposes. It provides a comprehensive BLE GATT server that implements the MentraOS protobuf protocol specification, enabling bidirectional communication between a phone app and simulated glasses.

## Key Features

### 🔗 **Custom BLE Service**
- **Service UUID**: `00004860-0000-1000-8000-00805f9b34fb`
- **TX Characteristic**: `000071FF-0000-1000-8000-00805f9b34fb` (Phone → Glasses)
- **RX Characteristic**: `000070FF-0000-1000-8000-00805f9b34fb` (Glasses → Phone)
- Compatible with existing ESP32-C3 BLE clients and test scripts

### �� **Protocol Support**
- **Protobuf Messages** (Header: `0x02`) - Control commands and responses
- **Audio Chunks** (Header: `0xA0`) - LC3 audio streaming simulation
- **Image Chunks** (Header: `0xB0`) - Image transfer simulation
- Real-time message analysis and detailed logging
- Echo response generation for testing

### 🏷️ **Dynamic Device Naming**
- Device appears as `NexSim XXXXXX` (where XXXXXX is MAC address suffix)
- Matches ESP32-C3 naming convention for seamless integration

### 🔍 **Advanced Debugging**
- Comprehensive hex dump logging
- Message type detection and parsing
- ASCII representation of received data
- Protocol-aware analysis (protobuf field detection)

## Hardware Requirements

- **nRF5340 DK** (PCA10095)
- USB-C cable for power and programming
- Computer with nRF Connect SDK installed

## Software Requirements

- **nRF Connect SDK** v2.4.0 or later
- **nRF Connect for VS Code** extension
- **Segger J-Link** tools (included with nRF Connect SDK)
- **Python 3.8+** (for testing scripts)

## Project Structure

```
nrf5340dk_ble_glasses_protobuf_simulator_bidirectional/
├── CMakeLists.txt                 # Build configuration
├── prj.conf                      # Project configuration
├── README.md                     # This file
├── src/
│   ├── main.c                    # Main application logic
│   ├── mentra_ble_service.c      # Custom BLE service implementation
│   ├── mentra_ble_service.h      # BLE service header
│   ├── protobuf_handler.c        # Protocol message analysis
│   └── protobuf_handler.h        # Protocol handler header
└── boards/                       # Board-specific configurations
```

## Building and Flashing

### 1. Open in nRF Connect for VS Code
```bash
# Open the project folder in VS Code with nRF Connect extension
code nrf5340dk_ble_glasses_protobuf_simulator_bidirectional/
```

### 2. Build the Project
- Press `Ctrl+Shift+P` (Windows/Linux) or `Cmd+Shift+P` (macOS)
- Type "nRF Connect: Build"
- Select the nRF5340 DK board (`nrf5340dk_nrf5340_cpuapp`)

### 3. Flash to Device
- Connect nRF5340 DK via USB
- Press `Ctrl+Shift+P` and type "nRF Connect: Flash"
- The device will be programmed automatically

### 4. Monitor Output
- Use "nRF Connect: Start RTT Viewer" to see real-time logs
- Or use a serial terminal at 115200 baud

## Testing

### BLE Scanner Apps
Use any BLE scanner app to verify the device is advertising:
- **nRF Connect** (iOS/Android)
- **LightBlue** (iOS/macOS)
- **BLE Scanner** (Android)

Look for device named: `NexSim XXXXXX`

### Python Test Scripts
Use the existing ESP32-C3 test scripts from the parent project:

```bash
# From the esp32s3_ble_glasses_sim_bidirectional folder
python ble_scanner.py              # Scan for NexSim device
python service_scanner.py          # Examine BLE services
python phone_ble_simulator.py      # Full bidirectional testing
python direct_connect_test.py      # Direct protobuf testing
```

## Expected Behavior

### On Startup
```
[00:00:01.000] Starting advertising with:
[00:00:01.001]   Device name: NexSim A1B2C3
[00:00:01.002]   Service UUID: 00004860-0000-1000-8000-00805f9b34fb
[00:00:01.003] Advertising successfully started
```

### On BLE Connection
```
[00:00:05.123] *** CLIENT CONNECTED! ***
[00:00:05.124] Connection established successfully
```

### On Data Reception
```
[00:00:10.456] === BLE DATA RECEIVED ===
[00:00:10.457] Received BLE data (15 bytes):
[00:00:10.458] 0x02 0x0D 0x0A 0x08 0x70 0x69 0x6E 0x67 0x5F 0x30 0x30 0x31 0x10 0x01
[00:00:10.459] [PROTOBUF] Control header detected: 0x02 (Protobuf message)
[00:00:10.460] [ASCII] Raw string: "..ping_001.."
[00:00:10.461] Generated echo response: Echo: Received 15 bytes
[00:00:10.462] === END BLE DATA ===
```

## Key Differences from ESP32-C3 Version

| Aspect | ESP32-C3 | nRF5340 DK |
|--------|----------|------------|
| **Framework** | Arduino/ESP-IDF | Zephyr RTOS |
| **BLE Stack** | ESP32 BLE | Nordic SoftDevice |
| **Logging** | Serial.println() | Zephyr LOG_* macros |
| **Memory** | 400KB RAM | 512KB RAM |
| **Performance** | Single core | Dual core ARM Cortex-M33 |
| **Power** | Good | Excellent |
| **Debugging** | Basic | Advanced (RTT, J-Link) |

## Troubleshooting

### Device Not Advertising
- Check RTT logs for advertising start messages
- Verify BLE is enabled in `prj.conf`
- Ensure proper build for `nrf5340dk_nrf5340_cpuapp`

### Connection Issues
- Verify service UUID matches client expectations
- Check characteristic permissions and properties
- Monitor RTT logs for connection events

### Build Errors
- Ensure nRF Connect SDK is properly installed
- Check that all required Kconfig options are enabled
- Verify board target is correct

## Protocol Specification

This implementation follows the **MentraOS BLE Packet Format Specification v2.0**:

- **Service UUID**: `00004860-0000-1000-8000-00805f9b34fb`
- **Control Messages**: Start with `0x02` + protobuf data
- **Audio Streaming**: Start with `0xA0` + stream_id + LC3 data  
- **Image Transfer**: Start with `0xB0` + stream_id + chunk_index + data

For complete protocol details, see: `../esp32s3_ble_glasses_sim_bidirectional/mcu_client/firmware_spec_protobuf.md`

## Contributing

When modifying this project:

1. **Test thoroughly** with both BLE scanner apps and Python scripts
2. **Maintain compatibility** with existing ESP32-C3 clients
3. **Update documentation** if adding new features
4. **Follow Zephyr coding standards** for consistency

## License

```
Copyright (c) 2024 Mentra
SPDX-License-Identifier: Apache-2.0
```

This project is part of the MentraOS development ecosystem and is intended for development and testing purposes.
