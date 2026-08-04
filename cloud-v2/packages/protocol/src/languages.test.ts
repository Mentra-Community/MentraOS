/**
 * @fileoverview Registry tests (issue 021 WP1). Pins the invariants every
 * other layer depends on: hints are bare codes, tags are BCP-47, bare codes
 * canonicalize, invalid input never passes through.
 */
import { describe, test, expect } from "bun:test";

import {
  SUPPORTED_LANGUAGE_HINTS,
  SUPPORTED_TRANSCRIPTION_LANGUAGES,
  isTranscriptionLanguage,
  isLanguageHint,
  toTranscriptionLanguage,
  toLanguageHint,
  suggestTranscriptionLanguage,
} from "./languages";

describe("language registry", () => {
  test("every hint is a bare lowercase ISO 639-1/2 code", () => {
    for (const hint of SUPPORTED_LANGUAGE_HINTS) {
      expect(hint).toMatch(/^[a-z]{2,3}$/);
    }
  });

  test("every subscription tag is BCP-47 shaped", () => {
    for (const tag of SUPPORTED_TRANSCRIPTION_LANGUAGES) {
      expect(tag).toMatch(/^[a-z]{2,3}-[A-Za-z0-9]{2,4}$/);
    }
  });

  test("every canonical tag reduces to a supported hint", () => {
    // "fil-PH" (from tl) is the documented exception: its primary subtag is
    // not in the hint set, so hint derivation yields null and the hint is
    // simply omitted. Everything else must round-trip.
    for (const tag of SUPPORTED_TRANSCRIPTION_LANGUAGES) {
      const hint = toLanguageHint(tag);
      if (tag === "fil-PH") {
        expect(hint).toBeNull();
      } else {
        expect(hint).not.toBeNull();
      }
    }
  });

  test("guards accept members and reject non-members", () => {
    expect(isTranscriptionLanguage("en-US")).toBe(true);
    expect(isTranscriptionLanguage("en")).toBe(false);
    expect(isTranscriptionLanguage("banana")).toBe(false);
    expect(isLanguageHint("en")).toBe(true);
    expect(isLanguageHint("en-US")).toBe(false);
  });

  test("bare codes canonicalize to their default tag", () => {
    expect(toTranscriptionLanguage("fr")).toBe("fr-FR");
    expect(toTranscriptionLanguage("en")).toBe("en-US");
    expect(toTranscriptionLanguage("zh")).toBe("zh-CN");
    expect(toTranscriptionLanguage("tl")).toBe("fil-PH");
  });

  test("supported tags pass through unchanged, including extra regionals", () => {
    expect(toTranscriptionLanguage("fr-FR")).toBe("fr-FR");
    expect(toTranscriptionLanguage("en-GB")).toBe("en-GB");
    expect(toTranscriptionLanguage("zh-TW")).toBe("zh-TW");
  });

  test("invalid input returns null, never a passthrough", () => {
    expect(toTranscriptionLanguage("French")).toBeNull();
    expect(toTranscriptionLanguage("banana")).toBeNull();
    expect(toTranscriptionLanguage("xx-YY")).toBeNull();
  });

  test("hint derivation strips regions and rejects unknowns", () => {
    expect(toLanguageHint("en-US")).toBe("en");
    expect(toLanguageHint("fr")).toBe("fr");
    expect(toLanguageHint("xx-YY")).toBeNull();
  });

  test("suggestions repair case and separator mistakes", () => {
    expect(suggestTranscriptionLanguage("fr_FR")).toBe("fr-FR");
    expect(suggestTranscriptionLanguage("EN-us")).toBe("en-US");
    expect(suggestTranscriptionLanguage("FR")).toBe("fr-FR");
    expect(suggestTranscriptionLanguage("banana")).toBeNull();
  });
});
