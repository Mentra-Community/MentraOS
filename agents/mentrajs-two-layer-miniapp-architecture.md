# MentraJS Two-Layer Miniapp Architecture

**Status:** Proposed (v2 — verified against Pebble's actual implementation)
**Author:** Alex Israelov + Claude
**Date:** 2026-05-09
**Branch:** `mentra-miniapp-sdk-2`

## What changed from v1

v1 of this doc oversold "Pebble validates this." A deep reading of Pebble's
actual code (see `coredevices/mobileapp` — `libpebble3/src/iosMain/kotlin/
io/rebble/libpebblecommon/js/`) revealed two big gaps and many small
missing pieces. Critical changes in v2:

- **Pebble runs ONE PKJS context at a time, not N.** Their lifecycle is
  "one watch app running → one JSContext." When the user starts a
  different watch app, the previous context is torn down. **Pebble has
  not validated the N-concurrent-context model on iOS.** We're the ones
  signing up for that risk. Phase 1.5 added: real-device memory benchmark
  of N=10 contexts for 24 hours before committing Phase 4 work.
- **Pebble's WebView ↔ JS communication is one-shot via URL redirect**,
  not a live message bus. Our typed-bus design is more powerful but is
  novel work, not Pebble-proven. Spec now flags this honestly.
- Added missing pieces Pebble has and we forgot: `signalReady` round-trip
  with NACK timeout, `evalCatching` wrapper around every script,
  `console.*` rewiring, `window.onerror` / `onunhandledrejection`,
  `JSContext.setName` + `setInspectable`, log redaction for sensitive
  terms, stable per-(user, miniapp) token primitive, `JSManagedValue` for
  any JSValue native code holds across calls, tear-down race ordering,
  `debugForceGC` diagnostic hook.

## Writing this once, correctly

The MentraOS team is excited about the local SDK. Once it ships, engineers
will start porting cloud miniapps to it, and external developers will
build new ones. **We get one chance to set the SDK contract.** Migrating
the contract later means breaking every miniapp built against it.

This drives several decisions:

- **Live message bus from v1, not URL-redirect.** Cloud miniapps are real
  SPAs with React/Vue/Svelte. They need real-time channels between
  background and UI. URL-redirect is fine for "hit Save and exit"
  config pages but won't handle live transcription previews, glasses
  display previews, streaming sensor data into the UI, etc. We commit to
  the bus from day one even though it's more code.
- **Typed channels enforced at compile time.** `Channels` interface in
  `src/shared/channels.ts` is the single source of truth; both layers
  import from it; misnamed events fail at compile time. Catches a class
  of bugs that would otherwise show up only at runtime in production.
- **Storage as source of truth, not in-memory state.** Miniapps will be
  killed and respawned (host app jetsam, glasses disconnect, user
  toggles disable). Every miniapp must hydrate from `phone.storage` on
  start. Documenting this as a hard rule + adding a lint that flags
  miniapps which keep state outside storage.
- **Permissions declared in manifest, prompted at install** — not at
  first call. Makes the install flow predictable and avoids miniapp
  authors getting whack-a-mole rejections from iOS permission prompts
  scattered across their code paths.
- **Bridge surface frozen for v1, additions go through SDK versioning.**
  Adding a new bridge method = bumping `sdkVersion` in `mentra.json`.
  Host refuses to spawn miniapps targeting an SDK version it doesn't
  support. Removing a method = same. This way miniapps can be confident
  about what works.
- **No "two ways to do things."** Forbidden: WebView calling native
  directly. Forbidden: background reaching into WebView DOM. The only
  paths are background → native (via `__dispatch`) and background ↔
  WebView (via the message bus). One way, every time.
- **Hot-reload from day one.** Both layers reload on file change during
  `bun run dev`. Background reloads = `kill(miniappId) + spawn(...)`
  triggered over a websocket from the dev tooling to the host app.
  WebView reloads via the standard reload trigger. If devs have to
  restart the host app to test changes, they will hate the SDK. They
  will be loud about it. We will lose them.

## Why this exists

Today every running local miniapp gets its own persistent `WKWebView` in
the Mentra Manager iOS app. Real-device measurements on iPhone 15 (release
build) show:

- 1 backgrounded WebView: ✅ stable indefinitely (~1.17 GB resident)
- 5 backgrounded WebViews: ✅ stable indefinitely (~1.07 GB)
- 10 backgrounded WebViews: ☠️ jetsam'd within ~1 second

Each `react-native-webview` instance is a separate `com.apple.WebKit.WebContent`
OS process carrying ~80–150 MB of WebKit baseline + JIT region + JavaScript
heap + layout engine + GPU process slice. **This overhead is WebKit's, not
ours — there is no flag to make it smaller.** Projecting to user devices:

| Device | RAM | Backgrounded WebViews we can sustain |
|---|---|---|
| iPhone 15 Pro Max | 8 GB | 8–10 |
| iPhone 15 / 14 | 6 GB | 5–7 |
| iPhone 13 / 12 | 4–6 GB | 3–5 |
| iPhone SE 3 (2022) | 4 GB | 1–2 |
| iPhone SE 2 (2020) | 3 GB | 0–1 |

The product requirement is **miniapps must keep running with the phone
screen off and the Mentra app backgrounded, with glasses connected**. On
SE-class devices, a single backgrounded miniapp consumes the entire jetsam
budget. We can't ship that.

The fix is to stop using a WebView for the always-on background half of a
miniapp. WebKit's overhead is fine when a user is *looking* at a miniapp's
settings page (one WebView at a time, foreground). It's fatal when we
silently keep N of them warm in background to relay glasses events.

## The architecture

Each miniapp becomes **two cooperating layers** that ship in the same
bundle and never run independently:

1. **Background layer ("MentraJS")** — a `JavaScriptCore` `JSContext`,
   one per installed-and-enabled miniapp, **always running** while the
   Mentra Manager process is alive. ~3–5 MB resident per context. No DOM,
   no rendering. This is where all glasses logic lives.
2. **UI layer ("MentraUI")** — a `WKWebView` spawned **on demand** when
   the user opens the miniapp's settings page. Destroyed when the user
   navigates away. Standard HTML/CSS/JS, full DOM, can use any framework.
   Has zero direct native access — only talks to its own background layer
   via message passing.

Both layers ship in the same git repo and the same bundle. The developer
writes them together. They share TypeScript channel definitions for type
safety across the message bus.

This is the **WeChat mini-program model** (logic layer in JSCore + view
layer in WebView, communicating via native router) and the **VS Code
extension model** (extension host + sandboxed webview iframe). It is
well-trodden territory at billion-user scale.

### Process topology

```
┌────────────────────────────────────────────────────────────────────┐
│                  Mentra Manager (host RN app)                       │
│                                                                     │
│  ┌──────────────────────┐         ┌────────────────────────────┐    │
│  │ Native iOS code      │ ←─────→ │ MentraNativeBus            │    │
│  │ (BLE, mic, display,  │         │ (single router)            │    │
│  │  storage, location)  │         └─────────┬──────────────────┘    │
│  └──────────────────────┘                   │                       │
│                                              │                       │
│             ┌────────────────────────────────┼─────────────┐        │
│             ▼                                ▼             ▼        │
│  ┌──────────────────────┐       ┌──────────────────────┐            │
│  │ JSContext for app A  │       │ JSContext for app B  │   ...      │
│  │ (always alive in BG) │       │ (always alive in BG) │            │
│  │                      │       │                      │            │
│  │  __dispatch          │       │  __dispatch          │            │
│  │  navigator.*         │       │  navigator.*         │            │
│  │  Mentra SDK          │       │  Mentra SDK          │            │
│  │                      │       │                      │            │
│  │  ui.send/on          │       │  ui.send/on          │            │
│  └──────────┬───────────┘       └──────────────────────┘            │
│             │                                                       │
│             │ (only when user opens app A's settings)              │
│             ▼                                                       │
│  ┌────────────────────────────┐                                     │
│  │ WKWebView (transient)      │                                     │
│  │                            │                                     │
│  │  window.mentra.send/on     │                                     │
│  │  window.mentra.ready()     │                                     │
│  │                            │                                     │
│  │  *no direct native access* │                                     │
│  └────────────────────────────┘                                     │
└────────────────────────────────────────────────────────────────────┘
```

Key invariants:
- N JSContexts always alive, one per installed miniapp.
- 0 or 1 WebView at a time (one foreground miniapp UI at a time on iOS).
- WebView is spawned cold when the user navigates to the miniapp's UI
  route, destroyed when they navigate away.
- WebView never talks to native directly. All native capability requests
  go through the bound JSContext.

## Why "fresh WebView per open" instead of pooling

The earlier draft of this doc proposed pre-warming a WebView pool to
reduce mount latency. **Dropped.** Reasons:

- WKWebView cold-mount on iPhone 15 is ~100–300 ms. A tap-to-screen
  latency of 300 ms is fine for a settings sheet. Users don't notice.
- A pool of 1 means the warm WebView is always the *wrong* miniapp's
  WebView (we have to call `loadFileURL` to swap it). The "warm"
  benefit shrinks to ~50 ms saved.
- Pool management adds bug surface (orphan messages, stale routing,
  dirty global state from the previous miniapp).
- Memory cost of holding a warm WebView in background is ~80 MB
  permanent — defeats the whole point of the architecture.

Spawn fresh, destroy on exit. Same pattern Chrome uses for extension
popups.

## The bridge surface

There are **two** bridges, exposing different things. They never overlap.

### Bridge 1: MentraJS ↔ Native (the full-power bridge)

Every native capability lives here. Auto-injected as a global on each
JSContext at spawn time:

```typescript
// Injected by the host app at JSContext setup
declare global {
  function __dispatch(iface: string, method: string, args: unknown[]): Promise<unknown>
}
```

The `@mentra/sdk` package wraps `__dispatch` into typed APIs:

```typescript
// What the SDK exposes to background.ts
export const glasses = {
  display: {
    text(content: string, opts?: DisplayOptions): Promise<void>
    image(uri: string, opts?: ImageOptions): Promise<void>
    clear(): Promise<void>
  },
  mic: {
    onPcm(cb: (pcm: ArrayBuffer) => void): Unsubscribe
    start(opts?: MicOptions): Promise<void>
    stop(): Promise<void>
  },
  buttons: {
    on(event: ButtonEvent, cb: () => void): Unsubscribe
  },
}

export const phone = {
  notifications: {
    onReceived(cb: (n: PhoneNotification) => void): Unsubscribe
  },
  location: {
    get(opts?: LocationOpts): Promise<Position>
    watch(cb: (p: Position) => void): Unsubscribe
  },
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    remove(key: string): Promise<void>
  },
  network: {
    fetch(url: string, opts?: RequestInit): Promise<Response>
    websocket(url: string): WebSocket  // shimmed in JS over native sockets
  },
}

export const ui = {
  isOpen(): boolean
  send<C extends keyof Channels>(channel: C, payload: Channels[C]): void
  on<C extends keyof Channels>(channel: C, cb: (payload: Channels[C]) => void): Unsubscribe
  onOpen(cb: () => void): Unsubscribe
  onClose(cb: () => void): Unsubscribe
}
```

The full surface lives **only** here. WebViews never see any of this.

### Bridge 2: WebView ↔ MentraJS (per-miniapp, namespaced)

Auto-injected into each WebView at mount time:

```typescript
// Injected by the host app via WKUserScript at document-start
declare const mentra: {
  send<C extends keyof Channels>(channel: C, payload: Channels[C]): void
  on<C extends keyof Channels>(channel: C, cb: (payload: Channels[C]) => void): Unsubscribe
  ready(): void
}
```

`mentra.send()` does NOT go to native. It goes to the bound JSContext's
`ui.on()` handlers via the host app's router. If the developer wants to
display text on glasses from a button click in their UI, they have to
send a message to background, and background calls `glasses.display.text()`.

### Why "no native shortcut for the WebView"

To prevent the "two ways to do things" mess. There is exactly one path
from a WebView interaction to a hardware action:

```
WebView event
  → mentra.send(channel, payload)         [WebView side]
  → host router                            [native]
  → ui.on(channel, cb) handler            [JSContext side]
  → glasses.display.text(...)             [SDK call]
  → __dispatch('glasses.display', ...)    [bridge]
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
background. This is the WeChat model and the VS Code model. It works.

## Source layout for a miniapp

```
my-notes-miniapp/
├── mentra.json             # manifest
├── package.json
├── tsconfig.json
├── src/
│   ├── background.ts       # MentraJS entrypoint — always running
│   ├── ui/
│   │   ├── index.html      # WebView entrypoint
│   │   ├── index.ts        # WebView code
│   │   └── styles.css
│   └── shared/
│       └── channels.ts     # message channel typings, shared by both layers
└── dist/                   # output of `bun run build`
    ├── background.js
    └── ui/
        ├── index.html
        ├── index.js
        └── styles.css
```

`mentra.json`:

```json
{
  "id": "com.alex.notes",
  "name": "Notes",
  "version": "1.0.0",
  "background": "dist/background.js",
  "ui": {
    "entry": "dist/ui/index.html",
    "title": "Notes",
    "icon": "assets/icon.png"
  },
  "permissions": ["glasses.display", "glasses.buttons", "phone.storage"]
}
```

`src/shared/channels.ts` — the single source of truth for the message bus
between the two layers:

```typescript
export interface Channels {
  // WebView → background
  'add-note': { body: string }
  'delete-note': { id: string }
  'show-on-glasses': { id: string }
  'request-state': void

  // background → WebView
  'state': { notes: Note[] }
  'note-added': { note: Note }
}

export interface Note {
  id: string
  body: string
  at: number
}
```

Both `background.ts` and `ui/index.ts` import from this file. The SDK's
generic types pin `mentra.send` and `mentra.on` to keys of `Channels`,
so misnamed events fail at compile time.

## Concrete example: full Notes miniapp

`src/background.ts`:

```typescript
import { glasses, phone, buttons, ui } from '@mentra/sdk'
import type { Note } from './shared/channels'

let notes: Note[] = []

async function init() {
  notes = (await phone.storage.get('notes')) as Note[] ?? []

  buttons.on('click', () => {
    glasses.display.text(notes.at(-1)?.body ?? 'No notes yet')
  })

  ui.onOpen(() => {
    ui.send('state', { notes })
  })

  ui.on('add-note', async ({ body }) => {
    const note: Note = { id: crypto.randomUUID(), body, at: Date.now() }
    notes.push(note)
    await phone.storage.set('notes', notes)
    ui.send('note-added', { note })
  })

  ui.on('delete-note', async ({ id }) => {
    notes = notes.filter(n => n.id !== id)
    await phone.storage.set('notes', notes)
    ui.send('state', { notes })
  })

  ui.on('show-on-glasses', ({ id }) => {
    const note = notes.find(n => n.id === id)
    if (note) glasses.display.text(note.body)
  })
}

init()
```

`src/ui/index.ts`:

```typescript
import type { Note } from '../shared/channels'

let notes: Note[] = []

mentra.on('state', ({ notes: incoming }) => {
  notes = incoming
  render()
})

mentra.on('note-added', ({ note }) => {
  notes.push(note)
  render()
})

document.getElementById('add')!.addEventListener('click', () => {
  const input = document.getElementById('input') as HTMLInputElement
  const body = input.value.trim()
  if (!body) return
  mentra.send('add-note', { body })
  input.value = ''
})

function render() {
  const list = document.getElementById('list')!
  list.innerHTML = notes
    .map(n => `<li data-id="${n.id}">${n.body}
                  <button data-show="${n.id}">📺</button>
                  <button data-delete="${n.id}">🗑️</button></li>`)
    .join('')
  list.querySelectorAll<HTMLButtonElement>('[data-show]').forEach(btn => {
    btn.onclick = () => mentra.send('show-on-glasses', { id: btn.dataset.show! })
  })
  list.querySelectorAll<HTMLButtonElement>('[data-delete]').forEach(btn => {
    btn.onclick = () => mentra.send('delete-note', { id: btn.dataset.delete! })
  })
}

mentra.ready()
```

What's *missing* from `index.ts`: any reference to `glasses`, `phone`,
`buttons`, `storage`. By construction, the WebView cannot call those.
A user tapping "📺 show on glasses" goes through the message bus.

## Lifecycle

### Miniapp install

1. Host app downloads bundle from `apps.mentra.glass`, validates manifest,
   stores in app sandbox.
2. Host app spawns a `JSContext`, evaluates `dist/background.js`. JSContext
   now alive in memory.
3. Background's top-level code runs (typically: hydrate state from storage,
   register listeners).

### User opens the miniapp's UI

1. Host app navigates to the miniapp UI route (e.g. `/applet/<id>/ui`).
2. Host app spawns a fresh `WKWebView`.
3. Host app installs the WebView's user script (the `window.mentra` shim
   pointing at the host's `webkit.messageHandlers.mentra`).
4. Host app binds the WebView to the miniapp's JSContext (router knows
   "messages from this WebView go to JSContext X").
5. Host app calls `webView.loadFileURL(<bundle>/dist/ui/index.html)`.
6. WebView mounts. `index.ts` runs. Calls `mentra.ready()`.
7. Host router delivers `__open__` to background. Background's
   `ui.onOpen` handlers fire. Background pushes initial state via
   `ui.send('state', ...)`.
8. WebView renders.

### User navigates away from the UI

1. Host app's router emits `__close__` to background.
2. Background's `ui.onClose` handlers fire. Background can flush pending
   state to storage if needed.
3. Host app destroys the `WKWebView`. WebContent process exits. Memory
   freed.
4. Background JSContext is unaffected — keeps running normally.

### Host app backgrounded by user (screen off, in pocket)

1. iOS may or may not suspend the host process — depends on whether we
   hold a `bluetooth-central` background mode (we do) and have an active
   BLE session (we do, while glasses are connected).
2. As long as host process is alive, all JSContexts continue running.
3. WebViews are already destroyed (user navigated away to background).
4. Background JS receives glasses events normally via the BLE bridge,
   processes them, calls `glasses.display.text` etc.
5. This is the steady-state production scenario — phone in pocket,
   glasses receiving updates from running miniapps.

### iOS jetsams the host app

1. All JSContexts die.
2. On next launch, host app re-spawns each installed-and-enabled
   miniapp's JSContext.
3. Each miniapp's `background.ts` re-runs from scratch, hydrating from
   `phone.storage`.

This is why **`phone.storage` is the source of truth, not in-memory
state**. Same lesson Chrome MV3 service workers had to teach the world.

### Miniapp disabled by user

1. Host app tears down the JSContext.
2. Marks miniapp inactive in installed-apps state.
3. Background JS state (in memory) is gone. Storage remains until
   uninstall.

### Miniapp uninstalled

1. Tear down JSContext.
2. Remove bundle files from app sandbox.
3. Drop `phone.storage` namespace for that miniapp.

## What we explicitly forbid

To enforce "one way to do things":

- **WebViews cannot make BLE calls.** No `mentra.glasses.display.text()`
  in WebView code. Only `mentra.send('show-text', {...})` to background.
- **WebViews cannot access storage directly.** Background owns storage;
  WebView asks background.
- **WebViews cannot subscribe to button presses.** Background subscribes;
  if it wants to forward to the WebView, it can `ui.send('button', ...)`.
- **WebViews cannot have their own background lifecycle.** When the WebView
  is closed it's gone. Reopening is a fresh mount.
- **Background cannot directly manipulate WebView DOM.** Has to go through
  `ui.send('render-this', ...)` and let WebView code handle the DOM.

This is enforced by simply not injecting any other APIs into the WebView.
There's no `window.mentra.glasses` to call — it does not exist. The
WebView is sandboxed iframe-like.

## Race conditions worth thinking about

1. **WebView opens, fires events before background is ready.** Solution:
   `mentra.ready()` is required. SDK buffers `mentra.send()` calls
   until after `ready()` is acked. Background never sees pre-ready
   messages.
2. **Background sends to a WebView mid-close.** Solution: `ui.isOpen()`
   check; SDK silently drops `ui.send()` when no WebView is bound.
3. **User opens UI, WebView loads, but background is mid-async-init.**
   Solution: SDK's `mentra.ready()` retries with exponential backoff
   until acked. Background's `init()` is awaited.
4. **Storage write races with WebView's request-state.** Solution:
   storage operations are awaited; reads happen-after-writes inside one
   async function.
5. **Two WebView messages arrive interleaved.** Solution: messages
   processed sequentially on the JSContext's main thread (single-threaded
   JS, same as browser). No special handling needed.

All normal client/server async problems. None unique to this architecture.

## Memory model

| Component | Memory | Notes |
|---|---|---|
| Empty `JSContext` | ~3–5 MB | JIT-less on iOS; ~7× slower than desktop JSC |
| `JSContext` after typical miniapp init | ~5–15 MB | Depends on JS bundle size + retained state |
| Empty `WKWebView` | ~80–120 MB | Whole separate WebContent OS process |
| `WKWebView` with miniapp UI loaded | ~100–150 MB | Plus WebKit GPU process slice |
| Host RN app baseline | ~500 MB (release build) | Already-large for unrelated reasons |

On iPhone SE 2 (3 GB RAM, ~600–800 MB jetsam ceiling):
- Today: 1 backgrounded miniapp = potentially over budget (host 500 MB +
  WebView 150 MB = 650 MB).
- New architecture: 50+ background miniapps fit comfortably (host
  500 MB + 50 × 5 MB = 750 MB). Plus 1 transient WebView when user
  opens settings (~150 MB peak, freed on exit).

The architecture turns a hard ceiling on iPhone SE into an essentially
unlimited budget for background miniapps.

## Apple compliance

Three concrete things to stay safe under guidelines 2.5.2 and 4.7:

1. **All bundles downloaded from Mentra's mini-app store** at
   `apps.mentra.glass` — not arbitrary URLs developers point at. We
   download `.bundle` (ZIP), validate signature/manifest, unzip into
   the app sandbox, and evaluate local files. Same posture as WeChat
   and Pebble, both shipped on the App Store with this model for years.
2. **`__dispatch` surface is narrow and audited.** Glasses BLE, mic
   data, display, buttons, location (with consent), storage, network.
   No camera, no photo library, no contacts, no microphone-from-the-phone,
   nothing that looks like "extending iOS native APIs" under 4.7.2.
3. **No `eval(networkResponseString)` ever.** All JS executes from files
   on disk under our app sandbox. The 2.5.2 rule is about downloading
   code that "introduces or changes features." Our miniapps are content
   that calls APIs we explicitly expose; they cannot extend the host.

The 3-sentence response to a reviewer: *"MentraOS is a mini-app platform
for our smart-glasses ecosystem. Mini-apps run in JavaScriptCore via a
narrow bridge to glasses BLE, similar to WeChat's mini-program model and
Pebble's PebbleKit JS. All mini-app code is downloaded from our
authenticated app store and runs entirely from local files; no networked
code execution."*

The guideline text in 2.5.2 has named JavaScriptCore as a permitted
runtime alongside WebKit since 2014. WeChat has 4M+ third-party mini
programs running in JSCore on iOS at billion-user scale. React Native
itself runs as JSC executing downloaded JS bundles via CodePush/EAS
Update — tens of thousands of approved apps over 8 years.

The risk that's actually worth taking seriously is **4.7.2**: don't
extend native API surface beyond what we audit. Stay narrow in
`__dispatch`.

## Pieces inherited from Pebble (do not skip these)

A deep read of `coredevices/mobileapp` revealed several "small" things
that aren't optional. They are how PKJS doesn't crash in production. We
copy each one, with citations.

### Single `__dispatch`, NOT per-method bindings (the production crash)

`JavascriptCoreJsRunner.kt:89-114` documents a real production crash:

> "Previously, ~35 Kotlin function references were individually set as
> JSValue properties, each becoming a KotlinBase wrapper. JSC's GC
> would call `[KotlinBase hash]` on these from its Heap Helper Thread,
> racing with K/N's GC and causing EXC_BAD_ACCESS."

`CrashReproducer.kt` is kept in their tree as a regression test. It
reproduces by spawning concurrent threads doing high-rate native→JS
calls + JSC GC pressure + JS code mixing native objects into WeakMap
keys + concurrent GC.

Note: the **specific** crash is Kotlin/Native GC × JSC GC. Swift uses
ARC, not a tracing GC, so we wouldn't hit this exact failure. But we'd
hit different ARC-vs-JSC issues. Take the lesson (single dispatcher),
not the literal cause.

### `JSManagedValue` for held JSValues

Any JSValue that native code retains across calls must be wrapped in
`JSManagedValue` and registered with `addManagedReference` on the
context's virtual machine, then unregistered on destruction. See
`JSCJSLocalStorageInterface.kt:36-42`.

Forgetting this → JSC's GC frees something we still reference → crash.
The reverse (forgetting to unregister) → memory leak across miniapp
restart cycles.

### `evalCatching` wraps every script

`JsCoreExtensions.kt:26-49`. Every `evaluateScript` call goes through a
wrapper that injects a JS try/catch around user code, piping any error
to a global error handler before rethrowing. This catches syntax errors
and synchronous throws that wouldn't fire `window.onerror`. **Never
call `evaluateScript` directly outside of init.**

### `signalReady` round-trip with NACK timeout

`PKJSApp.kt:91-117`. When the host needs to deliver a message to JS,
it first checks if the JS side has signalled `ready`. JS confirms via
`_Pebble.privateFnConfirmReadySignal(success)`. The `JsRunner.readyState`
`MutableStateFlow` only flips to `true` when JS confirms. Until then,
incoming messages **either wait up to 6 seconds or NACK**.

Our `mentra.ready()` needs the same shape: explicit ack from JS, host
buffers messages with a bounded timeout, NACKs on timeout. Document the
chosen timeout (we'll use 6s to match Pebble unless we have a reason
to differ).

### `console.*` rewiring + `window.onerror` + `onunhandledrejection`

`startup.js:4-9` and `64-130`. All of:

```js
console.log, console.warn, console.error, console.info,
console.debug, console.trace, console.assert
```

are rewired to forward to `_Pebble.onConsoleLog(level, message, traceback)`
**while still calling the original**. Plus `window.onerror` →
`_Pebble.onError(...)` and `window.addEventListener('unhandledrejection')`
→ `_Pebble.onUnhandledRejection(...)`.

This is how you debug user code in production. Without it, the only
way a developer's bug becomes visible is if they happen to attach Safari
Web Inspector mid-bug. Forward all console output to our log stream and
to Sentry (with redaction — see next).

### Console-log redaction

`PrivatePKJSInterface.kt:39-65`. When `obfuscateContent` is set,
log lines containing "token", "password", "secret", "auth", "key" etc.
are redacted before being forwarded to native. Sentry hygiene measure.
Worth copying — turn on in release builds, off in dev.

### `JSContext.setName()` and `setInspectable`

`JavascriptCoreJsRunner.kt:144-151`. Each context is named
`"PKJS: $appName"` so Safari Web Inspector picks up a sensible label
when developers attach. `setInspectable` is iOS 16.4+, gated by
`#available` check, **and** by a runtime config flag (so we can disable
inspection in release builds even on iOS 16.4+).

