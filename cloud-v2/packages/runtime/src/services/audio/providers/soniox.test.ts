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

import { createSonioxProvider } from "./soniox";
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

  // Lifecycle methods the provider calls. All no-ops for the test.
  async connect(): Promise<void> {}
  sendAudio(): void {}
  async finish(): Promise<void> {}
  async close(): Promise<void> {}

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

    const finals = events.filter((e) => e.isFinal);
    expect(finals.length).toBe(2);
    expect(finals[0]!.text).toBe("first utterance");
    expect(finals[1]!.text).toBe("second utterance");
    // Distinct utterances → distinct ids.
    expect(finals[0]!.utteranceId).not.toBe(finals[1]!.utteranceId);

    await provider.close();
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
