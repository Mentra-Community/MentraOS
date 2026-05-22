/**
 * Deterministic Soniox bug reproduction via mock session.
 *
 * The real Soniox endpoint-mid-utterance bug is hard to provoke from TTS
 * because v4's semantic endpoint detector is robust against clean audio.
 * It DOES misfire on real speech in prod/staging (~5% of utterances).
 *
 * Rather than chase TTS audio that triggers the model, we replay the
 * exact event sequence captured from a staging trace where the bug fired.
 * This isolates the test to our handler code (SonioxSdkStream.handleResult/
 * handleEndpoint/handleFinalized) where the fix lives.
 *
 * Bug pattern captured from staging (user said "You know? Come on, I'm right."):
 *
 *   interim "Come"
 *   interim "Come on"
 *   interim "Come on,"
 *   interim "You know? Come on, I'"       ← rolling window jumped
 *   FINAL   "You know? Come on, I'"       ← endpoint fired mid-word
 *   ENDPT
 *   interim "Come on, I'm"
 *   interim "Come on, I'm right."
 *   FINAL   "Come on, I'm right."
 *   ENDPT
 *
 * Expected (after fix): one FINAL "You know? Come on, I'm right."
 *
 * Usage:
 *   bun run src/scripts/soniox-repro-mock.ts
 *
 * Exit 0 if single-FINAL behavior observed, 1 if bug still present.
 */

import { EventEmitter } from "events";
import pino from "pino";
import type { RealtimeResult, RealtimeToken } from "@soniox/node";

import { SonioxSdkStream } from "../services/session/transcription/providers/SonioxSdkStream";
import type { StreamCallbacks } from "../services/session/transcription/types";

// ---------------------------------------------------------------------------
// Mock Soniox session: an EventEmitter that records sendAudio/finalize/pause
// calls and lets us emit "result", "endpoint", "finalized" at will.
// ---------------------------------------------------------------------------

class MockSonioxSession extends EventEmitter {
  state: "idle" | "connecting" | "connected" | "closed" = "idle";
  sentAudio = 0;
  finalizeCalls = 0;
  pauseCalls = 0;
  resumeCalls = 0;

  async connect(): Promise<void> {
    this.state = "connecting";
    setImmediate(() => {
      this.state = "connected";
      this.emit("connected");
    });
  }

  sendAudio(_data: Uint8Array): void {
    this.sentAudio += _data.length;
  }

  finalize(): void {
    this.finalizeCalls++;
  }

  pause(): void {
    this.pauseCalls++;
  }

  resume(): void {
    this.resumeCalls++;
  }

  async finish(): Promise<void> {
    // no-op; emits handled separately
  }

  close(): void {
    this.state = "closed";
    this.emit("disconnected", "test");
  }

  // Helper to emit a fully-typed RealtimeResult
  emitResult(tokens: Partial<RealtimeToken>[], finalAudioProcMs = 0, totalAudioProcMs = 0): void {
    const fullTokens: RealtimeToken[] = tokens.map((t) => ({
      text: t.text ?? "",
      is_final: t.is_final ?? false,
      confidence: t.confidence ?? 0.9,
      start_ms: t.start_ms ?? 0,
      end_ms: t.end_ms ?? 100,
      speaker: t.speaker ?? "1",
      language: t.language ?? "en",
    }));
    const result: RealtimeResult = {
      tokens: fullTokens,
      final_audio_proc_ms: finalAudioProcMs,
      total_audio_proc_ms: totalAudioProcMs,
    } as any;
    this.emit("result", result);
  }
}

