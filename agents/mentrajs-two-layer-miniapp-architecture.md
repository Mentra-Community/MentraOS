# MentraJS — Two-Layer Local Miniapp Architecture

**Status:** Proposed
**Authors:** Alex Israelov + Claude

A spec for moving the local miniapp SDK from a persistent-WebView model
to a JavaScriptCore-per-miniapp background runtime + on-demand WebView
for UI. Most of the existing SDK (~49% of LoC) lifts unchanged. The
new pieces are bounded: a Swift JSContext runtime in the existing
`crust` module, a `__dispatch` bridge, a polyfill bundle, and a
WebView-↔-JSContext message bus.

---

## Why this exists

The current local SDK gives every running miniapp its own persistent
`WKWebView` in the Mentra Manager iOS app. Stress test on iPhone 15
release build:

- 1 backgrounded WebView → ✅ stable (~1.17 GB resident host)
- 5 backgrounded WebViews → ✅ stable (~1.07 GB)
- 10 backgrounded WebViews → ☠️ jetsam'd within ~1 second

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
│  ┌──────────────────────┐         ┌────────────────────────┐    │
│  │ Native iOS code      │ ←─────→ │ MentraJS native router │    │
│  │ (BLE, mic, display,  │         │ (Swift, in `crust`)    │    │
│  │  storage, location)  │         └─────────┬──────────────┘    │
│  └──────────────────────┘                   │                   │
│                                              │                   │
│             ┌────────────────────────────────┼─────────┐         │
│             ▼                                ▼         ▼         │
│  ┌─────────────────┐              ┌─────────────────┐           │
│  │ JSContext A     │              │ JSContext B     │  ...      │
│  │ (always alive)  │              │ (always alive)  │           │
│  │  __dispatch     │              │  __dispatch     │           │
│  │  polyfills      │              │  polyfills      │           │
│  │  @mentra/sdk    │              │  @mentra/sdk    │           │
│  │  miniapp BG JS  │              │  miniapp BG JS  │           │
│  │     │           │              └─────────────────┘           │
│  │     ↕ ui bus    │                                            │
│  │  ┌──┴────────────────┐                                       │
│  │  │ WKWebView         │  ← only when user is looking          │
│  │  │ (transient)       │     at this miniapp's settings        │
│  │  │ window.mentra     │                                       │
│  │  │ no native access  │                                       │
│  │  └───────────────────┘                                       │
│  └─────────────────┘                                            │
└─────────────────────────────────────────────────────────────────┘
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

### Cross-platform: JSC on Android too

Bundle JSC on Android via `react-native-jsc` for SDK uniformity.
Performance gap vs Hermes/V8 is irrelevant for our workload — heavy
work is in native modules; miniapp JS is event-handler-tier.

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
// Functions added to CoreModule
spawn(miniappId: string, polyfillBundle: string, miniappJs: string): boolean
evaluate(miniappId: string, src: string): JSValue
kill(miniappId: string): void
dispatchToJs(miniappId: string, channel: string, payload: unknown): void
// Event "mentrajs_message" — fires when a JSContext calls __dispatch
```

Estimated ~300-500 LoC of Swift added to `crust`. For reference,
`CrustModule.swift` is 323 LoC today.

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
6. Inject the SDK shim (`@mentra/sdk` typed wrappers around
   `__dispatch` exposing the existing `session.*` API surface).
7. Run the miniapp's `background.js`.
8. Call the miniapp's optional `init(session)` export.

By step 7 the miniapp sees a world that looks like a Web Worker — same
`setTimeout`, `fetch`, `WebSocket`, `localStorage`, `crypto.subtle`.

---

## The bridge surface — two bridges, never overlap

### Bridge 1: MentraJS ↔ Native (full power)

`__dispatch(iface, method, args)` is the only path from background JS
to native code. The SDK wraps it into the typed `MiniappSession` API
that miniapps actually use.

**The SDK API surface already exists** in `mobile/modules/miniapp/src/`.
We do NOT redesign it. The 16 module wrappers (`session.glasses`,
`session.display`, `session.input`, `session.transcription`,
`session.translation`, `session.mic`, `session.speaker`,
`session.camera`, `session.dashboard`, `session.led`,
`session.location`, `session.imu`, `session.phone`,
`session.permissions`, `session.storage`, `session.stream`,
`session.system`) all wrap a constructor-injected `session` and call
`session.sendOneShot` / `session.sendRequest` / `session._subscribe`.
Transport-agnostic.

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

`src/shared/channels.ts` — single source of truth for message names:

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
import type {MiniappSession} from "@mentra/sdk"
import type {Note} from "./shared/channels"

let notes: Note[] = []

export async function init(session: MiniappSession) {
  notes = (await session.storage.get("notes")) as Note[] ?? []

  // Glasses button → display latest note on glasses
  session.input.onButtonPress(() => {
    session.display.showTextWall(notes.at(-1)?.body ?? "No notes yet")
  })

  // WebView lifecycle
  session.ui.onOpen(() => session.ui.send("state", {notes}))

  session.ui.on("add-note", async ({body}) => {
    const note: Note = {id: crypto.randomUUID(), body, at: Date.now()}
    notes.push(note)
    await session.storage.set("notes", notes)
    session.ui.send("note-added", {note})
  })

  session.ui.on("delete-note", async ({id}) => {
    notes = notes.filter((n) => n.id !== id)
    await session.storage.set("notes", notes)
    session.ui.send("state", {notes})
  })

  session.ui.on("show-on-glasses", ({id}) => {
    const note = notes.find((n) => n.id === id)
    if (note) session.display.showTextWall(note.body)
  })
}
```

