/**
 * @fileoverview The live WebSocket: handshake, reconnect, and liveness ping.
 *
 * `Connection` owns the one runtime socket and hides every raw-socket detail
 * from the rest of `cloud.runtime`. It opens the socket, runs the
 * `connection.init` / `connection.ack` handshake, reconnects with exponential
 * backoff plus jitter when the socket drops, and runs a client-driven liveness
 * ping so a half-open socket (one that looks alive but is not) is detected and
 * reconnected. Everything above it sees only validated `CloudToClientMessage`
 * values, never a string off the wire.
 *
 * It never imports a real socket: the platform supplies a `WebSocketLike`
 * factory, so the same code runs on the phone and in a Node/Bun test harness.
 *
 * See docs/issues/004-cloud-client/design.md ("src/modules/runtime/connection.ts")
 * and docs/issues/002-cloud-runtime/protocol.md (envelope, handshake, control).
 */
import {
  PROTOCOL_MAJOR,
  cloudToClientMessage,
  type ConnectionInit,
  type ConnectionAck,
  type ClientToCloudMessage,
  type CloudToClientMessage,
} from "@mentra/cloud-runtime/protocol";
import type { WebSocketLike } from "../../transports";
import type { Logger } from "../../logger";

/** Connection lifecycle, surfaced to the rest of runtime via `onState`. */
export type ConnectionState = "connecting" | "open" | "closed";

/**
 * How often the client sends `control.ping`, and how long it waits for the
 * matching `control.pong` before declaring the socket dead.
 *
 * The cloud is passive on liveness (the client owns reconnect), so these are
 * client-side constants. The timeout is shorter than the interval so a missed
 * pong is caught before the next ping goes out, rather than letting two pings
 * stack up against one dead socket.
 */
const PING_INTERVAL_MS = 15_000;
const PONG_TIMEOUT_MS = 10_000;

/**
 * How long to wait for `connection.ack` after sending `connection.init` before
 * giving up on a handshake. Without this, a socket that opens but never acks
 * (a stalled or misbehaving peer) would leave `open()` pending forever.
 */
const HANDSHAKE_TIMEOUT_MS = 15_000;

export interface ConnectionDeps {
  // Factory, not an instance: a fresh socket is opened on every (re)connect.
  ws: (url: string) => WebSocketLike;
  url: string;
  // Resolves the current access token just before each (re)connect, so a token
  // refreshed mid-session is picked up on the next open without re-wiring.
  getToken: () => Promise<string>;
  // Builds the `connection.init` payload (protocol version, platform, audio
  // config, initial subscriptions). Injected so the connection stays unaware of
  // what rides in the handshake beyond the token it stamps in.
  initPayload: () => ConnectionInit;
  reconnect: { baseMs: number; maxMs: number; jitter: boolean };
  logger: Logger;
}

/**
 * Build an envelope around a payload.
 *
 * Every WebSocket message carries `v: 2` and a millisecond `timestamp`, so this
 * one helper stamps both rather than each call site repeating (and risking
 * drifting on) the envelope shape.
 */
function envelope<T>(type: string, payload: T): {
  v: typeof PROTOCOL_MAJOR;
  type: string;
  timestamp: number;
  payload: T;
} {
  return { v: PROTOCOL_MAJOR, type, timestamp: Date.now(), payload };
}

/**
 * Compute the next reconnect delay: exponential backoff capped at `maxMs`, with
 * optional jitter.
 *
 * Jitter (a random fraction of the computed delay) keeps a fleet of phones from
 * reconnecting in lockstep after a shared cloud blip, which would otherwise hit
 * the cloud with a synchronized thundering herd.
 */
function backoffDelay(
  attempt: number,
  cfg: { baseMs: number; maxMs: number; jitter: boolean },
): number {
  const exponential = Math.min(cfg.maxMs, cfg.baseMs * 2 ** attempt);
  if (!cfg.jitter) return exponential;
  // Full jitter: a uniform random point in [0, exponential]. Spreads retries
  // across the whole window instead of clustering at its edge.
  return Math.random() * exponential;
}

export class Connection {
  private readonly deps: ConnectionDeps;

  // The current socket. Null between connect attempts and after close, so every
  // access guards on it rather than assuming a live socket.
  private socket: WebSocketLike | null = null;

