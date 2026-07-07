# Cloud v2 Audio Path Design

**Status:** Design proposal. Pending team review.

## Why this doc

Implementation-level companion to [`spec.md`](./spec.md). The spec
committed to stateless ingress + Redis-routed ownership + workers per
pod. This doc specifies the concrete Redis keys, command sequences,
typed message protocols between threads, packet header format, and
walkthroughs that prove the design hangs together.

Conventions used throughout:

- Every Redis command appears with its plain-English meaning right
  next to it. No looking things up.
- Every flag (`NX`, `XX`, `EX`, `MAXLEN ~`, etc.) is glossed inline.
- Numbered steps, no fake timing numbers. Real numbers come from
  measurement; until then we describe the sequence, not the speed.

## Concepts primer (additions specific to this doc)

The general terms (pod, worker, Redis stream, consumer group, TTL, UDP, LC3, PCM) are
glossed in [`../architecture.md`](../architecture.md). The Redis-command-level terms
used here:

- **`XADD`.** Redis Stream command. Appends an entry to a stream.
  Plain English: "add a new message to this stream's tail."
- **`XREADGROUP`.** Read from a stream as a member of a consumer
  group. Plain English: "give me the next unread entries, marked as
  delivered to me."
- **`XACK`.** Acknowledge an entry as processed. Plain English:
  "I've handled this entry; the group can stop tracking it as
  pending."
- **`XAUTOCLAIM`.** Take over pending entries from another consumer
  in the group. Plain English: "any entries that another consumer
  was delivered but didn't ack and haven't been retried in a while,
  give them to me instead."
- **`SET NX EX <n>`.** Set the key only if it doesn't already exist,
  with a TTL of n seconds.
- **`SET XX EX <n>`.** Set the key only if it already exists, with a
  TTL of n seconds. (Used to refresh.)
- **`DEL`.** Delete a key explicitly.

## Redis data shape

Keys, structures, TTLs, retention.

### Per-user keys

```
{user:X}:owner                    STRING
  Value: "<podHostname>:<workerIdx>"   e.g., "cloud-v2-cloud-abc123-dwcwn:3"
  TTL: 5 seconds; refreshed every 1.5s by the owner

{user:X}:audio                    STREAM
  Entries: { payload: <bytes>, ts: <ms>, ingress: <podHostname> }
  Retention: MAXLEN ~ 1000 (~20s at 50 packets/sec)
  Consumer group: "audio-workers"
  Consumer names: "<podHostname>:<workerIdx>"
```

The `{user:X}` hash tag is critical for cluster mode: all keys for a
user land on the same shard. Operations stay within one shard.

### Pod-level keys

```
pods:heartbeat:<podHostname>       STRING
  Value: <timestamp-ms> (value is informational; presence is the signal)
  TTL: 3 seconds; refreshed every 1s
```

### Why these specific values

- **Owner TTL 5s, refresh 1.5s.** Three refresh attempts before
  expiry; can absorb 2 transient hiccups. 5s is the worst-case
  detection delay if a pod dies the instant after a refresh.
- **Pod heartbeat TTL 3s, refresh 1s.** Same logic, faster cadence
  because pod-level signal is broader.
- **Stream retention `MAXLEN ~ 1000`.** Approximate trim
  (`~`) lets Redis batch the trim work for throughput; nominal cap
  ~1000 entries, may briefly exceed during high write rates. At 50
  packets/sec per user, ~20 seconds of buffered audio. Comfortably
  above the 10s recovery target.

## Redis operations table

Every operation in the system, with the command and plain English.

