# Manager Access Guide - Service Architecture

## Overview

This document explains the recommended approach for accessing managers in the `AsgClientService` package, particularly focusing on how `CommandProcessor` and other components should interact with the new interface-based architecture.

## 🏗️ **Current Architecture**

```
AsgClientService (Main Service - 763 lines)
├── ServiceContainer (Dependency Injection)
│   ├── IServiceLifecycle ← ServiceLifecycleManager
│   ├── ICommunicationManager ← CommunicationManager
│   ├── IStateManager ← StateManager
│   └── IStreamingManager ← StreamingManager
└── Supporting Components
    ├── AsgClientServiceManager (Legacy)
    ├── CommandProcessor (Updated to use interfaces)
    └── AsgNotificationManager
```

## 🎯 **Recommended Approach: Interface-Based Access**

### **Why Interface-Based Access?**

1. **Dependency Inversion Principle**: Components depend on abstractions, not concretions
2. **Loose Coupling**: Easy to swap implementations without changing dependent code
3. **Testability**: Easy to mock interfaces for unit testing
4. **Single Responsibility**: Each interface has a focused set of responsibilities
5. **Maintainability**: Clear separation of concerns

### **Before vs After**

#### ❌ **Before: Direct AsgClientServiceManager Access**

```java
// CommandProcessor directly accessing AsgClientServiceManager
public class CommandProcessor {
    private final AsgClientServiceManager serviceManager;

    public void handleRequestWifiStatus() {
        INetworkManager networkManager = serviceManager.getNetworkManager();
        if (networkManager != null) {
            boolean wifiConnected = networkManager.isConnectedToWifi();
            service.sendWifiStatusOverBle(wifiConnected);
        }
    }
}
```

#### ✅ **After: Interface-Based Access**

```java
// CommandProcessor using interface-based managers
public class CommandProcessor {
    private final ICommunicationManager communicationManager;
    private final IStateManager stateManager;
    private final IStreamingManager streamingManager;
    private final AsgClientServiceManager serviceManager; // Legacy support

    public void handleRequestWifiStatus() {
        if (stateManager.isConnectedToWifi()) {
            communicationManager.sendWifiStatusOverBle(true);
        } else {
            communicationManager.sendWifiStatusOverBle(false);
        }
    }
}
```

## 🔧 **Implementation Details**

### **1. CommandProcessor Constructor**

```java
public CommandProcessor(Context context,
                      AsgClientService service,
                      ICommunicationManager communicationManager,
                      IStateManager stateManager,
                      IStreamingManager streamingManager,
                      AsgClientServiceManager serviceManager) {
    this.context = context;
    this.service = service;
    this.communicationManager = communicationManager;
    this.stateManager = stateManager;
    this.streamingManager = streamingManager;
    this.serviceManager = serviceManager; // Legacy support
}
```

### **2. ServiceContainer Initialization**

```java
public ServiceContainer(Context context) {
    this.context = context;

    // Initialize core components
    this.serviceManager = new AsgClientServiceManager(context, null);
    this.notificationManager = new AsgNotificationManager(context);

    // Initialize interface implementations
    this.communicationManager = new CommunicationManager(serviceManager);
    this.stateManager = new StateManager(serviceManager);
    this.streamingManager = new StreamingManager(context, serviceManager);

    // Initialize CommandProcessor with interface-based managers
    this.commandProcessor = new CommandProcessor(context, null,
                                               communicationManager,
                                               stateManager,
                                               streamingManager,
                                               serviceManager);

    // Initialize lifecycle manager with all components
    this.lifecycleManager = new ServiceLifecycleManager(context, serviceManager, commandProcessor, notificationManager);
}
```

## 📋 **Manager Responsibilities**

### **ICommunicationManager**

```java
// Handles all Bluetooth communication
void sendWifiStatusOverBle(boolean isConnected);
void sendBatteryStatusOverBle();
void sendWifiScanResultsOverBle(List<String> networks);
void sendAckResponse(long messageId);
void sendTokenStatusResponse(boolean success);
void sendMediaSuccessResponse(String requestId, String mediaUrl, int mediaType);
void sendMediaErrorResponse(String requestId, String errorMessage, int mediaType);
void sendKeepAliveAck(String streamId, String ackId);
boolean sendBluetoothData(byte[] data);
```

### **IStateManager**

```java
// Handles state tracking and queries
void updateBatteryStatus(int level, boolean charging, long timestamp);
int getBatteryLevel();
boolean isCharging();
String getBatteryStatusString();
boolean isConnectedToWifi();
boolean isBluetoothConnected();
boolean isAugmentosServiceBound();
```

### **IStreamingManager**

```java
// Handles RTMP streaming and video recording
void startRtmpStreaming();
void stopRtmpStreaming();
void sendRtmpStatusResponse(boolean success, String status, String details);
void sendRtmpStatusResponse(boolean success, JSONObject statusObject);
void sendVideoRecordingStatusResponse(boolean success, String status, String details);
void sendVideoRecordingStatusResponse(boolean success, JSONObject statusObject);
StreamingStatusCallback getStreamingStatusCallback();
```

### **IServiceLifecycle**

```java
// Handles service lifecycle management
void initialize();
void onStart();
void handleAction(String action, Bundle extras);
void cleanup();
boolean isInitialized();
```

## 🔄 **Migration Strategy**

### **Phase 1: Hybrid Approach (Current)**

- ✅ Use interface-based managers for new functionality
- ✅ Keep `AsgClientServiceManager` for legacy components
- ✅ Gradually migrate existing code to use interfaces

