/**
 * @fileoverview Tests for SonioxProvider's utterance lifecycle.
 *
 * Focus: the transcript pile-up bug. Soniox delivers a ROLLING WINDOW that it
 * RE-DIARIZES across results, so a token's `speaker` label can flip between
 * rounds within ONE real utterance. The provider must NOT finalize / mint a new
 * utteranceId on that per-token flicker — it must emit interims under a single
 * stable utteranceId and commit exactly one FINAL on the Soniox `endpoint`
 * boundary (or on close()).
 *
 * We inject a fake Soniox client/session so we can drive `result` / `endpoint`
 * events deterministically without a network or API key.
 */
import { describe, test, expect } from "bun:test";

// Shrink the self-heal backoff so reconnect tests run in milliseconds. Read
// per-provider inside createSonioxProvider, so setting it here (before any
// provider is constructed) is sufficient.
process.env.SONIOX_RECONNECT_BASE_MS = "1";
process.env.SONIOX_RECONNECT_MAX_MS = "4";
process.env.SONIOX_RECONNECT_MAX_ATTEMPTS = "5";
process.env.SONIOX_ENDPOINT_DEBOUNCE_MS = "1";

import { createSonioxProvider, sonioxLanguageHints, sonioxTranslationTarget } from "./soniox";
import type { TranscriptEvent } from "./provider";

// Minimal shape of a Soniox realtime token we care about in these tests.
type FakeToken = {
  text: string;
  confidence: number;
  is_final: boolean;
  speaker?: string;
  language?: string;
  start_ms?: number;
  end_ms?: number;
  /** Set on translation-session tokens; absent for same-language passthrough. */
  translation_status?: "original" | "translation";
};

/**
 * A fake `RealtimeSttSession` that records event handlers so the test can
 * synthesize Soniox `result` / `endpoint` events. Stands in for the real
 * `@soniox/node` session, which is otherwise a live WebSocket.
 */
class FakeSession {
  private handlers = new Map<string, Array<(arg?: unknown) => void>>();

