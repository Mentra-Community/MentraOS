# Network I/O Package

A comprehensive network management system for the ASG client that provides platform-agnostic WiFi and hotspot functionality across different device types.

## 📁 Package Structure

```
io/network/
├── interfaces/
│   ├── INetworkManager.java           # Main network management interface
│   └── NetworkStateListener.java      # Network state change listener
├── core/
│   ├── BaseNetworkManager.java        # Base implementation with common functionality
│   └── NetworkManagerFactory.java     # Factory for creating platform-specific managers
├── managers/
│   ├── K900NetworkManager.java        # K900 device-specific implementation
│   ├── SystemNetworkManager.java      # System-level implementation with reflection
│   └── FallbackNetworkManager.java    # Fallback implementation for limited permissions
└── utils/
    └── DebugNotificationManager.java  # Debug notification utilities
```

## 🔧 Components

### **INetworkManager Interface**

The main interface that defines network management operations:

- `initialize()` - Initialize the network manager
- `enableWifi()` / `disableWifi()` - Control WiFi state
- `startHotspot()` / `stopHotspot()` - Control hotspot functionality
- `connectToWifi()` - Connect to specific WiFi networks
- `isConnectedToWifi()` - Check WiFi connection status
- `getLocalIpAddress()` - Get device IP address
- `getConfiguredWifiNetworks()` - List saved networks
- `scanWifiNetworks()` - Scan for available networks
- `shutdown()` - Cleanup resources

### **NetworkStateListener Interface**

Interface for receiving network state change notifications:

- `onWifiStateChanged(boolean isConnected)` - WiFi connection state changes
- `onHotspotStateChanged(boolean isEnabled)` - Hotspot state changes
- `onWifiCredentialsReceived(String ssid, String password, String authToken)` - Credentials received

### **BaseNetworkManager**

Abstract base class providing common functionality:

- Listener management and notification
- Platform detection (K900 vs standard Android)
- Common WiFi state checking
- IP address resolution
- Network scanning utilities

### **NetworkManagerFactory**

Factory class for creating appropriate network managers:

- **K900 Detection**: Automatically detects K900 devices
- **System Permissions**: Checks for system-level access
- **Fallback Support**: Provides limited functionality when permissions are restricted
- **Device-Specific**: Creates appropriate manager based on device capabilities

### **Platform-Specific Managers**

#### **K900NetworkManager**

- Uses K900-specific broadcast intents
- Native hotspot and WiFi control
- Enhanced functionality for K900 devices
- Automatic device detection

#### **SystemNetworkManager**

- Uses reflection to access system APIs
- Full WiFi and hotspot control
- Requires system permissions
- Includes embedded web server for hotspot setup

#### **FallbackNetworkManager**

- Limited functionality without system permissions
- User prompts for manual configuration
- K900 enhancement when K900 device is detected
- Graceful degradation of features

### **DebugNotificationManager**

Utility for showing debug notifications:

- Device type detection notifications
- WiFi state change notifications
- Hotspot state notifications
- Error reporting

## 🚀 Usage Examples

### **Basic Usage**

```java
// Get appropriate network manager for current device
INetworkManager networkManager = NetworkManagerFactory.getNetworkManager(context);

// Initialize and start using
networkManager.initialize();

// Add state change listener
networkManager.addWifiListener(new NetworkStateListener() {
    @Override
    public void onWifiStateChanged(boolean isConnected) {
        Log.d("Network", "WiFi connected: " + isConnected);
    }

    @Override
    public void onHotspotStateChanged(boolean isEnabled) {
        Log.d("Network", "Hotspot enabled: " + isEnabled);
    }

    @Override
    public void onWifiCredentialsReceived(String ssid, String password, String authToken) {
        Log.d("Network", "Credentials received for: " + ssid);
    }
});

// Enable WiFi
networkManager.enableWifi();

// Start hotspot
networkManager.startHotspot("MyHotspot", "password123");

// Connect to WiFi
networkManager.connectToWifi("MyNetwork", "networkpass");

// Check connection status
if (networkManager.isConnectedToWifi()) {
    String ipAddress = networkManager.getLocalIpAddress();
    Log.d("Network", "Connected with IP: " + ipAddress);
}
```

### **Platform Detection**

```java
// The factory automatically detects the best manager
INetworkManager manager = NetworkManagerFactory.getNetworkManager(context);

// Check what type of manager was created
if (manager instanceof K900NetworkManager) {
    Log.d("Network", "Using K900-specific network manager");
} else if (manager instanceof SystemNetworkManager) {
    Log.d("Network", "Using system-level network manager");
} else if (manager instanceof FallbackNetworkManager) {
    Log.d("Network", "Using fallback network manager");
}
```

## 🔄 Platform Detection Logic

The `NetworkManagerFactory` uses the following detection logic:

1. **K900 Detection**: Checks for K900-specific system UI package and broadcast actions
2. **System Permissions**: Checks if app has system-level permissions
3. **Fallback**: Uses limited functionality with user prompts

### **Detection Priority**

1. **K900 Device** → `K900NetworkManager` (Full native functionality)
2. **System Permissions** → `SystemNetworkManager` (Full reflection-based functionality)
3. **Limited Permissions** → `FallbackNetworkManager` (Limited functionality with K900 enhancement)

## 🛡️ Features

### **Platform Agnostic**

- Works on K900 and standard Android devices
- Automatic device detection and manager selection
- Consistent API across all implementations

### **Graceful Degradation**

- Falls back to limited functionality when permissions are restricted
- User-friendly prompts for manual configuration
- Maintains core functionality even with restrictions

### **Enhanced K900 Support**

- Native K900 broadcast support
- Enhanced hotspot functionality
- Automatic K900 detection in fallback mode

### **Debug Support**

- Comprehensive debug notifications
- Device type detection reporting
- State change monitoring

### **Thread Safe**

- All operations are thread-safe
- Proper listener management
- Safe broadcast receiver handling

## 📈 Benefits

1. **Unified Interface**: Single interface for all network operations
2. **Device Optimization**: Automatically uses best available APIs
3. **Permission Handling**: Graceful handling of permission restrictions
4. **Debug Support**: Comprehensive debugging and monitoring
5. **Extensible**: Easy to add new platform-specific implementations

## 🔮 Future Enhancements

- **Network Security**: Enhanced security validation
- **Connection Monitoring**: Real-time connection quality monitoring
- **Auto-Reconnection**: Automatic reconnection on connection loss
- **Network Profiles**: Support for multiple network configurations
- **Performance Metrics**: Network performance tracking

---

This network I/O package provides a robust, platform-agnostic foundation for all network operations in the ASG client system.
