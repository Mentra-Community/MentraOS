# Mentra Cloud Runtime: package build map

**Status:** Design, tracking the real package. This is the `@mentra/cloud-runtime`
file structure: what each file owns and its key signatures, plus the data flow that
ties them together. The big picture is in [`architecture.md`](./architecture.md); the
audio architecture and the Redis/worker detail are in [`audio/spec.md`](./audio/spec.md)
and [`audio/design.md`](./audio/design.md). Some of this is built and some is still in
progress; the "Current state" section at the end says which.

**TL;DR:** One package, `@mentra/cloud-runtime`, with a pure `/protocol` subpath the
client also imports. The server boots from `index.ts` (`startAudio()`), which wires
the network services (UDP ingress, the WebSocket session layer, Redis ownership) on
the main thread and a pool of workers that do the decode + transcription. Audio packets
travel main thread, to a Redis stream, to a worker, to a provider, and the transcript
travels back out the WebSocket.

## Package layout

```
cloud-v2/packages/runtime/        # @mentra/cloud-runtime
  package.json                    # exports: "." (server) and "./protocol" (pure, client-safe types)
  src/
    index.ts                      # boot: startAudio(), wires everything, owns the transcript-out path
    audio.types.ts                # re-exports the protocol audio types + subscriptionKey()
    connections/
      redis.connection.ts         # the ioredis clients (one normal, one for blocking stream reads)
    services/                     # the main-thread services
      udp-ingress.service.ts      # the UDP socket: receive packets, hand to the stream
      session.service.ts          # the WebSocket layer: auth, sessionTag, ownership claim, send-to-user
      ownership.service.ts        # the "one pod owns a user" claim + TTL refresh
      audio-stream.service.ts     # the Redis audio stream + the sessionTag registry
      worker-pool.service.ts      # spawn N workers, assign users, route transcripts back
    workers/                      # the worker thread + what runs in it
      audio.worker.ts             # per-core worker: read the stream, decode, transcribe, emit
      lc3/lc3.decoder.ts          # LC3 to PCM, via the liblc3 WASM build
      providers/
        provider.types.ts         # the transcription-provider interface
        soniox.provider.ts        # the production provider (Soniox)
        mock.provider.ts          # the deterministic test provider
    wire/
      phone-protocol.ts           # the v1 phone wire adapter (subscriptions in, data_stream out)
    protocol/                     # the pure, isomorphic v2 types (also @mentra/cloud-runtime/protocol)
      envelope.ts handshake.ts control.ts errors.ts audio.ts messages.ts index.ts
```

## Files and signatures

Two ground rules the structure enforces: `protocol/` has **zero server imports** (the
client imports the same files), and the worker thread does all the CPU work so the main
thread stays free for the network.

**`src/index.ts`**: the boot harness. `startAudio()` connects Redis, starts the worker
pool, starts UDP ingress and the WebSocket/HTTP server, and wires the worker pool's
transcript output to the right user's socket.

```ts
export interface StartAudioOptions {
  httpPort?: number; udpPort?: number; redisUrl?: string
  udpAdvertisedHost?: string; udpAdvertisedPort?: number; workerCount?: number
}
export interface AudioHandle { httpPort: number; udpPort: number; wsUrl: string; stop(): Promise<void> }
export function startAudio(opts?: StartAudioOptions): Promise<AudioHandle>
```

**`src/connections/redis.connection.ts`**: the Redis clients. Two of them, because a
blocking stream read would otherwise tie up the connection other commands need.

```ts
export function connectRedis(url: string): Promise<void>
export function getRedis(): Redis            // normal commands
export function getRedisStreams(): Redis     // the blocking XREADGROUP client
export function disconnectRedis(): Promise<void>
export const redisReadinessCheck: ReadinessCheck
```

**`src/services/udp-ingress.service.ts`**: the UDP socket. Receives `[header | LC3]`
packets and hands each to the audio stream; it doesn't decode or own anything.

```ts
export function startUdpIngress(port: number): Promise<void>
export function stopUdpIngress(): Promise<void>
```

**`src/services/session.service.ts`**: the WebSocket layer. Validates the token on
upgrade, mints the `sessionTag`, claims ownership, keeps the per-tag session registry,
and sends messages down to a user's socket.

```ts
export interface WsData { sessionTag: number; audioSessionId: string; mentraUserId: string; oemId: string; authSessionId: string }
export interface SessionEntry { ws: ServerWebSocket<WsData>; data: WsData }
export function configureAudioSession(opts: { udpAdvertisedHost: string; udpAdvertisedPort: number }): void
export function getSessionByTag(tag: number): SessionEntry | undefined
export function getActiveSessionCount(): number
export function getOwnedUserIds(): Iterable<string>
export function forwardToUserSessions(mentraUserId: string, message: unknown): void
export function tryWsUpgrade(req: Request, server: Bun.Server<WsData>): Promise<WsUpgradeResult>
export const wsHandlers: WebSocketHandler<WsData>
```

**`src/services/ownership.service.ts`**: the "exactly one pod owns this user" claim,
backed by a Redis key with a TTL. The refresh loop is what keeps ownership alive;
stopping it (or dying) releases the user.

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

**`src/services/audio-stream.service.ts`**: the Redis audio stream plus the `sessionTag`
to user registry. Parses the packet header, appends packets to `audio:{userId}`, and
resolves a tag to a user (local first, Redis as the cross-pod fallback).

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

