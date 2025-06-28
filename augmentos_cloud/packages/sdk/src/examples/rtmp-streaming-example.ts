/**
 * RTMP Streaming Example
 *
 * This example demonstrates how to use the MentraOS SDK to request
 * and manage RTMP streaming from smart glasses.
 */
import { RtmpStreamStatus } from 'src/types';
import { AppSession } from '../app/session';
// import type { StreamStatus } from '../app/session/modules/streaming';

// Initialize App session
const session = new AppSession({
  packageName: 'com.example.streaming-demo',
  apiKey: 'your-api-key',
  userId: 'example-user@example.com',
  appServer: {} as any, // In a real app, this would be a AppServer instance
  // In a real app, this would be the production server URL
  mentraOSWebsocketUrl: 'ws://localhost:8002/app-ws'
});

// Connect to MentraOS Cloud
async function startApp() {
  try {
    // Connect with a session ID
    await session.connect('streaming-demo-session');
    console.log('Connected to MentraOS Cloud');

    // Set up status handler
    setupStreamStatusHandler();

    // Request a stream
    await requestStream();

    // After some time, stop the stream
    setTimeout(stopStream, 60000); // 1 minute
  } catch (error) {
    console.error('Error starting app:', error);
  }
}

// Set up handler for stream status updates
function setupStreamStatusHandler() {
  // Register a handler for stream status updates
  const cleanup = session.streaming.onStatus((status: RtmpStreamStatus) => {
    console.log(`Stream status: ${status.status}`);

    // Log detailed information if available
    if (status.stats) {
      console.log(`Stream stats:
        Bitrate: ${status.stats.bitrate} bps
        FPS: ${status.stats.fps}
        Dropped frames: ${status.stats.droppedFrames}
        Duration: ${status.stats.duration} seconds
      `);
    }

    // Handle different status types
    switch (status.status) {
      case 'initializing':
        console.log('Stream is initializing...');
        break;
      case 'streaming':
        console.log('Stream is actively streaming!');
        break;
      case 'active':
        console.log('Stream is active and running!');
        break;
      case 'error':
        console.error(`Stream error: ${status.errorDetails}`);
        break;
      case 'stopped':
        console.log('Stream has stopped');
        // Clean up resources or update UI as needed
        break;
    }
  });

  // Store the cleanup function somewhere if you need to unregister later
  // For this example, we'll just let it run for the lifetime of the app
}

// Request an RTMP stream
async function requestStream() {
  try {
    // Request a stream with configuration
    await session.streaming.requestStream({
      rtmpUrl: 'rtmp://your-rtmp-server.com/live/stream-key',
      video: {
        width: 1280,
        height: 720,
        bitrate: 1500000, // 1.5 Mbps
        frameRate: 30
      }
    });

    console.log('Stream request sent successfully');
  } catch (error) {
    console.error('Error requesting stream:', error);
  }
}

// Stop the stream
async function stopStream() {
  try {
    await session.streaming.stopStream();
    console.log('Stop stream request sent successfully');
  } catch (error) {
    console.error('Error stopping stream:', error);
  }
}

// Error handling
session.events.on('error', (error) => {
  console.error('Session error:', error);
});

// Start the app
startApp();