| Operation | Redis command | Plain English |
| --- | --- | --- |
| Pod startup | (none), begin heartbeat loop | "Start refreshing my pod heartbeat" |
| Heartbeat refresh (every 1s) | `SET pods:heartbeat:<pod> <ts> EX 3` | "Set my heartbeat to 'now' and auto-delete in 3s" |
| Phone WS connects → claim user | `SET {user:X}:owner "<pod>:<worker>" NX EX 5` | "Try to set the owner key, but only if nobody else has set it. Expire in 5s." |
| Claim refresh (every 1.5s) | `SET {user:X}:owner "<pod>:<worker>" XX EX 5` | "Update the owner key to refresh its TTL, but only if it still exists (i.e., we still own it). Expire in 5s." |
| Phone WS disconnects → release | `DEL {user:X}:owner` | "Delete the owner key, freeing up the user for another pod to claim." |
| Ingress UDP packet for user X | `XADD {user:X}:audio MAXLEN ~ 1000 * payload <bytes> ts <ms> ingress <pod>` | "Append a new entry to the audio stream. Auto-trim to roughly 1000 entries. Let Redis assign the entry ID (`*`)." |
| Worker (via main thread) consumes audio | `XREADGROUP GROUP audio-workers <pod>:<worker> COUNT 100 BLOCK 1000 STREAMS {user:X}:audio >` | "As consumer `<pod>:<worker>` in the `audio-workers` group, read up to 100 new entries from the stream, blocking up to 1 second if there are none. `>` means 'only entries not yet delivered to any consumer'." |
| Acknowledge an entry | `XACK {user:X}:audio audio-workers <message-id>` | "Mark this entry as processed; the group can stop tracking it as pending." |
| New owner takes over | `XAUTOCLAIM {user:X}:audio audio-workers <new-pod>:<new-worker> 0 0-0` | "Claim any entries that other consumers were delivered but haven't acked. The `0 0-0` means 'any age, starting from the very beginning'." |
| Then read forward | `XREADGROUP GROUP audio-workers <new-pod>:<new-worker> ... STREAMS {user:X}:audio >` | (same as above, now reading new entries on the new consumer) |
| Pod graceful shutdown | for each owned user: `DEL {user:X}:owner`; then stop heartbeat refresh | "Release every ownership claim, stop heartbeating; another pod will pick up users on reconnect." |

## Claim semantics walkthrough

The three SET variants cover the whole ownership story:

**1. Initial claim (when phone WS first connects to a pod):**

```
SET {user:abc}:owner "cloud-v2-cloud-fk7ss:3" NX EX 5
```

Plain English: "Try to set this user's owner key. The `NX` flag means
'only succeed if no one else has set this key.' The `EX 5` means
'auto-delete in 5 seconds.' Returns `OK` on success, or `nil` if
another pod owns this user."

If `nil` is returned, the phone client retries after a brief backoff
,  eventually the prior owner's TTL expires and the new claim
succeeds.

**2. Refresh (every 1.5s while owning):**

```
SET {user:abc}:owner "cloud-v2-cloud-fk7ss:3" XX EX 5
```

Plain English: "Update the owner key, but only if it already exists.
The `XX` flag is the opposite of `NX`. Reset the 5s expiry."

If `nil` is returned, **we lost the claim**, another pod has it. The
worker should immediately stop processing audio for this user and
release its in-memory state.

**3. Release (on clean disconnect):**

```
DEL {user:abc}:owner
```

Plain English: "Delete the owner key. Another pod can claim
immediately without waiting for TTL."

## Worker dispatch protocol (typed messages)

Bun's `Worker` API; messages between main thread and worker via
`postMessage`. Audio buffers are transferred (zero-copy) using the
`Transferable` mechanism.

### Type definitions

