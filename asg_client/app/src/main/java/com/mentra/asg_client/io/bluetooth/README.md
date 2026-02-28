# Bluetooth I/O Package

A comprehensive Bluetooth management system for the ASG client that provides unified BLE operations across different device types, including K900 smart glasses and standard Android devices.

## 📁 Package Structure

```
io/bluetooth/
├── interfaces/
│   ├── IBluetoothManager.java           # Core Bluetooth interface
│   ├── BluetoothStateListener.java      # Bluetooth state listener
│   └── SerialListener.java              # Serial communication listener
├── core/
│   ├── BaseBluetoothManager.java        # Abstract base class
│   ├── BluetoothManagerFactory.java     # Factory for Bluetooth managers
│   └── ComManager.java                  # Serial communication manager
├── managers/
│   ├── StandardBluetoothManager.java    # Standard Bluetooth implementation
│   ├── K900BluetoothManager.java        # K900-specific implementation
│   └── NordicBluetoothManager.java      # Nordic-specific implementation
├── utils/
│   ├── BTUtil.java                      # Bluetooth utilities
│   ├── ByteUtil.java                    # Byte manipulation utilities
│   ├── CircleBuffer.java                # Circular buffer implementation
│   ├── K900MessageParser.java           # K900 message parsing
│   └── DebugNotificationManager.java    # Debug notification utilities
└── README.md                            # This documentation
```

## 🔧 Components

### **Bluetooth Interfaces**

#### **IBluetoothManager**

Core interface for Bluetooth management operations:

- `initialize()` - Initialize the Bluetooth manager
- `startAdvertising()` - Start BLE advertising
- `stopAdvertising()` - Stop BLE advertising
- `isConnected()` - Check connection status
- `disconnect()` - Disconnect from device
- `sendData(byte[] data)` - Send data to connected device
- `sendImageFile(String filePath)` - Send image file
- `addBluetoothListener(BluetoothStateListener listener)` - Add state listener
- `removeBluetoothListener(BluetoothStateListener listener)` - Remove state listener
- `shutdown()` - Cleanup resources

#### **BluetoothStateListener**

Interface for receiving Bluetooth state changes:

- `onConnectionStateChanged(boolean connected)` - Connection state change
- `onDataReceived(byte[] data)` - Data received from device

#### **SerialListener**

Interface for serial port events:

- `onSerialOpen(boolean success, int code, String serialPath, String msg)` - Serial port opened
- `onSerialReady(String serialPath)` - Serial port ready
- `onSerialRead(String serialPath, byte[] data, int size)` - Data read from serial
- `onSerialClose(String serialPath)` - Serial port closed

### **Bluetooth Core Classes**

#### **BaseBluetoothManager**

Abstract base class providing common functionality:

- **Listener Management**: Register/unregister Bluetooth state listeners
- **State Notification**: Notify listeners of connection and data events
- **Common Operations**: Default implementations for basic operations
- **Resource Management**: Basic cleanup and initialization

#### **BluetoothManagerFactory**

Factory class for creating appropriate Bluetooth managers:

- **Device Detection**: Automatically detects K900 vs standard Android devices
- **Manager Creation**: Creates the appropriate manager implementation
- **Platform Support**: Supports multiple device types and platforms

#### **ComManager**

Serial communication manager for K900 devices:

- **Serial Port Management**: Opens/closes serial ports
- **Data Transfer**: Handles data transmission via serial
- **Event Handling**: Manages serial port events and callbacks
- **Thread Safety**: Thread-safe serial operations

### **Bluetooth Managers**

#### **StandardBluetoothManager**

Implementation for standard Android devices:

- **BLE Peripheral**: Implements BLE peripheral functionality
- **GATT Server**: Provides GATT services for client connections
- **Advertising**: Handles BLE advertising with custom device name
- **MTU Negotiation**: Optimizes MTU size for data transfer
- **Auto-Pairing**: Automatic pairing with companion devices
- **Connection Management**: Robust connection state management

#### **K900BluetoothManager**

Implementation for K900 smart glasses:

- **Serial Communication**: Uses serial port to communicate with BES2700 module
- **File Transfer**: Advanced file transfer capabilities with retry logic
- **Message Parsing**: Handles K900 protocol message parsing
- **Fragmented Messages**: Manages fragmented messages across multiple reads
- **Error Recovery**: Robust error handling and recovery mechanisms

#### **NordicBluetoothManager**

Implementation using Nordic BLE libraries:

