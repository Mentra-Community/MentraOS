# Cloud Client: implementation design

**Status:** Design, ready to build against. This is how `@mentra/cloud-client` works
behind the public API: the three modules (`cloud.auth`, `cloud.runtime`,
`cloud.core`), the pieces that get passed in per platform, and the mechanics behind
each method (connecting, refreshing tokens, reconnecting, sending audio). The public
API is in [`spec.md`](./spec.md); the system picture and the decisions are in
[`architecture.md`](./architecture.md). This doc is the build plan.

**TL;DR:** One `CloudClient` object owns the server addresses, the auth providers, and
a small HTTP helper, and builds modules on top. `cloud.runtime` asks for a
`cloud-runtime` token and keeps the live WebSocket open. `cloud.core` is present only
when Core is configured and uses `cloud-core` credentials for product APIs and
miniapp-token minting. The phone-only pieces (the WebSocket, the UDP socket, secure
storage) are passed in, so the same core code runs on the phone and on a server.

## Package layout

The package is split so platform-only code never leaks into the shared logic:

- `@mentra/cloud-client`: the root import. All the logic, no phone-only or
  browser-only imports. You pass the platform pieces in yourself.
- `@mentra/cloud-client/react-native`: a thin wrapper that supplies the phone's
  WebSocket, UDP socket, and secure storage, then re-exports `CloudClient`. This is
  what the mobile app imports.
- `@mentra/cloud-client/node`: the same wrapper for a server, a Node WebSocket, a
  `dgram` UDP socket, and an in-memory or file-backed store. This is what the test
  harness imports.

Everything below is shared logic unless it says otherwise.

## Files and signatures

Proposed home: `cloud-v2/packages/cloud-client/` (a cloud-v2 workspace package, next
to the protocol types and the test harness; the mobile app depends on it).

```
cloud-v2/packages/cloud-client/
  package.json                 # @mentra/cloud-client; exports . ./react-native ./node
  tsconfig.json
  src/                         # the shared logic; the root import @mentra/cloud-client
    index.ts                   # public entry: re-exports CloudClient + the public types
    client.ts                  # the CloudClient class (wiring only)
    config.ts                  # CloudClientConfig + the public config types
    transports.ts              # the injected-transport interfaces (ws / udp / storage)
    http.ts                    # the shared REST helper
    logger.ts                  # Logger interface + a no-op default
    errors.ts                  # the client-side error types
    modules/
      auth/
        auth.ts                # cloud.auth: the AuthModule implementation
        token-store.ts         # token state + the single-flight refresh
        jwt.ts                 # read JWT claims (no signature check)
      runtime/
        runtime.ts             # cloud.runtime: the RuntimeModule, orchestrates the rest
        connection.ts          # the WebSocket: handshake, reconnect, liveness ping
        emitter.ts             # the one typed event emitter
        subscriptions.ts       # setSubscriptions over REST, with the version counter
        camera.ts              # managed photo + stream (REST request, await the push)
        audio-udp.ts           # UDP audio: encrypt each frame, hand bytes to the socket
      core/
        core.ts                # cloud.core: the CoreModule implementation
  react-native/
    index.ts                   # supplies the phone's ws/udp/storage, re-exports CloudClient
    transports.ts              # the RN WebSocket, native UDP, and secure-store adapters
  node/
    index.ts                   # supplies node ws/udp/storage, re-exports CloudClient
    transports.ts              # the ws-package, dgram, and memory/file adapters
```

(There's no `/core` import path, on purpose: it would read like the cloud-core
service. The root `@mentra/cloud-client` is the shared build, and `cloud.core` is just
the module under `src/modules/core/`.)

The signatures, file by file. The public ones (`AuthModule`, `RuntimeModule`,
`CoreModule`, the transport types) come from [`spec.md`](./spec.md); the rest are the
internal pieces behind them. Wire types (`AudioSubscription`, `TranscriptionData`,
the message unions) are imported from `@mentra/cloud-runtime/protocol`.

**`src/client.ts`**: the top-level object. It only wires things together: resolves
the addresses (proxy-aware), builds the HTTP helper, then builds the three modules in
order.

```ts
export class CloudClient {
  readonly auth: AuthModule
  readonly runtime: RuntimeModule
  readonly core?: CoreModule
  constructor(config: CloudClientConfig)
}
```