5 lines of Swift. Best DX feature in their whole runtime. Ship from
Phase 1.

### Stable per-(user, miniapp) token

`PKJSInterface.kt:35-61`. `Pebble.getAccountToken()` returns a stable
identifier scoped to (user, app), hashed so the developer never sees
actual user identity but can still recognize "this is the same user
returning." `getWatchToken()` is similar but scoped to (device, app).

Sideloaded apps get a per-developer-ID token; app-store apps get a
per-app-UUID token. Either way, the developer can correlate sessions
without identifying the user.

We need an analog: `phone.identity.appToken()` returning a UUID stable
per (user, miniapp). Important security/privacy primitive that miniapp
authors will want for any kind of cloud sync.

### Tear-down race ordering

`JavascriptCoreJsRunner.kt:155-173`. The exact sequence matters:

```
1. Cancel the coroutine scope
2. Join all in-flight jobs (so nothing is mid-evaluate)
3. Remove all JSManagedValue references (so JSC stops tracking them)
4. Drop the dispatcher StableRef
5. Close the threadContext
6. Force a GC.collect() to break cycles
```

Doing these out of order → race where threadContext closes mid-job, or
JSC GC fires after we've freed Kotlin/Swift objects it still
references. Bake this exact order into the runtime's destructor.

### `debugForceGC()` diagnostic hook

