# Mentra Cloud Runtime: package build map

**Status:** Design, the target structure. This is the `@mentra/cloud-runtime` file
layout we're refactoring toward: what each file owns and its key signatures, plus the
data flow that ties them together. The big picture is in
[`architecture.md`](./architecture.md); the audio architecture and the Redis/worker
detail are in [`audio/spec.md`](./audio/spec.md) and [`audio/design.md`](./audio/design.md).
The "Current state" section at the end says what's built and what's still moving.

**TL;DR:** One package, `@mentra/cloud-runtime`, with a pure `/protocol` subpath the
client also imports. The folders tell the story: **`net/`** is the connection edge
(UDP + WebSocket), **`services/session/`** is the per-user cross-pod state in Redis
(ownership, the audio stream, subscriptions), **`services/audio/`** is the
transcription work built on top (the pipeline + the workers + the providers), and
**`clients/`** holds the Redis connection. `index.ts` only boots; `audio.service.ts`
owns the audio pipeline.

## Package layout

```
cloud-v2/packages/runtime/        # @mentra/cloud-runtime
  package.json                    # exports: "." (server) and "./protocol" (pure, client-safe types)
  src/
    index.ts                      # boot only: parse config, connect, start the services, serve

    clients/
      redis.client.ts             # the ioredis clients (one normal, one for blocking stream reads)

    net/                          # the connection edge: what a client connects to
      udp.ts                      # UDP ingress socket: receive packets, hand to the stream
      ws.ts                       # WebSocket transport: upgrade/auth, the per-tag registry, send-to-user

    api/                          # the REST surface (Hono): client-initiated commands, pod-agnostic
      index.ts                    # the Hono app: mounts the service routes + health
      audio.api.ts                # PUT /api/audio/subscriptions (full-replace, sessionId + version guarded)
      camera.api.ts               # (later) managed photo + stream REST

    services/
      session/                    # the per-user state in Redis that makes scaling + failover work
        ownership.ts              # the "one pod owns this user" lock + TTL refresh
        stream.ts                 # the per-user audio bus + the sessionTag -> user lookup
        subscriptions.ts          # what audio the user wants + subscriptionKey() canonicalization
      audio/                      # the transcription work, built on the session state
        audio.service.ts          # the pipeline + per-session lifecycle (claim, assign, route out, release)
        workers/
          pool.ts                 # the worker pool, main-thread side
          worker.ts               # the worker thread: read the stream, decode, transcribe, emit
          lc3.ts                  # LC3 -> PCM, via the liblc3 WASM build
          liblc3.wasm
        providers/
          provider.ts             # the transcription-provider interface
          soniox.ts               # the production provider (Soniox)
          mock.ts                 # the deterministic test provider
      camera/                     # (later) managed photo + stream REST; no session state

    protocol/                     # the pure, isomorphic v2 types (also @mentra/cloud-runtime/protocol)
      envelope.ts handshake.ts control.ts errors.ts audio.ts messages.ts index.ts
```

Two ground rules the structure keeps: `protocol/` has **zero server imports** (the
client imports the same files), and the worker thread does all the CPU work so the
main thread stays free for the network. And the v1 phone-wire adapter is **gone** from
this layout (see "Current state").

## Files and signatures

The signatures don't change in the refactor, only where they live. The public ones
(`AudioSubscription`, the message unions) come from `protocol/`.

**`src/index.ts`**: boot only. Parses config from options/env, connects Redis, starts
the UDP and WebSocket listeners, hands off to `audio.service`, and serves the Hono
`api/` app (health + the REST surface).

```ts
export interface StartRuntimeOptions {
  httpPort?: number; udpPort?: number; redisUrl?: string
  udpAdvertisedHost?: string; udpAdvertisedPort?: number; workerCount?: number
}
export interface RuntimeHandle { httpPort: number; udpPort: number; wsUrl: string; stop(): Promise<void> }
export function startRuntime(opts?: StartRuntimeOptions): Promise<RuntimeHandle>
```

**`src/clients/redis.client.ts`**: the Redis clients. Two of them, because a blocking
stream read would otherwise tie up the connection other commands need.

