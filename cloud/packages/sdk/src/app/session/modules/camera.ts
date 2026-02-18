/**
 * 📷 Camera Module
 *
 * Unified camera functionality for App Sessions.
 * Handles both photo requests and RTMP streaming from connected glasses.
 */

import {
  PhotoRequest,
  PhotoData,
  AppToCloudMessageType,
  RtmpStreamRequest,
  RtmpStreamStopRequest,
  RtmpStreamStatus,
  isRtmpStreamStatus,
  ManagedStreamStatus,
  StreamStatusCheckResponse,
} from "../../../types";
import { VideoConfig, AudioConfig, StreamConfig, StreamStatusHandler } from "../../../types/rtmp-stream";
import { StreamType } from "../../../types/streams";
import { Logger } from "pino";
import { CameraManagedExtension, ManagedStreamOptions, ManagedStreamResult } from "./camera-managed-extension";
import { cameraWarnLog } from "../../../utils/permissions-utils";

/**
 * Options for photo requests
 */
export interface PhotoRequestOptions {
  /** Whether to save the photo to the device gallery */
  saveToGallery?: boolean;
  /** Custom webhook URL to override the TPA's default webhookUrl */
  customWebhookUrl?: string;
  /** Authentication token for custom webhook authentication */
  authToken?: string;
  /**
   * Desired photo size. All sizes are optimized for fast transfer.
   * - small: 640x480 (VGA) - ultra-fast transfers
   * - medium: 1280x720 (720p) - good balance (default)
   * - large: 1920x1080 (1080p) - high quality
   * - full: native sensor resolution - maximum detail (slower transfer)
   */
  size?: "small" | "medium" | "large" | "full";
  /** Image compression level for upload optimization. Defaults to "none". */
  compress?: "none" | "medium" | "heavy";
}

/**
 * Configuration options for an RTMP stream
 */
export interface RtmpStreamOptions {
  /** The RTMP URL to stream to (e.g., rtmp://server.example.com/live/stream-key) */
  rtmpUrl: string;
  /** Optional video configuration settings */
  video?: VideoConfig;
  /** Optional audio configuration settings */
  audio?: AudioConfig;
  /** Optional stream configuration settings */
  stream?: StreamConfig;
}

/**
 * 📷 Camera Module Implementation
 *
 * Unified camera management for App Sessions.
 * Provides methods for:
 * - 📸 Requesting photos from glasses
 * - 📹 Starting/stopping RTMP streams
 * - 🔍 Monitoring photo and stream status
 * - 🧹 Cleanup and cancellation
 *
 * @example
 * ```typescript
 * // Request a photo
 * const photoData = await session.camera.requestPhoto({ saveToGallery: true });
 *
 * // Start streaming
 * await session.camera.startStream({ rtmpUrl: 'rtmp://example.com/live/key' });
 *
 * // Monitor stream status
 * session.camera.onStreamStatus((status) => {
 *   console.log('Stream status:', status.status);
 * });
 *
 * // Stop streaming
 * await session.camera.stopStream();
 * ```
 */
export class CameraModule {
  private session: any; // Reference to AppSession
  private packageName: string;
  private sessionId: string;
  private logger: Logger;

  // Photo functionality
  // NOTE: Pending photo requests are now stored at AppServer level, not here.
  // This allows O(1) lookup when HTTP responses arrive and survives session reconnections.
  // See: cloud/issues/019-sdk-photo-request-architecture

  // Streaming functionality
  private isStreaming: boolean = false;
  private currentStreamUrl?: string;
  private currentStreamState?: RtmpStreamStatus;

  // Managed streaming extension
  private managedExtension: CameraManagedExtension;

  /**
   * Create a new CameraModule
   *
   * @param session - Reference to the parent AppSession
   * @param packageName - The App package name
   * @param sessionId - The current session ID
   * @param logger - Logger instance for debugging
   */
  constructor(session: any, packageName: string, sessionId: string, logger?: Logger) {
    this.session = session;
    this.packageName = packageName;
    this.sessionId = sessionId;
    this.logger = logger || (console as any);

    // Initialize managed extension
    this.managedExtension = new CameraManagedExtension(session, packageName, sessionId, this.logger);
  }

