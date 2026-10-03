/**
 * @fileoverview StreamModule -- video streaming from glasses.
 *
 * Wires to cloud streaming extensions via the __phone__ subscriber path.
 *
 * One entry point: `startStream`. By default it provisions a Mentra-hosted
 * stream and returns playback URLs (managed). Pass `direct` to publish straight
 * to your own ingest URL with no relay.
 */

import {MiniappRequestType, type PreviewErrorCode, type PreviewSource} from "../protocol"
import {MiniappSession} from "../session"

export interface StreamVideoConfig {
  width?: number
  height?: number
  bitrate?: number
  /** WHIP minimum target in bps; omitted leaves it unset. Clamped to the maximum. */
  minBitrateBps?: number
  /** WHIP startup bitrate in bps, clamped to the requested bounds. */
  initialBitrateBps?: number
  fps?: number
}

export interface StreamAudioConfig {
  bitrate?: number
  sampleRate?: number
  echoCancellation?: boolean
  noiseSuppression?: boolean
}

export interface StreamResolvedConfig {
  transport?: "rtmp" | "srt" | "whip"
  video?: {
    width: number
    height: number
    captureWidth?: number
    captureHeight?: number
    bitrate: number
    fps: number
  }
  audio?: {
    bitrate?: number
    sampleRate?: number
    echoCancellation?: boolean
    noiseSuppression?: boolean
  }
}

/**
 * Restream destination. The full stream key is part of the URL (e.g.
 * `rtmp://yt.com/live/STREAM-KEY`). `name` is a human label that surfaces
 * in dashboards but doesn't affect routing.
 */
export interface RestreamDestination {
  url: string
  name?: string
}

export interface StartStreamOptions {
  /**
   * Publish straight to your own ingest URL (rtmp/rtmps/srt/whip). The glasses
   * connect to it directly with no Mentra relay, so no playback URLs come back.
   * Omit this to use the managed relay (the default, best for most apps).
   */
  direct?: string
  /**
   * Restream destinations the managed relay fans out to (YouTube, Twitch, …).
   * Bare URL strings or `{url, name?}` objects; mix freely. Managed streams
   * only — ignored when `direct` is set.
   */
  destinations?: Array<string | RestreamDestination>
  video?: StreamVideoConfig
  audio?: StreamAudioConfig
  /** Play glasses-side stream start/stop sounds. Defaults to true. */
  sound?: boolean
  /**
   * Managed ingest protocol, a latency/durability trade. Ignored when `direct`
   * is set.
   *   - "srt" (default): ~10-20s latency via LL-HLS, shareable HLS/DASH URLs,
   *     and automatic recording.
   *   - "whip": sub-second WebRTC playback (use `webrtcUrl`/WHEP), but no
   *     HLS/DASH and no recording.
   *   - "rtmp": RTMPS ingest over TCP 443 → HLS playback. Use when WHIP/SRT
   *     UDP is blocked (then play `hlsUrl`, not WHEP).
   */
  ingest?: "srt" | "whip" | "rtmp"
  /** Optional Bearer token for direct WHIP Authorization (custom authenticated endpoints). */
  authToken?: string
  /**
   * When false, glasses skip mic capture for this WHIP session. Fixed for the
   * lifetime of the stream. Defaults to true. Older Mentra Apps ignore this.
   */
  captureAudio?: boolean
}

export interface StreamResult {
  streamId: string
  status: string
  resolvedConfig?: StreamResolvedConfig
  /** Managed streams only: the live-input UID for building hosted-player URLs. */
  liveInputId?: string
  /** Managed streams only: which playback this stream serves. In "webrtc" mode
   *  `hlsUrl` never serves content. */
  mode?: "hls" | "webrtc"
  /** Managed streams only: HLS playback URL. */
  hlsUrl?: string
  /** Managed streams only: DASH playback URL. */
  dashUrl?: string
  /** Managed streams only: WHEP playback URL (present in "webrtc" mode). */
  webrtcUrl?: string
}

/** Live encoder and device telemetry emitted periodically by supported glasses firmware. */
export interface StreamLiveStats {
  /** Current encoded video bitrate in bits per second. */
  bitrate?: number
  /** Current encode frame rate. */
  fps?: number
  droppedFrames?: number
  /** Seconds since the stream started. */
  duration?: number
  /** Device temperature in °C, if the hardware reports it. */
  temperatureC?: number
}

export interface StreamStatus {
  streamId: string
  status: string
  errorDetails?: string
  /** Negotiated encode config — forwarded once, on the first status ack. */
  resolvedConfig?: StreamResolvedConfig
  stats?: StreamLiveStats
}

export interface StreamPreviewOptions {
  /** Defaults to `"call"`. `"glasses"` is reserved and rejects with `unsupported`. */
  source?: PreviewSource
}

export type PreviewHandleState = "held" | "ended"

export interface PreviewHandleStatus {
  state: PreviewHandleState
  /** Set when `state` is `"ended"`: `stopped`, `source_ended`, `runtime_stopped`, ... */
  reason?: string
}

/** A preview request or lease failed. `code` is one of {@link PreviewErrorCode} when the host sent one. */
export class PreviewError extends Error {
  readonly code: PreviewErrorCode | string

  constructor(code: PreviewErrorCode | string, message?: string) {
    super(message ?? code)
    this.name = "PreviewError"
    this.code = code
  }
}

/**
 * The background-owned lease on a preview source.
 *
 * The lease is what lets a `<StreamPreview>` in the UI show frames. It survives the UI closing and
 * the WebView being destroyed, and ends on `stop()`, when the source ends (the meeting is over), or
 * when the background runtime stops. Hiding the component does not release it.
 */