- **Nordic BLE**: Uses Nordic Semiconductor BLE libraries
- **Server Management**: Advanced BLE server management
- **Connection Validation**: Periodic connection validation
- **Keep-Alive**: Maintains connection with keep-alive messages
- **Multi-Device**: Supports multiple connected devices

### **Bluetooth Utilities**

#### **BTUtil**

Utility class for Bluetooth operations:

- **Enable/Disable**: Control Bluetooth adapter state
- **Permission Checking**: Verify Bluetooth permissions
- **Platform Compatibility**: Handle different Android versions

#### **ByteUtil**

Byte array manipulation utilities:

- **Data Copying**: Safe byte array copying operations
- **Type Conversion**: Convert between bytes and integers
- **Hex Formatting**: Format byte arrays as hex strings
- **K900 Compatibility**: Compatible with K900 protocol requirements

#### **CircleBuffer**

Circular buffer implementation:

- **Data Buffering**: Efficient data buffering for UART communication
- **Overflow Protection**: Prevents buffer overflow
- **Thread Safety**: Thread-safe buffer operations
- **Memory Efficiency**: Memory-efficient circular buffer design

#### **K900MessageParser**

K900 protocol message parser:

- **Message Detection**: Detects K900 protocol message markers
- **Fragmentation Handling**: Handles fragmented messages
- **Buffer Management**: Manages message buffers efficiently
- **Validation**: Validates message integrity

#### **DebugNotificationManager**

Debug notification utilities:

- **User Feedback**: Show notifications for Bluetooth events
- **Debug Information**: Display debug information during development
- **State Notifications**: Notify users of connection state changes
- **Error Reporting**: Report Bluetooth errors to users

## 🚀 Usage Examples

### **Basic Bluetooth Setup**

```java
// Get the appropriate Bluetooth manager for the device
IBluetoothManager bluetoothManager = BluetoothManagerFactory.getBluetoothManager(context);

// Initialize the manager
bluetoothManager.initialize();

// Register a listener for state changes
bluetoothManager.addBluetoothListener(new BluetoothStateListener() {
    @Override
    public void onConnectionStateChanged(boolean connected) {
        if (connected) {
            Log.d("Bluetooth", "Connected to companion device");
        } else {
            Log.d("Bluetooth", "Disconnected from companion device");
        }
    }

    @Override
    public void onDataReceived(byte[] data) {
        Log.d("Bluetooth", "Received " + data.length + " bytes");
        // Process received data
    }
});

// Start advertising (for non-K900 devices)
bluetoothManager.startAdvertising();
```

### **Data Transmission**

```java
// Send data to connected device
byte[] data = "Hello, World!".getBytes();
boolean success = bluetoothManager.sendData(data);

if (success) {
    Log.d("Bluetooth", "Data sent successfully");
} else {
    Log.e("Bluetooth", "Failed to send data");
}

// Send image file
String imagePath = "/path/to/image.jpg";
boolean fileSuccess = bluetoothManager.sendImageFile(imagePath);

if (fileSuccess) {
    Log.d("Bluetooth", "Image file transfer started");
} else {
    Log.e("Bluetooth", "Failed to start image transfer");
}
```

### **K900-Specific Operations**

```java
// K900 devices automatically handle BLE advertising
// No need to call startAdvertising() on K900 devices

// Check if connected
if (bluetoothManager.isConnected()) {
    Log.d("Bluetooth", "Connected via K900 serial port");

    // Send data through serial connection
    byte[] data = "K900 data".getBytes();
    bluetoothManager.sendData(data);
}
```

### **Serial Communication (K900)**

```java
// Create serial communication manager
ComManager comManager = new ComManager(context);

// Register serial listener
comManager.registerListener(new SerialListener() {
    @Override
    public void onSerialOpen(boolean success, int code, String serialPath, String msg) {
        if (success) {
            Log.d("Serial", "Serial port opened: " + serialPath);
        } else {
            Log.e("Serial", "Failed to open serial port: " + msg);
        }
    }

    @Override
    public void onSerialReady(String serialPath) {
        Log.d("Serial", "Serial port ready: " + serialPath);
    }

    @Override
    public void onSerialRead(String serialPath, byte[] data, int size) {
        Log.d("Serial", "Read " + size + " bytes from serial port");
        // Process received data
    }

    @Override
    public void onSerialClose(String serialPath) {
        Log.d("Serial", "Serial port closed: " + serialPath);
    }
});

// Start serial communication
boolean started = comManager.start();
if (started) {
    Log.d("Serial", "Serial communication started");
}
```

### **Debug Notifications**

