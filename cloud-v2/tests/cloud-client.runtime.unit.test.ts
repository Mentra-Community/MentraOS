/**
 * @fileoverview Deterministic unit tests for cloud.runtime's recovery paths.
 *
 * No core, no network, no Soniox: these drive the runtime pieces directly with
 * a fake WebSocketLike and stub collaborators, so the auth-retry, reconnect/
 * backoff, and subscription-resend logic is exercised without the flakiness of a
 * real socket. The e2e proof of the same paths against real core+runtime lives
 * in cloud-client.e2e.integration.test.ts and cloud-client.reconnect.integration.test.ts.
 *
 * Covered:
 *  - Runtime.connect refreshes the token and reopens ONCE on a fatal AUTH_EXPIRED,
 *    and surfaces the original error if the retry also fails.
 *  - Runtime.connect does NOT retry on a non-AUTH_EXPIRED handshake rejection.
 *  - Connection reconnects with backoff after a non-host socket drop, re-runs the
 *    handshake, and does not reconnect after Connection.close.
 *  - Subscriptions.resend re-PUTs the current set at the current version.
 *  - Runtime.handleReopen (via the connection's reopen) calls subscriptions.resend.
 */
import { describe, expect, test } from "bun:test";
import {
  PROTOCOL_MAJOR,
  type ConnectionAck,
  type ConnectionInit,
  type CloudToClientMessage,
} from "../packages/runtime/src/protocol";
import type { WebSocketLike } from "../packages/cloud-client/src/transports";
import type { Logger } from "../packages/cloud-client/src/logger";
import { noopLogger } from "../packages/cloud-client/src/logger";
import {
  Connection,
  HandshakeRejectedError,
} from "../packages/cloud-client/src/modules/runtime/connection";
import { Runtime } from "../packages/cloud-client/src/modules/runtime/runtime";
import { RuntimeEmitter } from "../packages/cloud-client/src/modules/runtime/emitter";
import { Subscriptions } from "../packages/cloud-client/src/modules/runtime/subscriptions";

const NO_RECONNECT = { baseMs: 1, maxMs: 1, jitter: false };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function envelope<T>(type: string, payload: T) {
  return { v: PROTOCOL_MAJOR, type, timestamp: Date.now(), payload };
}

const ACK: ConnectionAck = { sessionId: "sess-1", negotiatedVersion: "2.0.0" };

/**
 * A scriptable fake socket: each instance records what was sent and exposes the
 * registered callbacks so a test can drive open/message/close by hand. The
 * factory hands back the next queued behavior, so a test can make the first
 * connect reject and a later reconnect succeed.
 */