### **Phase 2: Full Interface Migration**

- 🔄 Migrate all components to use interface-based managers
- 🔄 Remove direct `AsgClientServiceManager` dependencies
- 🔄 Create additional interfaces as needed

### **Phase 3: Legacy Cleanup**

- 🔄 Remove `AsgClientServiceManager` once all components are migrated
- 🔄 Consolidate remaining functionality into appropriate managers

## 💡 **Best Practices**

### **1. Use Interface-Based Managers First**

```java
// ✅ Good: Use interface-based manager
if (stateManager.isConnectedToWifi()) {
    communicationManager.sendWifiStatusOverBle(true);
}

// ❌ Avoid: Direct service manager access
INetworkManager networkManager = serviceManager.getNetworkManager();
if (networkManager != null) {
    boolean wifiConnected = networkManager.isConnectedToWifi();
    service.sendWifiStatusOverBle(wifiConnected);
}
```

### **2. Keep Legacy Support for Complex Operations**

```java
// ✅ Good: Use service manager for complex legacy operations
MediaCaptureService captureService = serviceManager.getMediaCaptureService();
if (captureService != null) {
    captureService.takePhotoLocally();
}

// ✅ Good: Use interface for simple operations
communicationManager.sendMediaSuccessResponse(requestId, mediaUrl, mediaType);
```

### **3. Delegate to Appropriate Managers**

```java
// ✅ Good: Delegate to streaming manager
streamingManager.sendVideoRecordingStatusResponse(true, "recording_started", null);

// ✅ Good: Delegate to communication manager
communicationManager.sendAckResponse(messageId);

// ✅ Good: Delegate to state manager
stateManager.updateBatteryStatus(level, charging, timestamp);
```

### **4. Avoid Direct Service Access**

```java
// ❌ Avoid: Direct service access from CommandProcessor
service.sendWifiStatusOverBle(isConnected);

// ✅ Good: Use communication manager
communicationManager.sendWifiStatusOverBle(isConnected);
```

## 🧪 **Testing Benefits**

### **Easy Mocking**

```java
@Test
public void testCommandProcessing() {
    // Create mocks
    ICommunicationManager mockCommunication = mock(ICommunicationManager.class);
    IStateManager mockState = mock(IStateManager.class);
    IStreamingManager mockStreaming = mock(IStreamingManager.class);

    // Create CommandProcessor with mocks
    CommandProcessor processor = new CommandProcessor(context, service,
                                                    mockCommunication,
                                                    mockState,
                                                    mockStreaming,
                                                    serviceManager);

    // Test behavior
    when(mockState.isConnectedToWifi()).thenReturn(true);

    // Verify interactions
    verify(mockCommunication).sendWifiStatusOverBle(true);
}
```

### **Isolated Testing**

```java
@Test
public void testCommunicationManager() {
    ICommunicationManager communication = new CommunicationManager(serviceManager);

    // Test communication functionality in isolation
    communication.sendWifiStatusOverBle(true);

    // Verify Bluetooth manager was called correctly
    verify(bluetoothManager).sendData(any(byte[].class));
}
```

## 🔍 **Debugging Benefits**

### **Clear Component Boundaries**

```java
// Easy to identify which manager is responsible
Log.d(TAG, "CommunicationManager: Sending WiFi status");
Log.d(TAG, "StateManager: WiFi state updated");
Log.d(TAG, "StreamingManager: RTMP stream started");
```

### **Isolated Error Handling**

```java
try {
    communicationManager.sendWifiStatusOverBle(isConnected);
} catch (Exception e) {
    Log.e(TAG, "CommunicationManager error: " + e.getMessage());
    // Handle communication-specific errors
}

try {
    stateManager.updateBatteryStatus(level, charging, timestamp);
} catch (Exception e) {
    Log.e(TAG, "StateManager error: " + e.getMessage());
    // Handle state-specific errors
}
```

## 📊 **Performance Benefits**

### **Lazy Loading**

```java
// Managers are initialized only when needed
public class ServiceContainer {
    private ICommunicationManager communicationManager;

    public ICommunicationManager getCommunicationManager() {
        if (communicationManager == null) {
            communicationManager = new CommunicationManager(serviceManager);
        }
        return communicationManager;
    }
}
```

### **Reduced Coupling**

```java
// Changes to one manager don't affect others
// CommunicationManager changes don't affect StateManager
// StateManager changes don't affect StreamingManager
```

## 🚀 **Future Extensibility**

### **Adding New Managers**

```java
// Easy to add new managers without changing existing code
public interface IMediaManager {
    void takePhoto(String requestId);
    void startVideoRecording(String requestId);
    void stopVideoRecording();
}

public class MediaManager implements IMediaManager {
    // Implementation
}
```

### **Adding New Interfaces**

```java
// Easy to add new interfaces for new concerns
public interface IConfigurationManager {
    void updateSettings(JSONObject settings);
    JSONObject getSettings();
    void resetToDefaults();
}
```

## ✅ **Conclusion**

The interface-based approach provides:

1. **Better Architecture**: Follows SOLID principles
2. **Improved Testability**: Easy to mock and test components
3. **Enhanced Maintainability**: Clear separation of concerns
4. **Future-Proof Design**: Easy to extend and modify
5. **Better Debugging**: Isolated component boundaries
6. **Performance Benefits**: Lazy loading and reduced coupling

**Key Takeaway**: Always prefer interface-based managers over direct `AsgClientServiceManager` access for new functionality, while maintaining legacy support for complex operations that haven't been migrated yet.
