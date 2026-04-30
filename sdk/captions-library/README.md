# captions-library

**Design artifact.** This folder demonstrates the existing `@mentra/miniapp` library plus the proposed-template approach: "put glasses runtime logic in `glasses-controller.ts`, recommend that pattern in the template."

This is the same app as `../captions-framework/`, written by a senior React developer faithfully following the convention. It compiles. It is reasonable code.

It also has five anti-patterns the convention does not prevent. They are annotated inline by number. The most important is #4 (stale closure on settings), which manifests only when paired to glasses, the user changes the slider, and they keep speaking. The kind of bug that ships green code review.

## What this app does

Subscribes to glasses transcription. Maintains an interim/final utterance lifecycle with diarization. Formats the most recent transcripts into HUD lines using a `displayLines` setting (2 to 5). Sends formatted lines to glasses display. Renders the same lines in the webview as a HUD preview. Below the preview, a settings slider; below that, a scrolling transcript history showing every finalized utterance plus the current interim line in italic.

## What real transcription looks like

`session.transcription.on(handler)` fires repeatedly with `{ text, isFinal, utteranceId?, speakerId? }`. Interim chunks for the same utterance share `utteranceId`. The final chunk locks the utterance in. With diarization on, each chunk carries a `speakerId`.

`@mentra/miniapp`'s current `TranscriptionData` lacks `utteranceId` and `speakerId` (the cloud SDK has both). The example casts at the boundary and treats both as optional. Adding the fields to `@mentra/miniapp` is a non-breaking change worth doing separately.

## Folder shape

```
captions-library/
  miniapp.json
  index.html
  server.ts                        Bun static host (not a backend)
  src/
    main.tsx
    App.tsx
    glasses-controller.ts          all session/runtime logic, per convention
    types.ts
    components/
      GlassesPreview.tsx
      SettingsPanel.tsx
      TranscriptHistory.tsx
  package.json
  tsconfig.json
```

About 200 lines of user code, plus a hand-rolled subscribe/notify bridge that every library-shape app has to invent.

## How the proposed runtime model amplifies these anti-patterns

The current proposal from the client team is to run miniapp code in a single WebView per miniapp, kept alive permanently while installed, with the body hidden when the user is not viewing it. The JavaScript context lives for hours or days. Module-scope state persists. Subscriptions registered at module scope persist.

Under that runtime model, every anti-pattern below gets worse:

