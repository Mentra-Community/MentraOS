# RTMP Streaming

The MentraOS SDK provides the capability to request RTMP streams directly from connected smart glasses. This feature is useful for applications that need to broadcast the camera feed to streaming platforms, conduct remote inspections, or implement surveillance features.

## Overview

RTMP (Real-Time Messaging Protocol) is widely used for live streaming to platforms like YouTube, Twitch, Facebook Live, and custom streaming servers. The MentraOS SDK allows Third-Party Applications (TPAs) to request the smart glasses to stream their camera feed to any RTMP endpoint.

## Requirements

- An RTMP endpoint URL (e.g., `rtmp://your-streaming-server.com/live/stream-key`)
- Connected smart glasses with streaming capability
- Proper permissions in your TPA's manifest

## Basic Usage

Here's a simple example of how to start an RTMP stream:

```typescript
// Request a basic RTMP stream with default settings
await client.streaming.requestStream({
  rtmpUrl: 'rtmp://streaming-server.example.com/live/stream-key'
});

// Later, when you want to stop streaming
await client.streaming.stopStream();
```

## Enhanced Configuration

The SDK supports advanced configuration options for video and audio parameters:

```typescript
// Request an RTMP stream with enhanced configuration
await client.streaming.requestStream({
  rtmpUrl: 'rtmp://streaming-server.example.com/live/stream-key',

  // Video configuration
  video: {
    width: 1280,
    height: 720,
    bitrate: 2000000,  // 2 Mbps
    frameRate: 30
  },

  // Audio configuration
  audio: {
    bitrate: 128000,  // 128 kbps
    sampleRate: 44100,  // 44.1 kHz
    echoCancellation: true,
    noiseSuppression: true
  },

  // Stream configuration
  stream: {
    durationLimit: 1800  // 30 minutes max duration
  }
});
```

## Configuration Options

### Video Configuration

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `width` | number | Video width in pixels | Device default (typically 1280) |
| `height` | number | Video height in pixels | Device default (typically 720) |
| `bitrate` | number | Video bitrate in bits per second | Device default (typically 2,000,000) |
| `frameRate` | number | Frames per second | Device default (typically 30) |

### Audio Configuration

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `bitrate` | number | Audio bitrate in bits per second | Device default (typically 128,000) |
| `sampleRate` | number | Audio sample rate in Hz | Device default (typically 44,100) |
| `echoCancellation` | boolean | Enable echo cancellation | `false` |
| `noiseSuppression` | boolean | Enable noise suppression | `false` |

### Stream Configuration

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `durationLimit` | number | Maximum stream duration in seconds | No limit |

## Monitoring Stream Status

You can monitor the status of your RTMP stream by registering a status change handler:

```typescript
// Register a status change handler
const unsubscribe = client.streaming.onStatusChange((status) => {
  console.log(`Stream status: ${status.status}`);

  if (status.status === 'active') {
    console.log('Stream is now live!');

    // You can also access performance statistics
    if (status.stats) {
      console.log(`Current bitrate: ${status.stats.bitrate} bps`);
      console.log(`Current FPS: ${status.stats.fps}`);
    }
  } else if (status.status === 'error') {
    console.error(`Stream error: ${status.errorDetails}`);
  }
});

// Later, unsubscribe when no longer needed
unsubscribe();
```

## Stream Status States

The stream can be in one of the following states:

- `initializing`: The stream is being set up
- `active`: The stream is running and broadcasting
- `busy`: Another app is currently streaming
- `error`: An error occurred while streaming
- `stopped`: The stream has been stopped

## Best Practices

1. **Network Conditions**: Consider the network conditions when setting bitrates. For unreliable networks, use lower bitrates.

2. **Battery Usage**: Streaming is battery-intensive. Consider setting a duration limit to prevent excessive battery drain.

3. **User Notification**: Always notify the user when streaming is active, and provide a clear way to stop the stream.

4. **Error Handling**: Always handle potential stream errors gracefully.

5. **Privacy Considerations**: Respect user privacy by ensuring users are aware when their camera feed is being streamed.

## Limitations

- Not all smart glasses models support all configuration options
- Streaming performance is dependent on network conditions and device capabilities
- Extended streaming may cause battery drain and device heating

## Example: Complete Streaming Implementation

Here's a more complete example showing how to implement RTMP streaming in a React application:

```typescript
import React, { useState, useEffect } from 'react';
import { Button, Text, View } from 'react-native';
import { useMentraOS } from '@mentra/sdk-react';
import type { StreamStatus } from '@mentra/sdk';

export function StreamingComponent() {
  const { client } = useMentraOS();
  const [streamStatus, setStreamStatus] = useState<StreamStatus | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);

  useEffect(() => {
    // Set up status monitoring
    const unsubscribe = client.streaming.onStatusChange((status) => {
      setStreamStatus(status);

      if (status.status === 'stopped' || status.status === 'error') {
        setIsStreaming(false);
      } else if (status.status === 'active') {
        setIsStreaming(true);
      }
    });

    // Clean up on component unmount
    return () => {
      // Stop any active stream when component unmounts
      if (client.streaming.isCurrentlyStreaming()) {
        client.streaming.stopStream();
      }
      unsubscribe();
    };
  }, [client]);

  const startStream = async () => {
    try {
      await client.streaming.requestStream({
        rtmpUrl: 'rtmp://your-streaming-server.com/live/stream-key',
        video: {
          width: 1280,
          height: 720,
          bitrate: 2000000,
          frameRate: 30
        },
        audio: {
          bitrate: 128000,
          echoCancellation: true,
          noiseSuppression: true
        }
      });
    } catch (error) {
      console.error('Failed to start stream', error);
    }
  };

  const stopStream = async () => {
    try {
      await client.streaming.stopStream();
    } catch (error) {
      console.error('Failed to stop stream', error);
    }
  };

  return (
    <View>
      <Text>Stream Status: {streamStatus?.status || 'Unknown'}</Text>

      {streamStatus?.stats && (
        <View>
          <Text>Bitrate: {streamStatus.stats.bitrate} bps</Text>
          <Text>FPS: {streamStatus.stats.fps}</Text>
          <Text>Duration: {streamStatus.stats.duration}s</Text>
        </View>
      )}

      {isStreaming ? (
        <Button title="Stop Streaming" onPress={stopStream} />
      ) : (
        <Button title="Start Streaming" onPress={startStream} />
      )}
    </View>
  );
}
```