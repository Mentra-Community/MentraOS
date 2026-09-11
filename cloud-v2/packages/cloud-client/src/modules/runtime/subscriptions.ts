/**
 * @fileoverview The audio subscription REST writer, with the version counter.
 *
 * Subscriptions move over REST (not the WebSocket) so the client gets
 * request/response and the WebSocket stays a downstream push channel. This class
 * owns the full-replace semantics: every change ships the entire desired set,
 * not a diff, so the cloud never has to reconcile partial updates.
 *
 * Two fields exist purely to survive the legacy scars the cloud guards against:
 *   - `version`: a monotonic counter the client bumps on every change, so the
 *     cloud can discard an out-of-order arrival (a retried or reordered write
 *     cannot clobber a newer set).
 *   - `sessionId`: tied to the current session from `connection.ack`, so a write
 *     from a stale session is ignored by the cloud.
 *
 * See docs/issues/002-cloud-runtime/audio/wire.md ("Subscription REST endpoint")
 * and docs/issues/004-cloud-client/design.md ("Subscriptions").
 */
import type { HttpClient } from "../../http";
import { systemTimers, type CloudClientTimers } from "../../timers";
import type { AudioSubscription } from "@mentra/cloud-protocol";

/** The REST path the cloud exposes for the full-replace subscription write. */
const SUBSCRIPTIONS_PATH = "/api/audio/subscriptions";

export interface SubscriptionsDeps {
  http: HttpClient;
  timers?: CloudClientTimers;
}

export class Subscriptions {
  private readonly http: HttpClient;
  private readonly timers: CloudClientTimers;

  /**
   * The last set we sent. Kept so a reconnect can re-send the exact same set at
   * the current version without the caller having to remember it.
   */
  private current: AudioSubscription[] = [];

  /**
   * The monotonic version of the set above. Starts at 0 so the first real
   * `set()` ships version 1; the cloud treats higher as newer.
   */
  private version = 0;

  constructor(deps: SubscriptionsDeps) {
    this.http = deps.http;
    this.timers = deps.timers ?? systemTimers;
  }

  /**
   * The current desired subscription set (the last one `set()` recorded).
   *
   * Read by the connection's `initPayload` so a (re)connect's `connection.init`
   * carries the live set as `audio.initialSubscriptions`. That makes the cloud
   * seed the new session's subscription key NON-EMPTY at handshake, so the
   * reconnected session transcribes atomically — without depending on the
   * follow-up REST resend landing (whose control-stream nudge can be missed by a
   * just-created `$`-positioned consumer group on the new owner pod). Returns a
   * copy so a caller cannot mutate our cached set.
   */
  currentSet(): AudioSubscription[] {
    return [...this.current];
  }

  /**
   * Replace the cloud's subscription set with `subs` for this session.
   *
   * Bumps the version on every call (even when the set is unchanged) so the
   * cloud always sees a strictly increasing version and applies the latest. The
   * full set is sent each time because the contract is full-replace, not a diff:
   * the cloud holds the authoritative set and we overwrite it wholesale.
   */
  async set(subs: AudioSubscription[], sessionId: string): Promise<void> {
    // Snapshot the set so a later in-place mutation by the caller cannot change
    // what we believe we sent (and would re-send on reconnect).
    this.current = [...subs];
    this.version += 1;
    await this.send(sessionId);
  }

  /**
   * Re-send the current set at the current version for a (possibly new) session.
   *
   * Used on reconnect: the cloud may have a fresh session whose subscription set
   * is empty, so without this re-send a live transcription would silently stop.
   * We do NOT bump the version here, because this is a replay of the same
   * logical set rather than a new change; the new `sessionId` is what makes the
   * write land against the reconnected session.
   */
  async resend(sessionId: string): Promise<void> {
    await this.send(sessionId);
  }

  /**
   * Ship the current set, retrying REJECTED writes (not just transport
   * failures). A "stale-session" rejection means a half-open ghost session
   * still holds the cloud's subscription record — typically the app's previous
   * process after a force-stop/crash, whose socket died without a close frame.
   * The cloud refuses to hand the record to us while the ghost still looks
   * alive, but its liveness window lapses within ~45s and the cloud then
   * accepts a takeover write — so a patient retry self-heals where a
   * fire-and-forget write would leave transcription silently dead until the
   * next reconnect. "stale-version" adopts the cloud's authoritative version
   * and retries once above it.
   */
  private async send(sessionId: string): Promise<void> {
    const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 45_000];
    for (let attempt = 0; ; attempt++) {
      // The full-replace PUT is idempotent: replaying it lands the same state,
      // so the HTTP helper may retry it on transient network failure too.
      const res = await this.http.put<{
        applied: boolean;
        version: number;
        reason: string | null;
      }>(
        SUBSCRIPTIONS_PATH,
        {
          subscriptions: this.current,
          sessionId,
          version: this.version,
        },
        { idempotent: true },
      );
      if (res?.applied !== false) return;

      if (res.reason === "stale-version") {
        // The cloud holds a newer version for this session (e.g. a replayed
        // older write). Adopt its counter and go strictly above it.
        this.version = Math.max(this.version, res.version) + 1;
        continue;
      }

      const delay = RETRY_DELAYS_MS[attempt];
      if (res.reason !== "stale-session" || delay === undefined) return;
      await new Promise<void>((resolve) => this.timers.setTimeout(resolve, delay));
    }
  }
}
