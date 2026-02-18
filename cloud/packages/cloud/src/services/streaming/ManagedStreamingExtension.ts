import { Logger } from "pino";
import WebSocket from "ws";
import {
  CloudToGlassesMessageType,
  CloudToAppMessageType,
  ManagedStreamRequest,
  ManagedStreamStopRequest,
  ManagedStreamStatus,
  OutputStatus,
  StartRtmpStream,
  StopRtmpStream,
  KeepRtmpStreamAlive,
  RtmpStreamStatus,
  KeepAliveAck,
} from "@mentra/sdk";
import UserSession from "../session/UserSession";
import { CloudflareStreamService } from "./CloudflareStreamService";
import {
  StreamRegistry,
  ManagedStreamState,
  StreamState,
} from "./StreamRegistry";
import { StreamLifecycleController } from "./StreamLifecycleController";
import { ConnectionValidator } from "../validators/ConnectionValidator";

// Keep-alive constants matching UnmanagedStreamingExtension
const KEEP_ALIVE_INTERVAL_MS = 15000; // 15 seconds
const ACK_TIMEOUT_MS = 10000; // 10 seconds to wait for ACK
const MAX_MISSED_ACKS = 3; // Max consecutive missed ACKs

/**
 * Extension to UnmanagedStreamingExtension that adds managed streaming capabilities
 * Works alongside the unmanaged streaming pipeline without modifying core logic
 */
export class ManagedStreamingExtension {
  private logger: Logger;
  private cloudflareService: CloudflareStreamService;
  private stateManager: StreamRegistry;

  // Per-stream lifecycle controllers keyed by streamId
  private lifecycleControllers: Map<string, StreamLifecycleController> =
    new Map();

  // Polling intervals for URL discovery
  private pollingIntervals: Map<string, NodeJS.Timeout> = new Map(); // userId -> interval

  // Track last sent status per stream+app to prevent duplicates
  private lastSentStatus: Map<string, ManagedStreamStatus> = new Map(); // key: `${streamId}:${packageName}`

  constructor(logger: Logger, streamRegistry: StreamRegistry) {
    this.logger = logger.child({ service: "ManagedStreamingExtension" });
    this.cloudflareService = new CloudflareStreamService(logger);
    this.stateManager = streamRegistry;

    this.logger.info("ManagedStreamingExtension initialized");

    // Schedule periodic cleanup
    setInterval(
      () => {
        this.performCleanup();
      },
      60 * 60 * 1000,
    ); // Every hour
  }

