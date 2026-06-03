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
} from "./provider.types";

const SONIOX_MODEL = process.env.SONIOX_MODEL ?? "stt-rt-v4";

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
  const sessionConfig: SttSessionConfig = {
    audio_format: "pcm_s16le",
    sample_rate: 16_000,
    num_channels: 1,
    model: SONIOX_MODEL,
    enable_language_identification: true,
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

  const session: RealtimeSttSession = client.realtime.stt(sessionConfig);

  // Stable-prefix accumulator: Soniox emits a rolling token window where
  // finalized tokens accumulate then may be compacted (pruned). To avoid
  // the interim text shrinking under us we capture finalized text into
  // `stablePrefix` and prepend it to non-final tokens on each result.
  let stablePrefix = "";
  let prevFinalLen = 0;

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
    let hasFinal = false;
    let currentFinalText = "";

    for (const t of tokens) {
      if (t.language) language = t.language;
      if (t.is_final) {
        currentFinalText += t.text;
        hasFinal = true;
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

    const evt: TranscriptEvent = {
      text: compositeText,
      isFinal: false,
      language,
      startMs,
      endMs,
    } as TranscriptEvent;
    opts.onTranscript(evt);

    // If we have ANY finalized tokens this round, also emit a finalized
    // event so downstream can commit. The SDK's `endpoint` / `finalized`
    // events are more correct signals long-term; this naive approach is
    // a starting point.
    if (hasFinal && stablePrefix.length > 0) {
      opts.onTranscript({
        text: stablePrefix,
        isFinal: true,
        language,
        startMs,
        endMs,
      });
    }
  };

  const handleEndpoint = () => {
    // Endpoint fires when Soniox detects an utterance boundary. Commit
    // whatever we have in stablePrefix as final and reset for next utterance.
    if (stablePrefix.length > 0) {
      opts.onTranscript({
        text: stablePrefix,
        isFinal: true,
      });
    }
    stablePrefix = "";
    prevFinalLen = 0;
  };

  const handleError = (err: Error) => {
    opts.onError?.(err);
  };

  // Visibility into the Soniox session lifecycle. Logged via console
  // (worker stderr); pino-in-worker can come later. Each line prefixed
  // with [soniox] for easy grep.
  session.on("connected", () => {
    console.log(`[soniox] connected scope=${opts.scope} lang=${opts.language}${opts.targetLanguage ? ` → ${opts.targetLanguage}` : ""}`);
  });
  session.on("disconnected", (reason: unknown) => {
    console.log(`[soniox] disconnected scope=${opts.scope} reason=${typeof reason === "string" ? reason : JSON.stringify(reason)}`);
  });
  session.on("finished", () => {
    console.log(`[soniox] finished scope=${opts.scope}`);
  });
  session.on("result", handleResult);
  session.on("endpoint", handleEndpoint);
  session.on("error", handleError);

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
      // Soniox SDK accepts Uint8Array of raw PCM bytes.
      const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      try {
        session.sendAudio(bytes);
      } catch (err) {
        opts.onError?.(err as Error);
      }
    },
    async close(): Promise<void> {
      try {
        await session.finish();
      } catch {
        /* best-effort */
      }
      try {
        session.off("result", handleResult);
        session.off("endpoint", handleEndpoint);
        session.off("error", handleError);
        await session.close();
      } catch {
        /* best-effort */
      }
    },
  };
}
