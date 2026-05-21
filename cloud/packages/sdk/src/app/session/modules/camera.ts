/**
 * 📷 Camera Module
 *
 * Unified camera functionality for App Sessions.
 * Handles photo requests and livestreaming from connected glasses.
 */

import {
  PhotoRequest,
  PhotoData,
  AppToCloudMessageType,
  StreamRequest,
  StreamStopRequest,
  StreamStatus,
  isStreamStatus,
  ManagedStreamStatus,
  StreamStatusCheckResponse,
  CameraFovSetRequest,
  CameraRoiPosition,
} from "../../../types";
import {
  VideoConfig,
  AudioConfig,
  StreamConfig,
  StreamStatusHandler,
  validateVideoConfig,
} from "../../../types/rtmp-stream";
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
  /** Controls shutter sound. Defaults to true if omitted. */
  sound?: boolean;
  /**
   * Sensor exposure time for this photo request only (nanoseconds). Not persisted.
   * Invalid values are ignored on the wire; device falls back to auto exposure.
   */
  exposureTimeNs?: number;
}

/**
 * Configuration options for a stream (RTMP, SRT, or WHIP)
 */
export interface StreamOptions {
  /** The stream URL to stream to. Supports rtmp://, rtmps://, srt://, and https:// (WHIP) protocols.
   * @example "rtmp://server.example.com/live/stream-key"
   * @example "srt://server.example.com:4201?streamid=your-stream-id"
   * @example "https://server.example.com/whip/endpoint"
   */
  streamUrl: string;
  /** Optional video configuration settings */
  video?: VideoConfig;
  /** Optional audio configuration settings */
  audio?: AudioConfig;
  /** Optional stream configuration settings */
  stream?: StreamConfig;
  /** Controls stream start/stop sounds. Defaults to true if omitted. */
  sound?: boolean;
}

/**
 * Options for setting the camera FOV and ROI position
 */
export interface CameraFovOptions {
  /** Field of view in degrees (82-118). 118 means full sensor, no crop. */
  fov: number;
  /** ROI crop position. Ignored when fov is 118. Defaults to "center". */
  roiPosition?: CameraRoiPosition;
}

const VALID_ROI_POSITIONS: CameraRoiPosition[] = ["center", "top", "bottom"];

