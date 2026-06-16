import { describe, expect, test } from "bun:test";

import { parseLegacySessionId } from "./legacy-session-id";

describe("parseLegacySessionId", () => {
  // Helper: build a fake "active user" lookup over a fixed set.
  const liveUsers = (...userIds: string[]) =>
    (id: string) => userIds.includes(id);

  describe("happy path — no hyphens in userId or packageName", () => {
    test("parses standard email + simple package", () => {
      expect(parseLegacySessionId("alpha@example.com-captions")).toEqual({
        userId: "alpha@example.com",
        packageName: "captions",
      });
    });

    test("parses with no isActiveUserId provided (returns longest @-candidate)", () => {
      expect(parseLegacySessionId("alpha@example.com-com.example.captions")).toEqual({
        userId: "alpha@example.com",
        packageName: "com.example.captions",
      });
    });
  });

  describe("hyphen in email local-part", () => {
    test("a-b@example.com with hyphenated package — pre-fix returned userId='a'", () => {
      expect(
        parseLegacySessionId(
          "a-b@example.com-some-app-name",
          liveUsers("a-b@example.com"),
        ),
      ).toEqual({
        userId: "a-b@example.com",
        packageName: "some-app-name",
      });
    });

    test("first-last@example.com with simple package", () => {
      expect(
        parseLegacySessionId("first-last@example.com-captions", liveUsers("first-last@example.com")),
      ).toEqual({
        userId: "first-last@example.com",
        packageName: "captions",
      });
    });

    test("multiple hyphens in local-part", () => {
      expect(
        parseLegacySessionId(
          "first-middle-last@example.com-com.example.notes",
          liveUsers("first-middle-last@example.com"),
        ),
      ).toEqual({
        userId: "first-middle-last@example.com",
        packageName: "com.example.notes",
      });
    });

    test("plus-tag containing a hyphen in local-part", () => {
      expect(
        parseLegacySessionId(
          "alpha+test-dash@example.com-some-app",
          liveUsers("alpha+test-dash@example.com"),
        ),
      ).toEqual({
        userId: "alpha+test-dash@example.com",
        packageName: "some-app",
      });
    });
  });

  describe("hyphen in email domain", () => {
    test("user@hyphen-domain.com with simple package", () => {
      expect(
        parseLegacySessionId("user@hyphen-domain.com-captions", liveUsers("user@hyphen-domain.com")),
      ).toEqual({
        userId: "user@hyphen-domain.com",
        packageName: "captions",
      });
    });

    test("hyphen in domain AND in package name", () => {
      expect(
        parseLegacySessionId(
          "user@hyphen-domain.com-some-app-name",
          liveUsers("user@hyphen-domain.com"),
        ),
      ).toEqual({
        userId: "user@hyphen-domain.com",
        packageName: "some-app-name",
      });
    });
  });

  describe("hyphens on both sides — the worst case", () => {
    test("hyphenated local-part AND hyphenated domain AND hyphenated package", () => {
      expect(
        parseLegacySessionId(
          "x-y@a-b.com-some-app-name",
          liveUsers("x-y@a-b.com"),
        ),
      ).toEqual({
        userId: "x-y@a-b.com",
        packageName: "some-app-name",
      });
    });
  });

  describe("isActiveUserId disambiguation", () => {
    test("when no candidates match, returns shortest TLD-shaped @-candidate as fallback", () => {
      // No live users; fallback should pick the shortest @-bearing candidate
      // whose userId ends with a TLD-shape — the most-likely actual email.
      // For "a-b@example.com-some-app-name" the candidates with "@" are:
      //   - "a-b@example.com"           (ends in ".com" ✓)
      //   - "a-b@example.com-some"      (no TLD shape)
      //   - "a-b@example.com-some-app"  (no TLD shape)
      // Only the first is TLD-shaped, so it wins. Critically, the
      // packageName must come out as "some-app-name", NOT "name".
      expect(
        parseLegacySessionId("a-b@example.com-some-app-name", liveUsers()),
      ).toEqual({
        userId: "a-b@example.com",
        packageName: "some-app-name",
      });
    });

    test("when no isActiveUserId is provided, returns shortest TLD-shaped @-candidate", () => {
      // Same selection rule applies when the caller omits the lookup.
      expect(parseLegacySessionId("a-b@example.com-some-app-name")).toEqual({
        userId: "a-b@example.com",
        packageName: "some-app-name",
      });
    });

    test("hyphen in domain — fallback path still recovers the full email", () => {
      // For "user@hyphen-domain.com-some-app" the @-bearing candidates are:
      //   - "user@hyphen"               (no TLD shape)
      //   - "user@hyphen-domain.com"    (ends in ".com" ✓)
      //   - "user@hyphen-domain.com-some" (no TLD shape)
      // The middle candidate is the only TLD-shaped one and wins, giving
      // the right packageName too.
      expect(parseLegacySessionId("user@hyphen-domain.com-some-app")).toEqual({
        userId: "user@hyphen-domain.com",
        packageName: "some-app",
      });
    });

    test("hyphens on both sides — fallback recovers the right split", () => {
      expect(
        parseLegacySessionId("a-b@c-d.com-some-app-name"),
      ).toEqual({
        userId: "a-b@c-d.com",
        packageName: "some-app-name",
      });
    });

    test("multiple TLD-shaped candidates exist — shortest wins", () => {
      // Pathological: a package name that contains a chunk ending in a
      // TLD-shape (e.g. "pkg.io") followed by another hyphen. Both
      // "user@example.com" and "user@example.com-pkg.io" end in a TLD
      // shape; shortest wins so the userId is the actual email, not an
      // email-plus-package-chunk frankenstring.
      expect(parseLegacySessionId("user@example.com-pkg.io-other")).toEqual({
        userId: "user@example.com",
        packageName: "pkg.io-other",
      });
    });

    test("5-letter TLD (.glass) is recognized", () => {
      // Sanity: covers Mentra's own dogfood domain and equivalents like
      // ".world", ".tech". The TLD regex permits 2–5 letters.
      expect(parseLegacySessionId("user@example.glass-some-app")).toEqual({
        userId: "user@example.glass",
        packageName: "some-app",
      });
    });

    test("hyphenated-subdomain @-candidates aren't confused with TLDs", () => {
      // For "user@sub.hyphen-domain.com-captions" the candidate
      // "user@sub.hyphen" ends in `.hyphen` (6 letters). The 2–5 letter
      // TLD bound rejects it, so only "user@sub.hyphen-domain.com"
      // counts as TLD-shaped and wins — preserving the full domain in
      // the parsed userId.
      expect(parseLegacySessionId("user@sub.hyphen-domain.com-captions")).toEqual({
        userId: "user@sub.hyphen-domain.com",
        packageName: "captions",
      });
    });

    test("long TLD beyond 5 letters (.museum) — falls back to shortest @-candidate, not longest", () => {
      // Pre-fix behavior MUST be preserved for non-hyphenated emails on
      // any TLD: returning userId=email and packageName=full-package.
      // .museum is 6 letters so the TLD regex doesn't match; we want the
      // final fallback to still pick the first @-bearing split, not the
      // last one (which would truncate the package).
      expect(parseLegacySessionId("user@example.museum-some-app-name")).toEqual({
        userId: "user@example.museum",
        packageName: "some-app-name",
      });
    });

    test("long TLD .industries (10 letters) — shortest @-candidate fallback", () => {
      expect(parseLegacySessionId("user@example.industries-pkg-with-hyphens")).toEqual({
        userId: "user@example.industries",
        packageName: "pkg-with-hyphens",
      });
    });

    test("IP-address-domain email — shortest @-candidate fallback", () => {
      // RFC-valid IP-domain email. The regex never matches a numeric
      // suffix, so step 5 fires and returns the first @-bearing split.
      expect(parseLegacySessionId("user@127.0.0.1-pkg-with-hyphens")).toEqual({
        userId: "user@127.0.0.1",
        packageName: "pkg-with-hyphens",
      });
    });

    // Known limitation, not asserted as passing: Punycode IDN domains
    // (`user@example.xn--fiqs8s-pkg-name`) misparse because the regex
    // matches the 2-letter `.xn` prefix as TLD-shaped before reaching
    // the real domain boundary. The clean fix is to swap the regex for
    // the Public Suffix List (`tldts` npm package); tracked as a
    // follow-up issue. Until then, Punycode-email users on legacy v2
    // SDK fall through to the same broken fallback as `.museum` users
    // with hyphen-in-domain — a tiny population.

    test("longest match wins when multiple @-candidates are live", () => {
      // Pathological edge case: both `a@x.com` and `a@x.com-b@y.com` are
      // somehow live. The longer one should win because it's more specific.
      expect(
        parseLegacySessionId(
          "a@x.com-b@y.com-pkg",
          liveUsers("a@x.com", "a@x.com-b@y.com"),
        ),
      ).toEqual({
        userId: "a@x.com-b@y.com",
        packageName: "pkg",
      });
    });

    test("falls through to longer candidate when shorter doesn't match", () => {
      // Walks past a shorter non-matching candidate to reach the live one.
      expect(
        parseLegacySessionId(
          "a-b@example.com-some-app-name",
          liveUsers("a-b@example.com"),
        ),
      ).toEqual({
        userId: "a-b@example.com",
        packageName: "some-app-name",
      });
    });
  });

  describe("malformed input", () => {
    test("empty string", () => {
      expect(parseLegacySessionId("")).toBeUndefined();
    });

    test("undefined", () => {
      expect(parseLegacySessionId(undefined)).toBeUndefined();
    });

    test("no hyphen at all", () => {
      expect(parseLegacySessionId("no-separators-but-no-email")).toBeUndefined();
    });

    test("hyphen but no @ anywhere", () => {
      expect(parseLegacySessionId("foo-bar-baz")).toBeUndefined();
    });

    test("trailing hyphen — empty packageName not allowed", () => {
      expect(parseLegacySessionId("user@example.com-")).toBeUndefined();
    });

    test("leading hyphen", () => {
      // sessionId starts with "-", so first candidate has empty userId,
      // which doesn't contain "@" → no candidate.
      expect(parseLegacySessionId("-bar")).toBeUndefined();
    });

    test("only @ but no hyphen", () => {
      expect(parseLegacySessionId("user@example.com")).toBeUndefined();
    });
  });

  describe("backwards-compatible behavior for unchanged callers", () => {
    test("standard email + dotted package name", () => {
      expect(
        parseLegacySessionId("user@example.com-com.example.captions"),
      ).toEqual({
        userId: "user@example.com",
        packageName: "com.example.captions",
      });
    });

    test("standard email + test-style package name", () => {
      expect(
        parseLegacySessionId("user0@example.com-com.example.testapp"),
      ).toEqual({
        userId: "user0@example.com",
        packageName: "com.example.testapp",
      });
    });
  });
});