```ts
import type { TranscriptionData, TranslationData, AudioSubscription } from "@mentra/sdk";

// Codec config from session-setup (immutable for the session)
type AudioCodecConfig =
  | { kind: "pcm" }
  | { kind: "lc3"; sampleRate: number; frameMs: number; bitrate: number };

// What the main thread tells the worker to set up at session start
type UserAssignment = {
  userId: string;
  codec: AudioCodecConfig;
  subscriptions: AudioSubscription[];
};

// Updated subscriptions mid-session (worker reconciles)
type SubscriptionUpdate = {
  userId: string;
  subscriptions: AudioSubscription[];
};

// Messages from main thread to worker
type MainToWorkerMessage =
  | { kind: "user-assigned"; assignment: UserAssignment }
  | { kind: "user-subscriptions-changed"; update: SubscriptionUpdate }
  | { kind: "audio-chunk"; userId: string; chunk: ArrayBuffer }
  | { kind: "user-released"; userId: string }
  | { kind: "shutdown" }
  | { kind: "heartbeat-ping"; sentAtMs: number };

// Messages from worker to main thread
type WorkerToMainMessage =
  | { kind: "transcript"; result: TranscriptionData }
  | { kind: "translation"; result: TranslationData }
  | { kind: "user-release-acked"; userId: string }
  | { kind: "worker-error"; userId?: string; reason: string; recoverable: boolean }
  | { kind: "heartbeat-pong"; sentAtMs: number; activeUserCount: number };
```

### Main thread loop

```ts
import { hostname } from "node:os";
const POD_HOSTNAME =
  process.env.NODE_ENV === "production"
    ? hostname()
    : `local-${hostname()}-${process.pid}`;

const audioWorker = new Worker(new URL("./audio-worker.ts", import.meta.url));

audioWorker.onmessage = (messageEvent: MessageEvent<WorkerToMainMessage>) => {
  const message = messageEvent.data;
  switch (message.kind) {
    case "transcript":
      deliverTranscriptToPhone(message.result);
      break;
    case "translation":
      deliverTranslationToPhone(message.result);
      break;
    case "user-release-acked":
      userToWorker.delete(message.userId);
      break;
    case "worker-error":
      logger.error({ userId: message.userId, reason: message.reason });
      if (!message.recoverable) replaceWorker(audioWorker);
      break;
    case "heartbeat-pong":
      recordHeartbeat(message.sentAtMs, message.activeUserCount);
      break;
  }
};

function dispatchAudioChunk(userId: string, chunk: ArrayBuffer): void {
  const workerIdx = userToWorker.get(userId);
  if (workerIdx === undefined) return;

  const msg: MainToWorkerMessage = { kind: "audio-chunk", userId, chunk };
  workers[workerIdx].postMessage(msg, [chunk]);
  // After postMessage with chunk as transferable, chunk.byteLength is 0
  // in this thread, ownership has moved to the worker.
}

function assignUserToWorker(assignment: UserAssignment): void {
  const workerIdx = hashUserId(assignment.userId) % workers.length;
  userToWorker.set(assignment.userId, workerIdx);

  const msg: MainToWorkerMessage = { kind: "user-assigned", assignment };
  workers[workerIdx].postMessage(msg);
}
```

### Worker loop

```ts
self.onmessage = (messageEvent: MessageEvent<MainToWorkerMessage>) => {
  const message = messageEvent.data;
  switch (message.kind) {
    case "user-assigned":
      initUser(message.assignment);
      break;
    case "user-subscriptions-changed":
      reconcileSubscriptions(message.update);
      break;
    case "audio-chunk":
      processAudioChunk(message.userId, message.chunk);
      break;
    case "user-released":
      tearDownUser(message.userId);
      postToMain({ kind: "user-release-acked", userId: message.userId });
      break;
    case "heartbeat-ping":
      postToMain({
        kind: "heartbeat-pong",
        sentAtMs: message.sentAtMs,
        activeUserCount: countActiveUsers(),
      });
      break;
    case "shutdown":
      drainAndExit();
      break;
  }
};

function postToMain(message: WorkerToMainMessage): void {
  self.postMessage(message);
}
```

### Transferable usage

`postMessage(msg, [chunk])` with `chunk` as an `ArrayBuffer` in the
transfer list means Bun moves the buffer's backing memory to the
worker rather than copying it. After the call, `chunk.byteLength`
is 0 in the sender. The receiver gets full ownership.

Plain English: "Don't copy the bytes; hand them over directly. After
this call, my side can't read them anymore."

This is the zero-copy path. Without it, every audio packet (~4KB)
gets structured-cloned, which adds CPU and GC pressure.