  /**
   * Start or join a managed stream
   */
  async startManagedStream(
    userSession: UserSession,
    request: ManagedStreamRequest,
  ): Promise<string> {
    const {
      packageName,
      quality,
      enableWebRTC,
      video,
      audio,
      stream: streamOptions,
      restreamDestinations,
    } = request;
    const userId = userSession.userId;

    this.logger.info(
      {
        userId,
        packageName,
        quality,
        enableWebRTC,
        hasVideo: !!video,
        hasAudio: !!audio,
        restreamCount: restreamDestinations?.length || 0,
      },
      "Starting managed stream request",
    );

    // Validate app is running
    if (!userSession.appManager.isAppRunning(packageName)) {
      throw new Error(`App ${packageName} is not running`);
    }

    const validation = ConnectionValidator.validateForHardwareRequest(
      userSession,
      "stream",
    );
    if (!validation.valid) {
      const connectionStatus =
        ConnectionValidator.getConnectionStatus(userSession);
      this.logger.error(
        {
          userId,
          packageName,
          error: validation.error,
          errorCode: validation.errorCode,
          connectionStatus,
        },
        "Managed stream request blocked by connection validator",
      );
      const error = new Error(
        validation.error ||
          "Cannot process stream request - connection validation failed",
      );
      (error as any).code = validation.errorCode;
      throw error;
    }

    // WiFi validation for glasses that require it
    const wifiValidation =
      ConnectionValidator.validateWifiForOperation(userSession);
    if (!wifiValidation.valid) {
      this.logger.error(
        {
          userId,
          packageName,
          error: wifiValidation.error,
          errorCode: wifiValidation.errorCode,
        },
        "Managed stream request blocked - WiFi required",
      );
      const error = new Error(
        wifiValidation.error || "WiFi connection required for streaming",
      );
      (error as any).code = wifiValidation.errorCode;
      throw error;
    }

    // Check WebSocket connection
    if (
      !userSession.websocket ||
      userSession.websocket.readyState !== WebSocket.OPEN
    ) {
      throw new Error("Glasses WebSocket not connected");
    }

    // Check for conflicts
    const conflict = this.stateManager.checkStreamConflict(userId, "managed");
    if (conflict.hasConflict) {
      throw new Error(conflict.message || "Stream conflict detected");
    }

    // Get or create managed stream
    const existingStream = this.stateManager.getStreamState(userId);

    if (existingStream && existingStream.type === "managed") {
      // Add viewer to existing stream
      const managedStream = this.stateManager.createOrJoinManagedStream({
        userId,
        appId: packageName,
        liveInput: {
          liveInputId: existingStream.cfLiveInputId,
          rtmpUrl: existingStream.cfIngestUrl,
          hlsUrl: existingStream.hlsUrl,
          dashUrl: existingStream.dashUrl,
          webrtcUrl: existingStream.webrtcUrl,
        },
      });

      // Send status to new viewer
      await this.sendManagedStreamStatus(
        userSession,
        packageName,
        managedStream.streamId,
        "active",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      );

      const lifecycle = this.ensureLifecycle(userSession, managedStream);
      lifecycle.recordActivity();
      lifecycle.setActive(true);

      return managedStream.streamId;
    }

    // Create new Cloudflare live input
    this.logger.debug(
      { userId, packageName },
      "📡 Creating new Cloudflare live input",
    );

    let liveInput;
    try {
      liveInput = await this.cloudflareService.createLiveInput(userId, {
        quality,
        enableWebRTC,
        enableRecording: true, // Must be true for live playback to work
        requireSignedURLs: false, // Public streams
        restreamDestinations, // Pass through restream destinations
      });

      this.logger.info(
        {
          userId,
          packageName,
          liveInput: JSON.stringify(liveInput, null, 2),
        },
        "✅ Cloudflare live input created successfully",
      );
    } catch (cfError) {
      this.logger.error(
        {
          userId,
          packageName,
          error: {
            message:
              cfError instanceof Error ? cfError.message : "Unknown error",
            stack: cfError instanceof Error ? cfError.stack : undefined,
            fullError: JSON.stringify(cfError, null, 2),
          },
        },
        "❌ Failed to create Cloudflare live input",
      );
      throw cfError;
    }

    // Create managed stream state
    this.logger.debug(
      { userId, packageName },
      "📊 Creating managed stream state",
    );
    const managedStream = this.stateManager.createOrJoinManagedStream({
      userId,
      appId: packageName,
      liveInput,
    });

    // Ensure lifecycle controller is active
    const lifecycle = this.ensureLifecycle(userSession, managedStream);
    lifecycle.recordActivity();
    lifecycle.setActive(true);

    // Wait for Cloudflare live input to fully initialize
    this.logger.info(
      { userId, packageName },
      "⏳ Waiting 3 seconds for Cloudflare live input to initialize",
    );
    //await new Promise((resolve) => setTimeout(resolve, 3000));

    // Send start command to glasses with Cloudflare RTMP URL
    const startMessage: StartRtmpStream = {
      type: CloudToGlassesMessageType.START_RTMP_STREAM,
      sessionId: userSession.sessionId,
      rtmpUrl: liveInput.rtmpUrl, // Cloudflare ingest URL
      appId: "MANAGED_STREAM", // Special app ID for managed streams
      streamId: managedStream.streamId,
      video: video || {},
      audio: audio || {},
      stream: streamOptions || {},
      timestamp: new Date(),
    };

    try {
      userSession.websocket.send(JSON.stringify(startMessage));

      this.logger.info(
        {
          userId,
          streamId: managedStream.streamId,
          cfLiveInputId: liveInput.liveInputId,
          packageName,
        },
        "Sent START_RTMP_STREAM for managed stream",
      );

      // Send initial status without URLs (they're not ready yet)
      await this.sendManagedStreamStatus(
        userSession,
        packageName,
        managedStream.streamId,
        "initializing",
        "Waiting for stream to start...",
        undefined, // No HLS URL yet
        undefined, // No DASH URL yet
        undefined, // No WebRTC URL yet
        undefined, // No preview URL yet
        undefined, // No thumbnail URL yet
      );

      // Start polling for playback URLs
      this.startPlaybackUrlPolling(userId, packageName, managedStream);
    } catch (error) {
      // Cleanup on error
      this.stateManager.removeStream(userId);
      // Keep-alive is now managed by lifecycle, no manual stop needed
      await this.cloudflareService.deleteLiveInput(liveInput.liveInputId);
      throw error;
    }

    return managedStream.streamId;
  }