```ts
export function connectRedis(url: string): Promise<void>
export function getRedis(): Redis            // normal commands
export function getRedisStreams(): Redis     // the blocking XREADGROUP client
export function disconnectRedis(): Promise<void>
export const redisReadinessCheck: ReadinessCheck
```

**`src/net/udp.ts`**: the UDP socket. Receives `[header | LC3]` packets and hands each
to the stream; it doesn't decode or own anything.

```ts
export function startUdpIngress(port: number): Promise<void>
export function stopUdpIngress(): Promise<void>
```

**`src/net/ws.ts`**: the WebSocket transport. Validates the token on upgrade, mints the
`sessionTag`, keeps the per-tag session registry, and sends messages down to a user's
socket. (The audio-specific lifecycle, claim ownership / assign a worker on connect,
lives in `audio.service.ts`, which the connect handler calls into.)

```ts
export interface WsData { sessionTag: number; audioSessionId: string; mentraUserId: string; tenantId: string; authSessionId: string }
export interface SessionEntry { ws: ServerWebSocket<WsData>; data: WsData }
export function configureAudioSession(opts: { udpAdvertisedHost: string; udpAdvertisedPort: number }): void
export function getSessionByTag(tag: number): SessionEntry | undefined
export function getActiveSessionCount(): number
export function getOwnedUserIds(): Iterable<string>
export function forwardToUserSessions(mentraUserId: string, message: unknown): void
export function tryWsUpgrade(req: Request, server: Bun.Server<WsData>): Promise<WsUpgradeResult>
export const wsHandlers: WebSocketHandler<WsData>
```

**`src/services/session/ownership.ts`**: the "exactly one pod owns this user" lock,
backed by a Redis key with a TTL. The refresh loop keeps it alive; stopping it (or
dying) releases the user. See the file's own header comment for the full plain-English
explanation of the lock.

```ts
export const OWNERSHIP_TTL_SEC = 5
export const OWNERSHIP_REFRESH_INTERVAL_MS = 1_500
export type ClaimResult = "claimed" | "already-ours" | "owned-by-other"
export function tryClaimOwnership(mentraUserId: string, podId: string): Promise<ClaimResult>
export function claimOwnershipWithRetry(mentraUserId: string, podId: string, deadlineMs?: number): Promise<ClaimResult>
export function refreshOwnership(mentraUserId: string, podId: string): Promise<boolean>
export function releaseOwnership(mentraUserId: string, podId: string): Promise<boolean>
export function getOwner(mentraUserId: string): Promise<string | null>
export function startOwnershipRefreshLoop(opts: { podId: string; getOwnedUserIds: () => Iterable<string> }): void
export function stopOwnershipRefreshLoop(): void
```

**`src/services/session/stream.ts`**: the per-user audio Redis stream plus the
`sessionTag` to user lookup. Parses the packet header, appends packets to
`audio:{userId}`, and resolves a tag to a user (local first, Redis as the cross-pod
fallback).

```ts
export const AUDIO_PACKET_HEADER_SIZE = 6
export interface ParsedAudioPacket { sessionTag: number; sequence: number; payload: Uint8Array }
export function parseAudioPacket(buf: Uint8Array): ParsedAudioPacket | null
export function ingestAudioPacket(packet: ParsedAudioPacket, localLookup: (tag: number) => LocalSessionLookup | undefined): Promise<IngestResult>
export const AUDIO_STREAM_MAXLEN = 1000
export const AUDIO_STREAM_GROUP = "audio-workers"
export function audioStreamKey(mentraUserId: string): string
export function appendAudioPacket(mentraUserId: string, packet: AudioPacket): Promise<string>
// sessionTag registry (TTL'd, with a refresh):
export function registerSessionTag(tag: number, record: SessionTagRecord): Promise<void>
export function refreshSessionTag(tag: number): Promise<void>
export function unregisterSessionTag(tag: number): Promise<void>
export function lookupSessionTagInRedis(tag: number): Promise<SessionTagRecord | null>
```

