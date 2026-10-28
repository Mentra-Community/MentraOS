/**
 * @fileoverview Where speech is processed: on the phone or in the cloud.
 *
 * Transcription listeners (`session.transcription.on` / `forLanguage`) and
 * speech requests (`session.speaker.speak`) take the same `processing` option.
 */

import {MiniappValidationError} from "./languages"

/**
 * Where speech is processed.
 *
 * - `"preferCloud"` (default): the cloud; the phone's on-device models only
 *   while the cloud is unreachable.
 * - `"preferLocal"`: on-device when a model for the language is ready,
 *   otherwise the cloud.
 * - `"localOnly"`: on-device only; never the cloud.
 */
export type SpeechProcessing = "preferCloud" | "preferLocal" | "localOnly"

const SPEECH_PROCESSING: readonly SpeechProcessing[] = ["preferCloud", "preferLocal", "localOnly"]

/** The `processing` option, with the deprecated `forceLocal` it replaces. */
export interface SpeechProcessingOptions {
  processing?: SpeechProcessing
  /** @deprecated Use `processing: "localOnly"`. Removed in 4.0. */
  forceLocal?: boolean
}

/**
 * @internal The processing an options object asks for. `processing` wins;
 * without it, the deprecated `forceLocal: true` means `"localOnly"`.
 * Throws `MiniappValidationError` for an unknown `processing` value.
 */
export function resolveSpeechProcessing(options: SpeechProcessingOptions, where: string): SpeechProcessing {
  const {processing} = options
  if (processing === undefined) return options.forceLocal === true ? "localOnly" : "preferCloud"
  if (SPEECH_PROCESSING.includes(processing)) return processing
  throw new MiniappValidationError(
    `${where}: unknown processing ${JSON.stringify(processing)}. Use ${SPEECH_PROCESSING.map((value) => `"${value}"`).join(", ")}.`,
  )
}