### Worker lifecycle policy

- **Spawn at pod startup.** `N = numCores - 1` (one core reserved
  for main thread, networking, K8s sidecar overhead).
- **Replace on crash.** Main thread receives `exit` event, spawns a
  fresh worker at the same index, reassigns affected users by
  re-running the `user-assigned` flow for each.
- **Heartbeat to detect hang.** Main thread sends
  `{ kind: "heartbeat-ping" }` every 1 second; worker replies with
  `heartbeat-pong`. After 3 consecutive missed pongs, main thread
  treats the worker as dead, terminates it, spawns replacement.
- **Graceful drain on shutdown.** Main thread sends
  `{ kind: "shutdown" }`; worker stops accepting new audio, finishes
  in-flight transcripts, exits.

## Cloud is passive on connection liveness

**Load-bearing invariant.** Cloud-v2 audio never closes a WebSocket because
of inactivity. No `idleTimeout` short enough to fire on silence, no
server-initiated pings driving a close, no VAD-aware disconnect logic.
The client owns connection liveness.

How the responsibility splits:

- **Client.** Sends `{"type":"ping"}` on a short interval (5 seconds in
  the v1 mobile SDK). If a `{"type":"pong"}` doesn't arrive within a
  timeout (5 seconds), the client closes its WS and reconnects.
- **Cloud.** Responds to client pings with pongs. That's all it does
  for liveness. The cloud's only triggers for releasing an ownership
  claim are the WS `close` event (client closed) or the Redis TTL
  expiring (pod died).

Why so cautious about this: v1 burned weeks debugging a "the WS keeps
dying after ~60 seconds of silence" symptom. Root cause was Kubernetes
nginx-ingress's `proxy-send-timeout: 60s` default, which closes the
connection when the **client** is silent, server-initiated pings only
reset the server→client direction and don't help. Once VAD started
suppressing audio during silence, the upstream pipeline of "client
sends nothing" → "ingress kills connection" → "session torn down" → "apps
killed and respawned" became a cascade. See v1 issues
`034-ws-liveness/` and `035-nginx-ws-timeout/`. The fix that worked was
client-driven app-level pings + lifting the ingress timeout to one
hour, same model we carry forward in cloud-v2.

What this rules out, even when it looks tempting:

- Closing a WS because VAD has reported silence for N seconds.
- Closing a WS because no UDP packets have arrived for N seconds.
- Setting `Bun.serve`'s `idleTimeout` to anything that fires during
  ordinary silence intervals (defaults to 120s in Bun; we either leave
  it alone or push it up).
- Tearing down provider connections (Soniox, etc.) on silence, pause
  them instead. v1 issue `044-cloud-prod-error-storm/` covered the
  same lesson for the provider layer.

## Audio packet header format

**Carry forward unchanged from v1.** The v1 packet format already
includes a session identifier in its header, supports encryption (per
v1's issue 027), and is what the existing mobile clients emit. We're
not redesigning the wire format for v2.

Concretely, this means:

- The header includes a session ID (extracted by the ingress code to
  determine the user)
- Encryption is per v1's existing scheme (see v1's
  `027-udp-audio-encryption/`)
- The payload after the header is LC3-encoded audio (current default)
  or PCM (legacy fallback)
- Packet sequence numbers and any other v1 fields are preserved

## Dual ingress transport (UDP + WS)

The same packet payload arrives via two channels:

### UDP path

Standalone UDP socket on the audio package's UDP port. Pure datagram
ingress. Used as the primary transport in production.

1. Receive a UDP datagram on the audio service's UDP port.
2. Parse the header to extract the session/user ID.
3. Validate the packet.
4. `XADD` the packet to the user's audio stream.
5. Done. No interpretation of the payload at the ingress layer.

### WebSocket binary path

The per-user transcript-delivery WebSocket (per OS-1513) is
bidirectional. Inbound binary frames on that same WS connection are
treated as audio packets:

1. Receive a binary message on the per-user WS.
2. Same userId is already known from the WS auth handshake (no header
   parse needed for session ID; the WS connection identifies the user).
