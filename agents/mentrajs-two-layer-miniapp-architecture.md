# MentraJS — Two-Layer Local Miniapp Architecture

**Status:** Proposed
**Authors:** Alex Israelov + Claude

A spec for moving the local miniapp SDK from a persistent-WebView model
to a per-miniapp background JS runtime (JSC on iOS, QuickJS on Android) + on-demand WebView
for UI. Most of the existing SDK (~49% of LoC) lifts unchanged. The
new pieces are bounded: a Swift JSContext runtime in the existing
`crust` module (and a Kotlin/Zipline mirror on Android), a `__dispatch`
bridge, a polyfill bundle, and a WebView-↔-JSContext message bus.

**See also:**
- **Testing strategy** (above the Implementation plan) — three
  layers of tests + per-phase acceptance gates so an agent can
  verify each phase end-to-end.
- **Appendix A** — file-by-file migration of `sdk/example-miniapp/`,
  the canonical fixture and integration test fixture.
- **Appendix B** — SDK + CLI migration checklist.

**Pre-refactor merges to keep in mind:**
- **2026-05 navigation + heading SDK** (PR #2779, merged into
  `mentra-miniapp-sdk-2`). Adds `session.navigation`,
  `session.heading`, a pivot engine, the `location_stream` rate
  alias, and ref-counted singleton services in `crust`. Most of
  this lifts verbatim into the JSC world — the reuse tables below
  reflect the post-merge surface. The pieces that need careful
  forwarding into the JSC port are flagged inline (Phase 2's
  acceptance gates cover them).

---

## Why this exists

The current local SDK gives every running miniapp its own persistent
`WKWebView` in the Mentra Manager iOS app. Stress test on iPhone 15
release build:

- 1 backgrounded WebView → ✅ stable
- 5 backgrounded WebViews → ✅ stable
- 10 backgrounded WebViews → ☠️ jetsam'd within ~1 second

(Total host resident memory was ~1.0–1.2 GB across the 1- and 5-app
runs — variation came from baseline RN/Sentry/Metro state at sample
time, not from per-WebView count. The point is the ceiling at 10.)

Each `react-native-webview` instance is a separate
`com.apple.WebKit.WebContent` OS process carrying ~80–150 MB of WebKit
baseline. **This overhead is WebKit's, not ours — no flag makes it
smaller.** Projecting to user devices:

| Device | RAM | Backgrounded WebViews we can sustain |
|---|---|---|
| iPhone 15 Pro Max | 8 GB | 8–10 |
| iPhone 15 / 14 | 6 GB | 5–7 |
| iPhone 13 / 12 | 4–6 GB | 3–5 |
| iPhone SE 3 (2022) | 4 GB | 1–2 |
| iPhone SE 2 (2020) | 3 GB | 0–1 |

Product requires miniapps to **keep running with the phone screen off
and the Mentra app backgrounded, with glasses connected**. On
SE-class devices, a single backgrounded miniapp consumes the entire
jetsam budget. We can't ship that.

The fix is to stop using a WebView for the always-on background half
of a miniapp. WebKit overhead is fine when a user is *looking* at
settings (one WebView at a time, foreground); it's fatal when we
silently keep N of them warm to relay glasses events.

---

## The architecture

Each miniapp ships as **two cooperating layers in one bundle**:

1. **Background layer (MentraJS)** — a per-miniapp JS context
   (Apple's `JSContext` on iOS, QuickJS via Cash App's Zipline on
   Android), one per installed miniapp, **always running** while
   the host app process is alive. ~3-5 MB resident per context on
   iOS-JSC; <1 MB per context on Android-QuickJS. No DOM, no
   rendering. Owns all glasses logic. The doc uses `JSContext` as
   shorthand for both engines — the per-miniapp JS sandbox, regardless
   of platform.
2. **UI layer (MentraUI)** — a `WKWebView` (iOS) / Android
   `WebView` spawned **on demand** when the user opens the miniapp's
   settings screen. Destroyed when they navigate away. Standard
   HTML/CSS/JS, full DOM. **Has zero direct native access** — only
   talks to its own background layer via a typed message bus.

This is the **WeChat mini-program model** (logic in JSCore + view in
WebView, native router between) and the **VS Code extension model**
(extension host + sandboxed webview iframe). Well-trodden at
billion-user scale.

```
┌─────────────────────────────────────────────────────────────────┐
│                  Mentra Manager (host RN app)                    │
│                                                                  │
│   ┌──────────────────────┐        ┌─────────────────────────┐    │
│   │ Native iOS / Android │ ←────→ │ MentraJS native router  │    │
│   │ (BLE, mic, display,  │        │ (Swift / Kotlin,        │    │
│   │  storage, location)  │        │  in `crust`)            │    │
│   └──────────────────────┘        └────────────┬────────────┘    │
│                                                │                 │
│              ┌─────────────────────────────────┼──────────────┐  │
│              ▼                                 ▼              ▼  │
│   ┌─────────────────────┐         ┌─────────────────────┐  ...   │
│   │ JS context A        │         │ JS context B        │        │
│   │ (JSC on iOS,        │         │ (JSC on iOS,        │        │
│   │  QuickJS on Android,│         │  QuickJS on Android,│        │
│   │  always alive)      │         │  always alive)      │        │
│   │  __dispatch         │         │  __dispatch         │        │
│   │  polyfills          │         │  polyfills          │        │
│   │  background/        │         │  background/        │        │
│   └──────────┬──────────┘         └─────────────────────┘        │
│              │                                                   │
│              │ ui bus (mentra.send / mentra.on)                  │
│              ▼                                                   │
│   ┌─────────────────────┐                                        │
│   │ WebView (transient) │ ← only when user is looking            │
│   │  window.mentra      │   at this miniapp's settings           │
│   │  no native access   │                                        │
│   └─────────────────────┘                                        │
└──────────────────────────────────────────────────────────────────┘
```

### Invariants

- N JSContexts always alive, one per installed-and-enabled miniapp.
- 0 or 1 WebView at a time (one foreground miniapp UI at a time).
- WebView spawned cold per open, destroyed on exit. No pooling.
- WebView never talks to native directly — all native requests go
  through the WebView's bound JSContext.
- Background → native: `__dispatch(iface, method, args)` (full power).
- Background ↔ WebView: typed `mentra.send`/`mentra.on` message bus
  (per-miniapp namespace, no native access from WebView side).

### Why fresh WebView per open, no pooling

WKWebView cold-mount is ~100-300 ms on iPhone 15. Fine for a settings
sheet. A pool of 1 means the warm WebView is always the *wrong*
miniapp's WebView; we'd `loadFileURL` to swap and only save ~50 ms.
Pool management adds bug surface (orphan messages, stale routing,
dirty global state). Memory cost of a warm WebView in background is
~80 MB permanent — defeats the point. Same pattern Chrome uses for
extension popups.

---

## Engine choice: JavaScriptCore on iOS, QuickJS on Android

Background JS runs in:
- **iOS:** native `JSContext` from `JavaScriptCore.framework`, with
  its own `JSVirtualMachine` per miniapp for heap isolation.