  /**
   * Stop managed stream for a specific app
   */
  async stopManagedStream(
    userSession: UserSession,
    request: ManagedStreamStopRequest,
  ): Promise<void> {
    const { packageName } = request;
    const userId = userSession.userId;

    this.logger.info(
      { userId, packageName },
      "Stopping managed stream for app",
    );

    const stream = this.stateManager.getStreamState(userId);
    if (!stream || stream.type !== "managed") {
      this.logger.warn(
        { userId, packageName },
        "No managed stream found to stop",
      );
      return;
    }

    // Remove this app as a viewer
    const shouldCleanup = this.stateManager.removeViewerFromManagedStream(
      userId,
      packageName,
    );

    // Notify app that stream is stopping
    await this.sendManagedStreamStatus(
      userSession,
      packageName,
      stream.streamId,
      "stopped",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );

    // If no more viewers, stop the stream entirely
    if (shouldCleanup) {
      await this.cleanupManagedStream(userSession, userId, stream, {
        status: "stopped",
      });
    }
  }

  /**
   * Handle RTMP stream status from glasses
   * @returns true if handled by managed streaming, false otherwise
   */
  async handleStreamStatus(
    userSession: UserSession,
    status: RtmpStreamStatus,
  ): Promise<boolean> {
    const { streamId, status: glassesStatus } = status;

    // Check if this is a managed stream by stream ID
    if (!streamId) {
      return false; // No streamId, cannot be a managed stream
    }

    const stream = this.stateManager.getStreamByStreamId(streamId);
    if (!stream || stream.type !== "managed") {
      return false; // Let the unmanaged extension handle direct RTMP streams
    }

    this.logger.info(
      {
        streamId,
        glassesStatus,
        userId: stream.userId,
      },
      "Received managed stream status from glasses",
    );

    // Update last activity
    this.stateManager.updateLastActivity(stream.userId);

    const lifecycle = this.ensureLifecycle(userSession, stream);
    lifecycle.recordActivity();

    // Map glasses status to our status
    let mappedStatus: ManagedStreamStatus["status"] = "active";
    switch (glassesStatus) {
      case "initializing":
      case "connecting":
        mappedStatus = "initializing";
        break;
      case "active":
      case "streaming":
        mappedStatus = "active";
        // When stream becomes active, try to get updated URLs
        this.updateStreamUrls(stream);
        lifecycle.setActive(true);
        break;
      case "stopping":
        mappedStatus = "stopping";
        lifecycle.setActive(false);
        break;
      case "stopped":
        mappedStatus = "stopped";
        lifecycle.setActive(false);
        break;
      case "error":
        mappedStatus = "error";
        lifecycle.setActive(false);
        break;
      default:
        lifecycle.setActive(true);
    }

    // Send status to all viewers
    const messageForViewers =
      mappedStatus === "error"
        ? status.errorDetails || "Stream error reported by glasses"
        : undefined;

    for (const appId of stream.activeViewers) {
      await this.sendManagedStreamStatus(
        userSession,
        appId,
        stream.streamId,
        mappedStatus,
        messageForViewers,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      );
    }

    // If stream stopped or errored, cleanup
    if (mappedStatus === "stopped" || mappedStatus === "error") {
      await this.cleanupManagedStream(userSession, stream.userId, stream, {
        status: mappedStatus,
        message: messageForViewers,
      });
    }

    return true; // Handled by managed streaming
  }

  /**
   * Update stream URLs from Cloudflare when stream becomes active
   */
  private async updateStreamUrls(stream: ManagedStreamState): Promise<void> {
    try {
      const streamDetails = await this.cloudflareService.getStreamDetails(
        stream.cfLiveInputId,
      );

      if (streamDetails) {
        let updated = false;

        if (
          streamDetails.playback?.hls &&
          streamDetails.playback.hls !== stream.hlsUrl
        ) {
          stream.hlsUrl = streamDetails.playback.hls;
          updated = true;
        }

        if (
          streamDetails.playback?.dash &&
          streamDetails.playback.dash !== stream.dashUrl
        ) {
          stream.dashUrl = streamDetails.playback.dash;
          updated = true;
        }

        // Get preview URL and player URL
        const previewUrl = streamDetails.preview;
        const playerUrl = this.cloudflareService.getEmbedUrl(
          stream.cfLiveInputId,
          { autoplay: true, muted: true, controls: true },
        );
        const thumbnailUrl = streamDetails.thumbnail;

        if (updated || previewUrl || thumbnailUrl) {
          this.logger.info(
            {
              streamId: stream.streamId,
              hlsUrl: stream.hlsUrl,
              dashUrl: stream.dashUrl,
              previewUrl,
              thumbnailUrl,
            },
            "Updated stream details from Cloudflare",
          );

          // Send updated URLs to all viewers
          const userSession = this.getUserSession(stream.userId);
          if (userSession) {
            for (const appId of stream.activeViewers) {
              await this.sendManagedStreamStatus(
                userSession,
                appId,
                stream.streamId,
                "active",
                "Stream details updated",
                stream.hlsUrl,
                stream.dashUrl,
                stream.webrtcUrl,
                previewUrl || playerUrl,
                thumbnailUrl,
              );
            }
          }
        }
      }
    } catch (error) {
      this.logger.debug(
        {
          streamId: stream.streamId,
          error,
        },
        "Could not update stream URLs",
      );
    }
  }