  on(event: string, handler: (arg?: unknown) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  off(event: string, handler: (arg?: unknown) => void): this {
    const list = this.handlers.get(event);
    if (list) this.handlers.set(event, list.filter((h) => h !== handler));
    return this;
  }

  emit(event: string, arg?: unknown): void {
    for (const h of this.handlers.get(event) ?? []) h(arg);
  }

  // Lifecycle methods the provider calls. Instrumented so self-heal tests can
  // assert connect/sendAudio/close behavior and inject a connect failure.
  connectCount = 0;
  sendAudioCount = 0;
  closeCount = 0;
  pauseCount = 0;
  resumeCount = 0;
  /** When > 0, the next N connect() calls reject (simulate a flaky reconnect). */
  failNextConnects = 0;

  async connect(): Promise<void> {
    this.connectCount += 1;
    if (this.failNextConnects > 0) {
      this.failNextConnects -= 1;
      throw new Error("fake connect failure");
    }
  }
  sendAudio(): void {
    this.sendAudioCount += 1;
  }
  pause(): void {
    this.pauseCount += 1;
    this.emit("finalized");
  }
  resume(): void {
    this.resumeCount += 1;
  }
  async finish(): Promise<void> {}
  async close(): Promise<void> {
    this.closeCount += 1;
  }

  /** Simulate an unexpected upstream drop (not triggered by our close()). */
  disconnect(reason = "upstream closed"): void {
    this.emit("disconnected", reason);
  }

  /** Convenience: push a Soniox result with the given rolling token window. */
  result(tokens: FakeToken[]): void {
    this.emit("result", { tokens });
  }

  /** Convenience: fire the endpoint (real utterance boundary). */
  endpoint(): void {
    this.emit("endpoint");
  }
}

/** Build a fake SonioxNodeClient whose `realtime.stt()` returns our session. */
function fakeClient(session: FakeSession): any {
  return {
    realtime: {
      stt: () => session,
    },
  };
}

/**
 * A fake client that hands out a NEW session per `realtime.stt()` call, in
 * order. Mirrors the real client, which mints a fresh session each call — the
 * self-heal path builds a replacement session, so the test needs more than one.
 * Records every session it produced so the test can drive/inspect them.
 */
function multiSessionClient(): { client: any; sessions: FakeSession[] } {
  const sessions: FakeSession[] = [];
  const client = {
    realtime: {
      stt: () => {
        const s = new FakeSession();
        sessions.push(s);
        return s;
      },
    },
  };
  return { client, sessions };
}

/** Resolve after `ms` of real time (kept small so tests stay fast). */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withFastGapConfig<T>(fn: () => Promise<T>): Promise<T> {
  const prevCheck = process.env.SONIOX_GAP_CHECK_INTERVAL_MS;
  const prevThreshold = process.env.SONIOX_AUDIO_GAP_THRESHOLD_MS;
  process.env.SONIOX_GAP_CHECK_INTERVAL_MS = "5";
  process.env.SONIOX_AUDIO_GAP_THRESHOLD_MS = "20";
  try {
    return await fn();
  } finally {
    if (prevCheck == null) {
      delete process.env.SONIOX_GAP_CHECK_INTERVAL_MS;
    } else {
      process.env.SONIOX_GAP_CHECK_INTERVAL_MS = prevCheck;
    }
    if (prevThreshold == null) {
      delete process.env.SONIOX_AUDIO_GAP_THRESHOLD_MS;
    } else {
      process.env.SONIOX_AUDIO_GAP_THRESHOLD_MS = prevThreshold;
    }
  }
}

async function makeProvider(): Promise<{
  session: FakeSession;
  events: TranscriptEvent[];
  provider: Awaited<ReturnType<typeof createSonioxProvider>>;
}> {
  const session = new FakeSession();
  const events: TranscriptEvent[] = [];
  const provider = await createSonioxProvider({
    scope: "user_test",
    language: "auto",
    client: fakeClient(session) as never,
    onTranscript: (e) => events.push(e),
  });
  return { session, events, provider };
}

async function makeTranslationProvider(target: string): Promise<{
  session: FakeSession;
  events: TranscriptEvent[];
  provider: Awaited<ReturnType<typeof createSonioxProvider>>;
}> {
  const session = new FakeSession();
  const events: TranscriptEvent[] = [];
  const provider = await createSonioxProvider({
    scope: "user_xlate_test",
    language: "auto",
    targetLanguage: target,
    client: fakeClient(session) as never,
    onTranscript: (e) => events.push(e),
  });
  return { session, events, provider };
}

describe("SonioxProvider translation same-language passthrough", () => {
  test("untagged tokens (spoken language == target) emit as transcription text with their source language", async () => {
    const { session, events, provider } = await makeTranslationProvider("es-ES");

    // Soniox emits NO translation_status when there is nothing to translate
    // (verified live: EN speech -> target en). Simulate Spanish speech with a
    // Spanish target: plain untagged tokens.
    session.result([
      { text: "Hola ", confidence: 0.9, is_final: false, language: "es" },
      { text: "mundo", confidence: 0.9, is_final: false, language: "es" },
    ]);
    session.endpoint();
    await wait(5);

    const finals = events.filter((e) => e.isFinal);
    expect(finals.length).toBe(1);
    expect(finals[0]!.text).toBe("Hola mundo");
    expect(finals[0]!.sourceLanguage).toBe("es");
    expect(finals[0]!.originalText).toBeUndefined();

    await provider.close();
  });

  test("cross-language windows still emit only the translation half with originalText", async () => {
    const { session, events, provider } = await makeTranslationProvider("es-ES");

    session.result([
      { text: "Hello ", confidence: 0.9, is_final: false, language: "en", translation_status: "original" },
      { text: "world", confidence: 0.9, is_final: false, language: "en", translation_status: "original" },
      { text: "Hola ", confidence: 0.9, is_final: false, language: "es", translation_status: "translation" },
      { text: "mundo", confidence: 0.9, is_final: false, language: "es", translation_status: "translation" },
    ]);
    session.endpoint();
    await wait(5);

    const finals = events.filter((e) => e.isFinal);
    expect(finals.length).toBe(1);
    expect(finals[0]!.text).toBe("Hola mundo");
    expect(finals[0]!.originalText).toBe("Hello world");
    expect(finals[0]!.sourceLanguage).toBe("en");

    await provider.close();
  });
});

describe("sonioxLanguageHints", () => {
  test("a specific language becomes its own bare-code hint (region stripped)", () => {
    expect(sonioxLanguageHints("fr-FR", undefined)).toEqual(["fr"]);
    expect(sonioxLanguageHints("en-US", ["ja"])).toEqual(["en"]); // specific wins; hints ignored
    expect(sonioxLanguageHints("ZH-hans", undefined)).toEqual(["zh"]);
  });

  test("auto with no hints yields undefined (never a BCP-47 tag)", () => {
    expect(sonioxLanguageHints("auto", undefined)).toBeUndefined();
    expect(sonioxLanguageHints("auto", [])).toBeUndefined();
    expect(sonioxLanguageHints(undefined, undefined)).toBeUndefined();
  });

  test("auto passes detection hints, reduced to bare codes and deduped", () => {
    expect(sonioxLanguageHints("auto", ["en", "ja"])).toEqual(["en", "ja"]);
    expect(sonioxLanguageHints("auto", ["en-US", "en-GB"])).toEqual(["en"]);
    expect(sonioxLanguageHints("auto", ["fr-FR", "ja"])).toEqual(["fr", "ja"]);
  });
});

describe("sonioxTranslationTarget", () => {
  test("strips the region to a bare code (Soniox rejects BCP-47 targets)", () => {
    expect(sonioxTranslationTarget("es-ES")).toBe("es");
    expect(sonioxTranslationTarget("zh-CN")).toBe("zh");
    expect(sonioxTranslationTarget("en")).toBe("en");
    expect(sonioxTranslationTarget("PT-BR")).toBe("pt");
  });
});

describe("SonioxProvider session configuration", () => {
  test("configures one-way translation with a bare target_language", async () => {
    const session = new FakeSession();
    let sessionConfig: Record<string, unknown> | undefined;
    const client = {
      realtime: {
        stt: (config: Record<string, unknown>) => {
          sessionConfig = config;
          return session;
        },
      },
    };

    const provider = await createSonioxProvider({
      scope: "user_xlate",
      language: "auto",
      targetLanguage: "es-ES",
      client: client as never,
      onTranscript: () => {},
    });

    expect(sessionConfig).toMatchObject({
      translation: { type: "one_way", target_language: "es" },
    });

    await provider.close();
  });

  test("passes auto-mode detection hints to Soniox language_hints", async () => {
    const session = new FakeSession();
    let sessionConfig: Record<string, unknown> | undefined;
    const client = {
      realtime: {
        stt: (config: Record<string, unknown>) => {
          sessionConfig = config;
          return session;
        },
      },
    };

    const provider = await createSonioxProvider({
      scope: "user_hints",
      language: "auto",
      languageHints: ["ja", "en-US"],
      client: client as never,
      onTranscript: () => {},
    });

    expect(sessionConfig).toMatchObject({
      enable_language_identification: true,
      language_hints: ["ja", "en"],
    });

    await provider.close();
  });

  test("sends the Mentra activation phrase as recognition context", async () => {
    const session = new FakeSession();
    let sessionConfig: Record<string, unknown> | undefined;
    const client = {
      realtime: {
        stt: (config: Record<string, unknown>) => {
          sessionConfig = config;
          return session;
        },
      },
    };

    const provider = await createSonioxProvider({
      scope: "user_test",
      language: "auto",
      client: client as never,
      onTranscript: () => {},
    });

    expect(sessionConfig).toMatchObject({
      context: {
        terms: ["Mentra", "Hey Mentra"],
        text: "Mentra, Hey Mentra (an AI assistant)",
      },
    });

    await provider.close();
  });
});

describe("SonioxProvider utterance lifecycle", () => {
  test("does not churn finals/utteranceIds when the rolling window's speaker flips mid-utterance", async () => {
    const { session, events, provider } = await makeProvider();

    // Round 1: rolling window where the (single, non-final) token is speaker "1".
    session.result([
      { text: "Okay ", confidence: 0.9, is_final: false, speaker: "1" },
    ]);

    // Round 2: SAME logical utterance, but Soniox re-diarized the window — the
    // first token now reads speaker "2", and more text has streamed in. Under
    // the old per-token speaker-compare this would emitFinal + mint a new id.
    session.result([
      { text: "Okay ", confidence: 0.9, is_final: false, speaker: "2" },
      { text: "um I should ", confidence: 0.9, is_final: false, speaker: "2" },
    ]);

    // Round 3: window keeps growing, speaker flips back to "1" — still one
    // logical utterance, no endpoint yet.
    session.result([
      { text: "Okay um I should ", confidence: 0.9, is_final: false, speaker: "1" },
      { text: "buy my ticket", confidence: 0.9, is_final: false, speaker: "1" },
    ]);

    // Before the endpoint: every event so far must be an interim, all sharing
    // ONE utteranceId. No finals, no new ids — i.e. no pile-up.
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.isFinal === false)).toBe(true);
    const interimIds = new Set(events.map((e) => e.utteranceId));
    expect(interimIds.size).toBe(1);
    const utteranceId = events[0]!.utteranceId;
    expect(utteranceId).toBeDefined();

    // The interim text grows in place (cumulative) under the same card.
    expect(events.at(-1)!.text).toBe("Okay um I should buy my ticket");

    // Now the real utterance boundary fires: exactly ONE final, same id.
    session.endpoint();
    await wait(5);

    const finals = events.filter((e) => e.isFinal);
    expect(finals.length).toBe(1);
    expect(finals[0]!.utteranceId).toBe(utteranceId);
    expect(finals[0]!.text).toBe("Okay um I should buy my ticket");

    await provider.close();
  });

