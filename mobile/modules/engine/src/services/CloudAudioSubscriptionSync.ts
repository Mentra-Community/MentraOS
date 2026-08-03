/**
 * Tracks cloud-audio subscription writes so LocalMiniappRuntime can dedupe
 * successful writes without losing retryability after transient Core/network
 * failures.
 *
 * Failure mode this protects:
 * 1. Local captions subscribes to transcription.
 * 2. The first Cloud V2 `PUT /api/audio/subscriptions` throws while the socket
 *    is reconnecting or Core is briefly unreachable.
 * 3. A reconnect/resync recomputes the same desired subscription set.
 *
 * If we mark the set as "last applied" before the PUT succeeds, step 3 is
 * incorrectly deduped and captions can wait forever even though Cloud V2 later
 * reconnects. So `begin()` only blocks exact duplicates while a write is in
 * flight; only `succeeded()` promotes that key to the applied state.
 */
export class CloudAudioSubscriptionSync {
  private lastAppliedKey = ""
  private pendingKey = ""

  public begin(nextKey: string): boolean {
    // Exact duplicate of the write already in flight — nothing to do.
    if (nextKey === this.pendingKey) {
      return false
    }
    // Matches the last successfully applied set, but ONLY skip when nothing
    // else is in flight. If a different write is pending (e.g. desired went
    // fr-FR -> [] -> fr-FR while the [] write is still on the wire),
    // lastAppliedKey is stale: it names what was applied BEFORE the in-flight
    // write lands. Skipping here would drop the re-subscribe and strand the
    // cloud on the intermediate (empty) set — captions silently die on any
    // rapid A -> B -> A subscription churn. The cloud's own version counter
    // resolves ordering between the concurrent writes, so sending both is safe.
    if (nextKey === this.lastAppliedKey && this.pendingKey === "") {
      return false
    }
    this.pendingKey = nextKey
    return true
  }

  public succeeded(key: string): void {
    if (this.pendingKey === key) {
      this.pendingKey = ""
    }
    this.lastAppliedKey = key
  }

  public failed(key: string): void {
    if (this.pendingKey === key) {
      this.pendingKey = ""
    }
  }
}
