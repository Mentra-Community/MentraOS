/**
 * @fileoverview StreamModule -- video streaming from glasses.
 *
 * Deferred in v1 Phases 1-4 (noop). Phase 5 wires these to cloud streaming
 * extensions via the __phone__ subscriber path.
 */

import {MiniappRequestType} from "../protocol"
import {MiniappSession} from "../session"

export interface StartUnmanagedOptions {
  streamUrl: string
  video?: boolean
  audio?: boolean
}

export interface StartManagedOptions {
  restreamDestinations?: string[]
}

export interface ManagedStreamResult {
  streamId: string
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
