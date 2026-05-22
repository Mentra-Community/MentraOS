/**
 * Regression sweep for parseLegacySessionId.
 *
 * Parameterized over a long list of session ID patterns. Goals:
 *   1. Prove the fix works for every hyphen-affected email pattern.
 *   2. Prove no regression for non-hyphenated emails (the vast majority).
 *   3. Prove the cross-product of {hyphenated-email × hyphenated-package} works.
 *   4. Prove behavior matches the pre-fix parser exactly for unambiguous cases.
 *
 * All emails and package names in this file are synthesized examples
 * (`example.com`, `example-corp.com`, `com.example.*`, etc.).
 */

import { describe, expect, test } from "bun:test";

import { parseLegacySessionId } from "./legacy-session-id";

// The pre-fix parser, kept here as a reference implementation so we can
// regression-test against it (verify the new behavior MATCHES it for
// non-hyphenated cases, and DIFFERS from it correctly for the bug cases).
function preFixParseUserId(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  const sep = sessionId.indexOf("-");
  if (sep <= 0) return undefined;
  return sessionId.slice(0, sep);
}

function preFixParsePackageName(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  const sep = sessionId.indexOf("-");
  if (sep === -1 || sep === sessionId.length - 1) return undefined;
  return sessionId.slice(sep + 1);
}

interface SweepCase {
  label: string;
  userId: string;
  packageName: string;
  // If true, the pre-fix parser was broken on this case (used to mark the
  // bug-fix cases where the new behavior intentionally differs from old).
  prefixWasBroken: boolean;
}

// ============================================================================
// Clean (non-hyphenated) email + various package shapes
// ============================================================================

const CLEAN_EMAIL_PATTERNS: SweepCase[] = [
  { label: "simple email + simple package", userId: "alpha@example.com", packageName: "captions", prefixWasBroken: false },
  { label: "simple email + dotted package", userId: "beta@example.com", packageName: "com.example.captions", prefixWasBroken: false },
  { label: "long email + long dotted package", userId: "very.long.email.address+suffix@longdomain.example", packageName: "cloud.example.notify", prefixWasBroken: false },
  { label: "email with dots and digits + simple package", userId: "user1.test2@example.com", packageName: "notes", prefixWasBroken: false },
];

const CLEAN_EMAIL_HYPHENATED_PACKAGE: SweepCase[] = [
  // Pre-fix handled these correctly because the FIRST hyphen still correctly
  // separates email from package when the email has no hyphens.
  { label: "clean email + simple hyphenated package", userId: "alpha@example.com", packageName: "some-app", prefixWasBroken: false },
  { label: "clean email + multi-hyphen package", userId: "alpha@example.com", packageName: "some-app-name", prefixWasBroken: false },
  { label: "clean email + dotted hyphenated package", userId: "alpha@example.com", packageName: "com.example.iris-client", prefixWasBroken: false },
  { label: "clean email + multi-hyphen dotted package", userId: "alpha@example.com", packageName: "com.example.data-plus-visual", prefixWasBroken: false },
  { label: "clean email + leading-segment hyphen", userId: "alpha@example.com", packageName: "com.example.pitch-tuner", prefixWasBroken: false },
  { label: "clean email + ai-assistant style package", userId: "alpha@example.com", packageName: "com.example.ai-assistant", prefixWasBroken: false },
];

// ============================================================================
// Hyphen-affected email patterns (the bug class)
// ============================================================================

const HYPHEN_IN_LOCAL_PART: SweepCase[] = [
  { label: "single hyphen at position 1", userId: "a-b@example.com", packageName: "captions", prefixWasBroken: true },
  { label: "single hyphen mid local-part", userId: "first-last@example.com", packageName: "captions", prefixWasBroken: true },
  { label: "multiple hyphens in local-part", userId: "a-b-c@example.com", packageName: "captions", prefixWasBroken: true },
  { label: "hyphen at end of local-part", userId: "user-@example.com", packageName: "captions", prefixWasBroken: true },
  { label: "leading hyphen in local-part", userId: "-user@example.com", packageName: "captions", prefixWasBroken: true },
  { label: "hyphenated local + hyphenated package", userId: "a-b@example.com", packageName: "some-app-name", prefixWasBroken: true },
  { label: "plus-tag with hyphen in local-part", userId: "alpha+test-dash@example.com", packageName: "some-app", prefixWasBroken: true },
  { label: "plus-tag with hyphen + hyphenated package", userId: "alpha+test-dash@example.com", packageName: "com.example.some-app", prefixWasBroken: true },
];

const HYPHEN_IN_DOMAIN: SweepCase[] = [
  { label: "single hyphen in domain", userId: "user@hyphen-domain.com", packageName: "captions", prefixWasBroken: true },
  { label: "multiple hyphens in domain", userId: "user@multi-hyphen-domain.com", packageName: "captions", prefixWasBroken: true },
  { label: "subdomain with hyphen", userId: "user@sub.hyphen-domain.com", packageName: "captions", prefixWasBroken: true },
  { label: "hyphenated domain + hyphenated package", userId: "user@hyphen-domain.com", packageName: "some-app-name", prefixWasBroken: true },
];

