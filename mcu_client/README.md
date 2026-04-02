# MentraOS MCU Client Development

This folder contains firmware implementations and testing tools for MentraOS smart glasses communication protocols. It includes BLE simulators for different microcontroller platforms and Python-based testing utilities.

## 📁 Directory Structure

```
mcu_client/
├── esp32_ble_simulator/           # ESP32-S3 BLE glasses simulator
├── nrf5340_ble_simulator/         # nRF5340 DK BLE glasses simulator  
├── python_simulators/             # Python BLE testing scripts
├── nrf5340/                       # Production nRF5340 firmware (existing)
├── firmware_spec.md               # BLE protocol specification (JSON)
├── firmware_spec_protobuf.md      # BLE protocol specification (Protobuf v2.0)
├── mentraos_ble.proto             # Protocol Buffers definitions
└── ANDROID_FIRMWARE_GUIDE.md     # Android integration guide
```

## �� Projects Overview

### ESP32 BLE Simulator
**Path**: `esp32_ble_simulator/`
- **Platform**: ESP32-S3 with Arduino framework
- **Purpose**: Rapid prototyping and testing of BLE protocols
- **Features**: Real-time protobuf message analysis, echo responses
- **IDE**: PlatformIO/Arduino IDE

### nRF5340 BLE Simulator  
**Path**: `nrf5340_ble_simulator/`
- **Platform**: nRF5340 DK with nRF Connect SDK
- **Purpose**: Production-ready BLE implementation
- **Features**: Advanced debugging, professional BLE stack
- **IDE**: nRF Connect for VS Code

### Python Simulators
**Path**: `python_simulators/`
- **Purpose**: Cross-platform BLE testing and validation
- **Features**: Device scanning, service discovery, protocol testing
- **Usage**: Compatible with both ESP32 and nRF5340 simulators

## 🚀 Quick Start

### 1. ESP32 Development
```bash
cd esp32_ble_simulator/
# Open in PlatformIO or Arduino IDE
# Upload to ESP32-S3 board
```

### 2. nRF5340 Development  
```bash
cd nrf5340_ble_simulator/
# Open in nRF Connect for VS Code
# Build and flash to nRF5340 DK
```

### 3. Python Testing
```bash
cd python_simulators/
pip install -r requirements.txt
python ble_scanner.py              # Scan for devices
python phone_ble_simulator.py      # Full protocol testing
```

## 📋 Protocol Support

Both simulators implement the **MentraOS BLE Protocol v2.0**:

- **Service UUID**: `00004860-0000-1000-8000-00805f9b34fb`
- **TX Characteristic**: `000071FF-0000-1000-8000-00805f9b34fb` (Phone → Glasses)  
- **RX Characteristic**: `000070FF-0000-1000-8000-00805f9b34fb` (Glasses → Phone)

### Message Types
- **0x02**: Protobuf control messages
- **0xA0**: Audio streaming (LC3)
- **0xB0**: Image transfer chunks

## 🔧 Development Workflow

1. **Prototype** with ESP32 simulator for rapid iteration
2. **Validate** using Python test scripts
3. **Port** to nRF5340 for production features
4. **Test** cross-compatibility between platforms

## 📚 Documentation

- [`firmware_spec_protobuf.md`](./firmware_spec_protobuf.md) - Complete protocol specification
- [`esp32_ble_simulator/README.md`](./esp32_ble_simulator/README.md) - ESP32 setup guide
- [`nrf5340_ble_simulator/README.md`](./nrf5340_ble_simulator/README.md) - nRF5340 setup guide
- [`python_simulators/README.md`](./python_simulators/README.md) - Testing scripts guide

## 🤝 Contributing

When developing new features:

1. **Start with ESP32** for rapid prototyping
2. **Test thoroughly** with Python simulators  
3. **Port to nRF5340** for production validation
4. **Document** protocol changes in firmware_spec_protobuf.md
5. **Update** both simulator implementations

## 📈 Development Progress

This is part of the **dev-loay-nexfirmware** branch development, focusing on:
- ✅ ESP32-S3 BLE simulator implementation
- ✅ nRF5340 DK port with Zephyr RTOS
- ✅ Python testing framework
- ✅ Protobuf protocol v2.0 support
- 🔄 Production firmware integration
- 🔄 Advanced protocol features

---
**Branch**: `dev-loay-nexfirmware`  
**Developer**: Loay Yari  
**Last Updated**: July 31, 2025
