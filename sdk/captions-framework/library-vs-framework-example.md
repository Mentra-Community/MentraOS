# Library + Convention vs Framework: a worked example

**Status:** Draft, follow-up to library-vs-framework.md
**Audience:** Cloud and miniapp engineering, leadership

The team's pushback on the framework proposal is that "logic in `glasses-controller.ts` plus a good template" gives us the same outcome with less platform burden. This doc tests that claim against a real app, written both ways. The point is not which version has fewer lines. The point is what each version makes possible and impossible.

## The runtime model changes the calculus

Before the code, frame this. The client team is proposing to run miniapp code in a single WebView per miniapp, kept alive permanently while the miniapp is installed. When the user navigates away, the body is hidden or the DOM is frozen. The JS context keeps running. Subscriptions stay alive. Module-scope state persists.

This is a clever choice. It avoids IPC, makes state persistence cheap, and keeps subscription continuity working without a separate phone-side runtime. But it has a consequence that is easy to miss: **the JavaScript context now outlives the user's perceived session.** The WebView is alive for hours or days. A subscription registered at module scope lives that long. A captured value in a closure lives that long. A leaked Provider that creates a second `MiniappSession` lives forever.

Three runtime models the framework should be agnostic to:

1. **Same WebView, single JS context.** What the client team is proposing. `client/` and `webview/` are different folders in the source but the same JavaScript context at runtime.
2. **Separate WebViews.** A long-lived hidden WebView for `client/`, a visible WebView for `webview/`. They talk via postMessage.
3. **JS runtime separate from WebView.** `client/` runs in JSCore, Hermes, or V8. `webview/` is a WebView.

Today's target is Option 1. The framework's job is to make the developer's code work correctly under all three, so we can change the platform's runtime model later without rewriting apps.

This runtime model strengthens the case for the framework's structural split. Under "WebView always alive," every anti-pattern in the library version below gets amplified because mistakes that used to die with the WebView now persist indefinitely. The framework's `client/` versus `webview/` split is the explicit lifecycle contract that matches the implicit runtime decision. Without the split, every developer has to internalize platform-internal lifecycle behavior to write correct code.

## The app

A captions miniapp. Subscribes to glasses transcription. Maintains an interim/final utterance lifecycle with diarization (speaker IDs). Formats the most recent transcripts into HUD lines using a configurable `displayLines` setting (2 to 5). Sends the formatted lines to the glasses display. Renders the same lines in the webview as a HUD preview that visually mimics the glasses display, then below that a scrolling transcript history showing every finalized utterance plus the current interim line in italic.

One setting: a slider for `displayLines`.

### Real transcription behavior the example handles

`session.transcription.on(handler)` fires repeatedly with chunks like:

```ts
{ text: string, isFinal: boolean, utteranceId?: string, speakerId?: string }
```

During an utterance, you receive a stream of interim chunks (each a longer prefix of the same utterance), then exactly one final chunk that locks the utterance in. Interim and final for the same utterance share the same `utteranceId`. With diarization on, each chunk carries a `speakerId`. New speaker means a new utterance from a different person.

Note: `@mentra/miniapp`'s current `TranscriptionData` lacks `utteranceId` and `speakerId` (the cloud SDK has both). The example casts at the boundary and treats both as optional. Adding the fields to `@mentra/miniapp` is a non-breaking change that should happen separately.

What the app deliberately does not do: font size (no such control on real glasses), color (G1 is monochrome), camera (no use here), backend (no per-user server logic).

## Framework version

```
captions-framework/
  mentra.config.ts        single declarative config
  shared/types.ts         types and CHARS_PER_LINE constant
  client/index.ts         phone-side runtime: subscribe, format, display, expose RPCs
  webview/                React UI
    main.tsx
    App.tsx
    index.html
  package.json
  tsconfig.json
```

About 130 lines of user code. The full source is in this folder. The key file is `client/index.ts`, which owns the interim/final lifecycle and rendering:

