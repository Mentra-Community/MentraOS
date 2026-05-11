# Miniapp SDK — Dev-Ex Overview

> A semi-high-level walkthrough of the new local miniapp SDK that ships in this PR. Intended as a starting point for the dev-ex discussion: what the SDK exposes, how the dev loop feels, and where the rough edges currently are. **Not** a spec — see the planning docs in `agents/` for the long-form design.

The SDK lives across four packages in `sdk/`:

| Package                                  | Role                                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| `@mentra/miniapp`                        | Runtime SDK consumed by miniapp authors. Session, modules, transports, React hooks.          |
| `@mentra/miniapp-cli` (`mentra-miniapp`) | Author-facing CLI. `dev`, `release`, `pack`, `manifest`, `permission`, `hardware`, `schema`. |
| `create-mentra-miniapp`                  | Project scaffolder. `bunx create-mentra-miniapp my-app` → a working starter.                 |
| `sdk/example-miniapp`                    | Reference miniapp ("Live Captions" + a tester for every module). What we build against.      |

A miniapp is a **static web app** (HTML/JS/CSS bundle, any framework) with a `miniapp.json` manifest. It runs inside the MentraOS app's WebView on the phone. The SDK gives it a typed API for talking to the glasses + phone.

---

## What the SDK exposes

### The session object

Everything goes through one object: `MiniappSession`. You construct it (or grab the React-shared one via `useSession()`) and the modules hang off it:

```ts
const session = new MiniappSession()
await session.connect()              // sends CONNECT, resolves on CONNECT_ACK

session.display.showTextWall("hello")
session.transcription.on(data => …)
await session.speaker.speak("hi there")
```

