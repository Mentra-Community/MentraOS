# Miniapp implementation rules

## Two layers

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

## UI layout

The UI WebView fills the whole phone screen. It runs under the status bar, the
home indicator, and the Mentra App's capsule menu (the floating control in the
top-right corner). `src/ui/App.tsx` shows the expected setup.

- Pad the root element by `useSafeArea().insets` on all four sides.
- Render page headers with `<MiniappHeader>` from `@mentra/miniapp/ui`. It
  lines the header up with the capsule menu and keeps content out from under
  it. Never put buttons or other controls under the capsule menu; taps there
  go to the Mentra App. For a custom header, spread `useCapsuleHeaderStyle()`
  onto it instead.
- Paint the page background on `html` and `body`, not only on an inner
  container. That color is what shows behind the status bar and the home
  indicator.
- Define both light and dark colors. The status-bar text follows the Mentra
  App's theme, and `<MentraProvider>` mirrors it as `<html class="dark">`.
  Read it in JavaScript with `useColorScheme()`. Do not hardcode a single
  scheme.

Reference: https://docs.mentraglass.com/app-devs/core-concepts/webviews/safe-areas

## Back navigation

The phone's back gesture (iOS edge swipe, Android back) runs `history.back()`
in the UI WebView. When the WebView has no history left, the Mentra App
minimizes the miniapp. Anything the user can go back from must push a history
entry.

- For pages, use a router in hash mode: react-router's `HashRouter`, or wouter
  with `useHashLocation`. Do not use `MemoryRouter`, `createMemoryRouter`, or
  wouter's `memoryLocation`.
- For tabs, dialogs, sheets, pickers, and multi-step flows, use
  `useHistoryState(key, initial)` from `@mentra/miniapp/ui` instead of
  `useState`.
- A back button in your own UI calls `history.back()`. It does not navigate
  forward to the parent route.

Reference: https://docs.mentraglass.com/app-devs/core-concepts/webviews/back-navigation

## Identity

- Replace `icon.png` with an icon designed for this miniapp: a square PNG, at
  least 512x512. The template ships a generic glasses placeholder, and
  `mentra-miniapp dev` and `release` warn while it is still in place.
- If you cannot create an image file, say so in your final message: tell the
  user that `icon.png` is still the template placeholder and needs replacing.
- Set `name` and `description` in `miniapp.json` to describe the miniapp.

## Development

- Use `bun run dev` while building and testing. Scan its QR code once. After
  that, every saved change rebuilds and reloads on the phone without a rescan.
  Several dev miniapps can coexist when they use distinct manifest package
  names.
- Use `bun run release` only for a persistent install that runs without the
  development computer. A release install is a fixed snapshot: each change
  needs another `bun run release` and another scan.