**`src/services/session/subscriptions.ts`**: what audio the user wants. Holds the
`subscriptionKey()` canonicalization today; the REST endpoint that writes the desired
set to Redis and nudges the worker (the marker in the stream) lands here as it's built.

```ts
export function subscriptionKey(sub: AudioSubscription): string   // canonical string, for dedup + equality
// (coming) the PUT /api/audio/subscriptions handler + the stream-marker reconcile
```

**`src/services/audio/audio.service.ts`**: the audio pipeline. Wires the parts into one
feature and owns the per-session lifecycle: on connect, claim ownership + register the
sessionTag + assign the user to a worker; per transcript, route it back out the WS; on
disconnect, release. (This orchestration lives in `index.ts` today and moves here.)

```ts
export function startAudioService(opts: { podId: string; workerCount: number }): void
export function stopAudioService(): Promise<void>
```

**`src/services/audio/workers/pool.ts`**: owns the workers on the main thread. Spawns
them, assigns each user to the least-loaded one, pushes subscription changes down, and
surfaces transcripts coming back up.

```ts
export function startWorkerPool(opts: { podId: string; count?: number }): void
export function stopWorkerPool(): Promise<void>
export function onTranscript(handler: (msg: TranscriptStubMessage | TranscriptMessage) => void): void
export function assignUser(mentraUserId: string): void
export function updateSubscriptions(mentraUserId: string, subs: AudioSubscription[]): void
export function releaseUser(mentraUserId: string): void
export function getPoolStats(): { workerCount: number; perWorker: Array<{ id: string; sessionCount: number; ready: boolean }> }
```

**`src/services/audio/workers/worker.ts`**: the worker thread. Reads its assigned
users' streams with `XREADGROUP`, decodes LC3, feeds the providers, and posts
transcripts back. The message types in and out are the worker's contract.

```ts
export type WorkerInMessage =
  | { type: "ATTACH_USER"; mentraUserId: string }
  | { type: "DETACH_USER"; mentraUserId: string }
  | { type: "UPDATE_SUBSCRIPTIONS"; mentraUserId: string; subs: AudioSubscription[] }
  | { type: "SHUTDOWN" }
export type WorkerOutMessage = TranscriptStubMessage | TranscriptMessage | WorkerReadyMessage
export interface TranscriptMessage {
  type: "TRANSCRIPT"; kind: "transcription" | "translation"; mentraUserId: string
  text: string; isFinal: boolean; language?: string; sourceLanguage?: string
  startMs?: number; endMs?: number; source: string
}
```

**`src/services/audio/workers/lc3.ts`**: the LC3-to-PCM decoder, on the liblc3 WASM
build.

```ts
export const SUPPORTED_FRAME_BYTES: Set<number>   // 20, 40, 60
export class LC3Decoder {
  static create(frameBytes?: number): Promise<LC3Decoder>
  decode(lc3Bytes: Uint8Array): Int16Array | null
  get samplesPerFrame(): number
}
```

**`src/services/audio/providers/provider.ts`**: the one interface every transcription
backend implements, so the worker is provider-agnostic.

```ts
export interface TranscriptEvent { text: string; isFinal: boolean; startMs?: number; endMs?: number; language?: string; tokens?: Array<{...}> }
export interface ProviderOptions { scope: string; language: string; onTranscript: (e: TranscriptEvent) => void; onError?: (e: Error) => void }
export interface TranscriptionProvider { writeAudio(pcm: Int16Array): void; close(): Promise<void>; readonly name: string }
```

**`src/services/audio/providers/soniox.ts`** / **`mock.ts`**: the production backend and
the deterministic test one, both behind that interface.

```ts
export function createSonioxProvider(opts: CreateSonioxProviderOptions): Promise<TranscriptionProvider>
export function createMockProvider(opts: CreateMockProviderOptions): Promise<TranscriptionProvider>
```

