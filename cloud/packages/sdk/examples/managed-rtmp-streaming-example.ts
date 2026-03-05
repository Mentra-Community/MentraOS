/**
 * Managed RTMP Streaming Example
 *
 * This example demonstrates how to use the MentraOS SDK's managed streaming
 * feature. With managed streaming, you don't need your own RTMP server -
 * MentraOS handles all the infrastructure and provides viewer URLs.
 *
 * The SDK uses the AppServer pattern — you create an AppServer with your
 * credentials and implement `onSession()` to handle user sessions.
 * The WebSocket URL is provided automatically by MentraOS Cloud via webhook;
 * you never need to specify it yourself.
 *
 * Perfect for:
 * - Social media streaming (X, YouTube Live, TikTok Live)
 * - Quick demos and prototypes
 * - Production apps without existing streaming infrastructure
 *
 * NEW: You can now add re-streaming to multiple platforms! See
 * managed-rtmp-streaming-with-restream-example.ts for details.
 */
import { AppServer, AppSession, StreamType, ManagedStreamStatus } from "../";

// Track current stream for cleanup
let currentStreamId: string | null = null;
let activeSession: AppSession | null = null;

// Create app server with your credentials
const app = new AppServer({
  packageName: "com.example.managed-streaming",
  apiKey: "your-api-key",
  port: 7010,
});

// Handle new user sessions
app.onSession = async (session: AppSession, sessionId: string, userId: string) => {
  console.log(`New session for user ${userId}`);
  activeSession = session;

  // Subscribe to stream status updates
  session.subscribe(StreamType.MANAGED_STREAM_STATUS);
  setupStreamStatusHandler(session);

  // Start managed streaming
  await startManagedStream(session);

  // Keep streaming for 2 minutes then stop
  setTimeout(
    async () => {
      await stopManagedStream(session);
    },
    2 * 60 * 1000,
  );
};

// Start a managed stream
async function startManagedStream(session: AppSession) {
  try {
    console.log("Starting managed stream...");

    // Start streaming with zero configuration!
    const result = await session.camera.startManagedStream();

    currentStreamId = result.streamId;

    console.log("\nStream started successfully!");
    console.log("Share these URLs with viewers:");
    console.log(`   HLS URL (Best compatibility): ${result.hlsUrl}`);
    console.log(`   DASH URL (Alternative): ${result.dashUrl}`);
    if (result.webrtcUrl) {
      console.log(`   WebRTC URL (Low latency): ${result.webrtcUrl}`);
    }

    console.log("\nViewers can open the HLS URL in:");
    console.log("   - Any modern web browser");
    console.log("   - VLC Media Player");
    console.log("   - Mobile video players");
    console.log("   - Or embed in your app with video.js or hls.js\n");
  } catch (error) {
    console.error("Failed to start managed stream:", error);
  }
}

// Example: Enable WebRTC for low-latency viewing
async function _startLowLatencyStream(session: AppSession) {
  try {
    const result = await session.camera.startManagedStream({
      enableWebRTC: true,
    });

    console.log("Low-latency stream started");
    console.log("WebRTC URL:", result.webrtcUrl);
    console.log("   (Latency: ~2-3 seconds vs 5-10 seconds for HLS)");
  } catch (error) {
    console.error("Failed to start stream:", error);
  }
}

// Set up handler for stream status updates
function setupStreamStatusHandler(session: AppSession) {
  session.on(StreamType.MANAGED_STREAM_STATUS, (status: ManagedStreamStatus) => {
    const timestamp = new Date().toLocaleTimeString();

    switch (status.status) {
      case "initializing":
        console.log(`[${timestamp}] Stream initializing...`);
        break;

      case "active":
        console.log(`[${timestamp}] Stream is LIVE!`);
        if (status.hlsUrl) {
          console.log(`   View at: ${status.hlsUrl}`);
        }
        break;

      case "stopping":
        console.log(`[${timestamp}] Stream stopping...`);
        break;

      case "stopped":
        console.log(`[${timestamp}] Stream stopped`);
        currentStreamId = null;
        break;

      case "error":
        console.error(`[${timestamp}] Stream error: ${status.message}`);
        currentStreamId = null;
        break;

      default:
        console.log(`[${timestamp}] Stream status: ${status.status}`);
    }
  });
}

// Stop the managed stream
async function stopManagedStream(session: AppSession) {
  if (!currentStreamId) {
    console.log("No active stream to stop");
    return;
  }

  try {
    console.log("Stopping managed stream...");
    await session.camera.stopManagedStream();
    console.log("Stream stopped successfully");
    currentStreamId = null;
  } catch (error) {
    console.error("Error stopping stream:", error);
  }
}

// Graceful shutdown on exit
process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  if (currentStreamId && activeSession) {
    await stopManagedStream(activeSession);
  }
  await app.stop();
});

// Start the server — MentraOS Cloud sends session webhooks here automatically
console.log("Managed RTMP Streaming Example");
console.log("==================================");
console.log("This example demonstrates zero-infrastructure streaming.");
console.log("No RTMP server needed - MentraOS handles everything!\n");

app.start().then(() => {
  console.log("Managed streaming app is running");
});
