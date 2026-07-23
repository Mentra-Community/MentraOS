/**
 * @fileoverview SonioxProvider — real Soniox streaming transcription.
 *
 * Wraps `@soniox/node`'s `RealtimeSttSession` behind the cloud-v2
 * `TranscriptionProvider` interface. One Soniox session per active
 * subscription (per user). Sends PCM as it arrives, emits transcripts
 * back via the provider callback.
 *
 * Configuration:
 *   - Requires `SONIOX_API_KEY` env var.
 *   - Model defaults to `"stt-rt-v4"`; override via `SONIOX_MODEL`.
 *   - Audio format hardcoded to s16le, 16kHz, mono (matches our LC3 output).
 *
 * What this does NOT include (deferred from v1's SonioxSdkStream port):
 *   - Endpoint debounce / merge (mid-utterance endpoint suppression)
 *   - Token compaction handling beyond what the SDK does
 *
 * Those land as we hit them in real-traffic testing. The minimum here is
 * enough to produce real transcripts from real audio; refinements come from
 * observing actual usage.
 *
 * Spec: docs/issues/003-audio/design.md; v1 reference at
 * cloud/packages/cloud/src/services/session/transcription/providers/SonioxSdkStream.ts
 */

import {
  SonioxNodeClient,
  type RealtimeResult,
  type RealtimeSttSession,
  type SttSessionConfig,
} from "@soniox/node";
import { randomUUID } from "node:crypto";

import type {
  ProviderOptions,
  TranscriptionProvider,
  TranscriptEvent,
} from "./provider";
import { createLogger } from "@mentra/cloud-shared";

const logger = createLogger("runtime").child({ module: "soniox" });

const SONIOX_MODEL = process.env.SONIOX_MODEL ?? "stt-rt-v4";
function audioGapConfig(): { checkIntervalMs: number; thresholdMs: number } {
  return {
    checkIntervalMs: Number(process.env.SONIOX_GAP_CHECK_INTERVAL_MS ?? 1_000),
    thresholdMs: Number(process.env.SONIOX_AUDIO_GAP_THRESHOLD_MS ?? 2_000),
  };
}

function endpointDebounceMs(): number {
  return Number(process.env.SONIOX_ENDPOINT_DEBOUNCE_MS ?? 500);
}

const MIN_ENDPOINT_OVERLAP_CHARS = 3;
const MIN_REGRESSION_DROP_CHARS = 12;
const MIN_REGRESSION_PREFIX_CHARS = 12;

/**
 * Self-heal backoff for an unexpected Soniox session drop.
 *
 * The underlying Soniox WebSocket can die WITHOUT our `close()` being called:
 * a network blip, a Soniox-side idle timeout, or a transient upstream error.
 * When that happens the provider object is still held (alive) in the worker's
 * per-user provider map, keyed by subscription identity — and the worker's
 * reconcile is idempotent by that key, so it will NEVER recreate the provider.
 * Audio keeps flowing into a dead session and transcripts silently stop.
 *
 * This is exactly the "captions freeze after a hostile network drop" wedge: a
 * clean pod-roll recovers (it DETACHes the user → the provider map is cleared →
 * a fresh ATTACH recreates providers), but a same-pod reconnect keeps the same
 * worker + the same (now-dead) provider, so only a full app restart recovers.
 *
 * The fix is for the provider to reconnect its OWN Soniox session in place on an
 * unexpected drop, so its identity in the worker map stays valid and transcripts
 * resume without any teardown/recreate. Bounded retries with capped backoff; we
 * give up (and surface onError) only after exhausting them.
 */
/**
 * Read the self-heal backoff tunables. Read per-provider (not at module load)
 * so tests can shrink the delays via env before constructing a provider; in
 * production these are stable for the process lifetime.
 */
function reconnectConfig(): { baseMs: number; maxMs: number; maxAttempts: number } {
  return {
    baseMs: Number(process.env.SONIOX_RECONNECT_BASE_MS ?? 500),
    maxMs: Number(process.env.SONIOX_RECONNECT_MAX_MS ?? 8_000),
    maxAttempts: Number(process.env.SONIOX_RECONNECT_MAX_ATTEMPTS ?? 10),
  };
}

