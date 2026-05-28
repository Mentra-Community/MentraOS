/**
 * @fileoverview Shared audio types used across services + workers.
 *
 * Currently:
 *   - AudioSubscription (discriminated union: transcription | translation)
 *   - Subscription canonicalization for structural equality
 *   - Inbound WS message envelopes
 *
 * Per the design (docs/issues/003-audio/spec.md "Subscription model"):
 * "Phone aggregates and dedupes across local miniapps; sends a flat list
 * to cloud on every (re)connect. Identity is structural."
 */

export type LanguageSource =
  | { mode: "specific"; code: string }
  | { mode: "auto"; hints?: string[] };

export interface TranscriptionSubscription {
  kind: "transcription";
  language: LanguageSource;
}

export interface TranslationSubscription {
  kind: "translation";
  source: LanguageSource;
  target: string;
}

export type AudioSubscription =
  | TranscriptionSubscription
  | TranslationSubscription;

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

// === WS inbound message envelopes ===

export interface SubscribeWsMessage {
  type: "SUBSCRIBE";
  subs: AudioSubscription[];
}

export interface PingWsMessage {
  type: "ping";
}

export type PhoneInboundWsMessage = SubscribeWsMessage | PingWsMessage;
