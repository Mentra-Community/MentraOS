# @mentra/miniapp

SDK for building MentraOS local miniapps — static web apps that run inside the MentraOS phone app's WebView and talk to smart glasses via a typed session API.

> Developing this SDK or running the in-repo example from a fresh clone? Start at the **[SDK developer guide](../../../sdk/README.md)** (setup, build loop, doc map).
> Per-module deep dives (return shapes, events, error codes): **[`sdk/docs/`](../../../sdk/docs/README.md)**.
> Companion package: **[`@mentra/miniapp-cli`](../../../sdk/miniapp-cli/README.md)** — `mentra-miniapp` CLI (`dev`, `release`, `pack`, `manifest`, `permission`, `hardware`, `schema`). Per-command docs live there.
> Scaffolder: `bunx create-mentra-miniapp my-app`.
> Reference miniapp: [`sdk/example-miniapp/`](../../../sdk/example-miniapp).
> High-level walkthrough: [`agents/miniapp-sdk-overview.md`](../../../agents/miniapp-sdk-overview.md).

## Install

```bash
bun add @mentra/miniapp
# or
npm install @mentra/miniapp
```

`react` is an optional peer dependency — only required if you use `@mentra/miniapp/react`.

## Entry points

| Specifier                  | Contents                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| `@mentra/miniapp`          | `MiniappSession`, `NotConnectedError`, transports, manifest-types re-exports, module type exports |
| `@mentra/miniapp/react`    | React hooks + `<MentraProvider>` + `<MiniappHeader>`                                              |
| `@mentra/miniapp/protocol` | `MiniappRequestType`, `MiniappResponseType`, `MiniappStreamType`, `MiniappErrorCode`              |

## Quick start

```ts
import {MiniappSession} from "@mentra/miniapp"

const session = new MiniappSession()
await session.connect() // sends CONNECT, resolves on CONNECT_ACK

// render() replaces the whole frame; stable ids update in place, render([]) clears.
const box = {x: 0, y: 0, w: 576, h: 288} // raw device px — see session.capabilities.display
session.display.render([{type: "text", id: "hello", box, text: "hello"}])
const unsub = session.transcription.on((d) => session.display.render([{type: "text", id: "hello", box, text: d.text}]))
// later: unsub()
```

React:

```tsx
import {MentraProvider, useSession, useConnected} from "@mentra/miniapp/react"

function App() {
  const session = useSession() // shared session, auto-connects
  const ready = useConnected()
  // ...
}

// root:
;<MentraProvider>
  <App />
</MentraProvider>
```

## Session

`MiniappSession` is the only object you construct. It owns the transport, the request/response correlation map, the pre-ready outbound queue, the keepalive PONG, and the cached visibility / capabilities / color-scheme / permissions state.

### Lifecycle

```ts
const session = new MiniappSession(options?)
await session.connect()       // idempotent; same Promise on repeat calls
session.isConnected()
session.disconnect()
```

`MiniappSessionOptions`:

- `packageName?: string` — overrides auto-detection from `window.MentraOS`
- `connectTimeoutMs?: number` — defaults to 10s
- transport-selection options from `createTransport` (`mode`, `transport`, `localSocket`)

### Lifecycle events

```ts
const off = session.on("ready", () => {})
session.off("ready", handler)
```

| Event          | Signature                                     |
| -------------- | --------------------------------------------- |
| `ready`        | `() => void` — fires after CONNECT_ACK        |
| `disconnect`   | `(reason: string) => void`                    |
| `error`        | `(err: Error) => void`                        |
| `visibility`   | `("foreground" \| "background") => void`      |
| `capabilities` | `(caps: GlassesCapabilities \| null) => void` |
| `colorScheme`  | `("light" \| "dark") => void`                 |
| `permissions`  | `(perms: PermissionRecord) => void`           |
| `speakerState` | `(event: SpeakerStateEvent) => void`          |

Convenience wrappers: `onVisibilityChange`, `onCapabilitiesChange`, `onColorSchemeChange`. Each `on(...)` call also returns an unsubscribe function.

### Cached state

`session.userId`, `session.packageName`, `session.capabilities`, `session.visibility`, `session.colorScheme`, `session.ready` — populated from `CONNECT_ACK` and kept in sync via the lifecycle events above.