  // The last successful handshake result (sessionId, audio coordinates). Held so
  // `cloud.runtime` can read `sessionId` for REST calls and the audio path can
  // read its coordinates, without re-doing the handshake.
  private currentAck: ConnectionAck | null = null;

  // Handler the rest of runtime registers for validated inbound messages.
  private messageHandler: ((msg: CloudToClientMessage) => void) | null = null;

  // State subscribers (connecting / open / closed).
  private readonly stateHandlers = new Set<(s: ConnectionState) => void>();

  // True once `close()` is called by the host, so an incidental socket-close
  // event does NOT trigger a reconnect. Distinguishes "the host asked us to
  // stop" from "the network dropped".
  private closedByHost = false;

  // How many consecutive failed (re)connect attempts, used to grow the backoff.
  // Reset to zero on a successful handshake.
  private reconnectAttempt = 0;

  // Liveness timers. The interval drives the periodic ping; the pong-wait timer
  // is armed when a ping goes out and disarmed when its pong arrives.
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;

  // While `open()` is awaiting `connection.ack`, these settle that promise. They
  // are cleared the moment the handshake resolves, rejects, or times out, so a
  // late ack or error cannot settle an already-finished promise.
  private pendingAck: {
    resolve: (ack: ConnectionAck) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(deps: ConnectionDeps) {
    this.deps = deps;
  }

  /**
   * The last handshake result, or null before the first successful connect.
   *
   * Read by `cloud.runtime` for the `sessionId` it echoes on REST calls and by
   * the audio path for the UDP coordinates and key.
   */
  get ack(): ConnectionAck | null {
    return this.currentAck;
  }

  /**
   * Open the socket, run the handshake, and resolve with `connection.ack`.
   *
   * The token goes in BOTH the first-frame `connection.init.payload.token` AND
   * the `?token=` URL parameter: the in-frame token is the real auth path, and
   * the query parameter is a fallback for environments where header or in-frame
   * auth is awkward (the Chrome JS debugger), per the protocol. Rejects if the
   * cloud answers with a fatal error or the handshake times out.
   */
  async open(): Promise<ConnectionAck> {
    // A fresh open() means the host wants the socket up; clear any prior
    // host-close intent so a later drop reconnects normally.
    this.closedByHost = false;
    return this.connectOnce();
  }

  /**
   * Close for good: stop liveness, mark host-closed so the close event does not
   * reconnect, and tear down the socket. Idempotent.
   */
  close(): void {
    this.closedByHost = true;
    this.stopLiveness();
    this.failPendingAck(new Error("Connection closed by host"));
    this.teardownSocket();
    this.setState("closed");
  }

  /**
   * Send an enveloped client-to-cloud message.
   *
   * The caller passes the message payload already typed; this stamps the
   * envelope and serializes. A send on a missing socket is dropped with a log
   * rather than throwing, because callers (for example a queued subscription
   * resend) should not have to guard every send against a mid-reconnect gap.
   */
  send(msg: ClientToCloudMessage): void {
    if (!this.socket) {
      this.deps.logger.warn("ws send dropped: socket not open", {
        type: msg.type,
      });
      return;
    }
    this.socket.send(JSON.stringify(msg));
  }

  /** Register the single handler for validated inbound messages. */
  onMessage(cb: (msg: CloudToClientMessage) => void): void {
    this.messageHandler = cb;
  }

  /** Subscribe to lifecycle changes. */
  onState(cb: (s: ConnectionState) => void): void {
    this.stateHandlers.add(cb);
  }

  // --- internals ------------------------------------------------------------

  /**
   * One full connect attempt: resolve the token, open the socket, wire its
   * callbacks, send `connection.init`, and await `connection.ack`. On a clean
   * handshake it starts liveness and resolves; on a transport error or a fatal
   * protocol error it rejects (the caller, or the reconnect loop, decides what
   * happens next).
   */
  private async connectOnce(): Promise<ConnectionAck> {
    this.setState("connecting");

    const token = await this.deps.getToken();
    const url = this.appendTokenParam(this.deps.url, token);
    const socket = this.deps.ws(url);
    this.socket = socket;

    // The promise the handshake settles. Wired before the socket can fire any
    // callback so an immediate open/message cannot race ahead of the listener.
    const acked = new Promise<ConnectionAck>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAck = null;
        reject(new Error("Handshake timed out waiting for connection.ack"));
      }, HANDSHAKE_TIMEOUT_MS);
      this.pendingAck = { resolve, reject, timer };
    });

    socket.onOpen(() => {
      // The socket is up; send the handshake. The token rides in the payload as
      // the primary auth path (the ?token= parameter above is only a fallback).
      const init = { ...this.deps.initPayload(), token };
      socket.send(JSON.stringify(envelope("connection.init", init)));
    });

    socket.onMessage((data) => this.handleRawMessage(data));

    socket.onError((err) => {
      // A transport error is logged but not acted on directly: the socket's own
      // close event (which follows) drives reconnect, so we have one path for
      // "the connection ended" rather than two competing ones. We never log the
      // token or any credential, only that an error occurred.
      this.deps.logger.warn("ws transport error", { url: this.deps.url });
      void err;
    });

    socket.onClose((info) => this.handleClose(info));

    return acked;
  }

  /**
   * Parse, validate, and route one raw inbound frame.
   *
   * Every frame is checked against `cloudToClientMessage` from the shared
   * protocol package before anything acts on it: a frame that does not match
   * (bad JSON, wrong shape, an unknown `type`) is dropped with a log, never
   * crashed on, so a malformed or future message cannot take the session down.
   * A valid frame is dispatched: handshake acks and fatal errors settle a
   * pending `open()`; control pings get an automatic pong; everything else,
   * including pong (which disarms the liveness timer), goes to the message
   * handler.
   */
  private handleRawMessage(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      this.deps.logger.warn("ws dropped: invalid JSON frame");
      return;
    }

    const result = cloudToClientMessage.safeParse(parsed);
    if (!result.success) {
      // Unknown or malformed type. Non-fatal by the protocol: log and ignore so
      // adding message types stays backward compatible within this major.
      this.deps.logger.warn("ws dropped: frame failed validation");
      return;
    }

    const msg = result.data;

    // The handshake ack resolves a pending open(). Checked first so the ack is
    // not also forwarded as an ordinary message before the session is ready.
    if (msg.type === "connection.ack") {
      this.handleAck(msg.payload);
      return;
    }

    // A fatal protocol error during the handshake rejects open(); any error is
    // also forwarded so the rest of runtime can surface it (non-fatal ones keep
    // the connection up).
    if (msg.type === "error") {
      if (msg.payload.fatal && this.pendingAck) {
        this.failPendingAck(
          new Error(`Handshake rejected: ${msg.payload.code}`),
        );
      }
      this.messageHandler?.(msg);
      return;
    }

    // The cloud may ping us; answer immediately so the peer's own liveness check
    // (if any) stays satisfied. This is separate from our client-driven ping.
    if (msg.type === "control.ping") {
      this.sendPong();
      return;
    }

    // A pong answers our liveness ping: the socket is proven alive, so disarm
    // the pong-wait timer that would otherwise reconnect us.
    if (msg.type === "control.pong") {
      this.clearPongTimer();
      return;
    }

    // Everything else (transcript, translation, ...) goes up to runtime.
    this.messageHandler?.(msg);
  }

  /**
   * Record a successful handshake, settle the pending `open()`, flip to the
   * open state, reset the backoff, and start liveness. This is the one place a
   * connection becomes "ready".
   */
  private handleAck(ack: ConnectionAck): void {
    this.currentAck = ack;
    this.reconnectAttempt = 0;

    if (this.pendingAck) {
      clearTimeout(this.pendingAck.timer);
      const { resolve } = this.pendingAck;
      this.pendingAck = null;
      resolve(ack);
    }

    this.setState("open");
    this.startLiveness();
  }

  /**
   * Handle a socket close. If the host asked to close, stay closed. Otherwise
   * the network dropped, so reconnect with backoff: this also covers a liveness
   * timeout, which closes the socket on purpose to funnel through this one path.
   */
  private handleClose(info: { code: number; reason: string }): void {
    this.stopLiveness();
    this.socket = null;

    // A drop mid-handshake rejects the in-flight open() so its caller is not
    // left hanging until the handshake timeout.
    this.failPendingAck(
      new Error(`Socket closed during handshake: ${info.code}`),
    );

    if (this.closedByHost) {
      this.setState("closed");
      return;
    }

    this.setState("closed");
    this.scheduleReconnect(info.reason || `code ${info.code}`);
  }

  /**
   * Wait out the backoff, then try again. Each failed attempt grows the delay
   * (capped, jittered). A failed reconnect simply schedules the next one, so the
   * loop keeps trying until the socket comes back or the host calls `close()`.
   */
  private scheduleReconnect(reason: string): void {
    const delay = backoffDelay(this.reconnectAttempt, this.deps.reconnect);
    this.reconnectAttempt += 1;
    this.deps.logger.info("ws scheduling reconnect", {
      attempt: this.reconnectAttempt,
      delayMs: Math.round(delay),
      reason,
    });

    setTimeout(() => {
      // The host may have called close() during the wait; honor it.
      if (this.closedByHost) return;
      this.connectOnce().catch(() => {
        // A failed reconnect attempt is expected during an outage. The attempt
        // ends in a close event, which schedules the next try, so there is
        // nothing to do here but swallow the rejection.
      });
    }, delay);
  }

  /**
   * Start the client-driven liveness ping.
   *
   * The client owns reconnect, so it actively probes the socket: it sends
   * `control.ping` on an interval and arms a pong-wait timer each time. A pong
   * disarms that timer (see `handleRawMessage`); a missing pong means the socket
   * is dead even if it still looks open, so we close it to trigger reconnect.
   */
  private startLiveness(): void {
    this.stopLiveness();
    this.pingTimer = setInterval(() => this.sendPing(), PING_INTERVAL_MS);
  }

  /** Send one liveness ping and arm the pong-wait timer. */
  private sendPing(): void {
    if (!this.socket) return;
    this.socket.send(JSON.stringify(envelope("control.ping", {})));

    // If a pong-wait timer is already armed, leave it: a single outstanding
    // timeout is enough to catch a dead socket, and re-arming would push the
    // deadline back on every interval.
    if (this.pongTimer) return;
    this.pongTimer = setTimeout(() => {
      // No pong in time. The socket is dead; close it so the close handler runs
      // the reconnect path, rather than reconnecting from here and racing the
      // existing socket's eventual close.
      this.deps.logger.warn("ws liveness timeout: no pong, reconnecting");
      this.pongTimer = null;
      this.teardownSocket();
      this.handleClose({ code: 4000, reason: "liveness timeout" });
    }, PONG_TIMEOUT_MS);
  }

  /** Answer a cloud ping with a pong. */
  private sendPong(): void {
    if (!this.socket) return;
    this.socket.send(JSON.stringify(envelope("control.pong", {})));
  }

  /** Stop both liveness timers (on close, reconnect, or teardown). */
  private stopLiveness(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.clearPongTimer();
  }

  /** Disarm the pong-wait timer (a pong arrived, or liveness is stopping). */
  private clearPongTimer(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  /**
   * Reject and clear the in-flight handshake promise, if any. Safe to call when
   * none is pending (a no-op), so close paths can call it unconditionally.
   */
  private failPendingAck(err: Error): void {
    if (!this.pendingAck) return;
    clearTimeout(this.pendingAck.timer);
    const { reject } = this.pendingAck;
    this.pendingAck = null;
    reject(err);
  }

  /**
   * Close and drop the underlying socket without changing host-close intent or
   * scheduling a reconnect. Used by paths that have already decided what happens
   * next (host close, liveness timeout).
   */
  private teardownSocket(): void {
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    try {
      socket.close();
    } catch {
      // The socket may already be closing; closing twice must not throw.
    }
  }

  /** Notify every state subscriber, isolating a throwing handler. */
  private setState(s: ConnectionState): void {
    for (const cb of [...this.stateHandlers]) {
      try {
        cb(s);
      } catch {
        // A misbehaving state handler must not break the others or the socket.
      }
    }
  }

  /**
   * Append `?token=` to the connect URL as the auth fallback.
   *
   * The token also rides in the first frame (the primary path); this query
   * parameter exists for environments where in-frame or header auth is awkward,
   * notably the Chrome JS debugger. We use `URL` so an existing query string is
   * merged correctly, and fall back to manual concatenation if `url` is not an
   * absolute URL the parser accepts.
   */
  private appendTokenParam(url: string, token: string): string {
    try {
      const u = new URL(url);
      u.searchParams.set("token", token);
      return u.toString();
    } catch {
      const sep = url.includes("?") ? "&" : "?";
      return `${url}${sep}token=${encodeURIComponent(token)}`;
    }
  }
}