```java
// Create debug notification manager
DebugNotificationManager notificationManager = new DebugNotificationManager(context);

// Show device type notification
notificationManager.showDeviceTypeNotification(true); // true for K900

// Show connection state
notificationManager.showBluetoothStateNotification(true); // true for connected

// Show MTU negotiation
notificationManager.showMtuNegotiationNotification(512);

// Show advertising status
notificationManager.showAdvertisingNotification("Xy_A");
```

### **Utility Operations**

```java
// Enable Bluetooth
boolean enabled = BTUtil.openBluetooth(context);
if (enabled) {
    Log.d("Bluetooth", "Bluetooth enabled successfully");
}

// Format byte array as hex
byte[] data = {0x01, 0x02, 0x03, 0x04};
String hexString = ByteUtil.outputHexString(data, 0, data.length);
Log.d("Bluetooth", "Hex string: " + hexString);

// Create circular buffer
CircleBuffer buffer = new CircleBuffer(1024);
boolean added = buffer.add(data, 0, data.length);
if (added) {
    Log.d("Bluetooth", "Data added to buffer");
}
```

## 🔄 Bluetooth Workflow

### **Standard Android Device Workflow**

1. **Initialization**: Bluetooth manager is initialized
2. **Advertising**: BLE advertising starts with device name "Xy_A"
3. **Discovery**: Companion app discovers the device
4. **Connection**: Companion app connects to the device
5. **MTU Negotiation**: MTU size is negotiated for optimal transfer
6. **Data Exchange**: Bidirectional data exchange begins
7. **Disconnection**: Device disconnects when companion app disconnects

### **K900 Device Workflow**

1. **Initialization**: K900 Bluetooth manager is initialized
2. **Serial Setup**: Serial port connection to BES2700 is established
3. **Protocol Handshake**: K900 protocol handshake is performed
4. **Connection Ready**: Serial connection is ready for data transfer
5. **Data Exchange**: Data is exchanged via serial protocol
6. **File Transfer**: Advanced file transfer with retry logic
7. **Cleanup**: Serial connection is closed on shutdown

### **Message Parsing Workflow (K900)**

1. **Data Reception**: Raw data is received from serial port
2. **Buffer Management**: Data is added to circular buffer
3. **Message Detection**: Protocol markers (## and $$) are detected
4. **Fragmentation Handling**: Fragmented messages are reassembled
5. **Validation**: Message integrity is validated
6. **Processing**: Complete messages are processed
7. **Cleanup**: Processed data is removed from buffer

## 🛡️ Features

### **Multi-Device Support**

- **K900 Devices**: Serial-based communication with BES2700 module
- **Standard Android**: Native BLE peripheral implementation
- **Nordic Devices**: Advanced BLE with Nordic libraries
- **Automatic Detection**: Automatic device type detection

### **Robust Communication**

- **Error Handling**: Comprehensive error handling and recovery
- **Retry Logic**: Automatic retry for failed operations
- **Connection Management**: Robust connection state management
- **Timeout Handling**: Proper timeout handling for operations

### **Advanced File Transfer**

- **Large Files**: Support for large file transfers
- **Progress Tracking**: Real-time transfer progress tracking
- **Retry Mechanism**: Automatic retry for failed transfers
- **Integrity Checking**: File integrity verification

### **Debug Support**

- **Notifications**: User-friendly debug notifications
- **Logging**: Comprehensive logging for troubleshooting
- **State Tracking**: Detailed state tracking and reporting
- **Error Reporting**: Clear error reporting and diagnostics

### **Performance Optimization**

- **MTU Optimization**: Dynamic MTU size negotiation
- **Buffer Management**: Efficient buffer management
- **Memory Usage**: Optimized memory usage
- **Battery Efficiency**: Battery-efficient operations

## 📈 Benefits

1. **Unified Interface**: Single interface for all Bluetooth operations
2. **Device Agnostic**: Works across different device types
3. **High Performance**: Optimized for performance and efficiency
4. **Reliable**: Robust error handling and recovery
5. **Extensible**: Easy to add new device types and features
6. **Debug Friendly**: Comprehensive debugging and logging
7. **User Friendly**: Clear user feedback and notifications

## 🔮 Future Enhancements

- **Mesh Networking**: Support for Bluetooth mesh networks
- **Audio Streaming**: Real-time audio streaming capabilities
- **Security**: Enhanced security and encryption
- **Multi-Protocol**: Support for additional Bluetooth protocols
- **Cloud Integration**: Cloud-based Bluetooth management
- **Analytics**: Bluetooth usage analytics and insights

---

This Bluetooth I/O package provides a comprehensive, high-performance foundation for all Bluetooth operations in the ASG client system, supporting multiple device types with robust error handling and advanced features.
