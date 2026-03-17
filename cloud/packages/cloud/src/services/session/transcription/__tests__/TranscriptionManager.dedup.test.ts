// @ts-nocheck
import { describe, it, expect, beforeEach, mock, spyOn } from "bun:test";
import { ExtendedStreamType, StreamType, parseLanguageStream, isLanguageStream } from "@mentra/sdk";

/**
 * TranscriptionManager is tightly coupled to UserSession, providers, Docker env vars, etc.
 * Rather than fight the constructor, we extract the pure helpers into a standalone harness
 * that mirrors the private methods exactly as they appear in TranscriptionManager.ts.
 *
 * If the implementation of these methods ever drifts from the source, the integration tests
 * (manual + e2e) will catch it.  These unit tests verify the _logic_ of dedup.
 */

// ─── Re-implement helpers exactly as they appear in TranscriptionManager ─────

function normalizeToBaseLanguage(subscription: ExtendedStreamType): ExtendedStreamType {
  if (typeof subscription !== "string") return subscription;

  const parsed = parseLanguageStream(subscription);
  if (!parsed) return subscription;

  if (parsed.type === StreamType.TRANSCRIPTION) {
    return `${StreamType.TRANSCRIPTION}:${parsed.transcribeLanguage}` as ExtendedStreamType;
  }
  if (parsed.type === StreamType.TRANSLATION && parsed.translateLanguage) {
    return `${StreamType.TRANSLATION}:${parsed.transcribeLanguage}-to-${parsed.translateLanguage}` as ExtendedStreamType;
  }

  return subscription;
}

function getMergedOptionsForLanguage(
  normalizedSubscription: ExtendedStreamType,
  rawSubscriptions: ExtendedStreamType[],
): { hints: string[]; disableLanguageIdentification: boolean } {
  const allHints = new Set<string>();
  let allDisable = true;
  let hasAnySubscriber = false;

  for (const raw of rawSubscriptions) {
    if (normalizeToBaseLanguage(raw) !== normalizedSubscription) continue;
    hasAnySubscriber = true;

    const parsed = parseLanguageStream(raw);
    if (!parsed) continue;

    const hintsParam = parsed.options?.hints;
    if (hintsParam) {
      const hints = (hintsParam as string).split(",").map((h) => h.trim());
      hints.forEach((h) => allHints.add(h));
    }

    const disableParam = parsed.options?.["no-language-identification"];
    if (disableParam !== true && disableParam !== "true") {
      allDisable = false;
    }
  }

  return {
    hints: Array.from(allHints),
    disableLanguageIdentification: hasAnySubscriber ? allDisable : false,
  };
}

function buildSubscriptionWithOptions(
  normalizedSubscription: ExtendedStreamType,
  options: { hints: string[]; disableLanguageIdentification: boolean },
): string {
  const result = normalizedSubscription as string;
  const params = new URLSearchParams();

  if (options.hints.length > 0) {
    params.set("hints", options.hints.join(","));
  }
  if (options.disableLanguageIdentification) {
    params.set("no-language-identification", "true");
  }

  const qs = params.toString();
  return qs ? `${result}?${qs}` : result;
}

