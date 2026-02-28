# AsgClientService Debugging Reference

## Overview

This document provides comprehensive debugging references for the `AsgClientService` package. It includes troubleshooting guides, log analysis, and debugging techniques for each component.

## Service Architecture Overview

```
AsgClientService (Main Service - 763 lines)
├── ServiceContainer (Dependency Injection)
│   ├── IServiceLifecycle ← ServiceLifecycleManager
│   ├── ICommunicationManager ← CommunicationManager
│   ├── IStateManager ← StateManager
│   └── IStreamingManager ← StreamingManager
└── Supporting Components
    ├── AsgClientServiceManager (Legacy)
    ├── CommandProcessor
    └── AsgNotificationManager
```

## Log Tags and Debugging

### Main Service Logs

```java
// Service lifecycle
Log.d(TAG, "AsgClientServiceV2 onCreate");
Log.d(TAG, "AsgClientServiceV2 onDestroy");

// Service actions
Log.d(TAG, "Received action: " + action);
Log.d(TAG, "Handling service action: " + action);

// WiFi state changes
Log.d(TAG, "🔄 WiFi state changed: " + (isConnected ? "CONNECTED" : "DISCONNECTED"));
Log.d(TAG, "🔄 WiFi debounce timeout - sending final state: " + state);

// Bluetooth events
Log.d(TAG, "Bluetooth connection state changed: " + (connected ? "CONNECTED" : "DISCONNECTED"));
Log.d(TAG, "Received " + data.length + " bytes from Bluetooth");

// Version info
Log.d(TAG, "📊 Sending version information");
Log.d(TAG, "✅ Sent version info to phone");
```

### ServiceContainer Logs

```java
// Container initialization
Log.d(TAG, "ServiceContainer initialized");
Log.d(TAG, "LifecycleManager initialized");
Log.d(TAG, "CommunicationManager initialized");
Log.d(TAG, "StateManager initialized");
Log.d(TAG, "StreamingManager initialized");

// Component access
Log.d(TAG, "Getting ServiceManager from container");
Log.d(TAG, "Getting CommandProcessor from container");
Log.d(TAG, "Getting NotificationManager from container");
```

### Manager Logs

#### ServiceLifecycleManager

```java
Log.d(TAG, "Service lifecycle manager initialized");
Log.d(TAG, "Handling action: " + action);
Log.d(TAG, "Service cleanup completed");
```

#### CommunicationManager

```java
Log.d(TAG, "📤 Sending WiFi status: " + isConnected);
Log.d(TAG, "📤 Sending battery status: " + level + "%");
Log.d(TAG, "📤 Sending ACK response: " + messageId);
Log.d(TAG, "📤 Sending media success response: " + requestId);
Log.d(TAG, "📤 Sending RTMP status response: " + status);
```

#### StateManager

```java
Log.d(TAG, "🔋 Battery status updated: " + level + "% " + (charging ? "(charging)" : "(not charging)"));
Log.d(TAG, "WiFi state updated: " + (isConnected ? "CONNECTED" : "DISCONNECTED"));
Log.d(TAG, "Bluetooth state updated: " + (isConnected ? "CONNECTED" : "DISCONNECTED"));
```

#### StreamingManager

```java
Log.d(TAG, "🎥 Starting RTMP streaming");
Log.d(TAG, "🎥 Stopping RTMP streaming");
Log.d(TAG, "📹 Video recording started: " + requestId);
Log.d(TAG, "📹 Video recording stopped: " + requestId);
```

### CommandProcessor Logs

```java
Log.d(TAG, "Processing JSON message type: " + type);
Log.d(TAG, "📤 Sent ACK for message ID: " + messageId);
Log.d(TAG, "📱 Received phone_ready message - sending glasses_ready response");
Log.d(TAG, "📦 Payload is not valid JSON, treating as ODM format");
```

## Common Issues and Debugging Steps

### Issue 1: Service Not Starting

#### Symptoms

- Service fails to start
- App crashes on service start
- Service not found in AndroidManifest.xml

#### Debug Steps

1. **Check AndroidManifest.xml**

   ```xml
   <service
       android:name=".service.AsgClientService"
       android:enabled="true"
       android:exported="true">
   ```

2. **Check Service Initialization Logs**

   ```bash
   adb logcat | grep "AsgClientServiceV2"
   ```

3. **Check ServiceContainer Initialization**

   ```bash
   adb logcat | grep "ServiceContainer"
   ```

4. **Check Manager Initialization**
   ```bash
   adb logcat | grep "Manager initialized"
   ```

#### Common Causes

- Missing permissions in AndroidManifest.xml
- ServiceContainer initialization failure
- Manager dependency injection failure
- Context issues

#### Solutions

```java
// Add missing permissions
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.BLUETOOTH" />
<uses-permission android:name="android.permission.BLUETOOTH_ADMIN" />

// Check service container initialization
if (serviceContainer == null) {
    Log.e(TAG, "ServiceContainer is null");
    return;
}
```

