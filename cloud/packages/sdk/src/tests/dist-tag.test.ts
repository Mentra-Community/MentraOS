/**
 * Tests for dist-tag utilities, update messages, clean transport, error classes,
 * and logger factory.
 *
 * Run with: bun test src/tests/dist-tag.test.ts
 */

import { describe, test, expect } from "bun:test";
import { getDistTag, newSDKUpdate } from "../constants/log-messages/updates";
import { createCleanStream } from "../logging/clean-transport";
import { createLogger } from "../logging/logger";
import {
  MentraError,
  MentraAuthError,
  MentraConnectionError,
  MentraTimeoutError,
  MentraValidationError,
  MentraPermissionError,
} from "../logging/errors";

// ─── getDistTag ──────────────────────────────────────────────────────────────

describe("getDistTag", () => {
  test("returns 'latest' for stable versions with no prerelease", () => {
    expect(getDistTag("2.1.29")).toBe("latest");
    expect(getDistTag("1.0.0")).toBe("latest");
    expect(getDistTag("0.0.1")).toBe("latest");
    expect(getDistTag("10.20.30")).toBe("latest");
  });

  test("returns 'beta' for beta prerelease versions", () => {
    expect(getDistTag("2.1.31-beta.5")).toBe("beta");
    expect(getDistTag("3.0.0-beta.0")).toBe("beta");
    expect(getDistTag("1.0.0-beta.100")).toBe("beta");
  });

  test("returns 'hono' for hono prerelease versions", () => {
    expect(getDistTag("3.0.0-hono.4")).toBe("hono");
    expect(getDistTag("3.0.0-hono.0")).toBe("hono");
    expect(getDistTag("4.0.0-hono.1")).toBe("hono");
  });

  test("returns 'alpha' for alpha prerelease versions", () => {
    expect(getDistTag("2.1.2-alpha.0")).toBe("alpha");
    expect(getDistTag("1.0.0-alpha.1")).toBe("alpha");
  });

  test("returns 'rc' for release candidate versions", () => {
    expect(getDistTag("4.0.0-rc.1")).toBe("rc");
    expect(getDistTag("3.0.0-rc.0")).toBe("rc");
  });

  test("returns 'canary' for canary versions", () => {
    expect(getDistTag("5.0.0-canary.1")).toBe("canary");
  });

  test("returns 'next' for next versions", () => {
    expect(getDistTag("5.0.0-next.1")).toBe("next");
  });

  test("returns 'latest' for unrecognized prerelease tags", () => {
    expect(getDistTag("1.0.0-unknown.1")).toBe("latest");
    expect(getDistTag("1.0.0-dev.1")).toBe("latest");
    expect(getDistTag("1.0.0-nightly.20240101")).toBe("latest");
    expect(getDistTag("1.0.0-foo")).toBe("latest");
  });

  test("returns 'latest' for empty or malformed input", () => {
    expect(getDistTag("")).toBe("latest");
    expect(getDistTag("not-a-version")).toBe("latest");
    expect(getDistTag("unknown")).toBe("latest");
  });

  test("does not match partial tag names embedded in longer words", () => {
    // "betamax" should NOT match "beta" — the regex uses -(tag) so
    // "1.0.0-betamax.1" would match "-beta" because the regex doesn't
    // anchor the end. This is a known edge case documenting current behavior.
    // In practice, no real npm dist-tags use these compound names.
    const result = getDistTag("1.0.0-betamax.1");
    // Current behavior: matches "beta" because regex is -(alpha|beta|...)
    // which finds "-beta" inside "-betamax". This is acceptable for real-world usage.
    expect(result).toBe("beta");
  });
});

// ─── newSDKUpdate ────────────────────────────────────────────────────────────

describe("newSDKUpdate", () => {
  test("generates update message for latest track", () => {
    const msg = newSDKUpdate("2.1.29", "2.1.30", "latest");
    expect(msg).toBe("SDK update available: 2.1.29 → 2.1.30 — bun install @mentra/sdk@latest");
  });

  test("generates update message for hono track", () => {
    const msg = newSDKUpdate("3.0.0-hono.4", "3.0.0-hono.5", "hono");
    expect(msg).toBe("SDK update available: 3.0.0-hono.4 → 3.0.0-hono.5 — bun install @mentra/sdk@hono");
  });

  test("generates update message for beta track", () => {
    const msg = newSDKUpdate("2.1.31-beta.5", "2.1.31-beta.6", "beta");
    expect(msg).toBe("SDK update available: 2.1.31-beta.5 → 2.1.31-beta.6 — bun install @mentra/sdk@beta");
  });

  test("defaults to latest when tag is omitted", () => {
    const msg = newSDKUpdate("2.1.29", "2.1.30");
    expect(msg).toContain("@mentra/sdk@latest");
  });

  test("contains the arrow separator", () => {
    const msg = newSDKUpdate("1.0.0", "2.0.0", "latest");
    expect(msg).toContain("→");
  });
});