**`src/services/worker-pool.service.ts`**: owns the workers on the main thread. Spawns
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

**`src/workers/audio.worker.ts`**: the worker thread. Reads its assigned users' streams
with `XREADGROUP`, decodes LC3, feeds the providers, and posts transcripts back to the
main thread. The message types in and out are the worker's contract.

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

**`src/workers/lc3/lc3.decoder.ts`**: the LC3-to-PCM decoder, on the liblc3 WASM build.

```ts
export const SUPPORTED_FRAME_BYTES: Set<number>   // 20, 40, 60
export class LC3Decoder {
  static create(frameBytes?: number): Promise<LC3Decoder>
  decode(lc3Bytes: Uint8Array): Int16Array | null
  get samplesPerFrame(): number
}
```

**`src/workers/providers/provider.types.ts`**: the one interface every transcription
backend implements, so the worker is provider-agnostic.

```ts
export interface TranscriptEvent { text: string; isFinal: boolean; startMs?: number; endMs?: number; language?: string; tokens?: Array<{...}> }
export interface ProviderOptions { scope: string; language: string; onTranscript: (e: TranscriptEvent) => void; onError?: (e: Error) => void }
export interface TranscriptionProvider { writeAudio(pcm: Int16Array): void; close(): Promise<void>; readonly name: string }
```

**`src/workers/providers/soniox.provider.ts`** / **`mock.provider.ts`**: the production
backend and the deterministic test one, both behind that interface.

```ts
export function createSonioxProvider(opts: CreateSonioxProviderOptions): Promise<TranscriptionProvider>
export function createMockProvider(opts: CreateMockProviderOptions): Promise<TranscriptionProvider>
```

**`src/wire/phone-protocol.ts`**: the adapter to the **v1** phone wire. It turns the
phone's stringly `phone_subscription_update` into typed `AudioSubscription[]`, and turns
a worker transcript into the v1 `data_stream` message the current mobile client expects.
(See "Current state" for why this still exists.)

```ts
export function parsePhoneSubscriptions(subscriptions: string[]): AudioSubscription[]
export function formatPhoneSubscription(sub: AudioSubscription): string
export function transcriptToDataStream(t: TranscriptMessage): DataStreamMessage
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

1. **Receive.** `udp-ingress.service` gets a UDP packet and calls
   `parseAudioPacket()` to split the header (`sessionTag`, `sequence`) from the LC3
   payload.
2. **Route.** `ingestAudioPacket()` resolves the `sessionTag` to a user (the local
   `session.service` map first, then `lookupSessionTagInRedis()` for a packet that
   landed on a non-owner pod) and appends it with `appendAudioPacket()` to
   `audio:{userId}`.
3. **Read.** On the owner pod, `audio.worker` is blocked on `XREADGROUP` over its
   assigned users' streams (consumer group `audio-workers`, consumer `pod:worker`). It
   wakes with the new entries.
4. **Decode.** The worker base64-decodes the payload and runs `LC3Decoder.decode()` to
   get PCM.
5. **Transcribe.** It calls `provider.writeAudio(pcm)` for each of the user's
   subscriptions; the provider streams back `TranscriptEvent`s.
6. **Emit.** The worker wraps each into a `TranscriptMessage` and `postMessage`s it to
   the main thread, then `XACK`s the entry so it isn't reprocessed.
7. **Deliver.** `worker-pool.service` surfaces the message through its `onTranscript`
   handler; `index.ts` formats it and calls `forwardToUserSessions()` in
   `session.service`, which sends it down the user's WebSocket.

Subscriptions ride the same path sideways: a REST `PUT` writes the set to Redis and
appends a "changed" marker to `audio:{userId}`, the worker picks it up in order with
the audio, and reconciles what it's transcribing.

## Current state

What's built versus what's still in progress, so the map isn't mistaken for "done":

- **Built:** the protocol types; the UDP ingress, session/WebSocket layer, ownership
  claim+refresh, the audio stream + sessionTag registry, the worker pool, the worker's
  stream-read + LC3 decode + provider plumbing, the Soniox and mock providers.
- **The outbound path is still v1.** Today the worker emits an internal
  `TranscriptMessage` and `index.ts` sends it to the client as the v1 `data_stream`
  message via `wire/phone-protocol.ts`. The v2 `stream.transcript` / `stream.translation`
  messages exist in `protocol/` but aren't the live outbound yet. Moving the live path
  to the v2 messages (and to the full `TranscriptionData` result shape) is the planned
  step.
- **UDP frames aren't decrypted yet.** The protocol defines per-session secretbox
  encryption ([`audio/wire.md`](./audio/wire.md)); the ingress path has this
  flagged as a to-do.
- **Replay on failover** (`XAUTOCLAIM` of unacked entries) is specced in
  [`audio/design.md`](./audio/design.md); confirm it against the worker as that lands.

## Build order from here

1. Move the outbound path to the v2 `stream.transcript` / `stream.translation` messages
   and the full `TranscriptionData` shape (keep the v1 `data_stream` adapter only while
   the v1 client is around).
2. Wire the subscription REST endpoint to the stream-marker reconcile path end to end.
3. Add UDP frame decryption at ingress.
4. Confirm the failover replay (`XAUTOCLAIM`) path against the worker.
