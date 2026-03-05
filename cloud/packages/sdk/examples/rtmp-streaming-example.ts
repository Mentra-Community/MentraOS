/**
 * RTMP Streaming Example
 *
 * This example demonstrates how to use the MentraOS SDK to request
 * and manage RTMP streaming from smart glasses.
 *
 * The SDK uses the AppServer pattern — you create an AppServer with your
 * credentials and implement `onSession()` to handle user sessions.
 * The WebSocket URL is provided automatically by MentraOS Cloud via webhook;
 * you never need to specify it yourself.
 */
import { AppServer, AppSession, RtmpStreamStatus } from "../";

// Create app server with your credentials
const app = new AppServer({
  packageName: "com.example.streaming-demo",
  apiKey: "your-api-key",
  port: 7010,
});

// Handle new user sessions
app.onSession = async (session: AppSession, sessionId: string, userId: string) => {
  console.log(`New session for user ${userId}`);

  // Set up stream status handler
  setupStreamStatusHandler(session);

  // Request a stream once connected
  await requestStream(session);

  // After some time, stop the stream
  setTimeout(() => stopStream(session), 60000); // 1 minute
};

// Set up handler for stream status updates
function setupStreamStatusHandler(session: AppSession) {
  session.camera.onStreamStatus((status: RtmpStreamStatus) => {
    console.log(`Stream status: ${status.status}`);

    // Log detailed information if available
    if (status.stats) {
      console.log(
        `Stream stats: Bitrate=${status.stats.bitrate} bps, FPS=${status.stats.fps}, Dropped=${status.stats.droppedFrames}, Duration=${status.stats.duration}s`,
      );
    }

    switch (status.status) {
      case "initializing":
        console.log("Stream is initializing...");
        break;
      case "streaming":
        console.log("Stream is actively streaming!");
        break;
      case "active":
        console.log("Stream is active and running!");
        break;
      case "error":
        console.error(`Stream error: ${status.errorDetails}`);
        break;
      case "stopped":
        console.log("Stream has stopped");
        break;
    }
  });
}

// Request an RTMP stream
async function requestStream(session: AppSession) {
  try {
    await session.camera.startStream({
      rtmpUrl: "rtmp://your-rtmp-server.com/live/stream-key",
      video: {
        width: 1280,
        height: 720,
        bitrate: 1500000, // 1.5 Mbps
        frameRate: 30,
      },
    });
    console.log("Stream request sent successfully");
  } catch (error) {
    console.error("Error requesting stream:", error);
  }
}

// Stop the stream
async function stopStream(session: AppSession) {
  try {
    await session.camera.stopStream();
    console.log("Stop stream request sent successfully");
  } catch (error) {
    console.error("Error stopping stream:", error);
  }
}

// Start the server — MentraOS Cloud sends session webhooks here automatically
app.start().then(() => {
  console.log("Streaming demo app is running");
});
