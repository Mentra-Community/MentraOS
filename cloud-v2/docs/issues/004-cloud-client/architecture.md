# Cloud Client and on-device transport: architecture and alignment

**Status:** Alignment doc. Shared reference for the on-device runtime team and the
cloud-v2 team. Its job: give everyone one mental model of how a local miniapp runs
on the phone and reaches the cloud, explain what `@mentra/cloud-client` is and why
it exists, and record the decisions we have made so we build the v2 transport once,
typed, with no tech debt.

**TL;DR:** Local miniapps never talk to the cloud directly. The phone is the single
hub: it runs the miniapp (a background JSContext plus an optional WebView UI),
handles most things locally, and proxies a small set of services to the cloud. That
cloud proxy is today the v1 `SocketComms` / `RestComms`. We are adding a parallel
**v2 transport**, `@mentra/cloud-client`, injected at the same seam. On the v2 path
the on-device runtime speaks the typed v2 protocol directly (no stringly shapes),
using the **same** `@mentra/cloud-runtime/protocol` types the cloud server and the
backend test harness use, so on-device and cloud cannot drift.

This doc spans three codebases at different stages; keep them straight:

| Where | State | What lives there |
| --- | --- | --- |
| base mobile app (`mobile/`, on `dev`) | live | v1 transport: `SocketComms`, `RestComms`, the `configureRuntime` seam |
| PR #3086 `fixes-navigation-bitmaps` | in flight, not merged | the two-layer local miniapp runtime (background JSContext + UI WebView) |
| `cloud-v2/` (this repo area) | in progress | the v2 cloud, `@mentra/cloud-client`, `@mentra/cloud-runtime/protocol` |

Paths below are monorepo-root-relative.

---

## 1. The shape of the system

Two clouds, and the phone sits between glasses and cloud:

```
  glasses  <--BLE-->  PHONE (the hub)  <--one connection per cloud-->  CLOUD
                          |
                          +-- runs local miniapps on-device
```

- **Cloud v1** (today): the phone holds one authenticated WebSocket plus REST.
- **Cloud v2** (in progress): a separate cloud, separate domain, v2-native
  protocol, reached through `@mentra/cloud-client`.

The load-bearing fact: **a local miniapp never opens its own cloud connection.** It
talks to the phone; the phone is the only thing with a cloud link. So swapping the
cloud transport is contained to the phone, and invisible to miniapp code.

## 2. How a local miniapp runs on-device (PR #3086)

