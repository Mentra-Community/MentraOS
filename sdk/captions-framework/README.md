# captions-framework

**Design artifact, not yet runnable.** Demonstrates the proposed `@mentra/miniapp` framework shape on a real captions miniapp. Counterpart to `../captions-library/`, which implements the same app with the existing library plus a `glasses-controller` convention.

## What this app does

Subscribes to glasses transcription. Maintains an interim/final utterance lifecycle with diarization (speaker IDs). Formats the most recent transcripts into HUD lines using a configurable `displayLines` setting. Sends the formatted lines to the glasses display, and renders the same lines in the webview as a HUD preview that visually mimics the glasses display.

The webview shows two views of the transcript:

- **HUD preview** at the top: monochrome green, fixed-width, last `displayLines` lines, identical to what is on the glasses right now.
- **Transcript history** below: every finalized utterance plus the current interim (rendered italic + faded). Scrollable.

One setting: a slider for `displayLines` (2 to 5).

## What real transcription looks like

`session.transcription.on(handler)` fires with chunks like:

```ts
{ text: string, isFinal: boolean, utteranceId?: string, speakerId?: string, language?: string }
```

During an utterance, you receive a stream of interim chunks (each a longer prefix of the same utterance), then exactly one final chunk that locks the utterance in. Interim and final for the same utterance share the same `utteranceId`. With diarization on, each chunk carries a `speakerId`. New speaker means a new utterance from a different person.

Note: `@mentra/miniapp`'s `TranscriptionData` does not yet expose `utteranceId` or `speakerId`, although the cloud SDK's equivalent does. The example treats both as optional and falls back to synthesized utterance IDs and dropped speaker prefixes when missing. Adding those fields to `@mentra/miniapp` is a small non-breaking change and a separate tracking item.

## Folder shape

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

About 130 lines of user code total.

## What is happening here

`client/index.ts` registers the transcription subscription at module scope. The handler maintains `history` (finalized utterances) and `interim` (current in-flight utterance, if any). New chunks update the interim or commit it. Speaker switches mid-utterance commit the previous interim so dictated text is not lost. Every chunk re-renders the HUD preview using the current `displayLines` from state.

`webview/App.tsx` is three components: `GlassesPreview` renders `mentra.state.preview` in the green-on-black HUD style, `SettingsPanel` is the slider, `TranscriptHistory` shows the full history with the interim line styled distinctly. None of these subscribe to anything. They consume reactive snapshots from `useMentra()`.

`shared/types.ts` defines the state shape, the `TranscriptionEvent` interface, and `CHARS_PER_LINE`.

`mentra.config.ts` is the only declarative entry point.

## Runtime model and why the split matters

The framework presumes the platform may run miniapp code in any of three ways:

1. **Same WebView, single JS context.** Current target.
2. **Separate WebView for runtime, separate WebView for UI.** Two contexts, postMessage between them.
3. **JS runtime separate from WebView.** `client/` runs in JSCore, Hermes, or V8.

The current proposal from the client team is Option 1 with a twist: the WebView stays alive permanently for installed miniapps. When the user navigates away, the body is hidden or the DOM is frozen. The JS context keeps running, subscriptions stay alive, state persists in module scope.

That changes the lifecycle contract: the JavaScript context now outlives the user's perceived session. A subscription registered at module scope lives for hours or days. A captured value in a closure lives that long. A leaked Provider that creates a second `MiniappSession` lives forever. The framework's `client/` versus `webview/` split is the explicit lifecycle contract that matches that runtime decision.

If we ever change the runtime model later (Option 2 or 3), the developer's code does not change. The folder boundary becomes a process boundary. The framework absorbs the migration.

## What the framework removes from the developer's responsibility

- Manual subscription registration, cleanup, deduplication.
- A bridge between the runtime and the React layer.
- Provider hierarchy, context scoping, session lifecycle.
- Settings persistence (state is in `client/`, persistence is automatic).
- Knowledge of how the platform hosts code today and tomorrow.
- Anti-patterns from `../captions-library/README.md`: each is either not expressible or transparently handled.

## Why this is a design artifact

The framework primitives shown here (`session`, `state`, `useMentra()`, the auto-discovered RPC surface at `mentra.client.*`) are **proposed**. They do not yet exist in `@mentra/miniapp`. The library currently exports `MiniappSession` and `useSession()`. The proposal is to extend `@mentra/miniapp` with a `framework` subpath that exposes these primitives alongside the library surface.

The imports in this folder will not resolve in TypeScript today. That is expected for a design artifact.

## What it would take to make this run

Under Option 1 hosting, the platform work is small:

1. `@mentra/miniapp/framework` exports: `session` and `state` (vanilla JS reactive primitive), built on top of the existing `MiniappSession`.
2. `@mentra/miniapp/framework/react` with `useMentra()` backed by `useSyncExternalStore`. About 30 lines.
3. Build step that walks `client/index.ts` exports and exposes them on `mentra.client.*` in the same bundle. About 50 lines plus type generation.
4. Build-time import rules: `webview/**/*.{ts,tsx}` cannot import `session` or `state` directly; only `useMentra()` from the React subpath.
5. CLI: `mentra dev` and `mentra build` wrappers around the existing Bun build pipeline.

A working version of this example by end of week is achievable.

## Read alongside

- `../captions-library/README.md`: the same app, library shape, with anti-patterns annotated.
- `./library-vs-framework.md`: the proposal.
- `./library-vs-framework-example.md`: the full design doc this code backs.
