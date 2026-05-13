# MentraJS — Two-Layer Local Miniapp Architecture

**Status:** Proposed
**Authors:** Alex Israelov + Claude

A spec for moving the local miniapp SDK from a persistent-WebView model
to a JavaScriptCore-per-miniapp background runtime + on-demand WebView
for UI. Most of the existing SDK (~49% of LoC) lifts unchanged. The
new pieces are bounded: a Swift JSContext runtime in the existing
`crust` module (and a Kotlin/JNI mirror on Android), a `__dispatch`
bridge, a polyfill bundle, and a WebView-↔-JSContext message bus.

**See also:**
- **Appendix A** — file-by-file migration of `sdk/example-miniapp/`,
  the canonical fixture and acceptance gate.
- **Appendix B** — SDK + CLI migration checklist.

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

1. **Background layer (MentraJS)** — a `JSContext` (Apple's
   JavaScriptCore framework), one per installed miniapp, **always
   running** while the host app process is alive. ~3-5 MB resident
   per context. No DOM, no rendering. Owns all glasses logic.
2. **UI layer (MentraUI)** — a `WKWebView` spawned **on demand**
   when the user opens the miniapp's settings screen. Destroyed
   when they navigate away. Standard HTML/CSS/JS, full DOM. **Has
   zero direct native access** — only talks to its own background
   layer via a typed message bus.

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
│   │ JSContext A         │         │ JSContext B         │        │
│   │ (always alive)      │         │ (always alive)      │        │
│   │  __dispatch         │         │  __dispatch         │        │
│   │  polyfills          │         │  polyfills          │        │
│   │  background.js      │         │  background.js      │        │
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

## Engine choice: native JavaScriptCore

Background JS runs in a native iOS `JSContext` from
`JavaScriptCore.framework`, with its own `JSVirtualMachine` per
miniapp for heap isolation. **Not Hermes. Not React Native's runtime.
Not a JSI library. Not a hidden WebView.**

### Why JSC specifically

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

### Cross-platform: JSC on Android, with JNI work

We bundle JavaScriptCore on Android so the same engine runs miniapp
JS on both platforms. Performance gap vs Hermes/V8 is irrelevant for
our workload — heavy work is in native modules; miniapp JS is
event-handler-tier.

**Android JSC binary source:**
`io.github.react-native-community:jsc-android:2026004.+` — the
maintained successor to the original Facebook `org.webkit:android-jsc`
(last published 2015) and the artifact already used in
`mobile/android/app/build.gradle` for the host RN bundle. We pin to
the same version coordinate so we don't ship two JSC builds. Adds
~5-7 MB to the Android binary (already paid by the host app).

**Critical Android caveat:** `jsc-android` ships as **prebuilt `.so`
files** for arm64-v8a / armeabi-v7a / x86_64 / x86. There is **no
Java / Kotlin API** equivalent to iOS's `JSContext` Swift class.
Calling JSC from Kotlin requires JNI glue. Three options:

- **(A) Write our own JNI wrapper** over the JSC C API exposed by
  `jsc-android` headers. Full control, ~2-3 weeks NDK work for the
  surface we need (create context / virtual machine / inject
  function / evaluateScript / set+get globals). C++ bridge code in
  `crust/android/src/main/cpp/`, bound to Kotlin via JNI.
- **(B) Vendor LiquidCore** (MIT, last released ~2019, stale but
  functional). Provides a Java API over JSC very close to iOS's
  Swift surface. Requires audit + likely forking to update for
  modern Android.
- **(C) Defer Android to a later phase**, ship iOS-only at GA.
  Honest if we're resource-constrained.

**Recommendation: option A (own JNI wrapper).** LiquidCore's staleness
makes it a long-term liability, and the surface we need is small
enough (~6 native methods) that hand-rolling JNI is bounded work.

**Android implementation lives alongside the iOS one in `crust`:**

```
mobile/modules/crust/android/src/main/
├── java/com/mentra/crust/
│   ├── CrustModule.kt                  # existing — add JSC Functions
│   ├── jsc/JSCRuntime.kt               # NEW: owns N JSContext handles
│   ├── jsc/JSCDispatcher.kt            # NEW: __dispatch routes
│   └── jsc/JSCPolyfillBridge.kt        # NEW: native fetch/WS/timers/storage/crypto
└── cpp/                                # NEW JNI layer
    ├── CMakeLists.txt
    ├── jsc_jni.cpp                     # JNI ↔ JSC C API
    └── jsc_jni.h
```

The polyfill bundle (`mobile/modules/mentrajs-runtime/runtime/`) is
**identical JS for both platforms**. Native bridge hooks differ
under the hood (`URLSession` vs OkHttp, `NSUserDefaults` vs
SharedPreferences, `CryptoKit` vs `javax.crypto`) but JS-side API
is one shape.

**Android-specific risks:**
- JNI surface adds C++ to a previously Kotlin/Swift-only repo;
  team needs an engineer comfortable with NDK builds and JSC C API.
- Bundle size concern: ~5-7 MB binary growth, but already paid by
  host RN — adding `crust`'s JNI lib is a few hundred KB on top.
- No Safari Web Inspector equivalent on Android JSC. We can wire
  Chrome DevTools' V8 protocol over WebSocket later if needed —
  defer.

**Android JSC sequencing:** because of the JNI work, Android takes
**3-5 weeks**, not 1. iOS Phase 1 ships first (~3 weeks); Android
JSC follows (~3-5 weeks). Either accept Android lagging by a phase
or budget two engineers in parallel from Phase 1.

### Memory profile: measured, not estimated

Real-device benchmark on iPhone 15 release build, 50 idle JSContexts
each running a representative workload (timer + 100-entry state +
`__dispatch` stub):

| Wave | Contexts | Resident MB | MB per context |
|---|---|---|---|
| 1 | 1 | 1020 → 1022 | 1.16 |
| 2 | 5 | 1022 → 1024 | 0.70 |
| 3 | 10 | 1024 → 1028 | 0.72 |
| 4 | 25 | 1028 → 1039 | 0.75 |
| 5 | 50 | 1039 → 1058 | 0.75 |

