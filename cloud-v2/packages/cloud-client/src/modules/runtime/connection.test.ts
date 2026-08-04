/**
 * @fileoverview Reconnect-robustness tests for `Connection`.
 *
 * The case under test is the one that used to wedge the client in dev: a
 * connect attempt that fails WITHOUT a clean `onClose` (only `onError` fires, as
 * a flaky transport or a mid-handshake network blip can produce). Before the
 * fix the reconnect loop was driven solely by `onClose`, so such a failure broke
 * the chain and the client sat silently disconnected until a full relaunch.
 *
 * The fix makes the loop self-sustaining (a failed attempt reschedules itself
 * from its own catch) and adds a watchdog backstop. The first test pins the
 * primary fix: after an error-only failure the `ws` factory is invoked AGAIN, so
 * the client retries instead of wedging. The remaining tests cover the
 * idempotency guard and that a host close stops the loop.
 */
import { describe, test, expect } from "bun:test";

import { Connection, type ConnectionDeps } from "./connection";
import type { WebSocketLike } from "../../transports";
import { noopLogger } from "../../logger";
import {
  PROTOCOL_MAJOR,
  type ConnectionInit,
  type ConnectionAck,
} from "@mentra/cloud-protocol";

/**
 * A scriptable `WebSocketLike` that records its callbacks so the test can drive
 * them by hand. It does nothing on its own: the test (acting as the fake peer)
 * decides whether this socket errors, opens, acks, or closes, and when.
 */
class FakeSocket implements WebSocketLike {
  sent: string[] = [];
  sentBinary: Uint8Array[] = [];
  openCb: (() => void) | null = null;
  messageCb: ((data: string) => void) | null = null;
  closeCb: ((info: { code: number; reason: string }) => void) | null = null;
  errorCb: ((err: unknown) => void) | null = null;
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }
  sendBinary(data: Uint8Array): void {
    this.sentBinary.push(data);
  }
  close(): void {
    this.closed = true;
  }
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

  /** Drive a successful handshake: open, receive init, then send back an ack. */
  driveSuccessfulHandshake(ack: ConnectionAck): void {
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
}

const SAMPLE_ACK: ConnectionAck = {
  sessionId: "s1",
  negotiatedVersion: "2.0.0",
};

const SAMPLE_INIT: ConnectionInit = { protocolVersion: "2.0.0" };

// A tiny, fast, deterministic backoff so the test never waits long. No jitter so
// delays are exact and the test is not flaky.
const FAST_RECONNECT = { baseMs: 5, maxMs: 20, jitter: false };

/** Build a Connection plus the factory state the test inspects. */
function makeConnection(opts: {
  // Sockets are returned in order, one per (re)connect attempt.
  sockets: FakeSocket[];
  // Optional hook to fail a given (re)connect attempt before its socket opens,
  // simulating a transient failure that never produces an onClose.
  getToken?: () => Promise<string>;
}): { conn: Connection; createdCount: () => number } {
  let created = 0;
  const ws = (_url: string): WebSocketLike => {
    const socket = opts.sockets[created] ?? new FakeSocket();
    created += 1;
    return socket;
  };

  const deps: ConnectionDeps = {
    ws,
    url: "wss://example.test/ws",
    getToken: opts.getToken ?? (async () => "test-token"),
    initPayload: () => SAMPLE_INIT,
    reconnect: FAST_RECONNECT,
    logger: noopLogger,
  };

  return { conn: new Connection(deps), createdCount: () => created };
}

