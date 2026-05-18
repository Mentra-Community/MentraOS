/**
 * CameraManager — v3 SDK Camera API
 *
 * Covers:
 * - photo capture
 * - externally-triggered photo events
 * - unmanaged RTMP streaming
 * - managed stream orchestration/status
 */

import { EventEmitter } from "events";
import {
  AppToCloudMessageType,
  CloudToAppMessageType,
  type ManagedStreamStatus,
  type RestreamDestination,
  type StreamStatus,
  StreamType,
  type StreamStatusCheckResponse,
  type AudioConfig,
  type StreamConfig,
  type VideoConfig,
  validateVideoConfig,
} from "../../types";

export interface PhotoOptions {
  size?: "small" | "medium" | "large" | "full";
  compression?: "none" | "medium" | "heavy";
  saveToGallery?: boolean;
  sound?: boolean;
  /**
   * Sensor exposure time for this photo request only, in nanoseconds (Camera2 `SENSOR_EXPOSURE_TIME`).
   * Not saved as a camera preference. Omit for auto exposure. Invalid or unsupported values fall back to auto exposure on device.
   */
  exposureTimeNs?: number;
  timeout?: number;
}

export interface PhotoData {
  url: string;
  width: number;
  height: number;
  timestamp: number;
  savedToGallery: boolean;
}

/**
 * Options for session.camera.startStream().
 *
 * Three modes:
 * - No options → managed relay (default, best for most apps)
 * - `destinations` → managed relay + fan out to external services
 * - `direct` → glasses connect straight to this URL, no relay
 */
export interface StreamOptions {
  /** Direct stream URL. Glasses connect to this URL directly, bypassing the cloud relay.
   *  Supports srt://, rtmp://, rtmps://, and https:// (WHIP) protocols.
   *  When set, the cloud relay is not used. No viewer URLs are returned.
   *  Most apps should NOT use this — use the default managed relay instead. */
  direct?: string;

  /** Restream destinations. The cloud relay fans out to these URLs.
   *  Only works with managed streaming (when `direct` is not set).
   *  Each URL is an RTMP or SRT ingest endpoint (YouTube, Twitch, etc.) */
  destinations?: string[];

  /** Stream quality. Only applies to managed streaming. */
  quality?: "720p" | "1080p";

  /** Enable WebRTC playback URL. Only applies to managed streaming. Default: true. */
  enableWebRTC?: boolean;

  /** Video configuration (resolution, bitrate, fps) */
  video?: VideoConfig;

  /** Audio configuration (bitrate, sample rate) */
  audio?: AudioConfig;

  /** Stream transport configuration */
  stream?: StreamConfig;

  /** Controls stream start/stop sounds on the glasses. Default: true. */
  sound?: boolean;
}

export interface StreamResult {
  hlsUrl: string;
  dashUrl: string;
  webrtcUrl?: string;
  previewUrl?: string;
  thumbnailUrl?: string;
  streamId: string;
}

/** @deprecated Use StreamOptions instead */
export interface RtmpStreamOptions {
  rtmpUrl: string;
  video?: VideoConfig;
  audio?: AudioConfig;
  stream?: StreamConfig;
  sound?: boolean;
}

/** @deprecated Use StreamOptions with destinations instead */
export interface ManagedStreamOptions {
  quality?: "720p" | "1080p";
  enableWebRTC?: boolean;
  video?: VideoConfig;
  audio?: AudioConfig;
  stream?: StreamConfig;
  restreamDestinations?: RestreamDestination[];
  sound?: boolean;
}

/** @deprecated Use StreamResult instead */
export type ManagedStreamResult = StreamResult;

export interface ExistingStreamInfo {
  hasActiveStream: boolean;
  streamInfo?: {
    type: "managed" | "unmanaged";
    streamId: string;
    status: string;
    createdAt: Date;
    hlsUrl?: string;
    dashUrl?: string;
    webrtcUrl?: string;
    previewUrl?: string;
    thumbnailUrl?: string;
    activeViewers?: number;
    rtmpUrl?: string;
    requestingAppId?: string;
  };
}