**`src/protocol/`**: the pure v2 types, also published as `@mentra/cloud-runtime/protocol`
and imported by the client (issue 004). No server imports, so it's safe in the RN
bundle. `envelope.ts` (the `{ v, type, timestamp, payload }` wrapper), `handshake.ts`
(`connection.init` / `connection.ack`), `control.ts` (ping/pong), `errors.ts`,
`audio.ts` (the subscription + result schemas), `messages.ts` (the discriminated unions
`clientToCloudMessage` / `cloudToClientMessage`). Covered in detail by
[`protocol.md`](./protocol.md).

## Data flow: a packet to a transcript

The handoffs, in order:

1. **Receive.** `net/udp` gets a UDP packet and calls `parseAudioPacket()`
   (`services/session/stream`) to split the header (`sessionTag`, `sequence`) from the
   LC3 payload.
2. **Route.** `ingestAudioPacket()` resolves the `sessionTag` to a user (the local
   `net/ws` registry first, then `lookupSessionTagInRedis()` for a packet that landed
   on a non-owner pod) and appends it with `appendAudioPacket()` to `audio:{userId}`.
3. **Read.** On the owner pod, the worker (`services/audio/workers/worker`) is blocked
   on `XREADGROUP` over its assigned users' streams (consumer group `audio-workers`,
   consumer `pod:worker`). It wakes with the new entries.
4. **Decode.** The worker base64-decodes the payload and runs `LC3Decoder.decode()` to
   get PCM.
5. **Transcribe.** It calls `provider.writeAudio(pcm)` for each of the user's
   subscriptions; the provider streams back `TranscriptEvent`s.
6. **Emit.** The worker wraps each into a `TranscriptMessage` and `postMessage`s it to
   the main thread, then `XACK`s the entry so it isn't reprocessed.
7. **Deliver.** `services/audio/workers/pool` surfaces the message through its
   `onTranscript` handler; `audio.service` turns it into the v2 `stream.transcript`
   message and calls `forwardToUserSessions()` (`net/ws`) to send it down the user's
   WebSocket.

Subscriptions ride the same path sideways: a REST `PUT` writes the set to Redis and
appends a "changed" marker to `audio:{userId}`, the worker picks it up in order with
the audio, and reconciles what it's transcribing.

## Current state

What's built versus what's still moving, so the map isn't mistaken for "done". Note
this doc shows the **target** structure; the package is being refactored into it.

- **Built (at the old paths):** the protocol types; UDP ingress, the WebSocket layer,
  ownership claim+refresh, the audio stream + sessionTag registry, the worker pool, the
  worker's stream-read + LC3 decode + provider plumbing, the Soniox and mock providers.
- **The folder refactor** (this layout: `net/`, `clients/`, `services/session/`,
  `services/audio/`, the `index` -> `audio.service` split) is the next step.
- **The outbound is being moved to v2 and the v1 adapter removed.** Today the worker
  emits an internal `TranscriptMessage` and the boot path sends it to the client as the
  v1 `data_stream` message through a v1 phone-wire adapter. The v2 `stream.transcript` /
  `stream.translation` messages exist in `protocol/`. The plan is to emit those (and the
  full `TranscriptionData` shape) and **delete the v1 adapter**; the legacy mobile stays
  on the v1 cloud over its own connection, so the v2 runtime never needs the v1 wire.
- **UDP frames aren't decrypted yet.** The protocol defines per-session secretbox
  encryption ([`audio/wire.md`](./audio/wire.md)); the ingress path has this flagged.
- **Subscriptions over REST** (the `PUT` + stream-marker reconcile) isn't wired end to
  end yet; `subscriptionKey()` exists, the endpoint doesn't.
- **Replay on failover** (`XAUTOCLAIM` of unacked entries) is specced in
  [`audio/design.md`](./audio/design.md); confirm it against the worker as it lands.

## Build order from here

1. **Refactor to this layout** (move/rename files, split `index` into boot +
   `audio.service`, split `session.service` into `net/ws` transport + lifecycle).
2. **Move the outbound to the v2 `stream.transcript` / `stream.translation` messages**
   and delete the v1 phone-wire adapter.
3. **Wire the subscription REST endpoint** to the stream-marker reconcile path.
4. **Add UDP frame decryption** at ingress.
5. **Confirm the failover replay** (`XAUTOCLAIM`) path against the worker.
