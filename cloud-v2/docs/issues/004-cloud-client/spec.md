# Cloud Client spec

**Status:** Spec. The public API of `@mentra/cloud-client`. The big picture and the
decisions are in [`architecture.md`](./architecture.md), and how it's built behind
this API is in [`design.md`](./design.md). This is the contract to build against, now
that the protocol ([`../002-cloud-runtime/protocol.md`](../002-cloud-runtime/protocol.md))
and the auth slice ([`../001-cloud-core/auth/spec.md`](../001-cloud-core/auth/spec.md))
are locked.

## Construction

You make one `CloudClient`. Which build you import decides the platform, and each
build already has its network sockets and storage wired in, so the constructor is
just config:

```ts
import { CloudClient } from "@mentra/cloud-client/react-native"   // device
import { CloudClient } from "@mentra/cloud-client/node"           // tests, dev-stack

const cloud = new CloudClient({
  endpoints:
    | { core: string; runtime: string; proxy?: string }   // Core + Runtime
    | { runtime: string; proxy?: string },                // Runtime-only
  auth: {
    runtime:
      | { source: "core" }                                // Core broker mints cloud-runtime token
      | { getToken: () => Promise<string> },              // OEM/local runtime-token provider
    core?: CoreBackedAuthConfig,                          // cloud-core audience, when Core exists
  },
})

cloud.runtime
cloud.core // present/usable only when Core is configured
```

The root import (`@mentra/cloud-client`) is the shared build; it doesn't know what
platform it's on and takes the platform pieces as inputs. The `react-native` and
`node` imports are thin wrappers that supply them:

```ts
interface CloudClientTransports {
  ws: WebSocketLike // RN built-in / nitro-websockets / ws (node)
  udp: UdpSocketLike // native on device, dgram in node
  storage: KeyValueStore // secure store on device, memory/file in node
}
```

## `cloud.auth`

```ts
interface AuthModule {
  getRuntimeToken(): Promise<string> // cloud-runtime audience
  getCoreToken(): Promise<string> // cloud-core audience, Core-backed mode only
  getMiniappToken(packageName: string): Promise<{token: string; expiresAt: number}> // cached per package
  readonly identity: {mentraUserId: string; tenantId: string}
  onExpired(handler: () => void): () => void // refresh failed; host must re-auth
}
```

- `cloud.runtime` uses `getRuntimeToken()` only. Hosted-Core mode configures
  `runtime: { source: "core" }`, which calls Core/Auth's runtime-token broker.
  Runtime-only mode supplies `runtime.getToken()` from an OEM auth backend or
  local/dev issuer without any Core endpoint.
- In Core-backed mode, `getCoreToken()` and `getMiniappToken` use Core/Auth.
  `getCoreToken()` is for Core-owned APIs with audience `cloud-core`.
- `getMiniappToken` calls `POST /api/client/auth/miniapp-token`, caches per
  packageName, re-mints before expiry. The Core token is used only as the Bearer
  to Core-owned APIs and is never handed to a miniapp; only the miniapp-scoped
  token is exposed to a miniapp.
- `identity` is Core-owned identity. Runtime-only tokens may carry identity
  claims for Runtime authorization/logging, but `cloud.auth.identity`, miniapp
  token minting, and miniapp auto-auth are unavailable unless `auth.core` and
  `endpoints.core` are configured.

## `cloud.runtime`

```ts
interface RuntimeModule {
  connect(): Promise<void>
  close(): void

  setSubscriptions(subs: AudioSubscription[]): Promise<void> // full-replace, PUT /api/audio/subscriptions
  sendAudioFrame(frame: Uint8Array): void

  getStatus(): RuntimeSnapshot

  onTranscript(handler: (data: TranscriptionData) => void): () => void
  onTranslation(handler: (data: TranslationData) => void): () => void

  requestManagedPhoto(opts: PhotoOptions): Promise<{requestId: string; readUrl: string}>
  startManagedStream(opts: StreamOptions): Promise<ManagedStream>
  stopManagedStream(streamId: string): Promise<void>

  onConnected(handler: () => void): () => void
  onDisconnected(handler: (info: {reason: string}) => void): () => void
  onStatusChanged(handler: (status: RuntimeSnapshot) => void): () => void
  onError(handler: (err: ProtocolError) => void): () => void

  // generic surface for forwarding / iteration / logging (typed via the event map)
  on<K extends keyof RuntimeEvents>(event: K, handler: (data: RuntimeEvents[K]) => void): () => void
  off<K extends keyof RuntimeEvents>(event: K, handler: (data: RuntimeEvents[K]) => void): void
  onAny(handler: (event: keyof RuntimeEvents, data: unknown) => void): () => void
}

type RuntimeStatus = "connecting" | "connected" | "reconnecting" | "disconnected"
type RuntimeAudioTransport = "udp" | "ws" | "none"

interface RuntimeSnapshot {
  status: RuntimeStatus
  audioTransport: RuntimeAudioTransport
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
  `cloud.auth.getRuntimeToken()`), reconnect with backoff, and the client-driven
  liveness ping.
- `setSubscriptions` sends `{ subscriptions, sessionId, version }` (full-replace).
  The client owns `version` (monotonic) and echoes the `sessionId` from
  `connection.ack`.
- `getStatus()` / `onStatusChanged(cb)` expose client lifecycle state for host UI
  and fallback policy. `status` is the WebSocket/runtime session state:
  initial open is `connecting`, a post-open retry loop is `reconnecting`,
  successful handshake is `connected`, and host teardown is `disconnected`.
  `audioTransport` is the outbound cloud audio path the client has configured:
  `udp` when `connection.ack.audio` configured UDP, `none` before/after a session
  or when the ack does not include audio, and `ws` once client-side WS binary
  audio fallback is implemented. Mobile/offline transcription fallback is host
  state, not a cloud-client transport value.
- `requestManagedPhoto` resolves when the cloud pushes `photo.ready`; rejects on
  `photo.error`. The UDP audio path receives `sessionTag`, the udp host/port, and
  the encryption key from `connection.ack.audio` and hands them to the injected
  native UDP transport (bytes do not flow through JS).

## `cloud.core`

The other Core REST calls the device makes (not the live session, not auth),
sent with the Core identity token from `cloud.auth`. In runtime-only mode the
module is absent rather than being routed to Runtime. The Store miniapp uses its
own Miniapp SDK authenticated fetch surface; Store catalog operations are not a
Cloud Client module.

```ts
interface CoreModule {
  reports: ReportModule
  supportProfile: SupportProfileModule
}

```

Guardrail: device-facing only, no Dev Console / OEM Portal / store web UI.

## Shared types

The message types (`AudioSubscription`, `TranscriptionData`, `TranslationData`,
`ProtocolError`, and the rest) aren't defined here. They come from
`@mentra/cloud-runtime/protocol`, the one package the cloud server also uses. The
cloud-client imports them, so it can't drift from what the cloud actually accepts.

## Consumers

- **island (device):** the host wires this client in at island's `configureRuntime`
  hook (see [`architecture.md`](./architecture.md), sections 4 and 8).
- **backend test harness (Node/Bun):** constructs `CloudClient` with node
  transports and drives the full path (auth, connect, subscribe, send, receive),
  so tests exercise the real wire contract.