export interface PreviewHandle {
  readonly source: PreviewSource
  readonly handleId: string
  /** Correlation id stamped on every `PREVIEW_TRACE` log line for this lease. */
  readonly previewTraceId: string
  readonly state: PreviewHandleState
  /** Release the lease. Idempotent. */
  stop(): Promise<void>
  /** Lease transitions. Fires `{state: "ended", reason}` exactly once. */
  onStatus(cb: (status: PreviewHandleStatus) => void): () => void
}

interface PreviewStartResult {
  handleId: string
  previewTraceId: string
  source: PreviewSource
}

function toPreviewError(error: unknown): PreviewError {
  if (error instanceof PreviewError) return error
  const value = (error ?? {}) as {code?: unknown; message?: unknown}
  const code = typeof value.code === "string" ? value.code : "unsupported"
  const message = typeof value.message === "string" ? value.message : undefined
  return new PreviewError(code, message)
}

class PreviewHandleImpl implements PreviewHandle {
  state: PreviewHandleState = "held"
  private readonly listeners = new Set<(status: PreviewHandleStatus) => void>()

  constructor(
    readonly source: PreviewSource,
    readonly handleId: string,
    readonly previewTraceId: string,
    private readonly release: (handle: PreviewHandleImpl) => Promise<void>,
  ) {}

  async stop(): Promise<void> {
    if (this.state === "ended") return
    this.end("stopped")
    await this.release(this)
  }

  onStatus(cb: (status: PreviewHandleStatus) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** @internal */
  end(reason: string): void {
    if (this.state === "ended") return
    this.state = "ended"
    this.emit({state: "ended", reason})
  }

  private emit(status: PreviewHandleStatus): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(status)
      } catch {
        // A throwing listener must not stop the others from hearing that the lease ended.
      }
    }
  }
}

export class StreamModule {
  private readonly previewHandles = new Map<string, PreviewHandleImpl>()

  constructor(private readonly session: MiniappSession) {}

  /**
   * Take the preview lease on a source so a `<StreamPreview>` in the UI can show its frames.
   *
   * For `"call"` the caller must declare `CAMERA` and own the active meeting (`session.meeting`).
   * Only one lease exists at a time; a second request fails with `preview_busy`. Rejects with a
   * {@link PreviewError}. Never await this on a call's connect path: preview is additive.
   */
  async preview(options: StreamPreviewOptions = {}): Promise<PreviewHandle> {
    const source = options.source ?? "call"
    if (source !== "call") {
      throw new PreviewError("unsupported", `Preview source "${String(source)}" is not supported yet`)
    }
    let result: PreviewStartResult
    try {
      result = await this.session.sendRequest<PreviewStartResult>({
        type: MiniappRequestType.STREAM_PREVIEW_START,
        source,
      })
    } catch (error) {
      throw toPreviewError(error)
    }
    const handle = new PreviewHandleImpl(result.source ?? source, result.handleId, result.previewTraceId, (h) =>
      this.releasePreview(h),
    )
    this.previewHandles.set(handle.handleId, handle)
    handle.onStatus((status) => {
      if (status.state === "ended") this.previewHandles.delete(handle.handleId)
    })
    return handle
  }

  private async releasePreview(handle: PreviewHandleImpl): Promise<void> {
    this.previewHandles.delete(handle.handleId)
    try {
      await this.session.sendRequest<void>({
        type: MiniappRequestType.STREAM_PREVIEW_STOP,
        handleId: handle.handleId,
      })
    } catch (error) {
      throw toPreviewError(error)
    }
  }

  /** @internal — applied by MiniappSession on inbound STREAM_PREVIEW_STATUS. */
  _applyPreviewStatus(payload: Record<string, unknown>): void {
    if (typeof payload.handleId !== "string") return
    const handle = this.previewHandles.get(payload.handleId)
    if (!handle) return
    if (payload.state === "ended") {
      handle.end(typeof payload.reason === "string" ? payload.reason : "ended")
    }
  }

  /**
   * Start a live video stream from the glasses camera.
   *
   * Managed (default) -- Mentra hosts the stream and the result carries
   * `hlsUrl`/`dashUrl`/`webrtcUrl` for playback. Optionally fan out to your own
   * `destinations`.
   *
   * Direct -- pass `direct` with your own ingest URL; the glasses publish to it
   * and no playback URLs are returned.
   */
  async startStream(options: StartStreamOptions = {}): Promise<StreamResult> {
    if (options.direct !== undefined) {
      return this.session.sendRequest<StreamResult>({
        type: MiniappRequestType.STREAM_START,
        streamUrl: options.direct,
        video: options.video,
        audio: options.audio,
        sound: options.sound ?? true,
        ...(options.authToken ? {authToken: options.authToken} : {}),
        ...(typeof options.captureAudio === "boolean" ? {captureAudio: options.captureAudio} : {}),
      })
    }
    return this.session.sendRequest<StreamResult>({
      type: MiniappRequestType.MANAGED_STREAM_START,
      restreamDestinations: options.destinations,
      video: options.video,
      audio: options.audio,
      sound: options.sound ?? true,
      ingest: options.ingest,
      ...(typeof options.captureAudio === "boolean" ? {captureAudio: options.captureAudio} : {}),
    })
  }

  /** Stop the active stream, or a specific one by `streamId`. */
  async stop(streamId?: string): Promise<void> {
    await this.session.sendRequest<void>({
      type: MiniappRequestType.STREAM_STOP,
      streamId,
    })
  }
}