  test("emits one final per endpoint-bounded utterance and starts a fresh id after", async () => {
    const { session, events, provider } = await makeProvider();

    // Utterance A.
    session.result([
      { text: "first utterance", confidence: 0.9, is_final: false, speaker: "1" },
    ]);
    session.endpoint();

    // Utterance B (after a commit, a fresh id is minted lazily on next token).
    session.result([
      { text: "second utterance", confidence: 0.9, is_final: false, speaker: "1" },
    ]);
    session.endpoint();
    await wait(5);

    const finals = events.filter((e) => e.isFinal);
    expect(finals.length).toBe(2);
    expect(finals[0]!.text).toBe("first utterance");
    expect(finals[1]!.text).toBe("second utterance");
    // Distinct utterances → distinct ids.
    expect(finals[0]!.utteranceId).not.toBe(finals[1]!.utteranceId);

    await provider.close();
  });

  test("merges a repeated rolling window after endpoint instead of emitting a duplicate utterance", async () => {
    const { session, events, provider } = await makeProvider();

    session.result([
      { text: "Can you hear me?", confidence: 0.9, is_final: false, speaker: "1" },
    ]);
    const utteranceId = events.at(-1)!.utteranceId;

    // Soniox can fire an endpoint, then keep the previous words in the next
    // rolling window. This is the exact shape that produced a duplicate local
    // captions card in E2E testing.
    session.endpoint();
    session.result([
      { text: " Can", confidence: 0.9, is_final: false, speaker: "1" },
    ]);
    session.result([
      {
        text: " Can you hear me? What did you do?",
        confidence: 0.9,
        is_final: false,
        speaker: "1",
      },
    ]);
    session.endpoint();
    await wait(5);

    const finals = events.filter((e) => e.isFinal);
    expect(finals.length).toBe(1);
    expect(finals[0]!.utteranceId).toBe(utteranceId);
    expect(finals[0]!.text).toBe("Can you hear me? What did you do?");

    const ids = new Set(events.map((e) => e.utteranceId));
    expect(ids.size).toBe(1);

    await provider.close();
  });

