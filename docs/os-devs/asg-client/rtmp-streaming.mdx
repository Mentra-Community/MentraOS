# RTMP Streaming

The ASG Client supports live video streaming via RTMP (Real-Time Messaging Protocol), allowing real-time video transmission from the glasses to remote servers.

## Overview

RTMP streaming enables:

- Live video broadcasting from glasses
- Real-time video analysis by apps
- Remote assistance scenarios
- Video recording to cloud servers

## RTMP Commands

The system uses four main commands for RTMP control:

### 1. start_rtmp_stream

Initiates an RTMP stream to a specified URL.

**Command Structure:**

```json
{
  "type": "start_rtmp_stream",
  "rtmpUrl": "rtmp://server.com/live/stream-key",
  "streamId": "unique-stream-id",
  "video": {
    "width": 1280,
    "height": 720,
    "bitrate": 2000000
  }
}
```

**Requirements:**

- Active WiFi connection
- Valid RTMP URL
- Sufficient bandwidth

**Response:**

```json
{
  "type": "rtmp_stream_status",
  "status": "initializing",
  "streamId": "unique-stream-id"
}
```

### 2. stop_rtmp_stream

Terminates the active RTMP stream.

**Command Structure:**

```json
{
  "type": "stop_rtmp_stream",
  "streamId": "unique-stream-id"
}
```

**Response:**

```json
{
  "type": "rtmp_stream_status",
  "status": "stopped",
  "streamId": "unique-stream-id"
}
```

### 3. keep_rtmp_stream_alive

Keep-alive mechanism to prevent stream timeout. Must be sent at least every 60 seconds.

**Command Structure:**

```json
{
  "type": "keep_rtmp_stream_alive",
  "streamId": "unique-stream-id",
  "ackId": "unique-ack-id",
  "timestamp": "2024-01-01T12:00:00Z"
}
```

**ACK Response (from glasses):**

```json
{
  "type": "keep_alive_ack",
  "streamId": "unique-stream-id",
  "ackId": "unique-ack-id",
  "timestamp": 1234567890
}
```

### 4. get_rtmp_status

Queries the current streaming status.

**Command Structure:**

```json
{
  "type": "get_rtmp_status"
}
```

**Response:**

```json
{
  "type": "rtmp_stream_status",
  "status": "active", // or "stopped", "error", etc.
  "streamId": "unique-stream-id",
  "stats": {
    "bitrate": 1950000,
    "fps": 30,
    "droppedFrames": 5
  }
}
```

## Stream Lifecycle

### Starting a Stream

1. **Request received**: Phone sends `start_rtmp_stream` via BLE
2. **WiFi check**: Verify WiFi connection is active
3. **Stream init**: Initialize RTMP encoder and connection
4. **Start streaming**: Begin sending video data
5. **Status updates**: Send status back to phone/cloud

### Keep-Alive Mechanism

The stream has a **60-second timeout** that requires periodic keep-alive messages:

1. **Cloud sends keep-alive** every 15 seconds with unique `ackId`
2. **Glasses reset timeout** and respond with ACK containing same `ackId`
3. **If no keep-alive for 60 seconds**, stream automatically stops
4. **If 3 ACKs are missed**, cloud marks connection as degraded

```
Cloud → Glasses: keep_rtmp_stream_alive (every 15s)
Glasses → Cloud: keep_alive_ack (immediate response)
```

### Stopping a Stream

Streams can stop in three ways:

1. **Explicit stop**: Via `stop_rtmp_stream` command
2. **Timeout**: No keep-alive received for 60 seconds
3. **Error**: Network failure, encoder error, etc.

## Implementation Details

### RtmpStreamingService

The main service handling RTMP streaming:

```java
// Start streaming
RtmpStreamingService.startStreaming(context, rtmpUrl);

// Stop streaming
RtmpStreamingService.stopStreaming(context);

// Check status
boolean isStreaming = RtmpStreamingService.isStreaming();
```

### Stream Timeout Handling

```java
// In AsgClientService
case "keep_rtmp_stream_alive":
    String streamId = dataToProcess.optString("streamId", "");
    String ackId = dataToProcess.optString("ackId", "");

    // Reset the 60-second timeout
    RtmpStreamingService.resetStreamTimeout(streamId);

    // Send ACK back
    sendKeepAliveAck(streamId, ackId);
    break;
```

### Status Messages

The glasses send various status updates during streaming:

- `initializing` - Stream setup in progress
- `active` - Streaming successfully
- `reconnecting` - Attempting to reconnect after failure
- `error` - Stream failed with error details
- `stopped` - Stream terminated
- `timeout` - Stream stopped due to keep-alive timeout

## Network Requirements

### Bandwidth

- Minimum: 1 Mbps upload
- Recommended: 2-3 Mbps upload
- Adapts bitrate based on connection

### WiFi Stability

- Requires stable WiFi connection
- Automatic reconnection on brief disconnects
- Stops on extended network loss

## Error Handling

### Common Errors

1. **No WiFi Connection**

   ```json
   {
     "status": "error",
     "error": "no_wifi_connection"
   }
   ```

2. **Invalid RTMP URL**

   ```json
   {
     "status": "error",
     "error": "invalid_rtmp_url"
   }
   ```

3. **Stream Timeout**
   ```json
   {
     "status": "error",
     "errorDetails": "Stream timed out - no keep-alive from cloud"
   }
   ```

### Recovery Mechanisms

- **Auto-reconnect**: Attempts reconnection on temporary failures
- **Backoff strategy**: Increasing delays between reconnection attempts
- **Clean shutdown**: Proper resource cleanup on errors

## Best Practices

1. **Always send keep-alives** at 15-second intervals
2. **Monitor ACK responses** to detect connection issues
3. **Handle status updates** to show stream state in UI
4. **Implement proper cleanup** when app disconnects
5. **Check WiFi** before starting streams
6. **Use unique streamIds** for tracking

## Debugging

### Log Filters

```bash
# All RTMP logs
adb logcat | grep -E "RtmpStreaming|RTMP"

# Keep-alive activity
adb logcat | grep "keep_rtmp_stream_alive\|keep_alive_ack"

# Stream status
adb logcat | grep "rtmp_stream_status"
```

### Common Issues

1. **Stream stops after ~5 minutes**: Check keep-alive implementation
2. **ACKs not received**: Verify BLE communication both ways
3. **Poor quality**: Check WiFi signal strength and bandwidth
4. **Can't start stream**: Ensure only one stream active at a time