**`src/config.ts`**: the shape you pass to the constructor.

```ts
export interface CloudClientConfig {
  endpoints:
    | {core: string; runtime: string; proxy?: string} // Core + Runtime
    | {runtime: string; proxy?: string} // Runtime-only
  auth: AuthConfig
  transports: CloudClientTransports
  logger?: Logger
  reconnect?: {baseMs: number; maxMs: number; jitter: boolean}
}
export type CoreBackedAuthConfig =
  | {subjectToken: string; subjectTokenType: SubjectTokenType}
  | {getSubjectToken: () => Promise<{token: string; type: SubjectTokenType}>}
  | {accessToken: string; refreshToken: string}
export type RuntimeAuthConfig = {getToken: () => Promise<string>}
export type AuthConfig = {
  runtime: RuntimeAuthConfig
  core?: CoreBackedAuthConfig
}
export type SubjectTokenType = "oem-jwt" | "mentra-core" | "supabase"
```

**`src/transports.ts`**: the three things each platform supplies. The core only ever
touches these interfaces, never a real socket.

```ts
export interface WebSocketLike {
  send(data: string): void
  close(): void
  onOpen(cb: () => void): void
  onMessage(cb: (data: string) => void): void
  onClose(cb: (info: {code: number; reason: string}) => void): void
  onError(cb: (err: unknown) => void): void
}
export interface UdpSocketLike {
  send(bytes: Uint8Array, host: string, port: number): void
  onMessage(cb: (bytes: Uint8Array) => void): void
  close(): void
}
export interface KeyValueStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}
export interface CloudClientTransports {
  ws: (url: string) => WebSocketLike
  udp: () => UdpSocketLike
  storage: KeyValueStore
}
```

**`src/http.ts`**: one REST helper used by every module: builds the URL, adds the
Bearer header, parses JSON, maps a non-2xx to a typed error, and retries safe calls.

```ts
export interface HttpClient {
  get<T>(path: string, opts?: ReqOpts): Promise<T>
  post<T>(path: string, body?: unknown, opts?: ReqOpts): Promise<T>
  put<T>(path: string, body: unknown, opts?: ReqOpts): Promise<T>
}
export interface ReqOpts {
  bearer?: string
  idempotent?: boolean
} // bearer overrides the default
export function createHttpClient(deps: {
  baseUrl: string
  getToken?: () => Promise<string> // default Bearer source (cloud.auth)
  logger: Logger
}): HttpClient
```

**`src/modules/auth/auth.ts`**: `cloud.auth`. The public methods plus the wiring.

```ts
export class Auth implements AuthModule {
  constructor(deps: {http: HttpClient; store: TokenStore; config: AuthConfig; logger: Logger})
  getRuntimeToken(): Promise<string> // cloud-runtime audience
  getCoreToken(): Promise<string> // cloud-core audience
  getMiniappToken(packageName: string): Promise<{token: string; expiresAt: number}>
  get identity(): {mentraUserId: string; tenantId: string}
  onExpired(handler: () => void): () => void
}
```

Core-backed deployments can implement `getRuntimeToken()` by exchanging an OEM
subject token through Core/Auth and receiving a normalized runtime token. Runtime-only
deployments can implement it with an OEM backend, local/dev issuer, or already-issued
token. The runtime module does not know which path supplied the token.

**`src/modules/auth/token-store.ts`**: the token state and the single-flight lock.

```ts
export class TokenStore {
  constructor(deps: {storage: KeyValueStore})
  current(): {accessToken: string; exp: number} | null // in-memory
  save(tokens: {accessToken: string; refreshToken: string}): Promise<void> // persists refresh
  refreshToken(): Promise<string | null>
  singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> // de-dupes concurrent refresh/mint
}
```

**`src/modules/auth/jwt.ts`**: read the claims out of a token (no verification; the
cloud verifies).

```ts
export function decodeClaims(jwt: string): {
  sub: string
  tenantId: string
  exp: number
  [k: string]: unknown
}
```

**`src/modules/runtime/runtime.ts`**: `cloud.runtime`. Implements the public
`RuntimeModule` by delegating to the four pieces below.

