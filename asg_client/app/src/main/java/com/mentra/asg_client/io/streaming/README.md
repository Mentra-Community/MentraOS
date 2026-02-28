# Streaming I/O Package

A comprehensive streaming management system for the ASG client that provides unified streaming operations across different protocols, with a focus on RTMP streaming using StreamPackLite.

## 📁 Package Structure

```
io/streaming/
├── interfaces/
│   ├── IStreamingService.java           # Core streaming interface
│   ├── StreamingStatusCallback.java     # Streaming status callback
│   └── StreamingEventListener.java      # Streaming event listener
├── core/
│   ├── BaseStreamingService.java        # Abstract base streaming service
│   ├── StreamingServiceFactory.java     # Factory for streaming services
│   └── StreamingManager.java            # Central streaming manager
├── services/
│   ├── RtmpStreamingService.java        # RTMP streaming service implementation
│   └── StreamingServiceBinder.java      # Service binder implementation
├── events/
│   ├── StreamingCommand.java            # Streaming commands
│   ├── StreamingEvent.java              # Streaming events
│   └── StreamingEventBus.java           # Event bus wrapper
├── ui/
│   ├── StreamingActivity.java           # Streaming activity
│   ├── RtmpStreamingFragment.java       # RTMP streaming fragment
│   └── StreamingUIHelper.java           # UI helper utilities
├── utils/
│   ├── StreamingUtils.java              # Streaming utilities
│   ├── RtmpUtils.java                   # RTMP-specific utilities
│   └── StreamingNotificationManager.java # Notification management
└── README.md                            # This documentation
```

## 🔧 Components

### **Streaming Interfaces**

#### **IStreamingService**

Core interface for streaming management operations:

- `initialize(Context context)` - Initialize the streaming service
- `setStreamingUrl(String url)` - Set the streaming URL
- `getStreamingUrl()` - Get the current streaming URL
- `startStreaming()` - Start streaming
- `stopStreaming()` - Stop streaming
- `isStreaming()` - Check if currently streaming
- `isReconnecting()` - Check if currently reconnecting
- `getReconnectionAttempt()` - Get current reconnection attempt
- `setStreamingStatusCallback(StreamingStatusCallback callback)` - Set status callback
- `removeStreamingStatusCallback()` - Remove status callback
- `getStatistics()` - Get streaming statistics
- `shutdown()` - Cleanup resources

#### **StreamingStatusCallback**

Interface for receiving streaming status updates:

- `onStreamStarting(String streamingUrl)` - Streaming starting
- `onStreamStarted(String streamingUrl)` - Streaming started
- `onStreamStopped()` - Streaming stopped
- `onReconnecting(int attempt, int maxAttempts, String reason)` - Reconnecting
- `onReconnected(String streamingUrl, int attempt)` - Reconnected
- `onReconnectFailed(int maxAttempts)` - Reconnection failed
- `onStreamError(String error)` - Streaming error

#### **StreamingEventListener**

Interface for listening to streaming events:

- `onStreamerReady()` - Streamer ready
- `onPreviewAttached()` - Preview attached
- `onStreamInitializing()` - Stream initializing
- `onStreamStarted()` - Stream started
- `onStreamStopped()` - Stream stopped
- `onConnected()` - Connected
- `onConnectionFailed(String message)` - Connection failed
- `onDisconnected()` - Disconnected
- `onError(String message)` - Error occurred

### **Streaming Events**

#### **StreamingCommand**

Commands that can be sent to streaming services:

- **Start** - Start streaming
- **Stop** - Stop streaming
- **SetRtmpUrl** - Set RTMP URL
- **LaunchActivity** - Launch streaming activity
- **SwitchCamera** - Switch camera (front/back)
- **ToggleFlash** - Toggle flash
- **SetMute** - Mute/unmute audio

#### **StreamingEvent**

Events emitted by streaming services:

- **Ready** - Streamer ready
- **PreviewAttached** - Preview attached
- **Initializing** - Stream initializing
- **Started** - Stream started
- **Stopped** - Stream stopped
- **Connected** - Connected
- **ConnectionFailed** - Connection failed
- **Disconnected** - Disconnected
- **Error** - Error occurred

### **Streaming Services**

#### **RtmpStreamingService**

RTMP streaming service implementation using StreamPackLite:

- **RTMP Streaming**: Full RTMP streaming capabilities
- **Reconnection Logic**: Robust reconnection with exponential backoff
- **Error Handling**: Comprehensive error handling and recovery
- **Notification Management**: User-friendly notifications
- **Wake Lock Management**: Prevents device sleep during streaming
- **Surface Management**: Camera preview surface handling
- **Timeout Management**: Stream timeout detection and handling
- **Statistics Tracking**: Real-time streaming statistics

### **Streaming UI Components**

#### **StreamingActivity**

Main streaming activity for user interaction:

- **Preview Display**: Camera preview using PreviewView
- **Stream Control**: Start/stop streaming controls
- **Status Display**: Real-time streaming status
- **Service Binding**: Binds to RtmpStreamingService
- **Event Handling**: Handles streaming events via EventBus

#### **RtmpStreamingFragment**

