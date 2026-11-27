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
bun run dev             # develop: scan once, then every save reloads on the phone
bun run dev:production  # try the production build, the one users will get
bun run build           # build both layers into dist/
```

Use `bun run dev` while you build. Scan its QR code once; after that each saved
change rebuilds and reloads on the phone, with no rescan. The Mentra App keeps
one dev entry per manifest package name, so you can test several dev miniapps
side by side.

`bun run dev:production` serves the production build, the one `bun run pack`
writes, from your computer in the same way. Nothing is watched: after a change,
run it again, and the phone takes the new build the next time it opens the
miniapp. Use it to try what users will get before you publish.

## Before you share it

- Replace `icon.png` with your own square icon (at least 512x512).
- Set `name` and `description` in `miniapp.json`.
