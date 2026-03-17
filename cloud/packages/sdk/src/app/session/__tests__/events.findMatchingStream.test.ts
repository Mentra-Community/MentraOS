import { describe, it, expect, beforeEach } from "bun:test";
import { EventManager } from "../events";
import { ExtendedStreamType, StreamType } from "../../../types";

describe("EventManager.findMatchingStream", () => {
  let events: EventManager;
  const noop = () => {};

  beforeEach(() => {
    events = new EventManager(noop, noop, "test.app", "");
  });

  /**
   * Helper: register a handler for a given stream type so it appears in handlers map.
   * Returns the cleanup function.
   */
  function registerHandler(streamType: ExtendedStreamType): () => void {
    // addHandler is the internal method used by all on* helpers.
    // We can use onTranscription for en-US or access addHandler via the
    // public convenience methods, but the most direct way is to go through
    // the generic stream subscription path.  EventManager exposes addHandler
    // which calls subscribe + stores in handlers map.
    // We use the internal fact that onTranscription / onTranscriptionForLanguage
    // ultimately call addHandler.  For arbitrary stream types we use the
    // lower-level path:
    return (events as any).addHandler(streamType, () => {});
  }

  // ─── Exact match ───────────────────────────────────────────────

  it("returns exact match for transcription:en-US", () => {
    registerHandler("transcription:en-US" as ExtendedStreamType);
    expect(events.findMatchingStream("transcription:en-US" as ExtendedStreamType)).toBe("transcription:en-US");
  });

  it("returns exact match for non-language stream", () => {
    registerHandler(StreamType.AUDIO_CHUNK as ExtendedStreamType);
    expect(events.findMatchingStream(StreamType.AUDIO_CHUNK as ExtendedStreamType)).toBe(StreamType.AUDIO_CHUNK);
  });

  // ─── Base language matching (the core dedup scenario) ──────────

  it("matches incoming base language to handler with hints", () => {
    // Handler registered with hints, incoming is base language form (from deduped cloud stream)
    registerHandler("transcription:en-US?hints=ja" as ExtendedStreamType);

    const result = events.findMatchingStream("transcription:en-US" as ExtendedStreamType);
    expect(result).toBe("transcription:en-US?hints=ja");
  });

  it("matches incoming base language to handler with no-language-identification", () => {
    registerHandler("transcription:en-US?no-language-identification=true" as ExtendedStreamType);

    const result = events.findMatchingStream("transcription:en-US" as ExtendedStreamType);
    expect(result).toBe("transcription:en-US?no-language-identification=true");
  });

  it("matches incoming base language to handler with hints and no-language-identification", () => {
    registerHandler("transcription:en-US?hints=ja,fr&no-language-identification=true" as ExtendedStreamType);

    const result = events.findMatchingStream("transcription:en-US" as ExtendedStreamType);
    expect(result).toBe("transcription:en-US?hints=ja,fr&no-language-identification=true");
  });

  it("matches incoming with hints to handler with different hints (same base language)", () => {
    registerHandler("transcription:en-US?hints=ja" as ExtendedStreamType);

    // Cloud sends per-app streamType, but in case it sends a different hints variant
    const result = events.findMatchingStream("transcription:en-US?hints=fr" as ExtendedStreamType);
    expect(result).toBe("transcription:en-US?hints=ja");
  });

  // ─── Different languages → no match ────────────────────────────

  it("returns null when incoming language differs from handler", () => {
    registerHandler("transcription:ja-JP" as ExtendedStreamType);

    const result = events.findMatchingStream("transcription:en-US" as ExtendedStreamType);
    expect(result).toBeNull();
  });

  it("does not match transcription:auto to transcription:en-US", () => {
    registerHandler("transcription:auto" as ExtendedStreamType);

    const result = events.findMatchingStream("transcription:en-US" as ExtendedStreamType);
    expect(result).toBeNull();
  });

  it("does not match transcription:en-US to transcription:auto", () => {
    registerHandler("transcription:en-US" as ExtendedStreamType);

    const result = events.findMatchingStream("transcription:auto" as ExtendedStreamType);
    expect(result).toBeNull();
  });

  // ─── Different stream types → no match ─────────────────────────

  it("does not match transcription to translation", () => {
    registerHandler("translation:en-US-to-es-ES" as ExtendedStreamType);

    const result = events.findMatchingStream("transcription:en-US" as ExtendedStreamType);
    expect(result).toBeNull();
  });

  // ─── Translation streams ───────────────────────────────────────

  it("matches translation with same language pair ignoring options", () => {
    registerHandler("translation:en-US-to-es-ES?no-language-identification=true" as ExtendedStreamType);

    const result = events.findMatchingStream("translation:en-US-to-es-ES" as ExtendedStreamType);
    expect(result).toBe("translation:en-US-to-es-ES?no-language-identification=true");
  });

  it("returns null for translation with different target language", () => {
    registerHandler("translation:en-US-to-fr-FR" as ExtendedStreamType);

    const result = events.findMatchingStream("translation:en-US-to-es-ES" as ExtendedStreamType);
    expect(result).toBeNull();
  });

  it("returns null for translation with different source language", () => {
    registerHandler("translation:ja-JP-to-es-ES" as ExtendedStreamType);

    const result = events.findMatchingStream("translation:en-US-to-es-ES" as ExtendedStreamType);
    expect(result).toBeNull();
  });

  // ─── Non-language streams ──────────────────────────────────────

  it("returns null for non-language stream with no handler", () => {
    registerHandler(StreamType.BUTTON_PRESS as ExtendedStreamType);

    const result = events.findMatchingStream(StreamType.AUDIO_CHUNK as ExtendedStreamType);
    expect(result).toBeNull();
  });

  // ─── No handlers at all ────────────────────────────────────────

  it("returns null when no handlers are registered", () => {
    expect(events.findMatchingStream("transcription:en-US" as ExtendedStreamType)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(events.findMatchingStream("" as ExtendedStreamType)).toBeNull();
  });

  // ─── Priority: exact match wins over base-language match ───────

  it("prefers exact match when both exact and base-language handlers exist", () => {
    registerHandler("transcription:en-US" as ExtendedStreamType);
    registerHandler("transcription:en-US?hints=ja" as ExtendedStreamType);

    // Exact match should win via the fast path
    const result = events.findMatchingStream("transcription:en-US" as ExtendedStreamType);
    expect(result).toBe("transcription:en-US");
  });

  it("prefers exact match for hints variant", () => {
    registerHandler("transcription:en-US" as ExtendedStreamType);
    registerHandler("transcription:en-US?hints=ja" as ExtendedStreamType);

    const result = events.findMatchingStream("transcription:en-US?hints=ja" as ExtendedStreamType);
    expect(result).toBe("transcription:en-US?hints=ja");
  });
});
