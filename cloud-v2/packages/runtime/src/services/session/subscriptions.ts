/**
 * @fileoverview Shared audio types used across services + workers.
 *
 * The canonical subscription/result types and their zod schemas live in
 * `protocol/audio.ts` (the isomorphic `@mentra/cloud-runtime/protocol`
 * entrypoint). This module re-exports the subscription types and adds the
 * server-side `subscriptionKey()` canonicalization used for structural
 * equality + Map keys.
 *
 * Per the design (docs/issues/002-cloud-runtime/audio/spec.md "Subscription
 * model"): "Phone aggregates and dedupes across local miniapps; sends a flat
 * list to cloud on every (re)connect. Identity is structural."
 */
export type {
  LanguageSource,
  TranscriptionSubscription,
  TranslationSubscription,
  AudioSubscription,
} from "@mentra/cloud-protocol/audio";

import type { AudioSubscription, LanguageSource } from "@mentra/cloud-protocol/audio";

/**
 * Stable string key for a subscription, used for equality + Map keys.
 * Canonicalizes `hints` ordering so two subs with the same hints in
 * different array orders compare equal.
 */
export function subscriptionKey(sub: AudioSubscription): string {
  if (sub.kind === "transcription") {
    return `t:${languageKey(sub.language)}`;
  }
  return `x:${languageKey(sub.source)}>${sub.target}`;
}

function languageKey(lang: LanguageSource): string {
  if (lang.mode === "specific") return `s:${lang.code}`;
  const hints = lang.hints ? [...lang.hints].sort().join(",") : "";
  return `a:${hints}`;
}

// WS inbound message envelopes (the v1 phone wire contract:
// `phone_subscription_update`, `ping`) live in `wire/phone-protocol.ts`,
// which translates them into the `AudioSubscription` shape above.
