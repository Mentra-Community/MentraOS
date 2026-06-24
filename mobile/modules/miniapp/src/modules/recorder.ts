/**
 * @fileoverview RecorderModule — host-side audio capture straight to a blob.
 *
 * `session.recorder.start()` tells the phone to begin writing the glasses mic
 * audio to a `session.blob` entry. Crucially, the AUDIO BYTES NEVER CROSS THE
 * BRIDGE: the host already has the decoded PCM (the same stream it forwards as
 * `mic.onAudioChunk`), so it taps it natively and writes the WAV file directly.
 * Only control (start/stop) and lightweight progress events ride the bridge.
 * This sidesteps the JSContext memory + watchdog limits that make long
 * recordings impossible to stream through the bridge.
 *
 * The captured PCM is what the audio system produces AFTER LC3 decode (the
 * canonical input to transcription) — i.e. it's a debugging view of "what audio
 * did we actually get", not the raw LC3/BLE frames.
 *
 * Requires `MICROPHONE` in miniapp.json. BACKGROUND-ONLY.
 */

import {MiniappRequestType, MiniappStreamType} from "../protocol"
import {MiniappSession} from "../session"
import type {BlobMeta} from "./blob"
import type {BlobRecordProgressData, UnsubscribeFn} from "./events"

export interface RecorderStartOptions {
  /** Container format. "wav" (default) wraps the PCM with a RIFF header; "pcm" is headerless. */
  format?: "wav" | "pcm"
  /** Optional human label for the resulting blob. */
  name?: string
  /** Extra metadata to persist on the blob. */
  meta?: Record<string, string | number | boolean>
}

export interface RecordingHandle {
  /** Handle for stop()/cancel(). */
  recordingId: string
  /** The blob id the recording is being written into. */
  blobId: string
}

export class RecorderModule {
  constructor(private readonly session: MiniappSession) {}

  /** True iff `MICROPHONE` is declared in the miniapp's manifest. */
  get hasPermission(): boolean {
    return this.session._hasManifestPermission("MICROPHONE")
  }

  /** Begin capturing glasses mic audio into a new blob. */
  start(opts: RecorderStartOptions = {}): Promise<RecordingHandle> {
    return this.session.sendRequest<RecordingHandle>({
      type: MiniappRequestType.BLOB_RECORD_START,
      format: opts.format ?? "wav",
      name: opts.name,
      meta: opts.meta,
    })
  }

  /** Finalize a recording (patches the WAV header) and return the completed blob. */
  stop(recordingId: string): Promise<BlobMeta> {
    return this.session.sendRequest<BlobMeta>({
      type: MiniappRequestType.BLOB_RECORD_STOP,
      recordingId,
    })
  }

  /** Abort a recording and discard the partial blob. */
  async cancel(recordingId: string): Promise<void> {
    await this.session.sendRequest<void>({
      type: MiniappRequestType.BLOB_RECORD_CANCEL,
      recordingId,
    })
  }

  /**
   * Subscribe to capture progress (~every 250ms while recording): elapsed ms,
   * bytes written, and a coarse 0–1 input level for a live meter.
   */
  onProgress(handler: (data: BlobRecordProgressData) => void): UnsubscribeFn {
    return this.session._subscribe(MiniappStreamType.BLOB_RECORD_PROGRESS, handler as (data: unknown) => void)
  }
}
