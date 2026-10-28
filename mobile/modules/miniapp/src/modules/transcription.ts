/**
 * @fileoverview TranscriptionModule — top-level transcription API.
 *
 * Mirrors cloud SDK v3's TranscriptionManager:
 *
 *   session.transcription.on(handler)                                // auto-detect
 *   session.transcription.forLanguage("en-US", handler)              // single language
 *   session.transcription.forLanguage(["en-US", "es-ES"], handler)   // multi-language
 *   session.transcription.configure({languageHints, vocabulary, diarization})
 *   session.transcription.onModelStatus(handler)                     // on-device model state
 *   session.transcription.finishUtterance()                          // end the on-device line now
 *   session.transcription.stop()                                     // tear down all
 *
 * Hoisted to top-level (vs. nested under `session.mic`) because transcription
 * is a domain in its own right, not a microphone-input event. The `mic`
 * module still exposes lower-level audio chunks + VAD; this module is for
 * "give me text from speech."
 *
 * MICROPHONE permission must be declared in miniapp.json. The phone runtime
 * rejects with PERMISSION_NOT_DECLARED otherwise.
 */

import {MiniappRequestType, MiniappStreamType} from "../protocol"
import {MiniappSession} from "../session"
import type {TranscriptionData, UnsubscribeFn} from "./events"
import {requireLanguageHint, requireTranscriptionLanguage} from "./languages"
import type {LanguageHint, TranscriptionLanguage} from "./languages"

/** Configuration for cloud-side transcription behavior. */
export interface TranscriptionConfig {
  /**
   * Language hints to improve auto-detection accuracy. Bare ISO 639-1 codes
   * from the registry (e.g. ["en", "ja"]); registry BCP-47 tags are accepted
   * and normalized ("en-US" -> "en"). Anything else throws
   * `MiniappValidationError`.
   */
  languageHints?: LanguageHint[]
  /** Custom vocabulary / boosted terms (e.g. ["MentraOS", "HIPAA"]). */
  vocabulary?: string[]
  /** Enable speaker diarisation. Defaults vary by provider. */
  diarization?: boolean
}

export interface TranscriptionOptions {
  /**
   * Use only on-device STT for this listener; never deliver cloud transcripts.
   * Other listeners on the same stream keep their own routing choice. The
   * phone uses the speech model picked on its Speech page and downloads it if
   * needed; follow that with `onModelStatus`.
   */
  forceLocal?: boolean
}

/**
 * State of the on-device speech-to-text model behind this miniapp's on-device
 * transcription. The phone runs the one model picked on its Speech page for
 * every miniapp.
 */
export interface TranscriptionModelStatus {
  /** BCP-47 language of the picked model, e.g. "en-US". */
  language: string
  /**
   * - `downloading`: the model is being downloaded (`progress` is 0–100).
   * - `loading`: the model is loading into memory.
   * - `ready`: on-device transcripts are flowing.
   * - `unavailable`: no on-device transcription right now; `reason` says why
   *   (for example no on-device subscription, a failed download, or a
   *   subscription in a language other than the picked model's).
   */
  state: "downloading" | "loading" | "ready" | "unavailable"
  progress?: number
  reason?: string
}

export class TranscriptionModule {
  private readonly unsubs = new Set<UnsubscribeFn>()
  private currentConfig: TranscriptionConfig | null = null
  private readonly modelStatusHandlers = new Set<(status: TranscriptionModelStatus) => void>()
  private modelStatusUnsub: UnsubscribeFn | null = null
  private modelStatus: TranscriptionModelStatus | null = null

  constructor(private readonly session: MiniappSession) {}

  /**
   * Subscribe to all transcription events (auto-detect language). The
   * detected language is in `data.language`.
   *
   * Wire-level: subscribes to `transcription:auto`. Today's wildcard fan-out
   * (handlers on `transcription:auto` receive any `transcription:<lang>`
   * event) preserves existing semantics.
   */
  on(handler: (data: TranscriptionData) => void, options: TranscriptionOptions = {}): UnsubscribeFn {
    return this.track(
      this.session._subscribe(`${MiniappStreamType.TRANSCRIPTION}:auto`, handler as (data: unknown) => void, options),
    )
  }