**~0.75 MB per JSContext at rest. Linear scaling.** With realistic
fetch/WebSocket shims holding NSURLSession instances, budget ~3-5 MB
per context. Even on iPhone SE 2 (3 GB RAM, ~600 MB jetsam ceiling),
50+ background miniapps fit comfortably.

Raw log: `agents/spike-results/jsc-spike-iphone15-release-50ctx.log`.
Reproducible via `xcrun devicectl device process launch -e
'{"MENTRA_RUN_JSC_BENCH":"1"}' com.mentra.mentra` then
`xcrun devicectl device copy from --domain-type appDataContainer
--domain-identifier com.mentra.mentra --source Documents/jsc-spike.log`.

---

## Where the native code lives

**Inside the existing `crust` Expo module.** `crust` already owns the
iOS/Android native interface for the SDK — adding a JSC runtime is a
few hundred lines of Swift in there. Don't fragment the module set.

```
mobile/modules/crust/
├── ios/
│   ├── CrustModule.swift              # existing — add JSC Functions here
│   ├── Source/JSCRuntime.swift        # NEW: owns N JSContexts keyed by id
│   ├── Source/JSCDispatcher.swift     # NEW: __dispatch routes
│   ├── Source/JSCPolyfillBridge.swift # NEW: native handlers for fetch/WS/timers/storage/crypto
│   └── ... existing crust files
├── android/                           # parallel Kotlin structure
└── src/CrustModule.ts                 # TS types for spawn/evaluate/kill
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
2. **Per-miniapp JSContext** (native iOS JSC / Android JSC, one
   per installed miniapp). Runs the miniapp's `background.js`.
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
  in the miniapp's background.js
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

**Two key properties to notice:**
1. **The host RN runtime is always in the middle.** It's the only
   place where messages from JSContexts and WebViews can be
   correlated and routed. JSContexts and WebViews never talk to
   each other directly.
2. **All three flows use Expo Module events / function calls as the
   transport between native and RN.** No custom IPC. Same plumbing
   we use for every other native module in the app.

The cost of this architecture: every cross-runtime hop has at least
one JSON serialize/deserialize. Acceptable for our message shape
(small JSON payloads, no streaming binary data — those go through
specialized native paths like `mic_pcm`).

### Spawn order

When `spawn(id, polyfillPath, miniappPath)` is called:

1. Create `JSVirtualMachine` + `JSContext` on a dedicated thread.
2. Set `context.name = "MentraJS: <id>"` and (DEBUG-only)
   `isInspectable = true` (gated on iOS 16.4+).
3. Inject `__dispatch` as a single Swift block on the context's
   global. Per Pebble's `CrashReproducer.kt`, never bind individual
   native callbacks as JSValue properties — JSC's GC races and
   crashes. **One C-callable function only.**
4. Inject `__hostLog`, `__hostError`, `__hostUnhandledRejection`
   for the polyfill's `console.*` and error rewires.
5. Wrap eval in `evalCatching`. Run the polyfill bundle (`startup.js`).
   Installs `setTimeout`/`fetch`/`WebSocket`/`localStorage`/etc on
   `globalThis`.
6. Inject the SDK shim (`@mentra/miniapp/background` typed wrappers around
   `__dispatch` exposing the existing `session.*` API surface).
7. Run the miniapp's `background.js`. Top-level code executes in
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
We do NOT redesign it. The 17 module wrappers (`session.glasses`,
`session.display`, `session.input`, `session.transcription`,
`session.translation`, `session.mic`, `session.speaker`,
`session.camera`, `session.dashboard`, `session.led`,
`session.location`, `session.imu`, `session.phone`,
`session.permissions`, `session.storage`, `session.stream`,
`session.system`) all wrap a constructor-injected `session` and call
`session.sendOneShot` / `session.sendRequest` / `session._subscribe`.
Transport-agnostic.

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

---

## Source layout for a miniapp

```
my-notes-miniapp/
├── miniapp.json               # manifest (existing schema, with additions)
├── package.json
├── tsconfig.json
├── src/
│   ├── background.ts          # MentraJS entrypoint — always running
│   ├── ui/
│   │   ├── index.html         # WebView entrypoint
│   │   ├── index.tsx          # WebView code (React or vanilla)
│   │   └── styles.css
│   └── shared/
│       └── channels.ts        # message channel typings, shared
├── icon.png                   # 512x512
└── dist/                      # output of `bun run build`
    ├── background.js
    └── ui/
        ├── index.html
        ├── index.js
        └── styles.css
