/**
 * @fileoverview Language validation at the SDK boundary (issue 021, WP2).
 *
 * The registry itself lives in `@mentra/cloud-protocol/languages` (single
 * source of truth shared with the cloud). This module re-exports the types so
 * miniapps import everything from `@mentra/miniapp`, and adds the throwing
 * validators the typed module surfaces (`transcription.*`, `translation.*`)
 * call on every language parameter.
 *
 * Contract (design doc docs/issues/021-typed-language-subscriptions):
 *   - Valid by construction: params are typed as literal unions, so TS users
 *     get autocomplete and compile errors.
 *   - Loud at runtime: JS users (or `any` casts) get a thrown
 *     `MiniappValidationError` with a suggestion, never silent fallback.
 *   - Canonical on the wire: bare codes ("fr") canonicalize to their default
 *     tag ("fr-FR") before becoming stream keys, so the phone/cloud only ever
 *     see registry tags.
 */

import {
  isTranscriptionLanguage,
  suggestTranscriptionLanguage,
  toLanguageHint,
  toTranscriptionLanguage,
  SUPPORTED_LANGUAGE_HINTS,
  SUPPORTED_TRANSCRIPTION_LANGUAGES,
} from "@mentra/cloud-protocol/languages"
import type {LanguageHint, TranscriptionLanguage} from "@mentra/cloud-protocol/languages"

export {SUPPORTED_LANGUAGE_HINTS, SUPPORTED_TRANSCRIPTION_LANGUAGES, isTranscriptionLanguage}
export type {LanguageHint, TranscriptionLanguage}

/**
 * Thrown synchronously by SDK methods when a parameter fails validation.
 * Deliberately a hard throw (not a warning, not a silent default): an invalid
 * language previously produced a subscription that silently transcribed the
 * wrong language or silently never spoke (OS-1746).
 */
export class MiniappValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MiniappValidationError"
  }
}

/**
 * Canonicalize a subscription language or throw. Accepts registry tags
 * ("fr-FR") and bare registry codes ("fr" -> "fr-FR").
 */
export function requireTranscriptionLanguage(value: string, param: string): TranscriptionLanguage {
  const canonical = toTranscriptionLanguage(value)
  if (canonical) return canonical
  const suggestion = suggestTranscriptionLanguage(value)
  throw new MiniappValidationError(
    `${param}: unknown language ${JSON.stringify(value)}` +
      (suggestion ? ` — did you mean ${JSON.stringify(suggestion)}?` : "") +
      ` Supported values are BCP-47 tags from SUPPORTED_TRANSCRIPTION_LANGUAGES (e.g. "en-US", "fr-FR").`,
  )
}

/**
 * Normalize a language hint to the bare code the STT provider accepts, or
 * throw. Accepts bare codes ("fr") and registry tags ("fr-FR" -> "fr").
 */
export function requireLanguageHint(value: string, param: string): LanguageHint {
  const hint = toLanguageHint(value)
  if (hint) return hint
  throw new MiniappValidationError(
    `${param}: unknown language hint ${JSON.stringify(value)}. ` +
      `Hints are bare ISO 639-1 codes from SUPPORTED_LANGUAGE_HINTS (e.g. "en", "fr").`,
  )
}