3. Optionally validate the packet shape (still v1 format inside).
4. `XADD` the packet to the user's audio stream.
5. Done.

Both paths converge at step 4. The Redis stream entry is identical; the
worker that consumes it has no idea which transport delivered the audio.

This matches v1's existing pattern (`bun-websocket.ts handleGlassesMessage`
routes binary messages into `AudioManager.processAudioData`, same as the
UDP server does).

### When each transport gets used

- **Production**: phone sends audio via UDP. Lower overhead, lower latency.
- **Local dev**: phone sends audio via WS over the existing control
  connection. No NAT / firewall / "what's the laptop's IP" issues.
- **Fallback**: in production, if UDP can't get through (corp network
  blocking UDP, mobile carrier path issues, etc.), phone falls back to WS.

Phone-side transport selection logic lives in the mobile SDK, not cloud.

### Changing the packet format

If/when we want to change the packet format (e.g., add per-packet
metadata or change the encryption scheme), it's a separate spec and
both transports update together.

## Session bootstrap walkthrough

Numbered steps, no fake timings. Walks through what actually happens
when a phone first connects, audio starts flowing, then disconnects.
Failover scenarios follow.

### Scenario 1: Phone connecting fresh

**WebSocket side:**

1. Phone opens WS to the load balancer; LB routes to some pod (call
   it Pod B).
2. Pod B accepts the WS handshake, validates the `cloud-runtime` token
   the phone presented in the connection (per
   [`../../007-runtime-auth-independence/README.md`](../../007-runtime-auth-independence/README.md)).
   On failure: close WS with auth error.
3. Pod B reads the verified user id and `tenantId` from the runtime token.
4. Pod B claims ownership:
   `SET {user:<mentraUserId>}:owner "<podHostname>:<workerIdx>" NX EX 5`.
   On success: continue. On failure (someone else owns): close WS,
   let the phone retry.
5. Phone sends a `session-setup` message over the WS, carrying the
   codec config and initial subscription set.
6. Pod B's main thread picks a worker:
   `workerIdx = hash(mentraUserId) % N`.
7. Pod B records the mapping `userToWorker.set(mentraUserId, workerIdx)`.
8. Pod B sends to the chosen worker:
   `{ kind: "user-assigned", assignment: { userId, codec, subscriptions } }`.
9. Worker initializes: allocates an LC3 decoder for this user, opens
   a Soniox WS for each transcription subscription, sets up
   translation streams for each translation subscription.
10. Pod B starts a refresh loop for this user's ownership claim:
    every 1.5 seconds, run
    `SET {user:<id>}:owner "..." XX EX 5`. If the `XX` set ever
    returns `nil`, log loudly and release the user immediately.
11. Pod B's main thread starts (or already had) a `XREADGROUP` loop
    on `{user:<id>}:audio` as consumer `<podHostname>:<workerIdx>` in
    the `audio-workers` group.

**UDP side, in parallel with the WS side:**

12. Phone starts sending UDP audio packets to the cloud's UDP service.
    Each packet lands on some pod (could be any pod; LB doesn't
    care).
13. Receiving pod (say Pod A or Pod B or Pod C, any of them) parses
    the v1-format packet header, extracts the session/user ID.
14. Receiving pod runs:
    `XADD {user:<id>}:audio MAXLEN ~ 1000 * payload <bytes> ts <ms> ingress <pod>`.
    The packet is now in the Redis Stream.

**Pickup, where the two sides meet:**

15. Pod B's main thread's `XREADGROUP` loop wakes up with the new
    entries.
16. For each entry: main thread looks up which worker owns the user
    (`userToWorker.get(mentraUserId)`), posts a message:
    `{ kind: "audio-chunk", userId, chunk }` with `chunk` as a
    Transferable.
17. Worker decodes LC3 → PCM, feeds the PCM to its Soniox WS.
18. Soniox emits transcription tokens back over its WS.
19. Worker aggregates tokens into a `TranscriptionData` (per the
    types in [`spec.md`](./spec.md)) and posts:
    `{ kind: "transcript", result }` to the main thread.
