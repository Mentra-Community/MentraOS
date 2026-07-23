/**
 * @fileoverview Map a worker-emitted transcript into a v2 wire message.
 *
 * The worker (a Bun Worker thread) speaks a small IPC shape, `TranscriptMessage`,
 * carrying the text plus the subscription that produced it. The client speaks
 * the v2 protocol: `stream.transcript` (transcription) and `stream.translation`
 * (translation), each a `TranscriptionData` / `TranslationData` payload wrapped
 * in the standard envelope.
 *
 * This module is the one place that translation happens, so the worker stays
 * free of protocol types and the WS layer just forwards whatever this returns.
 *
 * Protocol: src/protocol/{audio,messages,envelope}.ts.
 */

import { PROTOCOL_MAJOR, type Envelope } from "@mentra/cloud-protocol/envelope";
import type {
  LanguageSource,
  TranscriptionData,
  TranscriptionSubscription,
  TranslationData,
  TranslationSubscription,
} from "@mentra/cloud-protocol/audio";
import type { TranscriptMessage } from "./workers/worker";

/** The two push messages a transcript can become. */
export type StreamMessage =
  | (Envelope<TranscriptionData> & { type: "stream.transcript" })
  | (Envelope<TranslationData> & { type: "stream.translation" });

/** A specified language resolves to its code; an "auto" source resolves to the
 * language the provider actually detected, falling back to "auto" if it never
 * reported one.
 *
 * For specific mode the subscription's code MUST win over the provider's
 * detected language: the phone routes results to miniapp handlers by exact
 * stream key (`transcription:<resolvedLanguage>`), and providers report bare
 * ISO 639-1 codes ("en") while subscriptions carry BCP-47 tags ("en-US").
 * Echoing the detected code broke every specific-language subscription —
 * results went out keyed `transcription:en` and the `transcription:en-US`
 * handler never fired (OS-1746). */
function resolvedLanguage(
  source: LanguageSource,
  detected: string | undefined,
): { language: string; detected: boolean } {
  if (source.mode === "specific") {
    return { language: source.code, detected: false };
  }
  return { language: detected ?? "auto", detected: true };
}

/**
 * Convert a worker transcript into its v2 envelope. The discriminant is the
 * subscription kind, not the loose `kind` string, so the payload type is
 * sound.
 */
export function transcriptToStreamMessage(t: TranscriptMessage): StreamMessage {
  const timestamp = Date.now();

  if (t.subscription.kind === "translation") {
    const sub: TranslationSubscription = t.subscription;
    const src = resolvedLanguage(sub.source, t.sourceLanguage);
    const payload: TranslationData = {
      userId: t.mentraUserId,
      subscription: sub,
      text: t.text,
      isFinal: t.isFinal,
      originalText: t.originalText,
      utteranceId: t.utteranceId,
      speakerId: t.speakerId,
      startMs: t.startMs ?? 0,
      endMs: t.endMs ?? 0,
      source: { language: src.language, detected: src.detected },
      target: { language: sub.target },
      provider: t.source,
      timestamp,
    };
    return {
      v: PROTOCOL_MAJOR,
      type: "stream.translation",
      timestamp,
      payload,
    };
  }

  const sub: TranscriptionSubscription = t.subscription;
  const lang = resolvedLanguage(sub.language, t.language);
  const payload: TranscriptionData = {
    userId: t.mentraUserId,
    subscription: sub,
    text: t.text,
    isFinal: t.isFinal,
    utteranceId: t.utteranceId,
    speakerId: t.speakerId,
    startMs: t.startMs ?? 0,
    endMs: t.endMs ?? 0,
    resolvedLanguage: lang.language,
    languageDetected: lang.detected,
    tokens: [],
    provider: t.source,
    timestamp,
  };
  return {
    v: PROTOCOL_MAJOR,
    type: "stream.transcript",
    timestamp,
    payload,
  };
}