  // =====================================
  // 📸 Photo Functionality
  // =====================================

  /**
   * 📸 Request a photo from the connected glasses
   *
   * @param options - Optional configuration for the photo request
   * @returns Promise that resolves with the actual photo data
   *
   * @example
   * ```typescript
   * // Request a photo
   * const photo = await session.camera.requestPhoto();
   *
   * // Request a photo with custom webhook URL and authentication
   * const photo = await session.camera.requestPhoto({
   *   customWebhookUrl: 'https://my-custom-endpoint.com/photo-upload',
   *   authToken: 'your-auth-token-here'
   * });
   * ```
   */
  async requestPhoto(options?: PhotoRequestOptions): Promise<PhotoData> {
    return new Promise((resolve, reject) => {
      const baseUrl = this.session?.getHttpsServerUrl?.() || "";
      cameraWarnLog(baseUrl, this.packageName, "requestPhoto");
      try {
        // Generate unique request ID
        const requestId = `photo_req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

        // Register the photo request at AppServer level (single source of truth)
        // This allows O(1) lookup when HTTP response arrives and survives session reconnections
        // See: cloud/issues/019-sdk-photo-request-architecture
        this.session.appServer.registerPhotoRequest(requestId, {
          userId: this.session.userId,
          sessionId: this.sessionId,
          session: this.session,
          resolve,
          reject: (error: Error) => reject(error.message),
          timestamp: Date.now(),
        });

        // Create photo request message
        const message: PhotoRequest = {
          type: AppToCloudMessageType.PHOTO_REQUEST,
          packageName: this.packageName,
          sessionId: this.sessionId,
          requestId,
          timestamp: new Date(),
          saveToGallery: options?.saveToGallery || false,
          customWebhookUrl: options?.customWebhookUrl,
          authToken: options?.authToken,
          size: options?.size || "medium",
          compress: options?.compress || "none",
        };

        // Send request to cloud
        this.session.sendMessage(message);

        this.logger.info(
          {
            requestId,
            saveToGallery: options?.saveToGallery,
            hasCustomWebhook: !!options?.customWebhookUrl,
            hasAuthToken: !!options?.authToken,
          },
          `📸 Photo request sent`,
        );

        // If using custom webhook URL, resolve immediately since photo will be uploaded directly to custom endpoint
        if (options?.customWebhookUrl) {
          this.logger.info(
            { requestId, customWebhookUrl: options.customWebhookUrl },
            `📸 Using custom webhook URL - resolving promise immediately since photo will be uploaded directly to custom endpoint`,
          );

          // Complete the request at AppServer level and resolve with mock data
          const pending = this.session.appServer.completePhotoRequest(requestId);
          if (pending) {
            const mockPhotoData: PhotoData = {
              buffer: Buffer.from([]), // Empty buffer since we don't have the actual photo
              mimeType: "image/jpeg",
              filename: "photo.jpg",
              requestId,
              size: 0,
              timestamp: new Date(),
            };
            pending.resolve(mockPhotoData);
          }
          return;
        }

        // Timeout is now handled at AppServer level in registerPhotoRequest()
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        reject(`Failed to request photo: ${errorMessage}`);
      }
    });
  }

  // NOTE: handlePhotoReceived() and handlePhotoError() have been removed.
  // Photo responses are now handled directly by AppServer's /photo-upload endpoint,
  // which resolves/rejects the promise stored in AppServer.pendingPhotoRequests.
  // See: cloud/issues/019-sdk-photo-request-architecture

  /**
   * 🔍 Check if there's a pending photo request for the given request ID
   * @deprecated Photo requests are now managed at AppServer level. This method delegates to AppServer.
   *
   * @param requestId - The request ID to check
   * @returns true if there's a pending request
   */
  hasPhotoPendingRequest(requestId: string): boolean {
    return this.session.appServer.getPhotoRequest(requestId) !== undefined;
  }

  /**
   * ❌ Cancel a pending photo request
   * @deprecated Photo requests are now managed at AppServer level. This method delegates to AppServer.
   *
   * @param requestId - The request ID to cancel
   * @returns true if the request was cancelled, false if it wasn't found
   */
  cancelPhotoRequest(requestId: string): boolean {
    const pending = this.session.appServer.completePhotoRequest(requestId);
    if (pending) {
      pending.reject(new Error("Photo request cancelled"));
      this.logger.info({ requestId }, `📸 Photo request cancelled`);
      return true;
    }
    return false;
  }

  /**
   * 🧹 Cancel all pending photo requests for this session
   * @deprecated Photo requests are now managed at AppServer level. Use AppServer.cleanupPhotoRequestsForSession() instead.
   *
   * @returns Number of requests that were cancelled (always 0, cleanup happens at AppServer level)
   */
  cancelAllPhotoRequests(): number {
    // Photo request cleanup is now handled by AppServer.cleanupPhotoRequestsForSession()
    // which is called when the session permanently disconnects
    this.logger.debug(`📸 cancelAllPhotoRequests called - cleanup now happens at AppServer level`);
    return 0;
  }

  // =====================================
  // 📹 Streaming Functionality
  // =====================================

  /**
   * 📹 Start an RTMP stream to the specified URL
   *
   * @param options - Configuration options for the stream
   * @returns Promise that resolves when the stream request is sent (not when streaming begins)
   *
   * @example
   * ```typescript
   * await session.camera.startStream({
   *   rtmpUrl: 'rtmp://live.example.com/stream/key',
   *   video: { resolution: '1920x1080', bitrate: 5000 },
   *   audio: { bitrate: 128 }
   * });
   * ```
   */
  async startStream(options: RtmpStreamOptions): Promise<void> {
    this.logger.info({ rtmpUrl: options.rtmpUrl }, `📹 RTMP stream request starting`);

    cameraWarnLog(this.session.getHttpsServerUrl?.(), this.packageName, "startStream");

    if (!options.rtmpUrl) {
      throw new Error("rtmpUrl is required");
    }

    if (this.isStreaming) {
      this.logger.error(
        {
          currentStreamUrl: this.currentStreamUrl,
          requestedUrl: options.rtmpUrl,
        },
        `📹 Already streaming error`,
      );
      throw new Error("Already streaming. Stop the current stream before starting a new one.");
    }

    // Create stream request message
    const message: RtmpStreamRequest = {
      type: AppToCloudMessageType.RTMP_STREAM_REQUEST,
      packageName: this.packageName,
      sessionId: this.sessionId,
      rtmpUrl: options.rtmpUrl,
      video: options.video,
      audio: options.audio,
      stream: options.stream,
      timestamp: new Date(),
    };

    // Save stream URL for reference
    this.currentStreamUrl = options.rtmpUrl;

    // Send the request
    try {
      this.session.sendMessage(message);
      this.isStreaming = true;

      this.logger.info({ rtmpUrl: options.rtmpUrl }, `📹 RTMP stream request sent successfully`);
      return Promise.resolve();
    } catch (error) {
      this.logger.error({ error, rtmpUrl: options.rtmpUrl }, `📹 Failed to send RTMP stream request`);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return Promise.reject(`Failed to request RTMP stream: ${errorMessage}`);
    }
  }

  /**
   * 🛑 Stop the current RTMP stream
   *
   * @returns Promise that resolves when the stop request is sent
   *
   * @example
   * ```typescript
   * await session.camera.stopStream();
   * ```
   */
  async stopStream(): Promise<void> {
    this.logger.info(
      {
        isCurrentlyStreaming: this.isStreaming,
        currentStreamUrl: this.currentStreamUrl,
      },
      `📹 RTMP stream stop request`,
    );

    if (!this.isStreaming) {
      this.logger.info(`📹 Not streaming - no-op`);
      // Not an error - just a no-op if not streaming
      return Promise.resolve();
    }

    // Create stop request message
    const message: RtmpStreamStopRequest = {
      type: AppToCloudMessageType.RTMP_STREAM_STOP,
      packageName: this.packageName,
      sessionId: this.sessionId,
      streamId: this.currentStreamState?.streamId, // Include streamId if available
      timestamp: new Date(),
    };

    // Send the request
    try {
      this.session.sendMessage(message);
      return Promise.resolve();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return Promise.reject(`Failed to stop RTMP stream: ${errorMessage}`);
    }
  }

  /**
   * 🔍 Check if currently streaming
   *
   * @returns True if a stream is active or initializing
   */
  isCurrentlyStreaming(): boolean {
    return this.isStreaming;
  }

  /**
   * 📍 Get the URL of the current stream (if any)
   *
   * @returns The RTMP URL of the current stream, or undefined if not streaming
   */
  getCurrentStreamUrl(): string | undefined {
    return this.currentStreamUrl;
  }

  /**
   * 📊 Get the current stream status
   *
   * @returns The current stream status, or undefined if not available
   */
  getStreamStatus(): RtmpStreamStatus | undefined {
    return this.currentStreamState;
  }

  /**
   * 📺 Subscribe to RTMP stream status updates
   * This uses the standard stream subscription mechanism
   */
  subscribeToStreamStatusUpdates(): void {
    if (this.session) {
      this.session.subscribe(StreamType.RTMP_STREAM_STATUS);
    } else {
      this.logger.error("Cannot subscribe to status updates: session reference not available");
    }
  }

  /**
   * 📺 Unsubscribe from RTMP stream status updates
   */
  unsubscribeFromStreamStatusUpdates(): void {
    if (this.session) {
      this.session.unsubscribe(StreamType.RTMP_STREAM_STATUS);
    }
  }

  /**
   * 👂 Listen for stream status updates using the standard event system
   * @param handler - Function to call when stream status changes
   * @returns Cleanup function to remove the handler
   *
   * @example
   * ```typescript
   * const cleanup = session.camera.onStreamStatus((status) => {
   *   console.log('Stream status:', status.status);
   *   if (status.status === 'error') {
   *     console.error('Stream error:', status.errorDetails);
   *   }
   * });
   *
   * // Later, cleanup the listener
   * cleanup();
   * ```
   */
  onStreamStatus(handler: StreamStatusHandler): () => void {
    if (!this.session) {
      this.logger.error("Cannot listen for status updates: session reference not available");
      return () => {};
    }

    this.subscribeToStreamStatusUpdates();
    return this.session.on(StreamType.RTMP_STREAM_STATUS, handler);
  }

  /**
   * 🔄 Update internal stream state based on a status message
   * For internal use by AppSession
   * @param message - The status message from the cloud
   * @internal This method is used internally by AppSession
   */
  updateStreamState(message: any): void {
    this.logger.debug(
      {
        messageType: message?.type,
        messageStatus: message?.status,
        currentIsStreaming: this.isStreaming,
      },
      `📹 Stream state update`,
    );

    // Verify this is a valid stream response
    if (!isRtmpStreamStatus(message)) {
      this.logger.warn({ message }, `📹 Received invalid stream status message`);
      return;
    }

    // Convert to StreamStatus format
    const status: RtmpStreamStatus = {
      type: message.type,
      streamId: message.streamId,
      status: message.status,
      errorDetails: message.errorDetails,
      appId: message.appId,
      stats: message.stats,
      timestamp: message.timestamp || new Date(),
    };

    this.logger.info(
      {
        streamId: status.streamId,
        oldStatus: this.currentStreamState?.status,
        newStatus: status.status,
        wasStreaming: this.isStreaming,
      },
      `📹 Stream status processed`,
    );

    // Update local state based on status
    if (status.status === "stopped" || status.status === "error" || status.status === "timeout") {
      this.logger.info(
        {
          status: status.status,
          wasStreaming: this.isStreaming,
        },
        `📹 Stream stopped - updating local state`,
      );
      this.isStreaming = false;
      this.currentStreamUrl = undefined;
    }

    // Save the latest status
    this.currentStreamState = status;
  }

  // =====================================
  // 📹 Managed Streaming Functionality
  // =====================================

  /**
   * 📹 Start a managed stream
   *
   * The cloud handles the RTMP endpoint and returns HLS/DASH URLs for viewing.
   * Multiple apps can consume the same managed stream simultaneously.
   *
   * @param options - Configuration options for the managed stream
   * @returns Promise that resolves with viewing URLs when the stream is ready
   *
   * @example
   * ```typescript
   * const urls = await session.camera.startManagedStream({
   *   quality: '720p',
   *   enableWebRTC: true
   * });
   * console.log('HLS URL:', urls.hlsUrl);
   * ```
   */
  async startManagedStream(options?: ManagedStreamOptions): Promise<ManagedStreamResult> {
    return this.managedExtension.startManagedStream(options);
  }

  /**
   * 🛑 Stop the current managed stream
   *
   * This will stop streaming for this app only. If other apps are consuming
   * the same managed stream, it will continue for them.
   *
   * @returns Promise that resolves when the stop request is sent
   */
  async stopManagedStream(): Promise<void> {
    return this.managedExtension.stopManagedStream();
  }

  /**
   * 🔔 Register a handler for managed stream status updates
   *
   * @param handler - Function to call when stream status changes
   * @returns Cleanup function to unregister the handler
   */
  onManagedStreamStatus(handler: (status: ManagedStreamStatus) => void): () => void {
    return this.managedExtension.onManagedStreamStatus(handler);
  }

  /**
   * 📊 Check if currently managed streaming
   *
   * @returns true if a managed stream is active
   */
  isManagedStreamActive(): boolean {
    return this.managedExtension.isManagedStreamActive();
  }

  /**
   * 🔗 Get current managed stream URLs
   *
   * @returns Current stream URLs or undefined if not streaming
   */
  getManagedStreamUrls(): ManagedStreamResult | undefined {
    return this.managedExtension.getManagedStreamUrls();
  }

  /**
   * 🔍 Check for any existing streams (managed or unmanaged) for the current user
   *
   * This method checks if there's already an active stream for the current user,
   * which is useful to avoid conflicts and to reconnect to existing streams.
   *
   * @returns Promise that resolves with stream information if a stream exists
   *
   * @example
   * ```typescript
   * const streamInfo = await session.camera.checkExistingStream();
   * if (streamInfo.hasActiveStream) {
   *   console.log('Stream type:', streamInfo.streamInfo?.type);
   *   if (streamInfo.streamInfo?.type === 'managed') {
   *     console.log('HLS URL:', streamInfo.streamInfo.hlsUrl);
   *   } else {
   *     console.log('RTMP URL:', streamInfo.streamInfo.rtmpUrl);
   *   }
   * }
   * ```
   */
  async checkExistingStream(): Promise<{
    hasActiveStream: boolean;
    streamInfo?: {
      type: "managed" | "unmanaged";
      streamId: string;
      status: string;
      createdAt: Date;
      // For managed streams
      hlsUrl?: string;
      dashUrl?: string;
      webrtcUrl?: string;
      previewUrl?: string;
      thumbnailUrl?: string;
      activeViewers?: number;
      // For unmanaged streams
      rtmpUrl?: string;
      requestingAppId?: string;
    };
  }> {
    return this.managedExtension.checkExistingStream();
  }

  /**
   * Handle incoming stream status check response
   * @internal
   */
  handleStreamCheckResponse(response: StreamStatusCheckResponse): void {
    this.managedExtension.handleStreamCheckResponse(response);
  }

  /**
   * Handle incoming managed stream status messages
   * @internal
   */
  handleManagedStreamStatus(message: ManagedStreamStatus): void {
    this.managedExtension.handleManagedStreamStatus(message);
  }

  // =====================================
  // 🔧 General Utilities
  // =====================================

  /**
   * 🔧 Update the session ID (used when reconnecting)
   *
   * @param newSessionId - The new session ID
   * @internal This method is used internally by AppSession
   */
  updateSessionId(newSessionId: string): void {
    this.sessionId = newSessionId;
  }

  /**
   * 🧹 Cancel all pending requests and clean up resources
   *
   * @returns Object with counts of cancelled requests
   */
  cancelAllRequests(): { photoRequests: number } {
    const photoRequests = this.cancelAllPhotoRequests();

    // Stop streaming if active
    if (this.isStreaming) {
      this.stopStream().catch((error) => {
        this.logger.error({ error }, "Error stopping stream during cleanup");
      });
    }

    // Clean up managed extension
    this.managedExtension.cleanup();

    return { photoRequests };
  }
}

// Re-export types for convenience
export { VideoConfig, AudioConfig, StreamConfig, StreamStatusHandler };