`src/ui/index.tsx` — uses the existing React helpers from
`@mentra/miniapp/react`, adapted to talk to background via the bus:

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
| `sdk/miniapp-cli/src/manifest*.ts` (5 files) | ~850 | Add `sdkVersion`, `minHostVersion`, `entry` (object), `signature` schema fields. |
| `sdk/miniapp-cli/src/dev.ts` + `dev-server.ts` | ~480 | Bundle `dist/background.js` + `dist/ui/`; add `{type:"respawn-bg"}` message alongside `{type:"reload"}`. |
| `sdk/miniapp-cli/src/pack.ts` + `release.ts` | ~380 | Two-output bundle; cloud adds META-INF/signature on publish. |

### Reuse with major changes (right shape, internals rewritten)

| File | LoC | What survives, what changes |
|---|---|---|
| `mobile/modules/island/src/services/LocalMiniappRuntime.ts` | 1,752 | **Skeleton survives:** per-app registry, refcounted streams, ping loop, **22 handler methods** (CONNECT, SUBSCRIBE, DISPLAY, PLAY_AUDIO, SPEAK, RGB_LED, LOCATION_POLL, STORAGE_*, CAMERA_FOV, SHARE, OPEN_URL, COPY_CLIPBOARD, DOWNLOAD, PHOTO, STREAM_*, MANAGED_STREAM_*, PING/PONG). Handler bodies don't know they're talking to a WebView — they take `(packageName, payload)` and dispatch to native. **Rewrite:** front door (`handleRawMessage` → `__dispatch`); per-app `sendMessage` (postMessage → `JSContext.evaluateScript`); HMAC/local-token code goes away. |
| `mobile/modules/island/src/services/AppRegistry.ts` | 675 | Manifest normalization + zip pipeline survive. **Add:** `background.js` discovery alongside `index.html`; recognize new manifest fields; signature verification for store-installed bundles; sdkVersion/minHostVersion compatibility check on spawn. |
| `sdk/create-mentra-miniapp/bin/index.ts` + template | ~150 + template | Scaffolder logic survives (clack prompts, validation, template substitution). **Template files rewrite:** scaffold `src/background.ts`, `src/ui/`, `src/shared/channels.ts` instead of single React SPA. |

### Replace entirely

| File | LoC | Why |
|---|---|---|
| `mobile/modules/miniapp/src/transport/postmessage.ts` | 95 | Hard-coded to `window.ReactNativeWebView`. Repurpose as `WebViewToJsContextTransport` for the settings WebView. |
| `mobile/modules/island/src/services/WebviewBridge.ts` | 50 | Replaced by two sibling routers: `MentraJSRouter` (JSContext fan-out) + `MentraUIRouter` (settings WebView ↔ bound JSContext). |
| `mobile/modules/miniapp/src/globals.ts` | 62 | `window.MentraOS` is WebView-presentational. Keep file for WebView; JSContext gets a different injected globals object. |
| `mobile/modules/miniapp/src/index.ts` | 108 | Splits into two: `@mentra/sdk` (background API) and `@mentra/miniapp/ui` (settings WebView API). |
| `sdk/example-miniapp/` | (entire React SPA) | Restructure into two-layer: logic into `src/background.ts`, UI into `src/ui/`. Existing React code is reusable as the basis for the UI half. |

### Net-new code

- **`MentraJSRuntime.swift`** in `crust` — spawns JSContexts, owns
  lifecycle. ~300-500 LoC.
