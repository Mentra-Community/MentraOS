/**
 * @fileoverview MockProvider — synthetic transcripts for tests and local dev.
 *
 * Emits a deterministic transcript on every `writeAudio` call so end-to-end
 * tests can verify "PCM reached a provider and a transcript flowed back"
 * without depending on a real ASR API.
 *
 * Text format: `mock <scope> <n>` where `n` increments per write. Includes
 * the scope (typically the user identifier) so multi-user tests can confirm
 * routing didn't cross-talk.
 */

import type {
  ProviderOptions,
  TranscriptionProvider,
} from "./provider";

export interface CreateMockProviderOptions extends ProviderOptions {
  /**
   * If true, emit one interim then one final per write (mimics a real ASR
   * that streams partials). Default: false — single final per write.
   */
  emitInterim?: boolean;
}

export async function createMockProvider(
  opts: CreateMockProviderOptions,
): Promise<TranscriptionProvider> {
  let writeCount = 0;
  let totalSamples = 0;
  let closed = false;

  return {
    name: "mock",
    writeAudio(pcm: Int16Array): void {
      if (closed) return;
      writeCount++;
      // Audio is 16kHz mono Int16 → 16 samples per millisecond.
      const startMs = Math.round(totalSamples / 16);
      totalSamples += pcm.length;
      const endMs = Math.round(totalSamples / 16);
      const text = `mock ${opts.scope} ${writeCount}`;

      if (opts.emitInterim) {
        opts.onTranscript({
          text,
          isFinal: false,
          startMs,
          endMs,
          language: opts.language,
        });
      }
      opts.onTranscript({
        text,
        isFinal: true,
        startMs,
        endMs,
        language: opts.language,
      });
    },
    async close(): Promise<void> {
      closed = true;
    },
  };
}
