/**
 * @fileoverview MicModule — low-level audio input subscriptions.
 *
 * Mirrors cloud SDK v3's MicManager naming. Houses raw audio chunks + VAD;
 * transcription and translation hoisted to top-level (`session.transcription`
 * / `session.translation`) in the v3-alignment round so authors don't have to
 * mentally model "transcription is a microphone thing" — it's just a
 * top-level domain. This module was called `MicrophoneModule` /
 * `session.microphone` before that round.
 *
 * Audio *output* (TTS, file playback) lives on `session.speaker`.
 *
 * MICROPHONE permission must be declared in miniapp.json for any of these
 * subscriptions to succeed; the phone runtime rejects with
 * PERMISSION_NOT_DECLARED otherwise.
 */

import {MiniappRequestType, MiniappStreamType} from "../protocol"
import {MiniappSession} from "../session"
import type {AudioChunkData, UnsubscribeFn, VadData} from "./events"

export class MicModule {
  /** All active unsubscribe functions for stop() to tear down at once. */
  private readonly unsubs = new Set<UnsubscribeFn>()

  constructor(private readonly session: MiniappSession) {}

  /**
   * Subscribe to voice activity detection (VAD) events. `data.status` is
   * `true` while the user is speaking, `false` when silent.
   */
  onVoiceActivity(handler: (data: VadData) => void): UnsubscribeFn {
    return this.track(this.session._subscribe(MiniappStreamType.VAD, handler as (data: unknown) => void))
  }

  /**
   * Subscribe to raw audio chunks. Format depends on the phone's mic mode
   * (PCM or LC3, base64-encoded).
   */
  onAudioChunk(handler: (data: AudioChunkData) => void): UnsubscribeFn {
    return this.track(this.session._subscribe(MiniappStreamType.AUDIO_CHUNK, handler as (data: unknown) => void))
  }

  /**
   * Temporarily override glasses-side voice activity detection (GX8002) for
   * this miniapp's lifetime. When disabled, mic gating falls back to the
   * loudness gate only (if it is enabled). The Mentra App's configured value
   * is restored when this miniapp disconnects.
   *
   * Requires `MICROPHONE` in the miniapp manifest.
   */
  setVoiceActivityDetectionEnabled(enabled: boolean): Promise<void> {
    return this.session.sendRequest<void>({
      type: MiniappRequestType.MIC_SET_VAD_ENABLED,
      enabled,
    })
  }

  /**
   * Temporarily override the center-mic loudness gate ("Barrier") for this
   * miniapp's lifetime. It blocks quiet/self-talk audio independent of VAD.
   * The Mentra App's configured value is restored when this miniapp disconnects.
   *
   * Requires `MICROPHONE` in the miniapp manifest.
   */
  setLoudnessGateEnabled(enabled: boolean): Promise<void> {
    return this.session.sendRequest<void>({
      type: MiniappRequestType.MIC_SET_LOUDNESS_GATE_ENABLED,
      enabled,
    })
  }

  /**
   * Tear down every subscription this module owns. Useful when a component
   * is unmounting and wants to free everything at once without tracking
   * individual unsubscribe functions.
   */
  stop(): void {
    for (const u of this.unsubs) {
      try {
        u()
      } catch {
        /* ignore */
      }
    }
    this.unsubs.clear()
  }

  /** True iff `MICROPHONE` is declared in the miniapp's manifest. */
  get hasPermission(): boolean {
    return this.session._hasManifestPermission("MICROPHONE")
  }

  // ------------------------------------------------------------------------

  private track(unsub: UnsubscribeFn): UnsubscribeFn {
    this.unsubs.add(unsub)
    return () => {
      this.unsubs.delete(unsub)
      unsub()
    }
  }
}