## Modules

All event subscribers return an `UnsubscribeFn`. Subscriptions are ref-counted: the SDK sends `SUBSCRIBE` when a stream's active state or routing metadata changes.

| Module                        | Methods                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.display`             | `render(elements, opts?)` — scene API: diffed frames, stable-id in-place updates, `render([])` clears                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `session.speaker`             | `play({audioUrl})`, `speak(text, options?)`, `createStream({sampleRate?, volume?})` for bounded 16-bit PCM output, `stop()`, `onStateChange(handler)`                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `session.mic`                 | `onAudioChunk(handler)`, `onVoiceActivity(handler)`, `stop()`, `hasPermission`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `session.transcription`       | `on(handler, {forceLocal?})`, `forLanguage(lang \| [langs], handler, {forceLocal?})`, `configure({languageHints, vocabulary, diarization})`, `stop()`, `hasPermission`                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `session.translation`         | `forLanguagePair(from, to, handler)`, `stop()`, `hasPermission`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `session.input`               | `onButtonPress(handler)`, `onTouch(handler \| gesture, handler \| gestures, handler)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `session.location`            | `onUpdate(handler)`, `hasPermission`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `session.imu`                 | `onHeadPosition(handler)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `session.glasses`             | `onBattery(handler)`, `onConnection(handler)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `session.phone.notifications` | `on(handler)`, `onDismissed(handler)`, `stop()`, `hasPermission`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `session.phone.calendar`      | `listEvents({startsAt, endsAt, limit?})`, `hasPermission`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `session.phone`               | `onBattery(handler)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `session.system`              | `share(opts)`, `openUrl(url)`, `copyToClipboard(text)`, `download(opts)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `session.camera`              | `takePhoto({size?, mode?, transferMethod?, compress?, sound?, saveToGallery?, zsl?, mfnr?, timeoutMs?, ...})`, `setFov({fov, roiPosition?} \| {preset})`, `hasPermission`                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `session.led`                 | `turnOn({color?, ontime?, offtime?, count?})`, `turnOff()`, `blink(color, ontime, offtime, count)`, `solid(color, duration)` — resolve after the glasses acknowledge the RGB command                                                                                                                                                                                                                                                                                                                                                                                                         |
| `session.permissions`         | `has(type)`, `getAll()`, `onUpdate(handler)`, `onPermissionError(handler)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `session.storage`             | `get(key)`, `set(key, value)`, `delete(key)`, `list()` — strings only, scoped to `(userId, packageName)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `session.stream`              | `startUnmanaged({streamUrl, video?, audio?, sound?})`, `startManaged({restreamDestinations?, video?, audio?, sound?, ingest?})`, `stop(streamId?)` — stream video input fields are `width`, `height`, `bitrate`, and `fps`; resolved status reports effective frame rate as `resolvedConfig.video.fps`. Start resolves with `{streamId, status, resolvedConfig?}` after glasses report the publisher is streaming; managed starts also return playback URLs; `ingest` selects `"srt"` for HLS/recording or `"whip"` for low-latency WebRTC; stop is idempotent for an already-stopped stream |
| `session.dashboard`           | `setContent(mode, content)` — **noop in v1**, prints a one-time `console.warn`. Cloud DashboardManager owns rendering.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

`session.events` is **internal**. It exposes `subscribe(rawStreamType, handler)` only as a forward-compat escape hatch for new event types not yet wrapped on a domain module — prefer the typed module surface.

### Camera FOV

`await session.camera.setFov({fov, roiPosition})` applies a temporary, miniapp-owned FOV/ROI override and resolves with `CameraFovResult` after the ASG client reports the setting was applied following the camera restart cooldown. The host restores the previous live miniapp override—or the persistent 118-degree full-sensor base—when this miniapp closes. `roiPosition` accepts `"center"`, `"bottom"`, or `"top"` and defaults to `"center"`. You can also call `setFov({preset: "narrow" | "standard" | "wide"})`; presets map to 82, 102, and 118 degrees with center ROI. The call requires `CAMERA` in `miniapp.json` and rejects with `MiniappRequestError` if the host or glasses cannot apply it.