/**
 * 📷 Camera Module Implementation
 *
 * Unified camera management for App Sessions.
 * Provides methods for:
 * - 📸 Requesting photos from glasses
 * - 📹 Starting/stopping livestreams
 * - 🔍 Monitoring photo and stream status
 * - 🧹 Cleanup and cancellation
 *
 * @example
 * ```typescript
 * // Request a photo
 * const photoData = await session.camera.requestPhoto({ saveToGallery: true });
 *
 * // Start a livestream (managed, WebRTC by default)
 * const urls = await session.camera.startLivestream();
 *
 * // Start a local livestream (unmanaged, to your own server)
 * await session.camera.startLocalLivestream({ streamUrl: 'srt://192.168.1.100:4201' });
 *
 * // Monitor stream status
 * session.camera.onLocalLivestreamStatus((status) => {
 *   console.log('Stream status:', status.status);
 * });
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
  private currentStreamState?: StreamStatus;

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
        const expNs = options?.exposureTimeNs;
        const includeExp = typeof expNs === "number" && Number.isFinite(expNs) && expNs > 0;

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
          sound: options?.sound,
          ...(includeExp ? { exposureTimeNs: expNs } : {}),
        };

        // Send request to cloud
        this.session.sendMessage(message);

        this.logger.info(
          {
            requestId,
            saveToGallery: options?.saveToGallery,
            hasCustomWebhook: !!options?.customWebhookUrl,
            hasAuthToken: !!options?.authToken,
            exposureTimeNs: includeExp ? expNs : undefined,
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
   * @returns true if the request was found and cancelled
   */
  cancelPhotoRequest(requestId: string): boolean {
    const pending = this.session.appServer.completePhotoRequest(requestId);
    if (pending) {
      pending.reject(new Error("Photo request cancelled"));
      this.logger.debug({ requestId }, "Photo request cancelled");
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
    this.logger.debug("cancelAllPhotoRequests called — cleanup now happens at AppServer level");
    return 0;
  }

  // =====================================
  // 🔭 FOV / ROI Control
  // =====================================

  /**
   * 🔭 Set the camera field-of-view and ROI crop position
   *
   * Fire-and-forget: the promise resolves once the message is sent.
   * The phone applies the setting and pushes it to the glasses over BLE.
   *
   * @param options - FOV (82-118) and optional ROI position
   *
   * @example
   * ```typescript
   * // Narrow crop, looking at the top of the frame
   * await session.camera.setFov({ fov: 92, roiPosition: "top" });
   *
   * // Full sensor, no crop (roiPosition is ignored)
   * await session.camera.setFov({ fov: 118 });
   * ```
   */
  async setFov(options: CameraFovOptions): Promise<void> {
    const { fov } = options;
    let roiPosition: CameraRoiPosition = options.roiPosition ?? "center";

    if (fov < 82 || fov > 118) {
      throw new Error(`fov must be between 82 and 118, got ${fov}`);
    }

    if (!VALID_ROI_POSITIONS.includes(roiPosition)) {
      throw new Error(`roiPosition must be one of ${VALID_ROI_POSITIONS.join(", ")}, got "${roiPosition}"`);
    }

    if (fov === 118) {
      roiPosition = "center";
    }

    const requestId = `cam_fov_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    const message: CameraFovSetRequest = {
      type: AppToCloudMessageType.CAMERA_FOV_SET,
      packageName: this.packageName,
      sessionId: this.sessionId,
      requestId,
      fov,
      roiPosition,
      timestamp: new Date(),
    };

    this.session.sendMessage(message);
    this.logger.info({ fov, roiPosition, requestId }, "🔭 Camera FOV set request sent");
  }

  // =====================================
  // 📹 Local Livestream (Unmanaged)
  // =====================================

  /**
   * 📹 Start a local livestream to your own server (supports SRT, RTMP, WHIP)
   *
   * Use this when streaming to a server you control (local network or remote).
   * For managed streaming with automatic WebRTC playback, use `startLivestream()` instead.
   *
   * @param options - Configuration options including the stream URL
   * @returns Promise that resolves when the stream request is sent (not when streaming begins)
   *
   * @example
   * ```typescript
   * await session.camera.startLocalLivestream({
   *   streamUrl: 'srt://192.168.1.100:4201?streamid=my-stream',
   * });
   * ```
   */
  async startLocalLivestream(options: StreamOptions): Promise<void> {
    this.logger.info({ streamUrl: options.streamUrl }, `📹 Stream request starting`);

    cameraWarnLog(this.session.getHttpsServerUrl?.(), this.packageName, "startLocalLivestream");

    validateVideoConfig(options.video);

    if (!options.streamUrl) {
      throw new Error("streamUrl is required");
    }

    const url = options.streamUrl;
    if (
      !url.startsWith("rtmp://") &&
      !url.startsWith("rtmps://") &&
      !url.startsWith("srt://") &&
      !url.startsWith("https://") &&
      !url.startsWith("http://")
    ) {
      throw new Error("Invalid stream URL: must start with rtmp://, rtmps://, srt://, https://, or http://");
    }

    if (this.isStreaming) {
      this.logger.error(
        {
          currentStreamUrl: this.currentStreamUrl,
          requestedUrl: options.streamUrl,
        },
        `📹 Already streaming error`,
      );
      throw new Error("Already streaming. Stop the current stream before starting a new one.");
    }

    // Create stream request message
    const message: StreamRequest = {
      type: AppToCloudMessageType.STREAM_REQUEST,
      packageName: this.packageName,
      sessionId: this.sessionId,
      streamUrl: options.streamUrl,
      video: options.video,
      audio: options.audio,
      stream: options.stream,
      sound: options.sound,
      timestamp: new Date(),
    };

    // Save stream URL for reference
    this.currentStreamUrl = options.streamUrl;

    // Send the request
    try {
      this.session.sendMessage(message);
      this.isStreaming = true;

      this.logger.info({ streamUrl: options.streamUrl }, `📹 Stream request sent successfully`);
      return Promise.resolve();
    } catch (error) {
      this.logger.error({ error, streamUrl: options.streamUrl }, `📹 Failed to send stream request`);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return Promise.reject(`Failed to request stream: ${errorMessage}`);
    }
  }

  /**
   * 🛑 Stop the current local livestream
   *
   * @returns Promise that resolves when the stop request is sent
   *
   * @example
   * ```typescript
   * await session.camera.stopLocalLivestream();
   * ```
   */
  async stopLocalLivestream(): Promise<void> {
    this.logger.info(
      {
        isCurrentlyStreaming: this.isStreaming,
        currentStreamUrl: this.currentStreamUrl,
      },
      `📹 Stream stop request`,
    );

    if (!this.isStreaming) {
      this.logger.info(`📹 Not streaming - no-op`);
      // Not an error - just a no-op if not streaming
      return Promise.resolve();
    }

    // Create stop request message
    const message: StreamStopRequest = {
      type: AppToCloudMessageType.STREAM_STOP,
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
  getStreamStatus(): StreamStatus | undefined {
    return this.currentStreamState;
  }

  /**
   * 📺 Subscribe to RTMP stream status updates
   * This uses the standard stream subscription mechanism
   */
  subscribeToStreamStatusUpdates(): void {
    if (this.session) {
      this.session.subscribe(StreamType.STREAM_STATUS);
    } else {
      this.logger.error("Cannot subscribe to status updates: session reference not available");
    }
  }

  /**
   * 📺 Unsubscribe from RTMP stream status updates
   */
  unsubscribeFromStreamStatusUpdates(): void {
    if (this.session) {
      this.session.unsubscribe(StreamType.STREAM_STATUS);
    }
  }

  /**
   * 👂 Listen for local livestream status updates
   * @param handler - Function to call when stream status changes
   * @returns Cleanup function to remove the handler
   *
   * @example
   * ```typescript
   * const cleanup = session.camera.onLocalLivestreamStatus((status) => {
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
  onLocalLivestreamStatus(handler: StreamStatusHandler): () => void {
    if (!this.session) {
      this.logger.error("Cannot listen for status updates: session reference not available");
      return () => {};
    }

    this.subscribeToStreamStatusUpdates();
    return this.session.on(StreamType.STREAM_STATUS, handler);
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
    if (!isStreamStatus(message)) {
      this.logger.warn({ message }, `📹 Received invalid stream status message`);
      return;
    }

    // Convert to StreamStatus format
    const status: StreamStatus = {
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
  // 📹 Livestream (Managed)
  // =====================================

  /**
   * 📹 Start a livestream
   *
   * Managed by Mentra cloud. Returns playback URLs automatically.
   * By default uses WebRTC for sub-second latency. If restreamDestinations
   * are provided, switches to SRT ingest with HLS/DASH playback.
   * Multiple miniapps can consume the same livestream simultaneously.
   *
   * @param options - Configuration options for the livestream
   * @returns Promise that resolves with playback URLs when the stream is ready
   *
   * @example
   * ```typescript
   * // Default: WebRTC (low latency)
   * const urls = await session.camera.startLivestream();
   * console.log('WebRTC URL:', urls.webrtcUrl);
   *
   * // With restream destinations: SRT + HLS/DASH
   * const urls = await session.camera.startLivestream({
   *   restreamDestinations: [{ url: 'rtmp://...', name: 'YouTube' }]
   * });
   * console.log('HLS URL:', urls.hlsUrl);
   * ```
   */
  async startLivestream(options?: ManagedStreamOptions): Promise<ManagedStreamResult> {
    return this.managedExtension.startManagedStream(options);
  }

  /**
   * 🛑 Stop the current livestream
   *
   * This will stop streaming for this miniapp only. If other miniapps are consuming
   * the same livestream, it will continue for them.
   *
   * @returns Promise that resolves when the stop request is sent
   */
  async stopLivestream(): Promise<void> {
    return this.managedExtension.stopManagedStream();
  }

  /**
   * 🔔 Register a handler for livestream status updates
   *
   * @param handler - Function to call when stream status changes
   * @returns Cleanup function to unregister the handler
   */
  onLivestreamStatus(handler: (status: ManagedStreamStatus) => void): () => void {
    return this.managedExtension.onManagedStreamStatus(handler);
  }

  /**
   * 📊 Check if a livestream is active
   *
   * @returns true if a livestream is active
   */
  isLivestreamActive(): boolean {
    return this.managedExtension.isManagedStreamActive();
  }

  /**
   * 🔗 Get current livestream URLs
   *
   * @returns Current stream URLs or undefined if not streaming
   */
  getLivestreamUrls(): ManagedStreamResult | undefined {
    return this.managedExtension.getManagedStreamUrls();
  }

  // =====================================
  // 🔄 Deprecated aliases (old method names)
  // =====================================

  /** @deprecated Use `startLivestream()` instead */
  async startManagedStream(options?: ManagedStreamOptions): Promise<ManagedStreamResult> {
    return this.startLivestream(options);
  }
  /** @deprecated Use `stopLivestream()` instead */
  async stopManagedStream(): Promise<void> {
    return this.stopLivestream();
  }
  /** @deprecated Use `onLivestreamStatus()` instead */
  onManagedStreamStatus(handler: (status: ManagedStreamStatus) => void): () => void {
    return this.onLivestreamStatus(handler);
  }
  /** @deprecated Use `isLivestreamActive()` instead */
  isManagedStreamActive(): boolean {
    return this.isLivestreamActive();
  }
  /** @deprecated Use `getLivestreamUrls()` instead */
  getManagedStreamUrls(): ManagedStreamResult | undefined {
    return this.getLivestreamUrls();
  }
  /** @deprecated Use `startLocalLivestream()` instead */
  async startStream(options: StreamOptions): Promise<void> {
    return this.startLocalLivestream(options);
  }
  /** @deprecated Use `stopLocalLivestream()` instead */
  async stopStream(): Promise<void> {
    return this.stopLocalLivestream();
  }
  /** @deprecated Use `onLocalLivestreamStatus()` instead */
  onStreamStatus(handler: StreamStatusHandler): () => void {
    return this.onLocalLivestreamStatus(handler);
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
   *     console.log('Stream URL:', streamInfo.streamInfo.streamUrl);
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
      streamUrl?: string;
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
      this.stopLocalLivestream().catch((error) => {
        this.logger.error({ error }, "Error stopping stream during cleanup");
      });
    }

    // Clean up managed extension
    this.managedExtension.cleanup();

    return { photoRequests };
  }
}

// Re-export types for convenience
export type { VideoConfig, AudioConfig, StreamConfig, StreamStatusHandler };
