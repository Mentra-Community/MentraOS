/**
 * @fileoverview End-to-end reconnect test for `Runtime` transcript delivery.
 *
 * Reproduces the "captions freeze after a hostile network drop" investigation
 * at the SDK seam: a consumer registers `onTranscript` ONCE (as the island
 * runtime's `ensureCloudResultsWired` does), the socket then drops, several
 * reconnect attempts FAIL, and finally one succeeds. The test asserts that the
 * originally-registered `onTranscript` STILL fires on the recovered session —
 * i.e. the handler is not silently dropped when the socket churns — and that the
 * recovery `connection.init` carried the live subscription set (so the cloud
 * seeds the new session non-empty and actually transcribes).
 *
 * This guards the client contract end-to-end. The actual on-device wedge was
 * server-side (a dead Soniox provider never recreated on a same-pod reconnect —
 * see runtime/.../providers/soniox.ts self-heal), but the SDK's handler survival
 * + init-carries-subscriptions is the load-bearing client invariant and must not
 * regress.
 */
import { describe, test, expect } from "bun:test";

import { Runtime } from "./runtime";
import { Connection, type ConnectionDeps } from "./connection";
import { RuntimeEmitter } from "./emitter";
import { Subscriptions } from "./subscriptions";
import { Camera } from "./camera";
import { UdpAudio } from "./audio-udp";
import type { WebSocketLike, UdpSocketLike } from "../../transports";
import type { HttpClient } from "../../http";
import { noopLogger } from "../../logger";
import {
  PROTOCOL_MAJOR,
  type ConnectionInit,
  type ConnectionAck,
  type AudioSubscription,
} from "@mentra/cloud-runtime/protocol";