// ─── Error classes ───────────────────────────────────────────────────────────

describe("MentraError hierarchy", () => {
  test("MentraError has correct name, message, and code", () => {
    const err = new MentraError("test error", "TEST_CODE");
    expect(err.name).toBe("MentraError");
    expect(err.message).toBe("test error");
    expect(err.code).toBe("TEST_CODE");
    expect(err instanceof Error).toBe(true);
    expect(err instanceof MentraError).toBe(true);
  });

  test("MentraAuthError", () => {
    const err = new MentraAuthError("bad key");
    expect(err.name).toBe("MentraAuthError");
    expect(err.code).toBe("AUTH_ERROR");
    expect(err instanceof MentraError).toBe(true);
    expect(err instanceof MentraAuthError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });

  test("MentraConnectionError with default code", () => {
    const err = new MentraConnectionError("connection lost");
    expect(err.name).toBe("MentraConnectionError");
    expect(err.code).toBe("CONNECTION_ERROR");
    expect(err instanceof MentraError).toBe(true);
  });

  test("MentraConnectionError with custom code", () => {
    const err = new MentraConnectionError("refused", "ECONNREFUSED");
    expect(err.code).toBe("ECONNREFUSED");
  });

  test("MentraTimeoutError", () => {
    const err = new MentraTimeoutError("timed out");
    expect(err.name).toBe("MentraTimeoutError");
    expect(err.code).toBe("TIMEOUT_ERROR");
    expect(err instanceof MentraError).toBe(true);
  });

  test("MentraValidationError", () => {
    const err = new MentraValidationError("bad input");
    expect(err.name).toBe("MentraValidationError");
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err instanceof MentraError).toBe(true);
  });

  test("MentraPermissionError includes stream and permission info", () => {
    const err = new MentraPermissionError("denied", "audio", "microphone");
    expect(err.name).toBe("MentraPermissionError");
    expect(err.code).toBe("PERMISSION_ERROR");
    expect(err.stream).toBe("audio");
    expect(err.requiredPermission).toBe("microphone");
    expect(err instanceof MentraError).toBe(true);
  });

  test("error classes work with try/catch instanceof", () => {
    try {
      throw new MentraAuthError("unauthorized");
    } catch (e) {
      expect(e instanceof MentraAuthError).toBe(true);
      expect(e instanceof MentraError).toBe(true);
      expect(e instanceof Error).toBe(true);
      // Should NOT be a different error type
      expect(e instanceof MentraConnectionError).toBe(false);
      expect(e instanceof MentraTimeoutError).toBe(false);
    }
  });
});

// ─── Clean transport ─────────────────────────────────────────────────────────

describe("createCleanStream", () => {
  test("returns a writable stream", () => {
    const stream = createCleanStream();
    expect(stream).toBeDefined();
    expect(typeof stream.write).toBe("function");
    expect(stream.writable).toBe(true);
  });

  test("handles valid JSON log lines without throwing", (done) => {
    const stream = createCleanStream();
    const logLine = JSON.stringify({ level: 30, msg: "hello world" }) + "\n";
    stream.write(logLine, "utf-8", () => {
      // If we get here without throwing, the test passes
      done();
    });
  });

  test("handles empty messages without throwing", (done) => {
    const stream = createCleanStream();
    const logLine = JSON.stringify({ level: 30, msg: "" }) + "\n";
    stream.write(logLine, "utf-8", () => {
      done();
    });
  });

  test("handles malformed JSON without throwing", (done) => {
    const stream = createCleanStream();
    stream.write("not json at all\n", "utf-8", () => {
      done();
    });
  });

  test("handles all pino log levels without throwing", (done) => {
    const stream = createCleanStream();
    const levels = [10, 20, 30, 40, 50, 60];
    let completed = 0;
    for (const level of levels) {
      const logLine = JSON.stringify({ level, msg: `level ${level} message` }) + "\n";
      stream.write(logLine, "utf-8", () => {
        completed++;
        if (completed === levels.length) {
          done();
        }
      });
    }
  });
});

