/**
 * @fileoverview StreamModule -- video streaming from glasses.
 *
 * Wires to cloud streaming extensions via the __phone__ subscriber path.
 */

import {MiniappRequestType} from "../protocol"
import {MiniappSession} from "../session"

export interface StartUnmanagedOptions {
  streamUrl: string
  video?: boolean
  audio?: boolean
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
}

export interface ManagedStreamResult {
  streamId: string
  /** Cloudflare live input UID — useful for building hosted-player URLs. */
  liveInputId?: string
  hlsUrl?: string
  dashUrl?: string
  webrtcUrl?: string
}

export interface StreamStatus {
  streamId: string
  status: string
  errorDetails?: string
}

export class StreamModule {
  constructor(private readonly session: MiniappSession) {}

  async startUnmanaged(options: StartUnmanagedOptions): Promise<string> {
    const result = await this.session.sendRequest<{streamId: string}>({
      type: MiniappRequestType.STREAM_START,
      streamUrl: options.streamUrl,
      video: options.video ?? true,
      audio: options.audio ?? true,
    })
    return result?.streamId ?? ""
  }

  async startManaged(options: StartManagedOptions = {}): Promise<ManagedStreamResult> {
    const result = await this.session.sendRequest<ManagedStreamResult>({
      type: MiniappRequestType.MANAGED_STREAM_START,
      restreamDestinations: options.restreamDestinations,
    })
    return result ?? {streamId: ""}
  }

  async stop(streamId?: string): Promise<void> {
    await this.session.sendRequest<void>({
      type: MiniappRequestType.STREAM_STOP,
      streamId,
    })
  }
}