- **`__dispatch` glue + iface registry** — Swift dispatch table.
- **`DispatchTransport.ts`** — new `Transport` implementation
  wrapping `__dispatch` so existing `MiniappSession` sits on top
  unchanged.
- **Polyfill bundle** — see "Polyfill strategy" below.
- **`MentraUIRouter`** — when WebView mounts, host binds it to a
  JSContext and routes `mentra.send`/`mentra.on` between them via
  WKUserScript injection.
- **WKUserScript `window.mentra` shim** — typed `send`/`on`/`ready`
  + outbound buffer for messages before `ready()`.
- **Bundle signature verification** — Ed25519 over
  META-INF/manifest.sha256 in `AppRegistry.installFromUrl`.
- **`sdkVersion`/`minHostVersion` gating** — host refuses spawn if
  versions don't match.
- **Per-miniapp typed `Channels`** — TypeScript generics on
  `mentra.send`/`mentra.on` enforced at compile time.
- **Storage namespace cleanup on uninstall** — drop
  `storage/<id>/` per the bundle/install section.

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

**Total custom code: ~1000 LoC JS + ~600 LoC Swift, ~2-3 weeks.**

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

### Miniapp install

1. Host downloads bundle from `apps.mentra.glass`, validates manifest
   + Ed25519 signature, unzips into the app sandbox under
   `Application Support/mentraos/miniapps/<packageName>/<version>/`.
2. Host spawns a `JSContext` via `MentraJSRuntime.spawn(packageName,
   polyfillBundle, dist/background.js)`. JSContext now alive.
3. Background's `init(session)` runs (typically: hydrate state from
   `session.storage`, register listeners).

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

1. Host calls `MentraJSRuntime.kill(packageName)`.
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

```json
{ "error": { "code": "PERMISSION_DENIED",
             "permission": "MICROPHONE",
             "canRequest": true } }
```

If `canRequest`, the SDK can call `session.permissions.request(...)`
which routes through `__dispatch` to a host-rendered modal.

### App Review answer

*"Every miniapp declares permissions in a manifest, gets per-app user
consent at install, gets a second JIT consent for OS-level-sensitive
APIs, and the native bridge refuses unpermitted calls regardless of
what the JS attempts."* Maps 1:1 onto 4.7.3.

---

## Bundle, install, update, sideload

The existing `AppRegistry.ts` already does most of this. Additions:
signature verification, two-output bundle support, version retention.

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

### Storage layout

```
<App Support>/
  mentraos/
    miniapps/
      <packageName>/
        <version>/                  # active bundle tree
        <prev-version>/             # one prior, for rollback
        manifest.json               # registry entry (active, source)
    storage/
      <packageName>/                # session.storage namespace; survives upgrades
    cache/
      downloads/                    # transient ZIPs, evictable
```

**Use Application Support, NOT Documents.** Documents/ is user-visible
via Files.app and iCloud-eligible. The `storage/` namespace IS in a
user-data location so iCloud backup picks it up — separate concern.

(Today's `AppRegistry.ts` uses `Documents/lmas/` — migrate as part of
Phase 2.)

### Retention

- N=2 versions per package (active + previous, for rollback).
- Sideloaded / `dev-*` versions exempt — `pinned: true` flag.
- Disk budget: soft cap 200 MB. LRU eviction by last-launched, never
  evicting `pinned`, `dev-*`, or currently-running app.
- Eviction never touches `storage/<id>/` — user data survives bundle
  eviction.

### Install flow

1. **Resolve.** Mobile `POST /api/client/miniapps/:id/install-url`
   → cloud authorizes, mints 5-min signed R2 URL.
2. **Pre-flight.** Check size, sdkVersion range, storage budget.
3. **Permission prompt.** Manifest `permissions[]` shown as iOS-style
   sheet.
4. **Download.** To `cache/downloads/`. Progress bar.
5. **Unzip to staging.** `cache/lma_unzip/`. Atomic.
6. **Validate.** `packageName` matches; signature verified; entry
   files exist.
7. **Atomic swap.** Move staging → `miniapps/<id>/<new-version>/`.
   Old active version stays as rollback slot.
8. **Spawn / register.** Notify listeners. Store UI flips to "Open."
9. **Cleanup.** Delete cached download.

### Update flow

1. **Discovery.** Mobile polls `GET /api/client/miniapps/updates` on
   foreground + every 6h.
2. **Eligibility.** Skip if running (defer until stop, unless
   `force`); skip if sdkVersion mismatches host.