  test("keeps fuller interim when Soniox later emits a shorter finalized window", async () => {
    const { session, events, provider } = await makeProvider();

    const fullText =
      "Two app fan out test, local captions and local merge should both receive this final transcript.";
    const regressedText =
      "Two app fan out test, local cap both receive this final transcript.";

    session.result([
      { text: fullText, confidence: 0.9, is_final: false, speaker: "1" },
    ]);
    session.result([
      { text: regressedText, confidence: 0.9, is_final: true, speaker: "1" },
    ]);
    session.endpoint();
    await wait(5);

    expect(events.some((e) => e.text === regressedText)).toBe(false);
    expect(events.at(-1)).toMatchObject({
      text: fullText,
      isFinal: true,
    });

    await provider.close();
  });

  test("does not reuse the first utterance id across provider instances with the same scope", async () => {
    const sessionA = new FakeSession();
    const eventsA: TranscriptEvent[] = [];
    const providerA = await createSonioxProvider({
      scope: "user_test",
      language: "auto",
      client: fakeClient(sessionA) as never,
      onTranscript: (e) => eventsA.push(e),
    });

    const sessionB = new FakeSession();
    const eventsB: TranscriptEvent[] = [];
    const providerB = await createSonioxProvider({
      scope: "user_test",
      language: "auto",
      client: fakeClient(sessionB) as never,
      onTranscript: (e) => eventsB.push(e),
    });

    sessionA.result([
      { text: "first provider", confidence: 0.9, is_final: false, speaker: "1" },
    ]);
    sessionB.result([
      { text: "second provider", confidence: 0.9, is_final: false, speaker: "1" },
    ]);

    expect(eventsA[0]!.utteranceId).toBeDefined();
    expect(eventsB[0]!.utteranceId).toBeDefined();
    expect(eventsA[0]!.utteranceId).not.toBe(eventsB[0]!.utteranceId);

    await providerA.close();
    await providerB.close();
  });

