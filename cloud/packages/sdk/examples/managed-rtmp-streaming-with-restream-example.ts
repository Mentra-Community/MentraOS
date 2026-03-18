/**
 * Example: Managed RTMP Streaming with Re-streaming to Multiple Platforms
 *
 * This example demonstrates how to use the managed streaming feature with
 * automatic re-streaming to platforms like YouTube, Twitch, and Facebook.
 *
 * The cloud handles all RTMP endpoints and automatically forwards your stream
 * to the specified destinations.
 */

import { AppServer, TpaSession, ManagedStreamStatus, CloudToAppMessageType } from "../";

class MultiPlatformStreamingApp extends AppServer {
  constructor() {
    super({
      packageName: "com.example.multiplatform-streaming",
      apiKey: process.env.MENTRAOS_API_KEY || "your-api-key",
      port: 3000,
    });
  }

  protected async onSession(session: TpaSession, sessionId: string, userId: string): Promise<void> {
    console.log(`New session started: ${sessionId} for user ${userId}`);

    // Subscribe to managed stream status updates
    const managedStreamCleanup = session.camera.onManagedStreamStatus((status: ManagedStreamStatus) => {
      console.log(`Stream status: ${status.status}`);

      // Check output statuses
      if (status.outputs && status.outputs.length > 0) {
        console.log("Re-stream outputs:");
        status.outputs.forEach((output) => {
          console.log(`- ${output.name || output.url}: ${output.status}`);
          if (output.error) {
            console.error(`  Error: ${output.error}`);
          }
        });
      }

      if (status.status === "active") {
        console.log("Stream is live!");
        console.log("HLS URL:", status.hlsUrl);
        console.log("DASH URL:", status.dashUrl);
        session.layouts.showTextWall("Multi-platform stream is live!");
      }
    });

    // Start managed stream when glasses connect
    const connectCleanup = session.events.onConnected(async () => {
      console.log("Glasses connected! Starting multi-platform stream...");
      session.layouts.showTextWall("Starting multi-platform stream...");

      try {
        const streamResult = await session.camera.startManagedStream({
          quality: "720p",
          enableWebRTC: true,

          // NEW: Add re-streaming destinations
          restreamDestinations: [
            {
              url: "rtmp://a.rtmp.youtube.com/live2/YOUR-YOUTUBE-STREAM-KEY",
              name: "YouTube",
            },
            {
              url: "rtmp://live.twitch.tv/app/YOUR-TWITCH-STREAM-KEY",
              name: "Twitch",
            },
            {
              url: "rtmps://live-api-s.facebook.com:443/rtmp/YOUR-FACEBOOK-STREAM-KEY",
              name: "Facebook",
            },
          ],

          // Optional: Custom encoding settings
          video: {
            width: 1280,
            height: 720,
            bitrate: 2000000, // 2 Mbps
            frameRate: 30,
          },
          audio: {
            bitrate: 128000, // 128 kbps
            sampleRate: 48000,
            echoCancellation: true,
            noiseSuppression: true,
          },
        });

        console.log("Managed stream started successfully!");
        console.log("Stream ID:", streamResult.streamId);
        console.log("HLS URL:", streamResult.hlsUrl);
        console.log("DASH URL:", streamResult.dashUrl);
        console.log("WebRTC URL:", streamResult.webrtcUrl);

        // The stream is now being:
        // 1. Sent from glasses to the RTMP relay
        // 2. Forwarded to Cloudflare for HLS/DASH distribution
        // 3. Re-streamed to YouTube, Twitch, and Facebook automatically
      } catch (error) {
        console.error("Failed to start managed stream:", error);
        session.layouts.showTextWall(
          `Failed to start stream: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });

    // Stop stream when disconnected
    const disconnectCleanup = session.events.onDisconnected(async () => {
      console.log("Glasses disconnected, stopping stream...");
      try {
        await session.camera.stopManagedStream();
      } catch (error) {
        console.error("Error stopping stream:", error);
      }
    });

    // Register cleanup handlers
    this.addCleanupHandler(managedStreamCleanup);
    this.addCleanupHandler(connectCleanup);
    this.addCleanupHandler(disconnectCleanup);
  }
}

// Start the app server
const app = new MultiPlatformStreamingApp();
app.start().catch(console.error);

// Important notes:
//
// 1. Stream Keys: Replace YOUR-*-STREAM-KEY with actual stream keys from each platform
// 2. Platform Requirements: Each platform has specific requirements:
//    - YouTube: Requires 720p+ resolution, 30fps+, 2.5-4 Mbps bitrate
//    - Twitch: Flexible, but recommends 3-6 Mbps for 1080p
//    - Facebook: Supports up to 1080p, recommends 4 Mbps
//
// 3. The RTMP relay automatically transcodes your stream to meet platform requirements
// 4. You can monitor the status of each output in the ManagedStreamStatus updates
// 5. If an output fails, the main stream and other outputs continue working