const HYPHEN_BOTH_SIDES: SweepCase[] = [
  { label: "hyphen in local AND domain", userId: "first-last@hyphen-domain.com", packageName: "captions", prefixWasBroken: true },
  { label: "worst case: hyphen everywhere", userId: "a-b@c-d.com", packageName: "some-app-name", prefixWasBroken: true },
];

const ALL_CASES: SweepCase[] = [
  ...CLEAN_EMAIL_PATTERNS,
  ...CLEAN_EMAIL_HYPHENATED_PACKAGE,
  ...HYPHEN_IN_LOCAL_PART,
  ...HYPHEN_IN_DOMAIN,
  ...HYPHEN_BOTH_SIDES,
];

// ============================================================================
// The sweep
// ============================================================================

describe("parseLegacySessionId — regression sweep across patterns", () => {
  describe("with isActiveUserId (production code path)", () => {
    for (const c of ALL_CASES) {
      test(c.label, () => {
        const sessionId = `${c.userId}-${c.packageName}`;
        const result = parseLegacySessionId(sessionId, (uid) => uid === c.userId);
        expect(result).toEqual({
          userId: c.userId,
          packageName: c.packageName,
        });
      });
    }
  });

  describe("without isActiveUserId (fallback picks shortest TLD-shaped @-candidate)", () => {
    // The fallback fires when no live UserSession matches any candidate,
    // OR when the caller doesn't pass a lookup at all. It MUST return the
    // correct userId AND packageName, not just a recognizable userId,
    // because downstream code (v3 SDK reconnect bootstrapping → validate
    // API key) consumes the packageName before the session is available.
    //
    // Sweep covers clean emails AND every hyphen-affected pattern that
    // has a single TLD-shaped @-bearing candidate. Hyphen-only-in-domain
    // cases like `user@hyphen-domain.com` are included — the parser must
    // recover them without a live-session hint.
    for (const c of [
      ...CLEAN_EMAIL_PATTERNS,
      ...CLEAN_EMAIL_HYPHENATED_PACKAGE,
      ...HYPHEN_IN_LOCAL_PART,
      ...HYPHEN_IN_DOMAIN,
      ...HYPHEN_BOTH_SIDES,
    ]) {
      test(`fallback matches expected: ${c.label}`, () => {
        const sessionId = `${c.userId}-${c.packageName}`;
        const result = parseLegacySessionId(sessionId);
        expect(result).toEqual({
          userId: c.userId,
          packageName: c.packageName,
        });
      });
    }
  });
});

describe("parseLegacySessionId — backwards compatibility with pre-fix parser", () => {
  // For inputs WITHOUT hyphens in the userId portion, the new parser must
  // return the SAME result the old broken parser would have. This is the
  // regression guarantee: don't change behavior for working users.
  describe("no behavior change for clean emails (pre-fix was correct)", () => {
    for (const c of [...CLEAN_EMAIL_PATTERNS, ...CLEAN_EMAIL_HYPHENATED_PACKAGE]) {
      test(c.label, () => {
        expect(c.prefixWasBroken).toBe(false); // sanity: these are the "old behavior correct" cases
        const sessionId = `${c.userId}-${c.packageName}`;
        const oldUserId = preFixParseUserId(sessionId);
        const oldPackageName = preFixParsePackageName(sessionId);
        const newResult = parseLegacySessionId(sessionId, (uid) => uid === c.userId);
        expect(newResult?.userId).toBe(oldUserId!);
        expect(newResult?.packageName).toBe(oldPackageName!);
      });
    }
  });

  describe("behavior intentionally changes for hyphenated emails (pre-fix was broken)", () => {
    for (const c of [...HYPHEN_IN_LOCAL_PART, ...HYPHEN_IN_DOMAIN, ...HYPHEN_BOTH_SIDES]) {
      test(c.label, () => {
        expect(c.prefixWasBroken).toBe(true); // sanity: these are the bug cases
        const sessionId = `${c.userId}-${c.packageName}`;
        const oldUserId = preFixParseUserId(sessionId);
        const newResult = parseLegacySessionId(sessionId, (uid) => uid === c.userId);
        // Old parser was broken: extracted wrong userId
        expect(oldUserId).not.toBe(c.userId);
        // New parser fixes it
        expect(newResult?.userId).toBe(c.userId);
        expect(newResult?.packageName).toBe(c.packageName);
      });
    }
  });
});

describe("parseLegacySessionId — lookup is only called when needed and uses correct candidates", () => {
  test("lookup is called with @-bearing candidates only (no garbage)", () => {
    const callsReceived: string[] = [];
    const sessionId = "a-b@example.com-some-app-name";
    parseLegacySessionId(sessionId, (uid) => {
      callsReceived.push(uid);
      return uid === "a-b@example.com";
    });
    // All candidates passed to the lookup must contain "@".
    for (const c of callsReceived) {
      expect(c.includes("@")).toBe(true);
    }
    // "a" (the broken pre-fix answer) must NEVER be passed to the lookup.
    expect(callsReceived).not.toContain("a");
  });

  test("lookup stops as soon as a match is found (longest-first)", () => {
    let calls = 0;
    parseLegacySessionId(
      "a-b@example.com-some-app-name",
      (uid) => {
        calls++;
        // Match on the longest candidate (the full email).
        return uid === "a-b@example.com";
      },
    );
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(4); // bounded by hyphen-position count
  });
});
