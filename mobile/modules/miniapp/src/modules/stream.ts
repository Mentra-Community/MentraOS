/**
 * @fileoverview StreamModule -- video streaming from glasses.
 *
 * Wires to cloud streaming extensions via the __phone__ subscriber path.
 *
 * One entry point: `startStream`. By default it provisions a Mentra-hosted
 * stream and returns playback URLs (managed). Pass `direct` to publish straight
 * to your own ingest URL with no relay.
 */

import {MiniappRequestType} from "../protocol"
import {MiniappSession} from "../session"

export interface StreamVideoConfig {
  width?: number
  height?: number
  bitrate?: number
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

export class StreamModule {
  constructor(private readonly session: MiniappSession) {}

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
