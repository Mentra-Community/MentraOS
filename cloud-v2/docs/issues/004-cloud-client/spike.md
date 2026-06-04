# Cloud Client: spike

**Status:** Design and open questions. Not a spec yet. Captures the agreed shape
of `@mentra/cloud-client`, the headless library that is the device's single
connection to Cloud V2.

## What it is

A headless, isomorphic TypeScript library. It is the client end of the runtime
protocol plus the device-facing Cloud Core calls. The on-device Mentra Runtime
(`@mentra/island`) plugs into it through its `configureRuntime` adapters; OEM
hosts embed it; and the backend test harness drives the **same** library from
Node/Bun. We own it; the mobile app is a consumer.

### Goals

- **Headless and isomorphic.** Pure TS core, no React Native, Expo, or DOM
  imports. Platform-specific pieces (WebSocket, UDP, secure storage) are injected
  and chosen by import path. Two first-class consumers: island on device, and the
  backend test harness in Node/Bun (which also answers the 003-audio "test client
  deployment" open question and gives load/soak a real client).
- **v2-native.** Speaks only the runtime protocol; none of the v1 message shapes
  (`phone_subscription_update`, `data_stream`, legacy REST).
- **Typed, no stringly surface.** Subscriptions and events use the typed unions
  from `@mentra/cloud-runtime/protocol`. The only strings on the wire live inside
  that protocol package, validated by zod; callers never hand-write them.

## Construction

Platform is selected by the import path; each entry pre-wires its transports, so
the constructor is just config. Class, not factory.

```ts
import { CloudClient } from "@mentra/cloud-client/react-native"   // on device
import { CloudClient } from "@mentra/cloud-client/node"           // tests / dev-stack

const cloud = new CloudClient({ endpoints, auth })
```

The core (`@mentra/cloud-client/core`) is platform-agnostic and takes injected
transports (`transport`, `udp`, `storage`); the platform entries are thin
wrappers that fill those in. This keeps Node-only deps out of the RN bundle and
vice versa, and mirrors the `@mentra/cloud-runtime/protocol` subpath pattern.

```ts
const cloud = new CloudClient({
  endpoints: { core, runtime, proxy? },   // proxy rewrites both if set
  auth: { coreToken } | { tokenSource },  // see auth module
})
cloud.auth; cloud.runtime; cloud.core
```

The top-level client owns endpoint + proxy routing, the shared token state, retry
and backoff, and logging. The proxy is configured once and applies to both core
and runtime, matching how Cloud Proxy fronts both products.

## Module: `cloud.auth`

The single owner of credentials. The Mentra access token never leaves the client.

- Holds the access token and auto-refreshes it (rotating refresh token).
- Mints and caches miniapp-scoped tokens per packageName.
- Exposes the decoded identity (`mentraUserId`, `oemId`).
- Signals the host when refresh fails (re-auth needed).

```ts
cloud.auth.getAccessToken(): Promise<string>            // internal use by runtime/core
cloud.auth.getMiniappToken(packageName): Promise<{ token, expiresAt }>
cloud.auth.identity: { mentraUserId, oemId }
cloud.auth.onExpired(cb)
```

**Acquisition (decided via the migration bridge).** During the v1 to v2
transition the host hands the client the existing **core token**; the client
exchanges it at Cloud Core for the v2 access + refresh tokens (Mentra-as-OEM, the
core token is the subject token) and owns refresh thereafter. See
[`../001-cloud-core/auth/design.md`](../001-cloud-core/auth/design.md#migration-bridge-core-token-to-v2-access-token)
("Migration bridge"). End state: construct with a Supabase session instead of a
core token, same endpoint. This is the client half of
[`../001-cloud-core/auth/design.md`](../001-cloud-core/auth/design.md#miniapp-auto-auth).

## Module: `cloud.runtime`

The live session, the stateful and latency-sensitive part. Implements
[`../002-cloud-runtime/protocol.md`](../002-cloud-runtime/protocol.md).

```ts
cloud.runtime.connect(): Promise<void>
cloud.runtime.setSubscriptions(subs: AudioSubscription[]): Promise<void>
cloud.runtime.onTranscript(cb) / onTranslation(cb)
cloud.runtime.requestManagedPhoto(opts): Promise<PhotoResult>
cloud.runtime.startManagedStream(opts) / stopManagedStream()
cloud.runtime.onConnected(cb) / onDisconnected(cb) / onError(cb)
cloud.runtime.close()
```

- WS handshake (`connection.init` / `connection.ack`, Bearer from `cloud.auth`),
  reconnect with backoff, client-driven liveness ping.
- Subscriptions full-replace, typed.
- Stream events typed, per-event methods (no event-name strings).
- **Managed photo, not "take a photo".** The cloud brokers storage: it returns a
  presigned upload URL, the glasses PUT bytes directly to blob storage (the cloud
  is not in the image byte path), and the uploader pings completion for the read
  URL and for observability. `camera.takePhoto()` stays only at the dev SDK layer
  (dev intent); at this layer it is `requestManagedPhoto`.
- **UDP audio.** Receives `sessionTag`, the advertised UDP host/port, and the
  per-session encryption key from `connection.ack.audio`, and hands them to the
  injected native UDP transport. Audio bytes are native; they do not flow through
  JS. Encryption is NaCl secretbox per the audio protocol.

## Module: `cloud.core`

Device-facing Cloud Core REST. Stateless, typed, Bearer from `cloud.auth`.

```ts
cloud.core.miniapps.list(): Promise<MiniappListing[]>
cloud.core.miniapps.getBundle(packageName, version?): Promise<{ downloadUrl, version, manifest }>
cloud.core.user.getProfile(): Promise<Profile>     // if needed
```

Calls [`../001-cloud-core/`](../001-cloud-core/) services (miniapp-service,
storage-service). Guardrail: device-facing only, no Dev Console / OEM Portal /
store web UI. Starts thin and grows with miniapp-service.

## Events surface

No stringly events. Either per-event methods (`cloud.runtime.onTranscript(cb)`,
lean) or a typed emitter with a `CloudEvent` const and an event-to-payload map.
Underneath it is a typed emitter, consistent with island's `EventEmitter<...>`.

## How island consumes it

island stays transport-agnostic; the host wires the client into island's
adapters via `configureRuntime`:

- `socketComms` -> `cloud.runtime` (the v2-native typed surface, replacing the v1
  `sendMessage` / `updatePhoneSubscriptions` adapter).
- `requestMiniappSdkPhoto` -> `cloud.runtime.requestManagedPhoto`.
- the auth handshake gets the user identity from `cloud.auth.identity` and the
  miniapp token from `cloud.auth.getMiniappToken` (this is what the runtime hands
  the bundle, never the access token).
- `AppRegistry` bundle fetches -> `cloud.core.miniapps.getBundle`.

The adapter redesign (a typed v2 surface replacing `SocketCommsAdapter`) is
settled against the island runtime during implementation, since island is a
separate package.

## Open questions

1. **Subscription transport: decided (Option 2a).** `setSubscriptions` is a REST
   call; the cloud delivers it to the owning worker via a control entry in the
   user's audio stream, no pub/sub. See
   [`../002-cloud-runtime/audio/subscription-transport.md`](../002-cloud-runtime/audio/subscription-transport.md).
2. **Lock `protocol.md`.** The client implements it; it is currently Draft (now
   includes REST subscriptions, the UDP encryption block, and the corrected frame).
3. **Native audio boundary.** Where encryption happens (v1 does it in JS on the
   phone via `UdpManager.ts` / `UdpCrypto.ts`) and the exact injected `udp`
   interface. Lean: encryption in the isomorphic core (tweetnacl), socket send
   native.
4. **island adapter contract.** Needs island-team buy-in on the typed v2 surface.
5. **`core` and `runtime` payload shapes** depend on miniapp-service and the
   camera service, neither specced yet, so those methods start as sketches.
6. **WS transport library** under the hood: RN built-in vs
   `react-native-nitro-websockets`. Swappable (injected), so not a blocker; the
   default matters.

## References

- [`README.md`](./README.md) and the module stubs ([`auth/`](./auth/),
  [`runtime/`](./runtime/), [`core/`](./core/)).
- [`../002-cloud-runtime/protocol.md`](../002-cloud-runtime/protocol.md): the wire
  contract `runtime` implements.
- [`../001-cloud-core/auth/`](../001-cloud-core/auth/): identity, the migration
  bridge, and auto-auth (the `auth` module's server side).
