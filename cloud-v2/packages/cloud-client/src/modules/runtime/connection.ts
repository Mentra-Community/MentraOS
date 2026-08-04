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
 * Reconnect robustness (why the loop is self-sustaining + watchdogged):
 * The reconnect loop used to be driven ONLY by the socket's `onClose` event
 * (`handleClose` -> `scheduleReconnect`), and a scheduled attempt's
 * `connectOnce().catch()` just swallowed the rejection, trusting that a close
 * event would always fire and schedule the next try. That assumption is the
 * bug: a connect attempt can fail WITHOUT ever firing a clean `onClose` -- a
 * transient network/DNS blip mid-handshake, or a `WebSocketLike` transport that
 * emits only `onError` and no `onClose`. When that happens the chain breaks:
 * nothing schedules the next retry, so the client sits SILENTLY disconnected
 * forever until a full app relaunch. We hit this in dev (ADB/Metro flapping
 * wedged the v2 socket; only a cold relaunch recovered it).
 *
 * Three changes close that gap, belt-and-suspenders:
 *   0. A failed initial `open()` now also enters the reconnect loop. Before
 *      this, reconnect was robust only AFTER the first successful session had
 *      dropped; if the app booted while cloud was down, `open()` rejected and no
 *      retry was queued.
 *   1. The scheduled attempt's `.catch()` now reschedules itself, so a failure
 *      that did NOT fire `onClose` still queues the next try. `scheduleReconnect`
 *      is idempotent (guarded by `reconnectTimer`), so the double call from
 *      `onClose` + this catch never stacks two timers.
 *   2. A lightweight watchdog interval revives the loop if some unforeseen path
 *      ever leaves us `closed`, not host-closed, with no reconnect pending. Even
 *      if reasoning (1) misses a case, the watchdog guarantees we never sit dead.
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
} from "@mentra/cloud-protocol";
import type { WebSocketLike } from "../../transports";
import type { Logger } from "../../logger";

/** Connection lifecycle, surfaced to the rest of runtime via `onState`. */
export type ConnectionState = "connecting" | "open" | "closed";

/**
 * The error `open()` rejects with when the cloud answers the handshake with a
 * fatal protocol error instead of an ack.
 *
 * It carries the protocol `code` (for example `AUTH_EXPIRED`) so the caller can
 * branch on the cause without string-matching the message. `cloud.runtime` uses
 * this to recognize `AUTH_EXPIRED` and refresh-then-reopen once.
 */