/** A scriptable WebSocket the test drives by hand (peer = the test). */
class FakeSocket implements WebSocketLike {
  sent: string[] = [];
  openCb: (() => void) | null = null;
  messageCb: ((data: string) => void) | null = null;
  closeCb: ((info: { code: number; reason: string }) => void) | null = null;
  errorCb: ((err: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
  onOpen(cb: () => void): void {
    this.openCb = cb;
  }
  onMessage(cb: (data: string) => void): void {
    this.messageCb = cb;
  }
  onClose(cb: (info: { code: number; reason: string }) => void): void {
    this.closeCb = cb;
  }
  onError(cb: (err: unknown) => void): void {
    this.errorCb = cb;
  }

  /** Drive a full successful handshake: open, receive init, send ack back. */
  handshake(ack: ConnectionAck): void {
    this.openCb?.();
    this.messageCb?.(
      JSON.stringify({
        v: PROTOCOL_MAJOR,
        type: "connection.ack",
        timestamp: Date.now(),
        payload: ack,
      }),
    );
  }

  /** Push a (schema-valid) transcript frame down to the client. */
  pushTranscript(text: string, language = "en"): void {
    this.messageCb?.(
      JSON.stringify({
        v: PROTOCOL_MAJOR,
        type: "stream.transcript",
        timestamp: Date.now(),
        payload: {
          userId: "user-1",
          subscription: { kind: "transcription", language: { mode: "auto" } },
          text,
          isFinal: true,
          startMs: 0,
          endMs: 1000,
          resolvedLanguage: language,
          languageDetected: false,
          tokens: [],
          provider: "test",
          timestamp: Date.now(),
        },
      }),
    );
  }

  /** The decoded `connection.init` this socket received (the last init sent). */
  readInit(): ConnectionInit {
    const raw = this.sent.find((s) => s.includes("connection.init"));
    if (!raw) throw new Error("no connection.init sent on this socket");
    return JSON.parse(raw).payload as ConnectionInit;
  }
}

const ACK: ConnectionAck = { sessionId: "sess-1", negotiatedVersion: "2.0.0" };
const FAST_RECONNECT = { baseMs: 3, maxMs: 10, jitter: false };

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `cond()` is true or `timeoutMs` elapses (robust to backoff jitter). */
async function waitUntil(cond: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) {
    await wait(2);
  }
}

/** A no-op HttpClient — subscription writes resolve without a real server. */
function fakeHttp(): HttpClient {
  return {
    get: async () => undefined as never,
    post: async () => undefined as never,
    put: async () => undefined as never,
    delete: async () => undefined as never,
  };
}

function fakeUdp(): UdpSocketLike {
  return {
    send: () => {},
    onMessage: () => {},
    close: () => {},
  };
}

describe("Runtime transcript delivery survives a multi-attempt reconnect", () => {
  test("onTranscript registered once still fires after drop → N failed retries → reconnect", async () => {
    // Socket #1 = initial session. #2, #3 = failed reconnect attempts. #4 = the
    // eventual successful reconnect.
    const sockets = [new FakeSocket(), new FakeSocket(), new FakeSocket(), new FakeSocket()];
    let created = 0;
    const ws = (_url: string): WebSocketLike => {
      const s = sockets[created] ?? new FakeSocket();
      created += 1;
      return s;
    };

    const emitter = new RuntimeEmitter();
    const subscriptions = new Subscriptions({ http: fakeHttp() });
    const connDeps: ConnectionDeps = {
      ws,
      url: "wss://example.test/ws",
      getToken: async () => "tok",
      initPayload: () => ({
        protocolVersion: "2.0.0",
        audio: {
          codec: "lc3",
          sampleRate: 16000,
          initialSubscriptions: subscriptions.currentSet(),
        },
      }),
      reconnect: FAST_RECONNECT,
      logger: noopLogger,
    };
    const connection = new Connection(connDeps);
    const runtime = new Runtime({
      connection,
      emitter,
      subscriptions,
      camera: new Camera({ http: fakeHttp() }),
      audio: new UdpAudio({ udp: fakeUdp }),
      logger: noopLogger,
      forceRefreshToken: async () => "tok",
    });

    // Register the transcript consumer ONCE, the way the island runtime does.
    const received: string[] = [];
    runtime.onTranscript((d) => received.push(d.text));

    // Connect the initial session.
    const connectPromise = runtime.connect();
    await wait(5);
    sockets[0]!.handshake(ACK);
    await connectPromise;

    // Apply a live subscription set (so the reconnect init carries it).
    const subs: AudioSubscription[] = [{ kind: "transcription", language: { mode: "auto" } }];
    await runtime.setSubscriptions(subs);

    // Transcripts flow on the original session.
    sockets[0]!.pushTranscript("before drop");
    expect(received).toEqual(["before drop"]);

    // HOSTILE DROP: the socket closes; the reconnect loop kicks in.
    sockets[0]!.closeCb?.({ code: 1006, reason: "network lost" });

    // Two reconnect attempts FAIL (each opens then immediately closes without an
    // ack), simulating the cloud being briefly unreachable. Poll for each
    // attempt's socket so backoff timing can't make the test flaky.
    await waitUntil(() => created >= 2);
    expect(created).toBeGreaterThanOrEqual(2);
    sockets[1]!.closeCb?.({ code: 1006, reason: "still down" });

    await waitUntil(() => created >= 3);
    sockets[2]!.closeCb?.({ code: 1006, reason: "still down" });

    // The next attempt SUCCEEDS.
    await waitUntil(() => created >= 4);
    expect(created).toBeGreaterThanOrEqual(4);
    const recoverySocket = sockets[3]!;
    recoverySocket.handshake({ sessionId: "sess-2", negotiatedVersion: "2.0.0" });
    await wait(5);

    // The recovery handshake must have carried the LIVE subscription set, so the
    // cloud seeds the new session non-empty (initialSubCount > 0 on the server).
    expect(recoverySocket.readInit().audio?.initialSubscriptions).toEqual(subs);

    // THE ASSERTION THAT REPRODUCES THE WEDGE: the originally-registered
    // onTranscript must STILL fire on the recovered session. If a reconnect
    // dropped the handler, this transcript would never be recorded.
    recoverySocket.pushTranscript("after reconnect");
    expect(received).toEqual(["before drop", "after reconnect"]);

    runtime.close();
  });
});