Exposed as `JSGarbageCollect(jsContext.JSGlobalContextRef())`. Used by
`CrashReproducer` for repro and by us during memory leak hunts. Ship it,
gated to dev/super-mode builds.

### What we DON'T inherit from Pebble

- **Multiple concurrent JSContexts.** Pebble has one. We need N. **This
  is the single biggest risk in the architecture and is unproven.** See
  the new Phase 1.5 below.
- **Live message bus between WebView and JS.** Pebble does one-shot URL
  redirect. Ours is novel; budget for the bugs.

## Implementation plan

Each phase is a standalone, shippable milestone. Each builds on the
previous. We can pause between phases without leaving the codebase in
a broken state.

### Phase 0 — Ship-with-eviction (1 week)

**Goal:** Make the existing WebView-only model survivable on
iPhone-SE-class devices so we can ship the current PR.

Tasks:
- Add device-tier detection at boot (`physicalMemory` from
  `NSProcessInfo` via existing native bridge).
- Define hard caps per tier:
  - 3 GB RAM: 1 backgrounded miniapp max
  - 4 GB RAM: 3 max
  - 6 GB RAM: 5 max
  - 8 GB+ RAM: 8 max
- Enforce caps in `LocalMiniappRuntime` via LRU eviction. When the user
  starts an N+1th miniapp, the least-recently-used backgrounded one
  is unmounted (its `beforeevict` is fired, state flushed to storage).