```ts
import {session, state} from "@mentra/miniapp/framework"
import {CHARS_PER_LINE, type AppState, type TranscriptionEvent, type UtteranceEntry} from "../shared/types"

state.init<AppState>({
  history: [],
  interim: null,
  displayLines: 3,
  preview: [],
})

function formatUtterance(u: UtteranceEntry): string {
  return u.speakerId ? `[${u.speakerId}]: ${u.text}` : u.text
}

function formatHudLines(history: UtteranceEntry[], interim: UtteranceEntry | null, maxLines: number): string[] {
  const utterances = interim ? [...history, interim] : history
  const allLines: string[] = []
  for (const u of utterances) {
    const formatted = formatUtterance(u)
    for (let i = 0; i < formatted.length; i += CHARS_PER_LINE) {
      allLines.push(formatted.slice(i, i + CHARS_PER_LINE))
    }
  }
  return allLines.slice(-maxLines)
}

function render(): void {
  const lines = formatHudLines(
    state.get<UtteranceEntry[]>("history"),
    state.get<UtteranceEntry | null>("interim"),
    state.get<number>("displayLines"),
  )
  state.set("preview", lines)
  session.display.showText(lines.join("\n"))
}

function applyTranscription(data: TranscriptionEvent): void {
  const speakerId = data.speakerId ?? ""
  const interim = state.get<UtteranceEntry | null>("interim")

  if (data.isFinal) {
    const utteranceId = data.utteranceId ?? interim?.utteranceId ?? makeId()
    state.set("history", [...state.get<UtteranceEntry[]>("history"), {utteranceId, speakerId, text: data.text}])
    state.set("interim", null)
  } else {
    const sameUtterance =
      interim != null &&
      ((data.utteranceId !== undefined && data.utteranceId === interim.utteranceId) ||
        (data.utteranceId === undefined && speakerId === interim.speakerId))

    if (sameUtterance && interim) {
      state.set("interim", {...interim, text: data.text})
    } else {
      if (interim) {
        // Speaker switched; commit the unfinalized previous interim.
        state.set("history", [...state.get<UtteranceEntry[]>("history"), interim])
      }
      state.set("interim", {utteranceId: data.utteranceId ?? makeId(), speakerId, text: data.text})
    }
  }
  render()
}

session.onReady(() => {
  session.transcription.on((data) => applyTranscription(data as unknown as TranscriptionEvent))
})

export function setDisplayLines(n: number): void {
  if (n < 2 || n > 5) throw new Error("displayLines must be between 2 and 5")
  state.set("displayLines", n)
  render()
}
```

The webview is three components reading reactive state: `GlassesPreview` renders `mentra.state.preview` in the green-on-black HUD style; `SettingsPanel` is the slider; `TranscriptHistory` shows every finalized utterance plus the current interim line in italic. None subscribe to anything. They consume snapshots from `useMentra()`.

There is no manual subscription, no manual cleanup, no `useEffect` for runtime behavior, no `subscribe`/`notify` bridge. The webview cannot import `session`. The runtime is not in scope there, by construction.

## Library plus convention version

Same app. Following the team's proposed convention: "put glasses logic in `glasses-controller.ts`, recommend that pattern in the template."

```
captions-library/
  miniapp.json
  index.html
  server.ts                        Bun static host
  src/
    main.tsx
    App.tsx
    glasses-controller.ts          all session/runtime logic, per convention
    types.ts
    components/
      GlassesPreview.tsx
      SettingsPanel.tsx
  package.json
  tsconfig.json
```

About 200 lines of user code, plus a hand-rolled subscribe/notify bridge that every library-shape app has to invent. See `../captions-library/` for the full source. The key file:

