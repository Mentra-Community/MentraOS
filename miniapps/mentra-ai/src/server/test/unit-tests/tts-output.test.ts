/**
 * Test: Text-to-Speech (TTS) output
 *
 * Investigates why TTS may not speak responses aloud.
 *
 * The hypothesis: QueryProcessor decides whether to speak with
 * `hasSpeakers = !hasDisplay` (QueryProcessor.ts:43). On glasses that
 * have BOTH a display AND speakers (e.g. Simulated Glasses, which the
 * server logs report as `hasDisplay: true | hasSpeaker: true`), this
 * makes `hasSpeakers = false`, so `session.audio.speak()` is never
 * called — the response is shown on the display but never spoken.
 *
 * These tests use a fake AppSession so no real glasses are needed.
 *
 * Run: bun test ./src/server/test/unit-tests/tts-output.test.ts
 */

import { describe, test, expect, mock } from "bun:test";
import { User } from "../../session/User";

/**
 * Build a fake AppSession with controllable capabilities.
 * Records every call to audio.speak / audio.playAudio / layouts.showTextWall
 * so the test can assert what the pipeline actually did.
 */
function makeFakeSession(capabilities: {
  hasDisplay: boolean;
  hasCamera: boolean;
  hasSpeaker: boolean;
}) {
  const calls = {
    speak: [] as string[],
    playAudio: [] as unknown[],
    showTextWall: [] as string[],
  };

  const session = {
    capabilities: {
      modelName: "Test Glasses",
      hasDisplay: capabilities.hasDisplay,
      hasCamera: capabilities.hasCamera,
      hasSpeaker: capabilities.hasSpeaker,
    },
    audio: {
      speak: mock(async (text: string) => {
        calls.speak.push(text);
        return { success: true };
      }),
      playAudio: mock(async (opts: unknown) => {
        calls.playAudio.push(opts);
        return { success: true };
      }),
      stopAudio: mock(async () => {}),
    },
    layouts: {
      showTextWall: mock((text: string) => {
        calls.showTextWall.push(text);
      }),
    },
    location: {
      getLatestLocation: mock(async () => null),
    },
    camera: {
      requestPhoto: mock(async () => {
        throw new Error("no camera in test");
      }),
    },
  };

  return { session, calls };
}

/**
 * Build a User wired to a fake session, with the AI agent stubbed out
 * so the test runs offline and deterministically.
 */
function makeUser(capabilities: {
  hasDisplay: boolean;
  hasCamera: boolean;
  hasSpeaker: boolean;
}) {
  const user = new User("tts-test@mentra.glass");
  const { session, calls } = makeFakeSession(capabilities);
  // @ts-expect-error — assigning a fake session shaped like AppSession
  user.appSession = session;

  // Stub the agent so no real LLM call happens.
  user.chatHistory.addTurn = mock(async () => {}) as typeof user.chatHistory.addTurn;
  user.chatHistory.getRecentTurns = mock(() => []) as typeof user.chatHistory.getRecentTurns;
  user.location.queryNeedsLocation = mock(() => false) as typeof user.location.queryNeedsLocation;
  user.location.getCachedContext = mock(() => null) as typeof user.location.getCachedContext;
  user.location.getTimezone = mock(() => "America/Los_Angeles") as typeof user.location.getTimezone;
  user.notifications.formatForPrompt = mock(() => "No recent notifications.") as typeof user.notifications.formatForPrompt;

  return { user, calls };
}

describe("TTS output — does the pipeline speak the response?", () => {
  test("camera glasses (hasDisplay=false): response IS spoken", async () => {
    const { user, calls } = makeUser({
      hasDisplay: false,
      hasCamera: true,
      hasSpeaker: true,
    });

    await user.queryProcessor.processQuery("what time is it?");

    expect(calls.speak.length).toBeGreaterThan(0);
  });

  test("display+speaker glasses (hasDisplay=true, hasSpeaker=true): response is NOT spoken — THE BUG", async () => {
    const { user, calls } = makeUser({
      hasDisplay: true,
      hasCamera: false,
      hasSpeaker: true, // glasses DO have a speaker...
    });

    await user.queryProcessor.processQuery("what time is it?");

    // The glasses physically have a speaker, so we WANT this to be > 0.
    // It currently is 0 because QueryProcessor uses `hasSpeakers = !hasDisplay`.
    // This assertion documents the bug — flip it to .toBeGreaterThan(0)
    // once QueryProcessor reads `capabilities.hasSpeaker` directly.
    expect(calls.speak.length).toBe(0);
  });

  test("display+speaker glasses: response IS shown on the display", async () => {
    const { user, calls } = makeUser({
      hasDisplay: true,
      hasCamera: false,
      hasSpeaker: true,
    });

    await user.queryProcessor.processQuery("what time is it?");

    expect(calls.showTextWall.length).toBeGreaterThan(0);
  });
});