### Camera Photos

`await session.camera.takePhoto(...)` resolves only after the photo is delivered through the phone/cloud upload path. The result includes `{requestId, photoUrl, mimeType, size}`. Glasses-side or phone-relay failures such as `CAMERA_BUSY`, `BATTERY_LOW`, storage errors, or fallback upload failures reject before upload polling completes; intermediate `photo_status` progress and request acceptance alone do not resolve the miniapp photo promise.

Pass `transferMethod: "ble"` to skip direct Wi-Fi upload and always relay the image through the phone over Bluetooth. The default `"auto"` mode tries direct upload first and falls back to BLE.

### Transcription language convention

Transcription/translation streams use a colon-suffixed wire format: `transcription:en-US`, `translation:en-US:fr-FR`. `session.transcription.on(handler)` subscribes to `transcription:auto` (cloud auto-detects). The detected language is in the payload. A handler on `transcription:auto` receives any `transcription:<lang>` event — wildcard fan-out — so "give me transcripts in whatever language" works without manual wiring. Use `session.transcription.forLanguage(lang | [langs], handler)` to pin specific languages. Pass `{forceLocal: true}` as the final argument to either method to require on-device transcription and suppress cloud results for that subscription. Routing is per listener, so a default listener on the same stream can continue receiving cloud transcription.

### Permissions semantics

`session.permissions.has("microphone")` returns whether the manifest declared the permission. Same semantics as cloud SDK v3. **It does NOT report OS-level grant state** — even when `has(...)` returns `true` the user can have denied the OS prompt and your subscriptions will silently receive no events. OS-grant tracking and `request(...)` are deferred and will land additively on the same module.

`PermissionType` is the lowercase canonical union: `"location" | "microphone" | "camera" | "notifications" | "calendar"`. Manifest UPPER_CASE names map onto these (`BACKGROUND_LOCATION` → `location`; `READ_NOTIFICATIONS`, `POST_NOTIFICATIONS` → `notifications`).

## React bindings — `@mentra/miniapp/react`

All hooks share a single session per app, created on first `useSession()` call.

| Hook                      | Returns                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| `useSession()`            | Shared `MiniappSession`. Auto-calls `connect()` once.                                      |
| `useConnected()`          | `boolean` — flips on `ready` / `disconnect`                                                |
| `useCapabilities()`       | The current glasses capability profile, or `null`                                          |
| `useVisibility()`         | `"foreground" \| "background"`                                                             |
| `useColorScheme()`        | `"light" \| "dark"` (host theme)                                                           |
| `useSafeArea()`           | `{insets, capsuleMenu}` — pixel insets + bounding rect of the host's floating capsule menu |
| `useCapsuleHeaderStyle()` | Pre-computed CSS for a header row that aligns with the capsule menu                        |

Components:

- `<MentraProvider>` — root provider. Keeps `<html class="dark">` in sync with the host color scheme during render (no FOUC).
- `<MiniappHeader title="…" left={…} right={…} onBack={…} />` — drop-in header that respects the safe area and leaves room for the capsule menu.

## Manifest — `miniapp.json`

```json
{
  "packageName": "com.mentra.example",
  "version": "1.0.0",
  "name": "Live Captions",
  "description": "…",
  "icon": "icon.png",
  "permissions": [{"type": "MICROPHONE", "description": "…"}],
  "hardwareRequirements": [
    {"type": "DISPLAY", "level": "REQUIRED"},
    {"type": "MICROPHONE", "level": "REQUIRED"}
  ]
}
```

- `permissions[].type` ∈ `MICROPHONE | CAMERA | CALENDAR | LOCATION | BACKGROUND_LOCATION | READ_NOTIFICATIONS | POST_NOTIFICATIONS`
- `hardwareRequirements[].type` ∈ `CAMERA | DISPLAY | MICROPHONE | SPEAKER | IMU | BUTTON | LIGHT | WIFI`, `level` ∈ `REQUIRED | OPTIONAL`

The CLI validates the manifest on every `dev`, `release`, and `pack`. Run `mentra-miniapp schema print` for the canonical JSON Schema.

## CLI

