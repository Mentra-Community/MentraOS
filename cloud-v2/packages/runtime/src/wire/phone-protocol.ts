/**
 * @fileoverview Phone wire protocol adapter (the v1 "glasses-ws" contract).
 *
 * This module is the ONE place that knows the wire shapes the mobile client
 * speaks. The mobile is unchanged between Cloud V1 and Cloud V2, so cloud-v2
 * must match v1's shapes byte-for-byte on this seam:
 *
 *   inbound   { type: "phone_subscription_update", subscriptions: string[] }
 *   outbound  { type: "data_stream", streamType, data }
 *
 * Everything inside the audio service uses its own clean types
 * (`AudioSubscription`, `TranscriptMessage`). This adapter translates at the
 * boundary so the v1 contract never leaks into the worker / pipeline code.
 *
 * Subscription string grammar (from v1, see docs/issues/004-local-sdk/):
 *   transcription                       auto-detect language
 *   transcription:en-US                 specific language
 *   transcription:auto                  auto-detect (explicit)
 *   translation:es-ES-to-en-US          source -> target
 *   translation:all-to-en-US            any source -> target
 * Optional query suffix (e.g. `?no-language-identification=true`) is ignored;
 * the audio pipeline doesn't use it yet.
 */

import type {
  AudioSubscription,
  LanguageSource,
} from "../audio.types";
import type { TranscriptMessage } from "../workers/audio.worker";

// === Inbound: phone -> cloud ===

export interface PhoneSubscriptionUpdate {
  type: "phone_subscription_update";
  subscriptions: string[];
  /** ISO timestamp the mobile stamps on. We don't act on it; kept for parity. */
  timestamp?: string;
}

// === Outbound: cloud -> phone ===

/** The `data` payload for a `transcription:*` stream. Matches v1 TranscriptionData. */
export interface TranscriptionData {
  type: "transcription";
  text: string;
  isFinal: boolean;
  transcribeLanguage?: string;
  detectedLanguage?: string;
  startTime: number;
  endTime: number;
  provider?: string;
}

/** The `data` payload for a `translation:*` stream. Matches v1 TranslationData. */
export interface TranslationData {
  type: "translation";
  text: string;
  isFinal: boolean;
  transcribeLanguage?: string;
  translateLanguage?: string;
  startTime: number;
  endTime: number;
  provider?: string;
}

/** The envelope the mobile receives and routes by `streamType`. */
export interface DataStreamMessage {
  type: "data_stream";
  streamType: string;
  data: TranscriptionData | TranslationData;
}

// === Inbound parsing ===

/**
 * Parse the mobile's flat subscription-string list into the audio service's
 * internal `AudioSubscription[]`. Non-audio subscriptions (location, calendar,
 * etc.) are silently dropped — the audio service only owns transcription and
 * translation. Unparseable entries are skipped rather than throwing, so one
 * bad string can't wedge the whole update.
 */
export function parsePhoneSubscriptions(
  subscriptions: string[],
): AudioSubscription[] {
  const out: AudioSubscription[] = [];
  for (const raw of subscriptions) {
    const sub = parseOne(raw);
    if (sub) out.push(sub);
  }
  return out;
}

function parseOne(raw: string): AudioSubscription | null {
  // Drop any query suffix; we don't consume those options yet.
  const s = raw.split("?", 1)[0]?.trim() ?? "";

  if (s === "transcription" || s.startsWith("transcription:")) {
    const code = s.includes(":") ? s.slice("transcription:".length) : "";
    return { kind: "transcription", language: parseLanguage(code) };
  }

  if (s.startsWith("translation:")) {
    const spec = s.slice("translation:".length); // e.g. "es-ES-to-en-US"
    const sep = spec.indexOf("-to-");
    if (sep === -1) return null;
    const sourceCode = spec.slice(0, sep);
    const target = spec.slice(sep + "-to-".length);
    if (!target) return null;
    return {
      kind: "translation",
      source: parseLanguage(sourceCode),
      target,
    };
  }

  // Not an audio subscription — ignore.
  return null;
}

/** `""` / `auto` / `all` mean auto-detect; anything else is a specific code. */
function parseLanguage(code: string): LanguageSource {
  if (code === "" || code === "auto" || code === "all") return { mode: "auto" };
  return { mode: "specific", code };
}

// === Outbound formatting ===

/**
 * Inverse of {@link parseOne}: render an internal subscription back to its
 * v1 wire string. Used by the reference test client (which thinks in
 * `AudioSubscription`) to emit `phone_subscription_update`.
 */
export function formatPhoneSubscription(sub: AudioSubscription): string {
  if (sub.kind === "transcription") {
    return sub.language.mode === "specific"
      ? `transcription:${sub.language.code}`
      : "transcription:auto";
  }
  const source = sub.source.mode === "specific" ? sub.source.code : "all";
  return `translation:${source}-to-${sub.target}`;
}

/**
 * Convert a worker-emitted `TranscriptMessage` into the v1 `data_stream`
 * envelope the mobile expects. The `streamType` is reconstructed so the
 * mobile routes it to the matching subscription:
 *   transcription -> `transcription:<lang>` (or `transcription` when auto)
 *   translation   -> `translation:<source>-to-<target>`
 */
export function transcriptToDataStream(t: TranscriptMessage): DataStreamMessage {
  if (t.kind === "translation") {
    const source = t.sourceLanguage ?? "auto";
    const target = t.language ?? "";
    return {
      type: "data_stream",
      streamType: `translation:${source}-to-${target}`,
      data: {
        type: "translation",
        text: t.text,
        isFinal: t.isFinal,
        transcribeLanguage: t.sourceLanguage,
        translateLanguage: t.language,
        startTime: t.startMs ?? 0,
        endTime: t.endMs ?? 0,
        provider: t.source,
      },
    };
  }

  const lang = t.language ?? "";
  return {
    type: "data_stream",
    streamType: lang === "" || lang === "auto"
      ? "transcription"
      : `transcription:${lang}`,
    data: {
      type: "transcription",
      text: t.text,
      isFinal: t.isFinal,
      transcribeLanguage: t.language,
      detectedLanguage: t.language,
      startTime: t.startMs ?? 0,
      endTime: t.endMs ?? 0,
      provider: t.source,
    },
  };
}