```ts
export class Runtime implements RuntimeModule {
  constructor(deps: {
    connection: Connection
    emitter: RuntimeEmitter
    subscriptions: Subscriptions
    camera: Camera
    audio: UdpAudio
    logger: Logger
  })
  connect(): Promise<void>
  close(): void
  setSubscriptions(subs: AudioSubscription[]): Promise<void>
  onTranscript(cb: (d: TranscriptionData) => void): () => void
  onTranslation(cb: (d: TranslationData) => void): () => void
  requestManagedPhoto(opts: PhotoOptions): Promise<{requestId: string; readUrl: string}>
  startManagedStream(opts: StreamOptions): Promise<ManagedStream>
  stopManagedStream(streamId: string): Promise<void>
  onConnected(cb: () => void): () => void
  onDisconnected(cb: (info: {reason: string}) => void): () => void
  onError(cb: (err: ProtocolError) => void): () => void
  on<K extends keyof RuntimeEvents>(event: K, cb: (d: RuntimeEvents[K]) => void): () => void
  off<K extends keyof RuntimeEvents>(event: K, cb: (d: RuntimeEvents[K]) => void): void
  onAny(cb: (event: keyof RuntimeEvents, data: unknown) => void): () => void
}
```

**`src/modules/runtime/connection.ts`**: owns the socket, the handshake, reconnect,
and the liveness ping. Hands validated messages up; the rest of runtime never sees a
raw socket.

```ts
export class Connection {
  constructor(deps: {
    ws: (url: string) => WebSocketLike
    url: string
    getToken: () => Promise<string>
    initPayload: () => ConnectionInit
    reconnect: {baseMs: number; maxMs: number; jitter: boolean}
    logger: Logger
  })
  open(): Promise<ConnectionAck> // connect + init + await ack
  close(): void
  send(msg: ClientToCloudMessage): void
  onMessage(cb: (msg: CloudToClientMessage) => void): void // already validated by the protocol types
  onState(cb: (s: "connecting" | "open" | "closed") => void): void
  get ack(): ConnectionAck | null // sessionId, audio config
}
```

**`src/modules/runtime/emitter.ts`**: the single typed emitter the public `on*`
methods wrap.

```ts
export interface RuntimeEvents {
  transcript: TranscriptionData
  translation: TranslationData
  connected: void
  disconnected: {reason: string}
  error: ProtocolError
}
export class RuntimeEmitter {
  on<K extends keyof RuntimeEvents>(e: K, cb: (d: RuntimeEvents[K]) => void): () => void
  off<K extends keyof RuntimeEvents>(e: K, cb: (d: RuntimeEvents[K]) => void): void
  onAny(cb: (e: keyof RuntimeEvents, d: unknown) => void): () => void
  emit<K extends keyof RuntimeEvents>(e: K, d: RuntimeEvents[K]): void
}
```

**`src/modules/runtime/subscriptions.ts`**: the REST full-replace with the version
counter, plus the re-send on reconnect.

```ts
export class Subscriptions {
  constructor(deps: {http: HttpClient})
  set(subs: AudioSubscription[], sessionId: string): Promise<void> // PUT, bumps version
  resend(sessionId: string): Promise<void> // re-PUT the current set
}
```

**`src/modules/runtime/camera.ts`**: the managed-photo and managed-stream
features: send a REST request, then resolve when the matching push arrives.

```ts
export class Camera {
  constructor(deps: {http: HttpClient})
  requestPhoto(opts: PhotoOptions): Promise<{requestId: string; readUrl: string}>
  startStream(opts: StreamOptions): Promise<ManagedStream>
  stopStream(streamId: string): Promise<void>
  handlePush(msg: CloudToClientMessage): void // resolves/rejects a pending request by requestId
}
```

**`src/modules/runtime/audio-udp.ts`**: the UDP audio path: encrypt in the core,
send through the injected socket.

```ts
export class UdpAudio {
  constructor(deps: {udp: () => UdpSocketLike})
  configure(audio: NonNullable<ConnectionAck["audio"]>): void // sessionTag, host/port, key
  sendFrame(lc3: Uint8Array): void // secretbox + frame + udp.send
  close(): void
}
```

**`src/modules/core/core.ts`**: `cloud.core`. Stateless REST.

```ts
export class Core implements CoreModule {
  constructor(deps: {http: HttpClient})
  reports: ReportModule
  supportProfile: SupportProfileModule
}

```