20. Main thread receives the result, sends it over the phone's WS.
21. Pod B `XACK`s the audio entries it has processed, so the consumer
    group stops tracking them as pending.

**Key property:** steps 12-14 are independent of steps 1-11. Audio
can be flowing into Redis before the WS is fully set up. The buffer
catches the early audio; the worker reads it when it's ready. No
race condition between "WS established" and "audio arriving."

### Scenario 2: Subscription update mid-session

Same user, already connected, the phone wants to add or remove a
subscription.

1. Phone sends the **full new desired set** (not a delta) via a guarded
   REST write — `PUT /api/audio/subscriptions` with its `sessionId` and a
   monotonic `version`. (Locked wire contract; see [`wire.md`](./wire.md).
   `@mentra/cloud-client` posts to this REST path — it is **not** a WS message.)
2. The runtime applies the guarded write to the per-user subscription key,
   then publishes a control-stream nudge the user's worker reads:
   `{ kind: "user-subscriptions-changed", update: { userId, subscriptions } }`.
3. Worker compares the new set to its current set (using structural
   equality after canonicalizing fields like sorting `hints[]` arrays).
4. For each subscription in `current \ new`: tear down its provider
   stream.
5. For each subscription in `new \ current`: spin up a new provider
   stream.
6. Worker continues processing audio; new subscriptions get fed audio
   as soon as their streams are ready.

### Scenario 3: Phone WS drops, reconnects to a different pod

1. Phone's WS to Pod B dies (network blip, app backgrounded, etc.).
2. Pod B's main thread detects the WS close.
3. Pod B sends to the user's worker:
   `{ kind: "user-released", userId }`.
4. Pod B runs `DEL {user:<id>}:owner` to release the ownership claim
   explicitly. (Faster than waiting for TTL.)
5. Worker tears down per-user state (closes Soniox WS, frees decoder),
   posts: `{ kind: "user-release-acked", userId }`.
6. Pod B's main thread removes the user from `userToWorker`.

**Meanwhile**, audio is still being sent up by the phone (if mic is
still hot) and lands on some pod (could be A, B, or C). Whichever
pod receives `XADD`s to `{user:<id>}:audio`. The stream keeps growing.

7. Phone's client-side reconnect logic fires.
8. New WS lands on Pod C (LB picks).
9. Pod C accepts the WS, validates auth, reads `mentraUserId`.
10. Pod C runs
    `SET {user:<id>}:owner "<podC-hostname>:<workerIdx>" NX EX 5`.
    Success (Pod B's release in step 4 freed the key).
11. Phone sends `session-setup` again (subscriptions + codec).
12. Pod C assigns user to a worker, same flow as steps 6-11 in
    Scenario 1.
13. Worker opens a fresh Soniox WS.
14. Pod C's main thread joins the audio stream with `XAUTOCLAIM`:
    `XAUTOCLAIM {user:<id>}:audio audio-workers <podC>:<workerIdx> 0 0-0`.
    This claims any entries that Pod B's consumer was delivered but
    didn't ack (i.e., the audio that arrived after Pod B died /
    during the gap).
15. Pod C reads the claimed entries; dispatches them to its worker.
16. Worker decodes the buffered audio, feeds to the freshly-opened
    Soniox WS in order.
17. Soniox processes the catch-up audio, emits transcripts.
18. Transcripts flow back over the new WS.

**The user perceives:** a brief delay in transcripts. No words
missing. Continuity preserved.

### Scenario 4: Pod crash (no graceful release)

1. Pod B dies suddenly (OOM, K8s kill, hardware fault).
2. The `DEL` in step 4 of Scenario 3 doesn't happen.
3. The ownership claim `{user:<id>}:owner` remains in Redis until
   TTL expiry.
4. Pod B's heartbeat (`pods:heartbeat:<podB-hostname>`) expires in
   ~3 seconds.