A local miniapp bundle (a ZIP) ships two entry points
(`mobile/modules/island/src/services/AppRegistry.ts`, "Two-layer bundles ship
`entry.background` and optional `entry.ui`"):

- **Background layer:** `src/background/index.ts`, runs in an **always-on
  JSContext** (JavaScriptCore on iOS). The miniapp's logic. Headless, no DOM, stays
  alive when the UI is closed. `mobile/modules/miniapp/src/background/index.ts`:
  "the always-running JSContext side of a two-layer miniapp."
- **UI layer:** `src/ui/`, runs in a **WebView** (React, DOM), optional, mounted
  and torn down as the user opens/closes the screen.

Both layers use the same SDK object, `MiniappSession`
(`mobile/modules/miniapp/src/session.ts`): `session.display`,
`session.transcription.on(...)`, `session.storage`, etc.

Three bridges wire it together (all `mobile/modules/island/src/services/`):

| Bridge | Connects | File |
| --- | --- | --- |
| **MentraJSRouter** | phone host <-> background JSContext | `MentraJSRouter.ts` |
| **MentraUIRouter** + `window.mentra` shim | UI WebView <-> its background JSContext | `MentraUIRouter.ts`, `mentraUiShim.ts` |
| **LocalMiniappRuntime** | the phone-side hub everything funnels into | `LocalMiniappRuntime.ts` |

Lifecycle plumbing rounds it out: `MentraJSCrashController` (respawn on crash),
`MentraJSLogPipeline` (logs out of the JSContext), `MiniappRunningRegistry`
("running" means the background JSContext is alive). The native spawn/kill is a
binding (`MentraJSCrustBinding`); the iOS engine is `JSContext`.

So the "two JS contexts" the auth design refers to are real here: a **background
JSContext** and a **UI WebView**. (The engine is JSContext, not Crust. Crust is
native image/video/navigation utilities.)

## 3. What crosses to the cloud, and what does not

`LocalMiniappRuntime` receives every `session.*` call (via `MentraJSRouter`) and
either handles it locally or proxies it to the cloud. Per
`agents/local-app-runtime-plan.md`:

- **Local, no cloud:** display (to glasses over BLE), LED, audio playback, button /
  touch, head position / IMU, battery, connection state, VAD, raw mic chunks,
  location, phone notifications, calendar, simple storage. This is most of the
  surface.
- **Cloud-proxied through the phone:** speech-to-text (`transcription:*`),
  translation (`translation:*`), TTS, managed photo / managed stream, telemetry.
  The phone subscribes to the cloud on behalf of all local miniapps, **aggregated**
  (three miniapps wanting `transcription:en-US` is one cloud subscription).

**This is the scoping insight for the whole transport change: only the
cloud-proxied bucket touches the cloud, so only that bucket is affected by swapping
v1 transport for v2.** The local hardware path does not care which cloud exists.

## 4. The transport today (v1)

The cloud-proxied traffic goes through the host's transport, injected into the
island runtime at the `configureRuntime` seam
(`mobile/modules/island/src/runtime/config.ts`, the `socketComms` hook), wired in
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
  `LocalMiniappRuntime.forwardEvent(streamType, data)` (fans a transcript out to the
  subscribed miniapps); `phone_photo_ready` / `phone_stream_status` ->
  `LocalMiniappRuntime.handleCloudMessage()`.

Two properties to notice, because v2 removes both: subscriptions are **stringly**
(`"transcription:en-US"`), and messages are **raw untyped objects** keyed by a
`type` string.

## 5. What `@mentra/cloud-client` is, and why it exists

`@mentra/cloud-client` is a headless, isomorphic TypeScript library that is the
device's single connection to **Cloud v2**. It owns auth, the runtime transport,
and device-facing core calls, behind three modules (`cloud.auth`, `cloud.runtime`,
`cloud.core`). Platform pieces (WebSocket, UDP, secure storage) are injected, so the
same core runs on the phone and in Node. Full API in
[`spec.md`](./spec.md).

Why a dedicated library rather than more methods on `SocketComms`:

- **It is the v2 protocol, isolated.** v1 `SocketComms` is shaped around the v1
  wire. v2 has a clean envelope, REST-for-commands, WS-for-push, and v2 auth. Mixing
  them into one class rebuilds the tech debt we are trying to leave behind.
- **One contract, shared by everyone.** The cloud-client speaks only
  `@mentra/cloud-runtime/protocol`: the zod types and validators that the **cloud
  server** produces against and the **backend test harness** drives. The same
  library, with Node transports, is the test client. So:

  > the on-device runtime, the cloud server, and the test harness all validate the
  > same types. On-device cannot silently diverge from what the cloud accepts,
  > because there is one definition and it is type-checked on every side.

  That is the core reason to type the on-device path against the protocol rather
  than hand-maintain string shapes: a change to a subscription or event type is a
  compile error everywhere it matters, and a green test-harness run is evidence the
  phone will work too.
- **Auth lives in one place.** `cloud.auth` holds the v2 access token and mints
  miniapp-scoped tokens; the raw access token never reaches a miniapp. The phone
  stops hand-managing tokens for transport.

## 6. The decisions

Recorded so we build it once.

**D1. The cloud-client is the v2 transport, injected at the existing
`configureRuntime` seam.** It is not a rewrite of the island runtime. The host
constructs `new CloudClient(...)` and injects its surface where v1 `socketComms`
goes today. The island runtime stays the owner of subscription aggregation and
fan-out.

**D2. Change the island runtime and kill the string shapes (typed seam).** The
`socketComms` hook (`sendMessage(object)`, `updatePhoneSubscriptions(string[])`) is
replaced by a typed v2 surface, and the handful of `LocalMiniappRuntime` call sites
that build v1 shapes are updated to build typed values from
`@mentra/cloud-runtime/protocol` and call typed `cloud.runtime.*` methods.
Rationale: no tech debt, real TypeScript safety, and parity with the cloud and the
test harness by construction. The alternative (keep v1 signatures, translate on the
host side) would preserve the stringly surface inside the runtime and reintroduce a
drift point; we are not doing that.

**D3. v1 and v2 coexist as separate transport paths.** The v1 `SocketComms` /
`RestComms` stays for the v1 cloud. The cloud-client is the v2 path. A device /
session selects one. We are adding a path, not ripping one out.

**D4. Scope is the cloud-proxied bucket only.** Subscriptions, transcript /
translation push, managed photo / stream, TTS, telemetry. The local hardware path
(display, BLE, mic, storage, IMU, notifications) is untouched. This keeps the change
small and reviewable.

**D5. Auth moves into `cloud.auth`.** The v2 access token and miniapp-scoped tokens
are owned by the cloud-client; miniapps receive only the scoped token. See
[`../001-cloud-core/auth/design.md`](../001-cloud-core/auth/design.md).

## 7. Before and after, at the seam

The seam shape (`mobile/modules/island/src/runtime/config.ts`), v1 then v2:

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
`updateCloudSubscriptions()`), v1 then v2:

