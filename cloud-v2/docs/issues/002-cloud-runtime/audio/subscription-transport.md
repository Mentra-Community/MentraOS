# Audio Subscription Transport: WS vs REST

**Status:** Decided, **Option 2a** (REST endpoint, with the change delivered to
the owning worker as a control entry in the user's audio stream, no pub/sub). The
options analysis below is kept for the record. This doc chose how the client tells
the cloud which audio streams (transcription, translation) it wants in v2.

## Decision

**Option 2a.** Subscriptions are a REST endpoint (`PUT /v2/runtime/audio/subscriptions`,
full-replace, `epoch` + `version` guards). The handler (any pod) writes the
authoritative set to the `{user:X}` Redis key and `XADD`s a `subscriptions-changed`
control entry into the user's existing `{user:X}:audio` stream; the owning worker
consumes it in order via its existing `XREADGROUP`, with `XAUTOCLAIM` failover
replay. No pub/sub is introduced, so the 003 "no pub/sub in the audio path"
commitment holds. `connection.init.audio.initialSubscriptions` seeds the key at
session start. This is what `cloud.runtime.setSubscriptions` calls.

## Scope

Only the transport and propagation of **audio subscriptions** (transcription,
translation). Not the subscription data model (already settled), not managed
photo or managed stream (those are plain stateless REST with no coupling to the
audio session). The data model is fixed by
[`spec.md`](./spec.md#subscription-model): a structured discriminated union,
full-set replace (not deltas), structural identity after canonicalization. That
does not change in either option here.

## Why this is open

The prior 003 design put subscriptions on the WebSocket on purpose, to avoid any
cross-pod coordination (see "Option 1"). A newer direction wants client-initiated
commands to be REST (request/response, retries, tracing, and a WebSocket that is
mostly a downstream push channel). That is a real ergonomic win but it reintroduces
the cross-pod problem the WS approach sidesteps. This doc lays out both so we can
choose deliberately.

## Invariants any option must satisfy

These come from the prior cloud-v2 specs and from scars in the legacy cloud
(`SUBSCRIPTION-CONSISTENCY.md`, `subscription-system-redesign.md`).

1. **Full-set replace.** Client sends the complete desired set; cloud diffs and
   reconciles. Last-writer-wins is therefore safe (with ordering, see #2).
2. **Ordering across reconnects.** Legacy flapped because updates applied
   out of order, and because a stale or empty snapshot arriving after a
   reconnect overwrote good state. The fix legacy converged on is
   **epoch (per connection/session) + version (monotonic per snapshot)**: ignore
   writes from a stale epoch, discard out-of-order versions. Any option that lets
   more than one writer touch the set must carry epoch + version.
3. **No empty-wipe.** A late or retried empty set must not clobber a live
   non-empty set. The epoch + version guard plus explicit-clear semantics cover
   this.
4. **Single source of truth, computed on demand.** Legacy added derived caches
   for O(1) reads, then removed them because caches drift. The worker should
   reconcile its provider set from the full subscription set each time, not from
   a cached delta.
5. **Cluster-mode safety.** All per-user Redis keys use the `{user:X}` hash tag
   so they land on one shard (matches the audio stream and ownership keys).
6. **Failover continuity.** On pod death or reconnect, the new owner must end up
   with the correct subscription set without dropping transcripts (works with the
   existing `XAUTOCLAIM` replay of buffered audio).
7. **Cloud passive on liveness.** Unchanged. The client owns reconnect; the cloud
   never tears down on silence.

## Option 1: Subscriptions on the WebSocket (the prior 003 design)

The client sends subscriptions on the WS: the initial set in the handshake
(`connection.init` / `session-setup`), and any change as a mid-session WS message.
The pod holding the WS is, by construction, the owner pod and runs the user's
worker, so the main thread forwards the set to the worker by in-process
`postMessage`. Source of truth is the mobile client, re-asserted on every
(re)connect.

```
client --WS connection.init {subs}--> owner pod main thread --postMessage--> worker
client --WS subscriptions.update {subs}--> owner pod main thread --postMessage--> worker
(on reconnect/failover: client re-sends the full set to the new owner)
```

**Pros**
- Zero cross-pod coordination. No Redis subscription key, no pub/sub. Matches the
  003 commitment that pub/sub is not used in the audio path.
- Failover is trivially correct: the client re-asserts the full set to whichever
  pod it reconnects to. No stale Redis state to reconcile or expire.
- Ordering is natural: one ordered WS connection per session. Epoch is just the
  connection. Less machinery to get #2 and #3 right.

**Cons**
- The WS is no longer mostly downstream. The client initiates subscription
  changes over it, against the "WS for push, REST for commands" preference.
- No request/response for a subscription change. The client cannot easily get a
  per-update ack, rejected list, or retry semantics the way a REST call gives.
- Couples the subscription API to the WS lifecycle (must be connected to change
  subscriptions; a change during a reconnect blip has to wait for the new socket).

## Option 2: Subscriptions over REST (decoupled from the WS pod)

The client sends the full set to a stateless REST endpoint that any pod can
serve. The handler writes the authoritative set to a `{user:X}` Redis key
(guarded by epoch + version) and then makes sure the owner's worker learns about
it. The REST handler never needs to reach the owner pod directly.

```
PUT /v2/runtime/subscriptions { subscriptions, epoch, version }
   -> any pod: validate, CAS-write {user:X}:subs (reject stale epoch/older version)
   -> signal the owner (see 2a / 2b)
   -> owner worker reconciles from the full set
```

The owner reads the key as the source of truth when it claims the user (fresh
connect, failover, worker restart), so it always has the current set even if it
missed a live signal. The key's lifetime is tied to the session (TTL refreshed by
the owner, or deleted on clean disconnect) so stale subscriptions do not linger.
`connection.init` can still carry an initial set to seed the key atomically with
session creation and close the cold-start gap.

There are two ways to signal the owner. This is the sub-decision inside Option 2.

### 2a: Control entry in the user's existing stream (no pub/sub)

The REST handler `XADD`s a `subscriptions-changed` control entry into the user's
existing `{user:X}:audio` stream (or a sibling `{user:X}:control` stream). The
owner worker already runs `XREADGROUP` on that stream, so it receives the control
entry **in order with the audio**, on the **same shard**, and inherits the same
`XAUTOCLAIM` failover replay. No new fan-out primitive is introduced.

- **Pros:** reuses existing machinery; honors the "no pub/sub" commitment;
  in-order with audio; failover replay for free; same-shard.
- **Cons:** mixes a control message into an audio stream (or adds a second
  stream to manage); the worker must branch on entry type. Slightly unusual to
  put control data in an audio stream.

### 2b: Sharded pub/sub nudge

The REST handler writes the key and publishes a lightweight "changed" nudge on
the user's shard (`SPUBLISH`). The owner subscribes (`SSUBSCRIBE`) and re-reads
the key on the nudge. Key is truth, pub/sub is only a nudge; the worker also
re-reads on startup and on ownership acquisition so a missed message cannot leave
it stale.

- **Pros:** clean separation of audio vs control; conventional pattern.
- **Cons:** adds the pub/sub primitive the 003 spec deliberately avoided; nudge
  can be missed (mitigated by always reconciling from the key); one more thing to
  reason about under cluster mode.

**Pros (Option 2 overall)**
- Client-initiated changes are REST: request/response, ack with a rejected list,
  retries, standard Bearer auth, per-request tracing.
- WS stays mostly downstream.
- Subscriptions can be changed independent of WS connection state (subject to an
  owner existing to act on them).

**Cons (Option 2 overall)**
- Reintroduces cross-pod coordination and the consistency hazards legacy fought:
  needs epoch + version, explicit-clear semantics, and key-lifetime management.
- More moving parts than Option 1 (a key, a signal channel, reconcile-on-takeover).
- Two writers of the set (WS init seed + REST updates) must agree via epoch +
  version.

## Comparison

| Dimension | Option 1: WS | Option 2a: REST + stream entry | Option 2b: REST + pub/sub |
| --- | --- | --- | --- |
| Cross-pod coordination | none | via existing stream | via pub/sub |
| New Redis primitive | none | none (reuses stream) | sharded pub/sub |
| Honors "no pub/sub in audio path" | yes | yes | no |
| Client request/response + ack | no | yes | yes |
| WS mostly downstream | no | yes | yes |
| Failover correctness | client re-send | key + XAUTOCLAIM replay | key + reconcile-on-takeover |
| Ordering machinery needed | minimal (one socket) | epoch + version | epoch + version |
| Moving parts | fewest | medium | most |

## Cross-cutting requirements (whichever we pick)

- If more than one writer can touch the set (any REST option), carry
  **epoch + version** and reject stale epoch / older version. Reply with an ack
  that includes a `rejected[]` list.
- Define **explicit clear**: an empty set is honored only when it is the latest
  version for the current epoch, so a stale empty cannot wipe a live set.
- Worker reconciles from the **full set**, no derived caches across the boundary.
- All keys hash-tagged `{user:X}`.

## Recommendation (lean, not a decision)

If we keep the WS mostly downstream is a hard product goal, **Option 2a** is the
best fit: it gives the REST ergonomics without adding the pub/sub the audio
spec rejected, and it reuses the per-user stream we already operate. If we value
the least machinery and trust the client to re-assert on reconnect, **Option 1**
is materially simpler and is what the prior design already specifies.

Option 2b is only preferable if we end up wanting general cross-pod control
fan-out for other reasons, at which point a real pub/sub channel pays for itself.

## Open questions

1. Is "WS mostly downstream" a hard goal, or a preference we would trade for
   Option 1's simplicity?
2. If Option 2: stream control entry in `{user:X}:audio`, or a dedicated
   `{user:X}:control` stream?
3. Epoch source: the WS session id from `connection.ack`, or a client-generated
   per-connection nonce echoed on every REST call?
4. Subscription key lifetime: TTL refreshed by the owner, or explicit delete on
   clean disconnect, or both?

## References

- [`spec.md`](./spec.md#subscription-model) (subscription model, open question #2)
- [`design.md`](./design.md) (Scenario 2 subscription update, Scenario 3/4
  failover, the "no pub/sub" note, hash-tag keys)
- `cloud/packages/cloud/src/services/session/docs/SUBSCRIPTION-CONSISTENCY.md`
  (out-of-order and empty-wipe scars, epoch + version proposal)
- `cloud/packages/cloud/src/services/session/SubscriptionManager.ts`
  (single-source-of-truth, no-caches, full-set replace, per-app serialization)
- [`../protocol.md`](../protocol.md) (the v2 wire
  contract this feeds into)