export interface CreateSonioxProviderOptions extends ProviderOptions {
  /** Provide the Soniox client to reuse a single client across multiple streams. */
  client?: SonioxNodeClient;
  /**
   * If set, configure Soniox one-way translation. Result tokens with
   * `translation_status: "translation"` are emitted; original tokens are
   * dropped. If unset, the provider behaves as a transcription stream
   * (all tokens emitted as source-language text).
   */
  targetLanguage?: string;
}

/**
 * Build Soniox `language_hints` from the subscription. A specific language is
 * its own hint (region stripped: "en-US" -> "en"). For "auto" we pass the
 * miniapp's detection hints, each reduced to Soniox's bare-code format and
 * deduped; unknown/empty yields undefined (no hints). Passing a BCP-47 tag or
 * an unrecognized code makes Soniox reject the session ("Invalid language
 * hint"), so everything is normalized here (issue 021).
 */
export function sonioxLanguageHints(
  language: string | undefined,
  hints: string[] | undefined,
): string[] | undefined {
  const toBareCode = (code: string) => code.split("-")[0].toLowerCase();
  if (language && language !== "auto") {
    return [toBareCode(language)];
  }
  if (!hints || hints.length === 0) return undefined;
  const bare = [...new Set(hints.map(toBareCode).filter(Boolean))];
  return bare.length > 0 ? bare : undefined;
}

/**
 * Soniox one-way translation target. Like `language_hints`, Soniox's
 * `translation.target_language` takes a bare ISO 639-1 code — a BCP-47 tag
 * ("es-ES") is rejected with "Invalid language in translation.target_language"
 * and kills the session, so strip the region (mirrors v1's SonioxSdkStream,
 * which used `targetLanguage.split("-")[0]`). Subscription keys and result
 * routing keep the full tag; only the provider config is reduced (issue 021).
 */
export function sonioxTranslationTarget(target: string): string {
  return target.split("-")[0].toLowerCase();
}

/** Shared client per worker. Soniox SDK is happy with one client for many streams. */
let sharedClient: SonioxNodeClient | null = null;
function getClient(): SonioxNodeClient {
  if (sharedClient) return sharedClient;
  const apiKey = process.env.SONIOX_API_KEY;
  if (!apiKey) {
    throw new Error(
      "SONIOX_API_KEY is not set — required to use the soniox provider. Run Cloud V2 through Doppler with access to the cloud-v2/dev config.",
    );
  }
  sharedClient = new SonioxNodeClient({ api_key: apiKey });
  return sharedClient;
}

