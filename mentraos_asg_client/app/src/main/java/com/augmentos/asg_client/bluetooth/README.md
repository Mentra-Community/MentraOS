# AugmentOS Bluetooth Connectivity

This directory contains the implementation of the Bluetooth connectivity module for AugmentOS ASG Client, providing a unified API for both standard Android devices and K900 smart glasses.

## Architecture

The Bluetooth connectivity implementation follows a layered architecture similar to the WiFi module:

1. **Interface Layer**: 
   - `IBluetoothManager`: Core interface defining BLE operations
   - `BluetoothStateListener`: Interface for receiving BLE events

2. **Base Implementation**: 
   - `BaseBluetoothManager`: Abstract class with common functionality

3. **Device-Specific Implementations**:
   - `K900BluetoothManager`: For K900 devices, using serial connection to BES2700
   - `StandardBluetoothManager`: For regular Android devices, using standard BLE API

4. **Factory**:
   - `BluetoothManagerFactory`: Creates the appropriate manager based on device

5. **Debugging**:
   - `DebugNotificationManager`: Shows notifications for debugging

## K900-Specific Implementation

The K900 implementation uses a serial connection to communicate with the BES2700 Bluetooth module:

1. **Serial Communication**:
   - `com.lhs.serialport.api.SerialPort`: JNI wrapper for serial port access
   - `com.lhs.serialport.api.SerialManager`: Manager for serial ports
   - `SerialListener`: Interface for serial port events
   - `ComManager`: High-level manager for serial communication

2. **JNI Libraries**:
   - Native libraries (`liblhsserial.so`) need to be copied from the K900 SDK
   - Run `copy_native_libs.sh` in the project root to copy the libraries

## Usage

```java
// Get the appropriate Bluetooth manager for the device
IBluetoothManager bluetoothManager = BluetoothManagerFactory.getBluetoothManager(context);

// Initialize
bluetoothManager.initialize();

// Register a listener
bluetoothManager.addBluetoothListener(new BluetoothStateListener() {
    @Override
    public void onConnectionStateChanged(boolean connected) {
        // Handle connection state changes
    }

    @Override
    public void onDataReceived(byte[] data) {
        // Handle received data
    }
});

// Start advertising (for non-K900 devices)
bluetoothManager.startAdvertising();

// Send data
bluetoothManager.sendData(dataBytes);

// Shutdown when done
bluetoothManager.shutdown();
```

## Important Notes

1. The K900 implementation requires the native library (`liblhsserial.so`) to be present in the `jniLibs` directory.

2. The K900 implementation uses the original package structure (`com.lhs.serialport.api`) to ensure compatibility with the native library. This is intentional and should not be changed.

3. The `StandardBluetoothManager` implementation is currently a stub. It needs to be completed with actual BLE implementation when support for regular Android devices is needed.

4. K900 devices handle BLE advertising automatically through the BES2700 module, so `startAdvertising()` and `stopAdvertising()` are no-ops on these devices.