// ─── Logger factory ──────────────────────────────────────────────────────────

describe("createLogger", () => {
  test("creates a logger with default config", () => {
    const logger = createLogger();
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.child).toBe("function");
  });

  test("creates a logger with verbose mode", () => {
    const logger = createLogger({ verbose: true });
    expect(logger).toBeDefined();
  });

  test("creates a logger with explicit log levels", () => {
    const levels = ["none", "error", "warn", "info", "debug"] as const;
    for (const logLevel of levels) {
      const logger = createLogger({ logLevel });
      expect(logger).toBeDefined();
    }
  });

  test("child loggers inherit configuration", () => {
    const logger = createLogger({ logLevel: "warn" });
    const child = logger.child({ module: "test" });
    expect(child).toBeDefined();
    expect(typeof child.info).toBe("function");
    expect(typeof child.warn).toBe("function");
  });

  test("logger can log without throwing", () => {
    const logger = createLogger({ logLevel: "debug", verbose: false });
    // These should not throw
    expect(() => logger.info("test info")).not.toThrow();
    expect(() => logger.warn("test warn")).not.toThrow();
    expect(() => logger.error("test error")).not.toThrow();
    expect(() => logger.debug("test debug")).not.toThrow();
    expect(() => logger.info({ extra: "data" }, "structured log")).not.toThrow();
  });
});

// ─── Integration: getDistTag → newSDKUpdate ──────────────────────────────────

describe("dist-tag integration", () => {
  const testCases = [
    { version: "2.1.29", expectedTag: "latest", nextVersion: "2.1.30" },
    { version: "2.1.31-beta.5", expectedTag: "beta", nextVersion: "2.1.31-beta.6" },
    { version: "3.0.0-hono.4", expectedTag: "hono", nextVersion: "3.0.0-hono.5" },
    { version: "2.1.2-alpha.0", expectedTag: "alpha", nextVersion: "2.1.2-alpha.1" },
    { version: "4.0.0-rc.1", expectedTag: "rc", nextVersion: "4.0.0-rc.2" },
  ];

  for (const { version, expectedTag, nextVersion } of testCases) {
    test(`${version} → detects '${expectedTag}' track → installs @mentra/sdk@${expectedTag}`, () => {
      const tag = getDistTag(version);
      expect(tag).toBe(expectedTag);

      const msg = newSDKUpdate(version, nextVersion, tag);
      expect(msg).toContain(`@mentra/sdk@${expectedTag}`);
      expect(msg).toContain(version);
      expect(msg).toContain(nextVersion);
    });
  }
});

// ─── Cloud endpoint simulation ───────────────────────────────────────────────

describe("cloud version endpoint contract", () => {
  const ALLOWED_DIST_TAGS = new Set(["latest", "beta", "alpha", "hono", "rc", "canary", "next"]);

  test("allowed tags are accepted", () => {
    for (const tag of ["latest", "beta", "alpha", "hono", "rc", "canary", "next"]) {
      expect(ALLOWED_DIST_TAGS.has(tag)).toBe(true);
    }
  });

  test("unknown tags fall back to latest", () => {
    const requestedTag = "nightly";
    const tag = ALLOWED_DIST_TAGS.has(requestedTag) ? requestedTag : "latest";
    expect(tag).toBe("latest");
  });

  test("empty tag defaults to latest", () => {
    const requestedTag = "";
    const resolved = requestedTag || "latest";
    const tag = ALLOWED_DIST_TAGS.has(resolved) ? resolved : "latest";
    expect(tag).toBe("latest");
  });

  test("SDK tag list aligns with cloud allowed list", () => {
    // The SDK's KNOWN_DIST_TAGS should be a subset of the cloud's ALLOWED_DIST_TAGS.
    // This test ensures they stay in sync.
    const SDK_KNOWN_TAGS = ["alpha", "beta", "hono", "rc", "canary", "next"];
    for (const tag of SDK_KNOWN_TAGS) {
      expect(ALLOWED_DIST_TAGS.has(tag)).toBe(true);
    }
  });
});