export async function createSonioxProvider(
  opts: CreateSonioxProviderOptions,
): Promise<TranscriptionProvider> {
  const client = opts.client ?? getClient();
  const gapConfig = audioGapConfig();
  const endpointDebounce = endpointDebounceMs();

  // Build session config. For language="auto" we enable detection; for a
  // specific code we pass it as hint with detection still on. (Letting
  // Soniox identify even when hinted is robust to user accent / code-switch.)
  //
  // Endpoint detection + diarization mirror v1's SonioxSdkStream:
  // `enable_endpoint_detection` makes Soniox emit an `<end>` (surfaced here as
  // the `endpoint` event) at natural utterance boundaries, which is our ONLY
  // signal to commit a single FINAL per utterance (besides stream close).
  // `enable_speaker_diarization` tags tokens with a `speaker` id used purely for
  // the "Speaker N" label; a speaker change does NOT close an utterance, because
  // Soniox re-diarizes its rolling window and the per-token speaker flickers
  // mid-utterance (see handleResult for the full rationale).
  // `max_endpoint_delay_ms` is the v2 SDK's analogue of v1's
  // `max_non_final_tokens_duration_ms` (both bound how long Soniox waits before
  // finalizing after speech ends); v1 used 2000ms.
  const sessionConfig: SttSessionConfig = {
    audio_format: "pcm_s16le",
    sample_rate: 16_000,
    num_channels: 1,
    model: SONIOX_MODEL,
    enable_language_identification: true,
    enable_endpoint_detection: true,
    enable_speaker_diarization: true,
    max_endpoint_delay_ms: 2_000,
    // Soniox hints take bare ISO 639-1 codes ("en"), but subscriptions carry
    // BCP-47 tags ("en-US") — strip the region like v1's SonioxSdkStream did,
    // or the hint is unrecognized and does nothing. For a specific language the
    // language itself is the hint; for "auto" we pass the miniapp's detection
    // hints (already bare codes) so language identification is biased without
    // being pinned.
    language_hints: sonioxLanguageHints(opts.language, opts.languageHints),
    context: {
      terms: ["Mentra", "Hey Mentra"],
      text: "Mentra, Hey Mentra (an AI assistant)",
    },
    // For translation subs, configure Soniox's one-way translation. Result
    // tokens then carry `translation_status: "original" | "translation"`
    // and we filter to the translation half.
    translation: opts.targetLanguage
      ? { type: "one_way", target_language: sonioxTranslationTarget(opts.targetLanguage) }
      : undefined,
  } as SttSessionConfig;
  const isTranslation = !!opts.targetLanguage;

  // The live Soniox session. Mutable because we replace it on a self-heal
  // reconnect (the old one is dead; a fresh `client.realtime.stt(...)` takes its
  // place) while keeping THIS provider object — and therefore its identity in
  // the worker's per-user provider map — stable.
  let session: RealtimeSttSession = client.realtime.stt(sessionConfig);

  // True once `close()` has run. Gates the self-heal path so an expected
  // teardown (our own `session.finish()` → `disconnected`) does not trigger a
  // reconnect, and so a frame written after close is dropped, not sent.
  let closed = false;

  // True while a self-heal reconnect is in flight. Audio written during this
  // window is dropped (there is no live upstream session to take it); the rest
  // of the pipeline already tolerates dropped frames during a reconnect.
  let reconnecting = false;
  let reconnectAttempts = 0;
  let gapCheckInterval: ReturnType<typeof setInterval> | null = null;
  let lastAudioWriteTime = Date.now();
  let pausedForGap = false;

  // === Per-utterance state (ports v1's SonioxTranscriptionProvider) ===
  //
  // Soniox emits a rolling token window where finalized tokens accumulate then
  // may be compacted (pruned). To avoid the interim text shrinking under us we
  // capture finalized text into `stablePrefix` and prepend it to non-final
  // tokens on each result. All of this state is scoped to ONE utterance and is
  // reset by `startNewUtterance` at each boundary.
  let stablePrefix = "";
  let prevFinalLen = 0;
  // Last interim string we emitted for this utterance. Doubles as the text we
  // commit when an utterance closes (endpoint / speaker change), and as a
  // dedupe guard so we don't re-emit an unchanged interim.
  let lastSentInterim = "";

  // Translation subs only: parallel accumulator for the ORIGINAL-language
  // tokens of the same utterance (same rolling-window semantics as above), so
  // results can carry `originalText` for combined original+translated captions.
  // Also tracks the detected SOURCE language — translation-status tokens carry
  // the TARGET language, so the source must come from the original tokens.
  let originalStablePrefix = "";
  let originalPrevFinalLen = 0;
  let lastOriginalText = "";
  let currentSourceLanguage: string | undefined = undefined;

  // Utterance correlation: interim + final events for one speech segment share
  // a `utteranceId`, so the client (local-captions' `updateByUtteranceId`)
  // keeps a single card and updates it in place, committing on the final.
  let currentUtteranceId: string | null = null;
  let currentSpeakerId: string | undefined = undefined;
  let currentLanguage: string | undefined = undefined;

  // Soniox endpoint is a soft signal. It can fire while the SDK still carries
  // the same rolling-window text into the next result, which previously caused
  // a duplicate new utterance/card. Hold the candidate final briefly, and if
  // following results overlap, keep extending the original utterance instead.
  let pendingFinalText = "";
  let pendingFinalUtteranceId: string | null = null;
  let pendingFinalSpeakerId: string | undefined = undefined;
  let pendingFinalLanguage: string | undefined = undefined;
  let pendingFinalOriginalText = "";
  let pendingFinalSourceLanguage: string | undefined = undefined;
  let pendingFinalStartMs: number | undefined = undefined;
  let pendingFinalEndMs: number | undefined = undefined;
  let pendingFinalTimer: ReturnType<typeof setTimeout> | null = null;

  // Monotonic id minting: a provider-instance nonce prevents collisions when the
  // cloud process/provider restarts with the same scope and sequence number.
  // `opts.scope` (user + sub identity) keeps ids readable per subscription.
  let utteranceSeq = 0;
  const providerInstanceId = randomUUID();
  const mintUtteranceId = (): string => {
    utteranceSeq += 1;
    return `utt_${opts.scope}_${providerInstanceId}_${utteranceSeq}`;
  };

  const startNewUtterance = (speakerId?: string, language?: string): void => {
    currentUtteranceId = mintUtteranceId();
    currentSpeakerId = speakerId;
    currentLanguage = language;
    stablePrefix = "";
    prevFinalLen = 0;
    lastSentInterim = "";
    originalStablePrefix = "";
    originalPrevFinalLen = 0;
    lastOriginalText = "";
    currentSourceLanguage = undefined;
  };

  const resetActiveUtterance = (): void => {
    stablePrefix = "";
    prevFinalLen = 0;
    lastSentInterim = "";
    originalStablePrefix = "";
    originalPrevFinalLen = 0;
    lastOriginalText = "";
    currentSourceLanguage = undefined;
    currentUtteranceId = null;
    currentSpeakerId = undefined;
    currentLanguage = undefined;
  };

  const emitFinalEvent = (event: {
    text: string;
    utteranceId?: string;
    speakerId?: string;
    language?: string;
    originalText?: string;
    sourceLanguage?: string;
    startMs?: number;
    endMs?: number;
  }): void => {
    opts.onTranscript({
      text: event.text,
      isFinal: true,
      utteranceId: event.utteranceId,
      speakerId: event.speakerId,
      language: event.language,
      originalText: event.originalText || undefined,
      sourceLanguage: event.sourceLanguage,
      startMs: event.startMs,
      endMs: event.endMs,
    });
  };

  const clearPendingFinal = (): void => {
    if (pendingFinalTimer) {
      clearTimeout(pendingFinalTimer);
      pendingFinalTimer = null;
    }
    pendingFinalText = "";
    pendingFinalUtteranceId = null;
    pendingFinalSpeakerId = undefined;
    pendingFinalLanguage = undefined;
    pendingFinalOriginalText = "";
    pendingFinalSourceLanguage = undefined;
    pendingFinalStartMs = undefined;
    pendingFinalEndMs = undefined;
  };

  const tryMergeOverlap = (a: string, b: string): string | null => {
    const left = a.trim();
    const right = b.trim();
    if (!left || !right) return null;
    if (left === right || left.startsWith(right)) return left;
    if (right.startsWith(left)) return left + right.slice(left.length);

    const maxOverlap = Math.min(left.length, right.length);
    for (let len = maxOverlap; len >= MIN_ENDPOINT_OVERLAP_CHARS; len -= 1) {
      if (left.endsWith(right.slice(0, len))) {
        return left + right.slice(len);
      }
    }
    return null;
  };

  const isLikelyWindowRegression = (next: string, previous: string): boolean => {
    const normalizedNext = next.trim();
    const normalizedPrevious = previous.trim();
    if (!normalizedNext || !normalizedPrevious) return false;
    const drop = normalizedPrevious.length - normalizedNext.length;
    if (drop < MIN_REGRESSION_DROP_CHARS) return false;

    let sharedPrefix = 0;
    const maxPrefix = Math.min(
      normalizedNext.length,
      normalizedPrevious.length,
    );
    while (
      sharedPrefix < maxPrefix &&
      normalizedNext[sharedPrefix] === normalizedPrevious[sharedPrefix]
    ) {
      sharedPrefix += 1;
    }

    return (
      sharedPrefix >=
      Math.min(MIN_REGRESSION_PREFIX_CHARS, normalizedNext.length)
    );
  };

  const commitPendingFinal = (): void => {
    if (!pendingFinalText) {
      clearPendingFinal();
      return;
    }

    const committedText = pendingFinalText;
    const committedUtteranceId = pendingFinalUtteranceId;
    emitFinalEvent({
      text: committedText,
      utteranceId: committedUtteranceId ?? undefined,
      speakerId: pendingFinalSpeakerId,
      language: pendingFinalLanguage,
      originalText: pendingFinalOriginalText,
      sourceLanguage: pendingFinalSourceLanguage,
      startMs: pendingFinalStartMs,
      endMs: pendingFinalEndMs,
    });
    if (
      committedUtteranceId &&
      currentUtteranceId === committedUtteranceId &&
      lastSentInterim.trim() === committedText
    ) {
      resetActiveUtterance();
    }
    clearPendingFinal();
  };

  const schedulePendingFinalCommit = (): void => {
    if (pendingFinalTimer) clearTimeout(pendingFinalTimer);
    pendingFinalTimer = setTimeout(() => {
      commitPendingFinal();
    }, endpointDebounce);
  };

  const setPendingFinalFromActive = (text: string): void => {
    pendingFinalText = text;
    pendingFinalUtteranceId = currentUtteranceId;
    pendingFinalSpeakerId = currentSpeakerId;
    pendingFinalLanguage = currentLanguage;
    pendingFinalOriginalText = lastOriginalText;
    pendingFinalSourceLanguage = currentSourceLanguage;
  };

  /**
   * Commit the current utterance as a single FINAL and reset for the next one.
   * Called only at a real utterance boundary: the Soniox `endpoint` event and
   * stream `close()`. NOT on per-token speaker flicker (see handleResult). No-op
   * if there is nothing buffered, so back-to-back boundaries don't emit empty
   * finals.
   */
  const emitFinal = (startMs?: number, endMs?: number): void => {
    const text = lastSentInterim.trim();
    if (!text) {
      // Nothing to commit; still close the utterance so the next token batch
      // starts fresh.
      resetActiveUtterance();
      return;
    }
    emitFinalEvent({
      text,
      utteranceId: currentUtteranceId ?? undefined,
      speakerId: currentSpeakerId,
      language: currentLanguage,
      originalText: lastOriginalText || undefined,
      sourceLanguage: currentSourceLanguage,
      startMs,
      endMs,
    });
    // Reset for the next utterance. A fresh id is minted lazily when the next
    // token arrives (see handleResult).
    resetActiveUtterance();
  };

  const handleResult = (result: RealtimeResult) => {
    const allTokens = result.tokens ?? [];

    // For translation subs, split the window: translation-status tokens are
    // the emitted `text` (target language); original-status tokens feed the
    // parallel `originalText` accumulator and the detected SOURCE language.
    // For transcription subs, keep everything (translation_status will be
    // 'none' since we didn't request translation).
    //
    // SAME-LANGUAGE PASSTHROUGH (issue 021 / OS-1762): when the spoken
    // language already equals the translation target, Soniox skips translation
    // entirely and emits plain transcription tokens with NO translation_status
    // (verified empirically 2026-07-21: EN speech -> target en yields only
    // untagged tokens; EN -> es yields original/translation pairs). Keep those
    // untagged tokens as emitted text so target-language speech surfaces as a
    // transcription instead of silently vanishing. Because the SAME session
    // makes both the detection and the translation decision, this cannot
    // double-emit: an utterance either has translation tokens (cross-language)
    // or untagged tokens (same-language), never both halves for one segment.
    const tokens = isTranslation
      ? allTokens.filter(
          (t) =>
            (t as { translation_status?: string }).translation_status !==
            "original",
        )
      : allTokens;
    const originalTokens = isTranslation
      ? allTokens.filter(
          (t) =>
            (t as { translation_status?: string }).translation_status ===
            "original",
        )
      : [];

    let interimText = "";
    let language: string | undefined;
    let startMs: number | undefined;
    let endMs: number | undefined;
    let currentFinalText = "";

    for (const t of tokens) {
      // First token of the stream (or first after a commit): open an utterance.
      //
      // IMPORTANT: we deliberately do NOT split the utterance when a token's
      // `speaker` label differs from `currentSpeakerId`. Soniox delivers a
      // ROLLING WINDOW that it RE-DIARIZES across results, so a given token's
      // `speaker` can flicker/flip between rounds within one real utterance.
      // The previous implementation called `emitFinal` + `startNewUtterance` on
      // every such per-token change, which fired spuriously many times within a
      // single utterance — committing a FINAL and minting a NEW utteranceId per
      // partial. On the captions client that produced a pile-up of growing,
      // cumulative cards (one per partial, uncorrelatable), worse with
      // diarization. We instead finalize ONLY on the real utterance boundary:
      // the Soniox `endpoint` event (`handleEndpoint`) and on `close()`.
      //
      // This mirrors v1's SonioxSdkStream (cloud/.../providers/SonioxSdkStream.ts),
      // whose `handleResult` uses the LAST token's speaker for attribution and
      // documents: "Speaker changes within the window do NOT rotate the
      // utteranceId." Speaker is still tracked below for the "Speaker N" label;
      // it just doesn't trigger a finalize/restart.
      if (!currentUtteranceId) {
        startNewUtterance(t.speaker, t.language ?? opts.language);
      }

      // Track the latest token's speaker so the emitted interim/final carries
      // the current (dominant) speaker for the label — without splitting.
      if (t.speaker) currentSpeakerId = t.speaker;
      // Track detected language for output but DON'T split the utterance on a
      // language change — Soniox's per-token language can flap mid-utterance.
      if (t.language) {
        language = t.language;
        currentLanguage = t.language;
        // Untagged tokens on a translation session are the same-language
        // passthrough: their language IS the detected source. (Cross-language
        // source tracking comes from the original-token loop below.)
        if (
          isTranslation &&
          (t as { translation_status?: string }).translation_status == null
        ) {
          currentSourceLanguage = t.language;
        }
      }

      if (t.is_final) {
        currentFinalText += t.text;
        if (t.start_ms != null && startMs == null) startMs = t.start_ms;
        if (t.end_ms != null) endMs = t.end_ms;
      } else {
        interimText += t.text;
      }
    }

    // Original-language tokens (translation subs only): same rolling-window
    // accumulation as the main stream, into the parallel buffers. The first
    // original token may arrive before any translation token; the utterance is
    // opened lazily by either stream above, and `originalText` simply rides
    // along on whichever emit happens next.
    if (originalTokens.length > 0) {
      let originalInterim = "";
      let originalFinal = "";
      for (const t of originalTokens) {
        if (!currentUtteranceId) {
          startNewUtterance(t.speaker, undefined);
        }
        if (t.language) currentSourceLanguage = t.language;
        if (t.is_final) originalFinal += t.text;
        else originalInterim += t.text;
      }
      if (originalFinal.length > originalPrevFinalLen) {
        originalStablePrefix += originalFinal.slice(originalPrevFinalLen);
      }
      originalPrevFinalLen = originalFinal.length;
      const originalComposite = originalStablePrefix + originalInterim;
      if (originalComposite.length > 0) lastOriginalText = originalComposite;
    }

    // Accumulate finalized text. On window growth, append the delta. On
    // shrink (compaction), keep stablePrefix; reset tracker to new length.
    if (currentFinalText.length > prevFinalLen) {
      stablePrefix += currentFinalText.slice(prevFinalLen);
    }
    prevFinalLen = currentFinalText.length;

    const compositeText = (stablePrefix + interimText).trim();
    if (compositeText.length === 0) return;

    if (pendingFinalText && pendingFinalTimer) {
      const pendingBefore = pendingFinalText;
      const merged = tryMergeOverlap(pendingFinalText, compositeText);
      if (merged !== null) {
        currentUtteranceId = pendingFinalUtteranceId ?? currentUtteranceId;
        if (currentSpeakerId) pendingFinalSpeakerId = currentSpeakerId;
        else currentSpeakerId = pendingFinalSpeakerId;
        if (currentLanguage) pendingFinalLanguage = currentLanguage;
        else currentLanguage = pendingFinalLanguage;
        if (lastOriginalText) {
          pendingFinalOriginalText =
            tryMergeOverlap(pendingFinalOriginalText, lastOriginalText) ??
            lastOriginalText;
        }
        if (currentSourceLanguage) {
          pendingFinalSourceLanguage = currentSourceLanguage;
        }

        pendingFinalText = merged;
        lastSentInterim = merged;

        if (merged !== pendingBefore) {
          opts.onTranscript({
            text: merged,
            isFinal: false,
            utteranceId: currentUtteranceId ?? undefined,
            speakerId: currentSpeakerId,
            language,
            originalText: pendingFinalOriginalText || undefined,
            sourceLanguage: pendingFinalSourceLanguage,
            startMs,
            endMs,
          });
          schedulePendingFinalCommit();
        }
        return;
      }

      commitPendingFinal();
    }

    // Emit an INTERIM only. We deliberately do NOT emit a final on every round
    // that has finalized tokens (v1 lesson: that piles up one card per partial
    // on the client). The single final is emitted at the utterance boundary by
    // `emitFinal`, driven by the Soniox `endpoint` event (and on `close()`).
    if (isLikelyWindowRegression(compositeText, lastSentInterim)) {
      return;
    }

    if (compositeText !== lastSentInterim) {
      opts.onTranscript({
        text: compositeText,
        isFinal: false,
        utteranceId: currentUtteranceId ?? undefined,
        speakerId: currentSpeakerId,
        language,
        originalText: lastOriginalText || undefined,
        sourceLanguage: currentSourceLanguage,
        startMs,
        endMs,
      });
      lastSentInterim = compositeText;
    }
  };

  const handleEndpoint = () => {
    // Endpoint fires when Soniox detects an utterance boundary (the `<end>`
    // token). It is a soft signal, so defer the FINAL briefly; if Soniox's
    // next rolling window overlaps, we merge it back into this utterance.
    const candidate = lastSentInterim.trim();
    if (candidate) {
      if (pendingFinalText && pendingFinalTimer) {
        const merged = tryMergeOverlap(pendingFinalText, candidate);
        if (merged !== null) {
          pendingFinalText = merged;
          if (currentSpeakerId) pendingFinalSpeakerId = currentSpeakerId;
          if (currentLanguage) pendingFinalLanguage = currentLanguage;
          if (lastOriginalText) {
            pendingFinalOriginalText =
              tryMergeOverlap(pendingFinalOriginalText, lastOriginalText) ??
              lastOriginalText;
          }
          if (currentSourceLanguage) {
            pendingFinalSourceLanguage = currentSourceLanguage;
          }
        } else {
          commitPendingFinal();
          setPendingFinalFromActive(candidate);
        }
      } else {
        setPendingFinalFromActive(candidate);
      }
      schedulePendingFinalCommit();
    }
    resetActiveUtterance();
  };

  const handleFinalized = () => {
    // The SDK fires this after session.pause() or session.finalize(). For our
    // audio-gap pause, it is the trusted "speech segment ended" signal.
    commitPendingFinal();
    emitFinal();
  };

  const handleError = (err: Error) => {
    stopGapDetection();
    opts.onError?.(err);
    // A provider-side error usually precedes (or accompanies) the socket dying.
    // Treat it as a trigger for the self-heal path: if the session is no longer
    // usable, `scheduleReconnect` brings up a fresh one; if it is still alive,
    // the reconnect is a no-op once `connected` re-fires.
    scheduleReconnect("error");
  };

  // The `disconnected` handler is named so the same function is wired onto every
  // session instance (original + each reconnect) and can be `off`-ed on close.
  const handleDisconnected = (reason: unknown) => {
    logger.info(`disconnected scope=${opts.scope} reason=${typeof reason === "string" ? reason : JSON.stringify(reason)}`);
    // An UNEXPECTED disconnect (not our own close()) means the upstream session
    // is gone. Self-heal in place so the provider keeps producing transcripts
    // for the audio that is still arriving. An expected disconnect (closed=true)
    // is the normal teardown and must NOT reconnect.
    scheduleReconnect("disconnected");
  };

  const handleConnected = () => {
    logger.info(
      `connected scope=${opts.scope} lang=${opts.language}${opts.targetLanguage ? ` → ${opts.targetLanguage}` : ""}`,
    );
  };

  const handleFinished = () => {
    logger.info(`finished scope=${opts.scope}`);
    commitPendingFinal();
    emitFinal();
  };

  /**
   * Wire our handlers onto a Soniox session instance. Visibility events
   * (`connected`/`finished`) and the data/lifecycle events (`result`,
   * `endpoint`, `error`, `disconnected`). Called for the initial session and
   * for every replacement built on a self-heal reconnect.
   */
  const wireSession = (s: RealtimeSttSession): void => {
    s.on("connected", handleConnected);
    s.on("disconnected", handleDisconnected);
    s.on("finished", handleFinished);
    s.on("result", handleResult);
    s.on("endpoint", handleEndpoint);
    s.on("finalized", handleFinalized);
    s.on("error", handleError);
  };

  /** Detach our handlers from a session instance (on replace or close). */
  const unwireSession = (s: RealtimeSttSession): void => {
    try {
      s.off("connected", handleConnected);
      s.off("disconnected", handleDisconnected);
      s.off("finished", handleFinished);
      s.off("result", handleResult);
      s.off("endpoint", handleEndpoint);
      s.off("finalized", handleFinalized);
      s.off("error", handleError);
    } catch {
      /* best-effort */
    }
  };

  const stopGapDetection = (): void => {
    if (gapCheckInterval) {
      clearInterval(gapCheckInterval);
      gapCheckInterval = null;
    }
  };

  const startGapDetection = (): void => {
    stopGapDetection();
    lastAudioWriteTime = Date.now();
    pausedForGap = false;

    gapCheckInterval = setInterval(() => {
      if (closed || reconnecting || pausedForGap) return;
      if (Date.now() - lastAudioWriteTime < gapConfig.thresholdMs) return;

      try {
        session.pause();
        pausedForGap = true;
        logger.info(`auto-paused scope=${opts.scope} after audio gap`);
      } catch (err) {
        logger.warn({ err }, `auto-pause failed scope=${opts.scope}`);
      }
    }, gapConfig.checkIntervalMs);
  };

  /**
   * Rebuild the underlying Soniox session in place after an unexpected drop.
   *
   * Reentrancy-guarded by `reconnecting`, so a burst of `disconnected` + `error`
   * for the same drop schedules exactly one heal. Each attempt builds a fresh
   * session, wires it, and connects; on failure it backs off and retries up to
   * `SONIOX_RECONNECT_MAX_ATTEMPTS`, after which it surfaces the failure via
   * `onError` and stops (the next provider recreate, e.g. a real detach, is the
   * recovery path of last resort). We do NOT flush a final on the dead session's
   * in-flight utterance — the rolling-window state is preserved so the resumed
   * session continues the same card where possible.
   */
  const reconnect = reconnectConfig();
  const scheduleReconnect = (trigger: string): void => {
    if (closed || reconnecting) return;
    stopGapDetection();
    pausedForGap = false;
    reconnecting = true;

    const attempt = async (): Promise<void> => {
      while (!closed) {
        reconnectAttempts += 1;
        if (reconnectAttempts > reconnect.maxAttempts) {
          logger.error(`self-heal gave up scope=${opts.scope} after ${reconnect.maxAttempts} attempts (trigger=${trigger})`);
          opts.onError?.(
            new Error(`soniox session lost and could not reconnect (scope=${opts.scope})`),
          );
          reconnecting = false;
          return;
        }

        const delay = Math.min(
          reconnect.maxMs,
          reconnect.baseMs * 2 ** (reconnectAttempts - 1),
        );
        logger.info(`self-heal reconnect scope=${opts.scope} attempt=${reconnectAttempts} delayMs=${delay} trigger=${trigger}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (closed) break;

        // Drop the dead session's handlers so its late events can't drive us.
        unwireSession(session);

        const next = client.realtime.stt(sessionConfig);
        wireSession(next);
        try {
          await next.connect();
          // Connected: swap in the fresh session and clear the heal state.
          session = next;
          reconnecting = false;
          reconnectAttempts = 0;
          startGapDetection();
          logger.info(`self-heal reconnected scope=${opts.scope}`);
          return;
        } catch (err) {
          logger.error({ err }, `self-heal connect failed scope=${opts.scope} attempt=${reconnectAttempts}`);
          unwireSession(next);
          try {
            await next.close();
          } catch {
            /* best-effort */
          }
          // Loop and back off again.
        }
      }
      reconnecting = false;
    };

    void attempt();
  };

  // Wire the initial session and connect it.
  wireSession(session);
  try {
    await session.connect();
    startGapDetection();
  } catch (err) {
    logger.error({ err }, `connect failed scope=${opts.scope}`);
    opts.onError?.(err as Error);
    throw err;
  }

  return {
    name: "soniox",
    writeAudio(pcm: Int16Array): void {
      // Drop frames while a self-heal reconnect is in flight (or after close):
      // there is no live upstream session to take them, and the pipeline already
      // tolerates a brief audio gap across a reconnect.
      if (closed || reconnecting) return;
      // Soniox SDK accepts Uint8Array of raw PCM bytes.
      const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      lastAudioWriteTime = Date.now();
      if (pausedForGap) {
        try {
          session.resume();
          pausedForGap = false;
          resetActiveUtterance();
          logger.info(`resumed scope=${opts.scope} after audio gap`);
        } catch (err) {
          logger.warn({ err }, `resume failed scope=${opts.scope}`);
        }
      }
      try {
        session.sendAudio(bytes);
      } catch (err) {
        // A throw here usually means the socket died between checks: surface it
        // and kick off self-heal so the next frames have somewhere to land.
        opts.onError?.(err as Error);
        scheduleReconnect("writeAudio");
      }
    },
    async close(): Promise<void> {
      // Mark closed FIRST so any disconnect/error fired by our own teardown does
      // not spin up a self-heal reconnect.
      closed = true;
      stopGapDetection();
      // Flush any in-flight utterance as a final so a card that was mid-update
      // gets committed instead of being left dangling on detach.
      try {
        commitPendingFinal();
        emitFinal();
      } catch {
        /* best-effort */
      }
      try {
        await session.finish();
      } catch {
        /* best-effort */
      }
      try {
        unwireSession(session);
        await session.close();
      } catch {
        /* best-effort */
      }
    },
  };
}