**`src/logger.ts`** / **`src/errors.ts`**: small shared bits.

```ts
export interface Logger {
  debug(msg: string, meta?: object): void
  info(msg: string, meta?: object): void
  warn(msg: string, meta?: object): void
  error(msg: string, meta?: object): void
}
export const noopLogger: Logger

export class CloudClientError extends Error {}
export class HttpError extends CloudClientError {
  status!: number
  code?: string
}
export class AuthExpiredError extends CloudClientError {}
```

**`react-native/index.ts`** and **`node/index.ts`**: the only platform-specific
files. Each builds the three transports and re-exports a `CloudClient` that's
pre-wired with them, so the caller just passes `{ endpoints, auth }`.

```ts
// node/index.ts
import {CloudClient as Base, CloudClientConfig} from "@mentra/cloud-client"
import {nodeTransports} from "./transports"
export class CloudClient extends Base {
  constructor(config: Omit<CloudClientConfig, "transports">) {
    super({...config, transports: nodeTransports()})
  }
}
```

## The pieces passed in per platform

Three things differ between a phone and a server, so the core takes them as inputs
instead of importing them (the types are in [`spec.md`](./spec.md#construction)):

| Input     | What it is                                | On the phone                                 | On a server           |
| --------- | ----------------------------------------- | -------------------------------------------- | --------------------- |
| `ws`      | opens a WebSocket and sends/receives text | the RN WebSocket (or nitro-websockets later) | the `ws` package      |
| `udp`     | sends and receives UDP packets            | a native socket                              | Node `dgram`          |
| `storage` | a tiny key/value store for tokens         | the OS secure store                          | memory or a temp file |

REST is the exception: there's no platform input for it, because `fetch` exists on
both a phone and a modern server. The core calls `fetch` directly.

## The top-level `CloudClient`

`new CloudClient(config)` does the wiring and nothing else clever:

- Holds the server addresses (`endpoints.runtime`, optional `endpoints.core`, and
  optional `endpoints.proxy`). If a proxy is set, configured service addresses are
  rewritten to go through it.
- Builds a small **HTTP helper** (next-to-last section) that every module uses for
  REST: it adds the `Authorization: Bearer` header, parses JSON, and maps errors.
- Builds `cloud.auth` first, then `cloud.runtime` and optional `cloud.core`.
- Owns logging and the reconnect/backoff settings, so there's one place to tune them.

## `cloud.auth`

The one owner of credentials. It supplies a runtime token for `cloud.runtime`, and
when Core is configured it owns the Core token/refresh-token lifecycle. It never
hands Core or Runtime bearer tokens to a miniapp (see
[`architecture.md`](./architecture.md) section 6).

**Getting the first Core token.** In Core-backed mode, it's constructed with a
**subject token** (the OEM's signed JWT, or a Mentra core token / Supabase session,
or a `getSubjectToken()` callback that fetches one). On first use it calls
`POST /api/client/auth/exchange` with that subject token and gets back a Core token
(good for ~1h) and a refresh token, which it saves.

**Getting the Runtime token.** `cloud.runtime` asks `cloud.auth.getRuntimeToken()`.
Hosted deployments can implement that by calling Core/Auth as a broker. Runtime-only
deployments can fetch from an OEM backend, local/dev issuer, or already-issued token
without configuring Core at all.

**`getCoreToken()`** (used internally by `cloud.core` before every Core call):

1. If the cached Core token is still valid (with a small safety margin, say 60s),
   return it.
2. Otherwise refresh: call `POST /api/client/auth/refresh` with the stored refresh
   token, save the new Core token and the new (rotated) refresh token, return the
   new Core token.
3. If two callers ask at once, only **one** refresh request goes out and both get its
   result (a single-flight lock). Without this, a reconnect storm would fire many
   refreshes at once.
4. If refresh fails (the refresh token is dead or revoked), clear it. If the
   host configured `getSubjectToken()`, exchange one fresh subject token and
   continue; otherwise fire `onExpired` so the host can send the user back
   through login. Don't retry forever.

**`getMiniappToken(packageName)`:** calls `POST /api/client/auth/miniapp-token` with
the Core token as the Bearer, and caches the result per packageName with its
expiry. A second call for the same packageName returns the cached token until it's
near expiry, then re-mints (single-flight, same as above). This is what the on-device
runtime calls at miniapp launch and on refresh.

**`identity`:** Core/runtime tokens are JWTs, so claims like `sub` and `tenantId` are
base64 JSON inside them. `identity` reads them straight off the active token path.
It does **not** verify the signature: the client isn't a security boundary for its
own token, the cloud verifies on every call.

**What's persisted:** the refresh token (so a relaunch doesn't force a new login).
The Core token can stay in memory and be re-minted from the refresh token on
startup.

## `cloud.runtime`

The live session: one WebSocket, plus REST for anything the client initiates. It
implements the locked protocol in
[`../002-cloud-runtime/protocol.md`](../002-cloud-runtime/protocol.md).

**Connecting (`connect()`):**

1. Open the WebSocket to `endpoints.runtime`, with the `cloud-runtime` token in the
   first frame (the `?token=` URL fallback is there for the Chrome debugger).
2. Send a `connection.init` message: the protocol version, the platform, and the
   audio config (codec, sample rate, and any initial subscriptions so audio that
   starts immediately isn't transcribed against an empty set).
3. Wait for the cloud's `connection.ack`. It carries the `sessionId` (used on REST
   calls) and, when UDP audio is available, the `sessionTag`, the UDP host/port, and
   the per-session encryption key. Save all of it. Now the session is ready.
4. If the cloud replies with a fatal `error` instead (bad or expired token), surface
   it; for `AUTH_EXPIRED`, obtain a fresh runtime token through `cloud.auth` and
   reopen.

**Staying connected:**

- **Reconnect with backoff.** If the socket drops, reconnect with an exponential
  delay plus a little randomness (so a fleet of phones doesn't reconnect in lockstep).
  On every successful reconnect, redo the handshake and **re-send the full
  subscription set** at the current version, because the cloud may have a fresh
  session.
- **Runtime status.** Hosts can read `cloud.runtime.getStatus()` and subscribe with
  `cloud.runtime.onStatusChanged(cb)`. Initial open reports `connecting`; a drop
  after at least one successful open reports `reconnecting`; a completed handshake
  reports `connected`; an explicit host close reports `disconnected`. The snapshot
  also carries `audioTransport` so debug UI can say whether audio is currently
  configured for `udp`, future `ws`, or `none`.
- **Liveness.** The client sends a `control.ping` every N seconds and expects a
  `control.pong`. No pong in time means the connection is dead even if the socket
  looks open, so reconnect. (The cloud stays passive on liveness; the client owns
  reconnect.)

**Incoming messages.** Every WebSocket message is parsed and checked against the
shared `cloudToClientMessage` definition from `@mentra/cloud-runtime/protocol` before
anything acts on it. A message that doesn't match is dropped with a log, not crashed
on. A valid one is handed to the typed event emitter (below). An unknown `type` is
non-fatal by the protocol, so it's logged and ignored.

**The event emitter.** Under the hood there's one typed emitter keyed by an event map
(`RuntimeEvents`). The friendly methods (`onTranscript`, `onTranslation`,
`onConnected`, ...) and the generic `on(event, cb)` / `onAny(cb)` are thin wrappers
over it, so there's one source of truth and no event-name strings to mistype. Every
subscribe call returns an unsubscribe function.

**Subscriptions (`setSubscriptions(subs)`):** this is a REST call, not a WebSocket
message, so any pod can serve it. It sends
`PUT /api/audio/subscriptions { subscriptions, sessionId, version }`:

- `subscriptions` is the full desired set as typed `AudioSubscription[]` (full
  replace, not a diff).
- `version` is a counter the client bumps on every change, so an out-of-order arrival
  at the cloud is ignored.
- `sessionId` is the one from `connection.ack`, so the cloud ties the update to this
  session.

**Managed photo and stream:** the client sends a REST request and then waits for a
matching WebSocket push. `requestManagedPhoto()` sends the request, records it by
`requestId`, and resolves the promise when the `photo.ready` push with that
`requestId` arrives (rejecting on `photo.error` or after a timeout). `startManagedStream()`
is the same shape over the stream endpoints.

**UDP audio:** the audio bytes never touch the JavaScript layer. From
`connection.ack.audio` the runtime has the `sessionTag`, the UDP host/port, and the
encryption key. It encrypts each frame **in the core** (NaCl secretbox / tweetnacl,
so it's identical on phone and server and testable on a server) into the frame
`[ sessionTag(4) | seq(2) | nonce(24) | ciphertext ]`, and the injected `udp`
transport just sends the bytes. On the WebSocket audio fallback there's no UDP and no
secretbox key; the frames ride the per-user WebSocket, which is already encrypted.

**Known transport-selection gap:** the cloud/runtime side accepts WS binary fallback
frames, but the current cloud-client mobile path only sends audio through `UdpAudio`.
That means a UDP-blocked network can show a healthy WebSocket session while audio
never reaches Redis/Soniox. Client-side fallback still needs active transport
selection: detect missing UDP progress, switch `audioTransport` to `ws`, and send the
same audio frames over the live WebSocket as the last-resort cloud path.

## `cloud.core`

The simplest module: stateless REST calls using the Core identity token from
`cloud.auth.getCoreToken()`. `cloud.core` owns report/support resources. Store
catalog calls originate from the Store miniapp through the Miniapp SDK instead
of a Cloud Client Store module. In runtime-only mode `cloud.core` is absent.

## The shared HTTP helper

All three modules make REST calls through one small helper so the behavior is
consistent:

- Resolves the base address (proxy-aware) and builds the URL.
- Adds `Authorization: Bearer <module token>` from `cloud.auth` (except the
  `/exchange` call, which presents the subject token instead). Runtime REST uses
  `cloud-runtime`; Core REST uses `cloud-core`.
- Sends and parses JSON, and maps a non-2xx response to a typed error the caller can
  branch on (for example, a 401 from a resource call triggers one refresh-and-retry
  through `cloud.auth`).
- Retries only safe, idempotent calls (`GET`, the full-replace `PUT`) on a transient
  network error, with a small backoff.

## How auth and the live connection interact

Runtime tokens expire while a session can last much longer, so the two modules
cooperate:

- `cloud.runtime` always gets a runtime token through `cloud.auth.getRuntimeToken()`;
  `cloud.core` gets a Core token through `cloud.auth.getCoreToken()` when Core is
  configured.
- If the cloud rejects the live socket with `AUTH_EXPIRED` anyway (clock skew, a
  revoke mid-session), `cloud.runtime` asks `cloud.auth` for a fresh runtime token,
  then reopens with the new token.
- If token refresh itself fails, `cloud.auth` falls back to one fresh
  `getSubjectToken()` exchange when available. If that is unavailable or also
  fails, `cloud.auth.onExpired` fires once and the host decides what to do
  (usually: send the user back through login).

## Errors and logging

- Protocol errors arrive as the typed `ProtocolError` (`code`, `message`, `fatal`).
  Fatal ones close the socket (the cloud closes it; the client then reconnects or, for
  auth, refreshes first). Non-fatal ones surface through `onError` and the connection
  stays up.
- One logger is owned by `CloudClient` and passed down, so a host can route
  cloud-client logs wherever it wants. Tokens are never logged.

## Implementation order

Build it so the test harness works as early as possible:

1. The transport interfaces + the **node** implementations (so everything is testable
   on a server from day one), and the shared HTTP helper.
2. The `CloudClient` skeleton (endpoints, proxy rewrite, logger).
3. `cloud.auth`: exchange, refresh (single-flight), `getMiniappToken`, `identity`,
   `onExpired`, persistence.
4. `cloud.runtime`: the handshake, the typed emitter, `setSubscriptions`, reconnect,
   liveness.
5. Managed photo/stream, then the UDP audio path.
6. `cloud.core`.
7. The **react-native** transport implementations.

## Proposals carried from `architecture.md`

These are the still-open choices, with the proposed direction (full reasoning in
[`architecture.md`](./architecture.md) section 10):

- Inject `cloud.runtime` directly as the on-device runtime's `cloud` hook, with no
  separate adapter layer to keep in sync.
- Do the UDP encryption in the shared core (above), with the native side doing only
  the send/receive.

The local SDK runs on cloud-client, with no v1/v2 toggle; the move to it is a rollout
sequence (build the runtime, build the client, integration-test the runtime through
the client, then wire the mobile app onto it). See
[`architecture.md`](./architecture.md) section 11.
