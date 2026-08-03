/**
 * @fileoverview Transcription provider interface.
 *
 * Abstracts the "PCM in, transcript out" pipeline so we can swap between:
 *   - `MockProvider` for tests + local dev (no API key needed)
 *   - `SonioxProvider` (next iteration) wrapping `@soniox/node`
 *   - Future: alternative ASR vendors as failover or for specific languages
 *
 * Lifecycle:
 *   const provider = await createMockProvider({ onTranscript: handler });
 *   provider.writeAudio(pcm);           // many times
 *   await provider.close();             // on detach
 *
 * Callbacks are passed at construction time (set-and-forget). Providers
 * don't expose subscribe/unsubscribe — there's one handler per provider
 * instance, owned by the worker that created it.
 */

export interface TranscriptEvent {
  /** Transcribed text. May be a partial token or a complete word/phrase. */
  text: string;
  /** Whether the provider considers this finalized (vs. interim/in-progress). */
  isFinal: boolean;
  /**
   * Stable id for the utterance this event belongs to. Interim and final
   * events for the same speech segment share one id so the client can
   * correlate them and update a single card in place, then commit it on
   * the final. Reset at each utterance boundary (endpoint / speaker change).
   */
  utteranceId?: string;
  /** Speaker id if the provider reports diarization (e.g. `"1"`, `"2"`). */
  speakerId?: string;
  /** Audio timeline window this transcript covers, in milliseconds. */
  startMs?: number;
  endMs?: number;
  /** ISO language code if the provider reports it (e.g. `"en"`). */
  language?: string;
  /**
   * For translation: the source-language text of the same window, when the
   * provider supplies original tokens alongside the translated ones. Lets a
   * client render combined original + translated captions from one stream.
   */
  originalText?: string;
  /**
   * For translation: the DETECTED source-audio language (e.g. `"en"`), taken
   * from the original-language tokens. `language` carries the language of
   * `text` (the target language), so the detected source needs its own field.
   */
  sourceLanguage?: string;
  /** Provider-specific token-level data, for clients that want it. */
  tokens?: Array<{
    text: string;
    isFinal: boolean;
    startMs?: number;
    endMs?: number;
    speaker?: string;
  }>;
}

export interface ProviderOptions {
  /** Identifier for logging — typically the user's `mentraUserId`. */
  scope: string;
  /** Source language (`"auto"` for detection, otherwise BCP-47 code). */
  language: string;
  /**
   * Optional detection hints for `language: "auto"` — bare ISO 639-1 codes
   * ("en", "ja") that bias language identification without pinning it. Ignored
   * for a specific `language` (the language itself is the hint there). Carries
   * the miniapp's `transcription.configure({languageHints})` through to the
   * provider (issue 021).
   */
  languageHints?: string[];
  /** Fired when the provider has a transcript event to emit. */
  onTranscript: (event: TranscriptEvent) => void;
  /** Fired on provider-side errors. Worker logs + decides whether to recreate. */
  onError?: (err: Error) => void;
}

export interface TranscriptionProvider {
  /** Feed a PCM (Int16 mono, 16kHz) chunk. Non-blocking. */
  writeAudio(pcm: Int16Array): void;

  /** Close cleanly. Best-effort flushes any pending interim transcripts. */
  close(): Promise<void>;

  /** Provider identifier for diagnostics — `"mock"`, `"soniox"`, etc. */
  readonly name: string;
}