```ts
// today: stringly
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
(`LocalMiniappRuntime.handleManagedStreamStart()`), v1 then v2:

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

The stringly `"transcription:en-US"` is mapped to an `AudioSubscription` exactly
once, where subscriptions are built; after that the value is typed all the way to
the cloud.

## 8. End-to-end trace: a transcription subscription

A miniapp's background JSContext runs `session.transcription.on(cb)`.

- **Today (v1):** envelope -> `MentraJSRouter` -> `LocalMiniappRuntime`
  (`streamSubscribers += this app`) -> `updateCloudSubscriptions()` ->
  `socketComms.updatePhoneSubscriptions(["transcription:en-US"])` -> `SocketComms`
  WS `phone_subscription_update` -> v1 cloud. Transcript returns as `data_stream` ->
  `LocalMiniappRuntime.forwardEvent()` -> back through `MentraJSRouter` to the
  JSContext's `cb`.
- **v2:** same up to `LocalMiniappRuntime`, which builds
  `[{ kind: "transcription", language: { mode: "specific", code: "en-US" } }]` and
  calls `cloud.runtime.setSubscriptions(subs)` -> REST `PUT /api/audio/subscriptions`
  on v2 cloud. Transcript returns via `cloud.runtime.onTranscript` (WS push) ->
  `forwardEvent()` -> the JSContext `cb`. The hardware path (mic capture, BLE,
  display) is unchanged.

## 9. What each side owns, and open questions

- **On-device runtime (Matt's domain):** the typed `cloud` adapter shape in
  `runtime/config.ts`, and the handful of `LocalMiniappRuntime` call sites that move
  from v1 shapes to typed `cloud.runtime.*`. The aggregation and fan-out logic stays
  the same; only the values it produces and the method it calls change.
- **cloud-v2 (our domain):** `@mentra/cloud-client` (the library) and
  `@mentra/cloud-runtime/protocol` (the shared types). The host wiring that
  constructs `CloudClient` and injects it through `configureRuntime`.
- **Open questions to settle together:**
  1. The exact typed adapter surface (method names, which lifecycle events) the
     island runtime wants, versus the `cloud.runtime` API in [`spec.md`](./spec.md).
  2. Where `new CloudClient(...)` is constructed and how the v1-vs-v2 path is
     selected at boot.
  3. The native UDP audio boundary on the v2 path (encryption location, the injected
     `udp` interface), tracked in [`spike.md`](./spike.md).

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