  /**
   * Subscribe to transcription for one or more specific languages. Each call
   * is independent; multiple can be active simultaneously.
   *
   * Languages are validated against the platform registry
   * (`SUPPORTED_TRANSCRIPTION_LANGUAGES`): registry BCP-47 tags pass through,
   * bare registry codes canonicalize ("fr" -> "fr-FR"), anything else throws
   * `MiniappValidationError` immediately — an invalid language must never
   * become a subscription that silently transcribes the wrong thing
   * (OS-1746 / issue 021).
   *
   * @param language - Registry tag(s), e.g. `"en-US"` or `["en-US", "es-ES"]`.
   * @param handler  - Called for every event in any of the listed languages.
   */
  forLanguage(
    language: TranscriptionLanguage | TranscriptionLanguage[],
    handler: (data: TranscriptionData) => void,
    options: TranscriptionOptions = {},
  ): UnsubscribeFn {
    const langs = (Array.isArray(language) ? language : [language]).map((lang) =>
      requireTranscriptionLanguage(lang, "transcription.forLanguage(language)"),
    )
    if (langs.length === 0) return () => {}

    const unsubs: UnsubscribeFn[] = []
    for (const lang of langs) {
      unsubs.push(
        this.session._subscribe(
          `${MiniappStreamType.TRANSCRIPTION}:${lang}`,
          handler as (data: unknown) => void,
          options,
        ),
      )
    }
    const combined: UnsubscribeFn = () => {
      for (const u of unsubs) {
        try {
          u()
        } catch {
          /* ignore */
        }
      }
    }
    return this.track(combined)
  }

  /**
   * Apply transcription configuration (language hints, custom vocabulary,
   * diarisation toggle). Hints are validated against the registry and
   * normalized to bare codes ("en-US" -> "en"); unknown values throw
   * `MiniappValidationError` synchronously.
   *
   * Sent to the phone runtime as a REQUEST (not a one-shot) so the returned
   * promise rejects if the runtime cannot apply it — a config that the
   * platform ignores must be loud, not silent (issue 021 S3). Cached locally
   * so the runtime can re-apply on reconnect.
   */
  configure(config: TranscriptionConfig): Promise<void> {
    const normalized: TranscriptionConfig = {
      ...config,
      languageHints: config.languageHints?.map((hint) =>
        requireLanguageHint(hint, "transcription.configure(languageHints)"),
      ),
    }
    this.currentConfig = {...normalized}
    return this.session
      .sendRequest<void>({
        type: MiniappRequestType.TRANSCRIPTION_CONFIG,
        config: {...normalized},
      })
      .then(() => undefined)
  }

  /**
   * Follow the on-device speech-to-text model's state. You get the current
   * state right away, then every change. Use it to show "downloading 40%" or
   * to wait for `ready` before relying on on-device transcripts.
   */
  onModelStatus(handler: (status: TranscriptionModelStatus) => void): UnsubscribeFn {
    this.modelStatusHandlers.add(handler)
    if (!this.modelStatusUnsub) {
      // One stream subscription per module; the host sends its current state on subscribe.
      this.modelStatusUnsub = this.session._subscribe(MiniappStreamType.TRANSCRIPTION_MODEL_STATUS, (data) => {
        const status = data as TranscriptionModelStatus
        this.modelStatus = status
        for (const listener of [...this.modelStatusHandlers]) listener(status)
      })
    } else if (this.modelStatus) {
      // Later handlers get the last state locally, since the host only replays on subscribe.
      const current = this.modelStatus
      queueMicrotask(() => {
        if (this.modelStatusHandlers.has(handler) && this.modelStatus === current) handler(current)
      })
    }
    return this.track(() => {
      this.modelStatusHandlers.delete(handler)
      if (this.modelStatusHandlers.size > 0) return
      this.modelStatusUnsub?.()
      this.modelStatusUnsub = null
      this.modelStatus = null
    })
  }

  /**
   * End the current on-device utterance now, instead of waiting for the
   * recognizer's own end-of-speech pause. Call it when your own end-of-turn
   * rule fires (for example after `mic.onVoiceActivity` reports enough
   * silence).
   *
   * Resolves with the final text once that final transcript has been
   * delivered to your on-device handlers, or `""` when nothing was pending.
   * Resolves `null` when no on-device recognizer is running or the picked
   * model can't finish early (models that transcribe in fixed chunks); their
   * final text still arrives on its own.
   *
   * Applies only to on-device transcription and needs an active
   * `{forceLocal: true}` subscription. The phone runs one recognizer for every
   * miniapp, so this ends the current line for every on-device subscriber,
   * Captions included.
   */
  finishUtterance(): Promise<string | null> {
    return this.session.sendRequest<string | null>({type: MiniappRequestType.TRANSCRIPTION_FINISH})
  }

  /** Tear down every transcription subscription this module owns. */
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

  /** @internal — current config, read by tests / future reconnect logic. */
  _getConfig(): TranscriptionConfig | null {
    return this.currentConfig ? {...this.currentConfig} : null
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