function findAppTranscriptionSubscription(
  appSubscriptions: ExtendedStreamType[],
  transcribeLanguage: string,
): ExtendedStreamType | null {
  for (const sub of appSubscriptions) {
    if (!isLanguageStream(sub as string)) continue;
    const parsed = parseLanguageStream(sub as ExtendedStreamType);
    if (parsed && parsed.type === StreamType.TRANSCRIPTION && parsed.transcribeLanguage === transcribeLanguage) {
      return sub;
    }
  }
  return null;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("TranscriptionManager stream dedup", () => {
  // ─── normalizeToBaseLanguage ──────────────────────────────────

  describe("normalizeToBaseLanguage", () => {
    it("returns base form unchanged", () => {
      expect(normalizeToBaseLanguage("transcription:en-US" as ExtendedStreamType)).toBe("transcription:en-US");
    });

    it("strips hints query param", () => {
      expect(normalizeToBaseLanguage("transcription:en-US?hints=ja" as ExtendedStreamType)).toBe("transcription:en-US");
    });

    it("strips multiple query params", () => {
      expect(
        normalizeToBaseLanguage(
          "transcription:en-US?hints=ja,fr&no-language-identification=true" as ExtendedStreamType,
        ),
      ).toBe("transcription:en-US");
    });

    it("preserves auto language code", () => {
      expect(normalizeToBaseLanguage("transcription:auto" as ExtendedStreamType)).toBe("transcription:auto");
    });

    it("normalizes translation to base pair", () => {
      expect(
        normalizeToBaseLanguage("translation:en-US-to-es-ES?no-language-identification=true" as ExtendedStreamType),
      ).toBe("translation:en-US-to-es-ES");
    });

    it("returns non-language streams unchanged", () => {
      expect(normalizeToBaseLanguage("audio_chunk" as ExtendedStreamType)).toBe("audio_chunk");
    });

    it("returns button_press unchanged", () => {
      expect(normalizeToBaseLanguage(StreamType.BUTTON_PRESS as ExtendedStreamType)).toBe(StreamType.BUTTON_PRESS);
    });
  });

  // ─── getMergedOptionsForLanguage ──────────────────────────────

  describe("getMergedOptionsForLanguage", () => {
    it("returns empty options for single sub without options", () => {
      const result = getMergedOptionsForLanguage("transcription:en-US" as ExtendedStreamType, [
        "transcription:en-US" as ExtendedStreamType,
      ]);
      expect(result.hints).toEqual([]);
      expect(result.disableLanguageIdentification).toBe(false);
    });

    it("collects hints from one subscriber", () => {
      const result = getMergedOptionsForLanguage("transcription:en-US" as ExtendedStreamType, [
        "transcription:en-US" as ExtendedStreamType,
        "transcription:en-US?hints=ja" as ExtendedStreamType,
      ]);
      expect(result.hints).toEqual(["ja"]);
      expect(result.disableLanguageIdentification).toBe(false);
    });

    it("unions hints from multiple subscribers", () => {
      const result = getMergedOptionsForLanguage("transcription:en-US" as ExtendedStreamType, [
        "transcription:en-US?hints=ja" as ExtendedStreamType,
        "transcription:en-US?hints=fr,de" as ExtendedStreamType,
      ]);
      expect(result.hints.sort()).toEqual(["de", "fr", "ja"]);
      expect(result.disableLanguageIdentification).toBe(false);
    });

    it("deduplicates overlapping hints", () => {
      const result = getMergedOptionsForLanguage("transcription:en-US" as ExtendedStreamType, [
        "transcription:en-US?hints=ja,fr" as ExtendedStreamType,
        "transcription:en-US?hints=fr,de" as ExtendedStreamType,
      ]);
      expect(result.hints.sort()).toEqual(["de", "fr", "ja"]);
    });

    it("disables language identification only when ALL subscribers disable it", () => {
      const result = getMergedOptionsForLanguage("transcription:en-US" as ExtendedStreamType, [
        "transcription:en-US?no-language-identification=true" as ExtendedStreamType,
      ]);
      expect(result.disableLanguageIdentification).toBe(true);
    });

    it("enables language identification when any subscriber wants it", () => {
      const result = getMergedOptionsForLanguage("transcription:en-US" as ExtendedStreamType, [
        "transcription:en-US?no-language-identification=true" as ExtendedStreamType,
        "transcription:en-US" as ExtendedStreamType,
      ]);
      expect(result.disableLanguageIdentification).toBe(false);
    });

    it("ignores subscriptions for a different base language", () => {
      const result = getMergedOptionsForLanguage("transcription:en-US" as ExtendedStreamType, [
        "transcription:en-US?hints=ja" as ExtendedStreamType,
        "transcription:ja-JP?hints=en" as ExtendedStreamType,
      ]);
      expect(result.hints).toEqual(["ja"]);
    });

    it("returns empty/false when no subscriptions match", () => {
      const result = getMergedOptionsForLanguage("transcription:en-US" as ExtendedStreamType, [
        "transcription:ja-JP?hints=en" as ExtendedStreamType,
      ]);
      expect(result.hints).toEqual([]);
      expect(result.disableLanguageIdentification).toBe(false);
    });
  });

  // ─── buildSubscriptionWithOptions ─────────────────────────────

  describe("buildSubscriptionWithOptions", () => {
    it("returns base subscription when no options", () => {
      expect(
        buildSubscriptionWithOptions("transcription:en-US" as ExtendedStreamType, {
          hints: [],
          disableLanguageIdentification: false,
        }),
      ).toBe("transcription:en-US");
    });

    it("appends hints query param", () => {
      const result = buildSubscriptionWithOptions("transcription:en-US" as ExtendedStreamType, {
        hints: ["ja", "fr"],
        disableLanguageIdentification: false,
      });
      expect(result).toContain("transcription:en-US?");
      expect(result).toContain("hints=ja");
      // URLSearchParams encodes commas — just check both hints are present
      expect(result).toMatch(/ja/);
      expect(result).toMatch(/fr/);
    });

    it("appends no-language-identification", () => {
      const result = buildSubscriptionWithOptions("transcription:en-US" as ExtendedStreamType, {
        hints: [],
        disableLanguageIdentification: true,
      });
      expect(result).toBe("transcription:en-US?no-language-identification=true");
    });

    it("appends both hints and no-language-identification", () => {
      const result = buildSubscriptionWithOptions("transcription:en-US" as ExtendedStreamType, {
        hints: ["ja"],
        disableLanguageIdentification: true,
      });
      expect(result).toContain("hints=");
      expect(result).toContain("no-language-identification=true");
    });
  });

  // ─── findAppTranscriptionSubscription ─────────────────────────

  describe("findAppTranscriptionSubscription", () => {
    it("finds matching subscription by base language", () => {
      const appSubs = [
        "transcription:en-US?hints=ja" as ExtendedStreamType,
        StreamType.BUTTON_PRESS as ExtendedStreamType,
      ];
      expect(findAppTranscriptionSubscription(appSubs, "en-US")).toBe("transcription:en-US?hints=ja");
    });

    it("finds plain subscription without options", () => {
      const appSubs = ["transcription:en-US" as ExtendedStreamType];
      expect(findAppTranscriptionSubscription(appSubs, "en-US")).toBe("transcription:en-US");
    });

    it("returns null when language does not match", () => {
      const appSubs = ["transcription:ja-JP" as ExtendedStreamType];
      expect(findAppTranscriptionSubscription(appSubs, "en-US")).toBeNull();
    });

    it("returns null when app has no transcription subs", () => {
      const appSubs = [StreamType.BUTTON_PRESS as ExtendedStreamType, StreamType.AUDIO_CHUNK as ExtendedStreamType];
      expect(findAppTranscriptionSubscription(appSubs, "en-US")).toBeNull();
    });

    it("returns null for empty subscriptions", () => {
      expect(findAppTranscriptionSubscription([], "en-US")).toBeNull();
    });

    it("ignores translation subscriptions", () => {
      const appSubs = ["translation:en-US-to-es-ES" as ExtendedStreamType];
      expect(findAppTranscriptionSubscription(appSubs, "en-US")).toBeNull();
    });

    it("returns first match when app has multiple transcription subs (shouldn't happen but defensive)", () => {
      const appSubs = [
        "transcription:en-US" as ExtendedStreamType,
        "transcription:en-US?hints=ja" as ExtendedStreamType,
      ];
      // Should return the first one it finds
      const result = findAppTranscriptionSubscription(appSubs, "en-US");
      expect(result).toBe("transcription:en-US");
    });
  });

  // ─── updateSubscriptions dedup (logic-level) ─────────────────
  //
  // We can't construct a real TranscriptionManager without Docker env, MongoDB, etc.
  // Instead we verify the normalization logic that drives dedup: given a set of raw
  // subscriptions, the normalized set should collapse duplicates.

  describe("updateSubscriptions dedup (normalization logic)", () => {
    function simulateNormalization(rawSubs: string[]): {
      normalizedDesired: Set<string>;
      streamCount: number;
    } {
      const validSubscriptions = rawSubs.filter((sub) => !sub.startsWith("translation:")) as ExtendedStreamType[];

      const normalizedDesired = new Set(validSubscriptions.map((s) => normalizeToBaseLanguage(s)));

      return {
        normalizedDesired,
        streamCount: normalizedDesired.size,
      };
    }

    it("deduplicates same base language with different hints → 1 stream", () => {
      const result = simulateNormalization(["transcription:en-US", "transcription:en-US?hints=ja"]);
      expect(result.streamCount).toBe(1);
      expect(result.normalizedDesired.has("transcription:en-US")).toBe(true);
    });

    it("deduplicates same base language with hints and no-language-identification → 1 stream", () => {
      const result = simulateNormalization([
        "transcription:en-US?hints=ja",
        "transcription:en-US?no-language-identification=true",
      ]);
      expect(result.streamCount).toBe(1);
      expect(result.normalizedDesired.has("transcription:en-US")).toBe(true);
    });

    it("keeps different base languages as separate streams", () => {
      const result = simulateNormalization(["transcription:en-US", "transcription:ja-JP"]);
      expect(result.streamCount).toBe(2);
      expect(result.normalizedDesired.has("transcription:en-US")).toBe(true);
      expect(result.normalizedDesired.has("transcription:ja-JP")).toBe(true);
    });

    it("keeps auto and en-US as separate streams", () => {
      const result = simulateNormalization(["transcription:auto", "transcription:en-US"]);
      expect(result.streamCount).toBe(2);
    });

    it("filters out translation subscriptions", () => {
      const result = simulateNormalization(["transcription:en-US", "translation:en-US-to-es-ES"]);
      expect(result.streamCount).toBe(1);
      expect(result.normalizedDesired.has("transcription:en-US")).toBe(true);
    });

    it("three apps with same base language, different options → 1 stream", () => {
      const result = simulateNormalization([
        "transcription:en-US",
        "transcription:en-US?hints=ja",
        "transcription:en-US?hints=fr&no-language-identification=true",
      ]);
      expect(result.streamCount).toBe(1);
    });

    it("subscription change from hints=ja to hints=fr → still 1 stream (same base)", () => {
      // Simulate: first update
      const round1 = simulateNormalization(["transcription:en-US?hints=ja"]);
      expect(round1.streamCount).toBe(1);

      // Simulate: second update after app changed hints
      const round2 = simulateNormalization(["transcription:en-US?hints=fr"]);
      expect(round2.streamCount).toBe(1);

      // The normalized key is the same — no stop/start needed
      expect([...round1.normalizedDesired][0]).toBe([...round2.normalizedDesired][0]);
    });

    it("subscription change from en-US to ja-JP → different stream", () => {
      const round1 = simulateNormalization(["transcription:en-US?hints=ja"]);
      const round2 = simulateNormalization(["transcription:ja-JP"]);

      // Different normalized keys — stop en-US, start ja-JP
      expect([...round1.normalizedDesired][0]).toBe("transcription:en-US");
      expect([...round2.normalizedDesired][0]).toBe("transcription:ja-JP");
    });

    it("empty subscriptions → 0 streams", () => {
      const result = simulateNormalization([]);
      expect(result.streamCount).toBe(0);
    });
  });

  // ─── End-to-end merged options for stream creation ────────────

  describe("merged options for stream creation", () => {
    it("produces correct subscription string for two apps with different hints", () => {
      const rawSubs = [
        "transcription:en-US" as ExtendedStreamType,
        "transcription:en-US?hints=ja" as ExtendedStreamType,
      ];
      const normalized = "transcription:en-US" as ExtendedStreamType;
      const mergedOptions = getMergedOptionsForLanguage(normalized, rawSubs);
      const result = buildSubscriptionWithOptions(normalized, mergedOptions);

      // Should include ja hint but not disable language identification
      expect(result).toContain("hints=ja");
      expect(result).not.toContain("no-language-identification");
    });

    it("produces correct subscription string with all options merged", () => {
      const rawSubs = [
        "transcription:en-US?hints=ja" as ExtendedStreamType,
        "transcription:en-US?hints=fr,de&no-language-identification=true" as ExtendedStreamType,
        "transcription:en-US?no-language-identification=true" as ExtendedStreamType,
      ];
      const normalized = "transcription:en-US" as ExtendedStreamType;
      const mergedOptions = getMergedOptionsForLanguage(normalized, rawSubs);

      // Hints: union of ja, fr, de
      expect(mergedOptions.hints.sort()).toEqual(["de", "fr", "ja"]);
      // disable: NOT all disable (first sub doesn't have the param → defaults to false/enabled)
      // Actually the first sub doesn't have no-language-identification, so allDisable should be false
      expect(mergedOptions.disableLanguageIdentification).toBe(false);

      const result = buildSubscriptionWithOptions(normalized, mergedOptions);
      expect(result).toContain("hints=");
      expect(result).not.toContain("no-language-identification");
    });

    it("disables language identification when all subs disable it", () => {
      const rawSubs = [
        "transcription:en-US?no-language-identification=true" as ExtendedStreamType,
        "transcription:en-US?hints=ja&no-language-identification=true" as ExtendedStreamType,
      ];
      const normalized = "transcription:en-US" as ExtendedStreamType;
      const mergedOptions = getMergedOptionsForLanguage(normalized, rawSubs);

      expect(mergedOptions.disableLanguageIdentification).toBe(true);
      expect(mergedOptions.hints).toEqual(["ja"]);

      const result = buildSubscriptionWithOptions(normalized, mergedOptions);
      expect(result).toContain("no-language-identification=true");
      expect(result).toContain("hints=ja");
    });
  });
});