```ts
// src/glasses-controller.ts
import {MiniappSession} from "@mentra/miniapp"
import {CHARS_PER_LINE, type TranscriptionEvent, type UtteranceEntry} from "./types"

export const session = new MiniappSession()

let settings = {displayLines: 3}
let history: UtteranceEntry[] = []
let interim: UtteranceEntry | null = null
let currentPreview: string[] = []
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((cb) => cb())

function formatHudLines(/* same shape as the framework version */): string[] {
  /* ... */
}

session.connect().then(() => {
  // Senior dev pulls `displayLines` into a local const at the top of
  // handler setup for readability. This is the bug.
  const {displayLines} = settings

  session.transcription.on((rawData) => {
    const data = rawData as unknown as TranscriptionEvent
    // ... maintain history/interim from chunk ...
    currentPreview = formatHudLines(history, interim, displayLines) // STALE
    session.layouts.showTextWall(currentPreview.join("\n"))
    notify()
  })
})

export function getSettings() {
  return settings
}
export function getHistory() {
  return history
}
export function getInterim() {
  return interim
}
export function getPreview() {
  return currentPreview
}
export function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function setDisplayLines(n: number) {
  settings = {...settings, displayLines: n}
  // Re-render directly with `n`, so the slider appears to work
  // immediately. Until the next transcription chunk overwrites
  // currentPreview using the stale captured `displayLines`.
  currentPreview = formatHudLines(history, interim, n)
  session.layouts.showTextWall(currentPreview.join("\n"))
  notify()
}
```

Three components subscribe via the hand-rolled bridge: `GlassesPreview`, `SettingsPanel`, `TranscriptHistory`. Each calls `useEffect(() => subscribe(...), [])` to fan out per-chunk state changes into React state setters.

This compiles. It runs. It is reasonable code. The developer followed the convention.

It also has five latent failure modes the convention does not prevent.

## What silently breaks in the library plus convention version

Under the proposed "WebView always alive" runtime model, every one of these is amplified. The JavaScript context lives for hours or days. Mistakes that used to die with the WebView now persist for the lifetime of the install.

### 1. Subscription registered after `connect()` resolves

`session.transcription.on(...)` is registered inside `.then(() => ...)` after `connect()`. Whether early transcription frames are buffered or dropped depends on the transport implementation. The dev cannot tell whether they will be lost without reading the transport implementation.

The framework version handles this because `session.onReady()` is the platform's job, not the developer's.

### 2. Each component subscribes independently

Two components mount, two `subscribe(...)` calls, two closures in `listeners`. Every transcription chunk fires every closure. Add a third component (a notifications badge, a status indicator) and the fan-out scales linearly with components, not with state changes. Under "WebView always alive," this fan-out runs continuously for the lifetime of the install.

The framework version subscribes once at the runtime layer and pushes state changes via the platform's reactive update path.

### 3. Module-scope state has no persistence

Settings, current transcript, and current preview all live in JS module scope inside the WebView's bundle. If the WebView dies (memory pressure, forced kill, app update), the module re-initializes and all state is lost. Under "WebView always alive" the WebView rarely dies, so this rarely manifests, but when it does the user sees their settings reset and their transcript empty.

The fix the developer would invent: hand-roll persistence by calling `session.simpleStorage.set("displayLines", ...)` and rehydrating on connect. Cross-account leakage is a separate hazard the API does not warn about.

The framework version's state primitive persists through phone-side storage automatically.

### 4. Stale closure on settings inside the subscription handler

The most damaging item, and the one the demo lands on.

The dev moves settings into a struct because they expect to add more settings later (language, hints). Then for readability, they destructure at the top of the handler setup:

```ts
session.connect().then(() => {
  const {displayLines} = settings // captured at handler registration
  session.transcription.on((data) => {
    // ... maintain history/interim from chunk ...
    currentPreview = formatHudLines(history, interim, displayLines) // STALE
    session.layouts.showTextWall(currentPreview.join("\n"))
    notify()
  })
})
```

This is correct JavaScript. The destructured `displayLines` is captured at the moment `session.connect().then(...)` resolves. It does not update when the user changes the setting via the webview.

