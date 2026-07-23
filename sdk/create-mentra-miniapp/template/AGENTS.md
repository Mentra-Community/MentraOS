# Miniapp implementation rules

- Put glasses subscriptions, `session.*` calls, durable state, and logic that
  must survive UI closure in `src/background/`.
- Put React, rendering, DOM access, and browser UI libraries in `src/ui/`.
- The layers do not share memory. Exchange serializable data through the typed
  `mentra.*` / `session.ui.*` channels declared in `src/shared/channels.ts`.
- The background is a bare JavaScript engine, not a browser or Node. Supported
  globals are `console`, timers, `queueMicrotask`, `fetch`, `WebSocket`,
  `localStorage`, `crypto.getRandomValues`, `crypto.randomUUID`, `TextEncoder`,
  `TextDecoder`, `atob`, `btoa`, and the SDK-supported `AbortController` subset.
- Do not use `window`, `document`, DOM elements, `performance`,
  `XMLHttpRequest`, `crypto.subtle`, Node built-ins, `process`, or runtime module
  resolution in `src/background/`. Use `Date.now()` instead of
  `performance.now()`.
- `bun run dev` is live and temporary. Multiple dev miniapps can coexist when
  they use distinct manifest package names. Use `bun run release` for a
  persistent local install that runs without the development computer.