5. Phone's WS to Pod B dies (TCP timeout or RST).
6. Phone reconnects, lands on Pod C.
7. Pod C runs
   `SET {user:<id>}:owner "<podC>:<workerIdx>" NX EX 5`.
8. **`NX` fails** because Pod B's claim hasn't expired yet (within
   the 5s TTL window).
9. Pod C closes the WS with a "retry soon" signal (or the phone's
   reconnect logic backs off).
10. Phone retries after a brief backoff (~1-2s).
11. Eventually (at most 5s after Pod B died), the claim expires.
    Pod C's `NX` succeeds.
12. From here, Scenario 3's flow continues from its step 11.

**Recovery time** for pod-crash failover is approximately the
ownership TTL (5s) plus the phone's reconnect attempt cycle (~1-2s).
Comfortably within the <10s budget.

### Scenario 5: Worker crash within a pod

1. Worker 3 on Pod B crashes (uncaught exception, OOM, etc.).
2. Pod B's main thread receives the `exit` event from the worker.
3. Pod B spawns a replacement worker at index 3.
4. For each user that was on the dead worker (from `userToWorker`):
   - Re-send `{ kind: "user-assigned", assignment }` to the new
     worker. The assignment carries everything needed (userId,
     codec, subscriptions).
   - The new worker opens fresh provider connections and resumes.
5. Audio in the Redis Stream that the dead worker didn't ack is
   pending; the new consumer (same name `<podB>:<3>`) sees it on
   its next `XREADGROUP` call automatically because they're the
   same consumer name in the same group.

Wait, there's a subtlety here. The consumer name `<pod>:<worker>` is
the same after worker replacement (worker index 3 is still index 3).
The Redis consumer group treats the new worker as continuing the old
consumer. Pending entries are delivered on next read.

If we want stronger isolation (e.g., spawn the new worker with a
fresh consumer name and `XAUTOCLAIM` from the dead one), that's an
implementation choice. For first cut: same consumer name, since
worker replacement is fast and the consumer group state is local to
Redis anyway.

Worker death recovery: typically <3 seconds.

### Scenario 6: Graceful pod shutdown (rolling deploy)

1. K8s sends `SIGTERM` to Pod B.
2. Pod B's main thread receives the signal, enters drain mode:
   - Stops accepting new WS connections (readiness probe begins
     returning 503).
   - For each currently-owned user:
     - Sends a `session-migrating` message over the WS to give the
       phone a hint to reconnect.
     - Runs `DEL {user:<id>}:owner` to release the claim.
     - Sends `{ kind: "user-released", userId }` to the user's
       worker.
   - Sends `{ kind: "shutdown" }` to all workers.
3. Phones receive the migration hint and immediately reconnect.
   They land on healthy pods (Pod B is no longer in the LB
   rotation because readiness is failing).
4. New pods claim ownership (succeeds because Pod B explicitly
   released).
5. New pods do `XAUTOCLAIM` to inherit any unacked audio.
6. Transcripts resume on the new pods.
7. Pod B waits for in-flight transcripts to finish (with a 10-second
   timeout), then exits cleanly.
8. K8s removes Pod B.

**The user perceives:** essentially nothing. A graceful deploy is
not a failover; it's a planned hand-off. Total disruption is on the
order of how quickly the phone reconnects, typically <1 second.

K8s `terminationGracePeriodSeconds` should be set to match the drain
deadline (10s) plus a small buffer (5s). Total ~15s.

## Capacity sizing (rough)

These are first-order estimates, not measurements. Actual numbers
come from the e2e test suite.

### Per-user load on Redis

- Audio publishes: ~50/sec/user (LC3 at 20ms frames)
- Other reads/writes: negligible (claim refresh every 1.5s, sparse
  metadata)
- Effective: ~55 ops/sec/user

### Redis instance sizing