class MockSonioxClient {
  lastSession: MockSonioxSession | null = null;
  realtime = {
    stt: (_config: any) => {
      const session = new MockSonioxSession();
      this.lastSession = session;
      return session as any;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const logger = pino({
  level: process.env.SONIOX_REPRO_VERBOSE ? "debug" : "warn",
  transport: {
    target: "pino-pretty",
    options: { colorize: true, ignore: "pid,hostname,time", singleLine: true },
  },
});

const stubProvider: any = {
  name: "soniox",
  recordSuccess: () => {},
  recordFailure: () => {},
};

type CapturedEvent = {
  t: number;
  kind: "interim" | "FINAL";
  text: string;
  utteranceId?: string;
};

const events: CapturedEvent[] = [];
let t0 = 0;

const callbacks: StreamCallbacks = {
  onReady: () => {
    console.log(`[${(Date.now() - t0).toString().padStart(5)}ms] READY`);
  },
  onData: (data: any) => {
    const t = Date.now() - t0;
    const kind = data.isFinal ? "FINAL" : "interim";
    events.push({ t, kind, text: data.text, utteranceId: data.utteranceId });
    const tag = kind === "FINAL" ? "\x1b[33mFINAL  \x1b[0m" : "interim";
    console.log(`[${t.toString().padStart(5)}ms] ${tag} (${data.utteranceId?.slice(-6) ?? "------"}) "${data.text}"`);
  },
  onError: (err: Error) => console.error(`ERROR ${err.message}`),
  onClosed: () => {},
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Test scenarios
// ---------------------------------------------------------------------------

interface Scenario {
  name: string;
  /**
   * Drive the session through a synthetic event sequence.
   * Returns when the scenario is finished feeding events.
   */
  run: (session: MockSonioxSession) => Promise<void>;
}

const scenarios: Scenario[] = [
  {
    // Direct replay of the staging bug trace:
    //   interim "Come"
    //   interim "Come on"
    //   interim "Come on,"
    //   interim "You know? Come on, I'"   ← suddenly prefixed by "You know? "
    //   FINAL   "You know? Come on, I'"   ← endpoint fired mid-word
    //   ENDPT
    //   interim "Come on, I'm"
    //   interim "Come on, I'm right."
    //   FINAL   "Come on, I'm right."
    //   ENDPT
    name: "staging-replay: 'You know? Come on, I\\'m right.' split mid-word",
    run: async (s) => {
      // Build up "Come on," with non-final tokens
      s.emitResult([{ text: "Come", is_final: false }]);
      await sleep(20);
      s.emitResult([
        { text: "Come", is_final: false },
        { text: " on", is_final: false },
      ]);
      await sleep(20);
      s.emitResult([
        { text: "Come", is_final: false },
        { text: " on", is_final: false },
        { text: ",", is_final: false },
      ]);
      await sleep(20);

      // Now Soniox commits "You know? " as finalized tokens (it had heard this
      // earlier; the rolling window re-surfaces it). "Come on, I'" added.
      s.emitResult([
        { text: "You know?", is_final: true },
        { text: " Come", is_final: true },
        { text: " on,", is_final: true },
        { text: " I'", is_final: false },
      ]);
      await sleep(20);

      // Endpoint fires immediately — mid-word "I'"
      s.emit("endpoint");
      await sleep(50);

      // After endpoint, audio keeps flowing. New utterance begins picking up
      // the continuation. Note "Come on, I'm" duplicates "Come on, I'"
      s.emitResult([{ text: "Come", is_final: false }]);
      await sleep(20);
      s.emitResult([
        { text: "Come", is_final: false },
        { text: " on", is_final: false },
        { text: ",", is_final: false },
        { text: " I'm", is_final: false },
      ]);
      await sleep(20);
      s.emitResult([
        { text: "Come", is_final: true },
        { text: " on,", is_final: true },
        { text: " I'm", is_final: true },
        { text: " right.", is_final: false },
      ]);
      await sleep(20);
      s.emitResult([
        { text: "Come", is_final: true },
        { text: " on,", is_final: true },
        { text: " I'm", is_final: true },
        { text: " right.", is_final: true },
      ]);
      await sleep(20);
      s.emit("endpoint");
    },
  },
  {
    // Single clean utterance — should produce ONE final.
    name: "clean utterance: 'Hello, how are you?'",
    run: async (s) => {
      s.emitResult([{ text: "Hello", is_final: false }]);
      await sleep(30);
      s.emitResult([
        { text: "Hello", is_final: false },
        { text: ",", is_final: false },
        { text: " how", is_final: false },
      ]);
      await sleep(30);
      s.emitResult([
        { text: "Hello", is_final: true },
        { text: ",", is_final: true },
        { text: " how", is_final: true },
        { text: " are", is_final: false },
        { text: " you?", is_final: false },
      ]);
      await sleep(30);
      s.emitResult([
        { text: "Hello", is_final: true },
        { text: ",", is_final: true },
        { text: " how", is_final: true },
        { text: " are", is_final: true },
        { text: " you?", is_final: true },
      ]);
      await sleep(30);
      s.emit("endpoint");
    },
  },
  {
    // Real "two separate utterances" — should produce TWO finals.
    name: "two real utterances: 'Hello.' [pause] 'Goodbye.'",
    run: async (s) => {
      s.emitResult([
        { text: "Hello", is_final: true },
        { text: ".", is_final: true },
      ]);
      await sleep(30);
      s.emit("endpoint");
      // Real silence between utterances — long enough that any debounce
      // should commit the first final
      await sleep(1500);
      s.emitResult([
        { text: "Goodbye", is_final: true },
        { text: ".", is_final: true },
      ]);
      await sleep(30);
      s.emit("endpoint");
    },
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function runScenario(scenario: Scenario): Promise<{ pass: boolean; finals: CapturedEvent[] }> {
  console.log("\n" + "═".repeat(80));
  console.log(`SCENARIO: ${scenario.name}`);
  console.log("═".repeat(80));

  events.length = 0;
  t0 = Date.now();

  const client = new MockSonioxClient();
  const stream = new SonioxSdkStream(
    "mock-" + Date.now(),
    "transcription:en-US",
    stubProvider,
    "en-US",
    undefined,
    callbacks,
    logger as any,
    { model: "stt-rt-v4" } as any,
    client as any,
  );

  await stream.initialize();
  // Wait for the connected event to flow through
  await sleep(50);

  const session = client.lastSession!;
  await scenario.run(session);

  // Drain a bit so any deferred logic fires (the fix may include a debounce
  // window). 1500ms covers up to a 1s debounce comfortably.
  await sleep(1500);

  // Close: flush any pending text
  session.emit("finished");
  await sleep(100);
  await stream.close();
  await sleep(100);

  const finals = events.filter((e) => e.kind === "FINAL");
  return { pass: true, finals };
}

interface Expectation {
  name: string;
  expectedFinalCount: number;
  expectedFinalText?: string; // optional: substring match
}

const expectations: Expectation[] = [
  {
    name: scenarios[0].name,
    expectedFinalCount: 1,
    expectedFinalText: "right",
  },
  {
    name: scenarios[1].name,
    expectedFinalCount: 1,
    expectedFinalText: "Hello",
  },
  {
    name: scenarios[2].name,
    expectedFinalCount: 2,
  },
];

async function main() {
  let allPass = true;
  for (let i = 0; i < scenarios.length; i++) {
    const result = await runScenario(scenarios[i]);
    const expected = expectations[i];

    console.log(`\nFinals (${result.finals.length}):`);
    result.finals.forEach((f, j) => console.log(`  ${j + 1}. "${f.text}"`));

    let pass = result.finals.length === expected.expectedFinalCount;
    if (pass && expected.expectedFinalText) {
      pass = result.finals.some((f) => f.text.includes(expected.expectedFinalText!));
    }

    if (pass) {
      console.log(`\n\x1b[32m✓ PASS\x1b[0m: expected ${expected.expectedFinalCount} FINAL(s)`);
    } else {
      allPass = false;
      console.log(
        `\n\x1b[31m✗ FAIL\x1b[0m: expected ${expected.expectedFinalCount} FINAL(s)${expected.expectedFinalText ? ` containing "${expected.expectedFinalText}"` : ""}, got ${result.finals.length}`,
      );
    }
  }

  console.log("\n" + "═".repeat(80));
  console.log(allPass ? "\x1b[32mAll scenarios passed.\x1b[0m" : "\x1b[31mFailures detected.\x1b[0m");
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(2);
});