### Issue 2: Bluetooth Communication Issues

#### Symptoms

- No data received via Bluetooth
- No data sent via Bluetooth
- Bluetooth connection not established

#### Debug Steps

1. **Check Bluetooth Permissions**

   ```bash
   adb logcat | grep "Bluetooth"
   ```

2. **Check Connection State**

   ```java
   boolean isConnected = stateManager.isBluetoothConnected();
   Log.d(TAG, "Bluetooth connected: " + isConnected);
   ```

3. **Check Data Reception**

   ```java
   Log.d(TAG, "Received " + data.length + " bytes from Bluetooth");
   ```

4. **Check Data Sending**
   ```java
   Log.d(TAG, "📤 Sending data via Bluetooth: " + data.length + " bytes");
   ```

#### Common Causes

- Bluetooth permissions not granted
- Bluetooth manager not initialized
- Connection state not properly tracked
- Data format issues

#### Solutions

```java
// Check permissions
if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH)
    != PackageManager.PERMISSION_GRANTED) {
    Log.e(TAG, "Bluetooth permission not granted");
    return;
}

// Check Bluetooth manager
if (serviceContainer.getServiceManager().getBluetoothManager() == null) {
    Log.e(TAG, "Bluetooth manager is null");
    return;
}
```

### Issue 3: Command Processing Issues

#### Symptoms

- Commands not processed
- Incorrect responses
- JSON parsing errors

#### Debug Steps

1. **Check Command Reception**

   ```bash
   adb logcat | grep "Processing JSON message"
   ```

2. **Check JSON Parsing**

   ```java
   try {
       JSONObject jsonObject = new JSONObject(jsonStr);
       Log.d(TAG, "JSON parsed successfully: " + jsonObject.toString());
   } catch (JSONException e) {
       Log.e(TAG, "JSON parsing error: " + e.getMessage());
   }
   ```

3. **Check Command Routing**

   ```java
   Log.d(TAG, "Processing command type: " + type);
   ```

4. **Check Response Generation**
   ```java
   Log.d(TAG, "📤 Sending response: " + response.toString());
   ```

#### Common Causes

- Malformed JSON data
- Unknown command types
- CommandProcessor not initialized
- Missing command handlers

#### Solutions

```java
// Validate JSON before processing
if (jsonObject == null) {
    Log.e(TAG, "JSON object is null");
    return;
}

// Check command type
String type = jsonObject.optString("type", "");
if (type.isEmpty()) {
    Log.e(TAG, "Command type is empty");
    return;
}

// Add command handler
switch (type) {
    case "new_command":
        handleNewCommand(jsonObject);
        break;
    default:
        Log.w(TAG, "Unknown command type: " + type);
        break;
}
```

### Issue 4: State Management Issues

#### Symptoms

- Incorrect battery status
- WiFi status not updated
- State not persisted

#### Debug Steps

1. **Check State Updates**

   ```bash
   adb logcat | grep "Battery status updated"
   adb logcat | grep "WiFi state updated"
   ```

2. **Check State Queries**

   ```java
   int batteryLevel = stateManager.getBatteryLevel();
   boolean isCharging = stateManager.isCharging();
   boolean wifiConnected = stateManager.isConnectedToWifi();
   Log.d(TAG, "Current state - Battery: " + batteryLevel + "%, Charging: " + isCharging + ", WiFi: " + wifiConnected);
   ```

3. **Check State Persistence**
   ```java
   SharedPreferences prefs = PreferenceManager.getDefaultSharedPreferences(context);
   String savedState = prefs.getString("battery_level", "unknown");
   Log.d(TAG, "Saved battery level: " + savedState);
   ```

#### Common Causes

- State not properly updated
- State manager not initialized
- State persistence issues
- Race conditions

#### Solutions

```java
// Ensure state manager is initialized
if (stateManager == null) {
    Log.e(TAG, "StateManager is null");
    return;
}

// Update state atomically
synchronized (this) {
    stateManager.updateBatteryStatus(level, charging, timestamp);
    Log.d(TAG, "State updated successfully");
}
```

### Issue 5: Streaming Issues

#### Symptoms

- RTMP streaming not working
- Video recording issues
- Streaming callbacks not triggered

#### Debug Steps

1. **Check Streaming Initialization**

   ```bash
   adb logcat | grep "Starting RTMP streaming"
   adb logcat | grep "Stopping RTMP streaming"
   ```

2. **Check Video Recording**

   ```bash
   adb logcat | grep "Video recording"
   ```

3. **Check Streaming Callbacks**

   ```java
   StreamingStatusCallback callback = streamingManager.getStreamingStatusCallback();
   if (callback == null) {
       Log.e(TAG, "Streaming callback is null");
   }
   ```

4. **Check Permissions**
   ```java
   if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
       != PackageManager.PERMISSION_GRANTED) {
       Log.e(TAG, "Camera permission not granted");
   }
   ```

