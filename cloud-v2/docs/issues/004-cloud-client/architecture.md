# Cloud Client and on-device transport: architecture and alignment

**Status:** Alignment doc for the on-device runtime and the cloud-v2 work. Read it
to get the whole picture: how a local miniapp runs on the phone and reaches the
cloud, what `@mentra/cloud-client` is and why it exists, how auth works for Mentra
and for OEMs, and the decisions behind building the v2 transport once, typed, with
no tech debt.

**TL;DR:** Local miniapps never talk to the cloud directly. The phone is the hub: it
runs the miniapp (a background JSContext plus an optional WebView UI), handles most
things on the phone, and proxies a few services to the cloud. Today that proxy is
the v1 `SocketComms` / `RestComms`. We're adding a second transport,
`@mentra/cloud-client`, injected the same way (the host's `configureRuntime` hook).
On the v2 path the on-device runtime speaks the typed v2 protocol directly (typed
values, not magic strings), using the same `@mentra/cloud-runtime/protocol` types as
the cloud server and the test harness, so on-device and cloud can't drift.

This doc spans three codebases at different stages; keep them straight:

| Where | State | What lives there |
| --- | --- | --- |
| base mobile app (`mobile/`, on `dev`) | live | v1 transport: `SocketComms`, `RestComms`, the `configureRuntime` hook |
| PR #3086 `fixes-navigation-bitmaps` | in flight, not merged | the two-layer local miniapp runtime (background JSContext + UI WebView) |
| `cloud-v2/` (this repo area) | in progress | the v2 cloud, `@mentra/cloud-client`, `@mentra/cloud-runtime/protocol` |

Paths below are monorepo-root-relative.

---

## 1. The shape of the system

Two clouds, with the phone sitting between glasses and cloud:

```
  glasses  <--BLE-->  PHONE (the hub)  <--one connection per cloud-->  CLOUD
                          |
                          +-- runs local miniapps on-device
```

- **Cloud v1** (today): the phone holds one authenticated WebSocket plus REST.
- **Cloud v2** (in progress): a separate cloud, separate domain, v2-native
  protocol, reached through `@mentra/cloud-client`.

The key thing: a local miniapp never opens its own cloud connection. It talks to the
phone, and the phone is the only thing holding a cloud link. So swapping the cloud
transport happens entirely on the phone, and miniapp code never notices.

## 2. How a local miniapp runs on-device (PR #3086)

A local miniapp bundle (a ZIP) ships two entry points
(`mobile/modules/island/src/services/AppRegistry.ts`, "Two-layer bundles ship
`entry.background` and optional `entry.ui`"):

- **Background layer:** `src/background/index.ts`, runs in an **always-on
  JSContext** (JavaScriptCore on iOS). It's the miniapp's logic: headless, no DOM,
  and it stays alive when the UI is closed.
  `mobile/modules/miniapp/src/background/index.ts`: "the always-running JSContext
  side of a two-layer miniapp."
- **UI layer:** `src/ui/`, runs in a **WebView** (React, DOM). Optional, mounted and
  torn down as the user opens and closes the screen.

Both layers use the same SDK object, `MiniappSession`
(`mobile/modules/miniapp/src/session.ts`): `session.display`,
`session.transcription.on(...)`, `session.storage`, etc.

Three bridges wire it together (all `mobile/modules/island/src/services/`):

| Bridge | Connects | File |
| --- | --- | --- |
| **MentraJSRouter** | phone host <-> background JSContext | `MentraJSRouter.ts` |
| **MentraUIRouter** + `window.mentra` shim | UI WebView <-> its background JSContext | `MentraUIRouter.ts`, `mentraUiShim.ts` |
| **LocalMiniappRuntime** | the phone-side hub everything funnels into | `LocalMiniappRuntime.ts` |

Then the lifecycle pieces: `MentraJSCrashController` (respawn on crash),
`MentraJSLogPipeline` (logs out of the JSContext), `MiniappRunningRegistry`
("running" means the background JSContext is alive). Native spawn/kill is a binding
(`MentraJSCrustBinding`); the iOS engine is `JSContext`.

So the "two JS contexts" the auth docs talk about are real here: a background
JSContext and a UI WebView. (The engine is JSContext, not Crust. Crust is native
image/video/navigation utilities.)

## 3. What crosses to the cloud, and what doesn't

`LocalMiniappRuntime` gets every `session.*` call (through `MentraJSRouter`) and
either handles it on the phone or proxies it to the cloud. From
`agents/local-app-runtime-plan.md`:

- **Local, no cloud:** display (to glasses over BLE), LED, audio playback, button /
  touch, head position / IMU, battery, connection state, VAD, raw mic chunks,
  location, phone notifications, calendar, simple storage. This is most of the
  surface.
- **Cloud-proxied through the phone:** speech-to-text (`transcription:*`),
  translation (`translation:*`), TTS, managed photo / managed stream, telemetry. The
  phone subscribes to the cloud on behalf of all local miniapps, **aggregated**
  (three miniapps wanting `transcription:en-US` is one cloud subscription).

That split is what keeps this change small: only the cloud-proxied bucket touches
the cloud, so only that bucket changes when we swap v1 for v2. The local hardware
path doesn't care which cloud exists.

## 4. The transport today (v1)

The cloud-proxied traffic goes out through the host's transport, injected into the
island runtime at the `configureRuntime` hook
(`mobile/modules/island/src/runtime/config.ts`, the `socketComms` entry), wired up in
`mobile/src/services/MantleManager.ts`:

```ts
// mobile/src/services/MantleManager.ts (today)
configureRuntime({
  socketComms: {
    sendMessage: (m) => socketComms.sendMessage(m),
    updatePhoneSubscriptions: (subs) => socketComms.updatePhoneSubscriptions(subs),
  },
  // audioPlayback, glassesStatus, settings, sendDisplayEvent, setMicRequirements,
  // requestMiniappSdkPhoto, ...
})
```

- **Subscriptions out:** `LocalMiniappRuntime.updateCloudSubscriptions()` aggregates
  `transcription:*` / `translation:*` into a **`string[]`** and calls
  `socketComms.updatePhoneSubscriptions([...])`. `mobile/src/services/SocketComms.ts`
  sends `{ type: "phone_subscription_update", subscriptions, timestamp }` over the WS.
- **Commands out:** managed stream/photo go through
  `socketComms.sendMessage({ type: "managed_stream_request", ... })` or a REST hook
  (`requestMiniappSdkPhoto` -> `mobile/src/services/RestComms.ts`).
- **The WS:** `mobile/src/services/WebSocketManager.ts` connects with the v1 auth
  token in the query string and v1 negotiation flags.
- **Inbound:** `SocketComms.handle_message()` switches on `type`: `data_stream` ->
  `LocalMiniappRuntime.forwardEvent(streamType, data)` (delivers a transcript to the
  subscribed miniapps); `phone_photo_ready` / `phone_stream_status` ->
  `LocalMiniappRuntime.handleCloudMessage()`.

Two things to call out, because v2 drops both: the subscriptions are just strings
(`"transcription:en-US"`), and the messages are untyped objects tagged with a `type`.

## 5. What `@mentra/cloud-client` is, and why it exists

`@mentra/cloud-client` is a headless, isomorphic TypeScript library: the device's
single connection to **Cloud v2**. It owns auth, the runtime transport, and the
device-facing core calls, behind three modules (`cloud.auth`, `cloud.runtime`,
`cloud.core`). The platform pieces (WebSocket, UDP, secure storage) are injected, so
the same core runs on the phone and in Node. Full API in [`spec.md`](./spec.md).

Why a separate library instead of more methods on `SocketComms`:

- **It's the v2 protocol, kept separate.** v1 `SocketComms` is built around the v1
  wire. v2 has a clean message format, REST for commands, WebSocket for push, and v2
  auth. Bolting that onto the same class just rebuilds the tech debt we're trying to
  leave behind.
- **One contract, shared by everyone.** The cloud-client speaks only
  `@mentra/cloud-runtime/protocol`: the zod types the **cloud server** validates
  against and the **test harness** drives. The same library with Node transports is
  the test client. So:

  > the on-device runtime, the cloud server, and the test harness all validate the
  > same types. On-device can't silently diverge from what the cloud accepts,
  > because there's one definition and it's type-checked on every side.

  That's the real reason to type the on-device path against the protocol instead of
  hand-maintaining strings: change a subscription or event type and it's a compile
  error everywhere it matters, and a green test-harness run is evidence the phone
  will work too.
- **Auth in one place.** `cloud.auth` holds the v2 access token and mints the
  miniapp-scoped tokens, so the phone stops hand-managing tokens for transport.

## 6. Auth: how the device and miniapps authenticate

`cloud.auth` is the one owner of credentials on the device. It's a module of the
cloud-client, so the same code authenticates the phone for Mentra and for OEMs, and
issues the per-miniapp tokens auto-auth needs. The access token is sent as the Bearer
on every call to Mentra's own APIs (cloud-core and cloud-runtime), but it's **never
handed to a miniapp**: a miniapp only ever holds its own scoped token (below).

### Device auth (the phone proves who the user is to v2 cloud)

The cloud-client is constructed with a **subject token** and exchanges it once at
`POST /api/client/auth/exchange` for a v2 **access token** plus a refresh token, then
owns refresh from there (`cloud.auth.getAccessToken()`). What the subject token is
depends on who's running the app:

- **OEM users.** The OEM's own backend mints a short-lived signed JWT for the
  signed-in user (the OEM owns its accounts; there's no Mentra login screen). The
  OEM's host app hands that JWT to the cloud-client at construction. Mentra verifies
  it against the OEM's registered public key and maps `(oemId, oemUserId)` to a
  `mentraUserId`.
- **Mentra users.** Mentra is "OEM zero" (`oemId = "mentra"`). The subject token is
  the existing core token during the transition, a Supabase session at the end
  state, same endpoint.

Either way the device ends up holding one Mentra-issued v2 access token, and
`cloud.runtime` / `cloud.core` use it as the Bearer for every v2 call. Full
mechanics: [`../001-cloud-core/auth/design.md`](../001-cloud-core/auth/design.md).

### Miniapp auto-auth (a miniapp calls its own backend as the user)

A miniapp with its own developer backend needs to call it as the current user, with
no login. The access token never goes to the miniapp (it's the device's credential
to all of Mentra). Instead:

1. At launch the runtime asks the cloud-client for a **miniapp-scoped token**:
   `cloud.auth.getMiniappToken(packageName)`. cloud-core mints an Ed25519 JWT with
   `sub = mentraUserId`, `oemId`, and `aud = <packageName>`, short-lived, scoped to
   that one miniapp.
2. The runtime **injects** that token into the miniapp's two contexts: the background
   JSContext (via `MentraJSRouter`) and, if present, the UI WebView (via
   `MentraUIRouter` / the `window.mentra` shim). `useMentraAuth()` reads
   `{ mentraUserId, token }` from the bridge; both contexts see the same token.
3. The miniapp calls its developer backend with
   `Authorization: Bearer <miniapp-scoped-token>`. The backend verifies it against
   Mentra's published public keys (JWKS), checks `aud == its packageName`, and applies
   its trust policy on `oemId`. No per-request call to Mentra.
4. The runtime re-mints and re-injects before expiry (`cloud.auth` caches per
   packageName).

On the v2 path, auto-auth adds a little on-device work: hold a `cloud.auth`, grab the
scoped token at launch, inject it into both contexts, and re-inject before it
expires. The bridges already exist (they carry the session messages); the auth token
is just one more message over them.

Common questions this answers:

- **"How does an OEM's user reach our cloud with no Mentra account?"** Their backend
  vouches with a signed JWT; the exchange turns it into a Mentra token.
- **"How does a miniapp know who the user is and call my backend safely?"** A
  per-miniapp token the backend verifies itself via JWKS, audience-pinned so a token
  for miniapp A can't be replayed against miniapp B.
- **"Where do tokens live?"** `cloud.auth` owns the access token and sends it only as
  the Bearer to Mentra's own APIs; a miniapp only ever holds its own scoped token,
  never the access token.

For the from-zero version of these terms (JWT, asymmetric signing, JWKS, audience,
exchange), see [`../001-cloud-core/auth/concepts.md`](../001-cloud-core/auth/concepts.md).

## 7. The decisions

The calls we've made, so this gets built once.

**D1. The cloud-client is the v2 transport, injected at the existing
`configureRuntime` hook.** It's not a rewrite of the island runtime. The host
constructs `new CloudClient(...)` and injects its surface where v1 `socketComms`
goes today. The island runtime stays the owner of subscription aggregation and
fan-out.

**D2. Change the island runtime and kill the string shapes (typed hook).** The
`socketComms` hook (`sendMessage(object)`, `updatePhoneSubscriptions(string[])`) is
replaced by a typed v2 surface, and the handful of `LocalMiniappRuntime` call sites
that build v1 shapes are updated to build typed values from
`@mentra/cloud-runtime/protocol` and call typed `cloud.runtime.*` methods. Why: no
tech debt, real TypeScript safety, and it matches the cloud and the test harness by
construction. The alternative (keep the v1 signatures and translate on the host side)
would keep the magic-string surface alive inside the runtime and reintroduce a drift
point, so we're not doing that.

**D3. v1 and v2 coexist as separate transport paths.** The v1 `SocketComms` /
`RestComms` stays for the v1 cloud. The cloud-client is the v2 path. A device or
session picks one. We're adding a path, not ripping one out.

**D4. Scope is the cloud-proxied bucket only.** Subscriptions, transcript /
translation push, managed photo / stream, TTS, telemetry. The local hardware path
(display, BLE, mic, storage, IMU, notifications) is untouched. That keeps the change
small and reviewable.

**D5. Auth moves into `cloud.auth`.** The v2 access token and miniapp-scoped tokens
are owned by the cloud-client; miniapps receive only the scoped token. See
[`../001-cloud-core/auth/design.md`](../001-cloud-core/auth/design.md).

## 8. Current vs proposed v2: the code that changes

The host-injected transport hook (`mobile/modules/island/src/runtime/config.ts`),
today then v2:

```ts
// today
interface SocketCommsAdapter {
  sendMessage: (message: object) => void
  updatePhoneSubscriptions: (subscriptions: string[]) => void
}

// v2 (typed against @mentra/cloud-runtime/protocol)
interface RuntimeCloudAdapter {
  setSubscriptions: (subs: AudioSubscription[]) => Promise<void>
  onTranscript: (cb: (d: TranscriptionData) => void) => () => void
  onTranslation: (cb: (d: TranslationData) => void) => () => void
  requestManagedPhoto: (opts: PhotoOptions) => Promise<PhotoResult>
  startManagedStream: (opts: StreamOptions) => Promise<ManagedStream>
  // ...connection lifecycle
}
```

The call site that builds subscriptions
(`mobile/modules/island/src/services/LocalMiniappRuntime.ts`,
`updateCloudSubscriptions()`), today then v2:

```ts
// today: magic strings
const cloudStreams = new Set<string>()
for (const [stream, subscribers] of this.streamSubscribers) {
  if (subscribers.size === 0) continue
  if (stream.startsWith("transcription:") || stream.startsWith("translation:"))
    cloudStreams.add(stream)               // "transcription:en-US"
}
getRuntimeHooks().socketComms?.updatePhoneSubscriptions(Array.from(cloudStreams))

// v2: typed AudioSubscription, validated by the shared protocol
const subs: AudioSubscription[] = []
for (const [stream, subscribers] of this.streamSubscribers) {
  if (subscribers.size === 0) continue
  if (stream.startsWith("transcription:"))
    subs.push({ kind: "transcription",
                language: { mode: "specific", code: stream.slice("transcription:".length) } })
  else if (stream.startsWith("translation:"))
    subs.push(parseTranslation(stream))    // -> { kind: "translation", source, target }
}
await getRuntimeHooks().cloud?.setSubscriptions(subs)   // cloud.runtime.setSubscriptions -> REST PUT /api/audio/subscriptions
```

A command call site
(`LocalMiniappRuntime.handleManagedStreamStart()`), today then v2:

```ts
// today: raw {type:...}
getRuntimeHooks().socketComms?.sendMessage({
  type: "managed_stream_request", packageName: "__phone__",
  requestId: streamRequestId, restreamDestinations: payload.restreamDestinations,
})

// v2: typed method
const { streamId } = await getRuntimeHooks().cloud?.startManagedStream({
  restreamDestinations: payload.restreamDestinations,
})
```

The string `"transcription:en-US"` gets mapped to an `AudioSubscription` once, where
subscriptions are built. After that the value is typed all the way to the cloud.

## 9. Current vs proposed v2: end to end (a transcription subscription)

A miniapp's background JSContext runs `session.transcription.on(cb)`.

- **Today (v1):** the message -> `MentraJSRouter` -> `LocalMiniappRuntime`
  (`streamSubscribers += this app`) -> `updateCloudSubscriptions()` ->
  `socketComms.updatePhoneSubscriptions(["transcription:en-US"])` -> `SocketComms`
  WS `phone_subscription_update` -> v1 cloud. Transcript comes back as `data_stream`
  -> `LocalMiniappRuntime.forwardEvent()` -> back through `MentraJSRouter` to the
  JSContext's `cb`.
- **v2:** same up to `LocalMiniappRuntime`, which builds
  `[{ kind: "transcription", language: { mode: "specific", code: "en-US" } }]` and
  calls `cloud.runtime.setSubscriptions(subs)` -> REST `PUT /api/audio/subscriptions`
  on v2 cloud. Transcript comes back via `cloud.runtime.onTranscript` (WS push) ->
  `forwardEvent()` -> the JSContext `cb`. The hardware path (mic capture, BLE,
  display) is unchanged.

## 10. Proposals on the points still open

A few things aren't pinned down yet. Instead of listing them as open questions,
here's the direction we'd take for each.

- **The injected surface is `cloud.runtime` itself, with no translation layer.**
  Instead of defining a separate island adapter interface and mapping it onto
  `cloud.runtime`, inject the `cloud.runtime` surface directly as the `cloud` hook.
  Its methods already match what the runtime needs (`setSubscriptions`,
  `onTranscript`, `onTranslation`, `requestManagedPhoto`, `startManagedStream`, the
  connection lifecycle), and they're typed against the shared protocol. One surface,
  no mapping layer to drift. (Supersedes the per-hook shape in
  [`island-adapter.md`](./island-adapter.md).)
- **One transport-selection point at boot.** Construct `CloudClient` where
  `configureRuntime` runs today and pick v1 vs v2 there with a single flag,
  defaulting to v2 for the v2 cloud. Keep the choice in one place so the rest of the
  runtime never branches on cloud version.
- **UDP audio: encrypt in the isomorphic core, send native.** Do the NaCl secretbox
  encryption in the cloud-client core (tweetnacl) and inject only a thin native
  socket for sending bytes. The crypto stays testable in Node (the harness) and
  identical on device; the native layer just does I/O. (Detail in
  [`spike.md`](./spike.md).)

## References

- [`README.md`](./README.md), [`spec.md`](./spec.md): the cloud-client overview and
  concrete API.
- [`island-adapter.md`](./island-adapter.md): the per-hook adapter proposal (to be
  folded into this doc during the cloud-client doc cleanup).
- [`../002-cloud-runtime/protocol.md`](../002-cloud-runtime/protocol.md): the v2
  transport contract the cloud-client implements.
- [`../001-cloud-core/auth/design.md`](../001-cloud-core/auth/design.md): how auth
  moves into `cloud.auth`.
- On-device code (base + PR #3086 `fixes-navigation-bitmaps`):
  `mobile/modules/island/src/services/LocalMiniappRuntime.ts`,
  `mobile/modules/island/src/runtime/config.ts`,
  `mobile/modules/island/src/services/MentraJSRouter.ts`,
  `mobile/modules/miniapp/src/session.ts`,
  `mobile/src/services/{MantleManager,SocketComms,RestComms,WebSocketManager}.ts`,
  `agents/local-app-runtime-plan.md`.