- **Android:** QuickJS via [Cash App's Zipline](https://github.com/cashapp/zipline),
  one Zipline/QuickJS context per miniapp.

In both cases: **not Hermes. Not React Native's runtime. Not a JSI
library. Not a hidden WebView.** Each miniapp gets its own isolated
JS engine instance.

### Why JSC specifically (iOS)

1. **Apple's 2.5.2 carve-out names JSC and WebKit by name** as
   permitted runtimes for downloaded code. Hermes isn't named.
2. **Multi-tenant miniapp host is a different review category than
   self-updating RN apps.** RN/CodePush/EAS Update get away with
   Hermes-on-downloaded-code under the "app updating itself"
   interpretation. We're a platform running arbitrary third-party
   code; we want to be inside the explicit rule text.
3. **Pebble and WeChat both ship native JSC on iOS at scale.** Direct
   precedent for our exact use case.

### Why not piggyback on RN's runtime

Surveyed every JSI isolate library: `react-native-worklets-core`
(Margelo), `react-native-worklets` (Software Mansion),
`react-native-multithreading` (mrousavy). All fall back to whatever
engine RN booted with — Hermes by default in 0.70+. None expose
Apple `JSContext`. The only path is calling `JavaScriptCore.framework`
directly from Swift. Open RN community proposal #193 has been asking
for this primitive for years; remains unresolved.

### Android engine: QuickJS via Zipline

Android uses **QuickJS via [Cash App's Zipline](https://github.com/cashapp/zipline)**
(`app.cash.zipline:zipline:1.27.0+`, Apache 2.0, Kotlin
Multiplatform). One Zipline instance per miniapp wraps a QuickJS
context. ~1.2 MB native lib (~400 KB QuickJS engine + Zipline glue).

The architectural shape mirrors iOS — per-miniapp context, single
`__dispatch` callback, polyfill bundle providing the SDK surface —
and ~95% of the polyfill JS is byte-shared between platforms.

**ECMAScript coverage.** QuickJS-NG covers everything we and modern
miniapp authors will hit: async/await, async iterators, optional
chaining, private class fields, top-level await (in modules), Proxy,
Reflect, BigInt, WeakRef/FinalizationRegistry, Error cause, all the
modern array/object methods, regex with lookbehind / named groups /
Unicode property escapes. **One categorical hole: no `Intl`** —
documented as unsupported on Android in the SDK; miniapps needing
it can opt into `@formatjs/intl`.

**Android implementation in `crust`:**

```
mobile/modules/crust/android/src/main/java/com/mentra/crust/
├── CrustModule.kt                     # existing — add Zipline Functions
├── jsc/JSCRuntime.kt                  # owns N Zipline instances,
│                                      #   one per installed miniapp.
│                                      #   ("JSC" name kept symmetric
│                                      #   with iOS sibling.)
├── jsc/JSCDispatcher.kt               # single __dispatch route per context
└── jsc/JSCPolyfillBridge.kt           # native fetch/WS/timers/storage/crypto
```

Kotlin spawns a context with
`Zipline.create(coroutineScope).also { it.quickJs.evaluate(...) }`,
registers a single Kotlin object exposing
`__dispatch(iface, method, argsJson)` via Zipline's bridge, and
calls back into JS via `evaluate("globalThis.__deliver(${json})")`.

**Mandatory microtask discipline (Android only).** QuickJS keeps
Promise reactions on its own pending-jobs queue. Zipline drains it
during bridge re-entry but **does not expose `executePendingJobs`
publicly** (verified against `cashapp/zipline` trunk:
`QuickJs.kt` exposes only `evaluate`/`compile`/`execute`/`gc`/
`interruptHandler`/memory props; `JS_ExecutePendingJob` is in the
vendored C source with no JNI export). Two viable patterns:

- **(preferred) Resolve via `ZiplineService` suspend.** Every native
  callback that needs to resolve a JS Promise calls back through a
  Kotlin `suspend` exposed as a `ZiplineService`. Zipline's bridge
  resumes the awaiting JS continuation and naturally drains pending
  jobs as part of the resume. This is the supported path; no fork
  needed.
- **(fallback) No-op `evaluate("0")` to force a bridge entry** that
  triggers Zipline's internal drain. Layering violation; works today
  but could break under future Zipline versions. Only use if the
  suspend-based path proves unworkable for a specific shim.

Either way, **iOS-JSC drains automatically via the iOS run loop, so
this is Android-only discipline.** The `JSCPolyfillBridge.kt`
helpers (fetch, WebSocket, crypto, etc.) are written as suspending
Kotlin functions on a `ZiplineService` interface; the JS-side
polyfill calls them via the typed bridge and gets a real `Promise`
that resolves correctly. **~50 LoC of shared scaffolding** to define
the `ZiplineService` interface that all polyfill shims share.

**Two engine-conditional polyfill guards** in the shared startup
bundle (Zipline pre-injects `console.{log,info,warn,error}` and
`setTimeout`/`clearTimeout`):

```js
if (!globalThis.console) installConsole()
if (!globalThis.setTimeout) installTimers()
```

`setInterval` and `queueMicrotask` are always installed (~30 LoC) —
Zipline ships neither.

**Native bridge concretes** (Kotlin, in `JSCPolyfillBridge.kt`):
- `setTimeout`/`setInterval` — `Handler.postDelayed` wrapped in our
  existing `BackgroundTimer` pattern so timers fire under Doze.
- `fetch` / `XMLHttpRequest` core — OkHttp.
- `WebSocket` — OkHttp's `WebSocketListener`.
- `localStorage` — `SharedPreferences` (per-miniapp file name
  `MentraJS-{packageName}`).
- `crypto.subtle` — `javax.crypto` for SHA / AES-GCM / HMAC; **Tink
  for X25519** (Android stdlib X25519 is API 33+ only; Tink keeps
  us minSdk-friendly).
- `crypto.getRandomValues` — `SecureRandom.nextBytes`.

**Two engine-agnostic polyfill caveats** (apply on iOS too):
- `whatwg-url-without-unicode` reaches for `Buffer` in IPv6 paths.
  Pre-bundle with `rollup-plugin-node-polyfills` (or a small `Buffer`
  shim); test the IPv6 path.
- `fetch-blob` references `ReadableStream` which neither engine
  ships. Drop streams (sync `arrayBuffer()` only) or add
  `web-streams-polyfill`.

**Sequencing.** Phase 1 Android ≈ **2-3 weeks**. iOS Phase 1 ships
first (~3 wks); Android follows (~2-3 wks). One engineer sequential
≈ 6 wks; two engineers parallel ≈ ~3 wks calendar.

**Bus factor.** Zipline's maintainer is one engineer at Block. Exit
ramp if it goes dark: fork the engine (QuickJS-NG, ~62K lines C in
`quickjs.c` plus ~20K across `libregexp` / `libunicode` / `libbf` /
`dtoa`, MIT) and write our own JNI bridge providing the surface we
use (suspending bridge methods + Promise resume + microtask drain).
**Realistic budget: 4-6 weeks** for parity with what we'd actually
use — Zipline ships a typed bridge, kotlinx.serialization interop,
source maps wired to QuickJS bytecode, and a coroutine event loop;
our minimal replacement skips the typed-bridge code generation but
must reproduce the suspend resume + drain plumbing. Hot-reload and
typed-interop niceties are lost on the exit ramp.

### Memory profile: measured (iOS), estimated (Android)

**iOS — measured.** Real-device benchmark on iPhone 15 release build,
50 idle JSContexts each running a representative workload (timer +
100-entry state + `__dispatch` stub):

| Wave | Contexts | Resident MB | MB per context |
|---|---|---|---|
| 1 | 1 | 1020 → 1022 | 1.16 |
| 2 | 5 | 1022 → 1024 | 0.70 |
| 3 | 10 | 1024 → 1028 | 0.72 |
| 4 | 25 | 1028 → 1039 | 0.75 |
| 5 | 50 | 1039 → 1058 | 0.75 |

**~0.75 MB per JSContext at rest on iOS. Linear scaling.** With
realistic fetch/WebSocket shims holding NSURLSession instances,
budget ~3-5 MB per context. Even on iPhone SE 2 (3 GB RAM, ~600 MB
jetsam ceiling), 50+ background miniapps fit comfortably.

**Caveat — navigation-active miniapps are heavy and process-singleton.**
A miniapp calling `session.navigation.start` activates the Google
Nav SDK in `crust`, which on iOS holds a hidden `GMSMapView`,
`GMSNavigator`, `GMSRoadSnappedLocationProvider`, plus
`CoreLocation`/`CoreMotion` state — easily ~30-50 MB of process
state on top of the per-JSContext baseline. The Nav SDK is also
**process-singleton**: only one trip can be in flight at a time
across all miniapps, because `NavigationManager` (Swift + Kotlin)
is built around a single `Navigator`. N>1 *contexts* still run
fine; the constraint is N=1 *active trips*. The host enforces this
already via `activeNavApps`/`navListeners` accounting in
`LocalMiniappRuntime`; carry that bookkeeping into the
`MentraJSRouter` rewrite.

Raw log: `agents/spike-results/jsc-spike-iphone15-release-50ctx.log`.
Reproducible via `xcrun devicectl device process launch -e
'{"MENTRA_RUN_JSC_BENCH":"1"}' com.mentra.mentra` then
`xcrun devicectl device copy from --domain-type appDataContainer
--domain-identifier com.mentra.mentra --source Documents/jsc-spike.log`.

**Android — estimated.** QuickJS contexts are ~200-400 KB each (per
QuickJS-NG docs and Cash App's published Zipline measurements),
plus Zipline's per-instance Kotlin overhead (~0.5-1 MB). Budget
**~1-1.5 MB per Android context** vs ~3-5 MB on iOS. Android's
process model also lacks iOS-style jetsam — foreground service +
no offscreen-renderer constraints. Memory ceiling is "whatever
the host RN process can hold," typically ~500 MB before LMK
becomes a concern. **Re-measure with the actual Zipline integration
in Phase 1.** Add to the spike-results folder when done.

---

## Where the native code lives

**Inside the existing `crust` Expo module.** `crust` already owns the
iOS/Android native interface for the SDK — adding a JSC runtime is a
few hundred lines of Swift in there. Don't fragment the module set.

**Rule:** any native code written for the miniapp SDK belongs in
`crust`. That includes the JS runtime, the dispatcher, the polyfill
bridge, and capability natives (nav, heading, future sensors). The
2026-05 navigation merge already follows this pattern. We don't
spin up new Expo modules per capability.

```
mobile/modules/crust/
├── ios/
│   ├── CrustModule.swift                          # add JSC Functions
│   ├── Source/JSCRuntime.swift                    # owns N JSContexts keyed by id
│   ├── Source/JSCDispatcher.swift                 # __dispatch routes
│   ├── Source/JSCPolyfillBridge.swift             # native handlers for fetch/WS/timers/storage/crypto
│   └── ... existing crust files
├── android/
│   └── src/main/java/com/mentra/crust/
│       ├── CrustModule.kt                         # add Zipline Functions
│       ├── jsc/JSCRuntime.kt                      # owns N Zipline instances keyed by id
│       ├── jsc/JSCDispatcher.kt                   # __dispatch routes
│       └── jsc/JSCPolyfillBridge.kt               # native handlers for fetch/WS/timers/storage/crypto
└── src/CrustModule.ts                             # TS types for spawn/evaluate/kill
```

Polyfill JS bundle ships in a separate package
(`mobile/modules/mentrajs-runtime/`) so JS shims iterate independently
of native code. Host loads `dist/startup.js` from that package on every
JSContext spawn.

### Expo module API surface (small)

```typescript
// Functions added to CrustModule (cross-platform Expo Module API,
// implemented twice — once in Swift, once in Kotlin)
spawn(packageName: string, polyfillBundle: string, miniappJs: string): boolean
evaluate(packageName: string, src: string): JSValue
kill(packageName: string): void
dispatchToJs(packageName: string, channel: string, payload: unknown): void
// Event "mentrajs_message" — fires when a JSContext calls __dispatch
// Delivered via Expo `sendEvent("mentrajs_message", ...)` from native;
// JS subscribes via `Crust.addListener("mentrajs_message", handler)`.
```

Estimated ~300-500 LoC of Swift added to `crust` plus a parallel
~300-500 LoC of Kotlin for Android. For reference,
`CrustModule.swift` is 323 LoC today and `CrustModule.kt` is 484 LoC.

### How JS↔Native messages actually flow

**Three distinct JavaScript runtimes are involved.** Be careful not
to conflate them:

1. **Host RN runtime** (Hermes, the React Native bridge — the
   "main" JS the Mentra app runs in). This is where
   `LocalMiniappRuntime` / `MentraJSRouter` lives, and where the
   `MiniappHost` React component lives.
2. **Per-miniapp JS context** (native iOS JSC / Android QuickJS via Zipline, one
   per installed miniapp). Runs the miniapp's `background/index.js`.
3. **Per-miniapp WebView** (transient WKWebView / Android WebView,
   exists only when user opens settings). Runs the miniapp's
   `dist/ui/index.html`.

These three NEVER share a JS heap. All inter-runtime communication
goes through native code as a router. The native router is
the source of truth for "which miniapp owns which messages."

**Background → Native → RN flow** (e.g. miniapp calls
`session.display.showTextWall("hi")`):

```
miniapp BG JS calls session.display.showTextWall("hi")
  ↓ SDK shim (in @mentra/miniapp/background)
  ↓
__dispatch("display", "showTextWall", ["hi"])
  ↓ injected as a single Swift block / Kotlin lambda
  ↓
Native JSCDispatcher (Swift on iOS, Kotlin on Android)
  ↓
Tag the call with this JSContext's packageName
  ↓
Send Expo Module event "mentrajs_message" with payload
  { packageName, iface: "display", method: "showTextWall", args }
  ↓ via Expo Module API `sendEvent("mentrajs_message", payload)`
    (same call shape on iOS and Android — Expo Modules normalize
    the underlying NativeEventEmitter / DeviceEventEmitter delivery)
  ↓
React Native receives in MentraJSRouter (host RN runtime),
  subscribed via Crust.addListener("mentrajs_message", ...)
  ↓
Routes to the existing handler body (lifted from
LocalMiniappRuntime.ts handleDisplay)
  ↓
Dispatches via existing native services (CrustModule.displayEvent)
  ↓
BLE write → glasses display "hi"
```

**RN → Native → Background flow** (e.g. host wants to push glasses
status change to all running miniapps):

```
MentraJSRouter (host RN) computes the event payload
  ↓
Calls Crust.dispatchToJs(packageName, "glasses_status",
  { connected: true })
  ↓ Expo Module Function call (sync from JS perspective)
  ↓
Native JSCDispatcher looks up the JSContext for packageName
  ↓
Calls jsContext.evaluateScript(`globalThis.__deliver(${json})`)
  ↓ runs on the JSContext's dedicated thread
  ↓
__deliver dispatches to subscribed session.* listeners
  in the miniapp's background/index.js
```

**WebView → Native → Background flow** (e.g. user taps button in
WebView, miniapp wants to display text on glasses):

```
WebView event handler calls mentra.send("show-glasses", { text })
  ↓ injected window.mentra shim
  ↓
window.ReactNativeWebView.postMessage(JSON.stringify({...}))
  ↓ react-native-webview's bridge
  ↓
MiniappHost.tsx onMessage handler (host RN runtime)
  ↓
Looks up which JSContext is bound to this WebView
  ↓
Calls Crust.dispatchToJs(packageName, "show-glasses", { text })
  ↓ same path as RN → Background above
  ↓
Background's session.ui.on("show-glasses") handler fires
  ↓
Handler calls session.display.showTextWall(text)
  ↓ same path as Background → Native → RN above
  ↓
glasses display the text
```

**Cloud → Background flow** (cloud-relayed responses for
asynchronous-by-design APIs like photo capture, managed streams):

```
Cloud server sends "phone_photo_ready" / "phone_stream_status" /
  "phone_managed_stream_status" to mobile via existing cloud socket
  ↓
MentraJSRouter.handleCloudMessage(msg) (lifted from
  LocalMiniappRuntime.ts's handleCloudMessage — 3 inline switch arms)
  ↓
Looks up the pending request in pendingCloudRequests Map (matching
  packageName + requestId)
  ↓
Calls Crust.dispatchToJs(packageName, "<corresponding event>", {...})
  ↓ same delivery path as the RN → Background flow above
  ↓
Background's awaiting Promise resolves
```

**Three key properties to notice:**
1. **The host RN runtime is always in the middle.** It's the only
   place where messages from JSContexts, WebViews, and the cloud
   socket can be correlated and routed. JSContexts and WebViews
   never talk to each other or to the cloud directly.
2. **All four flows use Expo Module events / function calls as the
   transport between native and RN** (the cloud flow inherits the
   same downstream path once it's inside `MentraJSRouter`). No
   custom IPC. Same plumbing we use for every other native module.
3. **Cloud responses are a third inbound source** for `MentraJSRouter`,
   alongside JSContext-originating `__dispatch` events and WebView
   `mentra.send`. Don't forget this when wiring the router; it's
   easy to miss because the cloud path doesn't go through `__dispatch`.

The cost of this architecture: every cross-runtime hop has at least
one JSON serialize/deserialize. Acceptable for our message shape
(small JSON payloads, no streaming binary data — those go through
specialized native paths like `mic_pcm`).

### Spawn order

When `spawn(id, polyfillPath, miniappPath)` is called:

1. **iOS:** Create `JSVirtualMachine` + `JSContext` on a dedicated thread.
   **Android:** Create a `Zipline` instance (which owns a `QuickJs`
   context) on a `CoroutineScope` bound to a single-thread
   `Dispatcher`. Same conceptual shape; same one-context-per-miniapp
   isolation.
2. **iOS:** Set `context.name = "MentraJS: <id>"` and (DEBUG-only)
   `isInspectable = true` (gated on iOS 16.4+).
   **Android:** No equivalent — Safari Inspector is iOS-only.
   Chrome DevTools wiring via Zipline's debugger support is
   deferred to Phase 6.
3. Inject `__dispatch` as a single function on the context's global.
   **iOS:** a Swift block. Per Pebble's `CrashReproducer.kt`, never
   bind individual native callbacks as JSValue properties — JSC's
   GC races and crashes. **One C-callable function only.**
   **Android:** a Kotlin object exposed via Zipline's bridge. We
   keep the same single-`__dispatch` shape for cross-platform
   parity even though QuickJS doesn't have JSC's GC race.
4. Inject `__hostLog`, `__hostError`, `__hostUnhandledRejection`
   for the polyfill's `console.*` and error rewires. **Android:**
   guard the `console.*` install — Zipline pre-injects
   `console.{log,info,warn,error}`, so wire `__hostLog` into
   Zipline's existing `console` instead of overwriting.
5. Run the polyfill bundle (`startup.js`) — wrapped in `evalCatching`
   on iOS / try-catch around `Zipline.quickJs.evaluate(...)` on
   Android. Installs `setTimeout`/`setInterval`/`fetch`/`WebSocket`/
   `localStorage`/etc on `globalThis`. Two `if (!globalThis.X)`
   guards in the bundle handle Zipline's pre-injected
   `console`/`setTimeout`/`clearTimeout`.
6. Inject the SDK shim (`@mentra/miniapp/background` typed wrappers around
   `__dispatch` exposing the existing `session.*` API surface).
7. Run the miniapp's `background/index.js`. Top-level code executes in
   the JSContext but **does not** receive `session` — it can set up
   module-level state but should not register listeners or call any
   `session.*` APIs (session isn't available yet).
8. Call the miniapp's `init(session)` export. **All listener
   registration and SDK calls go here.** This separation matters
   for respawn/hot-reload: `init` is re-invoked with a fresh session
   on every spawn, while top-level state is just where module
   declarations live.

If the miniapp doesn't export `init`, top-level code runs once at
spawn time and that's it. Document this clearly — registering
`session.*` handlers from top-level when `init` exists creates
double-registration on respawn.

By step 7 the miniapp sees a world that looks like a Web Worker — same
`setTimeout`, `fetch`, `WebSocket`, `localStorage`, `crypto.subtle`.

---

## The bridge surface — two bridges, never overlap

### Bridge 1: MentraJS ↔ Native (full power)

`__dispatch(iface, method, args)` is the only path from background JS
to native code. The SDK wraps it into the typed `MiniappSession` API
that miniapps actually use.

**The SDK API surface already exists** in `mobile/modules/miniapp/src/`.
We do NOT redesign it. The 19 module wrappers (`session.glasses`,
`session.display`, `session.input`, `session.transcription`,
`session.translation`, `session.mic`, `session.speaker`,
`session.camera`, `session.dashboard`, `session.led`,
`session.location`, `session.imu`, `session.phone`,
`session.permissions`, `session.storage`, `session.stream`,
`session.system`, `session.heading`, `session.navigation`) all wrap
a constructor-injected `session` and call `session.sendOneShot` /
`session.sendRequest` / `session._subscribe`. Transport-agnostic.

`session.navigation` and `session.heading` were added by the 2026-05
navigation SDK merge. Native sits in `crust` (Google Nav SDK on iOS
via `GoogleNavigation` pod, on Android via the
`com.google.android.libraries.navigation:navigation` AAR — see Phase
1 native scope below); the JS module is pure `__dispatch`-shaped
calls and lifts verbatim. `session.navigation` also ships a built-in
pivot engine (`modules/pivots/`) — pure-TS polyline-simplification +
crosswalk detection that synthesizes `CROSS_STREET` maneuvers. The
engine is **background-only** by construction: it consumes
position/route events and registers session callbacks, never touches
the DOM, and has nothing to expose to a WebView.

**Canonical pivot consumer pattern.** A miniapp subscribes to
pivots from `background/index.ts`:

```typescript
// background/index.ts
export function init(session: MiniappSession): void {
  session.navigation.onPivot((event) => {
    // event = { phase: "approaching" | "entered" | "exited", pivot }
    if (event.phase === "approaching") {
      session.display.showTextWall(formatManeuver(event.pivot))
    }
    // If the UI half also wants pivots, forward them — never
    // re-import the pivot engine on the WebView side. The engine
    // runs once, in background. The WebView is a renderer of what
    // background has already computed.
    session.ui.send("pivot", event)
  })
}
```

WebView side reads `mentra.on("pivot", ...)`. Same rule as every
other capability: native sensors → background event handler →
optional `session.ui.send(...)` → WebView re-renders. Running
geometry twice (once in background for glasses, once in WebView for
the map) is an anti-pattern — pick one canonical source and
broadcast.

`session.location.getOnce()` exists for the seed case — at app
mount, before the continuous `onUpdate` stream warms up, a single
fresh fix is useful so the UI has coords to render immediately. The
streaming subscription supersedes it once events start arriving.

Three new session modules are added by this proposal — flagged here
so readers don't assume they exist today.

**`session.ui`** — message bus to the miniapp's WebView when one is
mounted. Full surface:

```typescript
interface UIModule {
  // True when a WebView is currently bound to this miniapp.
  isOpen(): boolean

  // Fires once each time a WebView mounts and acks `mentra.ready()`.
  // If a handler is registered AFTER a WebView is already mounted,
  // it fires immediately for the current binding.
  onOpen(cb: () => void): UnsubscribeFn

  // Fires when the bound WebView closes (user navigates away or
  // WebView crashes / heartbeat times out).
  onClose(cb: () => void): UnsubscribeFn

  // Send a message to the bound WebView. If no WebView is bound,
  // the call is silently dropped (NOT buffered — UI state is
  // ephemeral; if the user isn't looking, the data isn't relevant).
  // Background's job is to maintain the source of truth in
  // session.storage; the WebView re-fetches on next open.
  send<C extends keyof Channels>(channel: C, payload: Channels[C]): void

  // Subscribe to messages from the WebView. Handlers persist across
  // WebView open/close cycles — registering once is enough.
  on<C extends keyof Channels>(channel: C, cb: (payload: Channels[C]) => void): UnsubscribeFn
}
```

Asymmetry with `mentra.send` (the WebView side): WebView-side
**buffers** until `ready()` ack (because the WebView is the
short-lived side and shouldn't drop user input). Background-side
**drops** silently when no WebView is bound (because the long-lived
side shouldn't accumulate stale UI updates; truth is in storage).

**`session.diagnostics`** — structured telemetry emitter:

```typescript
interface DiagnosticsModule {
  // Custom event with arbitrary props. Goes to Sentry breadcrumb
  // in production, mirrored to dev console in dev mode.
  event(name: string, props?: Record<string, unknown>): void

  // Structured error capture with optional context. Goes to Sentry
  // event (not just breadcrumb) in production, mirrored to dev
  // console in dev mode.
  error(err: Error | string, ctx?: Record<string, unknown>): void
}
```

Same token-bucket throttle as `console.*` (100/min sustained,
burst 500). `props` and `ctx` get JSON-serialized; non-serializable
values get coerced to strings. Redaction (token/password/secret/etc)
applies to all string values.

**`session.permissions.query` and `request`** — the existing
`permissions.ts` (84 LoC) has `has`, `getAll`, `onUpdate`,
`onPermissionError`. `request()` is explicitly marked as
"deferred to a future round" in the source. We add:

- `query(permission)` — returns `granted | denied | prompt`
  (matches `navigator.permissions.query` shape).
- `request(permission)` — host-rendered modal, resolves to
  `granted | denied | prompt` (`prompt` if user dismisses without
  choosing).

What changes: instead of `createTransport()` autodetecting
`PostMessageTransport`, we add a fourth branch that detects
`__dispatch` on the global and returns a new `DispatchTransport`.
Same `MiniappSession` class, same module wrappers, same developer API.

#### Wire format

**`__dispatch` request envelope** (JS calls native):
```typescript
type DispatchRequest = {
  iface: string       // e.g. "display"
  method: string      // e.g. "showTextWall"
  args: unknown[]     // method-specific positional args, JSON-serializable
  reqId?: string      // present for request/response; absent for one-shots
}
```

**Native return value** (synchronous from JS perspective):
- One-shots (`session.sendOneShot`) return immediately with `null`.
  Native processes asynchronously; errors surface via the
  `mentrajs_message` event with `iface: "_error"`.
- Requests (`session.sendRequest`) return a `Promise` resolved when
  native posts the matching `mentrajs_message` event with the same
  `reqId`. Resolution payload:
  ```typescript
  type DispatchResponse =
    | { reqId: string; ok: true; result: unknown }
    | { reqId: string; ok: false; error: DispatchError }
  ```

**`__deliver` envelope** (native pushes to JS):
```typescript
type DeliverEnvelope =
  | { kind: "init"; sessionId: string }                    // first delivery, post-spawn
  | { kind: "event"; iface: string; payload: unknown }     // subscribed events
  | { kind: "response"; reqId: string; ok: boolean; result?: unknown; error?: DispatchError }
```

`__deliver` is **defined by the polyfill bundle** (`startup.js`).
The bundle installs `globalThis.__deliver` to dispatch to subscribed
`session.*` listeners and pending request resolvers. The `init`
event triggers the SDK shim to construct the actual `MiniappSession`
object (the `session` is built JS-side from the polyfill bundle's
factory; native only sends `sessionId`, not a serialized session).

**Error code catalog** — all `DispatchError.code` values:
```
PERMISSION_NOT_DECLARED   // missing from miniapp.json permissions[]
PERMISSION_DENIED         // declared but user grant missing or revoked
INTERFACE_NOT_FOUND       // unknown iface name
METHOD_NOT_FOUND          // unknown method on a known iface
INVALID_ARGS              // arg shape doesn't match method's contract
NATIVE_THROW              // native handler threw — message includes details
TIMEOUT                   // request exceeded its timeout (native-side)
```

`DispatchError` shape: `{ code: string; message?: string; details?: Record<string, unknown> }`.

#### Polyfill bundle entry-point contract

`dist/startup.js` is evaluated as a single string at JS context
spawn time (step 5 of the spawn order). It runs **side-effecting
installs at top level** — no exported `install(globals)` function.
Concretely it:
1. Installs missing globals (`console`, `setTimeout`, `setInterval`,
   `queueMicrotask`, `URL`, `TextEncoder`, etc.) onto `globalThis`,
   guarded by `if (!globalThis.X)`.
2. Installs `globalThis.__deliver` per the envelope above.
3. Installs `globalThis.__hostLog`, `__hostError`,
   `__hostUnhandledRejection` for the polyfill's `console.*` and
   error rewires.
4. Does NOT install `__dispatch` — that's injected by native code
   (Swift block on iOS, Zipline `ZiplineService` on Android)
   before the bundle runs.

Real existing usage (from `sdk/example-miniapp/src/controller/GlassesController.ts`):

```typescript
this.session.transcription.on((data) => {
  if (this.captionsEnabled) {
    this.session.display.showTextWall(data.text)
  }
})

this.session.input.onButtonPress((data) => {
  // ...
})

await this.session.speaker.speak(phrase)
this.session.display.clearView()
```

### Bridge 2: WebView ↔ MentraJS (per-miniapp message bus)

Auto-injected into each WebView at mount time:

```typescript
declare const mentra: {
  send<C extends keyof Channels>(channel: C, payload: Channels[C]): void
  on<C extends keyof Channels>(channel: C, cb: (payload: Channels[C]) => void): Unsubscribe
  ready(): void
}
```

`mentra.send()` does NOT go to native. It goes to the bound
JSContext's `session.ui.on()` handlers via the host router.

`Channels` is defined per-miniapp in `src/shared/channels.ts` and
imported by both layers, so message names are typed at compile time.
**Channels is compile-time only** — there is no runtime registry; the
host router treats `channel` as an opaque string and routes by name.

#### UI bus wire format

WebView → host (via `window.ReactNativeWebView.postMessage(JSON)`):
```typescript
type UIInbound =
  | { type: "msg"; seq: number; channel: string; payload: unknown }
  | { type: "ready" }
  | { type: "heartbeat"; seq: number }
```

Host → WebView (via `webview.injectJavaScript("window.__mentra.recv(...)")`):
```typescript
type UIOutbound =
  | { type: "msg"; seq: number; channel: string; payload: unknown }
  | { type: "ack"; seq: number }              // ACK for a message
  | { type: "open" }                          // background-side onOpen fired
  | { type: "close" }                         // host is about to destroy WebView
```

**Sequence numbers** monotonically increase per direction. The host
maintains a per-WebView dedup window (last 64 seqs); duplicates from
a transient reconnect are silently dropped. `ack` is for delivery
confirmation only — the WebView side does not need to await acks
before sending more messages (fire-and-forget bus). The seq +
dedup window protects against the message-bus replays during
reconnect noted in Phase 3 tasks.

**Synthetic channels:** `mentra.on("__open__", ...)` and
`mentra.on("__close__", ...)` are reserved for lifecycle events and
delivered via the same `msg` envelope with channel name prefixed by
`__`. Miniapp authors should use `session.ui.onOpen` / `onClose` on
the background side instead; the WebView-side reserved names are
escape hatches for advanced use.

**Heartbeat:** WebView sends `{type: "heartbeat", seq}` every 5s;
host considers the WebView gone after 15s of silence and tears it
down (cleanup runs via the same code path as user-initiated close).

### Why "no native shortcut for the WebView"

To prevent the "two ways to do things" mess. There is exactly one
path from a WebView interaction to a hardware action:

```
WebView event
  → mentra.send(channel, payload)         [WebView side]
  → host router                            [native]
  → session.ui.on(channel, cb) handler    [JSContext side]
  → session.display.showTextWall(...)     [SDK call]
  → __dispatch('display', 'showTextWall', [...])  [bridge]
  → host native                           [Swift]
  → BLE write                             [hardware]
```

If we let the WebView call BLE directly:
- Race conditions between WebView's call and background's call to the
  same API.
- Two places to add logging, error handling, retries, throttling.
- Two places to break when the API surface changes.
- WebView code can't be moved into background without rewriting it.

The WebView is an "input device with a screen." All logic lives in
background. Same as WeChat, same as VS Code extensions.

**Note: ordinary browser APIs still work in the WebView.** The
restriction above is only on host-native APIs (glasses, mic,
storage, etc.). The WebView still has `fetch`, `WebSocket`,
`localStorage`, `IndexedDB`, the DOM, and so on — it's a normal
browser context. Calling a third-party HTTPS endpoint (Google
Places, your own backend, a tile server) directly from the WebView
is fine and expected. The rule is: anything that needs to reach the
device — BLE, sensors, files — goes through background.

---

## Source layout for a miniapp

```
my-notes-miniapp/
├── miniapp.json               # manifest (existing schema, with additions)
├── package.json
├── tsconfig.json
├── src/
│   ├── background/            # MentraJS entrypoint — always running
│   │   └── index.ts           # exports `init(session)` — runtime calls
│   │                          #   this once after spawn
│   ├── ui/
│   │   ├── index.html         # WebView entrypoint
│   │   ├── index.tsx          # WebView code (React or vanilla)
│   │   └── styles.css
│   └── shared/
│       └── channels.ts        # message channel typings, shared
├── icon.png                   # 512x512
└── dist/                      # output of `bun run build`
    ├── background/
    │   └── index.js
    └── ui/
        ├── index.html
        ├── index.js
        └── styles.css
```

Background and UI sit in **symmetric folders** so the layout reads
the same on both halves and `background/` can grow into multiple
files (controllers, managers, services) without restructuring.
`background/index.ts` is the canonical entry — the runtime loads
it and calls `init(session)`.

`miniapp.json` (existing schema + new fields, `packageName` not `id`):

```json
{
  "$schema": "./node_modules/@mentra/miniapp-cli/schema/miniapp.schema.json",
  "packageName": "com.alex.notes",
  "version": "1.0.0",
  "name": "Notes",
  "description": "Voice-driven note taking",
  "icon": "icon.png",
  "sdkVersion": "^0.2.0",
  "minHostVersion": "1.42.0",
  "type": "standard",
  "entry": {
    "background": "dist/background/index.js",
    "ui": "dist/ui/index.html"
  },
  "permissions": [
    {"type": "MICROPHONE", "description": "Voice notes"}
  ],
  "hardwareRequirements": [
    {"type": "DISPLAY", "level": "REQUIRED", "description": "Shows notes on glasses"}
  ]
}
```

`src/shared/channels.ts` — single source of truth for message names.
Both bundlers (background output and UI output) inline this file at
build time, so there's no runtime resolution. Only types and value
constants live here; runtime logic doesn't:

```typescript
export interface Note {
  id: string
  body: string
  at: number
}

export interface Channels {
  // WebView → background
  'add-note': { body: string }
  'delete-note': { id: string }
  'show-on-glasses': { id: string }

  // background → WebView
  'state': { notes: Note[] }
  'note-added': { note: Note }
}
```

`src/background/index.ts` — uses the existing SDK API:

```typescript
import type {MiniappSession} from "@mentra/miniapp/background"
import type {Note} from "./shared/channels"

let notes: Note[] = []

export async function init(session: MiniappSession) {
  // session.storage.get/set today only deals in strings — JSON-encode
  // structured data ourselves. (The SDK may add typed helpers later;
  // for now this is the pattern.)
  const stored = await session.storage.get("notes")
  notes = stored ? (JSON.parse(stored) as Note[]) : []
  const persist = () => session.storage.set("notes", JSON.stringify(notes))

  // Glasses button → display latest note on glasses
  session.input.onButtonPress(() => {
    session.display.showTextWall(notes.at(-1)?.body ?? "No notes yet")
  })

  // WebView lifecycle
  session.ui.onOpen(() => session.ui.send("state", {notes}))

  session.ui.on("add-note", async ({body}) => {
    const note: Note = {id: crypto.randomUUID(), body, at: Date.now()}
    notes.push(note)
    await persist()
    session.ui.send("note-added", {note})
  })

  session.ui.on("delete-note", async ({id}) => {
    notes = notes.filter((n) => n.id !== id)
    await persist()
    session.ui.send("state", {notes})
  })

  session.ui.on("show-on-glasses", ({id}) => {
    const note = notes.find((n) => n.id === id)
    if (note) session.display.showTextWall(note.body)
  })
}
```

`src/ui/index.tsx` — uses React helpers from `@mentra/miniapp/ui`,
adapted to talk to background via the bus:

```tsx
import type {Note} from "../shared/channels"

let notes: Note[] = []

mentra.on("state", ({notes: incoming}) => {
  notes = incoming
  render()
})

mentra.on("note-added", ({note}) => {
  notes.push(note)
  render()
})

document.getElementById("add")!.addEventListener("click", () => {
  const input = document.getElementById("input") as HTMLInputElement
  const body = input.value.trim()
  if (!body) return
  mentra.send("add-note", {body})
  input.value = ""
})

mentra.ready()
```

The `ui/index.tsx` has **no reference to `session`, `glasses`,
`display`, `input`, etc.** — by construction the WebView cannot call
those. A user tapping "show on glasses" sends a message to background
which handles the actual `session.display.showTextWall(...)` call.

---

## Reuse from the existing local SDK

About **half** of the existing local-miniapp SDK code (~7,500 of
~14,000 LoC after the 2026-05 navigation+heading merge) lifts into
the new architecture with zero or near-zero changes. Another
~3,500 LoC keeps its shape and gets new internals. Only ~2,800 LoC
is genuinely replaced. **This is mostly a refactor + add, not a
rewrite.**

### Lift verbatim (zero changes)

These files have no DOM dependency and no WebView assumption:

| File | LoC | Why portable |
|---|---|---|
| `mobile/modules/miniapp/src/protocol.ts` | 190 | Pure enums |
| `mobile/modules/miniapp/src/envelope.ts` | 54 | JSON serialize/parse + `crypto.randomUUID` |
| `mobile/modules/miniapp/src/modules/glasses.ts` | 23 | Wraps `session.sendOneShot` |
| `mobile/modules/miniapp/src/modules/imu.ts` | 18 | Same |
| `mobile/modules/miniapp/src/modules/input.ts` | 71 | Same (button + touch events) |
| `mobile/modules/miniapp/src/modules/location.ts` | 30 | Same |
| `mobile/modules/miniapp/src/modules/mic.ts` | 74 | Same |
| `mobile/modules/miniapp/src/modules/transcription.ts` | 128 | Same |
| `mobile/modules/miniapp/src/modules/translation.ts` | 65 | Same |
| `mobile/modules/miniapp/src/modules/dashboard.ts` | 31 | Same |
| `mobile/modules/miniapp/src/modules/led.ts` | 55 | Same |
| `mobile/modules/miniapp/src/modules/camera.ts` | 62 | Same |
| `mobile/modules/miniapp/src/modules/storage.ts` | 47 | Same |
| `mobile/modules/miniapp/src/modules/system.ts` | 76 | Same |
| `mobile/modules/miniapp/src/modules/stream.ts` | 61 | Same |
| `mobile/modules/miniapp/src/modules/display.ts` | 118 | Same |
| `mobile/modules/miniapp/src/modules/phone.ts` | 120 | Same |
| `mobile/modules/miniapp/src/modules/permissions.ts` | 84 | Same |
| `mobile/modules/miniapp/src/modules/speaker.ts` | 144 | Same |
| `mobile/modules/miniapp/src/modules/heading.ts` | 23 | Same (compass stream) |
| `mobile/modules/miniapp/src/modules/navigation.ts` | 801 | Turn-by-turn API + pivot subscriptions; pure `sendOneShot`/`sendRequest`/`_subscribe` |
| `mobile/modules/miniapp/src/modules/pivots/engine.ts` | 554 | Pure-TS pivot engine; consumes route + position events, emits synthetic `CROSS_STREET` maneuvers. Background-only (WebView never sees it). |
| `mobile/modules/miniapp/src/modules/pivots/geometry.ts` | 409 | Pure-TS polyline geometry (haversine, bearing, RDP, pivot extraction, crosswalk detection) |
| `mobile/modules/miniapp/src/transport/types.ts` | 26 | Transport interface fits `__dispatch` |
| `mobile/modules/engine/src/services/MicStateCoordinator.ts` | 113 | No WebView |
| `mobile/modules/engine/src/services/LocalSttFallbackCoordinator.ts` | 98 | No WebView |
| `mobile/modules/engine/src/services/LocalDisplayManager.ts` | 538 | Per-app display arbitration keyed on `packageName` |
| `mobile/modules/engine/src/services/DisplayProcessor.ts` | 714 | Pure compute |
| `mobile/modules/engine/src/services/MiniappRunningRegistry.ts` | 63 | Just update writers |
| `mobile/src/services/HeadingService.ts` | 98 | Singleton with ref-counted native compass subs + late-subscriber replay |
| `mobile/src/services/LocationManager.ts` | 177 | Foreground GPS wrapper (`expo-location`) — separate from background-task path in MantleManager |
| `mobile/src/services/NavigationService.ts` | 548 | Singleton wrapping `crust`'s Google Nav SDK; ref-counted listeners, route/maneuver/location event fan-out, Routes API REST path |
| `mobile/src/services/navigation/routesApiCodec.ts` | 52 | Pure decoders (`decodePolyline`, `parseDurationSeconds`). Has unit tests in sibling `.test.ts`. |

**~5,000 LoC of typed API surface and infrastructure that survives
unchanged.** (Bumped from ~3,000 after the navigation/heading PR
merged in 2026-05: nav SDK + pivot engine + Routes API codec all
lift verbatim since they're pure TS over `__dispatch`-shaped calls.)

### Reuse with minor changes

| File | LoC | Change needed |
|---|---|---|
| `mobile/modules/miniapp/src/session.ts` | 612 | Drop `createTransport()` autodetection; constructor-inject `DispatchTransport`. Keep queue-before-ACK, request/response correlation, permission cache, speaker state machine. |
| `mobile/modules/miniapp/src/modules/events.ts` | 208 | Move with `session.ts`; refcounted SUBSCRIBE machinery is pure logic. |
| `mobile/modules/miniapp/src/transport/mock.ts` | 208 | Stays for browser-tab dev path. |
| `mobile/modules/miniapp/src/transport/local-socket.ts` | 93 | Same. |
| `mobile/modules/miniapp/src/transport/auto.ts` | 125 | Add 4th branch: if `__dispatch` global → return `DispatchTransport`. |
| `mobile/modules/miniapp/src/dev-reload.ts` | 60 | Keep for WebView; add sibling for JSContext respawn. |
| `mobile/modules/engine/src/services/DevServerBridge.ts` | 288 | Same protocol, two delivery sinks (WebView reload + JSContext respawn). |
| `mobile/src/services/MantleManager.ts` | ~1,060 | Runtime-hook adapter that wires `NavigationService`/`HeadingService`/`setLocationTier` into the island runtime. Adapter shape carries forward — point it at the new `MentraJSRouter` instead of `LocalMiniappRuntime`. |
| `sdk/miniapp-cli/src/manifest*.ts` (4 non-test files) | ~712 | Add `sdkVersion`, `minHostVersion`, `entry` (object) schema fields. (Signature schema deferred to store-ship spec.) |
| `sdk/miniapp-cli/src/dev.ts` + `dev-server.ts` | ~480 | Bundle `dist/background/index.js` + `dist/ui/`; add `{type:"respawn-bg"}` message alongside `{type:"reload"}`. Today's `dev.ts` spawns a single dev server fronting the WebView; new flow orchestrates two bundlers (background + UI) plus the dev-server WebSocket. |
| `sdk/miniapp-cli/src/pack.ts` + `release.ts` | ~380 | Two-output bundle. (Signing pipeline deferred to store-ship spec.) |

### Reuse with major changes (right shape, internals rewritten)

| File | LoC | What survives, what changes |
|---|---|---|
| `mobile/modules/engine/src/services/LocalMiniappRuntime.ts` | 2,217 | **Skeleton survives:** per-app registry, refcounted streams, ping loop, **33 dispatch arms in `handleRawMessage`'s switch + 3 arms in `handleCloudMessage`'s switch**. Eight of the main arms are NAVIGATION_* added in the 2026-05 nav SDK merge (START, STOP, DEVIATE, SET_WRONG_SIDEWALK, SET_SKIP_CROSSINGS, GET_STATE, COMPUTE_ROUTE, REQUEST_PERMISSION); each routes through the host's `NavigationService` singleton via the `RuntimeHooks.navigation` adapter — the JSC port keeps that adapter shape unchanged. The runtime also owns: `location_stream` rate aggregation (strictest across all connected apps, with downgrade-to-`off` on unregister), `recomputeHeadingSubscription` (ref-counted compass sub), and a per-app nav event forwarder that survives mini-app UI close so active trips keep running. Handler bodies don't know they're talking to a WebView — they take `(packageName, payload)` and dispatch to native. **Rewrite:** front door (`handleRawMessage` → `__dispatch`); per-app `sendMessage` (postMessage → `JSContext.evaluateScript`); HMAC/local-token code goes away. `gracefullyUnregisterApp`'s 50 ms `WILL_DISCONNECT` window also goes away — JSC kill doesn't need a transport-flush grace; replace with synchronous teardown. |
| `mobile/modules/engine/src/services/AppRegistry.ts` | 675 | Manifest normalization + zip pipeline survive. **Add:** `background/index.js` discovery alongside `index.html`; recognize new manifest fields; sdkVersion/minHostVersion compatibility check on spawn. (Signature verification deferred to store-ship spec — all current bundles are LAN-sideloaded and unsigned.) |
| `sdk/create-mentra-miniapp/bin/index.ts` + template | ~150 + template | Scaffolder logic survives (clack prompts, validation, template substitution). **Template files rewrite:** scaffold `src/background/index.ts`, `src/ui/`, `src/shared/channels.ts` instead of single React SPA. |
| `mobile/src/components/miniapp/MiniappHost.tsx` | 627 | **Skeleton survives:** the `mount/unmount/setForeground/setBackground` public API stays the same shape — callers don't change. **Semantics invert in Phase 3:** today mounts a persistent off-screen `<WebView>` at `-left-[10000px]` and toggles classes; new world spawns a fresh WebView when the user navigates to a miniapp's UI route and tears it down on exit. Phase 0's LRU eviction branch in `setBackground` becomes dead code and gets removed (the policy tests survive into Phase 3 as policy-only unit tests). The 50 ms `gracefullyUnregisterApp` wait added by the 2026-05 nav merge also goes away — no transport handshake to flush in the JSC world. |

### Replace entirely

| File | LoC | Why |
|---|---|---|
| `mobile/modules/miniapp/src/transport/postmessage.ts` | 95 | Hard-coded to `window.ReactNativeWebView`. Repurpose as `WebViewToJsContextTransport` for the settings WebView. |
| `mobile/modules/engine/src/services/WebviewBridge.ts` | 50 | Replaced by two sibling routers: `MentraJSRouter` (JSContext fan-out) + `MentraUIRouter` (settings WebView ↔ bound JSContext). |
| `mobile/modules/miniapp/src/globals.ts` | 62 | `window.MentraOS` is WebView-presentational. Keep file for WebView; JSContext gets a different injected globals object. |
| `mobile/modules/miniapp/src/index.ts` | 108 | Replaced by two sub-path entry points via `package.json` `exports`: `@mentra/miniapp/background` (session API for the JSContext layer) and `@mentra/miniapp/ui` (WebView-side `mentra` global + React hooks). No bare `@mentra/miniapp` import — sub-paths only. |
| `sdk/example-miniapp/` | (entire React SPA) | Restructure into two-layer with **symmetric folders**: logic into `src/background/` (entry `background/index.ts` + `background/controllers/`), UI into `src/ui/`. Existing React code is reusable as the basis for the UI half. See Appendix A for the file-by-file map. |

### Net-new code

Native (Swift, in `crust`):
- **`JSCRuntime.swift`** — spawns JSContexts, owns lifecycle. ~300-500 LoC.
- **`JSCDispatcher.swift`** — `__dispatch` glue + iface registry.
- **`JSCPolyfillBridge.swift`** — native handlers for fetch/WS/timers/storage/crypto.
- **`PermissionStore` (SQLite)** — per-(packageName, iface) grant
  table; `__dispatch` consults this before invoking native APIs.
  Distinct from miniapp-facing `session.storage` (NSUserDefaults) —
  this is host-internal and never exposed to JS. Implemented in
  Phase 1 alongside `JSCDispatcher` (the dispatcher's first
  consumer is the permission gate). FMDB or sqlite3 binding —
  schema is two columns (`packageName TEXT, iface TEXT,
  PRIMARY KEY (packageName, iface)`).
- **Device-tier eviction** — `physicalMemory` query + LRU policy in
  `MiniappRunningRegistry`. Only relevant for the WebView half (the
  JSContext half doesn't need eviction at our memory profile).

Native (Kotlin, in `crust`):
- **`JSCRuntime.kt`** — wraps `Zipline.create(...)` per miniapp,
  owns lifecycle. Symmetric with iOS `JSCRuntime.swift`. ~300-500 LoC.
- **`JSCDispatcher.kt`** — Kotlin mirror of Swift dispatcher;
  registers a single Kotlin object exposing `__dispatch` via
  Zipline's bridge.
- **`JSCPolyfillBridge.kt`** — OkHttp / SharedPreferences /
  javax.crypto / Tink (X25519) backed equivalents. Each shim is a
  suspending method on a `ZiplineService` interface; Zipline's bridge
  handles Promise resume + microtask drain automatically. **No public
  `executePendingJobs` API exists in Zipline — relying on
  bridge-mediated resume is the only supported path.**
- **`PermissionStore`** — SQLite via Android's built-in
  `SQLiteOpenHelper`. Same schema as iOS.
- **Device-tier eviction** — `ActivityManager.getMemoryInfo()` for
  the equivalent of `physicalMemory`.

React Native UI (cross-platform TS/TSX, in `mobile/src/components/miniapp/`):
- **WebView host refactor** — `MiniappHost.tsx` (627 LoC today) shifts
  from "persistent off-screen WebViews" to "spawn cold per open,
  destroy on exit" for the UI layer. Existing `mount/unmount/
  setForeground/setBackground` API is kept; semantics inverted.
  **Mostly one file for both platforms** via `react-native-webview`,
  but **iOS and Android take different paths for the
  bootstrap-before-page-load shim** (see below).
- **iOS bootstrap:** `injectedJavaScriptBeforeContentLoaded` is
  reliable on iOS — use it to install the `window.mentra` shim before
  page JS runs.
- **Android bootstrap:** `injectedJavaScriptBeforeContentLoaded` is
  documented unreliable on Android (race with content load —
  react-native-webview docs explicitly warn, refs issues #1099 / #1609).
  Use `injectedJavaScriptObject` instead — exposes
  `window.ReactNativeWebView.injectedObjectJson()` synchronously
  before page scripts run. Bootstrap reads the JSON object and
  installs the runtime `window.mentra` shim from a small inline
  `<script>` injected into `index.html` by the bundler (or via
  `injectedJavaScript` post-load for any callable methods that don't
  need pre-load timing).
- **`MentraUIRouter`** — when WebView mounts, host binds it to a
  JSContext and routes `mentra.send`/`mentra.on` between them via
  `postMessage` / `injectJavaScript` (cross-platform). The
  bootstrap-shim divergence above is the only platform-conditional
  branch in this layer; everything downstream is one code path.

JS (host RN runtime, in `mobile/modules/engine/src/services/`):
- **`MentraJSRouter.ts`** — host-side router that subscribes to
  `Crust.addListener("mentrajs_message", ...)`, looks up the
  packageName, and dispatches to existing handler bodies lifted
  from `LocalMiniappRuntime.ts`. Owns the JSContext-side fan-out.
  Distinct from the runtime *inside* JSC (`JSCRuntime` is native
  Swift/Kotlin). ~400-600 LoC.
- **`MentraUIRouter.ts`** — bridges the bound WebView to its
  JSContext sibling, routing `mentra.send/on` between them.

JS (in `mobile/modules/miniapp/src/`):
- **`DispatchTransport.ts`** — new `Transport` implementation
  wrapping `__dispatch` so existing `MiniappSession` sits on top
  unchanged. Add as 4th branch in `transport/auto.ts`.
- **`session.ui` module** — message bus to the bound WebView
  (`send/on/onOpen/onClose/isOpen`).
- **`session.diagnostics` module** — `event(name, props)` and
  `error(err, ctx)` for structured telemetry.
- **`session.permissions.query`** — returns `granted | denied | prompt`.
- **`session.permissions.request`** — host-rendered modal prompt
  (existing `modules/permissions.ts` explicitly defers `request()` —
  this is the implementation.)
- **`window.mentra` shim** — typed `send`/`on`/`ready` injected into
  the WebView side via `injectedJavaScriptBeforeContentLoaded`.
  Outbound buffer for messages before `ready()`.
- **Per-miniapp typed `Channels`** — TypeScript generics on
  `mentra.send`/`mentra.on`/`session.ui.send`/`session.ui.on`
  enforced at compile time via the shared `src/shared/channels.ts`.

Polyfill bundle (in new `mobile/modules/mentrajs-runtime/`):
- All MIT-library installs + thin bridges (see "Polyfill strategy"
  below). ~1000 LoC JS + ~600 LoC Swift.

CLI + manifest:
- **`sdkVersion`/`minHostVersion` schema fields** in
  `sdk/miniapp-cli/schema/miniapp.schema.json`. Host refuses spawn
  if versions don't match.
- **`entry` object** in manifest schema (replaces today's flat layout
  for two-layer bundle support).
- **Two-output bundler** in `sdk/miniapp-cli/src/pack.ts` and
  `release.ts` — emit `dist/background/index.js` + `dist/ui/`.
- **`{type:"respawn-bg"}` message type** in `dev-server.ts`
  alongside existing `{type:"reload"}`.

**Cloud:** none for V1. The CLI's `bun mentra-miniapp release`
serves bundles over LAN HTTP + QR (already implemented). Mobile
fetches from the developer's laptop. No store, no signing pipeline,
no kill switch, no dev portal — those return when we ship the
store later (separate spec).

---

## Polyfill strategy

Both engines (iOS JSC and Android QuickJS via Zipline) are bare
ECMAScript runtimes. Workers-in-WebView would get
fetch/WebSocket/IndexedDB/crypto for free; we don't. **About half the
polyfills are drop-in MIT libraries** — the other half are thin
bridges to native I/O.

**The same JS polyfill bundle ships on both platforms.** Two trivial
runtime guards handle engine differences (Zipline pre-injects
`console.*` and `setTimeout`/`clearTimeout`; iOS-JSC has neither).
Native bridges differ underneath (URLSession vs OkHttp, NSUserDefaults
vs SharedPreferences, CryptoKit vs javax.crypto) — but the
miniapp-facing JS API is identical down to error messages.

| API | Strategy | Library / source | Custom LoC | Engine notes |
|---|---|---|---|---|
| `console.*` | **Drop-in MIT** | `@react-native/js-polyfills/console.js` | ~10 (logging hook) | Zipline pre-injects `console.{log,info,warn,error}` — guard with `if (!globalThis.console)`. On iOS we always install. |
| `TextEncoder` / `TextDecoder` | **Drop-in MIT** | `fast-text-encoding` (3 KB) | 0 | Both engines lack natively. |
| `URL` / `URLSearchParams` | **Drop-in MIT** | `whatwg-url-without-unicode` (40 KB) | 0 | Last published 2022-05 (prerelease tag, unmaintained). Pin the version, vendor the source, or budget for an eventual fork. Bundle with `rollup-plugin-node-polyfills` for `Buffer` refs in IPv6 paths. ~0.5 day. |
| `atob` / `btoa` | **Drop-in MIT** | `base-64` (3 KB) | 0 | |
| `EventTarget` / `addEventListener` | **Drop-in MIT** | `event-target-shim` (5 KB) | 0 | |
| `Blob` / `FormData` | **Drop-in + glue** | `fetch-blob` + `formdata-polyfill` | ~30 | `fetch-blob` references `ReadableStream` — drop streams (sync `arrayBuffer()` only) or add `web-streams-polyfill`. Same on both engines. |
| `AbortController` / `AbortSignal` | **Drop-in + glue** | `abort-controller` | ~20 | |
| `Promise` | Built-in | both engines ship modern Promises | 0 | iOS-JSC drains microtasks via the iOS run loop. **QuickJS does not** — see "Mandatory microtask discipline" above. All Android polyfill shims are written as suspending Kotlin `ZiplineService` methods so Zipline's bridge resumes await chains correctly. |
| `setTimeout` / `clearTimeout` | Bridge | — | ~40 | Zipline pre-injects `setTimeout`/`clearTimeout`. Guard with `if (!globalThis.setTimeout)` — on Android we use Zipline's, on iOS we install. |
| `setInterval` / `queueMicrotask` | Bridge | — | ~40 | Always-installed (Zipline ships neither). Android implementation uses our existing `BackgroundTimer` pattern so timers fire under Doze. |
| `Headers` / `Request` / `Response` | **Lift from whatwg-fetch (MIT)** | swap XHR core for native | ~100 | |
| `fetch` network plane | Bridge | atop the Headers/Request/Response above | ~150 over `URLSession` (iOS) / OkHttp (Android) | |
| `WebSocket` | Bridge | uses `event-target-shim` | ~150 over `URLSessionWebSocketTask` (iOS) / OkHttp `WebSocketListener` (Android) | |
| `localStorage` | Bridge | — | ~50 over `NSUserDefaults` (iOS) / `SharedPreferences` (Android) with `"MentraJS-{packageName}"` suite/file | |
| `crypto.subtle` (SHA, AES-GCM, HMAC, X25519) | Bridge | — | ~300 over `CryptoKit` (iOS) / `javax.crypto` + Tink for X25519 (Android — stdlib X25519 only API 33+) | |
| `crypto.getRandomValues` | Bridge | — | ~30 over `SecRandomCopyBytes` (iOS) / `SecureRandom.nextBytes` (Android) | |
| `crypto.randomUUID` | Pure-JS shim atop `getRandomValues` | RFC 4122 v4 (~10 lines) | ~10 | |

**Total custom code:**
- **JS polyfill bundle:** ~1000 LoC, shipped to both platforms unchanged
  (with the two guards above).
- **iOS native bridge:** ~600 LoC Swift in `JSCPolyfillBridge.swift`.
- **Android native bridge:** ~600 LoC Kotlin in `JSCPolyfillBridge.kt`,
  plus ~20 LoC shared microtask-drain helper.

**Documented engine gaps that miniapp authors will hit:**
- `Intl.*` — not available on Android (QuickJS-NG won't ship it).
  Document as unsupported, or load `@formatjs/intl` opt-in.
- `ReadableStream` / `WritableStream` — not available on either
  engine; `fetch().body` is treated as null-or-array-buffer only.
- `IndexedDB` — not provided; use `session.storage` instead.

### Out of scope (don't polyfill at v1)

- `IndexedDB` — complex; SDK's `session.storage` is the alternative (string key/value backed by NSUserDefaults / SharedPreferences; miniapp authors JSON-encode structured data themselves, as shown in the Notes example).
- `WebRTC` — niche; if needed, host app does it.
- `Service Workers` — irrelevant in non-browser context.
- `Push API` — push notifications go through `session.phone.notifications`.
- First-class `WebAssembly` — JSC supports it; we don't actively expose. If a miniapp uses `WebAssembly.instantiate` on a bundled .wasm it should work. Document as "supported but not first-class."
- `OffscreenCanvas` / Canvas — UI layer (WebView) gets full canvas free.
- `IntersectionObserver`, `MutationObserver`, `ResizeObserver` — DOM, not applicable.

### Conformance

Run Web Platform Tests (WPT) subset for each polyfilled API in CI.
Initial target: fetch + URL + TextEncoder pass at >80%.

### Don't copy from Pebble

Pebble's `coredevices/mobileapp` is GPL-3.0 dual-licensed. Their JS
shims are reference-only, not copy-pasteable. The MIT alternatives
above are equivalent in functionality.

---

## Lifecycle

### Miniapp install (V1: LAN sideload only)

1. User scans `mentra-miniapp release` QR or hits the dev URL. Host
   downloads the bundle ZIP over LAN HTTP from the developer's
   laptop, validates manifest, unzips into the app sandbox under
   `Documents/lmas/<packageName>/<version>/` (existing path).
2. Host spawns a JS context via `JSCRuntime.spawn(packageName,
   polyfillBundle, dist/background/index.js)`. Context now alive
   (Apple `JSContext` on iOS, Zipline/QuickJS context on Android).
3. Background's `init(session)` runs (typically: hydrate state from
   `session.storage`, register listeners).

When the store ships later: bundle download URL changes from "LAN
HTTP from dev laptop" to "signed R2 URL minted by cloud," and
signature verification kicks in. Same install flow otherwise.

### User opens the miniapp's UI

1. Host navigates to the miniapp UI route (e.g.
   `/applet/<packageName>/ui`).
2. Host spawns a fresh `react-native-webview` instance (WKWebView
   on iOS, Android `WebView` underneath).
3. Host injects the `window.mentra` shim. **iOS:** via
   `injectedJavaScriptBeforeContentLoaded` (reliable on iOS).
   **Android:** via `injectedJavaScriptObject` + a small inline
   bootstrap `<script>` in `index.html` (the
   `injectedJavaScriptBeforeContentLoaded` prop is documented
   unreliable on Android per react-native-webview issues
   #1099 / #1609). Either way, the shim posts via
   `window.ReactNativeWebView.postMessage(...)` and receives via
   `window.__mentra.recv(...)` calls injected by the host using
   `webview.injectJavaScript(...)`.
4. Host binds the WebView to the miniapp's JSContext (router knows
   "messages from this WebView go to JSContext X").
5. Host calls `webView.loadFileURL(<bundle>/dist/ui/index.html)`.
6. WebView mounts. `index.tsx` runs. Calls `mentra.ready()`.
7. Host router delivers `__open__` to background. Background's
   `session.ui.onOpen` handlers fire. Background pushes initial
   state via `session.ui.send('state', ...)`.
8. WebView renders.

### User navigates away from the UI

1. Host router emits `__close__` to background.
2. Background's `session.ui.onClose` handlers fire. Background can
   flush pending state to storage.
3. Host destroys the `WKWebView`. WebContent process exits. Memory
   freed.
4. Background JSContext is unaffected.

**Aside — `beforeDisconnect` is for the WebView-only world.** The
2026-05 SDK ships `session.onBeforeDisconnect(handler)` plus a
`WILL_DISCONNECT` push + 50 ms grace window for the *current*
single-tier architecture, so a miniapp can fire one last
`display.clear()` before the WebView transport closes (see
`LocalMiniappRuntime.gracefullyUnregisterApp`). In the two-layer
world, the WebView teardown above is just a `session.ui.onClose`
event — the JSContext-side `MiniappSession` doesn't disconnect,
because it never had a transport tied to the WebView in the first
place. `onBeforeDisconnect` still fires, but only on JSContext kill
(disabled / uninstalled / process death), and the grace window
becomes unnecessary because there's no transport handshake to flush
through. **Migration note:** keep the SDK API for compat, drop the
50 ms wait in `LocalMiniappRuntime` when its front door swaps to
`__dispatch`.

### Host app backgrounded by user (screen off, in pocket)

**iOS:** Host process stays alive while we hold the
`bluetooth-central` background mode (we do) and have an active BLE
session (we do, while glasses are connected). All JSContexts
continue running. WebViews are already destroyed (user navigated
away). Background JS receives glasses events normally via the BLE
bridge, processes them, calls `session.display.*` etc.

**Android:** Host process stays alive via the foreground service we
already run for BLE. All Zipline/QuickJS contexts continue running.
JS timers fire reliably under Doze because the polyfill bridge
routes `setInterval` through our existing `BackgroundTimer` pattern
(AlarmManager + wakelock from the foreground service), bypassing
WebView-style timer throttling. WebViews are already destroyed.
Background JS receives glasses events normally.

This is the steady-state production scenario on both platforms.

### Host process killed (iOS jetsam / Android LMK)

**iOS jetsam.** When iOS's jetsam kills the host process under
memory pressure, all JSContexts die. On next launch (BLE event
wakes the host), each installed-and-enabled miniapp's JSContext
re-spawns and `background/index.ts` re-runs from scratch, hydrating
from `session.storage`.

**Android LMK / OEM background killers.** Same recovery shape on
the Android side. Foreground service + glasses connection should
keep us alive, but Xiaomi/Huawei/Samsung aggressive-killer behavior
is real. Same re-spawn-on-launch path applies — Zipline contexts
reconstruct, `init(session)` re-fires, state hydrates from
`session.storage`.

**`session.storage` is the source of truth, not in-memory state.**
Same lesson Chrome MV3 service workers had to teach.

### Miniapp disabled by user

1. Host fires `session.onBeforeDisconnect` handlers in the
   JSContext synchronously (so e.g. `session.display.clear()` lands
   before kill). No grace timer — runs synchronously on the JS
   thread before kill.
2. Host calls `JSCRuntime.kill(packageName)`.
3. Marks miniapp inactive in installed-apps state.
4. In-memory state is gone. Storage remains until uninstall.

### Miniapp uninstalled

1. Kill JSContext.
2. Remove bundle files from app sandbox.
3. Drop `session.storage` namespace for that miniapp (with user
   confirmation).

### Tear-down order inside a miniapp

When `session.onBeforeDisconnect` fires in background, the miniapp
gets one synchronous chance to wind down. **Order matters:**

1. Stop ongoing work that uses the SDK (`session.navigation.stop()`,
   `session.mic.stop()`, `session.stream.stop()`, etc.) — these
   send one-shot requests through the still-open transport.
2. Clear any glasses state the user shouldn't see frozen
   (`session.display.clear()`).
3. Release internal subscriptions and timers.
4. Do NOT call `session.disconnect()` from inside this handler —
   the host is already tearing the session down. Calling it again
   double-fires the cleanup and can race with the host's own
   teardown.

Reversing 1 and 2 (clearing the display before stopping nav) is
visible: the next nav-update tick repaints the glasses before the
stop request lands, and the display stays stuck until the next
session.

---

## What we explicitly forbid

- **WebViews cannot make BLE calls.** No native API in WebView.
  Only `mentra.send('show-text', {...})` to background.
- **WebViews cannot access storage directly.** Background owns
  storage; WebView asks background.
- **WebViews cannot subscribe to button presses.** Background
  subscribes; if it wants to forward, `session.ui.send('button', ...)`.
- **WebViews cannot have their own background lifecycle.** When
  closed, gone. Reopening is fresh mount.
- **Background cannot directly manipulate WebView DOM.** Has to go
  through `session.ui.send('render-this', ...)` and let WebView code
  handle the DOM.

Enforced by simply not injecting any other APIs into the WebView.
There's no `window.mentra.glasses` to call — it doesn't exist.

---

## Permissions

Apple's **Guideline 4.7.3** requires per-miniapp user consent for any
sensitive capability the host shares — the host already holding an
OS-level permission does NOT cascade to miniapps. WeChat, Telegram,
Snapchat all do this; canonical pattern.

### Permission set

The existing `AppPermissionType` union (string-literal type, not a TS `enum`) in `mobile/modules/engine/src/types/applet.ts`:

```typescript
type AppPermissionType =
  | "ALL"
  | "MICROPHONE"
  | "CAMERA"
  | "CALENDAR"
  | "LOCATION"
  | "BACKGROUND_LOCATION"
  | "READ_NOTIFICATIONS"
  | "POST_NOTIFICATIONS"
```

Manifests already use these. Keep this enum; extend with a few that
are new (network allowlists, glasses subcategories) over time. Don't
break the existing format.

### Grant model

| Permission | Grant model | Prompt timing |
|---|---|---|
| `MICROPHONE` | Install + first-call | Install + JIT modal |
| `CAMERA` | Install + first-call | Install + JIT modal |
| `LOCATION` / `BACKGROUND_LOCATION` | Install + first-call | Install + JIT modal |
| `READ_NOTIFICATIONS` / `POST_NOTIFICATIONS` | Install + first-call | Install + JIT modal |
| `CALENDAR` | Install + first-call | Install + JIT modal |
| Storage / display / button events (implicit) | Granted by install | Never re-prompt |

Sensitive permissions get a **two-step flow**: declared in manifest at
install, then a JIT modal on first use. Bulk install-time consent is
known dark pattern for sensitive APIs — iOS users expect JIT.

### Enforcement: defense in depth

**Two gates, distinct concepts:**
- **Declared in manifest** — *exists today.* `LocalMiniappRuntime.ts`
  reads `app.installedManifest.permissions` (in-memory array on the
  registered-app record) inline at each call site (e.g. `:683-700`,
  `:981`, `:1280`). Returns `PERMISSION_NOT_DECLARED` if the iface's
  required permission is missing. This is a *static* check —
  whatever the developer put in `miniapp.json`.
- **Granted by user** — **NET-NEW for Phase 1.** Today the host
  doesn't enforce per-user grants separately from declarations
  (consent is implicit at install). Phase 1 adds a `PermissionStore`
  (SQLite) that records which permissions the user has explicitly
  granted, and JIT-prompt UI for first-call escalation.

**Authoritative gate sequence (after Phase 1):**

1. **Manifest validation at install.** Reject malformed `permissions[]`
   (existing). Persist granted set in **SQLite** (`PermissionStore`,
   net-new) keyed by `(packageName, permission)`. Distinct from
   miniapp-facing `session.storage` (which is NSUserDefaults /
   SharedPreferences).
2. **Native `__dispatch` handler — the authoritative gate.** Every
   JS context is tagged with its `packageName` at creation.
   `__dispatch(iface, method, args)` looks up:
   - `installedManifest.permissions` — declared? (existing check)
   - `PermissionStore.granted(packageName, permission)` — granted?
     (net-new check)
   - Both must pass; either failure returns the appropriate error
     code (`PERMISSION_NOT_DECLARED` or `PERMISSION_DENIED`).
3. **JS shim — purely ergonomic.** `session.permissions.query(...)`
   returns `granted | denied | prompt`. Devs call this to avoid
   silent rejections; must NOT be the only check (a malicious
   miniapp could bypass and call `__dispatch` directly).

**Effort estimate for the net-new permission grant flow:** ~1 week
of Phase 1 (SQLite store + native JIT modal + migrate the ~25
inline check sites in `LocalMiniappRuntime.ts` to the new gate).
Counted in Phase 1's 3-week iOS budget.

### Unpermitted call returns

The existing SDK already defines a `PERMISSION_NOT_DECLARED` error
code in `mobile/modules/miniapp/src/protocol.ts` (sugar accessor
in `modules/permissions.ts`'s `onPermissionError`) —
fired when a miniapp calls an API for a permission its manifest
didn't declare. Reuse it. Add one new code, `PERMISSION_DENIED`,
for the case where the manifest declared the permission but the
user denied it at install or via JIT modal:

```json
{ "error": { "code": "PERMISSION_DENIED",
             "permission": "MICROPHONE",
             "canRequest": true } }
```

If `canRequest`, the SDK can call `session.permissions.request(...)`
which routes through `__dispatch` to a host-rendered modal.
`request()` resolves to `granted` (user approved), `denied` (user
declined), or `prompt` (user dismissed without choosing — same as
the browser's `navigator.permissions.query` shape).

### App Review answer

*"Every miniapp declares permissions in a manifest, gets per-app user
consent at install, gets a second JIT consent for OS-level-sensitive
APIs, and the native bridge refuses unpermitted calls regardless of
what the JS attempts."* Maps 1:1 onto 4.7.3.

---

## Bundle, install, update, sideload

The existing `AppRegistry.ts` already does most of this. Additions
**in the initial cut:** two-output bundle support, version retention.

**Signing / `META-INF/` / Ed25519 verification ships when the store
ships, not in the initial cut.** The bundle format and signing
sections below describe the full target so the layout is reserved
upfront — but in the initial cut bundles are unsigned, sideloaded
over LAN from the developer's CLI, and `AppRegistry` skips the
signature check entirely. See Phase 4 for what actually lands.

### Bundle format

Flat ZIP, MIME `application/zip`. Wire extension `.zip`, alias
`.mpkg`. Same precedent as Pebble `.pbw`, Chrome `.crx`, VS Code
`.vsix`. Layout:

```
miniapp.json                  # manifest, required at zip root
icon.png                      # 512×512 PNG
dist/background/              # background bundle folder
  index.js                    #   entry (required, name from manifest.entry.background)
  ...                         #   chunked imports if bundler splits
dist/ui/                      # UI bundle folder
  index.html                  #   entry (required, name from manifest.entry.ui)
  index.js                    #   UI bundle
  styles.css                  #   UI styles
  ...                         #   any other UI assets
```

### Signing (deferred — design only)

Future store ships will add a `META-INF/` directory with
`manifest.sha256`, `signature.ed25519`, and `signing-cert.json` —
two-key system, store-only signing, platform key held by cloud,
developers don't hold keys (App Store / Play Store model).
Verification on device: tree-hash all non-META-INF files, verify
Ed25519 against a pinned platform pubkey, throw `SIGNATURE_INVALID`
on mismatch. Bundle layout above reserves space; the actual
META-INF emission, signing pipeline, and on-device verification
ship with the store-spec, not here.

### Storage layout (V1)

Today's `AppRegistry.ts` uses `Documents/lmas/`:

```
<Documents>/
  lmas/
    <packageName>/
      <version>/                    # active bundle tree
      <prev-version>/               # one prior, for rollback
      manifest.json                 # registry entry (active, source)
```

`session.storage` is a separate namespace per miniapp, backed by
NSUserDefaults under suite name `MentraJS-<packageName>` (per the
polyfill bridge). It survives bundle upgrades and uninstall (until
the user explicitly opts to delete data on uninstall).

When the store ships later, we may want to migrate the bundle tree
to `Application Support/mentraos/miniapps/` so it isn't user-visible
via Files.app or iCloud-eligible — but that migration is its own
footgun (per-iOS-version path-resolution differences, existing
sideloaded apps to preserve) and not worth the risk for V1.

### Retention

- N=2 versions per package (active + previous, for rollback).
- Sideloaded / `dev-*` versions exempt — `pinned: true` flag.
- Disk budget: soft cap 200 MB. LRU eviction by last-launched, never
  evicting `pinned`, `dev-*`, or currently-running app.
- Eviction never touches `storage/<id>/` — user data survives bundle
  eviction.

### Install flow (V1: LAN sideload only)

1. **Discover.** User scans QR from `mentra-miniapp release` or
   types the dev URL.
2. **Pre-flight.** Check size, sdkVersion range, storage budget.
3. **Permission prompt.** Manifest `permissions[]` shown as iOS-style
   sheet.
4. **Download.** Bundle ZIP from developer's laptop over LAN HTTP,
   to `cache/downloads/`. Progress bar.
5. **Unzip to staging.** `cache/lma_unzip/`. Atomic.
6. **Validate.** `packageName` matches; entry files exist per
   manifest's `entry.background` and `entry.ui`.
7. **Atomic swap.** Move staging → `lmas/<packageName>/<version>/`.
   Old active version stays as rollback slot (if any).
8. **Spawn / register.** Spawn JSContext. Notify listeners.
9. **Cleanup.** Delete cached download.

### Sideloading for developers

Two existing paths in `sdk/miniapp-cli/` (both implemented today):
1. **`mentra-miniapp dev`** — hot-reload over LAN. Bundle never lands
   on disk; runs from in-memory dev server.
2. **`mentra-miniapp release`** — produces a zip, serves over LAN,
   phone scans QR. Installed bundle marked `pinned: true` +
   `source: "sideload"`.

Sideloaded bundles are unsigned (only LAN-trusted). Same sandbox as
the eventual store apps — same permission prompts, no elevated
privileges. Pinned bit prevents LRU eviction.

### Update flow (V1)

For sideloaded miniapps, "update" = developer re-runs
`mentra-miniapp release` and the user re-scans QR. New version
installs alongside old; activates on next launch (or immediately
on QR scan, depending on dev preference). No store-driven update
discovery.

### Uninstall

1. Confirm with user. If app has data, *"X has 14 KB of data. Delete
   it too?"* — checkbox default unchecked (mirror iOS app uninstall).
2. If running: stop JS context.
3. Delete `lmas/<packageName>/`.
4. If user opted to delete data: delete the app's `session.storage`
   namespace (NSUserDefaults `MentraJS-<packageName>` suite, or
   the equivalent SharedPreferences file on Android).
5. Revoke permissions; remove from local cache.

### Host app upgrade

When the Mentra Manager app updates (App Store / Play Store
upgrade), miniapp bundles and `session.storage` survive — both live
in app-private storage that the OS preserves across upgrades. Two
things to handle:

- **Polyfill bundle ABI.** The bundled `startup.js` ships *inside*
  the host binary, so it always matches the host's `JSCDispatcher`.
  No coordination needed; new host = new polyfill bundle, same
  install.
- **`session.storage` schema.** Miniapp authors own their own
  `session.storage` schema; we do not migrate user data. SDK guidance:
  treat `session.storage` like Chrome MV3 `chrome.storage` — the
  miniapp checks for legacy keys on startup and migrates in-app.
- **Bundle re-validation.** On host upgrade, `AppRegistry` re-reads
  each installed manifest and re-checks `minHostVersion`. Bundles
  that would now fail the version gate are marked disabled (not
  deleted) with a clear UI surfacing "needs newer SDK"; user can
  uninstall manually.

---

## Operations: crash recovery, telemetry, observability

### Crash detection

Three sources:
1. **JS uncaught throw** — caught by `evalCatching` +
   `window.onerror` + `onunhandledrejection`. Does NOT kill JSContext.
2. **Native bridge throws** — surfaced as JS-side rejection. Same
   path.
3. **JSC internal failure / EXC_BAD_ACCESS / OOM in JSContext** —
   kills the context. Detected via dispatcher's `weak self` callback
   going nil + `pingLoop` miss.

### Crash respawn

Always a fresh `JSContext` + `JSVirtualMachine`. State hydrates from
`session.storage`. Runtime owns respawn, not the miniapp.

**Retry policy:** exponential backoff capped at 3 retries / 5 min,
then `CRASHLOOP_DISABLED`. State machine: `RUNNING → CRASHED →
BACKOFF(2s/8s/30s) → CRASHLOOP_DISABLED`. Resets on clean 60s uptime.

**UX tiers:**
- 1st crash: silent respawn.
- 2nd within 5 min: toast *"X restarted."*
- 3rd → CRASHLOOP_DISABLED: persistent banner on home tile + push
  to developer.

### Telemetry counters

Native-side, no JS overhead:
- `dispatch.calls{packageName, method}`
- `dispatch.latency_ms{packageName, method}`
- `jsc.heap_mb{packageName}` — sampled every 30s
- `crash.count{packageName, kind}`
- `respawn.count{packageName, reason}`
- `bridge.queue_depth{packageName}`

### Sentry routing

ONE Sentry project (`mentra-mobile`). `release = host_version`.
`tags = {miniapp.packageName, miniapp.version, miniapp.sdk_version,
device.model}`. Miniapp crashes are *host* events tagged with miniapp
identity. Per-developer visibility via dev portal pulling filtered
Sentry data through a server-side proxy keyed on
`tags["miniapp.packageName"]`.

**Miniapps do NOT bring their own Sentry SDK.** They get
`session.diagnostics.event(name, props)` and
`session.diagnostics.error(err, ctx)` which the host normalizes and
forwards under our project.

### Logging architecture

```
miniapp:console.log
  → rewired in startup.js
  → __dispatch("log", level, args)
  → Swift redaction (regex strip token|password|secret|auth|key|bearer|api[_-]?key)
  → branch:
    ├─ dev WS connected → mirror to dev console
    ├─ ring buffer (200 lines/miniapp, in-memory)
    └─ Sentry breadcrumb { category: "miniapp.console", level, packageName }
```

Token bucket: 100 lines/min sustained per miniapp, burst 500. Excess
dropped with one `[throttled N]` line.

### Health checks

Two layers:
- **WebView ↔ background**: WebView sends `__heartbeat__` every 5s;
  background considers WebView gone after 15s silence.
- **Background JSContext ↔ host**: host calls `__dispatch("ping")`
  every 5s; JSContext returns synchronously. Three consecutive misses
  → mark hung → kill + respawn.

`ping` synchronous from native — JS thread responds even if miniapp
is idle. **Hung** = JS thread wedged; **Idle** = miniapp has nothing
to do but runtime is responsive.

### Performance monitoring

- **Per-call latency:** wrap `__dispatch` in Swift with
  `CFAbsoluteTimeGetCurrent()` deltas. >100ms → Sentry breadcrumb;
  >1s → warn-level event.
- **Memory growth:** sample every 30s. Linear-regression last 20
  samples; slope >0.5 MB/min sustained for 10 min → fire
  `mentra.runtime.leak_suspected` event with packageName.
- **Soft watchdog:** JS thread blocks >5s on single sync eval → log
  warning. >30s → kill + respawn.

### Hot reload (dev mode)

Background reload = full kill + respawn. `bun run dev` opens WS to
host, on file change sends `{type: "respawn-bg", packageName, bundleUrl}`.
Host calls `JSCRuntime.respawn(packageName)`:
1. Cancel coroutine scope (Pebble's tear-down order)
2. Drop `JSManagedValue` references
3. Close JSContext
4. Spawn new context, fetch new bundle from `bundleUrl`, replay init
5. Miniapp's `init(session)` hydrates from `session.storage`

WebView reload = `webView.reload()`.

Latency target: save → see-on-glasses < 500ms for background reload,
< 200ms for WebView.

### Inspector

**iOS:** `setInspectable = true` is the killer DX feature. Gate on
iOS 16.4+ AND a runtime developer-mode flag — *off* in App Store
builds even on iOS 16.4+. Each context named
`MentraJS: <appName> (<packageName>)` so Safari Develop menu lists
them sensibly.

**Android:** Zipline exposes a Chrome DevTools wiring over the V8
debug protocol. Gate on `BuildConfig.DEBUG` only. Each context
labeled with `MentraJS: <appName> (<packageName>)` so the
chrome://inspect page lists them sensibly. Wired in Phase 6 (~3 days).

### Network inspection

`fetch` and `WebSocket` are JS shims over native — perfect chokepoint.
Dev mode: log every request/response (URL, status, duration, byte
count). Prod: log only failures and Sentry-tag with `network.host`.
No body capture in prod (privacy).

### Remote kill switch (deferred — design only)

**Not in initial scope.** No store ships in the initial cut, so there
is no upload pipeline to gate and no platform-distributed bundle to
revoke. Sketch retained here so the design slot is reserved when the
store ships.

Future cloud has `disabled_miniapps: { [packageName]: { reason, since,
scope: "all" | { userIds: [...] } } }` document. Host fetches on
launch + every 1h. If installed miniapp is in list, do NOT spawn its
JSContext; show "Disabled by Mentra" tile. Will be required for
Apple Guideline 2.5.2 compliance when the store ships.

---

## Production-critical implementation details (do not skip)

The items below are non-optional. Each is a small piece of code that
keeps the runtime from crashing or losing data in production. Most
were validated by Pebble's `coredevices/mobileapp` (GPL-3.0,
reference-only — we re-implement).

### Single `__dispatch`, NOT per-method bindings (production crash)

Pebble's `JavascriptCoreJsRunner.kt:89-114` documents an EXC_BAD_ACCESS
crash from binding ~35 native function references individually as
JSValue properties — JSC's GC raced with K/N's GC, hashing native
objects from JSC's Heap Helper Thread. Fix: one C-callable dispatch
function, generate JS-side proxy objects on top.

`CrashReproducer.kt` is in their tree as a regression test. Required
reading before exposing any native function to JSC.

The specific cause is K/N tracing GC vs JSC tracing GC; Swift uses ARC,
so we wouldn't hit *that* exact crash but we'd hit ARC-vs-JSC issues.
**Take the lesson, not the literal cause.**

### `JSManagedValue` for held JSValues

Any JSValue native code retains across calls must be wrapped in
`JSManagedValue` and registered with `addManagedReference` on the
context's virtual machine, then unregistered on destruction. Forget
this → JSC GC frees something we still reference → crash. See
`JSCJSLocalStorageInterface.kt:36-42`.

### `evalCatching` wraps every script

`JsCoreExtensions.kt:26-49`. Every `evaluateScript` call goes through
a wrapper that injects a JS try/catch piping errors to a global
handler before rethrowing. Catches syntax errors and synchronous
throws that wouldn't fire `window.onerror`. **Never call
`evaluateScript` directly outside init.**

### `signalReady` round-trip with NACK timeout

`PKJSApp.kt:91-117`. When host needs to deliver a message to JS, it
checks if JS has signalled `ready`. JS confirms via
`_Pebble.privateFnConfirmReadySignal(success)`. Host buffers messages
with a bounded timeout, NACKs on timeout.

**Two timeouts, not one** (Pebble's single 6s value is wrong for our
cold-start path):
- **Cold-start timeout: 15s.** First message after process spawn may
  need: spawn JS context (50-200ms) + evaluate ~100KB polyfill bundle
  (200-800ms) + load `background/index.js` (50-200ms) + run
  `init(session)` (user code, unbounded) + wait for the host to
  signal it's ready to deliver. On a slow Android device with
  battery saver active, this can be 3-10s; 15s gives realistic
  headroom.
- **Steady-state timeout: 3s.** Subsequent messages to an already-
  warm context — anything past 3s indicates the JS thread is wedged.

**NACK semantics:** the host's `dispatchToJs` returns an error to
its caller (the cloud-message handler / UI router / event source)
indicating the message was undeliverable. The miniapp's `init` did
not register, so from the miniapp's perspective the event simply
didn't happen — no exception is raised JS-side. Document expected
behavior so callers know to retry or surface "miniapp unresponsive."

**Re-measure on bottom-tier hardware before pinning the cold-start
number.** Pixel 4a + battery-saver + 50% storage full is the
recommended floor.

### `console.*` rewiring + `window.onerror` + `onunhandledrejection`

`startup.js:4-9` and `64-130`. All of `console.{log,warn,error,info,
debug,trace,assert}` rewired to forward to native (still calls
original). Plus `window.onerror` → `_Pebble.onError(...)` and
`window.addEventListener('unhandledrejection')` →
`_Pebble.onUnhandledRejection(...)`.

This is how user code gets debugged in production. Without it,
developer's bug is invisible unless they happen to attach Web
Inspector mid-bug.

### Console-log redaction

`PrivatePKJSInterface.kt:39-65`. Log lines containing "token",
"password", "secret", "auth", "key" are redacted before forwarding to
native. On in release, off in dev.

### `JSContext.setName()` and `setInspectable`

`JavascriptCoreJsRunner.kt:144-151`. `setInspectable` iOS 16.4+,
gated by `#available` AND a runtime config flag. 5 lines of Swift,
biggest DX feature in the runtime.

### Stable per-(user, miniapp) token

`PKJSInterface.kt:35-61`. `Pebble.getAccountToken()` returns stable
identifier scoped to (user, app), hashed so developer never sees
actual user identity. Sideloaded apps get per-developer token;
app-store apps get per-app token. Important security/privacy
primitive miniapp authors will want for cloud sync.

### Tear-down race ordering

`JavascriptCoreJsRunner.kt:155-173`. Exact sequence matters:
1. Cancel coroutine scope
2. Join all in-flight jobs (so nothing is mid-evaluate)
3. Remove all `JSManagedValue` references
4. Drop dispatcher StableRef
5. Close threadContext
6. Force `GC.collect()` to break cycles

Out of order → race where threadContext closes mid-job, or JSC GC
fires after we've freed Kotlin/Swift objects it still references.

### `debugForceGC()` diagnostic hook

Exposed as `JSGarbageCollect(jsContext.JSGlobalContextRef())`. Used
by `CrashReproducer` for repro and by us during memory leak hunts.
Ship it, gated to dev/super-mode builds.

### What we DON'T inherit from Pebble

- **Multiple concurrent JSContexts.** Pebble has one, we need N.
  Measured: works (0.75 MB/context on iPhone 15) but unprecedented
  in their design.
- **Live message bus between WebView and JS.** Pebble does one-shot
  URL redirect. Ours is novel.

---

## Pebble repo as a reference (read, don't copy)

`coredevices/mobileapp` is GPL-3.0 dual-licensed. We can't copy code
but reading it is the closest thing to a design doc since Pebble has
no published architecture documentation.

**JS runtime patterns:**
- `libpebble3/src/commonMain/kotlin/io/rebble/libpebblecommon/js/JsRunner.kt` (58 LoC) — abstract JS runtime interface
- `libpebble3/src/commonMain/.../js/PKJSApp.kt` (~286 LoC) — per-miniapp coordinator
- `libpebble3/src/iosMain/.../js/JavascriptCoreJsRunner.kt` (~281 LoC) — concrete JSContext lifecycle
- `libpebble3/src/iosMain/.../js/CrashReproducer.kt` (~99 LoC) — required reading
- `libpebble3/src/iosMain/.../js/JsCoreExtensions.kt` (~50 LoC) — `evalCatching` pattern
- `libpebble3/src/iosMain/.../js/RegisterableJsInterface.kt` — dispatch-table contract
- `libpebble3/src/iosMain/.../js/XMLHTTPRequest.js` (~166 LoC), `WebSocket.js`, `JSTimeout.js` — production JS shims
- `libpebble3/src/androidMain/.../js/WebViewJsRunner.kt` (~458 LoC) — Pebble's Android approach (system WebView + addJavascriptInterface)

**Lifecycle and state-machine patterns:**
- `libpebble3/src/commonMain/.../connection/WatchManager.kt` (~787 LoC) — multi-device state machine
- `libpebble3/src/commonMain/.../connection/Negotiator.kt` (~39 LoC) — concise post-connect handshake under 20s timeout
- `libpebble3/src/commonMain/.../connection/endpointmanager/CompanionAppLifecycleManager.kt` (~190 LoC) — "which miniapp is alive right now" decision logic; watch is source of truth

**Storage patterns:**
- `libpebble3/src/commonMain/.../locker/Locker.kt` (~705 LoC) — installed-app cache, 50 MB cap, sideloaded apps never evicted

**Patterns worth borrowing architecturally:**
- Single `__nativeDispatch` + JS-side proxy
- `evalCatching` wrapping every script eval
- HTTP interceptor as chain-of-responsibility
- Both `bluetooth-central` AND `bluetooth-peripheral` background modes
- Foreground service opt-in on Android, not forced
- Per-miniapp JSContext on its own dedicated thread (JSC is thread-affine)
- Watch (glasses for us) is source-of-truth for running-miniapp state

**Mistakes their code documents — avoid:**
- Don't bind N native functions individually into JSContext (CrashReproducer.kt)
- Don't ship a thin XHR shim and call it done
- Don't store running-miniapp state on phone as truth
- Don't auto-evict sideloaded miniapps when hitting cache caps
- Don't conflate "what's installed" (locker) with "what's running" (lifecycle manager)

---

## Testing strategy

**Three layers of tests, ordered by what they catch:**

### Layer 1 — Unit tests (every phase)

Standard Jest suites colocated with the code. Each phase's
acceptance gate enumerates the unit tests it must add.

- **iOS native:** XCTest in `mobile/modules/crust/ios/Tests/`.
  `bun test:ios:native` runs them.
- **Android native:** JUnit + Robolectric in
  `mobile/modules/crust/android/src/test/`.
  `bun test:android:native` runs them.
- **Polyfill bundle:** Jest snapshot tests against `dist/startup.js`
  output; per-API conformance tests for `fetch`, `URL`, `crypto`,
  etc. Run as part of `bun test`.
- **TypeScript SDK:** Jest in `mobile/modules/miniapp/test/` and
  `mobile/test/`. Existing harness; just add cases.

Unit tests catch wire-protocol regressions and per-handler bugs.
They don't prove the system works end-to-end — that's Layer 3.

### Layer 2 — Conformance tests (Phase 1 onward)

Run a subset of [Web Platform Tests](https://github.com/web-platform-tests/wpt)
against the polyfill bundle inside both engines, in CI:

- `fetch` — at least the `headers/`, `request/`, `response/`,
  `redirect/`, `abort/` subdirectories.
- `url` — `URL` parse / serialize / IDL surface.
- `encoding` — `TextEncoder`/`TextDecoder` round-trips.
- `WebCryptoAPI` — `subtle.digest` / `subtle.encrypt` / etc.

Initial target: **>80% pass on each suite, both engines.** Failures
are tracked as known-bug exceptions in a YAML allowlist (so new
regressions are caught but pre-existing gaps don't block CI).

This is the only way to know our `fetch` shim *behaves* like
browser fetch, not just "doesn't throw."

### Layer 3 — Example app as integration test

**`sdk/example-miniapp/` is the canonical end-to-end test fixture.**
It exists today as a single React SPA (Live Captions + 15 tester
pages exercising every `session.*` interface). Appendix A
documents the migration to the two-layer architecture, and that
migration is itself the integration acceptance gate for Phase 5.

After Phase 5 ships, the example app must round-trip every
`session.*` call through the new architecture — same observable
behavior as today, plus the new background/UI separation. The
existing tester pages effectively become an end-to-end test
suite for the SDK surface.

**Manual gate (run on real hardware before each phase ships):**
1. Install the latest example app on iPhone 15 + Pixel 4a.
2. Connect glasses (G1 or G2).
3. Open the app, navigate to each tester page in turn, exercise
   the controls. Visually verify expected glasses behavior +
   on-phone UI updates.
4. Background the host app for 5 min with glasses connected;
   verify transcription + display still work.
5. Force-kill the host app; reopen; verify state hydrates from
   `session.storage`.

This is the gate that catches integration bugs unit tests miss.
Maestro scripts cover the on-phone UI half (already exists at
`mobile/.maestro/`); glasses-side verification is manual until we
build a hardware-in-the-loop harness (out of scope for V1).

### Layer 4 — Production telemetry (Phase 6 onward)

Sentry counters `miniapp.crash`, `miniapp.respawn`,
`miniapp.evicted`, `miniapp.dispatch_latency_ms{method}` are the
post-ship feedback loop. Document baseline ranges in Phase 6 so
on-call has a target to compare against.

### What an agent should do

When implementing a phase end-to-end, in order:
1. Write the unit tests called out in the phase's "Acceptance gate"
   *first* (or alongside the implementation, but before declaring
   the phase done).
2. Run the WPT subset and check no regressions vs the previous
   phase's allowlist.
3. Walk through the manual gate above on real hardware. If you
   don't have hardware, **say so explicitly** in the PR
   description rather than claiming success.
4. After Phase 5: re-run the full example-app acceptance from
   Appendix A. After Phases 1-4: run the example app's *current*
   single-bundle behavior to confirm nothing broke for downstream
   work; the new behavior lights up at Phase 5.

If a unit test passes but the manual gate fails, the unit test is
wrong (or insufficient) — fix it, don't paper over the failure.

---

## Implementation plan

The architecture is a refactor + add, not a rewrite. **Two parallel
work tracks:** mobile/SDK (Phases 0–6) and cloud (separate plan,
loosely coupled). Mobile phases are sequential but each is
independently shippable.

**Pre-existing planning docs to reconcile:** `agents/` already
contains several miniapp-related plans —
`miniapp-store-backend-plan.md`, `local-app-runtime-plan.md`,
`miniapp-sdk-surface-alignment-plan.md`,
`miniapp-sdk-v3-alignment-spec.md`,
`miniapp-dev-applets-as-installed-apps-plan.md`,
`HUMAN-TODO-miniapp-improvements.md`. Before starting Phase 1, do a
pass to mark each as **superseded by this spec**, **still in scope**,
or **partially absorbed** — otherwise engineers will follow stale
plans.

### Phase 0 — Ship-with-eviction (~1.5 weeks)

**Goal:** Make the existing persistent-WebView model survivable on
SE-class devices so the current PR ships. **This phase is
throwaway scaffolding** — Phase 3 replaces persistent WebViews
entirely. Decision: ship it anyway because the current PR can't go
out without it, but timebox tightly.

Tasks:
- New native binding for `NSProcessInfo.physicalMemory` in `crust`
  (no existing first-party exposure of this API).
- Device-tier table: 3 GB → 1 background slot; 4 GB → 3; 6 GB → 5;
  8 GB+ → 8. Document numbers as derived from the iPhone 15
  benchmark (extrapolated, not validated on every tier).
- Add `lastForegroundAt: number` to `MiniappRunningRegistry` (today
  it's a plain `Set<string>` — needs schema extension).
- LRU eviction lives in **`mobile/src/components/miniapp/MiniappHost.tsx`**
  (627 LoC), NOT `LocalMiniappRuntime.ts`. MiniappHost owns
  mount/unmount/setForeground/setBackground today; eviction policy
  is a new branch in `setBackground`.
- "State flush on evict" is hard — there's no API to snapshot a
  WebView's JS heap. The fallback: emit a `beforeevict` message to
  the WebView; let the miniapp persist via existing
  `session.storage`. Document that miniapps following the
  "storage as source of truth" rule survive eviction transparently;
  others lose state.
- UI state when app was evicted (re-mount splash with "restoring…").
- Telemetry counter for `miniapp.evicted` (drops are otherwise
  invisible).
- Tests: `MiniappRunningRegistry` has none today; LRU policy needs
  a real test suite. **Keep tests focused on the eviction policy,
  not the persistent-WebView wiring** — Phase 3 deletes the
  *implementation* (persistent WebViews go away, so there's nothing
  left to evict), but the *policy-only* tests (LRU selection,
  capacity-per-tier) survive into Phase 3 as plain unit tests
  against the policy function.

**Android:** explicitly out of scope for Phase 0. Android doesn't
hit the same jetsam wall — multiple WebViews share one renderer
process. We don't need eviction there until usage shows we do.

**Acceptance gate (how to know Phase 0 is done):**
- Unit: `MiniappRunningRegistry` LRU test suite passes (eviction
  picks oldest `lastForegroundAt`, capacity matches device tier).
- Manual: install 3 miniapps on iPhone SE 2; foreground each in
  turn; verify the OLDEST gets evicted (telemetry counter
  `miniapp.evicted` increments) when capacity exceeded.
- Manual: re-foreground an evicted miniapp; verify splash shows
  "restoring…" then app rehydrates from `session.storage`.
- Telemetry: `miniapp.evicted` counter visible in Sentry.

### Phase 1 — JS runtime in `crust` (~3 weeks iOS, +2-3 weeks Android)

**Goal:** Spawn N JS contexts from Swift (JSC) and from Kotlin
(QuickJS via Zipline), route `__dispatch` to existing native
services, get a "hello world" miniapp displaying text on glasses
without WebView.

**iOS uses JSC, Android uses QuickJS via Zipline.** See
"Cross-platform: QuickJS on Android (via Zipline), JSC on iOS"
earlier for the rationale. Phase 2-6 below assume iOS is the
leading edge; each phase notes any Android-specific work.

Native (Swift):
- New files in `mobile/modules/crust/ios/Source/`:
  `JSCRuntime.swift`, `JSCDispatcher.swift`, `JSCPolyfillBridge.swift`.
  ~300-500 LoC total. Salvage code from
  `mobile/modules/bluetooth-sdk/ios/Source/utils/JSCExperiment.swift`
  (241 LoC, the spike that already proved the architecture) — start
  by lifting the `JSVirtualMachine`-per-context, `__dispatch`
  injection, and lifecycle code.
- Add Expo Functions to `CrustModule.swift`: `mentraJsSpawn`,
  `mentraJsEvaluate`, `mentraJsKill`, `mentraJsDispatchToJs`. Event
  `mentrajs_message`. Verify the new module registers cleanly via
  `bun expo prebuild` (note: per `mobile/AGENTS.md`, never use
  `--clean` or `--clear` flags).
- **`crust` already owns the native nav + heading + EvenHub-style
  protocol surfaces** after the 2026-05 nav merge (Google Nav SDK
  on iOS via `GoogleNavigation` pod + `NavigationManager.swift` 811
  LoC + `HeadingManager.swift` 74 LoC; on Android the equivalent
  Kotlin lives under `crust/android/.../navigation/` and
  `.../heading/` for 1500+150 LoC plus the `NavInfoReceiverService`
  manifest entry). The Phase 1 dispatcher's `iface: "navigation"`
  and `iface: "heading"` routes call straight into those existing
  singletons — no new native code, just `__dispatch` glue +
  permission gate.
- Pebble-inherited pieces all in scope: `JSManagedValue`,
  `evalCatching`, `console.*` rewiring, `window.onerror` /
  `onunhandledrejection`, `signalReady` with 15s cold-start /
  3s steady-state NACK timeouts,
  `JSContext.setName` + `setInspectable`, log redaction, tear-down
  race ordering, `debugForceGC` hook, stable per-(user, miniapp)
  token. Each is a 1-2 day item.

Polyfill bundle (new package):
- New Expo module: `mobile/modules/mentrajs-runtime/`. Needs
  `expo-module.config.json`, `package.json`, build script.
- The polyfill bundle is JS that gets evaluated as a single string
  inside the JSContext. Needs a bundler step (esbuild/rollup) that
  produces `dist/startup.js` — a single file with all polyfills
  inlined. **Add this build step explicitly; it's not free.**
- **Distribution to device:** the bundled `startup.js` is committed
  to source as a build artifact and shipped *inside the host RN app
  binary* via Expo Module assets. iOS: bundled into the Expo module
  framework's resources, read at runtime via `Bundle.module`.
  Android: placed under `crust/android/src/main/assets/` and read
  via `AssetManager.open("startup.js")`. **Not** fetched OTA — must
  match the host's `JSCDispatcher` ABI exactly, so it ships with
  the host app version.
- Install MIT libs to `mobile/package.json`:
  `@react-native/js-polyfills`, `fast-text-encoding`,
  `whatwg-url-without-unicode`, `base-64`, `event-target-shim`,
  `fetch-blob`, `formdata-polyfill`, `abort-controller`. (None are
  currently in `mobile/package.json`.)
- Write thin bridges in `JSCPolyfillBridge.swift` for setTimeout
  (DispatchQueue), fetch (URLSession), WebSocket
  (URLSessionWebSocketTask), localStorage (NSUserDefaults with
  `MentraJS-{packageName}` suite), crypto (CryptoKit).

Native (Kotlin):
- Add `app.cash.zipline:zipline:1.27.0+` to
  `mobile/modules/crust/android/build.gradle`. ~1.2 MB Zipline +
  QuickJS native lib per ABI. Plus
  `com.google.crypto.tink:tink-android:1.13.0+` (~1.2 MB AAR for
  X25519 / `crypto.subtle`). **Total APK growth: ~6-7 MB** on
  arm64-only Play Store splits (universal APK higher).
- New Kotlin files in `mobile/modules/crust/android/src/main/java/com/mentra/crust/`:
  `jsc/JSCRuntime.kt`, `jsc/JSCDispatcher.kt`, `jsc/JSCPolyfillBridge.kt`.
  ~600-800 LoC. Symmetric with the Swift surface — each `JSCRuntime`
  per miniapp wraps a `Zipline` instance.
- Add the same Expo Functions to `CrustModule.kt`. Verify
  `bun expo prebuild` regenerates the Gradle config (no `--clean`).
- Bridge concretes: OkHttp (fetch/WebSocket), `Handler.postDelayed`
  via our existing `BackgroundTimer` pattern for `setInterval`
  (Zipline supplies `setTimeout`/`clearTimeout`), SharedPreferences
  (`localStorage` with `MentraJS-{packageName}` name), `javax.crypto`
  for SHA / AES-GCM / HMAC, Tink for X25519 (Android stdlib X25519
  is API 33+ only), `SecureRandom.nextBytes` for `crypto.getRandomValues`.
- **All polyfill shims are `ZiplineService` suspend methods** so
  Zipline's bridge handles Promise resume + microtask drain. No
  public `executePendingJobs` API exists in Zipline. ~50 LoC of
  `ZiplineService` interface scaffolding shared across the shim
  files. See "Mandatory microtask discipline" earlier.
- Same single-`__dispatch` pattern, log redaction, tear-down
  ordering, stable per-(user, miniapp) token, and `signalReady`
  with NACK timeout as iOS.

JS:
- New `DispatchTransport.ts` in
  `mobile/modules/miniapp/src/transport/`. Add 4th branch to
  `auto.ts` (currently has 3: PostMessage, Mock,
  LocalSocketWithMockFallback).

**Android sequencing within Phase 1.** iOS ~3 wks, Android +2-3 wks
(matching the header). One engineer sequential ≈ 5-6 wks; two
engineers parallel ≈ ~3 wks calendar (iOS paces). If iOS surfaces
architectural issues mid-phase, Android port slips and ships in
Phase 2's window — but **don't ship the SDK as iOS-only at GA**.

**Acceptance gate (how to know Phase 1 is done):**
- Snapshot test: polyfill bundle output is byte-stable across
  builds.
- Unit (iOS): spawn → evaluate `2+2` → expect `4` → kill, no leaks
  per Instruments Allocations.
- Unit (Android): spawn → evaluate `2+2` → expect `4` → kill, no
  leaks per Android Profiler.
- Unit: `JSCPolyfillBridge` round-trips fetch / setTimeout /
  localStorage / crypto.subtle on both platforms (mocked native).
- Memory benchmark (iOS): 50 idle JSContexts ≤ ~50 MB total
  delta — see existing measured table.
- Memory benchmark (Android): record actual numbers in
  `agents/spike-results/zipline-spike-android.log` (the iOS
  estimate of ~1-1.5 MB per Zipline context needs validation).
- E2E (iOS + Android): hello-world miniapp installs, JS context
  spawns, `session.display.showTextWall("hi")`, glasses display it.
- Microtask test (Android): native bridge resolves a Promise from
  outside a JS call; verify `.then()` runs (proves microtask drain
  helper is wired).

### Phase 2 — Refactor `LocalMiniappRuntime` → `MentraJSRouter` (~3 weeks)

**Goal:** All 33 dispatch arms from `LocalMiniappRuntime.ts`
survive, front door swaps from postMessage to `__dispatch`.

- Move all 33 dispatch arms in `handleRawMessage`'s switch to a new
  `MentraJSRouter` class taking `(packageName, payload)` from
  `__dispatch` events. Of these, 19 delegate to `private handle*`
  methods (`handleConnect`, `handleSubscribe`, `handleDisplay`,
  `handlePlayAudio`, `handleStopAudio`, `handleRgbLed`,
  `handleCameraFov`, `handleStreamStart`, `handleStreamStop`,
  `handleManagedStreamStart`, `handleManagedStreamStop`, plus the
  eight `handleNavigation*` methods added in the 2026-05 nav
  merge); the remaining ~14 (SPEAK, LOCATION_POLL,
  STORAGE_GET/SET/DELETE/LIST, SHARE, OPEN_URL, COPY_CLIPBOARD,
  DOWNLOAD, PHOTO, PING, PONG, DASHBOARD_CONTENT_UPDATE) are inline
  `case` blocks. Lift both shapes verbatim — keep the inline ones
  inline in the new router unless they grow.
- **Carry forward the navigation accounting too.** The handler set
  is more than the eight cases: the runtime holds a `navListeners`
  Map (per-app forwarder unsub functions) and an `activeNavApps`
  Set (apps with an active trip). These get reattached on each
  `NAVIGATION_START`, detached on `unregisterApp`, and cleared on
  `arrived`/`error`/`NAVIGATION_STOP`. All of that bookkeeping
  belongs on `MentraJSRouter` — verbatim except for the front-door
  swap.
- **`location_stream` rate aggregation.** `LocalMiniappRuntime`
  tracks each connected app's `requestedLocationRate` and
  recomputes the *strictest* across all apps after every SUBSCRIBE
  and unregister (`recomputeLocationTier`); downgrades to `"off"`
  when no app is asking. The aggregate hits `MantleManager` via
  `RuntimeHooks.locationTier`. Bug surface here is real — keep the
  unit-testable algorithm intact in the rewrite and verify the
  downgrade path in tests.
- **`recomputeHeadingSubscription`.** Sensor stream is ref-counted
  on the `heading_update` subscriber set. Same shape as mic; lift
  verbatim.
- Public `handlePong` and inline PING handler stay; both are wired
  into the existing ping/keepalive loop.
- Front door: replace `handleRawMessage(packageName, raw)`
  (`public handleRawMessage` in `LocalMiniappRuntime.ts`) with the
  new `__dispatch`-driven entry point.
- Per-app `sendMessage` (currently `app.sendMessage(serialized)`,
  registered in `public registerApp()`, wired in `MiniappHost.tsx`
  via `webview.injectJavaScript("window.receiveNativeMessage(...)")`)
  becomes `JSCRuntime.dispatchToJs(...)`.
- **Cloud message routing:** preserve `public handleCloudMessage(msg)`
  — it routes cloud-relayed responses (`phone_photo_ready`,
  `phone_stream_status`, `phone_managed_stream_status`) via the
  `pendingCloudRequests` Map. This is a separate inbound path the
  spec didn't initially flag.
- **Collapse parallel registries:** today
  `WebviewBridge.setWebViewMessageHandler` and `MiniappHost.tsx`
  maintain a parallel registry on top of `LocalMiniappRuntime`'s
  own. New router has ONE registry.
- **Carry forward** infrastructure that's not a handler but lives
  in this file: `dev_log` console-tap, stream fan-out subscribers
  (`streamSubscribers` Map), `recomputeMicRequirements`,
  `updateCloudSubscriptions`, `installedManifest` permission
  gating (`declaredTypes` set, `permissionForStream` helper, gating
  loop, reject branch), `setInstalledManifest`, `unregisterApp`,
  `PERMISSION_NOT_DECLARED` once-per-session dedup
  (`warnedPermission` Set + `logPermissionNotDeclared` helper).
- **HMAC/local-token code removal:** verify nothing outside
  `LocalMiniappRuntime.ts` calls `generateLocalToken`/
  `validateLocalToken` (grep before deletion). Currently exposed
  publicly with comments tagging "browser fallback auth (Phase 4)" —
  if external callers exist, retire them first.
- Verify all existing miniapp APIs (display, transcription, mic,
  camera, speaker, LED, location, IMU, button events) work
  end-to-end through the new path.

**Android within Phase 2.** No additional Android-specific code —
this phase is pure RN runtime refactor (TypeScript). The
`MentraJSRouter` is platform-agnostic; it talks to whichever
`Crust` native module is loaded. As long as Phase 1 Android (Zipline/QuickJS integration) is
done, Phase 2 lights up on Android automatically.

**Acceptance gate (how to know Phase 2 is done):**
- Unit: each lifted handler has at least one test against a stub
  `__dispatch` event input and asserted native call.
- Unit: `MentraJSRouter` routes `__dispatch` to the correct handler
  by `iface`/`method` keys.
- Unit: `recomputeLocationTier` aggregates the strictest rate
  across N connected apps; downgrades to `"off"` on
  unregister-of-strictest. Cover the `LOCATION_RATE_PRIORITY`
  ordering explicitly.
- Unit: `recomputeHeadingSubscription` starts the sensor only on
  the first `heading_update` subscriber and stops on the last.
- Unit: per-app nav forwarder unsubscribes on `NAVIGATION_STOP` and
  on natural `arrived`/`error` events but survives mini-app UI
  close (mirrors the `activeNavApps`/`navListeners` discipline in
  the current runtime).
- Integration: install the example miniapp; verify every existing
  `session.*` call (display, transcription, mic, camera, speaker,
  LED, location, IMU, button events, navigation, heading)
  round-trips correctly by observing the existing tester pages
  still work end-to-end.
- Grep: zero references to `generateLocalToken`/`validateLocalToken`
  outside the deletion site.
- Grep: zero references to `app.sendMessage(...)` (replaced by
  `JSCRuntime.dispatchToJs(...)`).

### Phase 3 — WebView lifecycle inversion + UI message bus (~4 weeks)

**Goal:** WebView spawned on demand can talk to its bound JSContext
via `mentra.send`/`mentra.on`.

**Major architectural inversion to acknowledge:** today's
`MiniappHost.tsx` keeps WebViews **persistently mounted off-screen**
at `-left-[10000px]` (`:554`); `setForeground/setBackground` toggle
the offscreen class. This phase inverts the lifecycle to "spawn cold
on user open, destroy on exit." Phase 0's eviction code becomes
obsolete and gets removed here.

Implementation strategy for the bootstrap shim:
- `react-native-webview` does NOT expose raw `WKUserScript` or
  `webkit.messageHandlers` (verified: zero uses anywhere in the
  codebase). All WebView communication goes through
  `injectJavaScript` (runtime injection) + `onMessage`
  (`postMessage` from JS to native) for bidirectional comms.
- **Bootstrap-before-page-load is the only thing that differs by
  platform.** iOS uses `injectedJavaScriptBeforeContentLoaded`
  (reliable; today's `MiniappHost.tsx` and `webview.tsx` both
  already pass this prop).
  Android must use `injectedJavaScriptObject` instead, with a small
  inline `<script>` in the WebView's `index.html` that reads
  `window.ReactNativeWebView.injectedObjectJson()` and installs
  the `window.mentra` shim — the
  `injectedJavaScriptBeforeContentLoaded` prop is documented
  unreliable on Android (react-native-webview docs warn explicitly,
  refs issues #1099 / #1609).
- We layer the new `mentra.send/on/ready` API on top of this
  existing primitive — NOT raw WKUserScript. The spec's earlier
  references to `webkit.messageHandlers` were imprecise; the actual
  implementation uses `window.ReactNativeWebView.postMessage` with
  a typed envelope.
- Build the new `MentraUIRouter` over `react-native-webview`'s
  primitives, with the platform-conditional bootstrap above.
  ~1 week iOS + ~3 days Android (the bundler-injected inline
  bootstrap is a small new piece).

Tasks:
- Refactor `MiniappHost.tsx` (627 LoC): change `mount` semantics
  from "create persistent off-screen WebView" to "create transient
  WebView when user navigates to its UI route." Keep the public
  `mount/unmount` API; change semantics underneath.
- New `MentraUIRouter` (in `mobile/modules/engine/src/services/`,
  replacing `WebviewBridge.ts`): given a WebView and a
  `packageName`, routes `postMessage` from JS to the JSContext's
  `session.ui.on()` handlers, and routes `session.ui.send()`
  outputs back via `injectJavaScript("window.__mentra.recv(...)")`.
- `window.mentra` shim (~50 LoC). Full surface:
  `send`, `on`, `ready`, `onOpen`, `onClose`. Outbound buffer for
  messages before `ready()` ack. **Bootstrap path:** iOS injects via
  `injectedJavaScriptBeforeContentLoaded`; Android injects via
  `injectedJavaScriptObject` + a small bundler-emitted inline
  `<script>` in the WebView's `index.html` (see "Implementation
  strategy for the bootstrap shim" above).
- New `session.ui` module in
  `mobile/modules/miniapp/src/modules/ui.ts`. Surface:
  `send/on/onOpen/onClose/isOpen`. Wire into
  `mobile/modules/miniapp/src/session.ts`'s module-instantiation
  block (where `display`, `glasses`, `heading`, `navigation`, etc.
  are constructed) alongside the existing modules.
- Heartbeat: WebView sends `__heartbeat__` every 5s; background
  considers WebView gone after 15s silence.
- Sequence numbers + dedup window so message-bus replays during
  reconnect don't double-fire handlers.
- `dev-reload.ts` (60 LoC) — needs an update so the new shim's
  `window.__mentra.recv()` direct call still triggers reload events.
- `MiniappSplash` and `isLoaded` flag exist for slow-loading
  WebViews; reconcile with cold-spawn UX. Document expected
  splash-time behavior.
- Port the Notes example end-to-end.

**Android sequencing within Phase 3.** iOS WebView binding first,
then Android equivalent (`addJavascriptInterface` +
`evaluateJavascript` on Android WebView). Same shape, slightly
different native surface. ~3 weeks iOS + ~1 week Android — fits
the 4-week phase budget.

**Acceptance gate (how to know Phase 3 is done):**
- Unit: `MentraUIRouter` routes `mentra.send` → JSContext's
  `session.ui.on` handler in both directions, including outbound
  buffer flush after `ready()`.
- Integration: round-trip "WebView taps button → background runs
  glasses display call → glasses show text" on real hardware (iOS
  and Android).
- Manual: Notes example app — tap "show" in the WebView, see text
  on glasses, dismiss WebView, re-open WebView, see state preserved
  via `session.storage`.
- Manual: kill WebView mid-message-flight; verify background
  doesn't crash and re-opens cleanly.
- Perf: measure WebView open-to-render latency on iPhone 15 and
  Pixel 4a. Set a budget if numbers are surprising; otherwise just
  log them as the baseline.

### Phase 4 — Bundle / install / sideload (~1.5 weeks, mobile only)

V1 ships LAN-only sideloading via `bun mentra-miniapp dev` and
`bun mentra-miniapp release`. **No store, no signing, no remote
download** for V1. Bundles come from the developer's laptop over
LAN HTTP + QR code (already implemented).

**Goal:** Two-output bundles flow through CLI and install path.

- Update `sdk/miniapp-cli/schema/miniapp.schema.json` (120 LoC):
  add `sdkVersion`, `minHostVersion`, `entry` object schema fields.
- Update `sdk/miniapp-cli/src/manifest*.ts` (4 non-test files,
  ~712 LoC): manifest pipeline + JSON Schema generator. Add new
  fields. Keep mutation primitives, atomic-write, Levenshtein
  validator, clack wizard.
- Update `sdk/miniapp-cli/src/pack.ts` (90 LoC) + `release.ts`
  (294 LoC): emit two-output bundle (`dist/background/index.js` +
  `dist/ui/`). Today's pack zips a flat `dist/` — needs a
  convention shift.
- Update `sdk/miniapp-cli/src/dev.ts` + `dev-server.ts` (~480 LoC):
  bundle both layers; add `{type:"respawn-bg"}` message alongside
  existing `{type:"reload"}`.
- Update `mobile/modules/engine/src/services/AppRegistry.ts`
  (675 LoC): recognize new manifest fields; sdkVersion/
  minHostVersion gating; `background/index.js` discovery alongside
  `index.html`.
- **Update `sdk/example-miniapp/miniapp.json`** to add `entry`,
  `sdkVersion`, `minHostVersion` fields (Appendix A) — this app is
  the canonical fixture and must match the new schema before
  Phase 5's scaffolder rewrite ships.
- **`buildProjectZip` contract change:** today the zip pipeline
  walks `dist/` flat. New contract walks `dist/background/`
  recursively (preserving the `dist/background/` prefix) and
  `dist/ui/` recursively (preserving the `dist/ui/` prefix). Both
  folders mirror the `src/` layout 1:1. Document the new layout in
  the function's TSDoc and add a unit test asserting both folders
  are present in the zip.
- **Build-time env vars for miniapps.** Adopt the same
  `MENTRA_PUBLIC_*` (or similar) prefix convention the host uses
  for `EXPO_PUBLIC_*` — values from the developer's shell env (and
  miniapp-local `.env`) get inlined into both `dist/background/`
  and `dist/ui/` bundles at build time via the bundler's `define`
  option. Document that anything inlined into the UI bundle is
  visible in the WebView's network requests and source maps — keys
  that need to stay secret must live behind the developer's own
  backend, not in `MENTRA_PUBLIC_*`. The host's `mentra-miniapp dev`
  command picks up the miniapp's `.env` automatically (Bun loads
  `.env` from cwd; nothing special required).
- **Two-output build tooling.** The default scaffolded project
  ships two bundler configs (e.g. `build.background.ts` + 
  `build.ui.ts`) or one config with two entries. The background
  config **must not** pull DOM/CSS plugins (Tailwind, PostCSS, HTML
  imports) — the JSContext has no DOM. The UI config is a normal
  browser bundle. Phase 5's scaffolder template establishes the
  canonical shape; Phase 4's bundler contract just needs to accept
  whatever layout produces `dist/background/index.js` +
  `dist/ui/index.html`.

**Android within Phase 4.** `AppRegistry.ts` is platform-agnostic
TypeScript — the install path / unzip / on-disk layout (under
`Documents/lmas/` on iOS, `getFilesDir()/lmas/` on Android — same
relative tree) is identical across platforms. Verify the Android
unzip path resolves the same `dist/background/index.js` + `dist/ui/`
discovery as iOS.

**Out of scope for V1, deferred:**
- Ed25519 signature verification (no store, all bundles are
  sideloaded → unsigned by definition).
- `Documents/lmas/` → `Application Support/mentraos/` migration.
  Today's path works; migration is a per-platform footgun and not
  worth the risk for the current LAN-sideload product.
- Cloud-hosted bundle storage / R2 / install-URL flow.

These come back when we ship the store; not now.

**Acceptance gate (how to know Phase 4 is done):**
- Unit: `buildProjectZip` test asserting the zip contains both
  `dist/background/index.js` and `dist/ui/index.html` with correct
  prefixes.
- Unit: manifest schema validates a sample two-layer manifest with
  `entry.background` + `entry.ui` + `sdkVersion` + `minHostVersion`.
- Unit: `AppRegistry` rejects a manifest whose `minHostVersion`
  exceeds the current host version.
- Integration: `bun mentra-miniapp dev` from `sdk/example-miniapp/`
  produces a working zip; install via QR; both halves load on iOS
  and Android.

### Phase 5 — SDK split + scaffolder + example app migration (~2 weeks)

**Goal:** Developers can `bun create mentra-miniapp` and get a
two-layer template. Existing `sdk/example-miniapp/` migrates per
Appendix A — that migration is the integration acceptance gate for
the entire architecture.

- **Package naming: sub-paths under `@mentra/miniapp` (decided).**
  - `@mentra/miniapp/background` — session API (`glasses`, `phone`,
    `input`, `display`, `transcription`, `mic`, `speaker`, `camera`,
    `dashboard`, `led`, `location`, `imu`, `permissions`, `storage`,
    `stream`, `system`, `ui`, `diagnostics`).
  - `@mentra/miniapp/ui` — WebView-side `mentra` global, React
    hooks, `MentraProvider`, settings-page components.
  - **No bare `@mentra/miniapp` import.** Sub-paths only. There
    is no installed-base of miniapps to maintain back-compat with —
    we have one example app and rewrite it.
  - The unrelated cloud-side `@mentra/sdk` package keeps its name —
    no collision because we don't take that name.
  - Pattern matches Firebase, tRPC, Radix UI, Sentry: import path
    encodes the layer, so wrong-layer imports are caught at code
    review and bundlers tree-shake by sub-path boundary.
  - Set up via `package.json` `exports` field with separate
    `types` entries per sub-path so TypeScript can attach
    different ambient types per layer (e.g. `mentra: ...` global
    only declared in the `/ui` entry).
- Split `mobile/modules/miniapp/src/index.ts` (108 LoC) into
  `src/background/index.ts` and `src/ui/index.ts`. No npm-package
  rename.
- Update `sdk/create-mentra-miniapp/template/`: today scaffolds a
  Bun-server-based React SPA (`server.ts`, `index.html`, `src/`).
  Rewrite to scaffold `src/background/index.ts` (+ optional
  `src/background/controllers/` placeholder), `src/ui/index.html`,
  `src/ui/main.tsx`, `src/ui/App.tsx`, `src/shared/channels.ts`.
  Two-output build (Vite has separate `vite.config.background.ts`
  and `vite.config.ui.ts` — or one config with `build.lib.entry`
  mapping). Symmetric folder layout per Appendix A.
  Scaffolder logic at `sdk/create-mentra-miniapp/bin/index.ts`
  (149 LoC) survives — only template files change.
- Restructure `sdk/example-miniapp/` per **Appendix A** (entire
  React SPA migration). The new `MentraProvider` and `useSession`
  implementations live in `@mentra/miniapp/ui` and wrap the message
  bus rather than the in-WebView `MiniappSession` (which goes
  away on the UI side). New `useChannel<T>(name)` hook is the
  primary read path for state pushed by background.
- Documentation: SDK reference, tutorial, **rewrite the existing
  Mintlify docs** at `mintlify-docs/docs.json` (and `cloud/docs/docs.json`
  if it overlaps) to describe the two-layer model. Greenfield —
  no compat shim or migration guide for legacy single-bundle apps,
  per the "no installed base" decision. Realistic doc effort: 3-5
  days. Doc updates that cross multiple phases (e.g. permission
  model, signing) get scheduled in the phase that lands the
  feature, not lumped here.

**Android within Phase 5.** None — `@mentra/miniapp/{background,ui}`
is platform-agnostic JS. Same package serves both platforms.

**Acceptance gate (how to know Phase 5 is done):**
- `bun create mentra-miniapp test-app` produces a working scaffold
  with the symmetric `src/background/` + `src/ui/` layout from
  Appendix A.
- TypeScript compile passes for both `@mentra/miniapp/background`
  and `@mentra/miniapp/ui` sub-paths with their separate ambient
  types. **Test harness:** new file
  `sdk/example-miniapp/test/sub-path-types.test-d.ts` (or in
  `@mentra/miniapp` itself) using `tsd` or `@ts-expect-error` blocks:
  one block imports `from "@mentra/miniapp/background"` and asserts
  `// @ts-expect-error` on a reference to the `mentra` global; a
  second block imports `from "@mentra/miniapp/ui"` and asserts
  `mentra.send` typechecks. `bun typecheck` must pass.
- `sdk/example-miniapp/` runs end-to-end on the new architecture
  (full Appendix A acceptance gate — see "Acceptance test for the
  example-app migration" in Appendix A).
- Mintlify docs site builds and the two-layer model is documented.

### Phase 6 — Operations (~2 weeks)

**Goal:** Crash detection, telemetry, logging.

- Crash recovery state machine in `JSCRuntime` (RUNNING → CRASHED →
  BACKOFF → CRASHLOOP_DISABLED). Implement on both platforms.
- Telemetry counters wired to **Sentry** (no separate telemetry
  pipeline exists — verified). Tag events with
  `miniapp.packageName`, `miniapp.version`, `miniapp.sdk_version`,
  `device.model`, `miniapp.engine` (`jsc` or `quickjs`). Existing
  Sentry infra at `mobile/src/effects/SentrySetup.tsx`.
- Logging architecture (redaction, ring buffer, throttle).
- Health checks (heartbeat + ping).
- Soft watchdog (5s warn / 30s kill).
- **Android Chrome DevTools wiring (~3 days).** Zipline supports
  attaching Chrome DevTools to its QuickJS contexts via the V8
  debug protocol over WebSocket. Wire it behind `BuildConfig.DEBUG`
  to give Android the equivalent of iOS's Safari Inspector workflow.

**Out of scope for V1:** remote kill switch, dev portal. No store
in V1 → no kill switch needed; no upload UI / signing UI / crash
dashboard / engagement metrics needed. These come back when we ship
the store.

**Android within Phase 6.** Crash recovery state machine and
telemetry mirror in Kotlin's `JSCRuntime.kt`. Same Sentry SDK
(`@sentry/react-native`) ships unified events across platforms;
no Android-specific tag work needed.

**Acceptance gate (how to know Phase 6 is done):**
- Inject a deliberate crash into the example app's background
  (`throw new Error("test crash")` in `init`); observe the state
  machine progress through CRASHED → BACKOFF → eventual respawn.
- Inject a tight infinite loop; verify the soft watchdog warns at
  5s and kills at 30s; verify the kill is logged to Sentry with
  the right tags.
- Trigger a Sentry test event from inside a miniapp; verify it
  appears in Sentry tagged with `miniapp.packageName`,
  `miniapp.engine`, `miniapp.version`.
- Manual: connect Safari Web Inspector to an iOS-JSC context;
  verify console / sources panels work.
- Manual: connect Chrome DevTools to a Zipline context on Android;
  verify the same.

### Total: ~17 weeks mobile (iOS leading), Android lags by ~2-3 weeks

Phases 0-6 iOS sequential: 1.5 + 3 + 3 + 4 + 1.5 + 2 + 2 = **17 weeks**.
Phase 1 Android (Zipline / QuickJS integration + Kotlin bridge +
microtask discipline) adds **2-3 weeks**. With one engineer doing
both platforms sequentially: ~19-20 weeks total. With two engineers
parallelizing iOS-JSC and Android-Zipline from Phase 1 onward:
**~17 weeks calendar time** (iOS Phase 1 paces).

V1 has **zero cloud work**. The CLI's `bun mentra-miniapp release`
flow already serves bundles over LAN HTTP + QR (existing,
implemented). Mobile runtime fetches from the laptop. Done.

When we ship a store later, the cloud work returns:
- Ed25519 signing pipeline (mint `META-INF/signature.ed25519` at publish)
- Version channels on the `miniapps` collection schema
- `minHostVersion` gating in cloud manifest snapshot
- Remote kill switch endpoint + storage + admin auth
- Migration from existing cloud-app schema (`EditMiniApp.tsx` etc.)
- Dev portal MVP (upload, channels, crash dashboard, engagement
  metrics, signing key UI, permission diff preview, CI/CD endpoint)

That's its own work track and its own spec — not part of this one.

### Migration path for existing miniapps

Greenfield from the SDK's perspective — there's no shipping
installed base on the new SDK yet. Two miniapps live in this repo:

- **`sdk/example-miniapp/`** — the canonical fixture. Rewrite in
  Phase 5 per Appendix A; this rewrite is the integration
  acceptance gate for the entire architecture.
- **`sdk/Navigation/`** — a serious second miniapp (Google Maps,
  Places, multi-page React UI, ~3,000 LoC). **Out of scope for the
  refactor itself** — see "Out-of-scope: porting `sdk/Navigation/`"
  below. The SDK calls Nav consumes (`session.navigation.*`,
  `session.heading.*`, `location_stream` rates, pivots,
  `computeRoute`) ARE in scope — Phase 1's dispatcher routes them
  through the same `RuntimeHooks.navigation` adapter that
  `LocalMiniappRuntime` uses today.

No compatibility shims, no auto-migration command, no legacy
single-bundle support. The `EditMiniApp.tsx` flow in console
targets cloud miniapps (server-hosted), which is a separate product
not affected by this architecture change.

### Out-of-scope: porting `sdk/Navigation/`

The Navigation miniapp is a real consumer of the SDK and will need
its own two-layer port — but **not as part of this refactor**.
Reasoning:

- The example miniapp is the integration gate. If both halves of
  the architecture work for it, they work. Nav doesn't validate
  anything new at the runtime layer.
- Nav is ~3,000 LoC of frontend + 9 managers + Google Maps + Places.
  Porting it adds ~1 engineer-week of calendar risk for no
  architectural payoff.
- Nav's structure is closer to the target shape than the example
  app's — most of its managers are already thin SDK wrappers.
  Whichever patterns Appendix A establishes will apply directly
  when Nav is ported later.

**What Phase 1 still must support for Nav to eventually work:**
- `session.navigation.{start, stop, onUpdate, onRoute, onPivot,
  computeRoute, getSnapshot, getPivots, getActivePivot,
  getUpcomingPivot, requestPermission}` and the dev toggles
  (`simulateDeviation`, `setWrongSidewalkOffset`, `setSkipCrossings`).
- `session.heading.onUpdate`.
- `session.location.getOnce` and `session.location.onUpdate` with
  the rate-bearing `location_stream` form.
- The pivot engine running in the background JSContext (pure TS, no
  DOM — lifts verbatim per the Reuse table above).

All of those are already in the SDK and already routed by
`LocalMiniappRuntime`'s 8 NAVIGATION_* arms + heading sub +
location-rate aggregation. Phase 2's `MentraJSRouter` rewrite
preserves them; Phase 1's dispatcher must route the corresponding
ifaces. Nothing new for the JS runtime — just the same
"`__dispatch` calls the host adapter" pattern.

**When Nav gets ported (post-merge):** follow Appendix A's recipe,
plus three Nav-specific moves:
1. `User` singleton + reactive store moves to `background/User.ts`
   without the React-glue layer; UI side gets `useTripState`,
   `useCoords`, `useHeading` hooks reading pushed snapshots.
2. `GoogleMapsManager`, `ManeuverFormatter`, and `places.ts` stay
   WebView-side (DOM-bound, CSS-bound, fine to keep as ordinary
   browser code).
3. The 919-LoC `NavigationPage.tsx` swaps every `user.navigation.*`
   call for `mentra.send("trip:*", ...)`. The page becomes a pure
   renderer of state pushed from background.

Estimated ~1 engineer-week. Standalone PR after Phase 5 lands.

---

## Appendix A — `sdk/example-miniapp/` migration, file by file

The canonical fixture. Migration here is the acceptance gate for
"the SDK split is real" — if `bun mentra-miniapp dev` from the new
template produces a working two-layer build of this app, the
migration story works. (`sdk/Navigation/` is the only other miniapp
in the repo and is explicitly out of scope for this refactor — see
"Out-of-scope: porting `sdk/Navigation/`" above.) Concrete file map
below.

### Today's structure (single React SPA, runs inside one WebView)

```
sdk/example-miniapp/
├── miniapp.json                    # manifest
├── src/
│   ├── main.tsx                    # entry: instantiates GlassesController, mounts <App/>
│   ├── App.tsx                     # React tree root
│   ├── controller/
│   │   └── GlassesController.ts    # session.* subscriptions, glasses logic (113 LoC)
│   ├── store/
│   │   └── appStore.ts             # zustand store (43 LoC) shared by controller + UI
│   ├── pages/
│   │   ├── Shell.tsx               # nav shell
│   │   ├── CaptionsPage.tsx        # main UI
│   │   └── tester/
│   │       ├── _TesterRow.tsx      # shared row component
│   │       ├── TesterMenu.tsx      # menu of testers
│   │       └── 15 *Page.tsx files  # one per session.* iface (Display, IMU, Input,
│   │                               # Led, Location, Microphone, Permissions, Phone,
│   │                               # Speaker, Storage, System, Transcription,
│   │                               # Translation, Glasses, ComingSoon)
│   ├── ui/                         # shared UI components
│   ├── lib/                        # (empty today)
│   └── styles/, index.css, env.d.ts
```

### Target structure (two-layer)

**Symmetric `background/` and `ui/` folders.** Background gets its
own folder (not a single `background.ts` file at `src/`) so the layout is
consistent and `background/` can grow into multiple files
(managers, helpers, per-domain modules) without restructuring.
The JSContext entry is `background/index.ts`.

```
sdk/example-miniapp/
├── miniapp.json                    # manifest — adds entry{} object,
│                                   #   sdkVersion, minHostVersion fields
├── src/
│   ├── background/                 # NEW — JSContext side
│   │   ├── index.ts                # entry: exports `init(session)` —
│   │   │                           #   runtime calls this once after spawn
│   │   └── controllers/
│   │       └── GlassesController.ts # MOVED from src/controller/ (logic
│   │                               #   layer, instantiated from index.ts)
│   ├── ui/                         # WebView side (folder, as today)
│   │   ├── index.html              # NEW WebView entry
│   │   ├── main.tsx                # WebView entry — mounts <App/>
│   │   ├── App.tsx                 # MOVED from src/App.tsx (unchanged)
│   │   ├── pages/                  # MOVED — same files, new home
│   │   ├── components/             # was src/ui/
│   │   ├── hooks/
│   │   │   └── useChannel.ts       # NEW thin wrapper over `mentra.on/send`
│   │   └── styles/, index.css
│   └── shared/                     # imported by BOTH background/ and ui/
│       ├── channels.ts             # NEW — typed channel registry
│       │                           #   (TS interface for every name on
│       │                           #   `mentra.send`/`session.ui.send`)
│       └── types.ts                # NEW — domain types referenced by both
│                                   #   sides (TranscriptionEvent shape, etc.)
```

**Manifest `entry` object reflects the symmetric layout:**

```json
"entry": {
  "background": "dist/background/index.js",
  "ui": "dist/ui/index.html"
}
```

**Build outputs mirror sources:** `dist/background/index.js`
(plus any chunked imports under `dist/background/`) and
`dist/ui/index.html` + `dist/ui/*` assets. The CLI's two-output
bundler emits one bundle per layer, each rooted at the
corresponding source folder. Imports from `src/shared/` are
inlined into both bundles by the bundler — no runtime sharing
across the JSContext/WebView boundary.

### File-by-file changes

**`src/controller/GlassesController.ts` → `src/background/controllers/GlassesController.ts`.**
Class moves verbatim — already shaped correctly for the new world
(it already documents "Subscriptions are bound to the session
lifetime, NOT to any React component lifecycle" — this is exactly
the JSContext model). Two changes to the class body:

1. Replace `import {useAppStore} from "../store/appStore"` — zustand
   does not cross the JSContext/WebView boundary. State that the UI
   needs is published via `session.ui.send(channel, payload)`.
   The local copy lives only in WebView memory.
2. Where the controller wrote to `appStore`, instead emit a UI
   channel: e.g. `appStore.setTranscript(t)` becomes
   `session.ui.send("transcript", {text: t})`.
3. Where the controller exposed imperative methods that React called
   (e.g. `controller.startCaptions()`), become
   `session.ui.on("startCaptions", () => { ... })` handlers.

**`src/background/index.ts` is NEW** — a tiny entry file:

```typescript
import type {MiniappSession} from "@mentra/miniapp/background"
import {GlassesController} from "./controllers/GlassesController"

export function init(session: MiniappSession): void {
  const controller = new GlassesController(session)
  controller.start()
}
```

The runtime calls `init(session)` once after spawn (via a
`__deliver({event: "init", session})` injection — see the
"Spawn" section). Apps with multiple concerns instantiate multiple
controllers here. This file stays small on purpose; logic lives in
`background/controllers/` (or `background/managers/`,
`background/services/` — whatever the app's domain calls for).

**`src/store/appStore.ts`** — does not move directly. The store is
WebView-side only (zustand mounted in the React tree). The
background side has no `useAppStore`; it owns the canonical state
in plain TS variables and persists via `session.storage`. The
WebView's zustand store is a *cache* of what the background just
sent, hydrated on `mentra.ready()` from a one-shot
`session.ui.send("snapshot", {...})` call.

**`src/main.tsx` → `src/ui/main.tsx`.** Drop the
`new GlassesController(session)` call (background owns it now). New
entry calls `mentra.ready()` and subscribes to `mentra.on(...)` for
each channel. ~15 lines.

**`src/App.tsx`, `src/pages/`, `src/ui/`** — moved under `src/ui/`
unchanged. React tree is identical; only the *source of data*
changes. Replace `useAppStore(s => s.transcript)` with a
`useChannel<TranscriptPayload>("transcript")` hook (new, ~20 LoC,
lives in `src/ui/hooks/useChannel.ts`). The hook reads from the
WebView-local zustand cache that the new entry hydrates from
`mentra.on("transcript", ...)`.

**`src/pages/tester/*Page.tsx` (15 files including `_TesterRow.tsx`
and `TesterMenu.tsx`).** Each tester page today calls `session.*`
directly (per the explicit "tester pages are an exception" comment
at the top of `GlassesController.ts`). After migration, **none of
them can.** Three options per page:

- **(a) Mostly read-only testers** (Permissions, Storage,
  Transcription, IMU, Location, Microphone, System): page sends a
  `mentra.send("tester:start", {iface: "imu"})`; background opens
  the relevant subscription, pipes events back via
  `mentra.send("tester:event", {iface, payload})`. Page renders
  what it sees. ~30 LoC delta per tester.
- **(b) Fire-and-forget testers** (Display, Led, Speaker, Phone):
  page calls `mentra.send("tester:fire", {iface, method, args})`;
  background dispatches to `session[iface][method](...args)`.
  ~10 LoC delta per tester (one shared handler).
- **(c) Pure UI testers** (TesterMenu, _TesterRow, ComingSoon):
  unchanged.

Roll-up estimate: 3 fire-and-forget pages × 10 LoC + 7 read-only
× 30 LoC + 5 unchanged = ~240 LoC of tester-side delta plus a
~50 LoC dispatcher handler in `background/index.ts` (or a
`background/testers.ts` helper imported from `index.ts`).
~2-3 days work
for one engineer.

**`miniapp.json`.** Add fields per the new schema:
```json
{
  "sdkVersion": "0.2.0",
  "minHostVersion": "1.42.0",
  "entry": {
    "background": "dist/background/index.js",
    "ui": "dist/ui/index.html"
  }
}
```
All existing fields kept.

**Build config.** Today's miniapp uses a single bundler config
(likely `vite.config.ts`). Phase 4 of `sdk/miniapp-cli/src/pack.ts`
emits two outputs; the example app gets two `vite.config.*.ts`
files (one for `background`, one for `ui`) or a single config with
`build.lib.entry` mapping. Example template owns the canonical shape.

### Acceptance test for the example-app migration

The migration is "done" when:
1. `bun create mentra-miniapp my-app` produces a scaffold matching
   the target structure above.
2. `bun mentra-miniapp dev` in `sdk/example-miniapp/` builds both
   `dist/background/index.js` and `dist/ui/`, serves over LAN, and the
   QR-code install on a real device:
   - Spawns a JSContext, runs `init(session)`, glasses display
     starts working *before* the user opens the WebView.
   - Opens the WebView via app-tile tap; transcripts flow into the
     WebView's UI in real time.
   - Tester pages all behave identically to today.
3. Background survives going off-screen for >5 minutes (was the
   original jetsam motivation).

---

## Appendix B — SDK + CLI migration checklist

In addition to the example app, these shipped artifacts move:

- **`sdk/create-mentra-miniapp/bin/index.ts` + template** —
  scaffolder; rewrite template per Appendix A target structure.
  ~150 LoC scaffolder logic untouched (clack prompts, validation);
  template files swap. (Phase 5.)
- **`sdk/miniapp-cli/`** — see Phase 4 file list. `dev.ts` evolves to
  orchestrate background bundler + UI bundler + `dev-server.ts`
  WebSocket. (Phase 4.)
- **`@mentra/miniapp` package.json `exports`** — gain
  `./background` and `./ui` sub-paths; the bare `@mentra/miniapp`
  import is removed. Greenfield, no compat shim. (Phase 5.)
- **Docs** (`mintlify-docs/miniapp-*.md` if they exist; `sdk/example-miniapp/
  README.md`; `sdk/miniapp-cli/README.md`): rewrite. (Phase 5 +
  ongoing across phases as APIs stabilize — schedule a doc-update
  line item in each phase that lands a public-surface change.)
- **Tests in `sdk/miniapp-cli/tests/` and `mobile/test/`** — current
  suite asserts single-bundle behavior; rewrite to assert two-output
  bundle. (Phases 3-6 each include test updates for code they touch;
  no separate "tests phase" — tests ship with the code.)

### Could an agent execute this migration end-to-end?

Now: yes — the file mapping is concrete, the channel boundary is
specified, and acceptance criteria are testable. The two judgment
calls an agent will face are:
1. Picking option (a) vs (b) for each tester page — Appendix A
   gives the heuristic ("mostly read-only" vs "fire-and-forget").
2. Whether to keep zustand on the WebView side or replace with
   plain `useState`/context. Either is fine; spec recommends keeping
   zustand purely as a WebView-local cache (no boundary crossing).

---

## Race conditions worth thinking about

### Steady-state UI/background

1. **WebView opens, fires events before background is ready.**
   `mentra.ready()` is required. SDK buffers `mentra.send()` until
   acked. Background never sees pre-ready messages.
2. **Background sends to a WebView mid-close.** `session.ui.isOpen()`
   check; SDK silently drops `session.ui.send()` when no WebView
   bound.
3. **User opens UI, WebView loads, but background is mid-async-init.**
   SDK's `mentra.ready()` retries with exponential backoff until
   acked. Background's `init()` is awaited.
4. **Storage write races with WebView's request-state.** Storage
   operations awaited; reads happen-after-writes inside one async
   function.
5. **Two WebView messages arrive interleaved.** Processed sequentially
   on JSContext's main thread (single-threaded JS).

### Cross-lifecycle (install / spawn / uninstall / kill)

6. **Install-during-spawn.** User installs miniapp B while A's
   spawn is in-flight. Both writes to `MiniappRunningRegistry`
   (Phase 2's "ONE registry") must be serialized — use a single
   mutex around register/unregister, with all reads against the
   same lock. Without it, duplicate spawn or lost registration.
7. **Uninstall-while-WebView-foregrounded.** User uninstalls a
   miniapp whose WebView is currently mounted. Sequence: tear down
   WebView FIRST (synchronous), then kill JS context, then delete
   bundle. In-flight `mentra.send` from a WebView that's gone
   resolves to "no bound JS context"; in-flight native dispatch
   from a JS context that's gone returns the standard `INTERFACE_NOT_FOUND`
   error path with the context's `packageName` already deregistered.
8. **Jetsam during polyfill evaluate.** Host is killed mid-`evaluate`
   of `startup.js` (plausible on SE 2 under memory pressure with
   the polyfill bundle still loading). On-disk state is intact; the
   in-memory `MiniappRunningRegistry` may have a half-written entry.
   Crash recovery (Phase 6 state machine) **must handle "registry
   says running, no JS context exists"** — treat as a pseudo-crash,
   transition through CRASHED → respawn.
9. **Two host events fire concurrently into the same JS context.**
   `Crust.dispatchToJs(packageName, channelA, ...)` and
   `dispatchToJs(packageName, channelB, ...)` from different RN
   threads. The native dispatcher must serialize per-context (one
   thread per JS context already enforces this on iOS via
   `DispatchQueue`, on Android via Zipline's per-instance
   single-thread dispatcher requirement).
10. **Permission revocation during in-flight call.** User revokes
    `MICROPHONE` permission while miniapp has a pending audio request.
    The host's permission gate is checked at dispatch time; the
    in-flight call may already be past the gate. Mid-call revocation
    is best-effort: the next dispatch fails with `PERMISSION_DENIED`,
    but the current operation completes. Document this; don't
    promise hard cutoff.

---

## Open questions

Every entry below has a parked answer. Nothing here is blocking
this spec's implementation — the items get revisited later when
the right data shows up.

1. **CPU/memory quotas per miniapp?** Neither JSC nor QuickJS ships
   built-in quotas. We could add a watchdog in the dispatcher
   (`JSContextGroupSetExecutionTimeLimit` on iOS-JSC,
   `JS_SetInterruptHandler` on QuickJS) that aborts a miniapp
   blocking the JS thread for >N seconds. **Decision: defer until
   it bites.** Don't build now.
2. **Multiple simultaneous WebViews?** **One WebView at a time.**
   The product is "user looks at one miniapp's settings at a time."
   Not negotiable in V1.
3. **Notification scheduling from the WebView?** **All scheduling
   goes through background.** WebView never schedules anything
   directly — same as every other native API.
4. **What does the JS context do during the iOS suspension window?**
   In principle, JS pauses with the host process and resumes
   mid-task on wake; `setInterval` callbacks fire irregularly
   during suspension. **In practice we don't hit this path:** when
   glasses are connected we hold the `bluetooth-central` background
   mode, which keeps the host process alive and JSContexts
   continuously running. Suspension is a theoretical edge case for
   the "no glasses connected, app backgrounded" scenario, which
   is also when nothing important is happening. Document the
   theoretical behavior; don't engineer around it.
5. **Bridge contract versioning.** Every `miniapp.json` declares
   `sdkVersion`. Host refuses to spawn miniapps targeting an SDK
   version it doesn't support. **Decision: out of scope for now.**
   The policy details (what counts as a breaking change, semver
   vs marketing-version, etc.) get figured out later — there's no
   external developer base and no store yet, so nothing forces the
   call.
6. **Should the SDK provide a typed RPC helper over the UI bus?**
   The raw bus today is `mentra.send(channel, payload)` +
   `session.ui.on(channel, cb)` with a `shared/channels.ts` registry
   for types. Authors who want request/response semantics
   re-implement the correlation by hand. **Decision: keep the raw
   bus for now (option A).** Revisit later if the same boilerplate
   shows up across multiple miniapps.

---

## Success criteria

**Hard gates (CI / acceptance-gate enforced):**
- `sdk/example-miniapp/` runs end-to-end on the new architecture
  per Appendix A — the integration acceptance gate for Phase 5.
- Pass App Store review with the new architecture (binary outcome;
  no plan B, but the architecture is explicitly designed against
  Apple Guideline 2.5.2 / 4.7).

**Aspirational targets (measure and report; not blocking):**
- 10+ miniapps run simultaneously in background on iPhone SE 2
  (3 GB RAM) without jetsam — Phase 1 measures with realistic
  miniapp workloads (existing 50-context spike used a stub
  workload).
- 10+ miniapps run simultaneously in background on a low-end Android
  device (e.g. Pixel 4a, 6 GB RAM) without LMK — to be measured in
  Phase 1 alongside the iOS number.
- WebView open-to-render latency: **measured in Phase 3 acceptance
  gate**, no preset budget. The earlier "<500ms p95" was a guess;
  set the budget after measurement, not before.
- `bun create mentra-miniapp` to a working miniapp in under 30
  minutes for an experienced web dev (smoke-tested by an outside
  developer at the end of Phase 5; not CI-measurable).