3. **Background download.** Same pipeline, into `<new-version>/`
   alongside active. Active keeps running.
4. **Activation.**
   - Not running → bump `manifest.json.active` on next launch.
   - Running, non-forced → defer; swap on next stop.
   - `force: true` → kill, swap, respawn.
5. **State migration.** `storage/<id>/` is shared across versions —
   new code reads old data. SDK exposes a `storageVersion` hook for
   the miniapp to migrate its own data on first run.
6. **Rollback.** New version's JSContext throws on first boot or
   fails health check within 30s → AppRegistry rolls back to
   previous version dir, marks new version `quarantined`. Reports to
   cloud → cloud can mark version `RECALLED`, halting installs.

### Sideloading for developers

Two existing paths in `sdk/miniapp-cli/`:
1. **`mentra-miniapp dev`** — hot-reload over LAN. Bundle never lands
   on disk; runs from in-memory dev server.
2. **`mentra-miniapp release`** — produces a zip, serves over LAN,
   phone scans QR. Installed bundle marked `pinned: true` +
   `source: "sideload"`.

Sideloaded bundles are unsigned; only install when developer mode
enabled (already gating). Same sandbox as store apps — same
permission prompts, no elevated privileges. Pinned bit prevents LRU
eviction.

### Uninstall

1. Confirm with user. If app has data, *"X has 14 KB of data. Delete
   it too?"* — checkbox default unchecked (mirror iOS app uninstall).
2. If running: stop JSContext.
3. Delete `miniapps/<id>/`.
4. If user opted to delete data: delete `storage/<id>/`.
5. Revoke permissions; remove from local cache.
6. Notify cloud `POST /api/client/miniapps/:id/uninstall`.

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
Host calls `MentraJSRuntime.respawn(packageName)`:
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

### Remote kill switch (mandatory)

Cloud has `disabled_miniapps: { [packageName]: { reason, since,
scope: "all" | { userIds: [...] } } }` document. Host fetches on
launch + every 1h. If installed miniapp is in list, do NOT spawn its
JSContext; show "Disabled by Mentra" tile. Critical for security
incidents and Apple App Store demands.

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

The architecture is a refactor + add, not a rewrite. The phases below
are sequential but each is independently shippable.

### Phase 0 — Ship-with-eviction (1 week)

**Goal:** Make the existing WebView-only model survivable on
SE-class devices so the current PR ships.

- Add device-tier detection at boot (`physicalMemory` from
  `NSProcessInfo`).
- Hard caps per tier: 3 GB → 1 backgrounded miniapp; 4 GB → 3;
  6 GB → 5; 8 GB+ → 8.
- Enforce in `LocalMiniappRuntime` via LRU eviction. N+1th miniapp
  starts → least-recently-used backgrounded one unmounted, state
  flushed to storage.
