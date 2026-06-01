# session.ui — WebView message bus

`session.ui` is the background-side half of the typed message bus a
miniapp uses to talk to its on-demand UI WebView. Inverse of the
`mentra` global on the WebView side: same channel names + payload
shapes, opposite buffering policy.

The bus exists ONLY in two-layer miniapps (those whose `miniapp.json`
declares an `entry.background`). Legacy single-bundle miniapps never
see `session.ui`.

## Surface

```typescript
interface UIModule {
  isOpen(): boolean
  onOpen(cb: () => void): UnsubscribeFn
  onClose(cb: () => void): UnsubscribeFn
  send<C>(channel: C, payload: Channels[C]): void
  on<C>(channel: C, cb: (payload: Channels[C]) => void): UnsubscribeFn
}
```

## Buffering policy — asymmetric on purpose

- `session.ui.send(channel, payload)` **drops silently** when no
  WebView is bound. Background is the long-lived side and shouldn't
  accumulate stale UI updates. State of record lives in
  `session.storage`; the next `session.ui.onOpen` is the place to
  push a snapshot.
- `mentra.send(channel, payload)` (WebView side) **buffers** until
  `mentra.ready()` acks. The WebView is the short-lived side and
  shouldn't drop user input.

## Lifecycle

```text
WebView mounts ──▶ injected mentraUiShim wires window.mentra
                ──▶ shim posts {type:"ready"} once page calls mentra.ready()
                ──▶ host's MentraUIRouter wraps into EVENT/_ui/UI_OPEN
                ──▶ session.ui.onOpen handlers fire
                ──▶ background pushes initial snapshot via session.ui.send
WebView closes ─▶ host's closeUI tears down WebView ─▶ router unbinds
                ──▶ EVENT/_ui/UI_CLOSE delivered ─▶ session.ui.onClose fires
```

`session.ui.onOpen` callbacks registered AFTER a WebView is already
mounted fire immediately for the current binding — useful for
controllers that subscribe lazily.

## Typed channels

Both halves of the miniapp import `src/shared/channels.ts`:

```typescript
// src/shared/channels.ts
export interface Channels {
  // background → UI
  "captions:snapshot": {history: string[]; live: string}
  "captions:history-update": {history: string[]}

  // UI → background
  "captions:clear": Record<string, never>
  "captions:set-mirror": {mirrorToGlasses: boolean}
}

declare global {
  var mentra: import("@mentra/miniapp/ui").MentraTyped<Channels>
}
```

The same `Channels` interface drives compile-time checks on both
`mentra.send/on` (UI side) and `session.ui.send/on` (background side).
A typo in a channel name fails the build.

## Example

Background:

```typescript
import type {MiniappSession} from "@mentra/miniapp/background"

export function init(session: MiniappSession) {
  let history: string[] = []
  session.ui.onOpen(() => session.ui.send("captions:snapshot", {history, live: ""}))
  session.ui.on("captions:clear", () => {
    history = []
    session.ui.send("captions:history-update", {history})
  })
}
```

WebView:

```tsx
import "../shared/channels"
import {useChannel} from "./hooks/useChannel"

function CaptionsPage() {
  const snapshot = useChannel("captions:snapshot")
  return <button onClick={() => mentra.send("captions:clear", {})}>Clear</button>
}
```

## Errors

`session.ui.send` does not throw. Channels are opaque strings on the
wire; the host router treats unknown channel names as no-ops. The
typed `Channels` map enforces correctness at compile time — there's no
runtime registry to violate.

## See also

- [transport architecture](../agents/mentrajs-two-layer-miniapp-architecture.md)
  — full design, including the underlying envelope shapes (`UI_OPEN`,
  `UI_MESSAGE`, `UI_SEND`).
- [`@mentra/miniapp/ui` types](../mobile/modules/miniapp/src/ui/index.ts)
  for the `mentra` global declaration.
