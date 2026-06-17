/**
 * @fileoverview Token state for `cloud.auth`: the in-memory access token, the
 * persisted refresh token, and a single-flight lock.
 *
 * Split out from `auth.ts` so the storage details and the de-duplication lock
 * live in one place. Two facts drive the design:
 *
 *  - Only the refresh token is persisted (through the injected `KeyValueStore`),
 *    so a relaunch can re-mint an access token without a fresh login. The access
 *    token stays in memory: it is short-lived (~1h) and re-derivable.
 *  - Refreshes and miniapp-token mints must be de-duplicated. A reconnect storm
 *    can ask for a token from many callers at once; without the lock, each would
 *    fire its own `/refresh` and the rotation would invalidate the others'.
 *
 * Security: the access token is never written to storage and neither token is
 * ever logged.
 *
 * See docs/issues/004-cloud-client/design.md ("cloud.auth").
 */
import type { KeyValueStore } from "../../transports";
import { decodeClaims } from "./jwt";

/**
 * Storage key for the persisted refresh token.
 *
 * Namespaced so it cannot collide with anything else a host keeps in the same
 * secure store.
 */
const REFRESH_TOKEN_KEY = "mentra.cloud-client.refreshToken";

/** The access token plus its Unix-seconds expiry, held in memory only. */
interface AccessTokenState {
  accessToken: string;
  exp: number;
}

export class TokenStore {
  private readonly storage: KeyValueStore;

  /** The current access token, or null before the first exchange/refresh. */
  private access: AccessTokenState | null = null;

  /**
   * In-flight operations keyed by a caller-chosen string.
   *
   * Holding the promise (not just a boolean) lets every concurrent caller await
   * the same result, which is the whole point of single-flight here.
   */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(deps: { storage: KeyValueStore }) {
    this.storage = deps.storage;
  }

  /**
   * The current in-memory access token and its expiry, or null if none.
   *
   * Synchronous because the access token never round-trips through storage; the
   * caller (auth) decides whether it is still fresh using `exp`.
   */
  current(): AccessTokenState | null {
    return this.access;
  }

  /**
   * Record a freshly exchanged or refreshed token pair.
   *
   * The access token is decoded for its `exp` so callers can check freshness
   * without re-parsing; the refresh token is persisted so it survives a
   * relaunch. We read `exp` here (rather than in the caller) to keep all the
   * token-state bookkeeping in one place.
   */
  async save(tokens: { accessToken: string; refreshToken: string }): Promise<void> {
    this.access = {
      accessToken: tokens.accessToken,
      exp: decodeClaims(tokens.accessToken).exp,
    };
    await this.storage.set(REFRESH_TOKEN_KEY, tokens.refreshToken);
  }

  /**
   * The persisted refresh token, or null if none has ever been saved.
   *
   * Read from storage every time (not cached) so a token rotated by another
   * process or restored out of band is always the one used.
   */
  refreshToken(): Promise<string | null> {
    return this.storage.get(REFRESH_TOKEN_KEY);
  }

  /**
   * Drop only the in-memory access token, keeping the persisted refresh token.
   *
   * Called when the cloud rejects an access token the store still believes is
   * fresh (clock skew, or a mid-session revoke surfaced as AUTH_EXPIRED): the
   * next `current()` returns null so the caller refreshes against the still-good
   * refresh token, rather than handing back the rejected token again.
   */
  invalidateAccess(): void {
    this.access = null;
  }

  /**
   * Clear all token state, in memory and in storage.
   *
   * Called when the refresh token is dead, so a later attempt does not keep
   * presenting a known-bad token to the cloud.
   */
  async clear(): Promise<void> {
    this.access = null;
    await this.storage.delete(REFRESH_TOKEN_KEY);
  }

  /**
   * Run `fn` once even if several callers ask for the same `key` at the same
   * time, handing all of them the single result.
   *
   * The entry is removed once the work settles (whether it resolves or rejects)
   * so the next call after completion starts fresh rather than replaying a stale
   * promise. A rejection propagates to every waiter, which is correct: if a
   * refresh failed, all callers waiting on it should see that failure.
   */
  singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;

    const promise = (async () => {
      try {
        return await fn();
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, promise);
    return promise;
  }
}
