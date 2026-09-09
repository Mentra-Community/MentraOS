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
import { Maps } from "./maps";
import { Tts } from "./tts";
import { UdpAudio } from "./audio-udp";
import type { WebSocketLike, UdpSocketLike } from "../../transports";
import type { HttpClient } from "../../http";
import { noopLogger } from "../../logger";
import { systemTimers, type CloudClientTimers } from "../../timers";
import {
  PROTOCOL_MAJOR,
  type ConnectionInit,
  type ConnectionAck,
  type AudioSubscription,
} from "@mentra/cloud-protocol";

/** A scriptable WebSocket the test drives by hand (peer = the test). */
class FakeSocket implements WebSocketLike {
  sent: string[] = [];
  sentBinary: Uint8Array[] = [];
  openCb: (() => void) | null = null;
  messageCb: ((data: string) => void) | null = null;
  closeCb: ((info: { code: number; reason: string }) => void) | null = null;
  errorCb: ((err: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }
  sendBinary(data: Uint8Array): void {
    this.sentBinary.push(data);
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
const ACK_WITH_AUDIO: ConnectionAck = {
  sessionId: "sess-udp",
  negotiatedVersion: "2.0.0",
  audio: {
    sessionTag: 42,
    udp: { host: "127.0.0.1", port: 8000 },
    encryption: {
      algorithm: "xsalsa20-poly1305",
      key: Buffer.alloc(32).toString("base64"),
    },
  },
};
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
    head: async () => new Response(null, { status: 200, headers: { "content-type": "audio/mpeg" } }),
    post: async () => undefined as never,
    postForm: async () => undefined as never,
    put: async () => undefined as never,
    delete: async () => undefined as never,
    url: (path: string) => `https://runtime.test${path}`,
  };
}

function fakeTts(): Tts {
  return new Tts({ http: fakeHttp() });
}

function fakeUdp(): UdpSocketLike {
  return {
    send: () => {},
    onMessage: () => {},
    close: () => {},
  };
}

function recordingUdp(sent: Uint8Array[]): UdpSocketLike {
  return {
    send: (bytes) => {
      sent.push(bytes);
    },
    onMessage: () => {},
    close: () => {},
  };
}

describe("Runtime transcript delivery survives a multi-attempt reconnect", () => {
  test("status tracks runtime liveness and the configured audio transport", async () => {
    const socket = new FakeSocket();
    let created = 0;
    const ws = (_url: string): WebSocketLike => {
      created += 1;
      return socket;
    };

    const emitter = new RuntimeEmitter();
    const subscriptions = new Subscriptions({ http: fakeHttp() });
    const connection = new Connection({
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
    });
    const runtime = new Runtime({
      connection,
      emitter,
      subscriptions,
      camera: new Camera({ http: fakeHttp() }),
      maps: new Maps({ http: fakeHttp() }),
      tts: fakeTts(),
      audio: new UdpAudio({ udp: fakeUdp }),
      logger: noopLogger,
      forceRefreshToken: async () => "tok",
    });

    const statuses: Array<ReturnType<typeof runtime.getStatus>> = [];
    runtime.onStatusChanged((status) => {
      statuses.push(status);
    });

    expect(runtime.getStatus()).toEqual({ status: "disconnected", audioTransport: "none" });

    const connectedPromise = runtime.connect();
    await waitUntil(() => created === 1);
    expect(runtime.getStatus()).toEqual({ status: "connecting", audioTransport: "none" });

    socket.handshake(ACK_WITH_AUDIO);
    await connectedPromise;
    expect(runtime.getStatus()).toEqual({ status: "connected", audioTransport: "udp" });

    socket.closeCb?.({ code: 1006, reason: "network lost" });
    await waitUntil(() => runtime.getStatus().status === "reconnecting");
    expect(runtime.getStatus()).toEqual({ status: "reconnecting", audioTransport: "none" });

    runtime.close();
    expect(runtime.getStatus()).toEqual({ status: "disconnected", audioTransport: "none" });
    expect(statuses).toContainEqual({ status: "connected", audioTransport: "udp" });
    expect(statuses).toContainEqual({ status: "reconnecting", audioTransport: "none" });
  });

  test("falls back to WS when UDP liveness dies, then switches back on one UDP ack", async () => {
    const socket = new FakeSocket();
    let created = 0;
    const ws = (_url: string): WebSocketLike => {
      created += 1;
      return socket;
    };
    const udpSent: Uint8Array[] = [];
    const scheduledIntervals: number[] = [];
    const timers: CloudClientTimers = {
      ...systemTimers,
      setInterval(callback, intervalMs) {
        scheduledIntervals.push(intervalMs);
        return systemTimers.setInterval(callback, intervalMs);
      },
    };

    const emitter = new RuntimeEmitter();
    const subscriptions = new Subscriptions({ http: fakeHttp() });
    const connection = new Connection({
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
    });
    const runtime = new Runtime({
      connection,
      emitter,
      subscriptions,
      camera: new Camera({ http: fakeHttp() }),
      maps: new Maps({ http: fakeHttp() }),
      tts: fakeTts(),
      audio: new UdpAudio({ udp: () => recordingUdp(udpSent) }),
      timers,
      logger: noopLogger,
      forceRefreshToken: async () => "tok",
    });

    const connectedPromise = runtime.connect();
    await waitUntil(() => created === 1);
    socket.handshake(ACK_WITH_AUDIO);
    await connectedPromise;

    expect(runtime.getStatus()).toEqual({ status: "connected", audioTransport: "udp" });
    expect(scheduledIntervals).toEqual([1_000]);
    await waitUntil(() => runtime.getStatus().audioTransport === "ws", 4_000);
    expect(runtime.getStatus()).toEqual({ status: "connected", audioTransport: "ws" });

    runtime.sendAudioFrame(new Uint8Array([1, 2, 3]));
    expect(socket.sentBinary.length).toBe(1);

    socket.messageCb?.(
      JSON.stringify({
        v: PROTOCOL_MAJOR,
        type: "audio.udp_liveness_ack",
        timestamp: Date.now(),
        payload: {
          sessionId: ACK_WITH_AUDIO.sessionId,
          sessionTag: ACK_WITH_AUDIO.audio?.sessionTag,
          probeId: "probe-1",
          receivedAt: Date.now(),
        },
      }),
    );

    await waitUntil(() => runtime.getStatus().audioTransport === "udp");
    const wsFramesBeforeUdpSend = socket.sentBinary.length;
    const udpFramesBeforeRealAudio = udpSent.length;
    runtime.sendAudioFrame(new Uint8Array([4, 5, 6]));

    expect(runtime.getStatus()).toEqual({ status: "connected", audioTransport: "udp" });
    expect(socket.sentBinary.length).toBe(wsFramesBeforeUdpSend);
    expect(udpSent.length).toBeGreaterThan(udpFramesBeforeRealAudio);
    runtime.close();
  });

  test("connected event fires once on a normal initial open", async () => {
    const socket = new FakeSocket();
    let created = 0;
    const ws = (_url: string): WebSocketLike => {
      created += 1;
      return socket;
    };

    const emitter = new RuntimeEmitter();
    const subscriptions = new Subscriptions({ http: fakeHttp() });
    const connection = new Connection({
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
    });
    const runtime = new Runtime({
      connection,
      emitter,
      subscriptions,
      camera: new Camera({ http: fakeHttp() }),
      maps: new Maps({ http: fakeHttp() }),
      tts: fakeTts(),
      audio: new UdpAudio({ udp: fakeUdp }),
      logger: noopLogger,
      forceRefreshToken: async () => "tok",
    });

    let connected = 0;
    runtime.onConnected(() => {
      connected += 1;
    });

    const connectedPromise = runtime.connect();
    await waitUntil(() => created === 1);
    socket.handshake(ACK);
    await connectedPromise;

    expect(connected).toBe(1);
    runtime.close();
  });

  test("connected event fires when the first successful open is a retry after initial failure", async () => {
    const retrySocket = new FakeSocket();
    let created = 0;
    const ws = (_url: string): WebSocketLike => {
      created += 1;
      return retrySocket;
    };

    let tokenCalls = 0;
    const emitter = new RuntimeEmitter();
    const subscriptions = new Subscriptions({ http: fakeHttp() });
    const connection = new Connection({
      ws,
      url: "wss://example.test/ws",
      getToken: async () => {
        tokenCalls += 1;
        if (tokenCalls === 1) {
          throw new Error("cloud unavailable during initial app boot");
        }
        return "tok";
      },
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
    });
    const runtime = new Runtime({
      connection,
      emitter,
      subscriptions,
      camera: new Camera({ http: fakeHttp() }),
      maps: new Maps({ http: fakeHttp() }),
      tts: fakeTts(),
      audio: new UdpAudio({ udp: fakeUdp }),
      logger: noopLogger,
      forceRefreshToken: async () => "tok",
    });

    let connected = 0;
    runtime.onConnected(() => {
      connected += 1;
    });

    await runtime.connect().catch(() => undefined);
    expect(created).toBe(0);
    expect(connected).toBe(0);

    await waitUntil(() => created >= 1);
    retrySocket.handshake(ACK);
    await waitUntil(() => connected === 1);

    expect(connected).toBe(1);
    runtime.close();
  });

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
      maps: new Maps({ http: fakeHttp() }),
      tts: fakeTts(),
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