export type StreamStatusHandler = (status: StreamStatus) => void;

export interface CameraManagerDeps {
  router: {
    on(key: string, handler: (streamType: string, data: any, message: any) => void): () => void;
  };
  messageHandlers: {
    register(type: string, handler: (msg: any) => void): () => void;
  };
  addSubscription: (stream: string) => void;
  removeSubscription: (stream: string) => void;
  sendMessage: (message: any) => void;
  logger: {
    debug(...args: any[]): void;
    info(...args: any[]): void;
    warn(...args: any[]): void;
    error(...args: any[]): void;
  };
  getPackageName: () => string;
  getSessionId: () => string;
}

interface PendingPhotoRequest {
  requestId: string;
  resolve: (data: PhotoData) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingStreamCheck {
  resolve: (response: ExistingStreamInfo) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const STREAM_CHECK_TIMEOUT_MS = 5_000;
const MANAGED_STREAM_TIMEOUT_MS = 30_000;

function generateRequestId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}_${crypto.randomUUID()}`;
  }

  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

export class CameraManager {
  private readonly deps: CameraManagerDeps;
  private readonly events = new EventEmitter();
  private readonly handlerCleanups: Array<() => void> = [];

  private pendingRequests = new Map<string, PendingPhotoRequest>();
  private pendingStreamChecks = new Map<string, PendingStreamCheck>();
  private pendingManagedStreamRequest:
    | {
        resolve: (value: ManagedStreamResult) => void;
        reject: (reason?: any) => void;
        timeoutId: ReturnType<typeof setTimeout>;
      }
    | undefined;

  private _hasPermission = true;
  private isStreaming = false;
  private currentStreamUrl?: string;
  private currentStreamState?: StreamStatus;
  private isManagedStreaming = false;
  private currentManagedStreamId?: string;
  private currentManagedStreamUrls?: ManagedStreamResult;
  private managedStreamStatus?: ManagedStreamStatus;

  constructor(deps: CameraManagerDeps) {
    this.deps = deps;

    this.handlerCleanups.push(
      this.deps.messageHandlers.register(CloudToAppMessageType.PHOTO_RESPONSE, (msg: any) =>
        this.handlePhotoResponse(msg),
      ),
      // Register for both old ("rtmp_stream_status") and new ("stream_status") message types.
      // The cloud currently sends "rtmp_stream_status" but the enum maps to "stream_status".
      this.deps.messageHandlers.register(CloudToAppMessageType.STREAM_STATUS, (msg: any) =>
        this.handleStreamStatus(msg),
      ),
      this.deps.messageHandlers.register("rtmp_stream_status" as any, (msg: any) => this.handleStreamStatus(msg)),
      this.deps.messageHandlers.register(CloudToAppMessageType.MANAGED_STREAM_STATUS, (msg: any) =>
        this.handleManagedStreamStatus(msg),
      ),
      this.deps.messageHandlers.register(CloudToAppMessageType.STREAM_STATUS_CHECK_RESPONSE, (msg: any) =>
        this.handleStreamCheckResponse(msg),
      ),
    );
  }

  takePhoto(opts?: PhotoOptions): Promise<PhotoData> {
    return new Promise<PhotoData>((resolve, reject) => {
      const requestId = generateRequestId("photo_req");
      const timeoutMs = opts?.timeout ?? DEFAULT_TIMEOUT_MS;

      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Photo request timed out after ${timeoutMs}ms (requestId: ${requestId})`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, { requestId, resolve, reject, timer });

      const exposureNs = opts?.exposureTimeNs;
      const includeExposure = typeof exposureNs === "number" && Number.isFinite(exposureNs) && exposureNs > 0;

      const message = {
        type: AppToCloudMessageType.PHOTO_REQUEST,
        packageName: this.deps.getPackageName(),
        sessionId: this.deps.getSessionId(),
        requestId,
        timestamp: new Date(),
        saveToGallery: opts?.saveToGallery ?? false,
        size: opts?.size ?? "medium",
        compress: opts?.compression ?? "none",
        sound: opts?.sound,
        ...(includeExposure ? { exposureTimeNs: exposureNs } : {}),
      };

      try {
        this.deps.sendMessage(message);
        this.deps.logger.info(
          {
            requestId,
            size: message.size,
            compress: message.compress,
            saveToGallery: message.saveToGallery,
            exposureTimeNs: includeExposure ? exposureNs : undefined,
          },
          "📸 Photo request sent",
        );
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // ── Unified streaming API ────────────────────────────────────────────────

  /**
   * Start a video stream from the glasses.
   *
   * Three modes:
   * - `startStream()` — managed relay (default). Cloud handles quality, reconnection, viewer URLs.
   * - `startStream({ destinations: [...] })` — managed relay + fan out to YouTube/Twitch/etc.
   * - `startStream({ direct: "srt://..." })` — glasses connect straight to your URL, no relay.
   *
   * @example
   * ```ts
   * // Default — managed relay
   * const stream = await session.camera.startStream();
   * console.log(stream.hlsUrl, stream.webrtcUrl);
   *
   * // Managed relay + restream to YouTube
   * const stream = await session.camera.startStream({
   *   destinations: ["rtmp://youtube.com/live/your-key"],
   * });
   *
   * // Direct — glasses → your server, no relay
   * await session.camera.startStream({ direct: "srt://192.168.1.100:4201" });
   * ```
   */
  async startStream(options?: StreamOptions): Promise<StreamResult | void> {
    const opts = options ?? {};
    if (opts.direct) {
      return this._startDirectStream(opts);
    }
    return this._startManagedStream(opts);
  }

  /**
   * Stop any active stream (managed or direct).
   */
  async stopStream(): Promise<void> {
    if (this.isStreaming) {
      // Stop direct stream
      this.deps.sendMessage({
        type: AppToCloudMessageType.STREAM_STOP,
        packageName: this.deps.getPackageName(),
        sessionId: this.deps.getSessionId(),
        streamId: this.currentStreamState?.streamId,
        timestamp: new Date(),
      });
    }

    if (this.isManagedStreaming) {
      // Stop managed stream
      this.deps.sendMessage({
        type: AppToCloudMessageType.MANAGED_STREAM_STOP,
        packageName: this.deps.getPackageName(),
        sessionId: this.deps.getSessionId(),
        timestamp: new Date(),
      });

      // Issue 091: Clear local state immediately. Don't wait for the cloud
      // to respond with managed_stream_status: "stopped" — the cloud may
      // not respond if the stream was already cleaned up (keep-alive timeout,
      // glasses battery death, etc.). Without this, isManagedStreaming stays
      // true and the next startStream() throws "Already streaming."
      this.isManagedStreaming = false;
      this.currentManagedStreamId = undefined;
      this.currentManagedStreamUrls = undefined;
    }
  }

  /**
   * Subscribe to stream status updates (works for both managed and direct).
   */
  onStreamStatus(handler: StreamStatusHandler): () => void {
    // Subscribe to BOTH direct and managed stream status events.
    // Issue 091: the "unified" onStreamStatus was only wired to direct
    // stream events. Managed stream events (stopped, error, active from
    // Cloudflare keep-alive timeout, battery death, etc.) went to a
    // separate "managed_stream_status" event that this handler never heard.
    this.deps.addSubscription(StreamType.STREAM_STATUS);
    this.deps.addSubscription(StreamType.MANAGED_STREAM_STATUS);
    this.events.on("stream_status", handler);
    this.events.on("managed_stream_status", handler);

    return () => {
      this.events.off("stream_status", handler);
      this.events.off("managed_stream_status", handler);
      this.deps.removeSubscription(StreamType.STREAM_STATUS);
      this.deps.removeSubscription(StreamType.MANAGED_STREAM_STATUS);
    };
  }

  isCurrentlyStreaming(): boolean {
    return this.isStreaming || this.isManagedStreaming;
  }

  getCurrentStreamUrl(): string | undefined {
    return this.currentStreamUrl;
  }

  getStreamStatus(): StreamStatus | undefined {
    return this.currentStreamState;
  }

  getStreamUrls(): StreamResult | undefined {
    return this.currentManagedStreamUrls;
  }

  // ── Direct streaming (glasses → URL, no relay) ───────────────────────────

  private async _startDirectStream(opts: StreamOptions): Promise<void> {
    validateVideoConfig(opts.video);
    const url = opts.direct!;

    if (
      !url.startsWith("rtmp://") &&
      !url.startsWith("rtmps://") &&
      !url.startsWith("srt://") &&
      !url.startsWith("https://") &&
      !url.startsWith("http://")
    ) {
      throw new Error("Invalid stream URL: must start with rtmp://, rtmps://, srt://, https://, or http://");
    }

    // Only check streams WE started, not orphaned streams from a previous session.
    // isStreaming is only set when _startDirectStream sends a STREAM_REQUEST.
    // It's NOT set by incoming status events.
    if (this.isStreaming || this.isManagedStreaming) {
      throw new Error("Already streaming. Stop the current stream before starting a new one.");
    }

    this.currentStreamUrl = url;
    this.deps.sendMessage({
      type: AppToCloudMessageType.STREAM_REQUEST,
      packageName: this.deps.getPackageName(),
      sessionId: this.deps.getSessionId(),
      streamUrl: url,
      video: opts.video,
      audio: opts.audio,
      stream: opts.stream,
      sound: opts.sound,
      timestamp: new Date(),
    });
    this.isStreaming = true;
  }

  // ── Managed streaming (glasses → cloud relay → viewers/destinations) ─────

  private async _startManagedStream(opts: StreamOptions): Promise<StreamResult> {
    validateVideoConfig(opts.video);
    // Only check streams WE started, not orphaned streams from a previous session.
    if (this.isStreaming || this.isManagedStreaming) {
      throw new Error("Already streaming. Stop the current stream before starting a new one.");
    }

    // Convert destinations to restreamDestinations format
    const restreamDestinations: RestreamDestination[] | undefined = opts.destinations?.map((url) => ({ url }));

    this.deps.sendMessage({
      type: AppToCloudMessageType.MANAGED_STREAM_REQUEST,
      packageName: this.deps.getPackageName(),
      sessionId: this.deps.getSessionId(),
      quality: opts.quality,
      enableWebRTC: opts.enableWebRTC ?? true,
      video: opts.video,
      audio: opts.audio,
      stream: opts.stream,
      restreamDestinations,
      sound: opts.sound,
      timestamp: new Date(),
    });
    this.isManagedStreaming = true;

    return new Promise<StreamResult>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (this.pendingManagedStreamRequest?.timeoutId === timeoutId) {
          this.pendingManagedStreamRequest = undefined;
          this.isManagedStreaming = false;
          reject(new Error("Managed stream request timeout"));
        }
      }, MANAGED_STREAM_TIMEOUT_MS);

      this.pendingManagedStreamRequest = { resolve, reject, timeoutId };
    });
  }

  // ── Deprecated methods (backward compat) ─────────────────────────────────

  /** @deprecated Use startStream({ direct: url }) instead */
  async startDirectStream(options: RtmpStreamOptions): Promise<void> {
    return this._startDirectStream({
      direct: options.rtmpUrl,
      video: options.video,
      audio: options.audio,
      stream: options.stream,
      sound: options.sound,
    });
  }

  /** @deprecated Use startStream() or startStream({ destinations: [...] }) instead */
  async startManagedStream(options: ManagedStreamOptions = {}): Promise<StreamResult> {
    return this._startManagedStream({
      quality: options.quality,
      enableWebRTC: options.enableWebRTC,
      video: options.video,
      audio: options.audio,
      stream: options.stream,
      destinations: options.restreamDestinations?.map((d) => d.url),
      sound: options.sound,
    });
  }

  /** @deprecated Use stopStream() instead */
  async stopManagedStream(): Promise<void> {
    return this.stopStream();
  }

  /** @deprecated Use onStreamStatus() instead */
  onManagedStreamStatus(handler: (status: ManagedStreamStatus) => void): () => void {
    this.deps.addSubscription(StreamType.MANAGED_STREAM_STATUS);
    this.events.on("managed_stream_status", handler);

    return () => {
      this.events.off("managed_stream_status", handler);
      this.deps.removeSubscription(StreamType.MANAGED_STREAM_STATUS);
    };
  }

  /** @deprecated Use isCurrentlyStreaming() instead */
  isManagedStreamActive(): boolean {
    return this.isManagedStreaming;
  }

  /** @deprecated Use getStreamUrls() instead */
  getManagedStreamUrls(): StreamResult | undefined {
    return this.currentManagedStreamUrls;
  }

  getManagedStreamStatus(): ManagedStreamStatus | undefined {
    return this.managedStreamStatus;
  }

  async checkExistingStream(): Promise<ExistingStreamInfo> {
    return new Promise<ExistingStreamInfo>((resolve) => {
      const requestId = generateRequestId("stream_check");
      const timeoutId = setTimeout(() => {
        this.pendingStreamChecks.delete(requestId);
        resolve({ hasActiveStream: false });
      }, STREAM_CHECK_TIMEOUT_MS);

      this.pendingStreamChecks.set(requestId, { resolve, timeoutId });

      this.deps.sendMessage({
        type: AppToCloudMessageType.STREAM_STATUS_CHECK,
        packageName: this.deps.getPackageName(),
        sessionId: this.deps.getSessionId(),
        requestId,
        timestamp: new Date(),
      });
    });
  }

  get hasPermission(): boolean {
    return this._hasPermission;
  }

  handlePhotoResponse(message: any): void {
    const requestId: string | undefined = message?.requestId;
    if (!requestId) {
      this.deps.logger.warn("[CameraManager] Received PHOTO_RESPONSE without requestId:", message);
      return;
    }

    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      this.deps.logger.debug(`[CameraManager] No pending request for requestId="${requestId}" — ignoring.`);
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(requestId);

    if (message.error?.code === "permission_denied") {
      this._hasPermission = false;
    }

    if (message.success === false) {
      const errorMsg = message.error?.message ?? message.error?.code ?? "Photo capture failed";
      pending.reject(new Error(errorMsg));
      return;
    }

    pending.resolve({
      url: message.photoUrl ?? "",
      width: message.width ?? 0,
      height: message.height ?? 0,
      timestamp: message.timestamp ? new Date(message.timestamp).getTime() : Date.now(),
      savedToGallery: message.savedToGallery ?? false,
    });
  }

  private handleStreamStatus(message: StreamStatus): void {
    this.currentStreamState = {
      ...message,
      timestamp: message.timestamp ? new Date(message.timestamp) : new Date(),
    };

    // Only update isStreaming for streams WE initiated (isStreaming is set to true
    // in _startDirectStream). Don't let orphaned stream status events from a
    // previous session set isStreaming — that blocks new streams from starting.
    if (this.isStreaming) {
      if (message.status === "stopped" || message.status === "error" || message.status === "timeout") {
        this.isStreaming = false;
        this.currentStreamUrl = undefined;
      }
    }

    this.events.emit("stream_status", this.currentStreamState);
  }

  private handleManagedStreamStatus(status: ManagedStreamStatus): void {
    this.managedStreamStatus = status;

    if (status.status === "initializing" && status.streamId) {
      this.isManagedStreaming = true;
      this.currentManagedStreamId = status.streamId;
    }

    if (status.status === "active") {
      this.isManagedStreaming = true;
      this.currentManagedStreamId = status.streamId;

      if (status.hlsUrl && status.dashUrl) {
        const result: ManagedStreamResult = {
          hlsUrl: status.hlsUrl,
          dashUrl: status.dashUrl,
          webrtcUrl: status.webrtcUrl,
          previewUrl: status.previewUrl,
          thumbnailUrl: status.thumbnailUrl,
          streamId: status.streamId ?? "",
        };

        this.currentManagedStreamUrls = result;

        if (this.pendingManagedStreamRequest) {
          clearTimeout(this.pendingManagedStreamRequest.timeoutId);
          this.pendingManagedStreamRequest.resolve(result);
          this.pendingManagedStreamRequest = undefined;
        }
      }
    }

    if (status.status === "error" || status.status === "stopped") {
      if (this.pendingManagedStreamRequest) {
        clearTimeout(this.pendingManagedStreamRequest.timeoutId);
        this.pendingManagedStreamRequest.reject(new Error(status.message || "Managed stream failed"));
        this.pendingManagedStreamRequest = undefined;
      }

      this.isManagedStreaming = false;
      this.currentManagedStreamId = undefined;
      this.currentManagedStreamUrls = undefined;
    }

    this.events.emit("managed_stream_status", status);
  }

  private handleStreamCheckResponse(response: StreamStatusCheckResponse): void {
    // Match by requestId from the response — don't blindly pop the first entry.
    // This prevents concurrent checkExistingStream() calls from resolving the wrong promise.
    const requestId = (response as any).requestId;
    const pending = requestId ? this.pendingStreamChecks.get(requestId) : undefined;

    // Fallback: if the cloud doesn't include requestId, pop the first entry (v2 behavior)
    if (!pending) {
      const firstEntry = this.pendingStreamChecks.entries().next();
      if (firstEntry.done || !firstEntry.value) {
        return;
      }
      const [fallbackId, fallbackPending] = firstEntry.value;
      clearTimeout(fallbackPending.timeoutId);
      this.pendingStreamChecks.delete(fallbackId);
      fallbackPending.resolve({
        hasActiveStream: response.hasActiveStream,
        streamInfo: response.streamInfo
          ? {
              ...response.streamInfo,
              createdAt: new Date(response.streamInfo.createdAt),
            }
          : undefined,
      });
      return;
    }

    clearTimeout(pending.timeoutId);
    this.pendingStreamChecks.delete(requestId!);
    pending.resolve({
      hasActiveStream: response.hasActiveStream,
      streamInfo: response.streamInfo
        ? {
            ...response.streamInfo,
            createdAt: new Date(response.streamInfo.createdAt),
          }
        : undefined,
    });
  }

  destroy(): void {
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`CameraManager destroyed — session disconnected (${requestId})`));
    }
    this.pendingRequests.clear();

    for (const [requestId, pending] of this.pendingStreamChecks) {
      clearTimeout(pending.timeoutId);
      pending.resolve({ hasActiveStream: false });
      this.pendingStreamChecks.delete(requestId);
    }

    if (this.pendingManagedStreamRequest) {
      clearTimeout(this.pendingManagedStreamRequest.timeoutId);
      this.pendingManagedStreamRequest.reject(new Error("CameraManager destroyed — session disconnected"));
      this.pendingManagedStreamRequest = undefined;
    }

    for (const cleanup of this.handlerCleanups) {
      cleanup();
    }
    this.handlerCleanups.length = 0;

    this.events.removeAllListeners();
    this.currentStreamState = undefined;
    this.currentStreamUrl = undefined;
    this.isStreaming = false;
    this.managedStreamStatus = undefined;
    this.currentManagedStreamId = undefined;
    this.currentManagedStreamUrls = undefined;
    this.isManagedStreaming = false;
  }
}