  /**
   * Handle keep-alive ACK from glasses
   */
  handleKeepAliveAck(userId: string, ack: KeepAliveAck): void {
    const stream = this.stateManager.getStreamState(userId);
    if (!stream || stream.type !== "managed") {
      return;
    }

    const lifecycle = this.lifecycleControllers.get(stream.streamId);
    if (!lifecycle) {
      return;
    }

    lifecycle.handleAck(ack.ackId);
    this.stateManager.updateLastActivity(userId);
  }

  /**
   * Check for stream conflicts before starting unmanaged stream
   */
  checkUnmanagedStreamConflict(userId: string): boolean {
    const conflict = this.stateManager.checkStreamConflict(userId, "unmanaged");
    return conflict.hasConflict;
  }

  /**
   * Get stream statistics
   */
  getStats() {
    return this.stateManager.getStats();
  }

  /**
   * Get stream state by stream ID
   */
  getStreamByStreamId(streamId: string) {
    return this.stateManager.getStreamByStreamId(streamId);
  }

  /**
   * Return the list of viewer package names for the current managed stream of a user.
   * If the user has no managed stream, returns an empty array.
   */
  getManagedStreamViewers(userId: string): string[] {
    const stream = this.stateManager.getStreamState(userId);
    if (!stream || stream.type !== "managed") {
      return [];
    }
    return Array.from(stream.activeViewers);
  }

  /**
   * Get detailed stream information from Cloudflare
   * This includes HLS, DASH, preview/player URLs and other metadata
   */
  async getStreamDetails(streamId: string): Promise<{
    hlsUrl?: string;
    dashUrl?: string;
    previewUrl?: string;
    thumbnail?: string;
    playerUrl?: string;
    readyToStream?: boolean;
    status?: string;
    duration?: number;
    created?: string;
    modified?: string;
  } | null> {
    try {
      const stream = this.stateManager.getStreamByStreamId(streamId);
      if (!stream || stream.type !== "managed") {
        this.logger.warn(
          { streamId },
          "Stream not found or not a managed stream",
        );
        return null;
      }

      // Get details from Cloudflare
      const streamDetails = await this.cloudflareService.getStreamDetails(
        stream.cfLiveInputId,
      );

      if (!streamDetails) {
        // Return what we have locally
        return {
          hlsUrl: stream.hlsUrl,
          dashUrl: stream.dashUrl,
          playerUrl: this.cloudflareService.getEmbedUrl(stream.cfLiveInputId),
        };
      }

      // Build the player/preview URL
      const playerUrl = this.cloudflareService.getEmbedUrl(streamDetails.uid, {
        autoplay: true,
        muted: true,
        controls: true,
      });

      return {
        hlsUrl: streamDetails.playback?.hls || stream.hlsUrl,
        dashUrl: streamDetails.playback?.dash || stream.dashUrl,
        previewUrl: streamDetails.preview,
        thumbnail: streamDetails.thumbnail,
        playerUrl,
        readyToStream: streamDetails.readyToStream,
        status: streamDetails.status?.state,
        duration: streamDetails.duration,
        created: streamDetails.created,
        modified: streamDetails.modified,
      };
    } catch (error) {
      this.logger.error(
        {
          streamId,
          error,
        },
        "Failed to get stream details",
      );
      return null;
    }
  }

  /**
   * Get the current stream state for a user
   * Returns information about any active stream (managed or unmanaged)
   */
  getUserStreamState(userId: string): StreamState | undefined {
    return this.stateManager.getStreamState(userId);
  }