The session owns the transport, the request/response correlation map, the pre-ready outbound queue (so calls made before `CONNECT_ACK` aren't lost), keepalive PONG replies, and the cached visibility / capabilities / color-scheme / permissions state.

It emits eight lifecycle events you can subscribe to: `ready`, `disconnect`, `error`, `visibility`, `capabilities`, `colorScheme`, `permissions`, `speakerState`.

### Modules on the session

15 modules, named to mirror cloud SDK v3. Events live on the module that owns the domain. Imperative one-shots live alongside their owning surface (`session.speaker.speak`, `session.camera.takePhoto`).

| Module                  | What it does                                                                                                                 | Key methods                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `session.display`       | Push layouts to the glasses display                                                                                          | `showTextWall`, `showDoubleTextWall`, `showReferenceCard`, `showDashboardCard`, `showBitmapView`, `clearView`                            |
| `session.speaker`       | Phone-side audio **output**                                                                                                  | `play({audioUrl})`, `speak(text, {voice_id, …})` (cloud TTS), `stop()`, `onStateChange(handler)`                                         |
| `session.mic`           | Low-level audio **input**                                                                                                    | `onAudioChunk`, `onVoiceActivity`, `stop()`, `hasPermission`                                                                             |
| `session.transcription` | Speech → text                                                                                                                | `on(handler)`, `forLanguage(lang \| [langs], handler)`, `configure({languageHints, vocabulary, diarization})`, `stop()`, `hasPermission` |
| `session.translation`   | Cross-language transcription                                                                                                 | `forLanguagePair(from, to, handler)`, `stop()`, `hasPermission`                                                                          |
| `session.input`         | Physical control events                                                                                                      | `onButtonPress`, `onTouch(handler)` / `onTouch("click", handler)` / `onTouch(["a","b"], handler)`                                        |
| `session.location`      | Location events                                                                                                              | `onUpdate`, `hasPermission`                                                                                                              |
| `session.imu`           | Head position + motion events                                                                                                | `onHeadPosition`                                                                                                                         |
| `session.glasses`       | Glasses device-state events                                                                                                  | `onBattery`, `onConnection`                                                                                                              |
| `session.phone`         | Phone device-state events                                                                                                    | `notifications.{on, onDismissed, stop, hasPermission}`, `calendar.{on, stop, hasPermission}`, `onBattery`                                |
| `session.system`        | Phone-OS imperative utilities                                                                                                | `share(...)`, `openUrl(url)`, `copyToClipboard(text)`, `download(...)`                                                                   |
| `session.camera`        | Glasses camera                                                                                                               | `takePhoto({size, compress, sound, saveToGallery})`, `setFov({horizontal, vertical})`, `hasPermission`                                   |
| `session.led`           | Glasses RGB LED                                                                                                              | `turnOn({color, ontime, offtime, count})`, `turnOff()`, `blink(color, ontime, offtime, count)`, `solid(color, duration)`                 |
| `session.permissions`   | Manifest-declared permissions (matches v3 semantics)                                                                         | `has(type)`, `getAll()`, `onUpdate(handler)`, `onPermissionError(handler)`                                                               |
| `session.storage`       | Phone-local AsyncStorage scoped to `(userId, packageName)`                                                                   | `get`, `set`, `delete`, `list` (string values only)                                                                                      |
| `session.stream`        | Video streaming from glasses (Phase 5 — wired but bridged into existing cloud streaming)                                     | `startUnmanaged({streamUrl})`, `startManaged({restreamDestinations})`, `stop(streamId?)`                                                 |
| `session.dashboard`     | Dashboard widget surface — **noop in v1**, prints a one-time warning. Cloud DashboardManager still owns dashboard rendering. | `setContent(mode, content)`                                                                                                              |

`session.events` is **internal** and exposes only `subscribe(rawStreamType, handler)` — a forward-compat escape hatch for new event types not yet wrapped on a domain module. Authors should not reach for it directly; the typed methods on the modules above are the canonical surface.

Each event subscriber returns an `UnsubscribeFn`. Subscriptions are ref-counted: the SDK only sends `SUBSCRIBE` over the wire when a stream's count transitions 0↔1, so multiple components listening for the same stream don't fan out.

**Permissions, scoped.** `session.permissions.has("microphone")` returns whether the manifest declared `MICROPHONE` — same semantics as cloud SDK v3. It does NOT report OS-level grant state; even when `has(...)` returns `true` the user can have denied the OS prompt and your subscriptions will silently receive no events. OS-grant tracking and `request(...)` are deferred; when added they'll land additively (`isGranted(...)`, `request(...)`) on the same module without renaming today's surface.

### Controller pattern (recommended for non-trivial apps)

Smart-glasses miniapps are **always-on services**. The webview is a UI on top of a continuously-running session. If you tie subscriptions to React component lifecycle, you'll find that closing or navigating away from a page also stops the glasses behavior — which is the wrong shape for glasses.

**The rule:** user-facing glasses logic must live in a session-scoped controller, instantiated once at module init. React pages read controller-driven state via a store (Zustand recommended) and call imperative methods on the controller for user-triggered actions. They do NOT subscribe to `session.*` directly.

The reference implementation in `sdk/example-miniapp/src/`:

- **`controller/GlassesController.ts`** — single class. Owns every `session.transcription.on(...)`, `session.input.onButtonPress(...)`, etc. `start()` is called once from `main.tsx`'s Bootstrap shim. Subscriptions live for the entire session.
- **`store/appStore.ts`** — Zustand store. Controller writes (`store.appendHistory`); pages read (`useAppStore((s) => s.history)`).
- **`pages/CaptionsPage.tsx`** — viewer. Reads from store, calls `getGlassesController().clearGlasses()` for actions. Zero `session.*` calls.

**Tester pages exception:** `pages/tester/*` are diagnostic surfaces — by design they inline-subscribe to `session.*` (or call imperative methods on user button press) and tear down on unmount. This is the ONLY place where this pattern is acceptable. Each tester file has a header comment calling out the exception.

**Scaling up:** for ~5+ distinct concerns, split the controller into per-concern manager classes (mirrors cloud SDK v3's user-side pattern in `Mentra-AI`, `Merge`). The example's single-class approach is fine for 1-3 concerns.

The class is named `GlassesController` (not `CaptionsController`) so a developer forking the example keeps the name verbatim — it describes what the class does, not what the example uses it for.

### Subscriptions: language convention

Transcription/translation streams use a colon-suffixed wire format: `transcription:en-US`, `translation:en-US:fr-FR`. The SDK's `session.transcription.on(handler)` subscribes to `transcription:auto` and the cloud auto-detects the language. The detected language is in the event payload. There's also a wildcard fan-out: a handler on `transcription:auto` receives any `transcription:<lang>` event, which makes "give me transcripts in whatever language" work without manual wiring. Use `session.transcription.forLanguage("en-US", handler)` (or an array) to pin specific languages.

### React bindings (`@mentra/miniapp/react`)

Optional but recommended. All hooks share a single session per app.

| Hook                      | Returns                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| `useSession()`            | The shared `MiniappSession`. Auto-calls `connect()` once.                                  |
| `useConnected()`          | `boolean` — flips on `ready` / `disconnect`                                                |
| `useCapabilities()`       | The current glasses capability profile (or `null`)                                         |
| `useVisibility()`         | `"foreground" \| "background"`                                                             |
| `useColorScheme()`        | `"light" \| "dark"` (the host's current theme)                                             |
| `useSafeArea()`           | `{insets, capsuleMenu}` — pixel insets + bounding rect of the host's floating capsule menu |
| `useCapsuleHeaderStyle()` | Pre-computed CSS for a header row that aligns with the capsule menu                        |

Plus two components:

- `<MentraProvider>` — root provider. Currently does one thing: keeps `<html class="dark">` in sync with the host color scheme (no FOUC because it runs during render).
- `<MiniappHeader title="…" left={…} right={…} onBack={…} />` — drop-in header that respects the safe area and leaves room for the capsule menu.

### Manifest (`miniapp.json`)

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
- The CLI validates the manifest before both `dev` and `pack`. The validator mirrors `@mentra/types` string lists by hand on purpose — keeps the CLI dependency-light so `bunx mentra-miniapp` is fast.

### Host-injected globals (`window.MentraOS`)

The MentraOS app injects `window.MentraOS` into the WebView before content loads. Authors generally use the React hooks instead, but it's there:

```ts
{
  packageName, platform, capabilities,
  miniappLocal, miniappDeveloperMode,
  safeAreaInsets: {top, bottom, left, right},
  capsuleMenu: {top, right, bottom, left, width, height},
  colorScheme: "light" | "dark"
}
```

### Wire protocol (briefly)

Every message is a `{payload, requestId?}` envelope, JSON over the chosen transport. `requestId` correlates request ↔ response for methods that return a value. The SDK constants (`MiniappRequestType`, `MiniappResponseType`, `MiniappStreamType`, `MiniappErrorCode`) live in `@mentra/miniapp/protocol` and are re-exported. Full enum listing in `sdk/miniapp/src/protocol.ts`.

Two transports, auto-selected:

- **`PostMessageTransport`** — used when the miniapp runs inside the MentraOS WebView. Uses `window.ReactNativeWebView.postMessage` outbound and a `window`-level `message` listener inbound.
- **`LocalSocketTransport`** — fallback for running in Safari/Chrome on a laptop. Connects to `ws://127.0.0.1:8765` (a localhost WebSocket the phone exposes via MiniSockets, planned for Phase 4 — does not work today out of the box).

---

## What it feels like to build a miniapp

The intended dev loop, end to end:

```bash
bunx create-mentra-miniapp my-app   # scaffold
cd my-app
bun install
bun dev                              # starts dev server + prints QR
```

`bun dev` calls `mentra-miniapp dev` under the hood. That:

1. Reads + validates `miniapp.json` (hard-fails on bad permissions/hardware types so you don't have to debug it on the phone).
2. Spawns `bun run --hot server.ts` in the project (the template ships a tiny Bun.serve that serves `index.html`, `miniapp.json`, `icon.png`, and any assets under `public/`).
3. Polls localhost until the server is reachable.
4. Detects the LAN IP, builds a `mentra-miniapp://dev?url=…&name=…&package=…` URL, prints a terminal QR + the raw URL.
5. Watches for LAN-IP changes (Wi-Fi switch) and reprints the QR.

You scan the QR from **MentraOS app → Settings → Developer settings → Mini App Development → Scan Mini App QR Code**. Phone loads your dev URL into a WebView, injects `window.MentraOS`, the SDK's `PostMessageTransport` connects, you're live with hot reload.

The author writes a normal web app — anything that builds to static HTML/JS/CSS works, the example uses Bun's bundler with React + Tailwind + Radix. Inside, they use `useSession()` and the modules:

```tsx
const session = useSession()
useEffect(() => {
  return session.transcription.on((data) => {
    session.display.showTextWall(data.text)
  })
}, [session])
```

When ready to ship:

```bash
bun run build       # whatever bundler — outputs to dist/
bun run pack        # mentra-miniapp pack — produces the distributable ZIP
# or:
mentra-miniapp release   # build + pack + serve a QR to install on a phone
```

`mentra-miniapp pack`:

1. Validates `miniapp.json` again.
2. Copies `miniapp.json` and `icon.png` into `dist/`.
3. Zips `dist/` to `<packageName>-<version>.zip` using JSZip.

`mentra-miniapp release` is the all-in-one verb: it builds, packs, and serves the resulting ZIP behind a QR code so you can sideload it onto a phone over LAN. Pass `--no-cache` to skip the build cache.

That ZIP is the artifact you'd upload to the miniapp store (store backend lives in the `miniapp-store-backend-plan.md` planning doc — not in this PR yet).

### Other CLI verbs

```
mentra-miniapp manifest                    # interactive wizard for miniapp.json
mentra-miniapp permission list             # list declared permissions
mentra-miniapp permission add [TYPE]       # add (interactive without TYPE)
mentra-miniapp permission remove [TYPE]    # remove a declared permission
mentra-miniapp hardware list               # list hardware requirements
mentra-miniapp hardware add [TYPE] [LEVEL] # add a hardware requirement
mentra-miniapp hardware remove [TYPE]      # remove a hardware requirement
mentra-miniapp schema print                # print the miniapp.json JSON Schema
```

`schema regenerate` exists too but is a CLI-internal command — it rewrites the published schema file from the in-source allowed-values lists.

---

## Open dev-ex questions for the team

These are the things that I think need conversation before this becomes the official supported story:

1. **`bunx create-mentra-miniapp` is the entrypoint** — but right now the template is opinionated (Bun + Bun.serve + React + Tailwind + Radix in the example). Do we ship multiple templates? Just a minimal one? A Vite variant?
2. **Manifest enum drift** — the CLI's `manifest.ts` mirrors `@mentra/types` string lists by hand to keep the CLI dependency-light. We need a story for when those drift (codegen step at publish time? Tighten the cost of importing `@mentra/types` instead?).
3. **Capabilities surface is untyped** (`GlassesCapabilities = {[k: string]: unknown}`). Authors are reading `caps.hasCamera`, `caps.hasMicrophone`, etc. with no autocomplete. We should ship a typed capability schema from `@mentra/types`.
4. **Storage is strings-only.** Same shape as the cloud SDK's `SimpleStorage` so callers JSON-serialize themselves. Worth deciding if we want a `getJSON`/`setJSON` convenience or stay deliberately bare.
5. **Dashboard is a noop in v1**, with a one-time `console.warn`. What's the migration story for first-party miniapps that currently use the cloud SDK's dashboard surface?
6. **`session.stream`** is wired to existing cloud streaming via the `__phone__` subscriber path. Author-facing API matches what the cloud SDK exposes. Worth confirming we want the same shape going forward, or whether local streaming should look different.
7. **`LocalSocketTransport`** ships in the SDK but the phone-side MiniSockets server it talks to is Phase 4 — which means the in-laptop-browser dev story is currently broken. Decide whether to ship the SDK code now and land the server later, or hide the transport export until it works.
8. **Permission denial UX** — when an author subscribes to a stream whose required permission isn't in the manifest, the phone returns a `PERMISSION_NOT_DECLARED` error. Right now subscribe is fire-and-forget (no `requestId`), so the error surfaces as a session-level `error` event. Discuss whether subscribe should be a request that returns a result, or whether the error path is fine as-is.
9. **Versioning** — `@mentra/miniapp` is at `0.1.0`. Manifests get a string `version` but we have no schema-version field. We'll want one before v1 ships.
10. **`MentraProvider` is currently 30 lines of "sync the dark class"** — fine starting surface, but a clear place to add other root-level conveniences (analytics, error boundaries, deep-link handling). Worth a quick discussion on what else belongs there.

---

## File map

For anyone digging in:

- SDK runtime: `sdk/miniapp/src/{session,protocol,envelope,globals}.ts`, `sdk/miniapp/src/modules/`, `sdk/miniapp/src/transport/`, `sdk/miniapp/src/react/`
- CLI: `sdk/miniapp-cli/src/{index,dev,pack,manifest,qr}.ts`
- Scaffolder: `sdk/create-mentra-miniapp/`
- Reference miniapp: `sdk/example-miniapp/` (the Live Captions page + a `/tester` route exercising every module)

Long-form planning docs (the "what this should look like once it's done" reading list, also linked in the PR body):

- `agents/local-miniapp-architecture-discussion.md`
- `agents/local-miniapp-execution-plan.md`
- `agents/local-app-runtime-plan.md`
- `agents/cloud-shrinkage-plan.md`
- `agents/miniapp-store-backend-plan.md`
- `agents/miniapp-sdk-photo-cleanup-plan.md`
