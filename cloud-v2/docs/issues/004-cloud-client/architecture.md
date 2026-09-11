# Cloud Client and the phone-to-cloud connection: architecture and alignment

**Status:** Alignment doc for the on-device runtime and the cloud-v2 work. Read it
to get the whole picture: how a local miniapp runs on the phone and reaches the
cloud, what `@mentra/cloud-client` is and why it exists, how auth works for Mentra
and for OEMs, and the decisions behind building the new connection once, typed, with
no tech debt.

Throughout, **the transport** means the code on the phone that carries messages to
and from the cloud: it opens the connection, sends requests up (like "stream me
English transcripts"), and receives events back (like the transcripts themselves).
Today there's one transport, for the v1 cloud; we're adding a second, for the v2
cloud.

**TL;DR:** Local miniapps never talk to the cloud directly. The phone is the hub: it
runs the miniapp (a background JSContext plus an optional WebView UI), handles most
things on the phone, and passes a few services through to the cloud on the miniapps'
behalf. Today that pass-through goes through the v1 transport, `SocketComms` /
`RestComms`. We're adding a second transport for v2, `@mentra/cloud-client`, plugged
in the same way (the host's `configureRuntime` hook). On the v2 path the on-device
runtime speaks the typed v2 protocol directly (typed values, not magic strings),
using the same `@mentra/cloud-runtime/protocol` types as the cloud server and the
test harness, so on-device and cloud can't drift.

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
(`mobile/modules/engine/src/services/AppRegistry.ts`, "Two-layer bundles ship
`entry.background` and optional `entry.ui`"):

- **Background layer:** `src/background/index.ts`, the miniapp's logic. It runs in a
  small JavaScript engine on the phone (a "JSContext", JavaScriptCore on iOS) with no
  screen and no web page, and it keeps running even when the UI is closed.
  `mobile/modules/miniapp/src/background/index.ts`: "the always-running JSContext
  side of a two-layer miniapp."
- **UI layer:** `src/ui/`, the miniapp's screen, an ordinary web page running in a
  **WebView** (the phone's embedded browser). Optional, and it's mounted and torn
  down as the user opens and closes the screen.

The **`MiniappSession`** (`mobile/modules/miniapp/src/session.ts`, the
`session.display` / `session.transcription.on(...)` / `session.storage` API) lives
**only in the background JSContext**. The UI has no session of its own; it talks to
the background over an **RPC bridge** (`window.mentra` / the `ui` module) and the
background does the actual session work. So all the cloud-facing calls come from one
place, the background.

Three bridges wire it together (all `mobile/modules/engine/src/services/`):

| Bridge | Connects | File |
| --- | --- | --- |
| **MentraJSRouter** | phone host <-> background JSContext | `MentraJSRouter.ts` |
| **MentraUIRouter** + `window.mentra` shim | UI WebView <-> its background JSContext | `MentraUIRouter.ts`, `mentraUiShim.ts` |
| **LocalMiniappRuntime** | the phone-side hub everything funnels into | `LocalMiniappRuntime.ts` |

Then the lifecycle pieces: `MentraJSCrashController` (respawn on crash),
`MentraJSLogPipeline` (logs out of the JSContext), `MiniappRunningRegistry`
("running" means the background JSContext is alive). Starting and killing those
JSContexts is done by native code the runtime calls (`MentraJSCrustBinding`); on iOS
the engine is `JSContext`.

So the "two JS contexts" the auth docs talk about are real here: a background
JSContext and a UI WebView. (The engine is JSContext, not Crust. Crust is native
image/video/navigation utilities.)

## 3. What crosses to the cloud, and what doesn't

Every call a miniapp makes through its session (`session.display`,
`session.transcription.on(...)`, and so on) arrives at `LocalMiniappRuntime` on the
phone. It either handles the call right there on the phone, or forwards it to the
cloud on the miniapp's behalf. From `agents/local-app-runtime-plan.md`:

- **Handled on the phone (never reaches the cloud):** display (to glasses over BLE),
  LED, audio playback, button / touch, head position / IMU, battery, connection
  state, VAD, raw mic chunks, location, phone notifications, calendar, simple
  storage. This is most of what a miniapp does.
- **Passed through to the cloud:** speech-to-text (`transcription:*`), translation
  (`translation:*`), TTS, managed photo / managed stream, telemetry. The phone
  subscribes to the cloud once on behalf of all the local miniapps, combining their
  requests (three miniapps wanting `transcription:en-US` is one subscription to the
  cloud).

That split is what keeps this change small: only the services that get passed through
to the cloud are affected, so only those change when we swap v1 for v2. The local
hardware path doesn't care which cloud exists.

## 4. How the phone talks to the cloud today (v1)

Only the passed-through services from section 3 reach the cloud, and they all go
through one piece of phone code: the transport (again, the code that carries messages
to and from the cloud). The island runtime doesn't
reach for it directly; the host hands it in at startup through `configureRuntime`
(the function the phone calls once at boot to give the runtime its transport, audio,
settings, and so on). Today the host hands in the v1 `SocketComms` / `RestComms`:

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

Here's what actually travels over it:

- **Telling the cloud what to stream down.** The runtime keeps track of what each
  miniapp has subscribed to (a transcript in English, a translation, and so on). When
  that set changes, `updateCloudSubscriptions()` combines it across every running
  miniapp and sends the list up to the cloud
  (`updatePhoneSubscriptions([...])`, which `SocketComms` puts on the WebSocket as
  `{ type: "phone_subscription_update", subscriptions }`). That's how the cloud knows
  which audio to process for this phone and which events to stream back. Today the
  list is just strings like `"transcription:en-US"`.
- **One-off requests (a photo, a live stream).** When a miniapp asks for a managed
  photo or a stream, the runtime sends a single message up, e.g.
  `sendMessage({ type: "managed_stream_request", ... })`, or for photos a REST call
  (`requestMiniappSdkPhoto` -> `mobile/src/services/RestComms.ts`). These are plain
  objects with a `type` field and no type-checking.
- **Opening the connection.** `mobile/src/services/WebSocketManager.ts` opens the
  WebSocket and logs it in with the v1 token (passed in the URL).
- **Events coming back from the cloud.** Everything the cloud sends lands in
  `SocketComms.handle_message()`, which reads each message's `type` field and decides
  where it goes. A transcript arrives as a `data_stream` message and is handed to
  `LocalMiniappRuntime.forwardEvent()`, which delivers it to the miniapps that
  subscribed. A finished photo arrives as `phone_photo_ready` and goes to
  `handleCloudMessage()`.

v2 changes two things here: those subscription strings (`"transcription:en-US"`) and
those untyped `type`-tagged objects both become typed values.

## 5. What `@mentra/cloud-client` is, and why it exists

`@mentra/cloud-client` is a TypeScript library, just code, no screen or UI, that
handles the phone's whole connection to Cloud v2. The same library also runs on a
server (in Node), and that's the trick: our backend test harness drives the exact
same client the phone runs, so anything the tests prove also holds on the phone. It
exposes three areas: `cloud.auth` (login and tokens), `cloud.runtime` (the live
audio and event session), and optional `cloud.core` (the other v2 REST calls). The parts that
differ by platform (the WebSocket, the UDP socket, secure storage) are passed in from
outside, so the one library runs unchanged on the phone and on a server. Full API in
[`spec.md`](./spec.md).

Why a separate library instead of more methods on `SocketComms`:

- **It's the v2 protocol, kept separate.** v1 `SocketComms` is built around the v1
  wire. v2 has a clean message format, REST for commands, WebSocket for push, and v2
  auth. Bolting that onto the same class just rebuilds the tech debt we're trying to
  leave behind.
- **One contract, shared by everyone.** The cloud-client speaks only the shared type
  definitions in `@mentra/cloud-runtime/protocol`: the same types the **cloud server**
  checks every message against, and the ones the **test harness** builds its requests
  from. (That test harness is just this same library running on a server.) So:

  > the on-device runtime, the cloud server, and the test harness all validate the
  > same types. On-device can't silently diverge from what the cloud accepts,
  > because there's one definition and it's type-checked on every side.

  That's the real reason to type the on-device path against the protocol instead of
  hand-maintaining strings: change a subscription or event type and it's a compile
  error everywhere it matters, and a green test-harness run is evidence the phone
  will work too.
- **Auth in one place.** `cloud.auth` supplies the `cloud-runtime` token for live
  services and, when Core is configured, the `cloud-core` token plus
  miniapp-scoped tokens. The phone stops hand-managing tokens for transport, and
  runtime-only hosts do not need a dummy Core endpoint.

## 6. Auth: how the device and miniapps authenticate

`cloud.auth` is the one owner of credentials on the device. It's a module of the
cloud-client, so the same code authenticates the phone for Mentra and for OEMs,
while allowing Runtime and Core to use different token providers. The Runtime token
is sent as the Bearer to Cloud Runtime Services (`aud = "cloud-runtime"`). When Core
is configured, the Core token is sent to Core-owned APIs (`aud = "cloud-core"`) and
is used to mint per-miniapp tokens. Core/runtime bearer tokens are **never handed to
a miniapp**: a miniapp only ever holds its own scoped token (below).

### Device auth (the phone proves who the user is to v2 cloud)

In Core-backed deployments, the cloud-client is constructed with a **subject token**
and exchanges it at `POST /api/client/auth/exchange` for Core credentials. Hosted
Runtime can obtain a normalized `cloud-runtime` token through that same Core/Auth
trust broker. Runtime-only deployments instead provide `auth.runtime.getToken()`
from an OEM backend, local/dev issuer, or already-issued token and do not configure
`endpoints.core`.

What the subject token is depends on who's running the app:

- **OEM users.** The OEM's own backend mints a short-lived signed JWT for the
  signed-in user (the OEM owns its accounts; there's no Mentra login screen). The
  OEM's host app hands that JWT to the cloud-client at construction. Mentra verifies
  it against the OEM's registered public key and maps `(tenantId, tenantUserId)` to a
  `mentraUserId`.
- **Mentra users.** Mentra is "OEM zero" (`tenantId = "mentra"`). The subject token is
  the existing core token during the transition, a Supabase session at the end
  state, same endpoint.

Either way, hosted deployments normalize identity to `mentraUserId` + `tenantId`.
`cloud.runtime` uses a `cloud-runtime` token; `cloud.core` uses a `cloud-core`
token when configured. Full mechanics:
[`../001-cloud-core/auth/design.md`](../001-cloud-core/auth/design.md) and
[`../007-runtime-auth-independence/README.md`](../007-runtime-auth-independence/README.md).

### Miniapp auto-auth (a miniapp calls its own backend as the user)

A miniapp with its own developer backend needs to call it as the current user, with
no login. Core/runtime bearer tokens never go to the miniapp (they are device
credentials). Instead:

1. At launch the runtime asks the cloud-client for a **miniapp-scoped token**:
   `cloud.auth.getMiniappToken(packageName)`. cloud-core mints an Ed25519 JWT with
   `sub = mentraUserId`, `tenantId`, and `aud = <packageName>`, short-lived, scoped to
   that one miniapp.
2. The runtime hands that token to the **background JSContext** (via
   `MentraJSRouter`), which owns the session. The background's `useMentraAuth()`
   exposes `{ mentraUserId, token }`. If the UI needs them too, it gets them from the
   background over the RPC bridge (`window.mentra`), since the UI has no session of
   its own.
3. The miniapp calls its developer backend with
   `Authorization: Bearer <miniapp-scoped-token>`. The backend verifies it against
   Mentra's published public keys (JWKS), checks `aud == its packageName`, and applies
   its trust policy on `tenantId`. No per-request call to Mentra.
4. The runtime re-mints and re-injects before expiry (`cloud.auth` caches per
   packageName).

On the v2 path, auto-auth adds a little on-device work: hold a `cloud.auth`, grab the
scoped token at launch, inject it into both contexts, and re-inject before it
expires. The bridges already exist (they carry the session messages); the auth token
is just one more message over them.

Common questions this answers:

- **"How does an OEM's user reach our cloud with no Mentra account?"** Their backend
  vouches with a signed JWT; Core/Auth can exchange that into Core credentials and,
  for hosted Runtime, broker a normalized `cloud-runtime` token.
- **"How does a miniapp know who the user is and call my backend safely?"** A
  per-miniapp token the backend verifies itself via JWKS, audience-pinned so a token
  for miniapp A can't be replayed against miniapp B.
- **"Where do tokens live?"** `cloud.auth` owns Core/runtime bearer tokens and sends
  them only to their matching services; a miniapp only ever holds its own scoped
  token, never the Core/runtime bearer tokens.

For the from-zero version of these terms (JWT, asymmetric signing, JWKS, audience,
exchange), see [`../001-cloud-core/auth/concepts.md`](../001-cloud-core/auth/concepts.md).

## 7. The decisions

The calls we've made, so this gets built once.

**D1. The cloud-client is the v2 transport, injected at the existing
`configureRuntime` hook.** It's not a rewrite of the island runtime. The host
constructs `new CloudClient(...)` and injects its surface where v1 `socketComms`
goes today. The island runtime still owns the logic that tracks each miniapp's
subscriptions, combines them, and delivers each incoming event to the miniapps that
asked for it.

**D2. Change the island runtime and kill the string shapes (typed hook).** The
`socketComms` hook (`sendMessage(object)`, `updatePhoneSubscriptions(string[])`) is
replaced by a typed v2 surface, and the handful of `LocalMiniappRuntime` call sites
that build v1 shapes are updated to build typed values from
`@mentra/cloud-runtime/protocol` and call typed `cloud.runtime.*` methods. Why: no
tech debt, real TypeScript safety, and it matches the cloud and the test harness by
construction. The alternative (keep the v1 signatures and translate on the host side)
would keep the magic-string surface alive inside the runtime and reintroduce a drift
point, so we're not doing that.

**D3. The local SDK runs on cloud-client. There's no v1/v2 toggle.** The on-device
local-miniapp path uses cloud-client (v2); that's the only path it has. The v1
`SocketComms` / `RestComms` stays only for the legacy mobile stack on the v1 cloud,
and the runtime never branches on "which cloud version". The move to cloud-client is
a rollout sequence, not a runtime flag (see "Rollout" below).

**D4. Only the services that go to the cloud change.** Subscriptions, transcript /
translation coming back, managed photo / stream, TTS, telemetry. The local hardware
path (display, BLE, mic, storage, IMU, notifications) is untouched. That keeps the
change small and reviewable.

**D5. Auth moves into `cloud.auth`.** Runtime and Core token providers plus
miniapp-scoped tokens are owned by the cloud-client; miniapps receive only the
scoped token. See [`../001-cloud-core/auth/design.md`](../001-cloud-core/auth/design.md)
and [`../007-runtime-auth-independence/README.md`](../007-runtime-auth-independence/README.md).

**D6. Runtime status is a cloud-client concept, not a protocol enum.** The package
exposes `RuntimeStatus`, `RuntimeAudioTransport`, and `RuntimeSnapshot` so the host
can render accurate debug UI and make fallback decisions. These names stay generic
inside cloud-client; "Cloud V2" is a mobile/debug label, not part of the SDK's type
surface.

## 8. Current vs proposed v2: the code that changes

The host-injected transport hook (`mobile/modules/engine/src/runtime/config.ts`),
today then v2:

```ts
// today
interface SocketCommsAdapter {
  sendMessage: (message: object) => void
  updatePhoneSubscriptions: (subscriptions: string[]) => void
}

// v2 (typed against @mentra/cloud-runtime/protocol)
interface CloudRuntimeAdapter {
  setSubscriptions: (subs: AudioSubscription[]) => Promise<void>
  onTranscript: (cb: (d: TranscriptionData) => void) => () => void
  onTranslation: (cb: (d: TranslationData) => void) => () => void
  requestManagedPhoto: (opts: PhotoOptions) => Promise<PhotoResult>
  startManagedStream: (opts: StreamOptions) => Promise<ManagedStream>
  // ...connection lifecycle
}
```

The call site that builds subscriptions
(`mobile/modules/engine/src/services/LocalMiniappRuntime.ts`,
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
  no mapping layer to drift.
- **UDP audio: encrypt in the shared cloud-client code, send from native.** Do the
  NaCl secretbox encryption inside the cloud-client itself (the code that runs the
  same on phone and server, using tweetnacl), and pass in only a thin native socket to
  send the bytes. That keeps the encryption testable on a server and identical on the
  phone; the native side just sends and receives.

## 11. Rollout

Moving the local SDK onto cloud-client is a sequence, not a switch you flip:

1. Build the **cloud-runtime** (the v2 cloud, issue 002) until the audio path works
   end to end.
2. Build **`@mentra/cloud-client`**.
3. Use cloud-client as the **integration-test harness** for the runtime: the node
   build drives the real connection (auth, connect, subscribe, send audio, receive
   transcripts) against the runtime, so the runtime gets exercised by the exact client
   the phone will use. This is where we get confident the client and its dependencies
   work.
4. Once that's proven, **wire the rest of the mobile app's local-SDK path onto
   cloud-client**.

There's no per-session v1/v2 flag anywhere in this. The local SDK targets cloud-client
from the start; the legacy v1 stack stays on its own separate path until it's retired.

## References

- [`README.md`](./README.md), [`spec.md`](./spec.md): the cloud-client overview and
  concrete API.
- [`../002-cloud-runtime/protocol.md`](../002-cloud-runtime/protocol.md): the v2
  protocol the cloud-client implements.
- [`../001-cloud-core/auth/design.md`](../001-cloud-core/auth/design.md): how auth
  moves into `cloud.auth`.
- On-device code (base + PR #3086 `fixes-navigation-bitmaps`):
  `mobile/modules/engine/src/services/LocalMiniappRuntime.ts`,
  `mobile/modules/engine/src/runtime/config.ts`,
  `mobile/modules/engine/src/services/MentraJSRouter.ts`,
  `mobile/modules/miniapp/src/session.ts`,
  `mobile/src/services/{MantleManager,SocketComms,RestComms,WebSocketManager}.ts`,
  `agents/local-app-runtime-plan.md`.