export class HandshakeRejectedError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Handshake rejected: ${code}`);
    this.name = "HandshakeRejectedError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

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

/**
 * How often the reconnect watchdog checks that the loop is still alive.
 *
 * This is the belt-and-suspenders backstop: if any path ever leaves the
 * connection `closed` (not host-closed) with no reconnect timer pending, the
 * watchdog notices within one interval and restarts the loop. It is deliberately
 * coarse (slower than a single backoff step) because it is a safety net, not the
 * primary driver -- the catch-reschedule in `scheduleReconnect` handles the
 * common failed-attempt case directly; the watchdog only catches the cases that
 * one somehow misses.
 */
const RECONNECT_WATCHDOG_MS = 20_000;

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
  // Called when the WebSocket upgrade itself is rejected as unauthorized. That
  // happens before a protocol `error` frame can exist, so runtime's normal
  // AUTH_EXPIRED handshake retry cannot see it. The host uses this to invalidate
  // a cached access token before the next reconnect attempt asks for one.
  onAuthRejected?: () => Promise<void> | void;
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

function isUnauthorizedUpgrade(reason: string): boolean {
  return /\b401\b|unauthorized/i.test(reason);
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

  // The pending reconnect timer, or null when no retry is queued. This single
  // field makes `scheduleReconnect` idempotent: a second call while a timer is
  // already armed is a no-op, so the (intentional) double call from `onClose`
  // and from a failed attempt's catch-reschedule can never stack two timers and
  // double the reconnect rate.
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // The watchdog interval (started in open(), cleared in close()). It is the
  // backstop that revives the reconnect loop if it ever stalls: see
  // `tickWatchdog` and the file header for why a stall is possible at all.
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;

  // Mirror of the last state pushed through `setState`, so the watchdog can ask
  // "are we currently closed?" without a separate subscription. The state
  // handlers are fire-and-forget notifications; this is the authoritative copy
  // the watchdog reads.
  private currentState: ConnectionState = "closed";

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

    // A fresh open() is a clean slate: cancel any stale reconnect left over from
    // a previous session, and reset the backoff so we do not start this connect
    // from a long delay inherited from an earlier outage.
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;

    // Arm the watchdog for the lifetime of this open() session. It is cleared in
    // close(); restarting it here (after stopping any prior one) keeps exactly
    // one interval running even if open() is called more than once.
    this.startWatchdog();

    return this.connectOnce().catch((err) => {
      if (!this.closedByHost) {
        this.setState("closed");
        this.scheduleReconnect("initial open failed");
      }
      throw err;
    });
  }

  /**
   * Close for good: stop liveness, mark host-closed so the close event does not
   * reconnect, and tear down the socket. Idempotent.
   */
  close(): void {
    this.closedByHost = true;
    this.stopLiveness();
    // Cancel any queued reconnect and stop the watchdog: the host wants us down,
    // so neither the loop nor its backstop should bring the socket back up.
    this.clearReconnectTimer();
    this.stopWatchdog();
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

  /**
   * Send one binary frame on the live WebSocket.
   *
   * Used only for the audio fallback path. A missing socket is a soft drop for
   * the same reason text sends are: audio is continuous and reconnect is owned
   * by the connection state machine.
   */
  sendBinary(bytes: Uint8Array): void {
    if (!this.socket || this.currentState !== "open") {
      this.deps.logger.warn("ws binary send dropped: socket not open");
      return;
    }
    this.socket.sendBinary(bytes);
  }

  get isOpen(): boolean {
    return this.currentState === "open" && this.socket !== null;
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

    // Close any previous socket FIRST. Replacing `this.socket` without closing
    // leaves the old TCP connection alive: its callbacks are ignored (the
    // `socket !== this.socket` guards below) but the SERVER still sees a live
    // session — a ghost that holds the user's subscription record and rejects
    // the real session's writes as stale-session. One client must never hold
    // two server sessions.
    const previous = this.socket;
    if (previous) {
      this.socket = null;
      try {
        previous.close();
      } catch {
        /* best-effort */
      }
    }

    const token = await this.deps.getToken();
    const url = this.appendTokenParam(this.deps.url, token);
    const socket = this.deps.ws(url);
    this.socket = socket;

    // The promise the handshake settles. Wired before the socket can fire any
    // callback so an immediate open/message cannot race ahead of the listener.
    const acked = new Promise<ConnectionAck>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAck = null;
        // Close the half-done socket too: a handshake that times out client-
        // side may still COMPLETE server-side moments later, leaving a ghost
        // session nobody owns.
        try {
          socket.close();
        } catch {
          /* best-effort */
        }
        if (this.socket === socket) {
          this.socket = null;
        }
        reject(new Error("Handshake timed out waiting for connection.ack"));
      }, HANDSHAKE_TIMEOUT_MS);
      this.pendingAck = { resolve, reject, timer };
    });

    socket.onOpen(() => {
      if (socket !== this.socket) return;
      // The socket is up; send the handshake. The token rides in the payload as
      // the primary auth path (the ?token= parameter above is only a fallback).
      const init = { ...this.deps.initPayload(), token };
      socket.send(JSON.stringify(envelope("connection.init", init)));
    });

    socket.onMessage((data) => {
      if (socket !== this.socket) return;
      this.handleRawMessage(data);
    });

    socket.onError((err) => {
      if (socket !== this.socket) return;
      // A transport error is logged but not acted on directly: the socket's own
      // close event (which follows) drives reconnect, so we have one path for
      // "the connection ended" rather than two competing ones. We never log the
      // token or any credential, only that an error occurred.
      this.deps.logger.warn("ws transport error", { url: this.deps.url });
      void err;
    });

    socket.onClose((info) => this.handleClose(socket, info));

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
      const issue = result.error.issues[0];
      this.deps.logger.warn("ws dropped: frame failed validation", {
        type:
          parsed && typeof parsed === "object" && "type" in parsed
            ? String((parsed as { type?: unknown }).type)
            : "unknown",
        path: issue?.path.join(".") ?? "",
        issue: issue?.message ?? "unknown validation error",
      });
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
        this.failPendingAck(new HandshakeRejectedError(msg.payload.code));
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
  private handleClose(
    socket: WebSocketLike,
    info: { code: number; reason: string },
  ): void {
    if (socket !== this.socket) return;

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

    const reason = info.reason || `code ${info.code}`;
    if (isUnauthorizedUpgrade(reason)) {
      void Promise.resolve(this.deps.onAuthRejected?.())
        .catch((err) => {
          this.deps.logger.warn("ws auth refresh after unauthorized upgrade failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          if (!this.closedByHost) {
            this.scheduleReconnect(reason);
          }
        });
      return;
    }

    this.scheduleReconnect(reason);
  }

  /**
   * Wait out the backoff, then try again. Each failed attempt grows the delay
   * (capped, jittered). The loop is self-sustaining: a failed attempt schedules
   * the NEXT one from its own catch, so it keeps trying until the socket comes
   * back or the host calls `close()`.
   *
   * Idempotent by design. `handleClose` calls this when a socket drops, and a
   * failed attempt's catch (below) calls it too; the `reconnectTimer` guard
   * means whichever fires first wins and the other is a no-op, so we never stack
   * two timers and double the reconnect rate.
   */
  private scheduleReconnect(reason: string): void {
    // Already a retry queued -> nothing to do. This is the guard that makes the
    // double call from onClose + catch-reschedule (and the watchdog) harmless.
    if (this.reconnectTimer !== null) return;

    const delay = backoffDelay(this.reconnectAttempt, this.deps.reconnect);
    this.reconnectAttempt += 1;
    this.deps.logger.info("ws scheduling reconnect", {
      attempt: this.reconnectAttempt,
      delayMs: Math.round(delay),
      reason,
    });

    this.reconnectTimer = setTimeout(() => {
      // Null the timer first so this slot is free again: a connect that fails
      // below must be able to schedule the next retry, and the watchdog must see
      // "no reconnect pending" while the attempt is in flight.
      this.reconnectTimer = null;

      // The host may have called close() during the wait; honor it.
      if (this.closedByHost) return;

      this.connectOnce().catch(() => {
        // The attempt failed. Historically we relied on the socket's close event
        // to schedule the next try -- but a failure WITHOUT a clean onClose (a
        // mid-handshake network blip, or a transport that emits only onError)
        // never fires that event, which is exactly how the client used to wedge
        // (see the file header). So reschedule from here unconditionally; the
        // idempotency guard above means this is a no-op if onClose already
        // queued the next retry.
        if (!this.closedByHost) {
          this.scheduleReconnect("retry after failed attempt");
        }
      });
    }, delay);
  }

  /** Cancel a queued reconnect, if any. Safe to call when none is pending. */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Start the reconnect watchdog (one interval for the life of an open()
   * session). Stops any prior interval first so open() can be called repeatedly
   * without leaking intervals.
   */
  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdogTimer = setInterval(
      () => this.tickWatchdog(),
      RECONNECT_WATCHDOG_MS,
    );
  }

  /** Stop the reconnect watchdog (on host close). */
  private stopWatchdog(): void {
    if (this.watchdogTimer !== null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  /**
   * Belt-and-suspenders: if we are sitting `closed`, the host did not close us,
   * and yet no reconnect is queued, the loop has stalled -- revive it.
   *
   * In normal operation this never fires: either we are open/connecting, or a
   * reconnect timer is already pending. It exists only to guarantee that no
   * unforeseen path (a future refactor, an exotic transport) can leave the
   * client silently and permanently disconnected, which is the exact failure the
   * self-rescheduling catch was added to prevent. The watchdog is the last line
   * of defense behind it.
   */
  private tickWatchdog(): void {
    if (
      this.currentState === "closed" &&
      !this.closedByHost &&
      this.reconnectTimer === null
    ) {
      this.scheduleReconnect("watchdog: no reconnect pending");
    }
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
      const socket = this.socket;
      if (!socket) return;
      try {
        socket.close();
      } catch {
        // The close event below is the desired path; if close throws, run it
        // ourselves so liveness still recovers the session.
      }
      this.handleClose(socket, { code: 4000, reason: "liveness timeout" });
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
    // Record the state before notifying so the watchdog reads the authoritative
    // current value, independent of any (possibly throwing) subscriber.
    this.currentState = s;
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
