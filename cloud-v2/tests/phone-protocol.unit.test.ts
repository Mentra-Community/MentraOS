/**
 * @fileoverview Unit tests for the phone wire-protocol adapter.
 *
 * This module is the seam where cloud-v2 must match the unchanged mobile's
 * v1 wire contract, so it's worth pinning the exact string shapes:
 *   - parse: phone subscription strings -> internal AudioSubscription
 *   - format: the inverse (used by the reference test client)
 *   - transcriptToDataStream: internal TranscriptMessage -> v1 data_stream
 */

import { describe, expect, test } from "bun:test";
import {
  formatPhoneSubscription,
  parsePhoneSubscriptions,
  transcriptToDataStream,
} from "../packages/audio/src/wire/phone-protocol";
import type { TranscriptMessage } from "../packages/audio/src/workers/audio.worker";

describe("parsePhoneSubscriptions", () => {
  test("specific-language transcription", () => {
    expect(parsePhoneSubscriptions(["transcription:en-US"])).toEqual([
      { kind: "transcription", language: { mode: "specific", code: "en-US" } },
    ]);
  });

  test("auto transcription (bare, explicit, and 'all' all mean auto)", () => {
    for (const s of ["transcription", "transcription:auto", "transcription:all"]) {
      expect(parsePhoneSubscriptions([s])).toEqual([
        { kind: "transcription", language: { mode: "auto" } },
      ]);
    }
  });

  test("translation source-to-target", () => {
    expect(parsePhoneSubscriptions(["translation:es-ES-to-en-US"])).toEqual([
      {
        kind: "translation",
        source: { mode: "specific", code: "es-ES" },
        target: "en-US",
      },
    ]);
  });

  test("translation 'all' source means auto", () => {
    expect(parsePhoneSubscriptions(["translation:all-to-en-US"])).toEqual([
      { kind: "translation", source: { mode: "auto" }, target: "en-US" },
    ]);
  });

  test("query suffix is stripped", () => {
    expect(
      parsePhoneSubscriptions(["transcription:en-US?no-language-identification=true"]),
    ).toEqual([
      { kind: "transcription", language: { mode: "specific", code: "en-US" } },
    ]);
  });

  test("non-audio and malformed subscriptions are dropped, not thrown", () => {
    expect(
      parsePhoneSubscriptions([
        "location",
        "calendar",
        "translation:no-separator",
        "transcription:en-US",
      ]),
    ).toEqual([
      { kind: "transcription", language: { mode: "specific", code: "en-US" } },
    ]);
  });
});

describe("formatPhoneSubscription (inverse of parse)", () => {
  test("round-trips the canonical forms", () => {
    const cases = [
      "transcription:en-US",
      "transcription:auto",
      "translation:es-ES-to-en-US",
      "translation:all-to-en-US",
    ];
    for (const s of cases) {
      const parsed = parsePhoneSubscriptions([s]);
      expect(parsed).toHaveLength(1);
      expect(formatPhoneSubscription(parsed[0]!)).toBe(s);
    }
  });
});

describe("transcriptToDataStream", () => {
  const base: Omit<TranscriptMessage, "kind" | "language" | "sourceLanguage"> = {
    type: "TRANSCRIPT",
    mentraUserId: "mu_TEST",
    text: "hello world",
    isFinal: true,
    startMs: 100,
    endMs: 1200,
    source: "soniox",
  };

  test("transcription with a specific language", () => {
    const out = transcriptToDataStream({
      ...base,
      kind: "transcription",
      language: "en-US",
    });
    expect(out).toEqual({
      type: "data_stream",
      streamType: "transcription:en-US",
      data: {
        type: "transcription",
        text: "hello world",
        isFinal: true,
        transcribeLanguage: "en-US",
        detectedLanguage: "en-US",
        startTime: 100,
        endTime: 1200,
        provider: "soniox",
      },
    });
  });

  test("transcription with no/auto language uses the bare streamType", () => {
    const out = transcriptToDataStream({
      ...base,
      kind: "transcription",
      language: undefined,
    });
    expect(out.streamType).toBe("transcription");
    expect(out.data.type).toBe("transcription");
  });

  test("translation maps source/target into streamType and data", () => {
    const out = transcriptToDataStream({
      ...base,
      kind: "translation",
      language: "en-US", // target (emitted text language)
      sourceLanguage: "es-ES",
    });
    expect(out.streamType).toBe("translation:es-ES-to-en-US");
    expect(out.data).toMatchObject({
      type: "translation",
      translateLanguage: "en-US",
      transcribeLanguage: "es-ES",
    });
  });
});
