/**
 * 📷 Camera Module Managed Streaming Extension
 *
 * Extends the camera module with managed streaming capabilities.
 * Apps can request managed streams and receive HLS/DASH URLs without managing RTMP endpoints.
 */

import {
  ManagedStreamRequest,
  ManagedStreamStopRequest,
  ManagedStreamStatus,
  StreamStatusCheckRequest,
  StreamStatusCheckResponse,
  AppToCloudMessageType,
  StreamType,
  RestreamDestination,
} from "../../../types"
import {VideoConfig, AudioConfig, StreamConfig} from "../../../types/rtmp-stream"
import {Logger} from "pino"

/**
 * Configuration options for a managed stream
 */
export interface ManagedStreamOptions {
  /** Stream quality preset */
  quality?: "720p" | "1080p"
  /** Enable WebRTC for ultra-low latency viewing */
  enableWebRTC?: boolean
  /** Optional video configuration settings */
  video?: VideoConfig
  /** Optional audio configuration settings */
  audio?: AudioConfig
  /** Optional stream configuration settings */
  stream?: StreamConfig
  /** Optional RTMP destinations to re-stream to (YouTube, Twitch, etc) */
  restreamDestinations?: RestreamDestination[]
}

/**
 * Result returned when starting a managed stream
 */
export interface ManagedStreamResult {
  /** HLS URL for viewing the stream */
  hlsUrl: string
  /** DASH URL for viewing the stream */
  dashUrl: string
  /** WebRTC URL if enabled */
  webrtcUrl?: string
  /** Cloudflare Stream player/preview URL for embedding */
  previewUrl?: string
  /** Thumbnail image URL */
  thumbnailUrl?: string
  /** Internal stream ID */
  streamId: string
}

/**
 * 📹 Managed Streaming Extension for Camera Module
 *
 * Provides managed streaming capabilities where the cloud handles
 * RTMP endpoints and returns HLS/DASH URLs for viewing.
 *
 * @example
 * ```typescript
 * // Start a managed stream
 * const urls = await session.camera.startManagedStream({
 *   quality: '720p',
 *   enableWebRTC: true
 * });
 * console.log('HLS URL:', urls.hlsUrl);
 * console.log('DASH URL:', urls.dashUrl);
 * console.log('Player URL:', urls.previewUrl);
 * console.log('Thumbnail:', urls.thumbnailUrl);
 *
 * // Monitor managed stream status
 * session.camera.onManagedStreamStatus((status) => {
 *   console.log('Managed stream status:', status.status);
 * });
 *
 * // Stop managed stream
 * await session.camera.stopManagedStream();
 * ```
 */
export class CameraManagedExtension {
  private session: any
  private packageName: string
  private sessionId: string
  private logger: Logger

  // Managed streaming state
  private isManagedStreaming: boolean = false
  private currentManagedStreamId?: string
  private currentManagedStreamUrls?: ManagedStreamResult
  private managedStreamStatus?: ManagedStreamStatus

  // For tracking pending stream check requests
  private pendingStreamChecks?: Map<
    string,
    {
      resolve: (value: any) => void
      timeoutId: NodeJS.Timeout
    }
  >

  // Promise tracking for managed stream initialization
  private pendingManagedStreamRequest?: {
    resolve: (value: ManagedStreamResult) => void
    reject: (reason?: any) => void
  }

  constructor(session: any, packageName: string, sessionId: string, logger: Logger) {
    this.session = session
    this.packageName = packageName
    this.sessionId = sessionId
    this.logger = logger.child({module: "CameraManagedExtension"})
  }

