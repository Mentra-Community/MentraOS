/**
 * Integration test for the legacy session ID parser as wired into
 * bun-websocket.ts.
 *
 * Unit tests in `legacy-session-id.test.ts` cover the parser logic in
 * isolation. This file goes one level up: it imports the wrappers from
 * bun-websocket.ts (via `__forTesting`) and verifies the production
 * wiring — specifically, that those wrappers correctly delegate to
 * `parseLegacySessionId` with `UserSession.getById` injected as the
 * `isActiveUserId` lookup.
 *
 * Strategy: use `spyOn` to control what `UserSession.getById` returns
 * during each test. This exercises the exact production code path
 * (`parseUserIdFromLegacySessionId` → `parseLegacySessionId` →
 * `isActiveUserId` → `UserSession.getById`) without mocking the whole
 * module.
 *
 * All emails and package names in this file are synthesized examples.
 */

import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";

import UserSession from "../session/UserSession";
import { __forTesting } from "./bun-websocket";

const { parseUserIdFromLegacySessionId, parsePackageNameFromLegacySessionId } = __forTesting;

const ACTIVE = new Set<string>();
let getByIdSpy: ReturnType<typeof spyOn> | undefined;

function setActive(...userIds: string[]): void {
  ACTIVE.clear();
  for (const uid of userIds) {
    ACTIVE.add(uid);
  }
}

beforeEach(() => {
  ACTIVE.clear();
  getByIdSpy = spyOn(UserSession, "getById").mockImplementation((userId: string) => {
    return ACTIVE.has(userId) ? ({ userId } as unknown as UserSession) : undefined;
  });
});

afterEach(() => {
  getByIdSpy?.mockRestore();
  ACTIVE.clear();
});