  test("close() flushes an in-flight utterance as a single final", async () => {
    const { session, events, provider } = await makeProvider();

    session.result([
      { text: "dangling text", confidence: 0.9, is_final: false, speaker: "3" },
    ]);

    // No endpoint — detach mid-utterance. close() should commit it once.
    await provider.close();

    const finals = events.filter((e) => e.isFinal);
    expect(finals.length).toBe(1);
    expect(finals[0]!.text).toBe("dangling text");
  });
});

describe("SonioxProvider audio-gap pause/resume", () => {
  test("auto-pauses after an idle audio gap and commits buffered interim text", async () => {
    await withFastGapConfig(async () => {
      const { session, events, provider } = await makeProvider();

      session.result([
        { text: "pending words", confidence: 0.9, is_final: false, speaker: "1" },
      ]);
      const utteranceId = events.at(-1)!.utteranceId;

      await wait(50);

      expect(session.pauseCount).toBe(1);
      const finals = events.filter((e) => e.isFinal);
      expect(finals.length).toBe(1);
      expect(finals[0]!.text).toBe("pending words");
      expect(finals[0]!.utteranceId).toBe(utteranceId);

      await provider.close();
    });
  });

  test("resumes before sending the first audio chunk after an idle pause", async () => {
    await withFastGapConfig(async () => {
      const { session, provider } = await makeProvider();

      await wait(50);
      expect(session.pauseCount).toBe(1);

      provider.writeAudio(new Int16Array([1, 2, 3, 4]));

      expect(session.resumeCount).toBe(1);
      expect(session.sendAudioCount).toBe(1);

      await provider.close();
    });
  });

  test("does not auto-pause repeatedly while already paused", async () => {
    await withFastGapConfig(async () => {
      const { session, provider } = await makeProvider();

      await wait(80);

      expect(session.pauseCount).toBe(1);

      await provider.close();
    });
  });
});

/**
 * Self-heal: the "captions freeze after a hostile network drop" wedge.
 *
 * The underlying Soniox session can die WITHOUT our close() (network blip,
 * Soniox idle timeout). The provider object stays in the worker's per-user
 * provider map, keyed by subscription identity, and the worker's reconcile is
 * idempotent by that key — so it never recreates the provider. Without
 * self-heal, audio keeps flowing into the dead session and transcripts stop
 * until a full app restart forces a real detach. These tests assert the
 * provider reconnects its own session in place and resumes emitting.
 */
