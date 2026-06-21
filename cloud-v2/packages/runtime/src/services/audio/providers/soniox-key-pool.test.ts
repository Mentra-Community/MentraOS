import { describe, expect, test } from "bun:test";

import {
  SonioxKeyPool,
  classifySonioxCredentialFailure,
  parseSonioxFallbackApiKeys,
} from "./soniox-key-pool";

describe("SonioxKeyPool", () => {
  test("parses comma-separated fallback keys", () => {
    expect(parseSonioxFallbackApiKeys(" a, b ,, c ")).toEqual(["a", "b", "c"]);
    expect(parseSonioxFallbackApiKeys(undefined)).toEqual([]);
  });

  test("prefers the primary key while available", () => {
    const pool = new SonioxKeyPool("primary", ["fallback-a", "fallback-b"]);

    const credential = pool.selectCredential(new Set(), 1_000);

    expect(credential?.role).toBe("primary");
  });

  test("round-robins fallback keys when primary is cooling down", () => {
    const pool = new SonioxKeyPool("primary", ["fallback-a", "fallback-b"]);
    const primary = pool.selectCredential(new Set(), 1_000)!;
    pool.recordFailure(primary.id, new Error("Soniox error 429: rate limit"), 1_000);

    const first = pool.selectCredential(new Set(), 1_000);
    const second = pool.selectCredential(new Set(), 1_000);
    const third = pool.selectCredential(new Set(), 1_000);

    expect(first?.role).toBe("fallback");
    expect(second?.role).toBe("fallback");
    expect(third?.role).toBe("fallback");
    expect(first?.id).not.toBe(second?.id);
    expect(third?.id).toBe(first?.id);
  });

  test("deduplicates fallback keys that match the primary", () => {
    const pool = new SonioxKeyPool("primary", ["primary", "fallback"]);

    expect(pool.size).toBe(2);
  });

  test("makes concurrency failures available again after a short cooldown", () => {
    const pool = new SonioxKeyPool("primary", ["fallback"]);
    const primary = pool.selectCredential(new Set(), 1_000)!;
    pool.recordFailure(
      primary.id,
      new Error("Soniox error 429: maximum concurrent streams reached"),
      1_000,
    );

    expect(pool.selectCredential(new Set(), 1_000)?.role).toBe("fallback");
    expect(pool.selectCredential(new Set(), 6_001)?.role).toBe("primary");
  });

  test("disables invalid keys for the process", () => {
    const pool = new SonioxKeyPool("primary", ["fallback"]);
    const primary = pool.selectCredential(new Set(), 1_000)!;
    pool.recordFailure(primary.id, new Error("Soniox error 401: invalid api key"), 1_000);

    const availability = pool
      .describeAvailability(10_000)
      .find((item) => item.id === primary.id);

    expect(availability?.disabled).toBe(true);
    expect(availability?.available).toBe(false);
    expect(pool.selectCredential(new Set(), 10_000)?.role).toBe("fallback");
  });
});

describe("classifySonioxCredentialFailure", () => {
  test("classifies quota exhaustion separately from request rate limits", () => {
    expect(classifySonioxCredentialFailure(new Error("Monthly quota exceeded")).kind).toBe(
      "quota",
    );
    expect(
      classifySonioxCredentialFailure(
        new Error("Soniox error 402: Organization monthly budget exhausted"),
      ).kind,
    ).toBe("quota");
    expect(classifySonioxCredentialFailure(new Error("Soniox error 429: rate limit")).kind).toBe(
      "rate_limit",
    );
  });

  test("treats concurrent stream errors as temporary capacity errors", () => {
    expect(classifySonioxCredentialFailure(new Error("Too many concurrent streams")).kind).toBe(
      "concurrency",
    );
  });
});