  /**
   * 📹 Start a managed stream
   *
   * The cloud will handle the RTMP endpoint and return HLS/DASH URLs for viewing.
   * Multiple apps can consume the same managed stream simultaneously.
   *
   * @param options - Configuration options for the managed stream
   * @returns Promise that resolves with viewing URLs when the stream is ready
   *
   * @example
   * ```typescript
   * const urls = await session.camera.startManagedStream({
   *   quality: '1080p',
   *   enableWebRTC: true,
   *   video: { fps: 30 },
   *   audio: { sampleRate: 48000 }
   * });
   *
   * // Access all available URLs
   * console.log('HLS URL:', urls.hlsUrl);
   * console.log('DASH URL:', urls.dashUrl);
   * console.log('Player URL:', urls.previewUrl);  // Embeddable player
   * console.log('Thumbnail:', urls.thumbnailUrl);
   * ```
   */
  async startManagedStream(options: ManagedStreamOptions = {}): Promise<ManagedStreamResult> {
    this.logger.info({options}, "📹 Managed stream request starting")

    if (this.isManagedStreaming) {
      this.logger.error(
        {
          currentStreamId: this.currentManagedStreamId,
        },
        "📹 Already managed streaming error",
      )
      throw new Error("Already streaming. Stop the current managed stream before starting a new one.")
    }

    // Create the request message
    const request: ManagedStreamRequest = {
      type: AppToCloudMessageType.MANAGED_STREAM_REQUEST,
      packageName: this.packageName,
      quality: options.quality,
      enableWebRTC: options.enableWebRTC,
      video: options.video,
      audio: options.audio,
      stream: options.stream,
      restreamDestinations: options.restreamDestinations,
    }

    // Send the request
    this.session.sendMessage(request)
    this.isManagedStreaming = true

    // Create promise to wait for URLs
    return new Promise((resolve, reject) => {
      this.pendingManagedStreamRequest = {resolve, reject}

      // Set a timeout
      setTimeout(() => {
        if (this.pendingManagedStreamRequest) {
          this.pendingManagedStreamRequest = undefined
          this.isManagedStreaming = false
          reject(new Error("Managed stream request timeout"))
        }
      }, 30000) // 30 second timeout
    })
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
    // Always send the stop request - the cloud will handle whether there's actually
    // a stream to stop. This ensures the stop works even after reload/reconnection
    this.logger.info(
      {
        streamId: this.currentManagedStreamId,
        hasInternalState: this.isManagedStreaming,
      },
      "📹 Sending managed stream stop request",
    )

    const request: ManagedStreamStopRequest = {
      type: AppToCloudMessageType.MANAGED_STREAM_STOP,
      packageName: this.packageName,
    }

    this.session.sendMessage(request)

    // Don't clean up state immediately - wait for the 'stopped' status from cloud
    // This ensures we can retry stop if needed and maintains accurate state
  }

  /**
   * 🔍 Check for any existing streams (managed or unmanaged) for the current user
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
   *   }
   * }
   * ```
   */
  async checkExistingStream(): Promise<{
    hasActiveStream: boolean
    streamInfo?: {
      type: "managed" | "unmanaged"
      streamId: string
      status: string
      createdAt: Date
      // For managed streams
      hlsUrl?: string
      dashUrl?: string
      webrtcUrl?: string
      previewUrl?: string
      thumbnailUrl?: string
      activeViewers?: number
      // For unmanaged streams
      rtmpUrl?: string
      requestingAppId?: string
    }
  }> {
    return new Promise((resolve) => {
      // Store the resolver for the response
      const requestId = `stream_check_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`

      // Store a pending request that will be resolved when we get the response
      if (!this.pendingStreamChecks) {
        this.pendingStreamChecks = new Map()
      }

      const timeoutId = setTimeout(() => {
        this.pendingStreamChecks?.delete(requestId)
        resolve({hasActiveStream: false})
      }, 5000) // 5 second timeout

      this.pendingStreamChecks.set(requestId, {
        resolve,
        timeoutId,
      })

      // Send the check request with the requestId
      const request: StreamStatusCheckRequest = {
        type: AppToCloudMessageType.STREAM_STATUS_CHECK,
        packageName: this.packageName,
        sessionId: this.sessionId,
      }

      this.session.sendMessage(request)
    })
  }

  /**
   * 📊 Check if currently managed streaming
   *
   * @returns true if a managed stream is active
   */
  isManagedStreamActive(): boolean {
    return this.isManagedStreaming
  }

  /**
   * 🔗 Get current managed stream URLs
   *
   * @returns Current stream URLs or undefined if not streaming
   */
  getManagedStreamUrls(): ManagedStreamResult | undefined {
    return this.currentManagedStreamUrls
  }

  /**
   * 📊 Get current managed stream status
   *
   * @returns Current stream status or undefined
   */
  getManagedStreamStatus(): ManagedStreamStatus | undefined {
    return this.managedStreamStatus
  }