  /**
   * Add a restream output to a managed stream
   */
  async addRestreamOutput(
    streamId: string,
    packageName: string,
    destination: { url: string; name?: string },
  ): Promise<{
    success: boolean;
    outputId?: string;
    error?: string;
    message?: string;
  }> {
    try {
      const stream = this.stateManager.getStreamByStreamId(streamId);
      if (!stream || stream.type !== "managed") {
        return {
          success: false,
          error: "STREAM_NOT_FOUND",
          message: "Managed stream not found",
        };
      }

      // Initialize outputs array if needed
      if (!stream.outputs) {
        stream.outputs = [];
      }

      // Import limits from routes file
      const MAX_OUTPUTS_PER_STREAM = 10;
      const MAX_OUTPUTS_PER_APP = 10;

      // Check total outputs limit
      if (stream.outputs.length >= MAX_OUTPUTS_PER_STREAM) {
        return {
          success: false,
          error: "MAX_OUTPUTS_REACHED",
          message: `Stream has reached maximum of ${MAX_OUTPUTS_PER_STREAM} outputs`,
        };
      }

      // Check per-app limit
      const appOutputCount = stream.outputs.filter(
        (o) => o.addedBy === packageName,
      ).length;
      if (appOutputCount >= MAX_OUTPUTS_PER_APP) {
        return {
          success: false,
          error: "MAX_APP_OUTPUTS_REACHED",
          message: `Your app has reached maximum of ${MAX_OUTPUTS_PER_APP} outputs for this stream`,
        };
      }

      // Check for duplicate URL
      if (stream.outputs.some((o) => o.url === destination.url)) {
        return {
          success: false,
          error: "DUPLICATE_URL",
          message: "This RTMP URL is already configured as an output",
        };
      }

      // Create output via Cloudflare
      try {
        const cfOutputs = await this.cloudflareService.createOutputs(
          stream.cfLiveInputId,
          [destination],
        );

        if (cfOutputs.length === 0) {
          throw new Error("No output created");
        }

        const cfOutput = cfOutputs[0];

        // Add to stream state with ownership
        stream.outputs.push({
          cfOutputId: cfOutput.uid,
          url: destination.url,
          name: destination.name,
          addedBy: packageName,
          status: cfOutput,
        });

        // Send status update to all viewers
        await this.notifyOutputsChanged(stream);

        this.logger.info(
          {
            streamId,
            outputId: cfOutput.uid,
            url: destination.url,
            addedBy: packageName,
          },
          "Successfully added restream output",
        );

        return {
          success: true,
          outputId: cfOutput.uid,
        };
      } catch (cfError) {
        this.logger.error(
          {
            streamId,
            error: cfError,
            destination,
          },
          "Failed to create Cloudflare output",
        );

        return {
          success: false,
          error: "CLOUDFLARE_ERROR",
          message:
            cfError instanceof Error
              ? cfError.message
              : "Failed to create output",
        };
      }
    } catch (error) {
      this.logger.error(
        {
          streamId,
          packageName,
          error,
        },
        "Error adding restream output",
      );

      return {
        success: false,
        error: "INTERNAL_ERROR",
        message: "An unexpected error occurred",
      };
    }
  }

  /**
   * Remove a restream output from a managed stream
   */
  async removeRestreamOutput(
    streamId: string,
    outputId: string,
    packageName: string,
  ): Promise<{
    success: boolean;
    error?: string;
    message?: string;
  }> {
    try {
      const stream = this.stateManager.getStreamByStreamId(streamId);
      if (!stream || stream.type !== "managed") {
        return {
          success: false,
          error: "STREAM_NOT_FOUND",
          message: "Managed stream not found",
        };
      }

      if (!stream.outputs || stream.outputs.length === 0) {
        return {
          success: false,
          error: "OUTPUT_NOT_FOUND",
          message: "Output not found",
        };
      }

      // Find the output
      const outputIndex = stream.outputs.findIndex(
        (o) => o.cfOutputId === outputId,
      );
      if (outputIndex === -1) {
        return {
          success: false,
          error: "OUTPUT_NOT_FOUND",
          message: "Output not found",
        };
      }

      const output = stream.outputs[outputIndex];

      // Check ownership
      if (output.addedBy !== packageName) {
        return {
          success: false,
          error: "NOT_AUTHORIZED",
          message: "You can only remove outputs that you added",
        };
      }

      // Remove from Cloudflare
      try {
        await this.cloudflareService.deleteOutput(
          stream.cfLiveInputId,
          outputId,
        );
      } catch (cfError) {
        this.logger.error(
          {
            streamId,
            outputId,
            error: cfError,
          },
          "Failed to delete Cloudflare output",
        );

        // Continue with local removal even if Cloudflare fails
      }

      // Remove from stream state
      stream.outputs.splice(outputIndex, 1);

      // Send status update to all viewers
      await this.notifyOutputsChanged(stream);

      this.logger.info(
        {
          streamId,
          outputId,
          removedBy: packageName,
        },
        "Successfully removed restream output",
      );

      return { success: true };
    } catch (error) {
      this.logger.error(
        {
          streamId,
          outputId,
          packageName,
          error,
        },
        "Error removing restream output",
      );

      return {
        success: false,
        error: "INTERNAL_ERROR",
        message: "An unexpected error occurred",
      };
    }
  }

