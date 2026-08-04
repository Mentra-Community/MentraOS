# Mentra miniapp

This project has two runtimes with different jobs:

- `src/background/` is always on while the miniapp is enabled. Put glasses
  subscriptions, `session.*` calls, durable state, and logic that must keep
  running after the UI closes here.
- `src/ui/` is a normal WebView that exists only while the user has the miniapp
  open. Put React, rendering, DOM access, and browser UI libraries here.

The background is a bare JavaScript engine, not a browser or Node. It supports
`console`, timers, `fetch`, `WebSocket`, `localStorage`,
`crypto.getRandomValues`, `crypto.randomUUID`, `TextEncoder`, `TextDecoder`,
`atob`, `btoa`, and the SDK-supported `AbortController` subset. It does not
support `window`, `document`, DOM elements, `performance`, `XMLHttpRequest`,
`crypto.subtle`, Node built-ins, `process`, or runtime module resolution. Use
`Date.now()` instead of `performance.now()`.

`bun run build` checks background source (including imported shared files) and
reports common unsupported browser or Node APIs with a file, line, and supported
alternative before it emits a bundle.

The layers do not share memory. Exchange serializable data through the typed
`mentra.*` / `session.ui.*` message bus declared in `src/shared/channels.ts`.

## Commands

```bash
bun run dev      # live, temporary; keep the computer and CLI running
bun run release  # persistent local install that runs without the computer
bun run build    # build both layers into dist/
```

The Mentra App keeps one dev entry per manifest package name, so you can scan and
test multiple dev miniapps side by side. It also caches each entry's name and
icon. Rescanning the same package updates that entry. Use `bun run release` when
you want the miniapp to run without the computer.