The author-facing CLI lives in a sibling package: **[`@mentra/miniapp-cli`](../../../sdk/miniapp-cli/README.md)** (binary: `mentra-miniapp`). Full per-command docs there. Quick map:

| Command                                                        | Purpose                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------ |
| `mentra-miniapp dev`                                           | Hot-reload dev server + QR sideload onto a phone over LAN    |
| `mentra-miniapp release`                                       | Build, pack, and serve a QR to install on a phone            |
| `mentra-miniapp pack`                                          | Validate manifest and zip `dist/` into `<pkg>-<version>.zip` |
| `mentra-miniapp manifest`                                      | Interactive top-level wizard for `miniapp.json`              |
| `mentra-miniapp permission list \| add \| remove [TYPE]`       | Object-verb manifest edits for permissions                   |
| `mentra-miniapp hardware list \| add \| remove [TYPE] [LEVEL]` | Object-verb manifest edits for hardware requirements         |
| `mentra-miniapp schema print`                                  | Print the canonical `miniapp.json` JSON Schema               |

See [the CLI README](../../../sdk/miniapp-cli/README.md) for flags, semantics, and the `miniapp://` URL schemes the QR codes encode.

## Host-injected globals — `window.MentraOS`

The MentraOS app injects this before content loads. Authors generally use the React hooks instead, but the raw shape is:

```ts
{
  packageName, platform, capabilities,
  miniappLocal, miniappDeveloperMode,
  safeAreaInsets: {top, bottom, left, right},
  capsuleMenu: {top, right, bottom, left, width, height},
  colorScheme: "light" | "dark"
}
```

Use `getMentraOSGlobals()` (exported from the package) to read it with the right TypeScript types.

## Transports

Auto-selected by `createTransport(options)`:

- **`PostMessageTransport`** — used inside the MentraOS WebView. `window.ReactNativeWebView.postMessage` outbound, `window` `message` listener inbound.
- **`LocalSocketTransport`** — fallback for laptop browsers. Default endpoint `ws://127.0.0.1:8765`. The in-laptop-browser dev story is currently broken; see the overview doc for status.

Both are exported for advanced uses (forced transport, tests). `MockTransport` is also exported for unit tests.

## Wire protocol

Every message is a `{payload, requestId?}` envelope, JSON over the chosen transport. `requestId` correlates request ↔ response for methods that return a value. Constants live in `@mentra/miniapp/protocol`:

- `MiniappRequestType` — `CONNECT`, `SUBSCRIBE`, etc.
- `MiniappResponseType` — `CONNECT_ACK`, `EVENT`, `REQUEST_RESULT`, `PERMISSIONS_UPDATE`, …
- `MiniappStreamType` — typed names for stream identifiers
- `MiniappErrorCode` — `NOT_CONNECTED`, `PERMISSION_NOT_DECLARED`, …

Full enum listings in [`src/protocol.ts`](./src/protocol.ts).

## Controller pattern (recommended)

Smart-glasses miniapps are **always-on services**. The webview is a UI on top of a continuously-running session. If you tie subscriptions to React component lifecycle, closing or navigating away from a page also stops the glasses behavior — wrong shape for glasses.

**Rule:** user-facing glasses logic lives in a session-scoped controller, instantiated once at module init. React pages read controller-driven state via a store (Zustand recommended) and call imperative methods on the controller for user-triggered actions. They do **not** subscribe to `session.*` directly.

See [`sdk/example-miniapp/src/controller/GlassesController.ts`](../../../sdk/example-miniapp/src/background/controllers/GlassesController.ts) for a worked reference.

**Tester pages exception:** `pages/tester/*` are diagnostic surfaces — by design they inline-subscribe to `session.*` and tear down on unmount. This is the only place where that pattern is acceptable.

## File map

- Runtime: [`src/{session,protocol,envelope,globals}.ts`](./src/), [`src/modules/`](./src/modules/), [`src/transport/`](./src/transport/), [`src/react/`](./src/react/)
- CLI: [`../miniapp-cli/src/`](../../../sdk/miniapp-cli/src/)
- Scaffolder: [`../create-mentra-miniapp/`](../../../sdk/create-mentra-miniapp/)
- Reference miniapp: [`../example-miniapp/`](../../../sdk/example-miniapp/)