  /**
   * Notify all viewers when outputs change
   */
  private async notifyOutputsChanged(
    stream: ManagedStreamState,
  ): Promise<void> {
    const userSession = this.getUserSession(stream.userId);
    if (!userSession) return;

    // Send updated status to all viewers
    for (const appId of stream.activeViewers) {
      await this.sendManagedStreamStatus(
        userSession,
        appId,
        stream.streamId,
        "active",
        "Outputs updated",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      );
    }
  }

  /**
   * Start polling for playback URLs after stream creation
   */
  private startPlaybackUrlPolling(
    userId: string,
    packageName: string,
    managedStream: ManagedStreamState,
  ): void {
    const pollInterval = setInterval(async () => {
      try {
        // Check if stream is still active
        const currentStream = this.stateManager.getStreamState(userId);
        if (
          !currentStream ||
          currentStream.type !== "managed" ||
          currentStream.streamId !== managedStream.streamId
        ) {
          clearInterval(pollInterval);
          return;
        }

        this.logger.debug(
          {
            userId,
            streamId: managedStream.streamId,
            cfLiveInputId: managedStream.cfLiveInputId,
          },
          "🔍 Polling for stream details and live status",
        );

        // First check if stream is live
        const isLive = await this.cloudflareService.waitForStreamLive(
          managedStream.cfLiveInputId,
          1, // Only one attempt per poll
          0, // No delay, we handle it ourselves
        );

        if (isLive) {
          // Now get the actual stream details to retrieve the correct URLs
          const streamDetails = await this.cloudflareService.getStreamDetails(
            managedStream.cfLiveInputId,
          );

          let hlsUrl = managedStream.hlsUrl;
          let dashUrl = managedStream.dashUrl;
          let previewUrl: string | undefined;

          if (streamDetails) {
            // Use the actual URLs from Cloudflare if available
            if (streamDetails.playback?.hls) {
              hlsUrl = streamDetails.playback.hls;
              managedStream.hlsUrl = hlsUrl;
            }
            if (streamDetails.playback?.dash) {
              dashUrl = streamDetails.playback.dash;
              managedStream.dashUrl = dashUrl;
            }
            if (streamDetails.preview) {
              previewUrl = streamDetails.preview;
            }

            this.logger.info(
              {
                userId,
                streamId: managedStream.streamId,
                hlsUrl,
                dashUrl,
                previewUrl,
                thumbnail: streamDetails.thumbnail,
                readyToStream: streamDetails.readyToStream,
              },
              "🎉 Stream is live with verified URLs!",
            );
          } else {
            this.logger.info(
              {
                userId,
                streamId: managedStream.streamId,
                hlsUrl,
                dashUrl,
              },
              "🎉 Stream is live! Using constructed URLs",
            );
          }

          // Get user session to send updates
          const userSession = this.getUserSession(userId);
          if (!userSession) {
            clearInterval(pollInterval);
            return;
          }

          // Get player URL for embedding
          const playerUrl = this.cloudflareService.getEmbedUrl(
            managedStream.cfLiveInputId,
            { autoplay: true, muted: true, controls: true },
          );

          // Send status update to all apps viewing this stream
          for (const appId of managedStream.activeViewers) {
            await this.sendManagedStreamStatus(
              userSession,
              appId,
              managedStream.streamId,
              "active",
              "Stream is now live",
              hlsUrl,
              dashUrl,
              managedStream.webrtcUrl,
              previewUrl || playerUrl,
              streamDetails?.thumbnail,
            );
          }

          // Stop polling
          clearInterval(pollInterval);
        }
      } catch (error) {
        this.logger.error(
          {
            userId,
            streamId: managedStream.streamId,
            error,
          },
          "Error polling for playback URLs",
        );
      }
    }, 2000); // Poll every 2 seconds

    // Store interval for cleanup
    const existingInterval = this.pollingIntervals.get(userId);
    if (existingInterval) {
      clearInterval(existingInterval);
    }
    this.pollingIntervals.set(userId, pollInterval);

    // Set timeout to stop polling after 60 seconds
    setTimeout(() => {
      if (this.pollingIntervals.get(userId) === pollInterval) {
        clearInterval(pollInterval);
        this.pollingIntervals.delete(userId);
        this.logger.warn(
          {
            userId,
            streamId: managedStream.streamId,
          },
          "⏱️ Stopped polling for playback URLs after timeout",
        );
      }
    }, 60000);
  }

