# ESP32-C3 to nRF5340 DK Porting Guide

## Overview
This guide will help you port the ESP32-C3 BLE glasses simulator project to the nRF5340 DK using the nRF Connect SDK.

## Project Analysis

### Current ESP32-C3 Features:
- BLE GATT Server with custom service
- Service UUID: `00004860-0000-1000-8000-00805f9b34fb`
- TX Characteristic: `000071FF-0000-1000-8000-00805f9b34fb` (Phone → Glasses)
- RX Characteristic: `000070FF-0000-1000-8000-00805f9b34fb` (Glasses → Phone)
- Protobuf message detection (headers: 0x02, 0xA0, 0xB0)
- Serial logging and echo responses
- Device naming with MAC suffix

## Prerequisites

1. **nRF Connect SDK**: Install the latest version
2. **nRF5340 DK**: Development kit with dual-core ARM Cortex-M33
3. **Segger J-Link**: For debugging and flashing
4. **west**: nRF Connect SDK build tool

## Step 1: Choose Base Sample Project

The best nRF Connect SDK sample to start with is:
```
samples/bluetooth/peripheral_uart
```

This sample provides:
- BLE GATT server setup
- Custom service and characteristics  
- UART-like communication over BLE
- Connection management
- Notification support

## Step 2: Create Project Structure

```bash
# Navigate to your workspace
cd /Users/loayyari/Documents/Work/Mentra/Projects/

# Create nRF5340 project directory
mkdir nrf5340_ble_glasses_sim
cd nrf5340_ble_glasses_sim

# Copy the peripheral_uart sample as base
cp -r $NRF_CONNECT_SDK_PATH/samples/bluetooth/peripheral_uart/* .

# Modify for our use case
```

## Step 3: Key Files to Modify

### `prj.conf` - Project Configuration
```ini
# Enable Bluetooth LE
CONFIG_BT=y
CONFIG_BT_PERIPHERAL=y
CONFIG_BT_DEVICE_NAME="NexSim"

# Enable GATT server
CONFIG_BT_GATT_SERVICE_CHANGED=y

# Enable logging
CONFIG_LOG=y
CONFIG_BT_DEBUG_LOG=y

# Enable UART
CONFIG_SERIAL=y
CONFIG_UART_CONSOLE=y

# Memory settings for nRF5340
CONFIG_MAIN_STACK_SIZE=2048
CONFIG_SYSTEM_WORKQUEUE_STACK_SIZE=2048
```

### `CMakeLists.txt` - Build Configuration
```cmake
cmake_minimum_required(VERSION 3.20.0)

find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(nrf5340_ble_glasses_sim)

target_sources(app PRIVATE
    src/main.c
    src/ble_service.c
    src/protobuf_handler.c
)
```

## Step 4: Port Main Application Logic

### `src/main.c` - Main Application
Key changes from ESP32-C3:
- Replace Arduino framework with Zephyr RTOS
- Use nRF SDK BLE APIs instead of ESP32 BLE libraries
- Implement similar callback structure

### `src/ble_service.c` - BLE Service Implementation
Port the BLE service setup:
- Custom service UUID
- TX/RX characteristics
- Connection callbacks
- Write callbacks for received data

### `src/protobuf_handler.c` - Protocol Handler
Port the message detection logic:
- Header detection (0x02, 0xA0, 0xB0)
- Data parsing and logging
- Echo response generation

## Step 5: nRF5340 Specific Considerations

### Dual-Core Architecture:
- **Application Core**: Runs main application
- **Network Core**: Handles radio protocols (BLE)
- For simple BLE applications, only app core is needed

### Memory Layout:
- More flash and RAM available than ESP32-C3
- Can handle larger protobuf messages
- Better real-time performance

### Power Management:
- Superior low-power capabilities
- Better suited for battery-powered glasses

## Step 6: Build and Flash Commands

```bash
# Build for nRF5340 DK
west build -b nrf5340dk_nrf5340_cpuapp

# Flash to device
west flash

# Monitor serial output
west debug
```

## Step 7: Testing

Use the same Python BLE simulator scripts:
- `ble_scanner.py` - Should detect "NexSim" device
- `service_scanner.py` - Should find the custom service
- `phone_ble_simulator.py` - Should connect and exchange data
- `direct_connect_test.py` - Direct protobuf testing

## Expected Improvements

1. **Better BLE Performance**: nRF5340 has dedicated BLE radio
2. **More Reliable Connections**: Professional-grade BLE stack
3. **Lower Power Consumption**: Optimized for battery operation
4. **Better Debugging**: Advanced debugging capabilities
5. **Production Ready**: Suitable for commercial deployment

## Next Steps

1. Set up nRF Connect SDK environment
2. Copy and modify the peripheral_uart sample
3. Port the BLE service and protobuf logic
4. Test with existing Python simulators
5. Optimize for production use

Would you like me to help you with any specific step of this porting process?