  /**
   * 🔔 Register a handler for managed stream status updates
   *
   * @param handler - Function to call when stream status changes
   * @returns Cleanup function to unregister the handler
   *
   * @example
   * ```typescript
   * const cleanup = session.camera.onManagedStreamStatus((status) => {
   *   console.log('Status:', status.status);
   *   if (status.status === 'active') {
   *     console.log('Stream is live!');
   *   }
   * });
   *
   * // Later, unregister the handler
   * cleanup();
   * ```
   */
  onManagedStreamStatus(handler: (status: ManagedStreamStatus) => void): () => void {
    if (!this.session) {
      this.logger.error("Cannot listen for managed status updates: session reference not available")
      return () => {}
    }

    this.session.subscribe(StreamType.MANAGED_STREAM_STATUS)

    // Register the handler using the session's event system
    return this.session.on(StreamType.MANAGED_STREAM_STATUS, handler)
  }

  /**
   * Handle incoming stream status check response
   * Called by the parent AppSession when a response is received
   */
  handleStreamCheckResponse(response: StreamStatusCheckResponse): void {
    // Find and resolve any pending stream check
    if (this.pendingStreamChecks && this.pendingStreamChecks.size > 0) {
      const firstEntry = this.pendingStreamChecks.entries().next()
      if (!firstEntry.done && firstEntry.value) {
        const [requestId, pending] = firstEntry.value
        if (pending) {
          clearTimeout(pending.timeoutId)
          this.pendingStreamChecks.delete(requestId)
          pending.resolve(response)
        }
      }
    }
  }

  /**
   * Handle incoming managed stream status messages
   * Called by the parent AppSession when messages are received
   */
  handleManagedStreamStatus(status: ManagedStreamStatus): void {
    this.logger.info(
      {
        status: status.status,
        streamId: status.streamId,
      },
      "📹 Received managed stream status",
    )

    this.managedStreamStatus = status

    // Handle initializing status - stream is starting
    if (status.status === "initializing" && status.streamId) {
      this.isManagedStreaming = true
      this.currentManagedStreamId = status.streamId
    }

    // Handle initial stream ready status
    if (status.status === "active") {
      // Always update state when stream is active
      this.isManagedStreaming = true
      this.currentManagedStreamId = status.streamId

      if (status.hlsUrl && status.dashUrl) {
        const result: ManagedStreamResult = {
          hlsUrl: status.hlsUrl,
          dashUrl: status.dashUrl,
          webrtcUrl: status.webrtcUrl,
          previewUrl: status.previewUrl,
          thumbnailUrl: status.thumbnailUrl,
          streamId: status.streamId || "",
        }

        this.currentManagedStreamUrls = result

        // Resolve pending promise if exists
        if (this.pendingManagedStreamRequest) {
          this.pendingManagedStreamRequest.resolve(result)
          this.pendingManagedStreamRequest = undefined
        }
      }
    }

    // Handle error status
    if ((status.status === "error" || status.status === "stopped") && this.pendingManagedStreamRequest) {
      this.pendingManagedStreamRequest.reject(new Error(status.message || "Managed stream failed"))
      this.pendingManagedStreamRequest = undefined
      this.isManagedStreaming = false
      this.currentManagedStreamId = undefined
      this.currentManagedStreamUrls = undefined
    }

    // Clean up on stopped status
    if (status.status === "stopped") {
      this.isManagedStreaming = false
      this.currentManagedStreamId = undefined
      this.currentManagedStreamUrls = undefined
    }

    // Clean up local state on error regardless of pending request state
    if (status.status === "error") {
      this.isManagedStreaming = false
      this.currentManagedStreamId = undefined
      this.currentManagedStreamUrls = undefined
    }

    // Notify handlers (would use event emitter in real implementation)
    // this.emit('managedStreamStatus', status);
  }

  /**
   * 🧹 Clean up all managed streaming state
   */
  cleanup(): void {
    if (this.pendingManagedStreamRequest) {
      this.pendingManagedStreamRequest.reject(new Error("Camera module cleanup"))
      this.pendingManagedStreamRequest = undefined
    }

    this.isManagedStreaming = false
    this.currentManagedStreamId = undefined
    this.currentManagedStreamUrls = undefined
    this.managedStreamStatus = undefined

    this.logger.info("📹 Managed streaming extension cleaned up")
  }
}