  /**
   * Send managed stream status to app
   */
  private async sendManagedStreamStatus(
    userSession: UserSession,
    packageName: string,
    streamId: string,
    status: ManagedStreamStatus["status"],
    message?: string,
    hlsUrl?: string,
    dashUrl?: string,
    webrtcUrl?: string,
    previewUrl?: string,
    thumbnailUrl?: string,
  ): Promise<void> {
    const stream = this.stateManager.getStreamByStreamId(streamId);
    if (!stream || stream.type !== "managed") return;

    const appWs = userSession.appWebsockets.get(packageName);
    if (!appWs || appWs.readyState !== WebSocket.OPEN) {
      this.logger.warn(
        { packageName },
        "App WebSocket not available for status update",
      );
      // Clear last sent status for this app since connection is gone
      const statusKey = `${streamId}:${packageName}`;
      this.lastSentStatus.delete(statusKey);
      return;
    }

    // Convert CloudflareOutput to OutputStatus format
    let outputs: OutputStatus[] | undefined;
    if (stream.outputs && stream.outputs.length > 0) {
      outputs = stream.outputs.map((output) => ({
        url: output.url,
        name: output.name,
        status:
          output.status?.status?.current?.state === "connected"
            ? ("active" as const)
            : output.status?.status?.current?.state === "error"
              ? ("error" as const)
              : ("stopped" as const),
        error: output.status?.status?.current?.lastError,
      }));
    }

    const statusMessage: ManagedStreamStatus = {
      type: CloudToAppMessageType.MANAGED_STREAM_STATUS,
      status,
      hlsUrl: hlsUrl !== undefined ? hlsUrl : stream.hlsUrl,
      dashUrl: dashUrl !== undefined ? dashUrl : stream.dashUrl,
      webrtcUrl: webrtcUrl !== undefined ? webrtcUrl : stream.webrtcUrl,
      previewUrl: previewUrl,
      thumbnailUrl: thumbnailUrl,
      streamId,
      message,
      outputs,
    };

    // Check if this is a duplicate status
    const statusKey = `${streamId}:${packageName}`;
    const lastStatus = this.lastSentStatus.get(statusKey);

    if (lastStatus) {
      // Compare all relevant fields
      const isDuplicate =
        lastStatus.status === statusMessage.status &&
        lastStatus.hlsUrl === statusMessage.hlsUrl &&
        lastStatus.dashUrl === statusMessage.dashUrl &&
        lastStatus.webrtcUrl === statusMessage.webrtcUrl &&
        lastStatus.message === statusMessage.message &&
        JSON.stringify(lastStatus.outputs) ===
          JSON.stringify(statusMessage.outputs);

      if (isDuplicate) {
        this.logger.debug(
          {
            packageName,
            status,
            streamId,
          },
          "Skipping duplicate managed stream status",
        );
        return;
      }
    }

    // Send the status update
    appWs.send(JSON.stringify(statusMessage));

    // Track this as the last sent status
    this.lastSentStatus.set(statusKey, statusMessage);

    this.logger.debug(
      {
        packageName,
        status,
        streamId,
        hasHls: !!statusMessage.hlsUrl,
        hasDash: !!statusMessage.dashUrl,
        message,
      },
      "Sent managed stream status to app",
    );
  }

  /**
   * Fetch the active user session for a userId.
   */
  private getUserSession(userId: string): UserSession | undefined {
    return UserSession.getById(userId) || undefined;
  }

  private ensureLifecycle(
    userSession: UserSession,
    stream: ManagedStreamState,
  ): StreamLifecycleController {
    let lifecycle = this.lifecycleControllers.get(stream.streamId);
    if (lifecycle) {
      return lifecycle;
    }

    lifecycle = new StreamLifecycleController(
      {
        logger: this.logger.child({
          streamId: stream.streamId,
          userId: stream.userId,
        }),
        streamId: stream.streamId,
        keepAliveIntervalMs: KEEP_ALIVE_INTERVAL_MS,
        ackTimeoutMs: ACK_TIMEOUT_MS,
        maxMissedAcks: MAX_MISSED_ACKS,
        shouldSendKeepAlive: () =>
          !!userSession.websocket &&
          userSession.websocket.readyState === WebSocket.OPEN,
      },
      {
        sendKeepAlive: (ackId) =>
          this.sendKeepAliveMessage(userSession, stream.streamId, ackId),
        onTimeout: () => this.onLifecycleTimeout(userSession, stream),
        onKeepAliveSent: (ackId) => {
          this.logger.debug(
            { userId: stream.userId, streamId: stream.streamId, ackId },
            "Sent keep-alive for managed stream",
          );
        },
        onKeepAliveAcked: (ackId, ageMs) => {
          this.logger.debug(
            { userId: stream.userId, streamId: stream.streamId, ackId, ageMs },
            "Received keep-alive ACK for managed stream",
          );
        },
        onKeepAliveMissed: (ackId, ageMs, missedCount) => {
          this.logger.warn(
            {
              userId: stream.userId,
              streamId: stream.streamId,
              ackId,
              ageMs,
              missedAcks: missedCount,
            },
            "Keep-alive ACK missed for managed stream",
          );
        },
      },
    );

    this.lifecycleControllers.set(stream.streamId, lifecycle);
    return lifecycle;
  }

