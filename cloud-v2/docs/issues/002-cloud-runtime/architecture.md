# Mentra Cloud Runtime: architecture

**Status:** Overview. The big picture of the runtime, in plain language, with one
end-to-end trace. The deep detail already lives in the audio docs
([`audio/spec.md`](./audio/spec.md) for the architecture, [`audio/design.md`](./audio/design.md)
for Redis keys, the worker protocol, and failure walkthroughs) and the locked wire
contract ([`protocol.md`](./protocol.md)). This doc is the on-ramp; the package
build map is in [`design.md`](./design.md).

A note on words used throughout (skim once, refer back as needed):

- **A pod** is one running copy of the runtime server. There are many, behind a load
  balancer, and any of them can handle any request.
- **Redis** is a fast shared store all the pods talk to. A **Redis stream** is an
  append-only log in Redis: you append to the end, readers pull from where they left
  off. A **consumer group** is a set of readers on a stream where each entry goes to
  exactly one of them, and an entry a reader didn't finish can be claimed by another,
  which is how a new pod picks up where a dead one stopped.
- **A worker** is a background thread inside a pod (Bun's `Worker`), so heavy CPU work
  runs off the pod's main thread.
- **UDP** is a fire-and-forget way to send packets: low overhead, low latency, but no
  delivery guarantee (a packet can be dropped or arrive out of order). It's used for
  audio because the latency is lower than a reliable connection.
- **LC3** is the compressed audio codec the glasses send. It has to be decoded to
  plain audio (**PCM**, raw samples) before transcription.
- **A TTL** is a timer on a Redis key that deletes it automatically when it runs out.
  The runtime uses one for "who owns this user", and the owner keeps resetting it; if
  the owner dies and stops resetting it, the key expires and someone else can take
  over.

## 1. What the runtime is

The runtime is the service that turns a user's live audio into transcripts (and
translations), and brokers their camera photos and streams. It's **per-user and
self-hostable**: an OEM can run their own copy or point at Mentra's. It's one product
made of **services** (audio and camera today) that share one connection protocol
([`protocol.md`](./protocol.md)).

The client side of that connection is `@mentra/cloud-client` (issue 004); this is the
server side.

## 2. The problem it solves

In v1, everything about a user's audio session (the decoder, the connection to the
transcription provider) lived in one pod's memory. So one pod owned each user for the
whole session. That can't scale: a pod restart drops the session, you can't spread one
busy user's load, and a pod dying means lost transcript.

The v2 runtime has to scale sideways from day one (add pods, handle more users),
survive a pod dying without dropping anyone, and use all of a pod's CPU cores. Three
rules make that work.

## 3. The three rules that make it scale

**Rule 1: any pod can receive any audio.** The glasses send audio as UDP packets, and
each packet has a small header with a session tag that says which user it belongs to.
The pod that receives a packet doesn't have to be "the pod for that user", it just
writes the packet into that user's Redis stream and moves on. So audio ingress
spreads across every pod with no stickiness.

**Rule 2: one pod owns each user, and Redis tracks who.** Exactly one pod holds the
user's live WebSocket and does their transcription. That pod writes "I own user X"
into Redis with a **TTL** (a timer that auto-expires, set to 5 seconds) and keeps
refreshing it every 1.5 seconds. If that pod dies, it stops refreshing, the timer runs
out, and another pod is free to take over. The missing refresh is the single signal
for "the owner died", so there's no separate health-check to build.

**Rule 3: a pod splits its work across its cores.** Each pod runs a handful of workers
(about one per CPU core). A user is assigned to a worker by hashing their id, so the
same user always lands on the same worker. The worker holds that user's per-session
state (the audio decoder, the provider connections) and does the heavy decode +
transcription, while the pod's main thread just handles the network and the ownership
bookkeeping.

## 4. A session's life

1. The glasses open a WebSocket; the load balancer sends it to whatever pod, say pod
   B. Pod B checks the user's `cloud-runtime` token and reads the configured user
   id plus `tenantId` claims.
2. Pod B tries to claim ownership: write "owner = pod B" into Redis **only if nobody
   else holds it**, with the 5-second timer. If someone else already owns the user,
   pod B closes the socket and the glasses retry.
3. Pod B assigns the user to one of its workers (by hash) and starts the 1.5-second
   refresh loop on the ownership timer.
