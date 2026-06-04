# Cloud Client spec

**Status:** Spec. The concrete API of `@mentra/cloud-client`. The rationale and the
big picture are in [`architecture.md`](./architecture.md); this is the contract to
build against, now that the protocol ([`../002-cloud-runtime/protocol.md`](../002-cloud-runtime/protocol.md))
and the auth slice ([`../001-cloud-core/auth/spec.md`](../001-cloud-core/auth/spec.md))
are locked.

## Construction

Class, platform chosen by import path, transports pre-wired per platform:

```ts
import { CloudClient } from "@mentra/cloud-client/react-native"   // device
import { CloudClient } from "@mentra/cloud-client/node"           // tests, dev-stack

const cloud = new CloudClient({
  endpoints: { core: string; runtime: string; proxy?: string },  // proxy rewrites both if set
  auth:
    | { subjectToken: string; subjectTokenType: SubjectTokenType }   // exchanged once
    | { getSubjectToken: () => Promise<{ token: string; type: SubjectTokenType }> }  // fetched on demand
    | { accessToken: string; refreshToken: string },                 // already exchanged
})

cloud.auth; cloud.runtime; cloud.core
```

The core package `@mentra/cloud-client/core` is platform-agnostic and accepts
injected transports; the platform entries fill them in:

```ts
interface CloudClientTransports {
  ws: WebSocketLike            // RN built-in / nitro-websockets / ws (node)
  udp: UdpSocketLike           // native on device, dgram in node
  storage: KeyValueStore       // secure store on device, memory/file in node
}
```

## `cloud.auth`

```ts
interface AuthModule {
  getAccessToken(): Promise<string>                 // current, refreshing as needed (used by runtime/core)
  getMiniappToken(packageName: string): Promise<{ token: string; expiresAt: number }>  // cached per package
  readonly identity: { mentraUserId: string; oemId: string }
  onExpired(handler: () => void): () => void        // refresh failed; host must re-auth
}
```

- On first use it exchanges the subject token at
  `POST /api/client/auth/exchange` for access + refresh, then owns refresh via
  `POST /api/client/auth/refresh`.
- `getMiniappToken` calls `POST /api/client/auth/miniapp-token`, caches per
  packageName, re-mints before expiry. The access token is used only as the Bearer
  to Mentra's own APIs and is never handed to a miniapp; only the miniapp-scoped
  token is exposed to a miniapp.

## `cloud.runtime`

```ts
interface RuntimeModule {
  connect(): Promise<void>
  close(): void

  setSubscriptions(subs: AudioSubscription[]): Promise<void>   // full-replace, PUT /api/audio/subscriptions

  onTranscript(handler: (data: TranscriptionData) => void): () => void
  onTranslation(handler: (data: TranslationData) => void): () => void

  requestManagedPhoto(opts: PhotoOptions): Promise<{ requestId: string; readUrl: string }>
  startManagedStream(opts: StreamOptions): Promise<ManagedStream>
  stopManagedStream(streamId: string): Promise<void>

  onConnected(handler: () => void): () => void
  onDisconnected(handler: (info: { reason: string }) => void): () => void
  onError(handler: (err: ProtocolError) => void): () => void

  // generic surface for forwarding / iteration / logging (typed via the event map)
  on<K extends keyof RuntimeEvents>(event: K, handler: (data: RuntimeEvents[K]) => void): () => void
  off<K extends keyof RuntimeEvents>(event: K, handler: (data: RuntimeEvents[K]) => void): void
  onAny(handler: (event: keyof RuntimeEvents, data: unknown) => void): () => void
}
```

- **Events: per-event methods plus a typed generic emitter, one source of truth.**
  A single typed emitter (an event map `RuntimeEvents` of name to payload) is the
  implementation; the `on*` methods are thin sugar over it. Use the **per-event
  methods** (`cloud.runtime.onTranscript(cb)`) for the common case: discoverable
  (the IDE lists them), payload typed, nothing to mistype. Use the **generic
  `on(event, cb)` / `onAny(cb)`** for forwarding, iteration, or logging (for
  example island re-emitting all runtime events). The generic `on` is still typed
  through the event map, so there are no magic strings. Every `on*`/`on` returns
  an unsubscribe function.
- `connect()` does the `connection.init` / `connection.ack` handshake (Bearer from
  `cloud.auth`), reconnect with backoff, and the client-driven liveness ping.
- `setSubscriptions` sends `{ subscriptions, sessionId, version }` (full-replace).
  The client owns `version` (monotonic) and echoes the `sessionId` from
  `connection.ack`.
- `requestManagedPhoto` resolves when the cloud pushes `photo.ready`; rejects on
  `photo.error`. The UDP audio path receives `sessionTag`, the udp host/port, and
  the encryption key from `connection.ack.audio` and hands them to the injected
  native UDP transport (bytes do not flow through JS).

## `cloud.core`

Device-facing Cloud Core REST. Bearer from `cloud.auth`. Starts thin; grows with
miniapp-service (next week).

```ts
interface CoreModule {
  miniapps: {
    list(): Promise<MiniappListing[]>
    getBundle(packageName: string, version?: string): Promise<{ downloadUrl: string; version: string; manifest: MiniappManifest }>
  }
  user: { getProfile(): Promise<Profile> }
}
```

Guardrail: device-facing only, no Dev Console / OEM Portal / store web UI.

## Shared types

Wire types come from `@mentra/cloud-runtime/protocol` (zod, isomorphic):
`AudioSubscription`, `TranscriptionData`, `TranslationData`, `ProtocolError`, the
envelope and message unions. The cloud-client imports them so it cannot drift from
the server.

## Consumers

- **island (device):** the host wires this client in at island's `configureRuntime`
  hook (see [`architecture.md`](./architecture.md), sections 4 and 8).
- **backend test harness (Node/Bun):** constructs `CloudClient` with node
  transports and drives the full path (auth, connect, subscribe, send, receive),
  so tests exercise the real wire contract.