describe("SonioxProvider self-heal reconnect", () => {
  test("resumes transcripts after an unexpected upstream disconnect", async () => {
    const { client, sessions } = multiSessionClient();
    const events: TranscriptEvent[] = [];
    const provider = await createSonioxProvider({
      scope: "user_heal",
      language: "auto",
      client: client as never,
      onTranscript: (e) => events.push(e),
    });

    const first = sessions[0]!;
    // Transcripts flow on the original session.
    first.result([{ text: "hello", confidence: 0.9, is_final: false, speaker: "1" }]);
    expect(events.at(-1)!.text).toBe("hello");

    // The upstream session dies unexpectedly (the hostile-drop wedge).
    first.disconnect();

    // The provider should build + connect a replacement session.
    await wait(50);
    expect(sessions.length).toBe(2);
    const second = sessions[1]!;
    expect(second.connectCount).toBe(1);

    // Audio that arrives after the heal must reach the NEW session, and its
    // transcripts must reach the consumer — captions resume, no restart needed.
    provider.writeAudio(new Int16Array([1, 2, 3, 4]));
    expect(second.sendAudioCount).toBe(1);
    second.result([{ text: "world", confidence: 0.9, is_final: false, speaker: "1" }]);
    expect(events.at(-1)!.text).toBe("world");

    await provider.close();
  });

  test("retries with backoff when a reconnect attempt fails, then succeeds", async () => {
    // Mint sessions where the FIRST replacement's connect() rejects once, so the
    // self-heal loop must back off and try again before it gets a live session.
    const sessions: FakeSession[] = [];
    let nextFailCount = 0;
    const client = {
      realtime: {
        stt: () => {
          const s = new FakeSession();
          s.failNextConnects = nextFailCount;
          nextFailCount = 0;
          sessions.push(s);
          return s;
        },
      },
    };
    const errors: Error[] = [];
    const provider = await createSonioxProvider({
      scope: "user_retry",
      language: "auto",
      client: client as never,
      onTranscript: () => {},
      onError: (e) => errors.push(e),
    });

    const first = sessions[0]!;
    // Arm the next-built session to fail its first connect, then drop the live
    // one. Heal builds replacement #1 (connect rejects) → backs off → builds
    // replacement #2 (connect ok).
    nextFailCount = 1;
    first.disconnect();

    await wait(80);

    // At least two replacements were built (the failed one + the live one), and
    // self-heal did NOT give up (no error surfaced).
    expect(sessions.length).toBeGreaterThanOrEqual(3);
    expect(errors.length).toBe(0);

    // The final session is live and takes audio.
    const last = sessions.at(-1)!;
    provider.writeAudio(new Int16Array([1, 2]));
    expect(last.sendAudioCount).toBe(1);

    await provider.close();
  });

  test("does NOT reconnect on an expected close()", async () => {
    const { client, sessions } = multiSessionClient();
    const provider = await createSonioxProvider({
      scope: "user_close",
      language: "auto",
      client: client as never,
      onTranscript: () => {},
    });

    // close() finishes the session, which fires a `disconnected` on the real
    // SDK. That expected disconnect must NOT spin up a replacement session.
    await provider.close();
    sessions[0]!.disconnect(); // late teardown event, post-close
    await wait(30);

    expect(sessions.length).toBe(1);
  });

  test("drops audio frames while a reconnect is in flight", async () => {
    const { client, sessions } = multiSessionClient();
    const provider = await createSonioxProvider({
      scope: "user_gap",
      language: "auto",
      client: client as never,
      onTranscript: () => {},
      // Slow the heal so we can observe the in-flight window.
      onError: () => {},
    });

    const first = sessions[0]!;
    first.disconnect();
    // Immediately after the drop, before the replacement connects, frames are
    // dropped (no live session to take them) — no throw, no send on the dead one.
    const beforeSends = first.sendAudioCount;
    provider.writeAudio(new Int16Array([9, 9]));
    expect(first.sendAudioCount).toBe(beforeSends);

    await wait(50);
    await provider.close();
  });
});
