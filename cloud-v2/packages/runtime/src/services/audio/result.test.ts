/**
 * @fileoverview Tests for transcriptToStreamMessage, pinning the
 * resolvedLanguage contract (OS-1746).
 *
 * The phone routes results to miniapp handlers by exact stream key
 * (`transcription:<resolvedLanguage>`), so a specific-language subscription
 * MUST get its own code echoed back — never the provider's detected code,
 * which is a bare ISO 639-1 ("en") while subscriptions carry BCP-47 ("en-US").
 */
import { describe, test, expect } from "bun:test";

import { transcriptToStreamMessage } from "./result";
import type { TranscriptMessage } from "./workers/worker";

function transcriptMessage(overrides: Partial<TranscriptMessage>): TranscriptMessage {
  return {
    type: "TRANSCRIPT",
    kind: "transcription",
    mentraUserId: "user@example.com",
    text: "hello",
    isFinal: true,
    language: undefined,
    source: "soniox",
    subscription: { kind: "transcription", language: { mode: "auto" } },
    ...overrides,
  } as TranscriptMessage;
}

describe("transcriptToStreamMessage resolvedLanguage", () => {
  test("specific subscription echoes its own code even when the provider detected a different tag", () => {
    const msg = transcriptToStreamMessage(
      transcriptMessage({
        subscription: { kind: "transcription", language: { mode: "specific", code: "en-US" } },
        language: "en", // Soniox detected code (bare ISO 639-1)
      }),
    );
    expect(msg.type).toBe("stream.transcript");
    if (msg.type !== "stream.transcript") return;
    expect(msg.payload.resolvedLanguage).toBe("en-US");
    expect(msg.payload.languageDetected).toBe(false);
  });

  test("auto subscription resolves to the detected language", () => {
    const msg = transcriptToStreamMessage(
      transcriptMessage({
        subscription: { kind: "transcription", language: { mode: "auto" } },
        language: "es",
      }),
    );
    if (msg.type !== "stream.transcript") throw new Error("expected transcript");
    expect(msg.payload.resolvedLanguage).toBe("es");
    expect(msg.payload.languageDetected).toBe(true);
  });

  test("auto subscription with no detection falls back to auto", () => {
    const msg = transcriptToStreamMessage(
      transcriptMessage({
        subscription: { kind: "transcription", language: { mode: "auto" } },
        language: undefined,
      }),
    );
    if (msg.type !== "stream.transcript") throw new Error("expected transcript");
    expect(msg.payload.resolvedLanguage).toBe("auto");
    expect(msg.payload.languageDetected).toBe(true);
  });

  test("translation with specific source echoes the source code", () => {
    const msg = transcriptToStreamMessage(
      transcriptMessage({
        kind: "translation",
        subscription: {
          kind: "translation",
          source: { mode: "specific", code: "zh-CN" },
          target: "en-US",
        },
        sourceLanguage: "zh",
      } as Partial<TranscriptMessage>),
    );
    expect(msg.type).toBe("stream.translation");
    if (msg.type !== "stream.translation") return;
    expect(msg.payload.source.language).toBe("zh-CN");
    expect(msg.payload.source.detected).toBe(false);
    expect(msg.payload.target.language).toBe("en-US");
  });
});