Fragment for RTMP streaming demonstration:

- **UI Controls**: Complete streaming control interface
- **Camera Controls**: Switch camera and toggle flash
- **URL Input**: RTMP URL input field
- **Status Updates**: Real-time status updates
- **Service Integration**: Full service integration

### **Streaming Utilities**

#### **StreamingUtils**

Utility class for streaming operations:

- **URL Validation**: RTMP URL format validation
- **URL Parsing**: Extract stream key and server URL
- **Formatting**: Duration, bitrate, and file size formatting
- **Device Capability**: Check device streaming capability
- **Stream ID Generation**: Generate unique stream IDs

#### **StreamingNotificationManager**

Notification management for streaming:

- **Streaming Notifications**: Active streaming notifications
- **Reconnecting Notifications**: Reconnection status notifications
- **Error Notifications**: Error notifications
- **Notification Channels**: Android O+ notification channels
- **Server Name Extraction**: Extract server names for display

## 🚀 Usage Examples

### **Basic Streaming Setup**

```java
// Get streaming service
RtmpStreamingService streamingService = new RtmpStreamingService();

// Initialize
streamingService.initialize(context);

// Set streaming URL
streamingService.setStreamingUrl("rtmp://server.com/live/streamkey");

// Set status callback
streamingService.setStreamingStatusCallback(new StreamingStatusCallback() {
    @Override
    public void onStreamStarting(String streamingUrl) {
        Log.d("Streaming", "Starting stream to: " + streamingUrl);
    }

    @Override
    public void onStreamStarted(String streamingUrl) {
        Log.d("Streaming", "Stream started: " + streamingUrl);
    }

    @Override
    public void onStreamStopped() {
        Log.d("Streaming", "Stream stopped");
    }

    @Override
    public void onReconnecting(int attempt, int maxAttempts, String reason) {
        Log.d("Streaming", "Reconnecting: " + attempt + "/" + maxAttempts);
    }

    @Override
    public void onReconnected(String streamingUrl, int attempt) {
        Log.d("Streaming", "Reconnected on attempt: " + attempt);
    }

    @Override
    public void onReconnectFailed(int maxAttempts) {
        Log.e("Streaming", "Reconnection failed after " + maxAttempts + " attempts");
    }

    @Override
    public void onStreamError(String error) {
        Log.e("Streaming", "Stream error: " + error);
    }
});

// Start streaming
boolean success = streamingService.startStreaming();
if (success) {
    Log.d("Streaming", "Streaming started successfully");
} else {
    Log.e("Streaming", "Failed to start streaming");
}
```

### **Streaming Commands and Events**

```java
// Send streaming commands via EventBus
EventBus.getDefault().post(new StreamingCommand.Start());
EventBus.getDefault().post(new StreamingCommand.Stop());
EventBus.getDefault().post(new StreamingCommand.SetRtmpUrl("rtmp://server.com/live/streamkey"));
EventBus.getDefault().post(new StreamingCommand.SwitchCamera());
EventBus.getDefault().post(new StreamingCommand.SetMute(true));

// Listen for streaming events
@Subscribe(threadMode = ThreadMode.MAIN)
public void onStreamingEvent(StreamingEvent event) {
    if (event instanceof StreamingEvent.Ready) {
        Log.d("Streaming", "Streamer ready");
    } else if (event instanceof StreamingEvent.Started) {
        Log.d("Streaming", "Stream started");
    } else if (event instanceof StreamingEvent.Stopped) {
        Log.d("Streaming", "Stream stopped");
    } else if (event instanceof StreamingEvent.Connected) {
        Log.d("Streaming", "Connected to server");
    } else if (event instanceof StreamingEvent.Error) {
        StreamingEvent.Error errorEvent = (StreamingEvent.Error) event;
        Log.e("Streaming", "Error: " + errorEvent.getMessage());
    }
}
```

### **Streaming Utilities**

```java
// Validate RTMP URL
String rtmpUrl = "rtmp://server.com/live/streamkey";
if (StreamingUtils.isValidRtmpUrl(rtmpUrl)) {
    Log.d("Streaming", "Valid RTMP URL");

    // Extract components
    String streamKey = StreamingUtils.extractStreamKey(rtmpUrl);
    String serverUrl = StreamingUtils.extractServerUrl(rtmpUrl);

    Log.d("Streaming", "Stream Key: " + streamKey);
    Log.d("Streaming", "Server URL: " + serverUrl);
}

// Format streaming data
long duration = 125000; // 2 minutes 5 seconds
String formattedDuration = StreamingUtils.formatDuration(duration);
Log.d("Streaming", "Duration: " + formattedDuration); // "02:05"

int bitrate = 2500000; // 2.5 Mbps
String formattedBitrate = StreamingUtils.formatBitrate(bitrate);
Log.d("Streaming", "Bitrate: " + formattedBitrate); // "2.5 Mbps"

// Check device capability
if (StreamingUtils.canDeviceStream(context)) {
    Log.d("Streaming", "Device can stream");
} else {
    Log.w("Streaming", "Device cannot stream");
}

// Generate stream ID
String streamId = StreamingUtils.generateStreamId();
Log.d("Streaming", "Stream ID: " + streamId);
```