4. The session runs (audio flows, transcripts go back, see section 5).
5. If pod B dies, it stops refreshing. Within ~5 seconds the ownership timer expires.
   The glasses' socket also drops, so they reconnect, land on a new pod, and that pod
   claims the now-free ownership and **replays the recent audio that wasn't processed
   yet** (section 6). The user sees a brief pause, never missing words.

The handshake hands the client two ids for the same session: a `sessionId` (a string,
used on REST calls) and a `sessionTag` (a small number, stamped into each UDP audio
packet so the stateless ingress can route it). Same session, two shapes for two jobs.

## 5. End to end: a spoken word becomes a transcript

1. The glasses encode audio as LC3 and send it as UDP packets, each stamped with the
   user's `sessionTag`.
2. Whatever pod receives a packet looks up which user the tag belongs to (a local map,
   falling back to Redis), and appends the packet to that user's Redis stream
   (`audio:{userId}`).
3. The user's **owner** pod has a worker reading that stream. It pulls the new
   packets, decodes LC3 to plain audio, and feeds the audio to the transcription
   provider (Soniox in production, a mock in tests).
4. The provider streams back text. The worker turns it into a transcript result and
   hands it to the pod's main thread.
5. The main thread pushes the transcript down the user's WebSocket, and the worker
   marks those packets done in the stream so they're not processed again.

The provider is swappable behind one interface, so adding a transcription or
translation backend doesn't touch the rest of the path.

## 6. Staying correct through failure

The one hard requirement is **no missing transcript words across a failure**. Recovery
should take under 5 seconds for common faults, under 10 for rare ones, but the
absolute rule is no gap in the words.

Two things make that hold:

- The audio stream keeps the last ~10 to 20 seconds of packets (it's capped by length,
  old entries fall off). So the recent audio is still in Redis even if the pod
  processing it just died.
- When a new pod takes over a user, it **claims the unfinished packets** the dead
  owner hadn't marked done yet, replays them through a fresh decoder and provider, and
  the transcripts come out on the new pod. Because the stream survived the pod, nothing
  is lost.

The full failure-by-failure walkthrough (worker crash, pod crash, Redis blip, provider
drop, graceful shutdown) is in [`audio/design.md`](./audio/design.md).

## 7. Subscriptions: how the cloud knows what to send back

The cloud only transcribes what the user actually asked for (English transcript,
a translation, etc.). The client sends that desired set as a **REST** call
(`PUT /api/audio/subscriptions`), not over the WebSocket, so any pod can handle it.
That pod saves the set in Redis and drops a small "subscriptions changed" marker into
the user's audio stream. The owner's worker is already reading that stream, so it picks
up the marker in order with the audio, and adjusts what it's transcribing. No separate
broadcast system, and the marker replays on failover just like audio. (This was a
deliberate choice over pub/sub; see [`audio/spec.md`](./audio/spec.md) and the audio
wire doc.)

## 8. The services: audio and camera

**Audio** is everything above: stateful, owned by one pod, with the failover machinery,
because a live transcription session has to survive failures without a gap.

**Camera** is the opposite, and simpler: plain stateless REST, any pod, no ownership.
For a photo, the cloud hands back a one-time upload link, the glasses upload the image
straight to blob storage (the cloud never touches the bytes), and the cloud notifies
the phone when the upload lands. For a live stream, the cloud provisions it with the
video provider and hands back the ingest and playback details; the client drives it
from there. Full shapes in [`camera/spec.md`](./camera/spec.md).

The reason they're built so differently: a transcript is a continuous thing that must
not break, so audio needs ownership and replay; a photo or a stream is one-shot or
client-managed, so camera needs none of it.

## 9. Where to read more

- [`protocol.md`](./protocol.md): the locked connection contract (the message
  envelope, the handshake, the REST conventions) that both services sit on.
- [`audio/spec.md`](./audio/spec.md): the audio architecture in depth (the scaling
  rules, the fault model, the subscription and result types).
- [`audio/design.md`](./audio/design.md): the implementation detail (Redis keys, the
  worker protocol, the failure walkthroughs, the packet format).
- [`camera/spec.md`](./camera/spec.md): the camera service.
- [`design.md`](./design.md): the `@mentra/cloud-runtime` package build map (the
  files, what each owns, and the signatures).