/** Resolve after `ms` of real time (kept small so tests stay fast). */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Connection reconnect robustness", () => {
  test("a failed initial open still enters the reconnect loop", async () => {
    const retry = new FakeSocket();
    let tokenCalls = 0;
    const { conn, createdCount } = makeConnection({
      sockets: [retry],
      getToken: async () => {
        tokenCalls += 1;
        if (tokenCalls === 1) {
          throw new Error("cloud temporarily unavailable during app boot");
        }
        return "test-token";
      },
    });

    await conn.open().catch(() => undefined);
    expect(createdCount()).toBe(0);

    await wait(60);
    expect(createdCount()).toBe(1);

    retry.driveSuccessfulHandshake(SAMPLE_ACK);
    await wait(5);
    expect(conn.ack).toEqual(SAMPLE_ACK);

    conn.close();
  });

  test("a reconnect attempt that fails without onClose still schedules the next try", async () => {
    // This is the exact wedge from dev. We get a live session, drop it (entering
    // the reconnect loop), and then make the scheduled reconnect attempt FAIL in
    // a way that produces no clean onClose -- here the attempt's `getToken`
    // rejects, so `connectOnce()` rejects before any socket exists and no close
    // event can ever fire. Pre-fix, the loop relied entirely on onClose to queue
    // the next try, so this killed it: the client sat silently disconnected.
    // Post-fix, the scheduled attempt's catch reschedules itself, so the loop
    // survives and the next attempt is made.
    const first = new FakeSocket(); // initial session
    const third = new FakeSocket(); // the eventual successful retry

    // Attempt 1 (initial open): token ok.
    // Attempt 2 (first scheduled reconnect): token REJECTS -> fails, no onClose.
    // Attempt 3+ (next scheduled reconnect): token ok again.
    let tokenCalls = 0;
    const { conn, createdCount } = makeConnection({
      sockets: [first, /* attempt 2 socket is never opened */ third],
      getToken: async () => {
        tokenCalls += 1;
        if (tokenCalls === 2) {
          throw new Error("transient token/network blip mid-reconnect");
        }
        return "test-token";
      },
    });

    // Establish a live session.
    const opened = conn.open();
    await wait(5);
    first.driveSuccessfulHandshake(SAMPLE_ACK);
    await opened;
    expect(createdCount()).toBe(1);

    // Drop the socket cleanly: this schedules reconnect attempt 2.
    first.closeCb?.({ code: 1006, reason: "abnormal" });

    // Attempt 2 fires, its getToken rejects (no socket, no onClose). Without the
    // self-rescheduling catch the loop would stop here. Give the loop time to
    // make attempt 2 (which fails) AND reschedule + run attempt 3.
    await wait(120);

    // The ws factory was invoked again AFTER the failed-without-close attempt:
    // the loop did NOT wedge. (Attempt 2 never reaches ws() because getToken
    // throws first, so a third created socket proves attempt 3 ran.)
    expect(createdCount()).toBeGreaterThanOrEqual(2);

    // And that later attempt completes a real handshake -- we recovered fully,
    // not just spun. The successful retry is the last socket created.
    const recovered = third;
    recovered.driveSuccessfulHandshake(SAMPLE_ACK);
    await wait(5);
    expect(conn.ack).toEqual(SAMPLE_ACK);

    conn.close();
  });

  test("a socket that fires only onError (never onClose) does not wedge the loop", async () => {
    // The transport-level variant: a `WebSocketLike` that emits onError and
    // never onClose. The handshake eventually times out and rejects the attempt,
    // and the self-rescheduling catch then queues the next try. We assert the
    // loop keeps producing attempts rather than dying on the error-only socket.
    //
    // Note: the handshake timeout is a fixed internal constant, so this test
    // only checks that the FIRST reconnect (driven by the clean drop below) is
    // scheduled and runs; the error-only socket is exercised to prove onError
    // alone never tears anything down prematurely.
    const first = new FakeSocket();
    const second = new FakeSocket();
    const { conn, createdCount } = makeConnection({
      sockets: [first, second],
    });

    const opened = conn.open();
    await wait(5);
    first.driveSuccessfulHandshake(SAMPLE_ACK);
    await opened;
    expect(createdCount()).toBe(1);

    // Drop -> schedule reconnect. The reconnect socket fires only onError.
    first.closeCb?.({ code: 1006, reason: "abnormal" });
    await wait(40);
    expect(createdCount()).toBe(2);

    // onError alone must not tear down or wedge: the socket is still the active
    // one, and a later ack can still complete the handshake.
    second.errorCb?.(new Error("transient transport error"));
    second.driveSuccessfulHandshake(SAMPLE_ACK);
    await wait(5);
    expect(conn.ack).toEqual(SAMPLE_ACK);

    conn.close();
  });

  test("a normal onClose still drives exactly one reconnect (no double-fire)", async () => {
    const first = new FakeSocket();
    const second = new FakeSocket();
    const { conn, createdCount } = makeConnection({
      sockets: [first, second],
    });

    const opened = conn.open();
    // Wait for getToken() to resolve and the socket to be created before driving
    // its handshake callbacks.
    await wait(5);
    first.driveSuccessfulHandshake(SAMPLE_ACK);
    await opened;
    expect(createdCount()).toBe(1);

    // The socket drops cleanly. handleClose schedules a reconnect; the
    // idempotency guard must keep that to a single queued attempt even though
    // the catch path also exists.
    first.closeCb?.({ code: 1006, reason: "abnormal" });

    await wait(60);

    // One reconnect, not a storm: the second attempt was created.
    expect(createdCount()).toBe(2);

    conn.close();
  });

  test("a stale close from a previous socket cannot close the recovered socket", async () => {
    const first = new FakeSocket();
    const second = new FakeSocket();
    const { conn, createdCount } = makeConnection({
      sockets: [first, second],
    });

    const opened = conn.open();
    await wait(5);
    first.driveSuccessfulHandshake(SAMPLE_ACK);
    await opened;

    first.closeCb?.({ code: 1006, reason: "network lost" });
    await wait(40);
    expect(createdCount()).toBe(2);

    const recoveredAck = { ...SAMPLE_ACK, sessionId: "s2" };
    second.driveSuccessfulHandshake(recoveredAck);
    await wait(5);
    expect(conn.ack).toEqual(recoveredAck);

    // Some transports can deliver a late/duplicate close for an old socket
    // after a newer socket is already current. That stale event must not mark
    // the recovered connection closed or schedule a third socket.
    first.closeCb?.({ code: 1006, reason: "late duplicate close" });
    await wait(60);

    expect(conn.ack).toEqual(recoveredAck);
    expect(createdCount()).toBe(2);

    conn.close();
  });

  test("an unauthorized WebSocket upgrade refreshes auth before reconnecting", async () => {
    const first = new FakeSocket();
    const second = new FakeSocket();
    let created = 0;
    let refreshed = false;
    let refreshCalls = 0;

    const ws = (_url: string): WebSocketLike => {
      const socket = [first, second][created] ?? new FakeSocket();
      created += 1;
      return socket;
    };

    const conn = new Connection({
      ws,
      url: "wss://example.test/ws",
      getToken: async () => (refreshed ? "fresh-token" : "stale-token"),
      initPayload: () => SAMPLE_INIT,
      reconnect: FAST_RECONNECT,
      onAuthRejected: async () => {
        refreshCalls += 1;
        await wait(10);
        refreshed = true;
      },
      logger: noopLogger,
    });

    const readInitToken = (sock: FakeSocket): string => {
      const frame = sock.sent
        .map((s) => JSON.parse(s) as { type: string; payload: ConnectionInit & { token?: string } })
        .find((m) => m.type === "connection.init");
      if (!frame?.payload.token) throw new Error("no connection.init token");
      return frame.payload.token;
    };

    const opened = conn.open();
    await wait(5);
    first.driveSuccessfulHandshake(SAMPLE_ACK);
    await opened;
    expect(readInitToken(first)).toBe("stale-token");

    first.closeCb?.({
      code: 1006,
      reason: "Expected HTTP 101 response but was '401 Unauthorized'",
    });

    await wait(40);
    expect(refreshCalls).toBe(1);
    expect(created).toBe(2);

    second.driveSuccessfulHandshake({ ...SAMPLE_ACK, sessionId: "s2" });
    await wait(5);
    expect(readInitToken(second)).toBe("fresh-token");

    conn.close();
  });

  test("each (re)connect's connection.init carries the live initPayload (initialSubscriptions)", async () => {
    // Regression: a reconnect's new cloud session is brand-new and starts with an
    // empty subscription set. If `connection.init` does not carry the live
    // subscriptions, the reconnected session has audio but no transcription
    // provider until a follow-up REST resend lands — and that resend's
    // control-stream nudge can be missed by the new owner pod's just-created
    // consumer group. So the init payload MUST carry the current set on EVERY
    // (re)open. Here `initPayload` reads a mutable holder, exactly as the real
    // client reads `subscriptions.currentSet()`; we assert both the initial and
    // the reconnect handshake frames carry it.
    const first = new FakeSocket();
    const second = new FakeSocket();

    // Stand-in for the live subscription set the real `initPayload` reads.
    const liveSubs = [
      { kind: "transcription", language: { mode: "specific", code: "en-US" } },
    ] as unknown as NonNullable<
      NonNullable<ConnectionInit["audio"]>["initialSubscriptions"]
    >;

    let created = 0;
    const ws = (_url: string): WebSocketLike => {
      const socket = [first, second][created] ?? new FakeSocket();
      created += 1;
      return socket;
    };
    const conn = new Connection({
      ws,
      url: "wss://example.test/ws",
      getToken: async () => "test-token",
      // Factory re-read on every open, mirroring client.ts.
      initPayload: () => ({
        protocolVersion: "2.0.0",
        audio: { codec: "lc3", sampleRate: 16000, frameSizeBytes: 60, initialSubscriptions: liveSubs },
      }),
      reconnect: FAST_RECONNECT,
      logger: noopLogger,
    });

    const readInit = (sock: FakeSocket): ConnectionInit => {
      const frame = sock.sent
        .map((s) => JSON.parse(s) as { type: string; payload: ConnectionInit })
        .find((m) => m.type === "connection.init");
      if (!frame) throw new Error("no connection.init frame was sent");
      return frame.payload;
    };

    // Initial connect.
    const opened = conn.open();
    await wait(5);
    first.driveSuccessfulHandshake(SAMPLE_ACK);
    await opened;
    expect(readInit(first).audio?.initialSubscriptions).toEqual(liveSubs);

    // Reconnect: the new handshake must also carry the live set.
    first.closeCb?.({ code: 1006, reason: "abnormal" });
    await wait(40);
    expect(created).toBe(2);
    second.driveSuccessfulHandshake({ ...SAMPLE_ACK, sessionId: "s2" });
    await wait(5);
    expect(readInit(second).audio?.initialSubscriptions).toEqual(liveSubs);

    conn.close();
  });

  test("close() stops the reconnect loop", async () => {
    const first = new FakeSocket();
    const { conn, createdCount } = makeConnection({ sockets: [first] });

    const opened = conn.open().catch(() => {});
    await wait(5);
    expect(createdCount()).toBe(1);

    // Host closes before the failed attempt can reschedule.
    conn.close();
    first.errorCb?.(new Error("transport blip"));
    await opened;

    await wait(60);

    // No new socket: the host close wins and the loop stays down.
    expect(createdCount()).toBe(1);
  });
});
