import { describe, expect, it } from "bun:test";

import {
  SonioxKeyPool,
  classifySonioxCredentialFailure,
  getSharedSonioxKeyPool,
  parseSonioxFallbackApiKeys,
  resetSharedSonioxKeyPoolsForTests,
} from "../SonioxKeyPool";
import { SONIOX_MODEL as TRANSCRIPTION_SONIOX_MODEL } from "../../transcription/types";
import { SONIOX_MODEL as TRANSLATION_SONIOX_MODEL } from "../../translation/types";

describe("SonioxKeyPool", () => {
  it("defaults legacy Soniox transcription and translation to the current real-time model", () => {
    expect(TRANSCRIPTION_SONIOX_MODEL).toBe("stt-rt-v5");
    expect(TRANSLATION_SONIOX_MODEL).toBe("stt-rt-v5");
  });

  it("parses comma-separated fallback keys", () => {
    expect(parseSonioxFallbackApiKeys(" a, b ,, c ")).toEqual(["a", "b", "c"]);
    expect(parseSonioxFallbackApiKeys(undefined)).toEqual([]);
  });

  it("prefers the primary key while available", () => {
    const pool = new SonioxKeyPool("primary", ["fallback-a", "fallback-b"]);

    const credential = pool.selectCredential(new Set(), 1000);

    expect(credential?.role).toBe("primary");
  });

  it("round-robins fallback keys when primary is cooling down", () => {
    const pool = new SonioxKeyPool("primary", ["fallback-a", "fallback-b"]);
    const primary = pool.selectCredential(new Set(), 1000)!;
    pool.recordFailure(primary.id, new Error("Soniox error 429: rate limit"), 1000);

    const first = pool.selectCredential(new Set(), 1000);
    const second = pool.selectCredential(new Set(), 1000);
    const third = pool.selectCredential(new Set(), 1000);

    expect(first?.role).toBe("fallback");
    expect(second?.role).toBe("fallback");
    expect(third?.role).toBe("fallback");
    expect(first?.id).not.toBe(second?.id);
    expect(third?.id).toBe(first?.id);
  });

  it("deduplicates fallback keys that match the primary", () => {
    const pool = new SonioxKeyPool("primary", ["primary", "fallback"]);

    expect(pool.size).toBe(2);
  });

  it("makes concurrency failures available again after a short cooldown", () => {
    const pool = new SonioxKeyPool("primary", ["fallback"]);
    const primary = pool.selectCredential(new Set(), 1000)!;
    pool.recordFailure(primary.id, new Error("Soniox error 429: maximum concurrent streams reached"), 1000);

    expect(pool.selectCredential(new Set(), 1000)?.role).toBe("fallback");
    expect(pool.selectCredential(new Set(), 6_001)?.role).toBe("primary");
  });

  it("disables invalid keys for the process", () => {
    const pool = new SonioxKeyPool("primary", ["fallback"]);
    const primary = pool.selectCredential(new Set(), 1000)!;
    pool.recordFailure(primary.id, new Error("Soniox error 401: invalid api key"), 1000);

    const availability = pool.describeAvailability(10_000).find((item) => item.id === primary.id);

    expect(availability?.disabled).toBe(true);
    expect(availability?.available).toBe(false);
    expect(pool.selectCredential(new Set(), 10_000)?.role).toBe("fallback");
  });

  it("shares cooldown state for the same configured credentials", () => {
    resetSharedSonioxKeyPoolsForTests();
    const first = getSharedSonioxKeyPool("primary", ["fallback"]);
    const second = getSharedSonioxKeyPool("primary", ["fallback"]);

    const primary = first.selectCredential(new Set(), 1000)!;
    first.recordFailure(primary.id, new Error("Soniox error 402: Organization monthly budget exhausted"), 1000);

    expect(second.selectCredential(new Set(), 1000)?.role).toBe("fallback");
  });
});

describe("classifySonioxCredentialFailure", () => {
  it("classifies quota exhaustion separately from request rate limits", () => {
    expect(classifySonioxCredentialFailure(new Error("Monthly quota exceeded")).kind).toBe("quota");
    expect(classifySonioxCredentialFailure(new Error("Soniox error 402: Organization monthly budget exhausted")).kind).toBe(
      "quota",
    );
    expect(classifySonioxCredentialFailure(new Error("Soniox error 429: rate limit")).kind).toBe("rate_limit");
  });

  it("treats concurrent stream errors as temporary capacity errors", () => {
    expect(classifySonioxCredentialFailure(new Error("Too many concurrent streams")).kind).toBe("concurrency");
  });
});