- A subscription registered at module scope used to die when the WebView died. Now it survives forever.
- A leaked second `MiniappSession` (anti-pattern #5) does not get garbage collected on navigation.
- Module-scope settings captured into a stale closure (anti-pattern #4) keep using the wrong value for the lifetime of the install.

The framework's `client/` versus `webview/` split is the contract that matches this runtime decision: long-lived code goes in `client/`, webview code is structurally prevented from accidentally getting forever-life. Without that split, "do not write code that leaks under the always-alive WebView" is a rule the developer has to know on every line, with no compile-time help.

## The bridge the developer had to invent

Look at `glasses-controller.ts`. The developer wrote a `subscribe()` function, a `listeners` set, a `notify()` function, and a `useEffect(() => subscribe(...), [])` pattern in every component. That is the bridge between long-lived runtime state and the React tree.

That bridge does not exist in `../captions-framework/`. The framework provides it. Every developer who builds against the library writes this bridge differently. There are at least three plausible inventions:

1. Hand-rolled subscriber set (this version). Easiest to understand, easiest to get wrong.
2. Zustand or a similar small store library. Removes some bug classes, introduces dependency choice.
3. `useSyncExternalStore` directly. Most correct, almost no developer writes it from scratch.

## The five anti-patterns

Each is correct React or correct JavaScript, follows the convention, ships green code review.

### 1. Subscription registered after `connect()` resolves

`session.transcription.on(...)` is registered inside `.then(() => ...)` after `connect()`. Whether early transcription frames are buffered or dropped depends on the transport implementation. The dev cannot tell without reading the transport. See `glasses-controller.ts` line ~22.

The framework version handles this because `session.onReady()` is the platform's job.

### 2. Each component subscribes independently

Three components mount, three calls to `subscribe(...)`. Each closure runs on every transcription chunk. Add a fourth component (status indicator, badge) and the fan-out scales linearly. Under "WebView always alive" this fan-out runs continuously for the lifetime of the install. See `components/GlassesPreview.tsx`, `components/SettingsPanel.tsx`, `components/TranscriptHistory.tsx`.

The framework version subscribes once at the runtime layer and pushes state changes via the platform's reactive update path.

### 3. Module-scope state has no persistence

Settings, history, interim, currentPreview all live in JS module scope inside the WebView's bundle. If the WebView dies (memory pressure, OS forced kill), the module re-initializes and all state is lost: settings reset, transcript empty. Under "WebView always alive" the WebView rarely dies, so this is rare but high-impact.

The fix the developer would invent: persist to `localStorage` or call `session.simpleStorage.set(...)` manually. Now they are hand-rolling persistence. Cross-account leakage is a separate hazard the API does not warn about.

The framework version's state primitive persists through phone-side storage automatically.

### 4. Stale closure on settings inside the subscription handler

The most damaging item.

The dev refactors settings into a struct, then destructures at the top of the handler setup for readability:

```ts
session.connect().then(() => {
  const {displayLines} = settings // captured at handler registration

  session.transcription.on((data) => {
    // ... maintain history/interim ...
    currentPreview = formatHudLines(history, interim, displayLines) // STALE
    // ...
  })
})
```

This is correct JavaScript. The destructured `displayLines` is captured at the moment `session.connect().then(...)` resolves. It does not update when the user changes the setting via the webview.

When the user moves the slider from 3 to 5:

- `setDisplayLines()` formats the preview correctly with the new value (it uses the parameter `n` directly, not the closure), so the HUD briefly shows 5 lines.
- The webview slider position updates correctly (it reads `settings.displayLines` separately on every render).
- Then the next transcription chunk fires the handler. The handler overwrites `currentPreview` using the stale captured `displayLines = 3`. The HUD snaps back to 3 lines.
- Repeat on every chunk. The user sees the slider visually at 5, but the HUD flickers between 5 (when they last touched the slider) and 3 (whenever someone speaks).

The dev does not see this in development because:

- The webview UI looks right (the slider position, the settings panel display).
- The setDisplayLines path apparently works.
- They are not paired to glasses while iterating.

The bug ships. It is reproducible only when paired to glasses, the user changes the setting, and speech keeps coming in. The fix is to read `settings.displayLines` directly inside the handler instead of destructuring once.

The library cannot warn that the destructured const is wrong; both versions are correct JavaScript.

The framework version reads `state.get("displayLines")` inside the handler. There is no module-scope variable to capture, no destructure that begs to happen. The dev would have to deliberately pull `state.get(...)` out into a captured const above the handler, which is a visibly suspicious pattern.

See `glasses-controller.ts` line ~75 for the inline annotation.

### 5. Multi-Provider creates duplicate sessions

A future feature adds a `<DevModeProvider>` for testing, then a `<MentraSessionProvider>` for multi-user scenarios. They nest. Two `MiniappSession`s exist at runtime. Both connect. Most of the app uses one, the test subtree uses the other. Bug reports about "transcription works in main view but not in test screen."

Under "WebView always alive," the leaked second session lives for the lifetime of the install. The leak compounds across feature additions.

The framework version has no Provider for the runtime. Multiple Providers are not possible because the runtime is not Provider-scoped.

## The pattern under all five

The convention says **where code goes**. The bugs are about **call shape and data flow** (timing, identity, lifetime, multiplicity, value capture). A file convention cannot speak to those axes.

## What it would take to make this run

This version is close to running. The library it depends on (`@mentra/miniapp`) exists. The static-file server template is identical to `sdk/example-miniapp/`. A working version is a few hours of plumbing.

We may invest that time so the team can interactively see anti-pattern #4 surface (move the slider, watch the HUD revert on the next word). For today's design conversation, reading the files is enough.

## Read alongside

- `../captions-framework/README.md`: same app, framework shape.
- `../captions-framework/library-vs-framework-example.md`: the full design doc.
- `../captions-framework/library-vs-framework.md`: the proposal.