- UI state when an app was evicted (so re-open splash isn't confusing).

Unblocks shipping. Doesn't block Phase 1+.

### Phase 1 — JSC runtime in `crust` (2-3 weeks)

**Goal:** Spawn N JSContexts from Swift, route `__dispatch` to
existing native services, get a "hello world" miniapp displaying text
on glasses without WebView.

- New Swift files in `mobile/modules/crust/ios/Source/`:
  `JSCRuntime.swift`, `JSCDispatcher.swift`, `JSCPolyfillBridge.swift`.
  ~300-500 LoC total.
- Add Expo Functions to `CrustModule.swift`: `mentraJsSpawn`,
  `mentraJsEvaluate`, `mentraJsKill`, `mentraJsDispatchToJs`. Event
  `mentrajs_message`.
- Pebble-inherited pieces all in scope: `JSManagedValue`,
  `evalCatching`, `console.*` rewiring, `window.onerror` /
  `onunhandledrejection`, `signalReady` with 6s NACK timeout,
  `JSContext.setName` + `setInspectable`, log redaction, tear-down
  race ordering, `debugForceGC` hook, stable per-(user, miniapp)
  token.
- Polyfill bundle in `mobile/modules/mentrajs-runtime/runtime/`:
  install MIT libs (console, fast-text-encoding,
  whatwg-url-without-unicode, base-64, event-target-shim,
  fetch-blob, formdata-polyfill, abort-controller); write thin
  bridges for setTimeout/fetch/WebSocket/localStorage/crypto.
- New `DispatchTransport.ts` in
  `mobile/modules/miniapp/src/transport/`. Add 4th branch to
  `auto.ts` autodetect.
- Hello-world miniapp: install bundle, JSContext spawns,
  `session.display.showTextWall("hi")`, glasses display it.

### Phase 2 — Refactor `LocalMiniappRuntime` → `MentraJSRouter` (2 weeks)

**Goal:** All 22 handler methods from `LocalMiniappRuntime.ts` survive,
front door swaps from postMessage to `__dispatch`.

- Move 22 handler bodies from `LocalMiniappRuntime.ts` to a new
  `MentraJSRouter` class that takes `(packageName, payload)` from
  `__dispatch` events.
- Per-app `sendMessage` becomes `MentraJSRuntime.dispatchToJs(...)`
  instead of `webview.postMessage`.
- HMAC/local-token code removed (no separate WebSocket auth context).
- Verify all existing miniapp APIs (display, transcription, mic,
  camera, speaker, LED, location, IMU, button events) work
  end-to-end through the new path.

### Phase 3 — WebView binding + UI message bus (2 weeks)

**Goal:** WebView spawned on demand can talk to its bound JSContext
via `mentra.send`/`mentra.on`.

- Update `LocalMiniappRuntime` to spawn WebView fresh on user
  navigation, destroy on exit. No pool.
- Native router (`MentraUIRouter`): given a WebView and a
  `packageName`, routes `webkit.messageHandlers.mentra` messages to
  the JSContext's `session.ui.on()` handlers, and routes
  `session.ui.send()` outputs back to the WebView via
  `evaluateJavaScript("window.__mentra.recv(...)")`.
- WKUserScript injection: `window.mentra` shim (~50 lines JS).
  Buffers outbound `send()` until `ready()` ack.
- Heartbeat: WebView sends `__heartbeat__` every 5s; background
  considers gone after 15s silence.
- Sequence numbers + dedup window so message-bus replays during
  reconnect don't double-fire handlers.
- Port the Notes example end-to-end. Verify <50ms p95 round-trip
  latency on iPhone 15.

### Phase 4 — Bundle / install / store (1-2 weeks)

**Goal:** Two-output bundles flow through CLI, store, install path,
with signature verification.

- Update `sdk/miniapp-cli/src/manifest*.ts`: schema additions
  (`sdkVersion`, `minHostVersion`, `entry` object, `signature`).
- Update `sdk/miniapp-cli/src/pack.ts` + `release.ts`: emit
  two-output bundle (`dist/background.js` + `dist/ui/`).
- Update `sdk/miniapp-cli/src/dev.ts` + `dev-server.ts`: bundle
  both layers; add `{type:"respawn-bg"}` message.
- Update `mobile/modules/island/src/services/AppRegistry.ts`:
  recognize new manifest fields; add Ed25519 signature verification
  for store-installed bundles; sdkVersion/minHostVersion gating.
- Cloud-side: implement the publish pipeline that adds
  `META-INF/signature.ed25519` to bundles (per
  `agents/miniapp-store-backend-plan.md`).
- Migrate storage layout from `Documents/lmas/` to
  `Application Support/mentraos/miniapps/`.

### Phase 5 — SDK split + scaffolder rewrite (1 week)

**Goal:** Developers can `bun create mentra-miniapp` and get a
two-layer template.

- Split `mobile/modules/miniapp/src/index.ts` into two:
  `@mentra/sdk` (background API) and `@mentra/miniapp/ui` (settings
  WebView).
- Update `sdk/create-mentra-miniapp/template/`: scaffold
  `src/background.ts`, `src/ui/index.html`, `src/ui/index.tsx`,
  `src/shared/channels.ts`. Two-output build.
- Update `sdk/example-miniapp/`: restructure into two-layer.
  Existing React code is reusable as the basis for the UI half.
- Documentation: SDK reference, tutorial, migration guide.

### Phase 6 — Operations + dev portal (1 week)

**Goal:** Crash detection, telemetry, kill switch, dev portal MVP.

- Crash recovery state machine in `MentraJSRuntime`.
- Telemetry counters wired to existing telemetry pipeline.
- Sentry integration with miniapp-tagged events.
- Logging architecture (redaction, ring buffer, throttle).
- Health checks (heartbeat + ping).
- Soft watchdog (5s warn / 30s kill).
- Remote kill switch fetch on app launch + every 1h.
- Dev portal MVP: bundle upload, version channels (dev/beta/production),
  crash dashboard (filtered Sentry), engagement metrics, store listing
  editor, signing key management, permission manifest editor with diff
  preview, REST endpoint for CI/CD.

### Total: 8-10 weeks

Sequential. Phase 0 can run in parallel (different engineer) and
unblocks shipping the current PR.

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