```

`miniapp.json` (existing schema + new fields, `packageName` not `id`):

```json
{
  "$schema": "./node_modules/@mentra/miniapp-cli/schema/miniapp.schema.json",
  "packageName": "com.alex.notes",
  "version": "1.0.0",
  "name": "Notes",
  "description": "Voice-driven note taking",
  "icon": "icon.png",
  "sdkVersion": "^3.0.0",
  "minHostVersion": "2.3.0",
  "type": "standard",
  "entry": {
    "background": "dist/background.js",
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

`src/background.ts` — uses the existing SDK API:

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

About **half** of the existing local-miniapp SDK code (~5,500 of
~11,300 LoC) lifts into the new architecture with zero or near-zero
changes. Another ~3,000 LoC keeps its shape and gets new internals.
Only ~2,800 LoC is genuinely replaced. **This is mostly a
refactor + add, not a rewrite.**

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
| `mobile/modules/miniapp/src/transport/types.ts` | 26 | Transport interface fits `__dispatch` |
| `mobile/modules/island/src/services/MicStateCoordinator.ts` | 113 | No WebView |
| `mobile/modules/island/src/services/LocalSttFallbackCoordinator.ts` | 98 | No WebView |
| `mobile/modules/island/src/services/LocalDisplayManager.ts` | 538 | Per-app display arbitration keyed on `packageName` |
| `mobile/modules/island/src/services/DisplayProcessor.ts` | 714 | Pure compute |
| `mobile/modules/island/src/services/MiniappRunningRegistry.ts` | 63 | Just update writers |

**~3,000 LoC of typed API surface and infrastructure that survives
unchanged.**

### Reuse with minor changes

| File | LoC | Change needed |
|---|---|---|
| `mobile/modules/miniapp/src/session.ts` | 612 | Drop `createTransport()` autodetection; constructor-inject `DispatchTransport`. Keep queue-before-ACK, request/response correlation, permission cache, speaker state machine. |
| `mobile/modules/miniapp/src/modules/events.ts` | 208 | Move with `session.ts`; refcounted SUBSCRIBE machinery is pure logic. |
| `mobile/modules/miniapp/src/transport/mock.ts` | 208 | Stays for browser-tab dev path. |
| `mobile/modules/miniapp/src/transport/local-socket.ts` | 93 | Same. |
| `mobile/modules/miniapp/src/transport/auto.ts` | 125 | Add 4th branch: if `__dispatch` global → return `DispatchTransport`. |
| `mobile/modules/miniapp/src/dev-reload.ts` | 60 | Keep for WebView; add sibling for JSContext respawn. |
| `mobile/modules/island/src/services/DevServerBridge.ts` | 288 | Same protocol, two delivery sinks (WebView reload + JSContext respawn). |
| `sdk/miniapp-cli/src/manifest*.ts` (4 non-test files) | ~712 | Add `sdkVersion`, `minHostVersion`, `entry` (object) schema fields. (Signature schema deferred to store-ship spec.) |
| `sdk/miniapp-cli/src/dev.ts` + `dev-server.ts` | ~480 | Bundle `dist/background.js` + `dist/ui/`; add `{type:"respawn-bg"}` message alongside `{type:"reload"}`. Drop today's `user-server.ts` spawning — there's no longer a separate Express server fronting the WebView. |
| `sdk/miniapp-cli/src/pack.ts` + `release.ts` | ~380 | Two-output bundle. (Signing pipeline deferred to store-ship spec.) |

### Reuse with major changes (right shape, internals rewritten)

| File | LoC | What survives, what changes |
|---|---|---|
| `mobile/modules/island/src/services/LocalMiniappRuntime.ts` | 1,752 | **Skeleton survives:** per-app registry, refcounted streams, ping loop, **25 dispatch arms** (21 explicit `handle*` private methods + 4 inline arms in the type switch — covers CONNECT, SUBSCRIBE, DISPLAY, PLAY_AUDIO, SPEAK, RGB_LED, LOCATION_POLL, STORAGE_*, CAMERA_FOV, SHARE, OPEN_URL, COPY_CLIPBOARD, DOWNLOAD, PHOTO, STREAM_*, MANAGED_STREAM_*, PING/PONG). Handler bodies don't know they're talking to a WebView — they take `(packageName, payload)` and dispatch to native. **Rewrite:** front door (`handleRawMessage` → `__dispatch`); per-app `sendMessage` (postMessage → `JSContext.evaluateScript`); HMAC/local-token code goes away. |
| `mobile/modules/island/src/services/AppRegistry.ts` | 675 | Manifest normalization + zip pipeline survive. **Add:** `background.js` discovery alongside `index.html`; recognize new manifest fields; sdkVersion/minHostVersion compatibility check on spawn. (Signature verification deferred to store-ship spec — all current bundles are LAN-sideloaded and unsigned.) |
| `sdk/create-mentra-miniapp/bin/index.ts` + template | ~150 + template | Scaffolder logic survives (clack prompts, validation, template substitution). **Template files rewrite:** scaffold `src/background.ts`, `src/ui/`, `src/shared/channels.ts` instead of single React SPA. |

### Replace entirely

| File | LoC | Why |
|---|---|---|
| `mobile/modules/miniapp/src/transport/postmessage.ts` | 95 | Hard-coded to `window.ReactNativeWebView`. Repurpose as `WebViewToJsContextTransport` for the settings WebView. |
| `mobile/modules/island/src/services/WebviewBridge.ts` | 50 | Replaced by two sibling routers: `MentraJSRouter` (JSContext fan-out) + `MentraUIRouter` (settings WebView ↔ bound JSContext). |
| `mobile/modules/miniapp/src/globals.ts` | 62 | `window.MentraOS` is WebView-presentational. Keep file for WebView; JSContext gets a different injected globals object. |
| `mobile/modules/miniapp/src/index.ts` | 108 | Replaced by two sub-path entry points via `package.json` `exports`: `@mentra/miniapp/background` (session API for the JSContext layer) and `@mentra/miniapp/ui` (WebView-side `mentra` global + React hooks). No bare `@mentra/miniapp` import — sub-paths only. |
| `sdk/example-miniapp/` | (entire React SPA) | Restructure into two-layer: logic into `src/background.ts`, UI into `src/ui/`. Existing React code is reusable as the basis for the UI half. |

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
- **`JSCRuntime.kt`** + JNI wrapper — see the "Cross-platform: JSC
  on Android, with JNI work" section above for the `cpp/` JNI layer.
- **`JSCDispatcher.kt`** — Kotlin mirror of Swift dispatcher.
- **`JSCPolyfillBridge.kt`** — OkHttp / SharedPreferences / javax.crypto
  backed equivalents.
- **`PermissionStore`** — SQLite via Android's built-in
  `SQLiteOpenHelper`. Same schema as iOS.
- **Device-tier eviction** — `ActivityManager.getMemoryInfo()` for
  the equivalent of `physicalMemory`.

React Native UI (cross-platform TS/TSX, in `mobile/src/components/miniapp/`):
- **WebView host refactor** — `MiniappHost.tsx` (627 LoC today) shifts
  from "persistent off-screen WebViews" to "spawn cold per open,
  destroy on exit" for the UI layer. Existing `mount/unmount/
  setForeground/setBackground` API is kept; semantics inverted.
  **One file serves both iOS and Android** — `react-native-webview`
  abstracts WKWebView vs Android WebView underneath; the same
  `injectedJavaScriptBeforeContentLoaded` + `postMessage` surface
  works on both platforms. No platform-conditional branches needed
  in this layer.
- **`MentraUIRouter`** — when WebView mounts, host binds it to a
  JSContext and routes `mentra.send`/`mentra.on` between them. We
  use `react-native-webview`'s `injectedJavaScriptBeforeContentLoaded`
  + `postMessage`, NOT raw `WKUserScript` (which RN-WebView doesn't
  expose). Behavior matches Pebble's native bridge but layered on top
  of `react-native-webview`.

JS (host RN runtime, in `mobile/modules/island/src/services/`):
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
  (existing `permissions.ts:17–19` explicitly defers `request()` —
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
  `release.ts` — emit `dist/background.js` + `dist/ui/`.
- **`{type:"respawn-bg"}` message type** in `dev-server.ts`
  alongside existing `{type:"reload"}`.

**Cloud:** none for V1. The CLI's `bun mentra-miniapp release`
serves bundles over LAN HTTP + QR (already implemented). Mobile
fetches from the developer's laptop. No store, no signing pipeline,
no kill switch, no dev portal — those return when we ship the
store later (separate spec).

---

## Polyfill strategy

JSContext is a bare ECMAScript runtime. Workers-in-WebView would get
fetch/WebSocket/IndexedDB/crypto for free; we don't. **About half the
polyfills are drop-in MIT libraries** — the other half are thin
bridges to native I/O.

| API | Strategy | Library / source | Custom LoC |
|---|---|---|---|
| `console.*` | **Drop-in MIT** | `@react-native/js-polyfills/console.js` | ~10 (logging hook) |
| `TextEncoder` / `TextDecoder` | **Drop-in MIT** | `fast-text-encoding` (3 KB) | 0 |
| `URL` / `URLSearchParams` | **Drop-in MIT** | `whatwg-url-without-unicode` (40 KB) | 0 |
| `atob` / `btoa` | **Drop-in MIT** | `base-64` (3 KB) | 0 |
| `EventTarget` / `addEventListener` | **Drop-in MIT** | `event-target-shim` (5 KB) | 0 |
| `Blob` / `FormData` | **Drop-in + glue** | `fetch-blob` + `formdata-polyfill` | ~30 |
| `AbortController` / `AbortSignal` | **Drop-in + glue** | `abort-controller` | ~20 |
| `Promise` | Built-in | (modern JSC has Promises) | 0 |
| `setTimeout` / `setInterval` / `clear*` | Bridge | — | ~80 |
| `Headers` / `Request` / `Response` | **Lift from whatwg-fetch (MIT)** | swap XHR core for native | ~100 |
| `fetch` network plane | Bridge | atop the Headers/Request/Response above | ~150 over `URLSession` |
| `WebSocket` | Bridge | uses `event-target-shim` | ~150 over `URLSessionWebSocketTask` |
| `localStorage` | Bridge | — | ~50 over `NSUserDefaults` with `"MentraJS-{appId}"` suite |
| `crypto.subtle` (SHA, AES-GCM, HMAC, X25519) | Bridge | — | ~300 over `CryptoKit` |
| `crypto.getRandomValues` | Bridge | — | ~30 over `SecRandomCopyBytes` |
| `crypto.randomUUID` | Pure-JS shim atop `getRandomValues` | RFC 4122 v4 (~10 lines) | ~10 |

**Total custom code: ~1000 LoC JS + ~600 LoC Swift, ~2-3 weeks.**

Android counterparts: same JS shims; native swap is `OkHttp` for
fetch/WebSocket, `SharedPreferences` for `localStorage`,
`javax.crypto` for `crypto.subtle`, `SecureRandom.nextBytes` for
`crypto.getRandomValues`. Same total LoC, +~600 Kotlin.

### Out of scope (don't polyfill at v1)

- `IndexedDB` — complex; SDK's `session.storage` covers structured needs via SQLite native.
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
2. Host spawns a `JSContext` via `JSCRuntime.spawn(packageName,
   polyfillBundle, dist/background.js)`. JSContext now alive.
3. Background's `init(session)` runs (typically: hydrate state from
   `session.storage`, register listeners).

When the store ships later: bundle download URL changes from "LAN
HTTP from dev laptop" to "signed R2 URL minted by cloud," and
signature verification kicks in. Same install flow otherwise.

### User opens the miniapp's UI

1. Host navigates to the miniapp UI route (e.g.
   `/applet/<packageName>/ui`).
2. Host spawns a fresh `WKWebView`.
3. Host installs the WebView's user script (`window.mentra` shim
   pointing at `webkit.messageHandlers.mentra`).
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

### Host app backgrounded by user (screen off, in pocket)

1. iOS may or may not suspend the host process — depends on whether
   we hold a `bluetooth-central` background mode (we do) and have an
   active BLE session (we do, while glasses are connected).
2. As long as host process is alive, all JSContexts continue running.
3. WebViews are already destroyed (user navigated away).
4. Background JS receives glasses events normally via the BLE bridge,
   processes them, calls `session.display.*` etc.

This is the steady-state production scenario.

### iOS jetsams the host app

1. All JSContexts die.
2. On next launch, host re-spawns each installed-and-enabled
   miniapp's JSContext.
3. Each miniapp's `background.ts` re-runs from scratch, hydrating
   from `session.storage`.

**`session.storage` is the source of truth, not in-memory state.**
Same lesson Chrome MV3 service workers had to teach.

### Miniapp disabled by user

1. Host calls `JSCRuntime.kill(packageName)`.
2. Marks miniapp inactive in installed-apps state.
3. In-memory state is gone. Storage remains until uninstall.

### Miniapp uninstalled

1. Kill JSContext.
2. Remove bundle files from app sandbox.
3. Drop `session.storage` namespace for that miniapp (with user
   confirmation).

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

The existing `AppPermissionType` enum in `mobile/modules/island/src/types/applet.ts`:

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

1. **Manifest validation at install.** Reject malformed `permissions[]`.
   Persist granted set in **SQLite** keyed by `packageName` (not
   NSUserDefaults — needs a real security boundary).
2. **Swift `__dispatch` handler — the authoritative gate.** Every
   JSContext is tagged with its `packageName` at creation.
   `__dispatch(iface, method, args)` looks up
   `PermissionStore.granted(packageName, iface)` BEFORE invoking the
   native API.
3. **JS shim — purely ergonomic.** `session.permissions.query(...)`
   returns `granted | denied | prompt`. Devs call this to avoid
   silent rejections; must NOT be the only check (a malicious
   miniapp could bypass and call `__dispatch` directly).

### Unpermitted call returns

The existing SDK already defines a `PERMISSION_NOT_DECLARED` error
code in `mobile/modules/miniapp/src/protocol.ts:172` (sugar accessor
in `modules/permissions.ts:67-77`) —
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
dist/background.js            # background entry (required)
dist/ui/index.html            # UI entry (required)
dist/ui/index.js              # UI bundle
dist/ui/styles.css            # UI styles
META-INF/                     # added by cloud at publish
  manifest.sha256             # tree hash of all non-META-INF files
  signature.ed25519           # detached sig over manifest.sha256
  signing-cert.json           # signer keyid + expiry
```

`META-INF/` is added by the cloud at publish time, not the developer's
CLI. Same as Chrome Web Store CRX2/CRX3.

### Signing

Two-key system, store-only signing. The platform key
(`mentra-platform-ed25519`) is held by cloud, signs every store
bundle. Developers don't hold signing keys — identity bound at upload
via API key. Same as App Store / Play Store. Different from Pebble
(Pebble didn't sign PBWs).

### Verification on device

After unzip:
1. Read `META-INF/manifest.sha256` and `META-INF/signature.ed25519`.
2. Recompute tree hash over all non-META-INF files (sorted by path,
   deterministic).
3. Verify Ed25519 sig against pinned platform pubkey (bundled in host
   app, with one fallback rotation key).
4. Mismatch → throw `SIGNATURE_INVALID`, delete unzip, surface as
   *"This mini app failed integrity check."*

Sideloaded and dev bundles are unsigned; verification only runs when
bundle came from store install path.

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
2. If running: stop JSContext.
3. Delete `lmas/<packageName>/`.
4. If user opted to delete data: delete the app's `session.storage`
   namespace (NSUserDefaults `MentraJS-<packageName>` suite).
5. Revoke permissions; remove from local cache.

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

`setInspectable = true` is the killer DX feature. Gate on iOS 16.4+
AND a runtime developer-mode flag — *off* in App Store builds even on
iOS 16.4+. Each context named `MentraJS: <appName> (<packageName>)`
so Safari Develop menu lists them sensibly.

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

## Pieces inherited from Pebble (do not skip)

A deep read of `coredevices/mobileapp` revealed several "small" things
that aren't optional. They are how PKJS doesn't crash in production.
Reference-only (GPL-3.0); we re-implement.

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
with a bounded timeout (Pebble: 6s), NACKs on timeout. We use 6s.

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
  a real test suite.

**Android:** explicitly out of scope for Phase 0. Android doesn't
hit the same jetsam wall — multiple WebViews share one renderer
process. We don't need eviction there until usage shows we do.

### Phase 1 — JSC runtime in `crust` (~3 weeks iOS, +3-5 weeks Android)

**Goal:** Spawn N JSContexts from Swift (and from Kotlin via JNI),
route `__dispatch` to existing native services, get a "hello world"
miniapp displaying text on glasses without WebView.

**iOS-first.** Android lags because of the JNI work — see "Cross-platform:
JSC on Android, with JNI work" earlier. Phase 2-6 below assume iOS is
the leading edge; each phase notes any Android-specific work.

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
- Pebble-inherited pieces all in scope: `JSManagedValue`,
  `evalCatching`, `console.*` rewiring, `window.onerror` /
  `onunhandledrejection`, `signalReady` with 6s NACK timeout,
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

Native (Kotlin + C++):
- New `cpp/` directory under `mobile/modules/crust/android/src/main/`
  with `jsc_jni.cpp` + `jsc_jni.h` + `CMakeLists.txt`. Wraps the JSC
  C API exposed by `io.github.react-native-community:jsc-android` —
  ~6 native methods (createContext, evaluate, set/get global, dispose).
  ~2-3 weeks NDK work; engineer needs JSC C API + JNI familiarity.
- New Kotlin files in `mobile/modules/crust/android/src/main/java/com/mentra/crust/`:
  `jsc/JSCRuntime.kt`, `jsc/JSCDispatcher.kt`, `jsc/JSCPolyfillBridge.kt`.
  ~600-800 LoC. Mirrors the Swift surface 1:1 over the JNI wrapper.
- Add the same Expo Functions to `CrustModule.kt`. Verify
  `bun expo prebuild` regenerates the Gradle config including the
  CMake step (no `--clean`).
- Bridge concretes: OkHttp (fetch/WebSocket), `Handler.postDelayed`
  (setTimeout), SharedPreferences (`localStorage` with
  `MentraJS-{packageName}` name), `javax.crypto` + `SecureRandom`
  (crypto.subtle / getRandomValues).
- Same Pebble-inherited pieces apply on Android: stable token,
  log redaction, single `__dispatch` (binding individual native
  functions hits the same JSC GC race), tear-down ordering.

JS:
- New `DispatchTransport.ts` in
  `mobile/modules/miniapp/src/transport/`. Add 4th branch to
  `auto.ts` (currently has 3: PostMessage, Mock,
  LocalSocketWithMockFallback).

Tests:
- Snapshot tests for the polyfill bundle output.
- Smoke tests for `mentraJsSpawn`/`mentraJsKill` lifecycle.
- E2E test: hello-world miniapp installs, JSContext spawns,
  `session.display.showTextWall("hi")`, glasses display it.

**Android sequencing within Phase 1.** iOS first to prove the
architecture (~2 weeks), then port to Android (~1 week given
the shape is identical). The ~3-week Phase 1 budget covers both.
If iOS surfaces architectural issues, Android port slips a phase;
otherwise it ships in Phase 1. Don't ship the SDK as iOS-only.

### Phase 2 — Refactor `LocalMiniappRuntime` → `MentraJSRouter` (~3 weeks)

**Goal:** All ~24 request handlers from `LocalMiniappRuntime.ts`
survive, front door swaps from postMessage to `__dispatch`.

- Move ~24 `private handle*` bodies (currently
  `LocalMiniappRuntime.ts:612–1714`: handleConnect, handleSubscribe,
  handleDisplay, handlePlayAudio, handleStopAudio, handleSpeak,
  handleRgbLed, handleLocationPoll, handleStorage{Get,Set,Delete,List},
  handleCameraFov, handleShare, handleOpenUrl, handleCopyClipboard,
  handleDownload, handlePhoto, handleStream{Start,Stop},
  handleManagedStream{Start,Stop}, handlePong, plus inlined PING and
  stub DASHBOARD_CONTENT_UPDATE) to a new `MentraJSRouter` class
  taking `(packageName, payload)` from `__dispatch` events.
- Front door: replace `handleRawMessage(packageName, raw)` (current
  signature at `LocalMiniappRuntime.ts:474`) with the new
  `__dispatch`-driven entry point.
- Per-app `sendMessage` (currently `app.sendMessage(serialized)` at
  `LocalMiniappRuntime.ts:1626`, registered in `registerApp()` at
  `:379-408`, wired in `MiniappHost.tsx:136-140` via
  `webview.injectJavaScript("window.receiveNativeMessage(...)")`)
  becomes `JSCRuntime.dispatchToJs(...)`.
- **Cloud message routing:** preserve `handleCloudMessage(msg)` at
  `LocalMiniappRuntime.ts:284` — it routes cloud-relayed responses
  (`phone_photo_ready`, `phone_stream_status`,
  `phone_managed_stream_status`) via the `pendingCloudRequests` Map.
  This is a separate inbound path the spec didn't initially flag.
- **Collapse parallel registries:** today
  `WebviewBridge.setWebViewMessageHandler` (`WebviewBridge.ts:30`)
  and `MiniappHost.tsx:483` maintain a parallel registry on top of
  `LocalMiniappRuntime`'s own. New router has ONE registry.
- **Carry forward** infrastructure that's not a handler but lives
  in this file: `dev_log` console-tap (`:498-512`), stream fan-out
  subscribers (`streamSubscribers` Map at `:160`),
  `recomputeMicRequirements`, `updateCloudSubscriptions`,
  `installedManifest` permission gating (`:671-687`),
  `setInstalledManifest` (`:415`), `unregisterApp` (`:432`),
  `PERMISSION_NOT_DECLARED` once-per-session dedup (`:107-120`).
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
`Crust` native module is loaded. As long as Phase 1 Android JSC is
done, Phase 2 lights up on Android automatically.

### Phase 3 — WebView lifecycle inversion + UI message bus (~4 weeks)

**Goal:** WebView spawned on demand can talk to its bound JSContext
via `mentra.send`/`mentra.on`.

**Major architectural inversion to acknowledge:** today's
`MiniappHost.tsx` keeps WebViews **persistently mounted off-screen**
at `-left-[10000px]` (`:554`); `setForeground/setBackground` toggle
the offscreen class. This phase inverts the lifecycle to "spawn cold
on user open, destroy on exit." Phase 0's eviction code becomes
obsolete and gets removed here.

Implementation strategy for WKUserScript-style injection:
- `react-native-webview` does NOT expose raw `WKUserScript` or
  `webkit.messageHandlers` (verified: zero uses anywhere in the
  codebase). All WebView communication goes through
  `injectedJavaScriptBeforeContentLoaded` (`MiniappHost.tsx:584`,
  `webview.tsx:500`) for setup and `injectJavaScript` (runtime
  injection) + `onMessage` (`postMessage` from JS to native) for
  bidirectional comms.
- We layer the new `mentra.send/on/ready` API on top of this
  existing primitive — NOT raw WKUserScript. The spec's earlier
  references to `webkit.messageHandlers` were imprecise; the actual
  implementation uses `window.ReactNativeWebView.postMessage` with
  a typed envelope.
- Either: (a) build the new `MentraUIRouter` over
  `react-native-webview`'s primitives (preferred, ~1 week), or
  (b) write a custom WKWebView wrapper for full WKUserScript
  control (~1 week extra, only if (a) hits a wall).

Tasks:
- Refactor `MiniappHost.tsx` (627 LoC): change `mount` semantics
  from "create persistent off-screen WebView" to "create transient
  WebView when user navigates to its UI route." Keep the public
  `mount/unmount` API; change semantics underneath.
- New `MentraUIRouter` (in `mobile/modules/island/src/services/`,
  replacing `WebviewBridge.ts`): given a WebView and a
  `packageName`, routes `postMessage` from JS to the JSContext's
  `session.ui.on()` handlers, and routes `session.ui.send()`
  outputs back via `injectJavaScript("window.__mentra.recv(...)")`.
- `window.mentra` shim injected via
  `injectedJavaScriptBeforeContentLoaded` (~50 LoC). Full surface:
  `send`, `on`, `ready`, `onOpen`, `onClose`. Outbound buffer for
  messages before `ready()` ack.
- New `session.ui` module in
  `mobile/modules/miniapp/src/modules/ui.ts`. Surface:
  `send/on/onOpen/onClose/isOpen`. Wire into
  `mobile/modules/miniapp/src/session.ts:203-218` alongside existing
  modules.
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
- Acceptance: round-trip "WebView taps button → background runs
  glasses display call → glasses show text" — measure on iPhone 15
  with a real perf harness. No specific latency target — measure
  first, set a budget once we know what's normal.

**Android sequencing within Phase 3.** iOS WebView binding first,
then Android equivalent (`addJavascriptInterface` +
`evaluateJavascript` on Android WebView). Same shape, slightly
different native surface. ~3 weeks iOS + ~1 week Android — fits
the 4-week phase budget.

### Phase 4 — Bundle / install / sideload (~1-2 weeks, mobile only)

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
  (294 LoC): emit two-output bundle (`dist/background.js` +
  `dist/ui/`). Today's pack zips a flat `dist/` — needs a
  convention shift.
- Update `sdk/miniapp-cli/src/dev.ts` + `dev-server.ts` (~480 LoC):
  bundle both layers; add `{type:"respawn-bg"}` message alongside
  existing `{type:"reload"}`.
- Update `mobile/modules/island/src/services/AppRegistry.ts`
  (675 LoC): recognize new manifest fields; sdkVersion/
  minHostVersion gating; `background.js` discovery alongside
  `index.html`.
- **Update `sdk/example-miniapp/miniapp.json`** to add `entry`,
  `sdkVersion`, `minHostVersion` fields (Appendix A) — this app is
  the canonical fixture and must match the new schema before
  Phase 5's scaffolder rewrite ships.
- **`buildProjectZip` contract change:** today the zip pipeline
  walks `dist/` flat. New contract walks `dist/background.js` plus
  `dist/ui/` recursively, preserves the `dist/ui/` prefix.
  Document both in the function's TSDoc and add a unit test for
  the new layout.

**Android within Phase 4.** `AppRegistry.ts` is platform-agnostic
TypeScript — the install path / unzip / on-disk layout (under
`Documents/lmas/` on iOS, `getFilesDir()/lmas/` on Android — same
relative tree) is identical across platforms. Verify the Android
unzip path resolves the same `dist/background.js` + `dist/ui/`
discovery as iOS.

**Out of scope for V1, deferred:**
- Ed25519 signature verification (no store, all bundles are
  sideloaded → unsigned by definition).
- `Documents/lmas/` → `Application Support/mentraos/` migration.
  Today's path works; migration is a per-platform footgun and not
  worth the risk for the current LAN-sideload product.
- Cloud-hosted bundle storage / R2 / install-URL flow.

These come back when we ship the store; not now.

### Phase 5 — SDK split + scaffolder rewrite (~2 weeks)

**Goal:** Developers can `bun create mentra-miniapp` and get a
two-layer template.

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
  Rewrite to scaffold `src/background.ts`, `src/ui/index.html`,
  `src/ui/index.tsx`, `src/shared/channels.ts`. Two-output build.
  Scaffolder logic at `sdk/create-mentra-miniapp/bin/index.ts`
  (149 LoC) survives — only template files change.
- Restructure `sdk/example-miniapp/` per **Appendix A** (entire
  React SPA migration). The new `MentraProvider` and `useSession`
  implementations live in `@mentra/miniapp/ui` and wrap the message
  bus rather than the in-WebView `MiniappSession` (which goes
  away on the UI side). New `useChannel<T>(name)` hook is the
  primary read path for state pushed by background.
- Documentation: SDK reference, tutorial, **rewrite the existing
  Mintlify docs** at `docs/docs.json` (and `cloud/docs/docs.json`
  if it overlaps) to describe the two-layer model. Greenfield —
  no compat shim or migration guide for legacy single-bundle apps,
  per the "no installed base" decision. Realistic doc effort: 3-5
  days. Doc updates that cross multiple phases (e.g. permission
  model, signing) get scheduled in the phase that lands the
  feature, not lumped here.

**Android within Phase 5.** None — `@mentra/miniapp/{background,ui}`
is platform-agnostic JS. Same package serves both platforms.

### Phase 6 — Operations (~2 weeks)

**Goal:** Crash detection, telemetry, logging.

- Crash recovery state machine in `JSCRuntime` (RUNNING → CRASHED →
  BACKOFF → CRASHLOOP_DISABLED).
- Telemetry counters wired to **Sentry** (no separate telemetry
  pipeline exists — verified). Tag events with
  `miniapp.packageName`, `miniapp.version`, `miniapp.sdk_version`,
  `device.model`. Existing Sentry infra at
  `mobile/src/effects/SentrySetup.tsx`.
- Logging architecture (redaction, ring buffer, throttle).
- Health checks (heartbeat + ping).
- Soft watchdog (5s warn / 30s kill).

**Out of scope for V1:** remote kill switch, dev portal. No store
in V1 → no kill switch needed; no upload UI / signing UI / crash
dashboard / engagement metrics needed. These come back when we ship
the store.

**Android within Phase 6.** Crash recovery state machine and
telemetry mirror in Kotlin's `JSCRuntime.kt`. Same Sentry SDK
(`@sentry/react-native`) ships unified events across platforms;
no Android-specific tag work needed.

### Total: ~17 weeks mobile (iOS leading), Android lags by ~2 weeks

Phases 0-6 iOS sequential: 1.5 + 3 + 3 + 4 + 1.5 + 2 + 2 = **17 weeks**.
Phase 1 Android adds **3-5 weeks** for the JNI work. With one
engineer doing both platforms sequentially: ~22 weeks total. With
two engineers parallelizing iOS and Android JSC from Phase 1
onward: ~17-19 weeks calendar time.

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

### Migration path for existing miniapps (V1)

For V1 (LAN sideload only), no store-deployed miniapps to migrate.
The `EditMiniApp.tsx` flow in console targets cloud miniapps
(server-hosted), which is a separate product still — not affected
by this architecture change.

When the store ships later, we'll need:
- Compatibility shim for single-bundle (legacy) miniapps
- Manifest auto-migration command
- Cloud-side dual-write during migration window

Out of scope for the V1 doc.

---

## Appendix A — `sdk/example-miniapp/` migration, file by file

The only existing miniapp in the repo. Migration here is the
acceptance gate for "the SDK split is real" — if `bun mentra-miniapp
dev` from the new template produces a working two-layer build of
this app, the migration story works. Concrete file map below.

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
│   │       └── 14 *Page.tsx files  # one per session.* iface (Display, IMU, Input,
│   │                               # Led, Location, Microphone, Permissions, Phone,
│   │                               # Speaker, Storage, System, Transcription,
│   │                               # Translation, Glasses, ComingSoon)
│   ├── ui/                         # shared UI components
│   ├── lib/                        # (empty today)
│   └── styles/, index.css, env.d.ts
```

### Target structure (two-layer)

```
sdk/example-miniapp/
├── miniapp.json                    # manifest — adds entry{} object,
│                                   #   sdkVersion, minHostVersion fields
├── src/
│   ├── background.ts               # NEW entry — replaces main.tsx role on
│   │                               #   the JSContext side. Re-exports
│   │                               #   GlassesController logic.
│   ├── ui/
│   │   ├── index.html              # NEW WebView entry
│   │   ├── main.tsx                # WebView entry — mounts <App/>
│   │   ├── App.tsx                 # MOVED from src/App.tsx (unchanged)
│   │   ├── pages/                  # MOVED — same files, new home
│   │   ├── components/             # was src/ui/
│   │   ├── hooks/
│   │   │   └── useChannel.ts       # NEW thin wrapper over `mentra.on/send`
│   │   └── styles/, index.css
│   └── shared/
│       ├── channels.ts             # NEW — typed channel registry
│       │                           #   (TS interface for every name on
│       │                           #   `mentra.send`/`session.ui.send`)
│       └── types.ts                # NEW — domain types referenced by both
│                                   #   sides (TranscriptionEvent shape, etc.)
```

### File-by-file changes

**`src/controller/GlassesController.ts` → `src/background.ts`.**
Already shaped correctly for the new world (it already documents
"Subscriptions are bound to the session lifetime, NOT to any React
component lifecycle" — this is exactly the JSContext model).
Concrete changes:
1. Replace `import {useAppStore} from "../store/appStore"` — zustand
   does not cross the JSContext/WebView boundary. State that the UI
   needs is published via `session.ui.send(channel, payload)`.
   The local copy lives only in WebView memory.
2. Add an `init(session)` entry point exported from the module top
   level. The runtime will call this once after spawn (via a
   `__deliver({event: "init", session})` injection — see the
   "Spawn" section).
3. Where the controller wrote to `appStore`, instead emit a UI
   channel: e.g. `appStore.setTranscript(t)` becomes
   `session.ui.send("transcript", {text: t})`.
4. Where the controller exposed imperative methods that React called
   (e.g. `controller.startCaptions()`), become
   `session.ui.on("startCaptions", () => { ... })` handlers.

**`src/store/appStore.ts`** — does not move directly. The store is
WebView-side only (zustand mounted in the React tree). The
background.ts side has no `useAppStore`; it owns the canonical state
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
directly (per the explicit exception in `GlassesController.ts:15`).
After migration, **none of them can.** Three options per page:

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
~50 LoC dispatcher handler in `background.ts`. ~2-3 days work
for one engineer.

**`miniapp.json`.** Add fields per the new schema:
```json
{
  "sdkVersion": "0.2.0",
  "minHostVersion": "1.42.0",
  "entry": {
    "background": "dist/background.js",
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
   `dist/background.js` and `dist/ui/`, serves over LAN, and the
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
- **`sdk/miniapp-cli/`** — see Phase 4 file list. Drop `user-server.ts`
  Express-spawning path entirely; `dev.ts` orchestrates background
  bundler + UI bundler + dev-server.ts WebSocket only. (Phase 4.)
- **`@mentra/miniapp` package.json `exports`** — gain
  `./background` and `./ui` sub-paths; the bare `@mentra/miniapp`
  import is removed. Greenfield, no compat shim. (Phase 5.)
- **Docs** (`docs/miniapp-*.md` if they exist; `sdk/example-miniapp/
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

Normal client/server async problems, none unique to this architecture:

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

---

## Open questions

1. **Should disabled miniapps keep their JSContext alive?** Instinct:
   no, tear down on disable. Saves memory. JSContext re-spawns on
   re-enable, hydrates from storage.
2. **CPU/memory quotas per miniapp?** Pebble had none. JSC has no
   built-in quota. We can add a watchdog timer in the Swift
   dispatcher that aborts a miniapp's evaluation if it blocks the JS
   thread for >N seconds. Defer until it bites.
3. **Multiple simultaneous WebViews?** Out of scope. Product is "user
   looks at one miniapp's settings at a time."
4. **Notification scheduling from the WebView?** All scheduling goes
   through background. WebView never schedules anything directly.
5. **What does the JSContext do during the iOS suspension window?**
   Nothing — JS execution is paused with the host process. When the
   host wakes (BLE event arrives), JS resumes mid-task. State is
   preserved. The dev sees `setInterval` callbacks firing slightly
   irregularly when host was paused. Document this.
6. **Inter-miniapp communication?** Out of scope. If miniapp A needs
   to wake miniapp B, it goes through the host (notification, then
   user opens B). No direct miniapp-to-miniapp messaging.
7. **Versioning the bridge.** Every `miniapp.json` declares
   `sdkVersion`. Host refuses to spawn miniapps targeting an SDK
   version it doesn't support. Bump when we change the bridge
   contract.

---

## Success criteria

- 10+ miniapps run simultaneously in background on iPhone SE 2
  (3 GB RAM) without jetsam.
- WebView open-to-render latency <500ms (p95).
- A developer can `bun create mentra-miniapp` and ship a working
  miniapp in <30 minutes.
- Pass at least one App Store review with the new architecture.
- Existing miniapps run via compatibility shim with no developer
  changes required.