### **Notification Management**

```java
// Create notification manager
StreamingNotificationManager notificationManager = new StreamingNotificationManager(context);

// Show streaming notification
notificationManager.showStreamingNotification("rtmp://server.com/live/streamkey", 60000);

// Show reconnecting notification
notificationManager.showReconnectingNotification(3, 10, "Network timeout");

// Show error notification
notificationManager.showErrorNotification("Connection failed");

// Update streaming notification
notificationManager.updateStreamingNotification("rtmp://server.com/live/streamkey", 120000);

// Cancel notifications
notificationManager.cancelStreamingNotification();
notificationManager.cancelAllNotifications();
```

### **Service Integration**

```java
// Start streaming service
public static void startStreaming(Context context, String rtmpUrl) {
    Intent intent = new Intent(context, RtmpStreamingService.class);
    intent.putExtra("rtmp_url", rtmpUrl);

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent);
    } else {
        context.startService(intent);
    }
}

// Stop streaming service
public static void stopStreaming(Context context) {
    Intent intent = new Intent(context, RtmpStreamingService.class);
    context.stopService(intent);
}

// Check streaming status
public static boolean isStreaming() {
    return RtmpStreamingService.isStreaming();
}

public static boolean isReconnecting() {
    return RtmpStreamingService.isReconnecting();
}
```

## 🔄 Streaming Workflow

### **RTMP Streaming Workflow**

1. **Initialization**: Streaming service is initialized
2. **URL Configuration**: RTMP URL is set
3. **Camera Setup**: Camera preview surface is created
4. **Streamer Initialization**: StreamPackLite streamer is initialized
5. **Connection**: RTMP connection is established
6. **Streaming**: Video and audio streaming begins
7. **Monitoring**: Connection and performance are monitored
8. **Reconnection**: Automatic reconnection on connection loss
9. **Cleanup**: Resources are cleaned up on stop

### **Reconnection Workflow**

1. **Connection Loss**: Connection is lost or fails
2. **Failure Detection**: Failure is detected and logged
3. **Retry Logic**: Exponential backoff retry logic is applied
4. **Reconnection Attempt**: Reconnection is attempted
5. **Success/Failure**: Reconnection succeeds or fails
6. **Max Attempts**: If max attempts reached, streaming stops
7. **Recovery**: If successful, streaming resumes

### **Error Handling Workflow**

1. **Error Detection**: Error is detected in streaming process
2. **Error Classification**: Error is classified as retryable or non-retryable
3. **Retryable Errors**: Network errors trigger reconnection
4. **Non-Retryable Errors**: Fatal errors stop streaming
5. **User Notification**: User is notified of errors
6. **Logging**: Errors are logged for debugging
7. **Recovery**: System attempts to recover from errors

## 🛡️ Features

### **Multi-Protocol Support**

- **RTMP**: Real-time messaging protocol streaming
- **RTMPS**: Secure RTMP streaming
- **RTMPT**: RTMP tunneling
- **Extensible**: Easy to add new protocols

### **Robust Streaming**

- **Reconnection Logic**: Automatic reconnection with exponential backoff
- **Error Handling**: Comprehensive error handling and recovery
- **Timeout Management**: Stream timeout detection and handling
- **Performance Monitoring**: Real-time performance monitoring

### **Advanced Features**

- **Camera Control**: Switch between front and back cameras
- **Flash Control**: Toggle camera flash
- **Audio Control**: Mute/unmute audio
- **Preview Management**: Camera preview handling
- **Surface Management**: Efficient surface management

### **User Experience**

- **Notifications**: User-friendly streaming notifications
- **Status Updates**: Real-time streaming status updates
- **Error Reporting**: Clear error reporting and diagnostics
- **Progress Tracking**: Streaming progress tracking

### **Performance Optimization**

- **Memory Management**: Efficient memory usage
- **Battery Optimization**: Battery-efficient streaming
- **Wake Lock Management**: Prevents device sleep during streaming
- **Resource Management**: Proper resource cleanup

## 📈 Benefits

1. **Unified Interface**: Single interface for all streaming operations
2. **Protocol Agnostic**: Works across different streaming protocols
3. **High Performance**: Optimized for performance and efficiency
4. **Reliable**: Robust error handling and recovery
5. **Extensible**: Easy to add new streaming protocols and features
6. **User Friendly**: Clear user feedback and notifications
7. **Debug Friendly**: Comprehensive debugging and logging

## 🔮 Future Enhancements

- **WebRTC Support**: Real-time communication via WebRTC
- **HLS Streaming**: HTTP Live Streaming support
- **DASH Streaming**: Dynamic Adaptive Streaming over HTTP
- **Multi-Stream**: Support for multiple simultaneous streams
- **Cloud Integration**: Cloud-based streaming management
- **Analytics**: Streaming analytics and insights
- **Quality Adaptation**: Adaptive bitrate streaming
- **Recording**: Local stream recording capabilities

---

This Streaming I/O package provides a comprehensive, high-performance foundation for all streaming operations in the ASG client system, supporting multiple protocols with robust error handling and advanced features.
