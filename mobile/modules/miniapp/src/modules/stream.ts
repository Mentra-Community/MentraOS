/**
 * @fileoverview StreamModule -- video streaming from glasses.
 *
 * Wires to cloud streaming extensions via the __phone__ subscriber path.
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

export interface StartUnmanagedOptions {
  streamUrl: string
  video?: StreamVideoConfig
  audio?: StreamAudioConfig
  /** Play glasses-side stream start/stop sounds. Defaults to true. */
  sound?: boolean
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

export interface StartManagedOptions {
  /** Bare URL strings or {url, name?} objects; mix freely. */
  restreamDestinations?: Array<string | RestreamDestination>
  video?: StreamVideoConfig
  audio?: StreamAudioConfig
  /** Play glasses-side stream start/stop sounds. Defaults to true. */
  sound?: boolean
}

export interface StreamPublisherStartResult {
  streamId: string
  status: string
  resolvedConfig?: StreamResolvedConfig
}

export interface ManagedStreamResult extends StreamPublisherStartResult {
  /** Cloudflare live input UID — useful for building hosted-player URLs. */
  liveInputId: string
  hlsUrl: string
  dashUrl: string
  webrtcUrl?: string
}

export interface StreamStatus {
  streamId: string
  status: string
  errorDetails?: string
}

export class StreamModule {
  constructor(private readonly session: MiniappSession) {}

  async startUnmanaged(options: StartUnmanagedOptions): Promise<StreamPublisherStartResult> {
    return this.session.sendRequest<StreamPublisherStartResult>({
      type: MiniappRequestType.STREAM_START,
      streamUrl: options.streamUrl,
      video: options.video,
      audio: options.audio,
      sound: options.sound ?? true,
    })
  }

  async startManaged(options: StartManagedOptions = {}): Promise<ManagedStreamResult> {
    return this.session.sendRequest<ManagedStreamResult>({
      type: MiniappRequestType.MANAGED_STREAM_START,
      restreamDestinations: options.restreamDestinations,
      video: options.video,
      audio: options.audio,
      sound: options.sound ?? true,
    })
  }

  async stop(streamId?: string): Promise<void> {
    await this.session.sendRequest<void>({
      type: MiniappRequestType.STREAM_STOP,
      streamId,
    })
  }
}