describe("bun-websocket wrappers — integration via __forTesting", () => {
  describe("hyphenated email — live session", () => {
    test("hyphen in local-part + hyphenated package", () => {
      setActive("a-b@example.com");
      const sessionId = "a-b@example.com-some-app-name";
      expect(parseUserIdFromLegacySessionId(sessionId)).toBe("a-b@example.com");
      expect(parsePackageNameFromLegacySessionId(sessionId)).toBe("some-app-name");
    });

    test("hyphen in local-part — no live session, fallback returns correct userId AND package", () => {
      // No active session. Pre-fix would have returned "a". The new
      // fallback path picks the shortest TLD-shaped @-bearing candidate
      // so the userId is the real email AND the packageName isn't
      // truncated. The package value matters: it feeds validateApiKey in
      // the v3-SDK reconnect bootstrapping path.
      const sessionId = "a-b@example.com-some-app-name";
      expect(parseUserIdFromLegacySessionId(sessionId)).toBe("a-b@example.com");
      expect(parsePackageNameFromLegacySessionId(sessionId)).toBe("some-app-name");
    });

    test("hyphen in domain + dotted package", () => {
      setActive("user@hyphen-domain.com");
      const sessionId = "user@hyphen-domain.com-com.example.captions";
      expect(parseUserIdFromLegacySessionId(sessionId)).toBe("user@hyphen-domain.com");
      expect(parsePackageNameFromLegacySessionId(sessionId)).toBe("com.example.captions");
    });

    test("plus-tag with hyphen in local-part + hyphenated package", () => {
      setActive("alpha+test-dash@example.com");
      const sessionId = "alpha+test-dash@example.com-some-app";
      expect(parseUserIdFromLegacySessionId(sessionId)).toBe("alpha+test-dash@example.com");
      expect(parsePackageNameFromLegacySessionId(sessionId)).toBe("some-app");
    });
  });

  describe("non-hyphenated emails — must behave identically to pre-fix", () => {
    test("simple email + dotted package", () => {
      setActive("alpha@example.com");
      const sessionId = "alpha@example.com-com.example.captions";
      expect(parseUserIdFromLegacySessionId(sessionId)).toBe("alpha@example.com");
      expect(parsePackageNameFromLegacySessionId(sessionId)).toBe("com.example.captions");
    });

    test("clean email running app with hyphenated package name", () => {
      setActive("clean.user@example.com");
      const sessionId = "clean.user@example.com-some-app-name";
      expect(parseUserIdFromLegacySessionId(sessionId)).toBe("clean.user@example.com");
      expect(parsePackageNameFromLegacySessionId(sessionId)).toBe("some-app-name");
    });

    test("clean email with no live session — fallback still returns email", () => {
      const sessionId = "clean.user@example.com-com.example.captions";
      expect(parseUserIdFromLegacySessionId(sessionId)).toBe("clean.user@example.com");
      expect(parsePackageNameFromLegacySessionId(sessionId)).toBe("com.example.captions");
    });
  });

  describe("edge cases", () => {
    test("empty string", () => {
      expect(parseUserIdFromLegacySessionId("")).toBeUndefined();
      expect(parsePackageNameFromLegacySessionId("")).toBeUndefined();
    });

    test("undefined", () => {
      expect(parseUserIdFromLegacySessionId(undefined)).toBeUndefined();
      expect(parsePackageNameFromLegacySessionId(undefined)).toBeUndefined();
    });

    test("no @ in the string — not a legacy session ID", () => {
      // The new parser is stricter — requires at least one "@"-bearing candidate.
      // The pre-fix parser would have returned `userId="some"`, `packageName="random-string"`.
      // For non-legacy session IDs, returning undefined is the correct behavior
      // (the caller in bun-websocket.ts already has fallback logic for missing userId).
      expect(parseUserIdFromLegacySessionId("some-random-string")).toBeUndefined();
      expect(parsePackageNameFromLegacySessionId("some-random-string")).toBeUndefined();
    });

    test("hyphen in domain only", () => {
      setActive("user@hyphen-corp.uk");
      const sessionId = "user@hyphen-corp.uk-captions";
      expect(parseUserIdFromLegacySessionId(sessionId)).toBe("user@hyphen-corp.uk");
      expect(parsePackageNameFromLegacySessionId(sessionId)).toBe("captions");
    });

    test("hyphens in BOTH email AND package", () => {
      setActive("a-b@c-d.com");
      const sessionId = "a-b@c-d.com-some-app-name";
      expect(parseUserIdFromLegacySessionId(sessionId)).toBe("a-b@c-d.com");
      expect(parsePackageNameFromLegacySessionId(sessionId)).toBe("some-app-name");
    });
  });

  describe("disambiguation with multiple live users", () => {
    test("when both `a@x.com` and `a@x.com-b@y.com` are live, longer wins", () => {
      setActive("a@x.com", "a@x.com-b@y.com");
      const sessionId = "a@x.com-b@y.com-captions";
      expect(parseUserIdFromLegacySessionId(sessionId)).toBe("a@x.com-b@y.com");
      expect(parsePackageNameFromLegacySessionId(sessionId)).toBe("captions");
    });

    test("when only the shorter is live, parser walks to it", () => {
      setActive("a@x.com");
      const sessionId = "a@x.com-b@y.com-captions";
      expect(parseUserIdFromLegacySessionId(sessionId)).toBe("a@x.com");
      expect(parsePackageNameFromLegacySessionId(sessionId)).toBe("b@y.com-captions");
    });
  });

  describe("AppManager-constructed session IDs (production format)", () => {
    // AppManager.ts:208 constructs session IDs as `${userId}-${packageName}`.
    // These tests round-trip that exact construction to prove the parser
    // correctly handles what the cloud actually writes.
    test("round-trip: AppManager-style for hyphenated-email user", () => {
      setActive("a-b@example.com");
      const userId = "a-b@example.com";
      const packageName = "some-app-name";
      const constructed = `${userId}-${packageName}`;
      expect(parseUserIdFromLegacySessionId(constructed)).toBe(userId);
      expect(parsePackageNameFromLegacySessionId(constructed)).toBe(packageName);
    });

    test("round-trip: AppManager-style for a clean email user", () => {
      setActive("alpha@example.com");
      const userId = "alpha@example.com";
      const packageName = "com.example.captions";
      const constructed = `${userId}-${packageName}`;
      expect(parseUserIdFromLegacySessionId(constructed)).toBe(userId);
      expect(parsePackageNameFromLegacySessionId(constructed)).toBe(packageName);
    });
  });

  describe("UserSession.getById is invoked correctly", () => {
    test("getById is called when parsing legacy IDs with multiple @-candidates", () => {
      setActive("a-b@example.com");
      parseUserIdFromLegacySessionId("a-b@example.com-some-app-name");
      expect(getByIdSpy?.mock.calls.length ?? 0).toBeGreaterThan(0);
    });

    test("getById is NOT called with the buggy short prefix (pre-fix wrong answer)", () => {
      setActive("a-b@example.com");
      parseUserIdFromLegacySessionId("a-b@example.com-some-app-name");
      const calls = getByIdSpy?.mock.calls ?? [];
      const calledWithJustPrefix = calls.some((args: unknown[]) => args[0] === "a");
      expect(calledWithJustPrefix).toBe(false);
    });

    test("getById is never called with empty/garbage candidates", () => {
      parseUserIdFromLegacySessionId("a-b@example.com-some-app-name");
      const calls = getByIdSpy?.mock.calls ?? [];
      // All candidates MUST contain "@" (the parser's filter)
      for (const args of calls) {
        expect((args[0] as string).includes("@")).toBe(true);
      }
    });

    test("getById is not called for inputs without @ anywhere", () => {
      parseUserIdFromLegacySessionId("no-at-sign-here");
      expect(getByIdSpy?.mock.calls.length ?? 0).toBe(0);
    });
  });
});