  private async sendKeepAliveMessage(
    userSession: UserSession,
    streamId: string,
    ackId: string,
  ): Promise<void> {
    if (
      !userSession.websocket ||
      userSession.websocket.readyState !== WebSocket.OPEN
    ) {
      this.logger.warn(
        { streamId, sessionId: userSession.sessionId },
        "Cannot send keep-alive because WebSocket is not open",
      );
      return;
    }

    const message: KeepRtmpStreamAlive = {
      type: CloudToGlassesMessageType.KEEP_RTMP_STREAM_ALIVE,
      streamId,
      ackId,
    };

    userSession.websocket.send(JSON.stringify(message));
  }

  private async onLifecycleTimeout(
    userSession: UserSession,
    stream: ManagedStreamState,
  ): Promise<void> {
    this.logger.error(
      { userId: stream.userId, streamId: stream.streamId },
      "Managed stream timed out after missed keep-alive ACKs",
    );

    await this.cleanupManagedStream(userSession, stream.userId, stream, {
      status: "error",
      message: "Stream timed out waiting for keep-alive",
    });
  }

  private disposeLifecycle(streamId: string): void {
    const lifecycle = this.lifecycleControllers.get(streamId);
    if (lifecycle) {
      lifecycle.dispose();
      this.lifecycleControllers.delete(streamId);
    }
  }

  private disposeLifecycleForUser(userId: string): void {
    for (const [streamId, controller] of this.lifecycleControllers) {
      const stream = this.stateManager.getStreamByStreamId(streamId);
      if (!stream || stream.userId === userId) {
        controller.dispose();
        this.lifecycleControllers.delete(streamId);
      }
    }
  }

  /**
   * Clean up managed stream completely
   */
  private async cleanupManagedStream(
    userSession: UserSession,
    userId: string,
    stream: ManagedStreamState,
    options?: { status?: ManagedStreamStatus["status"]; message?: string },
  ): Promise<void> {
    this.logger.info(
      { userId, streamId: stream.streamId },
      "Cleaning up managed stream",
    );

    this.disposeLifecycle(stream.streamId);

    const status = options?.status ?? "stopped";
    const message = options?.message;

    // Notify all active viewers before removing stream state
    const viewers = Array.from(stream.activeViewers);
    for (const viewerPackage of viewers) {
      try {
        await this.sendManagedStreamStatus(
          userSession,
          viewerPackage,
          stream.streamId,
          status,
          message,
        );
      } catch (error) {
        this.logger.warn(
          { streamId: stream.streamId, viewerPackage, error },
          "Failed to notify viewer about managed stream cleanup",
        );
      }
    }

    // Stop polling for URLs if still active
    const pollInterval = this.pollingIntervals.get(userId);
    if (pollInterval) {
      clearInterval(pollInterval);
      this.pollingIntervals.delete(userId);
    }

    // Send stop command to glasses
    if (userSession.websocket?.readyState === WebSocket.OPEN) {
      const stopMessage: StopRtmpStream = {
        type: CloudToGlassesMessageType.STOP_RTMP_STREAM,
        sessionId: userSession.sessionId,
        appId: "MANAGED_STREAM", // Same special app ID used when starting
        streamId: stream.streamId,
        timestamp: new Date(),
      };
      userSession.websocket.send(JSON.stringify(stopMessage));
    }

    // Remove from state manager
    this.stateManager.removeStream(userId);

    // Clear last sent status for this stream
    for (const [key] of this.lastSentStatus) {
      if (key.startsWith(`${stream.streamId}:`)) {
        this.lastSentStatus.delete(key);
      }
    }
  }

  /**
   * Perform periodic cleanup
   */
  private async performCleanup(): Promise<void> {
    try {
      const removedUsers = this.stateManager.cleanupInactiveStreams(60);
      for (const userId of removedUsers) {
        this.disposeLifecycleForUser(userId);
      }

      this.logger.info(
        {
          removedStreams: removedUsers.length,
        },
        "Performed periodic cleanup",
      );
    } catch (error) {
      this.logger.error({ error }, "Error during periodic cleanup");
    }
  }

  /**
   * Dispose of all resources
   */
  dispose(): void {
    for (const lifecycle of this.lifecycleControllers.values()) {
      lifecycle.dispose();
    }
    this.lifecycleControllers.clear();

    for (const [, interval] of this.pollingIntervals) {
      clearInterval(interval);
    }
    this.pollingIntervals.clear();

    this.lastSentStatus.clear();

    this.logger.info("ManagedStreamingExtension disposed");
  }
}