When the user moves the slider from 3 to 5, two things happen on different code paths:

- `setDisplayLines()` formats the preview using the parameter `n` directly (not the closure), so the HUD briefly shows 5 lines as soon as the slider moves.
- The webview slider position updates correctly because every render reads `getSettings().displayLines` fresh.

So the slider appears to work. Then the next transcription chunk arrives. The handler overwrites `currentPreview` using the stale captured `displayLines = 3`. The HUD snaps back to 3 lines. On every subsequent chunk it stays at 3.

The user moves the slider to 5, the HUD flashes to 5 lines, then collapses back to 3 the moment someone speaks. They move it again. Same flicker. They give up and report "the lines setting is broken."

The dev does not see this in development because:

- The webview UI looks right (slider position, settings display).
- The setDisplayLines path apparently works.
- They are not paired to glasses with active speech while iterating.

The bug ships. It is reproducible only when paired to glasses, the user changes the setting, and speech keeps coming in. The fix is to read `settings.displayLines` directly inside the handler instead of destructuring once.

The library cannot warn that the destructured const is wrong; both versions are correct JavaScript.

The framework version reads `state.get("displayLines")` inside the handler. There is no module-scope variable to capture, no destructure that begs to happen. The dev would have to deliberately pull `state.get(...)` out into a captured const above the handler, which is a visibly suspicious pattern.

### 5. Multi-Provider creates duplicate sessions

A future feature adds a `<DevModeProvider>` for testing, then a `<MentraSessionProvider>` for multi-user scenarios. They nest. Two `MiniappSession`s exist at runtime. Both connect. Most of the app uses one, the test subtree uses the other. Bug reports about "transcription works in main view but not in test screen."

Under "WebView always alive," the leaked second session lives for the lifetime of the install. Garbage collection cannot reclaim it because it is reachable from React context. The leak compounds across feature additions.

The framework version has no Provider for the runtime. There is one runtime, owned by the platform, surfaced through `useMentra()`. Multiple Providers are not possible because the runtime is not Provider-scoped.

## The pattern under all five

In every case, the convention says **where code goes**. The bugs are about **call shape and data flow**:

- timing (when a subscription is registered relative to when events fire)
- identity (what counts as "the same" subscription, the same session, the same closure)
- lifetime (how long state lives relative to UI mount)
- multiplicity (how many of something exists)
- value capture (what gets closed over and when)

A file convention can put code in `glasses-controller.ts`. It cannot enforce any of these axes.

## The bridge problem

Look closely at what the library plus convention version had to invent: a bridge between `glasses-controller.ts` and React. The dev wrote a `subscribe` function, a listeners set, a `notify` function, and per-component `useEffect(() => subscribe(...), [])`.

That bridge does not exist in the framework version. `useMentra()` returns a value the platform keeps current. The dev does not subscribe, does not notify, does not invent a coordination layer.

This is not "the framework gives you a fancy reactive store." It is that the convention version forces every developer to invent the bridge, and there are at least three plausible inventions:

1. Hand-rolled subscriber set, as shown above. Easiest to understand, easiest to get wrong.
2. Zustand or a similar small store library. Removes some bug classes (immutability, selector-based re-renders) but introduces dependency choice as a thing every miniapp picks differently.
3. Custom hook that wraps the controller with `useSyncExternalStore`. The most correct version. Almost no developer will write this from scratch.

Three different bridges across three apps in the ecosystem means the platform team debugging issues has to learn three different idioms, and shared tooling cannot assume any one of them.

Convention says "put logic in `glasses-controller`." It does not say "and here is the canonical bridge to React." So every app gets its own bridge.

## When does convention work

Conventions enforce successfully when all three of the following hold:

1. Audience shares a mental model. Express works because Express developers share "middleware around HTTP." The audience that will write code against MentraOS is enterprise customers integrating us into their products, OEM partner engineering teams building their own apps, and the customers of those OEMs building on what is internally MentraOS. Three populations with three different default mental models, all writing production code.