- Surface a UI state to the user when an app was evicted (so when they
  re-open it, the splash isn't confusing).

This unblocks shipping the current PR. Does not require the new
architecture. Phase-1 work happens on a separate branch in parallel.

### Phase 1 — JSC runtime spike (1 week)

**Goal:** Prove we can spawn a `JSContext` from Swift, evaluate a JS
file, expose `__dispatch`, and get a "hello world" miniapp talking to
glasses.

Tasks:
- New Expo module: `mobile/modules/mentrajs/`
  - Swift: `MentraJSRuntime.swift` — owns N `JSContext`s keyed by
    miniapp ID. Each context has its own `JSVirtualMachine` for hard
    isolation (JSContexts that share a VM share the heap; we want
    full isolation for security).
  - Swift: `MentraJSDispatcher.swift` — implements `__dispatch`. Routes
    to existing native services (`CoreModule`, `crust`, etc.) for
    glasses, BLE, storage. Single function, dispatches by `iface`+
    `method` strings, JSON-serialized args.
  - Swift: bridge to RN via Expo Module API: `spawn(miniappId, jsPath)`,
    `evaluate(miniappId, src)`, `kill(miniappId)`, `dispatchToJs(miniappId,
    channel, payload)`.
  - JS shims (one-time, ~500 lines): `setTimeout`, `setInterval`,
    `clearTimeout`, `clearInterval`, `Promise` polyfill if needed
    (modern JSC has it), `fetch`, `WebSocket`, `localStorage`,
    `console.log` (forwards to native log).
- Test miniapp: a `helloworld.js` that on load calls
  `__dispatch('glasses.display', 'text', ['hello from JSC'])`.
- Demo: install the test miniapp, watch glasses display "hello from
  JSC" without any WebView involved.
- **Crucial: avoid the Pebble-discovered footgun.** Don't bind individual
  Swift functions as `JSValue` properties on the global object. Use a
  single `__dispatch` C function. Multiple agents have documented that
  the per-method pattern races JSC's GC with Swift's ARC and crashes in
  production. We inherit that lesson for free by going single-dispatcher
  from day one.
- All the inherited Pebble pieces from the section above are in scope
  for Phase 1: `JSManagedValue` for held JSValues, `evalCatching`,
  `console.*` rewiring, `window.onerror` / `onunhandledrejection`,
  `signalReady` with 6s NACK timeout, `JSContext.setName` +
  `setInspectable`, log redaction, tear-down race ordering,
  `debugForceGC` hook, stable per-(user, miniapp) token.

### Phase 1.5 — N-context memory benchmark ✅ DONE 2026-05-09

**Goal:** Validate the unproven claim that "we can run N concurrent
JSContexts in background." Pebble has zero data on this.

**Result: ~0.75 MB per JSContext on iPhone 15 release build.** 50
contexts added 37.4 MB total. Architecture is unambiguously viable.
Raw log: `agents/spike-results/jsc-spike-iphone15-release-50ctx.log`.

The spike was run agentically via:
1. `JSCExperiment.swift` — spawns N JSContexts each with own
   `JSVirtualMachine`, single `__dispatch` stub bridge, idle workload
   (timer + 100-entry state).
2. `OnCreate` hook in `BluetoothSdkModule` — checks
   `MENTRA_RUN_JSC_BENCH` env var and auto-runs the benchmark on launch.
3. `Documents/jsc-spike.log` written via `FileManager` (release builds
   don't pipe console.log or print() to syslog reliably).
4. `xcrun devicectl device process launch -e '{"MENTRA_RUN_JSC_BENCH":
   "1"}' com.mentra.mentra` to trigger.
5. `xcrun devicectl device copy from --domain-type appDataContainer
   --domain-identifier com.mentra.mentra --source Documents/jsc-spike.log`
   to pull the result.

The full pipeline is reproducible — re-run anytime to validate on new
devices.

**Caveats from the spike:**
- Workload was idle (timer + small state). Real miniapp heap will be
  bigger; budget ~3-5 MB/context once `fetch`/`WebSocket` shims are
  added (those hold native NSURLSession instances).
- Foreground only. iOS may compress idle JS heaps in background, may
  suspend timers. Phase 1.5b: 24-hour background soak under realistic
  load before declaring Phase 4 unblocked.
- iPhone SE 2/3 not yet measured. Should be similar order of magnitude
  but verify before committing on lower-RAM devices.

### Phase 1.5b — 24-hour background soak (1 day)

**Goal:** Verify N=10 contexts survive iOS background suspension cycles
under realistic load (BLE events, occasional XHR, periodic timers).

Tasks:
- Wire one of the synthetic JSContexts to receive real BLE events
  via the existing dispatch bridge (so it's not pure-idle).
- Add a fake fetch every 60 s (real NSURLSession HTTP request).
- Background the host app for 24 hours.
- Pull `Documents/jsc-spike.log` periodically (via launch + immediate
  copy-from) and check that the contexts are still alive + responsive.

If they survive → Phase 4 unblocked.
If contexts die or get suspended in unexpected ways → adjust the
architecture (heartbeat, wake-on-event, etc) before scaling to N.

### Phase 2 — WebView binding (2 weeks)

**Goal:** A WebView spawned on demand can talk to its bound JSContext
via `mentra.send/on` — a typed, live, bidirectional message bus.

**This is novel work, not Pebble-validated.** Pebble's WebView model is
one-shot URL redirect (`Pebble.openURL(url)` → user-facing settings page
→ user clicks Save → page redirects to `pebblejs://close#<json>` → host
intercepts navigation → calls `signalWebviewClosed(data)` back into JS).
That works but is too coarse for the kind of settings UIs we want to
support (real-time previews of glasses display, live device status,
streaming transcription previews).

**Decision: ship the live message bus from v1.** We are committing to
writing this correctly once. Reasoning:

- Engineers are excited to port cloud miniapps to local; that means real
  SPAs (React/Vue/Svelte), not form-submit pages. They WILL need a
  live channel.
- Adding the bus later means re-architecting every miniapp that already
  shipped on the v1 URL-redirect model. Painful migration.
- The bus is novel but bounded: ~500 lines of TS + Swift. Pebble didn't
  build it because their use case (config = one-time-saved settings)
  didn't need it; ours does.
- Tradeoff: we accept ~1 extra week of dev time + more bugs to hunt in
  exchange for an SDK that actually fits the use case from day one.

Tasks:
- Update `LocalMiniappRuntime` to spawn WebView fresh on user navigation
  to a miniapp's settings, destroy on exit. No pooling.
- Native router (`MentraNativeBus`): given a WebView and a miniapp ID,
  routes `webkit.messageHandlers.mentra` messages to the JSContext's
  `ui.on()` handlers, and routes `ui.send()` outputs back to the
  WebView via `evaluateJavaScript("window.__mentra.recv(...)")`.
- WKUserScript injection: at WebView mount, inject a `window.mentra`
  shim. ~50 lines of JS. Buffers outbound `send()` until `ready()`
  is acked by background (mirroring the `signalReady` protocol from
  background).
- Background `ui.send()` buffers messages while no WebView is bound;
  flushes on `__open__`. WebView `mentra.send()` buffers messages until
  `ready()` ack from background; flushes on ack.
- Heartbeat: WebView sends `__heartbeat__` every 5s; if background
  doesn't see one for 15s, it considers the WebView gone (covers crash/
  navigate-away cases the `__close__` event might miss).
- Sequence numbers on every message + dedup window on receiver, so
  message-bus replays during reconnect don't double-fire handlers.
- Update `MiniappHost.tsx` to support the new lifecycle.
- Port the `Notes` example end-to-end. Verify the round-trip latency
  and the message bus.
- Acceptance: round-trip "WebView taps button → background runs glasses
  display call → glasses show text" must be <50ms p95 on iPhone 15.

### Phase 3 — SDK packaging (1 week)

**Goal:** Developers can `bun create mentra-miniapp` and ship.

Tasks:
- Split current `@mentra/miniapp` package into two:
  - `@mentra/sdk` — background-only API. Uses `__dispatch` under the
    hood. Exposes `glasses`, `phone`, `buttons`, `ui`.
  - `@mentra/ui-sdk` — WebView-only API. Just exposes typed `mentra.send/
    on/ready` over the auto-injected `window.mentra`.
- Update bundler config (or create a new one) that emits two outputs
  from one source tree: `dist/background.js` and `dist/ui/index.html`
  (+ assets).
- Update `mentra.json` schema to include `background` and `ui` keys.
- Update miniapp dev tooling (`bun run dev`, `bun run release`) to
  build both layers and reload on change.
- Templates: `bun create mentra-miniapp` scaffolds the source tree
  shown above.
- Documentation: a single page laying out the SDK shape, the
  forbidden-things list, and a runnable Notes example.

### Phase 4 — Capability parity (2–3 weeks)

**Goal:** Every native capability that today's WebView SDK has, the new
JSC SDK has too. This is the long tail.

Tasks:
- Mic data subscription (PCM stream)
- Glasses display: text, image, clear, dashboard primitives
- Glasses buttons: click, long-press, swipe events
- Phone notifications: receive, dismiss
- Location: get-once, watch
- Storage: get/set/remove with namespaced per-miniapp scope
- Network: `fetch`, `WebSocket` (using JS shims over native sockets so
  we control the bridge surface)
- Logging: `console.log` → host log stream → Sentry breadcrumbs

Each capability is a small Swift method in `MentraJSDispatcher` plus a
typed wrapper in `@mentra/sdk`. Test each end-to-end with a smoke
miniapp.

### Phase 5 — Migration + deprecation (1–2 weeks)

**Goal:** Existing miniapps either migrate or run on a compatibility
shim. No miniapp left behind on launch day.

Tasks:
- For each existing miniapp on the store, port to the new two-layer
  format. (Mentra-internal apps first, then ping external developers.)
- Compatibility shim: if a miniapp's `mentra.json` lacks a `background`
  key, host treats the miniapp as "WebView-only" and spawns a stub
  background.js that just relays everything to the WebView. This is
  the fallback for old bundles. Mark deprecated; remove after 6 months.
- Remove the old "WebViews persist in background" code path. All
  always-on logic now lives in JSContexts.
- Final acceptance test: stress-test 10+ background miniapps on iPhone
  SE without jetsam. (This is the original goal of the whole project.)

## Total timeline

Sequential: 6–8 weeks. Phases 0 and 1 can run in parallel
(Phase 0 unblocks shipping; Phase 1 is a separate engineer).

If we throw 2 engineers at it: 4–5 weeks.

## Open questions

1. **Should disabled miniapps keep their JSContext alive?** My instinct:
   no, tear it down on disable. Saves memory. JSContext re-spawns on
   re-enable, hydrates from storage.
2. **CPU/memory quotas per miniapp?** Pebble had none. A runaway JS app
   would hang itself but not the host. JSC has no built-in quota. We
   can add a watchdog timer in the Swift dispatcher that aborts a
   miniapp's evaluation if it blocks the JS thread for >N seconds. My
   take: not in v1. Add when it bites.
3. **Multiple simultaneous WebViews?** When? Why? My take: never in v1.
   The product is "user looks at one miniapp's settings at a time."
4. **Notification scheduling from the WebView?** All scheduling goes
   through background. WebView never schedules anything directly.
5. **Hot-reload during development?** Both layers should auto-reload on
   file change. Background reloads = `kill(miniappId) + spawn(...)`
   triggered by `bun run dev` over a websocket to the host app.
   WebView reloads via standard WebView reload trigger.
6. **What does the JSContext do during the iOS suspension window?**
   Nothing — JS execution is paused with the host process. When the
   host wakes (BLE event arrives), JS resumes mid-task. State is
   preserved. The dev sees their `setInterval` callbacks firing slightly
   irregularly when the host was paused — same as today. Document this.
7. **Inter-miniapp communication?** Out of scope for v1. If miniapp A
   needs to wake miniapp B, it goes through the host (e.g. notification,
   then user opens B). No direct miniapp-to-miniapp messaging.
8. **Versioning the bridge.** Every `mentra.json` declares `sdkVersion`.
   Host refuses to spawn miniapps targeting an SDK version it doesn't
   support. Bump when we change the bridge contract.

## Success criteria

We've succeeded when:
- 10+ miniapps can run simultaneously in background on iPhone SE 2
  (3 GB RAM) without jetsam.
- WebView open-to-render latency is <500 ms (p95).
- A developer can `bun create mentra-miniapp` and ship a working
  miniapp to the store in under 30 minutes.
- We've passed at least one App Store review with the new architecture.
- Existing miniapps run via the compatibility shim with no developer
  changes required.

## Decision log

- **2026-05-09:** Decided against Maestro for the stress test harness;
  use deeplinks + autorun instead.
- **2026-05-09:** Decided against pre-warming WebView pool. Spawn fresh
  per open; cold-mount latency (~300 ms) is acceptable for a settings
  sheet.
- **2026-05-09:** Decided against `@callstack/react-native-sandbox`.
  Pre-1.0, one-person bus factor, no Expo support, ~15-30 MB per
  sandbox vs ~5 MB for raw JSC.
- **2026-05-09:** Decided against Workers-in-shared-WebView. Workers
  have no DOM and can't render UI; native bridging is two-hop;
  one-process-many-Workers means one bug jetsams them all.
- **2026-05-09:** Decided FOR a Pebble-style native JSC architecture.
  Best memory profile, proven at WeChat scale, Apple-precedent through
  WeChat/Pebble/RN/CodePush, narrow bridge surface keeps 4.7.2 risk
  manageable.
- **2026-05-09 (v2):** After verifying against Pebble's actual code,
  flagged that **Pebble has not validated the N-concurrent-context
  model** — they run one PKJS context at a time. We're extrapolating.
  Added Phase 1.5 as a blocking benchmark before Phase 4.
- **2026-05-09 (v2):** After verifying against Pebble's actual code,
  flagged that **our live-message-bus WebView model is novel** —
  Pebble does one-shot URL redirect. Phase 2 includes both: our richer
  bus AND a simpler URL-redirect path for compatibility.
- **2026-05-09 (v2):** Added all the Pebble-inherited "small" pieces
  that aren't optional: `JSManagedValue`, `evalCatching`, `console.*`
  rewiring, `window.onerror`, `signalReady` with NACK timeout,
  `JSContext.setName`/`setInspectable`, log redaction, tear-down race
  ordering, `debugForceGC`, stable per-(user, miniapp) token. All in
  Phase 1 scope.
- **2026-05-09 (v3):** Locked in live message bus from v1 (not URL
  redirect), added "Writing this once, correctly" section. We get one
  chance to set the SDK contract; engineers porting cloud miniapps
  need real-time channels.
- **2026-05-09 (v4):** Phase 1.5 spike completed: 0.75 MB per JSContext
  on iPhone 15 release. 50-context wave added 37 MB total. Architecture
  validated. The N-context risk flagged in v3 is resolved.