class FakeSocket implements WebSocketLike {
  sent: string[] = [];
  closed = false;
  private openCb: (() => void) | null = null;
  private msgCb: ((d: string) => void) | null = null;
  private closeCb: ((i: { code: number; reason: string }) => void) | null = null;
  private errCb: ((e: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  onOpen(cb: () => void): void {
    this.openCb = cb;
  }
  onMessage(cb: (d: string) => void): void {
    this.msgCb = cb;
  }
  onClose(cb: (i: { code: number; reason: string }) => void): void {
    this.closeCb = cb;
  }
  onError(cb: (e: unknown) => void): void {
    this.errCb = cb;
  }

  // Test drivers.
  fireOpen(): void {
    this.openCb?.();
  }
  fireMessage(msg: unknown): void {
    this.msgCb?.(JSON.stringify(msg));
  }
  fireClose(code = 1006, reason = "drop"): void {
    this.closeCb?.({ code, reason });
  }
  fireError(err: unknown): void {
    this.errCb?.(err);
  }
  /** The parsed type of the last frame the connection sent on this socket. */
  lastSentType(): string | undefined {
    const last = this.sent[this.sent.length - 1];
    return last ? (JSON.parse(last) as { type: string }).type : undefined;
  }
  sentTypes(): string[] {
    return this.sent.map((s) => (JSON.parse(s) as { type: string }).type);
  }
}

const initPayload = (): ConnectionInit => ({
  protocolVersion: "2.0.0",
  audio: { codec: "pcm", sampleRate: 16000 },
});

/**
 * Build a Connection whose ws factory returns the queued FakeSockets in order.
 * The returned `sockets` array grows as the connection opens each one.
 */
function makeConnection(opts?: {
  getToken?: () => Promise<string>;
  logger?: Logger;
}): { connection: Connection; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const connection = new Connection({
    ws: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    url: "ws://localhost:1/ws/session",
    getToken: opts?.getToken ?? (async () => "token-abc"),
    initPayload,
    reconnect: NO_RECONNECT,
    logger: opts?.logger ?? noopLogger,
  });
  return { connection, sockets };
}

/** Drive a FakeSocket through a successful handshake (open -> init -> ack). */
function completeHandshake(socket: FakeSocket, ack: ConnectionAck = ACK): void {
  socket.fireOpen();
  socket.fireMessage(envelope("connection.ack", ack));
}

describe("Connection: AUTH_EXPIRED handshake rejection", () => {
  test("open() rejects with a HandshakeRejectedError carrying the code", async () => {
    const { connection, sockets } = makeConnection();
    const opened = connection.open();
    await sleep(0);
    sockets[0].fireOpen();
    sockets[0].fireMessage(
      envelope("error", { code: "AUTH_EXPIRED", message: "expired", fatal: true }),
    );

    await expect(opened).rejects.toBeInstanceOf(HandshakeRejectedError);
  });

  test("the rejection's code is the protocol error code", async () => {
    const { connection, sockets } = makeConnection();
    const opened = connection.open();
    await sleep(0);
    sockets[0].fireOpen();
    sockets[0].fireMessage(
      envelope("error", { code: "AUTH_EXPIRED", message: "expired", fatal: true }),
    );
    const err = await opened.catch((e) => e);
    expect(err).toBeInstanceOf(HandshakeRejectedError);
    expect((err as HandshakeRejectedError).code).toBe("AUTH_EXPIRED");
  });
});

describe("Connection: reconnect with backoff", () => {
  test("reconnects and re-handshakes after a non-host socket drop", async () => {
    const { connection, sockets } = makeConnection();
    const opened = connection.open();
    await sleep(0);
    completeHandshake(sockets[0]);
    await opened;
    expect(sockets.length).toBe(1);

    // The network drops (not a host close): the connection should open a fresh
    // socket and redo the handshake.
    sockets[0].fireClose(1006, "network drop");
    await sleep(20); // baseMs=1, no jitter -> reconnect fires almost immediately

    expect(sockets.length).toBe(2);
    // The reconnect sends connection.init again on the new socket.
    completeHandshake(sockets[1], { ...ACK, sessionId: "sess-2" });
    expect(sockets[1].sentTypes()).toContain("connection.init");
    expect(connection.ack?.sessionId).toBe("sess-2");
  });

  test("does NOT reconnect after the host calls close()", async () => {
    const { connection, sockets } = makeConnection();
    const opened = connection.open();
    await sleep(0);
    completeHandshake(sockets[0]);
    await opened;

    connection.close();
    sockets[0].fireClose(1000, "host closed");
    await sleep(20);

    // No new socket: a host close must not trigger the reconnect loop.
    expect(sockets.length).toBe(1);
  });
});

describe("Subscriptions.resend", () => {
  test("re-PUTs the current set at the current version, no version bump", async () => {
    const puts: Array<{ path: string; body: unknown }> = [];
    const http = {
      get: async () => undefined as never,
      post: async () => undefined as never,
      delete: async () => undefined as never,
      put: async <T>(path: string, body: unknown): Promise<T> => {
        puts.push({ path, body });
        return undefined as T;
      },
    };
    const subs = new Subscriptions({ http });

    await subs.set(
      [{ kind: "transcription", language: { mode: "specific", code: "en" } }],
      "sess-1",
    );
    await subs.resend("sess-2");

    expect(puts.length).toBe(2);
    const first = puts[0].body as { version: number; sessionId: string };
    const second = puts[1].body as {
      version: number;
      sessionId: string;
      subscriptions: unknown[];
    };
    // set() bumped to version 1; resend() reuses it (no bump) for the new session.
    expect(first.version).toBe(1);
    expect(second.version).toBe(1);
    expect(second.sessionId).toBe("sess-2");
    expect(second.subscriptions.length).toBe(1);
  });
});

/**
 * A stub Connection good enough for Runtime: it records the open() calls, lets a
 * test script the next open's outcome, and exposes the state callback so a test
 * can drive a reopen.
 */
class StubConnection {
  openCalls = 0;
  private results: Array<{ ok: true; ack: ConnectionAck } | { ok: false; err: Error }> = [];
  private stateCb: ((s: "connecting" | "open" | "closed") => void) | null = null;
  private msgCb: ((m: CloudToClientMessage) => void) | null = null;
  ack: ConnectionAck | null = null;

  queue(result: { ok: true; ack: ConnectionAck } | { ok: false; err: Error }): void {
    this.results.push(result);
  }
  async open(): Promise<ConnectionAck> {
    this.openCalls += 1;
    const result = this.results.shift();
    if (!result) throw new Error("StubConnection: no scripted open result");
    if (!result.ok) throw result.err;
    this.ack = result.ack;
    return result.ack;
  }
  close(): void {}
  send(): void {}
  onMessage(cb: (m: CloudToClientMessage) => void): void {
    this.msgCb = cb;
  }
  onState(cb: (s: "connecting" | "open" | "closed") => void): void {
    this.stateCb = cb;
  }
  // Drive a reconnect's reopen from a test.
  fireState(s: "connecting" | "open" | "closed"): void {
    this.stateCb?.(s);
  }
}

function makeRuntime(
  connection: StubConnection,
  forceRefreshToken: () => Promise<string>,
): { runtime: Runtime; subscriptionResends: string[] } {
  const subscriptionResends: string[] = [];
  const subscriptions = {
    set: async () => {},
    resend: async (sessionId: string) => {
      subscriptionResends.push(sessionId);
    },
  } as unknown as Subscriptions;
  const runtime = new Runtime({
    // The Runtime only uses the Connection's open/onMessage/onState/ack/close.
    connection: connection as unknown as Connection,
    emitter: new RuntimeEmitter(),
    subscriptions,
    camera: { handlePush: () => {} } as never,
    audio: { configure: () => {}, close: () => {} } as never,
    logger: noopLogger,
    forceRefreshToken,
  });
  return { runtime, subscriptionResends };
}

describe("Runtime.connect: AUTH_EXPIRED refresh-and-retry", () => {
  test("refreshes the token and reopens once on a fatal AUTH_EXPIRED", async () => {
    const connection = new StubConnection();
    connection.queue({ ok: false, err: new HandshakeRejectedError("AUTH_EXPIRED") });
    connection.queue({ ok: true, ack: ACK });

    let refreshed = 0;
    const { runtime } = makeRuntime(connection, async () => {
      refreshed += 1;
      return "fresh-token";
    });

    await runtime.connect();

    expect(refreshed).toBe(1);
    expect(connection.openCalls).toBe(2);
  });

  test("surfaces the error if the reopen after refresh also fails", async () => {
    const connection = new StubConnection();
    connection.queue({ ok: false, err: new HandshakeRejectedError("AUTH_EXPIRED") });
    connection.queue({ ok: false, err: new HandshakeRejectedError("AUTH_EXPIRED") });

    let refreshed = 0;
    const { runtime } = makeRuntime(connection, async () => {
      refreshed += 1;
      return "fresh-token";
    });

    await expect(runtime.connect()).rejects.toBeInstanceOf(HandshakeRejectedError);
    // Refreshed once, opened twice; we do NOT loop a third time.
    expect(refreshed).toBe(1);
    expect(connection.openCalls).toBe(2);
  });

  test("does NOT retry on a non-AUTH_EXPIRED handshake rejection", async () => {
    const connection = new StubConnection();
    connection.queue({ ok: false, err: new HandshakeRejectedError("UNSUPPORTED_VERSION") });

    let refreshed = 0;
    const { runtime } = makeRuntime(connection, async () => {
      refreshed += 1;
      return "fresh-token";
    });

    await expect(runtime.connect()).rejects.toBeInstanceOf(HandshakeRejectedError);
    expect(refreshed).toBe(0);
    expect(connection.openCalls).toBe(1);
  });
});

describe("Runtime.handleReopen: subscription re-send on reconnect", () => {
  test("re-sends subscriptions when the connection reopens after the first open", async () => {
    const connection = new StubConnection();
    connection.queue({ ok: true, ack: ACK });
    const { runtime, subscriptionResends } = makeRuntime(connection, async () => "t");

    await runtime.connect();
    // The first open is handled by connect() itself, not a resend.
    expect(subscriptionResends.length).toBe(0);

    // A reconnect drives onState("open") again; the ack is now sess-2.
    connection.ack = { ...ACK, sessionId: "sess-2" };
    connection.fireState("open");
    await sleep(0);

    expect(subscriptionResends).toEqual(["sess-2"]);
  });
});