2. Structural complexity is low. Express is one tier. Our problem is three tiers (phone runtime, webview UI, optional cloud server) with protocol invariants between them.

3. There is a feedback loop on convention violations. Code review by people who know the conventions, accumulated team lore, hiring filters. We do not have any of those for code written by enterprise customers, OEM engineering teams, or OEM partner customers. We never see most of that code.

When the feedback loop is missing, every convention violation that ships becomes a support ticket that escalates back to us through enterprise contracts, OEM partnership agreements, or customer support. Every category of mistake the convention does not prevent is a category of tickets we will own at scale. Convention as a delivery mechanism for protocol invariants does not survive contact with a population we cannot review.

## Version drift

A team member might say: "fine, when we discover a new anti-pattern, we update the template, and new apps follow it."

Two failures:

First, existing apps do not migrate. Every miniapp is locked at the template version it was scaffolded from. Five years in, the ecosystem has apps written against five generations of conventions, each subtly different. There is no version field to inspect, no codemod to run, no enforced upgrade path. There is just a paragraph in `README.md` history that someone read on a Tuesday.

Second, we cannot tell which generation a given codebase is on. "Convention v3" and "convention v4" are two paragraphs of docs.

Frameworks ship versioned conventions with codemods. Templates ship a snapshot that drifts.

## The forward migration the framework absorbs

If the platform later moves from Option 1 (same WebView) to Option 2 or 3 (separated runtimes), the framework boundary becomes a process boundary mechanically. The developer's code does not change.

- `mentra.client.setDisplayLines(n)` was a direct function call inside one JS context. It becomes RPC over a transport. Same syntax, same types, same call site.
- `state.set("displayLines", n)` was a write to a shared in-process store. It becomes a synchronized write across processes. Same API.
- The transcription subscription was a JS-level event handler. It becomes a subscription on a per-runtime queue. Same registration call.

The framework absorbs the platform runtime change. Apps that were correct under Option 1 stay correct under Option 2 or 3. There is no migration cost on the developer's side.

Without the framework, every app written against "library plus convention" encodes assumptions about Option 1 (specifically, that `glasses-controller.ts` and React components are in the same JS context, that closures shared between them work, that `import` from glasses-controller into components gives a real reference). When the platform moves, every assumption breaks. Migration becomes a per-app rewrite.

## The strategic question

The library plus convention path optimizes for a population of code we will see and review. The framework path optimizes for a population of code we will not see.

The OEM and Series A thesis says we are pitching MentraOS as a platform to enterprise customers and OEM partners. Their engineering teams will build on top of us. Their customers will build on top of them. None of that code passes through our review process. The volume of production code calling our platform will not be written by us.

If we own the support burden for code we cannot review, the cost of every bug class the convention does not prevent is a category of escalations through enterprise contracts and OEM partnership agreements. The framework eliminates entire categories of those escalations structurally, by making the bugs not expressible in the first place.

If the strategic story is "we own a platform that enterprise customers and OEM partners build on," the framework conclusion follows from it. If the strategic story is "we maintain a small reviewed surface area," the library plus convention path is fine.

## What I want from the next conversation

Read the two versions of the code in this folder and `../captions-library/`. Sit with the five items in "what silently breaks." Anti-pattern #4 is the one to focus on: in the library version, move the slider while someone is speaking, watch the HUD flash to the new line count then snap back to the old one on the next word. Look at `glasses-controller.ts`, see that the bug is one destructure away.

If your reaction is "yes, those are real, but a good dev would catch them," we are betting we will catch them, which means we are betting on reviewing the code. If your reaction is "those would ship to production and we would not see them until enterprise customers complained," we are betting on a population of code we do not see, and the framework is the contract that lets us not see it.

That is the call. It is not about complexity, flexibility, or maintenance burden. Both versions have those tradeoffs. It is about which support burden we are willing to live with at scale.
