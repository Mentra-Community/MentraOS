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
 *   - Auto-pause on 2s silence gap (Fix 044-3 in v1)
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

import type {
  ProviderOptions,
  TranscriptionProvider,
  TranscriptEvent,
} from "./provider";

const SONIOX_MODEL = process.env.SONIOX_MODEL ?? "stt-rt-v4";

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

/** Shared client per worker. Soniox SDK is happy with one client for many streams. */
let sharedClient: SonioxNodeClient | null = null;
function getClient(): SonioxNodeClient {
  if (sharedClient) return sharedClient;
  const apiKey = process.env.SONIOX_API_KEY;
  if (!apiKey) {
    throw new Error(
      "SONIOX_API_KEY is not set — required to use the soniox provider. Set AUDIO_PROVIDER=mock to use the mock instead.",
    );
  }
  sharedClient = new SonioxNodeClient({ api_key: apiKey });
  return sharedClient;
}

export async function createSonioxProvider(
  opts: CreateSonioxProviderOptions,
): Promise<TranscriptionProvider> {
  const client = opts.client ?? getClient();

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
    language_hints:
      opts.language && opts.language !== "auto" ? [opts.language] : undefined,
    // For translation subs, configure Soniox's one-way translation. Result
    // tokens then carry `translation_status: "original" | "translation"`
    // and we filter to the translation half.
    translation: opts.targetLanguage
      ? { type: "one_way", target_language: opts.targetLanguage }
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

  // Utterance correlation: interim + final events for one speech segment share
  // a `utteranceId`, so the client (local-captions' `updateByUtteranceId`)
  // keeps a single card and updates it in place, committing on the final.
  let currentUtteranceId: string | null = null;
  let currentSpeakerId: string | undefined = undefined;
  let currentLanguage: string | undefined = undefined;

  // Monotonic id minting: a worker-stable counter avoids any reliance on wall
  // clock / RNG and is unique within this provider instance. `opts.scope`
  // (user + sub identity) keeps ids distinct across providers in the worker.
  let utteranceSeq = 0;
  const mintUtteranceId = (): string => {
    utteranceSeq += 1;
    return `utt_${opts.scope}_${utteranceSeq}`;
  };

  const startNewUtterance = (speakerId?: string, language?: string): void => {
    currentUtteranceId = mintUtteranceId();
    currentSpeakerId = speakerId;
    currentLanguage = language;
    stablePrefix = "";
    prevFinalLen = 0;
    lastSentInterim = "";
  };

  /**
   * Commit the current utterance as a single FINAL and reset for the next one.
   * Called only at a real utterance boundary: the Soniox `endpoint` event and
   * stream `close()`. NOT on per-token speaker flicker (see handleResult). No-op
   * if there is nothing buffered, so back-to-back boundaries don't emit empty
   * finals.
   */
  const emitFinal = (startMs?: number, endMs?: number): void => {
    if (!lastSentInterim) {
      // Nothing to commit; still close the utterance so the next token batch
      // starts fresh.
      stablePrefix = "";
      prevFinalLen = 0;
      lastSentInterim = "";
      currentUtteranceId = null;
      return;
    }
    opts.onTranscript({
      text: lastSentInterim,
      isFinal: true,
      utteranceId: currentUtteranceId ?? undefined,
      speakerId: currentSpeakerId,
      language: currentLanguage,
      startMs,
      endMs,
    });
    // Reset for the next utterance. A fresh id is minted lazily when the next
    // token arrives (see handleResult).
    stablePrefix = "";
    prevFinalLen = 0;
    lastSentInterim = "";
    currentUtteranceId = null;
  };

  const handleResult = (result: RealtimeResult) => {
    const allTokens = result.tokens ?? [];

    // For translation subs, drop the original-language tokens — caller
    // only cares about target-language text. For transcription subs,
    // keep everything (translation_status will be 'none' since we didn't
    // request translation).
    const tokens = isTranslation
      ? allTokens.filter(
          (t) =>
            (t as { translation_status?: string }).translation_status ===
            "translation",
        )
      : allTokens;

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
      }

      if (t.is_final) {
        currentFinalText += t.text;
        if (t.start_ms != null && startMs == null) startMs = t.start_ms;
        if (t.end_ms != null) endMs = t.end_ms;
      } else {
        interimText += t.text;
      }
    }

    // Accumulate finalized text. On window growth, append the delta. On
    // shrink (compaction), keep stablePrefix; reset tracker to new length.
    if (currentFinalText.length > prevFinalLen) {
      stablePrefix += currentFinalText.slice(prevFinalLen);
    }
    prevFinalLen = currentFinalText.length;

    const compositeText = stablePrefix + interimText;
    if (compositeText.length === 0) return;

    // Emit an INTERIM only. We deliberately do NOT emit a final on every round
    // that has finalized tokens (v1 lesson: that piles up one card per partial
    // on the client). The single final is emitted at the utterance boundary by
    // `emitFinal`, driven by the Soniox `endpoint` event (and on `close()`).
    if (compositeText !== lastSentInterim) {
      opts.onTranscript({
        text: compositeText,
        isFinal: false,
        utteranceId: currentUtteranceId ?? undefined,
        speakerId: currentSpeakerId,
        language,
        startMs,
        endMs,
      });
      lastSentInterim = compositeText;
    }
  };

  const handleEndpoint = () => {
    // Endpoint fires when Soniox detects an utterance boundary (the `<end>`
    // token). Commit the current utterance as a single FINAL and reset.
    emitFinal();
  };

  const handleError = (err: Error) => {
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
    console.log(
      `[soniox] disconnected scope=${opts.scope} reason=${typeof reason === "string" ? reason : JSON.stringify(reason)}`,
    );
    // An UNEXPECTED disconnect (not our own close()) means the upstream session
    // is gone. Self-heal in place so the provider keeps producing transcripts
    // for the audio that is still arriving. An expected disconnect (closed=true)
    // is the normal teardown and must NOT reconnect.
    scheduleReconnect("disconnected");
  };

  const handleConnected = () => {
    console.log(
      `[soniox] connected scope=${opts.scope} lang=${opts.language}${opts.targetLanguage ? ` → ${opts.targetLanguage}` : ""}`,
    );
  };

  const handleFinished = () => {
    console.log(`[soniox] finished scope=${opts.scope}`);
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
      s.off("error", handleError);
    } catch {
      /* best-effort */
    }
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
    reconnecting = true;

    const attempt = async (): Promise<void> => {
      while (!closed) {
        reconnectAttempts += 1;
        if (reconnectAttempts > reconnect.maxAttempts) {
          console.error(
            `[soniox] self-heal gave up scope=${opts.scope} after ${reconnect.maxAttempts} attempts (trigger=${trigger})`,
          );
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
        console.log(
          `[soniox] self-heal reconnect scope=${opts.scope} attempt=${reconnectAttempts} delayMs=${delay} trigger=${trigger}`,
        );
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
          console.log(`[soniox] self-heal reconnected scope=${opts.scope}`);
          return;
        } catch (err) {
          console.error(
            `[soniox] self-heal connect failed scope=${opts.scope} attempt=${reconnectAttempts}:`,
            err,
          );
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
  } catch (err) {
    console.error(`[soniox] connect failed scope=${opts.scope}:`, err);
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
      // Flush any in-flight utterance as a final so a card that was mid-update
      // gets committed instead of being left dangling on detach.
      try {
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
