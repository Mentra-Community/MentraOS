# Two-layer miniapp architecture

This page documents the **two-layer miniapp model**. If you're writing
a new miniapp, use this layout. The older single-bundle WebView pattern
still works but is being phased out.

## Why two layers

Each running miniapp had its own persistent WebKit/WebView process —
~80–150 MB per backgrounded miniapp. iPhone SE (3 GB RAM) jetsam'd
within a second after about 10 of them were spawned. The fix:

- **Background layer** (always-on, no DOM) — a per-miniapp JS context
  on JavaScriptCore (iOS) / QuickJS via Zipline (Android). 0.75–5 MB
  per context. Owns all glasses logic.
- **UI layer** (on-demand, full DOM) — a fresh WebView spawned when
  the user opens the miniapp's settings; destroyed on exit. No
  persistent off-screen state. Standard React + Tailwind + DOM, but
  zero direct native access — talks to its own background layer
  through a typed message bus.

## Background runtime contract

The background is not a browser and not Node. Do not rely on an API just
because TypeScript or Bun accepts it during a build. MentraOS explicitly
provides `console`, timers (`setTimeout`, `setInterval`, and
`queueMicrotask`), `fetch`, `WebSocket`, per-miniapp `localStorage`,
`crypto.getRandomValues`, `crypto.randomUUID`, `TextEncoder`, `TextDecoder`,
`atob`, `btoa`, and the SDK-supported `AbortController` subset.

It does **not** provide `window`, `document`, DOM elements, `performance`,
`XMLHttpRequest`, `crypto.subtle`, Node built-ins (`fs`, `path`, and so on),
`process`, or a runtime module resolver. Use `Date.now()` for elapsed time.

Keep `session.*` calls, hardware subscriptions, durable state, and work that
must survive UI closure in `src/background/`. Keep rendering, browser APIs,
and UI-only libraries in `src/ui/`. Pass serializable data between them over
the typed message bus.

## File layout

```
my-miniapp/
├── miniapp.json
├── src/
│   ├── background/           # JSContext entry — always running
│   │   ├── index.ts          # exports init(session)
│   │   └── controllers/      # optional — split logic here as it grows
│   ├── ui/                   # WebView entry — opens on demand
│   │   ├── index.html
│   │   ├── main.tsx          # mounts <App/>, calls mentra.ready()
│   │   └── App.tsx
│   └── shared/
│       ├── channels.ts       # typed channel registry — both sides import
│       └── types.ts          # cross-boundary types
└── dist/                     # output of `bun run build`
    ├── background/index.js
    └── ui/index.html + assets
```

`miniapp.json` declares both entries:

```json
{
  "packageName": "com.example.notes",
  "version": "1.0.0",
  "name": "Notes",
  "type": "standard",
  "sdkVersion": "0.3.0",
  "minHostVersion": "1.42.0",
  "entry": {
    "background": "dist/background/index.js",
    "ui": "dist/ui/index.html"
  },
  ...
}
```

## Sub-paths in @mentra/miniapp

The SDK ships two sub-paths under one package:

- **`@mentra/miniapp/background`** — `MiniappSession` + every
  `session.*` module type. Import this in `src/background/`.
- **`@mentra/miniapp/ui`** — `mentra` global declaration + React
  adapters (`MentraProvider`, `useSafeArea`, `useVisibility`,
  `MiniappHeader`, ...). Import this in `src/ui/`.

There is no bare `@mentra/miniapp` import. Sub-paths only. Picking the
wrong side fails at compile time — the `mentra` global isn't visible
from `@mentra/miniapp/background`, and `MiniappSession` isn't visible
from `@mentra/miniapp/ui`.

## Typed channels

`src/shared/channels.ts` is the single source of truth for every
name + payload shape that crosses the WebView ↔ background boundary.

```typescript
import type {MentraTyped} from "@mentra/miniapp/ui"

export interface Channels {
  // background → UI
  "captions:snapshot": {history: string[]}
  // UI → background
  "captions:clear": Record<string, never>
}

declare global {
  var mentra: MentraTyped<Channels>
}
```

Both halves of the build inline this file. There is no runtime
registry — channel names are opaque strings on the wire and only
enforced at compile time.

## Build

```
bun run build
```

Produces `dist/background/index.js` and `dist/ui/*` in a single pass.
The CLI's `mentra-miniapp pack` zips both folders into one bundle.

## Lifecycle

1. **Install** — host downloads bundle, unzips, validates manifest,
   spawns the JSContext, runs `init(session)`. Background is alive.
2. **User opens UI tile** — host creates a fresh WebView, injects the
   `mentra` shim, loads `dist/ui/index.html`. WebView calls
   `mentra.ready()`. `session.ui.onOpen` handlers fire in background.
3. **User navigates away** — host destroys the WebView. JSContext
   stays alive. `session.ui.onClose` fires.
4. **Disable / uninstall** — host calls `session.onBeforeDisconnect`
   handlers, kills the JSContext. Bundle stays unless uninstalled.

## Crash recovery

If background crashes, the host runs the controller's state machine:

- 1st crash → silent respawn after 2s
- 2nd within 5min → restart toast + 8s backoff
- 3rd → 30s backoff
- 4th → CRASHLOOP_DISABLED banner (user "Try again" tap re-enables)

A clean 60s window in `RUNNING` resets the retry counter.

## See also

- [session.ui](./ui.md) — the background-side message bus reference.
- [agents/mentrajs-two-layer-miniapp-architecture.md](../../agents/mentrajs-two-layer-miniapp-architecture.md)
  — full architecture spec, including memory profile and engine choice.
- The example miniapp (`sdk/example-miniapp/`) — canonical
  implementation following Appendix A of the architecture spec.