| Instance | Approx capacity | Use case |
| --- | --- | --- |
| In-cluster Redis pod | dev/experiment only | Local + early test |
| `cache.t4g.medium` (3GB, 2vCPU, burstable) | ~500-1000 users sustained | First prod, low traffic |
| `cache.m7g.large` (6GB, 2vCPU, non-burst) | ~3000-5000 users sustained | Real prod scale |
| Cluster mode with N shards | ~3000-5000 per shard | Beyond single-instance |

Memory per active user: ~2-4MB (audio buffer at MAXLEN ~ 1000).
Memory isn't the bound for our load; CPU is. The numbers above assume
CPU is the limit.

### Pod sizing

- Workers per pod: `N = numCores - 1`
- Each worker handles its hash-assigned users; ideal load is
  uniformly distributed by `hash(userId) % N`.
- Memory per active user inside a worker: depends on Soniox WS state
  and decoder state; ballpark 1-5MB per user.
- Realistic: a single 8-core pod with 7 workers can handle several
  hundred concurrent users before CPU saturates.

These need real measurement before sizing for production.

## Observability surface

Metrics every pod emits (Prometheus-style or similar):

```
audio.ingress.packet_received_total        counter, labels: { pod }
audio.stream.xadd_latency_ms               histogram, labels: { pod }
audio.stream.xreadgroup_latency_ms         histogram, labels: { pod, worker }
audio.worker.queue_depth                    gauge, labels: { pod, worker }
audio.worker.heartbeat_last_seen_ms_ago    gauge, labels: { pod, worker }
audio.ownership.claim_acquired_total        counter, labels: { pod }
audio.ownership.claim_lost_total            counter, labels: { pod, reason }
audio.ownership.takeover_total              counter, labels: { pod }
audio.worker.restart_total                  counter, labels: { pod, reason }
audio.transcript.end_to_end_latency_ms     histogram, labels: { pod }
audio.transcript.recovery_latency_ms       histogram, labels: { pod, fault_type }
```

Logs every pod emits (structured JSON):

- Every ownership claim acquire / refresh-failure / release / takeover
- Every worker spawn / crash / replace
- Every K8s lifecycle event (SIGTERM received, drain start/complete)
- Every Redis connection state change

Per-user verbosity is bounded: log at INFO for state transitions
(connect, disconnect, failover), DEBUG for per-packet operations.

## Out of scope

- Specific cluster topology (single shard vs N shards), pick at
  deploy time based on measurement.
- Specific Redis instance type, pick based on capacity needs.
- Audio packet format details, carried unchanged from v1.
- Test client implementation, e2e tests spec.
- Worker-thread-vs-process discussion, chose Bun Workers (threads);
  not revisiting.

## Open questions

- **Consumer name on worker restart.** Same consumer name (worker
  index) or fresh + XAUTOCLAIM? Lean: same, simpler.
- **`audio-workers` consumer group lifetime.** Created lazily on
  first `XREADGROUP`? Or eagerly when the user is first claimed?
  Lean: lazy, on demand.
- **Backpressure when a worker is slow.** If the worker's input
  queue is growing, do we drop oldest packets, refuse new
  assignments, scale workers, or something else? Lean: drop oldest
  for audio (UDP semantics already imply loss).
- **Stream sharding within a single user.** If one user is somehow
  generating disproportionate load, hashing them to one worker is a
  hotspot. Lean: accept it for now; one user's audio is one user's
  CPU. Revisit if real users hit this.
- **Provider abstraction shape.** Carry v1's `TranscriptionProvider`
  interface as-is, or redesign for v2? Lean: carry as-is, refactor
  later if needed.

## Cross-references

- [`../architecture.md`](../architecture.md): the plain-language overview of the
  whole runtime.
- [`spec.md`](./spec.md): the architectural commitments, fault model, and the
  rejected alternatives.
- [`wire.md`](./wire.md): the audio wire surface (subscription REST, push events, UDP
  frames).
- [`../../007-runtime-auth-independence/README.md`](../../007-runtime-auth-independence/README.md):
  the `cloud-runtime` token format and issuer/JWKS verification model used at the
  WS handshake.