#### Common Causes

- Camera permissions not granted
- Streaming service not initialized
- Network connectivity issues
- RTMP URL configuration issues

#### Solutions

```java
// Check camera permissions
if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
    != PackageManager.PERMISSION_GRANTED) {
    Log.e(TAG, "Camera permission required for streaming");
    return;
}

// Check network connectivity
if (!stateManager.isConnectedToWifi()) {
    Log.e(TAG, "WiFi not connected, cannot start streaming");
    return;
}

// Validate RTMP URL
if (rtmpUrl == null || rtmpUrl.isEmpty()) {
    Log.e(TAG, "RTMP URL is invalid");
    return;
}
```

## Performance Monitoring

### Memory Usage Monitoring

```java
// Monitor service memory usage
Runtime runtime = Runtime.getRuntime();
long usedMemory = runtime.totalMemory() - runtime.freeMemory();
long maxMemory = runtime.maxMemory();
long freeMemory = runtime.freeMemory();

Log.d(TAG, "Memory Usage - Used: " + usedMemory + " bytes, Max: " + maxMemory + " bytes, Free: " + freeMemory + " bytes");
```

### Component Performance Monitoring

```java
// Monitor manager performance
long startTime = System.currentTimeMillis();
// ... manager operation ...
long endTime = System.currentTimeMillis();
long duration = endTime - startTime;

if (duration > 100) { // Log slow operations
    Log.w(TAG, "Manager operation took: " + duration + "ms");
}
```

### Command Processing Performance

```java
// Monitor command processing time
long startTime = System.currentTimeMillis();
commandProcessor.processJsonCommand(jsonObject);
long endTime = System.currentTimeMillis();
long duration = endTime - startTime;

Log.d(TAG, "Command processing took: " + duration + "ms");
```

## Debugging Tools and Commands

### ADB Commands

```bash
# Filter logs by service
adb logcat | grep "AsgClientService"

# Filter logs by component
adb logcat | grep "ServiceContainer"
adb logcat | grep "CommandProcessor"
adb logcat | grep "CommunicationManager"

# Filter logs by log level
adb logcat *:E | grep "AsgClientService"  # Errors only
adb logcat *:W | grep "AsgClientService"  # Warnings and above
adb logcat *:D | grep "AsgClientService"  # Debug and above

# Clear logs and start fresh
adb logcat -c
adb logcat | grep "AsgClientService"
```

### Log Analysis Scripts

```bash
# Count log entries by component
adb logcat | grep "AsgClientService" | awk '{print $5}' | sort | uniq -c

# Find error patterns
adb logcat | grep "AsgClientService" | grep -i error

# Monitor specific operations
adb logcat | grep "AsgClientService" | grep "WiFi\|Bluetooth\|Battery"
```

### Debug Configuration

```java
// Enable debug logging
if (BuildConfig.DEBUG) {
    Log.d(TAG, "Debug mode enabled - verbose logging active");
}

// Add debug information
Log.d(TAG, "Service state - WiFi: " + stateManager.isConnectedToWifi() +
           ", Bluetooth: " + stateManager.isBluetoothConnected() +
           ", Battery: " + stateManager.getBatteryLevel() + "%");
```

## Testing and Validation

### Unit Testing

```java
// Test service container
@Test
public void testServiceContainerInitialization() {
    ServiceContainer container = new ServiceContainer(context);
    assertNotNull(container.getLifecycleManager());
    assertNotNull(container.getCommunicationManager());
    assertNotNull(container.getStateManager());
    assertNotNull(container.getStreamingManager());
}

// Test command processing
@Test
public void testCommandProcessing() {
    JSONObject command = new JSONObject();
    command.put("type", "test_command");
    command.put("data", "test_data");

    commandProcessor.processJsonCommand(command);
    // Verify response
}
```

### Integration Testing

```java
// Test service lifecycle
@Test
public void testServiceLifecycle() {
    // Start service
    Intent intent = new Intent(context, AsgClientService.class);
    context.startService(intent);

    // Verify service started
    assertTrue(isServiceRunning(AsgClientService.class));

    // Stop service
    context.stopService(intent);

    // Verify service stopped
    assertFalse(isServiceRunning(AsgClientService.class));
}
```

## Conclusion

This debugging reference provides comprehensive tools and techniques for troubleshooting issues in the `AsgClientService` package. The modular architecture makes it easy to isolate and resolve problems by focusing on specific components and their interactions.

Key debugging principles:

1. **Use appropriate log levels** (D for debug, W for warnings, E for errors)
2. **Monitor component initialization** and state
3. **Check permissions** and system requirements
4. **Validate data** before processing
5. **Monitor performance** for bottlenecks
6. **Use ADB commands** for real-time debugging
7. **Write unit tests** for component validation

The SOLID architecture makes debugging much easier by providing clear separation of concerns and well-defined interfaces for each component.
