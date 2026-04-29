# captions-framework

**Design artifact, not yet runnable.** This folder demonstrates the proposed `@mentra/miniapp` framework shape on a real captions miniapp. Counterpart to `../captions-library/`, which implements the same app with the existing library plus a `glasses-controller` convention.

## What this app does

Subscribes to glasses transcription. Formats the transcript into HUD lines using a configurable `displayLines` setting. Sends the formatted text to the glasses display, and publishes the same formatted text to the webview so the webview can render a HUD preview that always matches what the user sees on the glasses.

The webview has one setting: `displayLines` (2 to 5). Changing it re-renders the preview and the HUD immediately.

## What this app does not do

Anything outside the surface real glasses already support. No font size, no color, no camera, no fancy layouts. The G1 display is monochrome green text. The single setting is the only thing the production captions app exposes that we have here, and we kept just that one to keep the demo focused.

## Folder shape

```
captions-framework/
  mentra.config.ts        single declarative config
  shared/types.ts         types and constants shared across layers
  client/index.ts         phone-side runtime (long-lived, lifecycle-stable)
  webview/                React UI on the phone (mount-scoped)
    main.tsx
    App.tsx
    index.html
  package.json
  tsconfig.json
```

About 75 lines of user code total, including the React preview and settings panel.

## What is happening here

`client/index.ts` registers the transcription subscription at module scope. The handler reads `state.get("displayLines")` fresh every time a chunk arrives, formats the text, writes the formatted lines to `state.set("preview", ...)` (which the webview reads reactively), and calls `session.display.showText(...)` to update the glasses HUD. Same lines on both surfaces.

`webview/App.tsx` is two components: a `GlassesPreview` that renders `mentra.state.preview` in a green-on-black monospace box that mimics the HUD, and a `SettingsPanel` with a slider that calls `mentra.client.setDisplayLines(n)`. The webview never imports `session`, never subscribes to events, never owns mutable state.

`shared/types.ts` defines the state shape and the `CHARS_PER_LINE` constant used by both the formatter (in `client/`) and the preview component (in `webview/`).

`mentra.config.ts` is the only declarative entry point.

## Runtime model and why the split matters

The framework presumes the platform may run miniapp code in any of three ways:

1. **Same WebView, single JS context.** Current target. `client/` and `webview/` are different folders in the source but the same JavaScript context at runtime. The framework polices the boundary at build time.
2. **Separate WebView for runtime, separate WebView for UI.** Two contexts, postMessage between them.
3. **JS runtime separate from WebView.** `client/` runs in JSCore, Hermes, or V8. `webview/` is a WebView. Most decoupling.

The current proposal from the client team is Option 1 with a twist: the WebView stays alive permanently for installed miniapps. When the user navigates away, the body is hidden or the DOM is frozen. The JS context keeps running. Subscriptions stay alive. State persists in module scope.

That hosting trick changes the lifecycle contract: the JavaScript context now outlives the user's perceived session. A subscription registered at module scope lives for hours or days. A leaked Provider that creates a second `MiniappSession` lives forever. The framework's `client/` versus `webview/` split is the explicit lifecycle contract that matches that runtime decision. Long-lived runtime code goes in `client/` (where module-scope persistence is intended). React component code goes in `webview/` (where the framework prevents it from accidentally getting forever-life).

If we ever change the runtime model later (Option 2 or Option 3), the developer's code does not change. The folder boundary becomes a process boundary. The framework absorbs the migration.

## What the framework removes from the developer's responsibility

- Manual subscription registration, cleanup, deduplication.
- A bridge between the runtime and the React layer (the framework owns this).
- Provider hierarchy, context scoping, session lifecycle.
- Settings persistence (state is in `client/`, persistence is automatic).
- Knowledge of how the platform hosts code today and tomorrow.
- Anti-patterns from `../captions-library/README.md`: each is either not expressible or transparently handled.

## Why this is a design artifact

The framework primitives shown here (`session`, `state`, `useMentra()`, the auto-discovered RPC surface at `mentra.client.*`) are **proposed**. They do not yet exist in `@mentra/miniapp`. The library currently exports `MiniappSession` and `useSession()`. The proposal is to extend `@mentra/miniapp` with a `framework` subpath that exposes these primitives alongside the library surface.

The imports in this folder will not resolve in TypeScript today. That is expected for a design artifact. The folder exists so the team can read the framework shape side by side with `../captions-library/`.

## What it would take to make this run

Under same-WebView Option 1 hosting, the platform work is small because there is no IPC layer:

1. `@mentra/miniapp/framework` exports: `session` and `state` (vanilla JS reactive primitive), built on top of the existing `MiniappSession`.
2. `@mentra/miniapp/framework/react` with `useMentra()` backed by `useSyncExternalStore`. About 30 lines.
3. Build step that walks `client/index.ts` exports and exposes them on `mentra.client.*` in the same bundle. About 50 lines plus type generation.
4. Build-time import rules: `webview/**/*.{ts,tsx}` cannot import `session` or `state` directly; only `useMentra()` from the React subpath. ESLint rule or a build-step check.
5. CLI: `mentra dev` and `mentra build` wrappers around the existing Bun build pipeline. Most pieces exist in `cloud/packages/js`; this is largely renaming and wiring.

A working version of this example by end of week is achievable.

## Read alongside

- `../captions-library/README.md`: the same app, library shape, with anti-patterns annotated and how they are amplified under "WebView lives forever."
- `./library-vs-framework.md`: the proposal.
- `./library-vs-framework-example.md`: the full design doc this code backs.
