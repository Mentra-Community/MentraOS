# Local Miniapp SDK — Execution Plan

## What This Is

A new JavaScript SDK (`@mentra/miniapp`) that lets miniapps run locally on the phone in WebViews instead of on remote servers. The phone handles display, events, and hardware access directly — no cloud hop. The existing cloud SDK (`@mentra/sdk`) stays untouched and both coexist until deprecation.

**How it works:** Developer builds a static web app using `@mentra/miniapp`. App is bundled as a ZIP, installed on the phone, and loaded into a WebView inside MentraOS. The WebView talks to the phone over postMessage. The phone drives the glasses directly via BLE. For features that require cloud (STT, translation), the phone proxies subscriptions over its existing cloud WebSocket. TTS is a direct REST call — the phone constructs the cloud TTS URL and plays the audio stream itself.

**Why:** Eliminates latency from the cloud round-trip for most operations. Makes miniapps work offline for local-only features. Simplifies the developer experience (static web app vs. running a server). Prepares for Apple Guideline 4.7 compliance.

**Internal until V3.** Local JS SDK is internal-only through V1 and V2. Not publicly accessible until we implement a proper miniapp store flow.

Full technical spec: `agents/local-app-runtime-plan.md`

---

## V1 — Display Glasses (Internal)

Local JS miniapps for display-only glasses (G1, G2). No camera, no streaming. Cloud SDK unchanged, both coexist. All internal.

### [OS-1292: @mentra/miniapp SDK Package](https://linear.app/mentralabs/issue/OS-1292)

Build the new browser-native SDK.

- Wire protocol enums (`miniapp_*` naming, no legacy `tpa_*`)
- Bridge envelope format (`{payload, requestId?}`) with serialize/parse
- Transport layer: PostMessage (WebView) and WebSocket (browser fallback) with auto-detection
- `MiniappSession` class: zero-config, queue-before-ACK, auto PONG, request/response correlation, visibility tracking
- Modules: layouts, events, audio (play + speak), LED, storage, system (share/clipboard/openUrl/download)
- Stub modules: camera, dashboard, streaming (noop + warning)
- React hook: `useSession()`
- Build with `tsc`, browser-only target, no Node deps
- Unit tests: envelope roundtrip, protocol wire values, session queue/flush, request correlation

**Acceptance:** `tsc` builds clean. Unit tests pass. A minimal HTML page imports `MiniappSession`, bundles with Bun, runs in Chrome without errors.

### [OS-1293: Composer Rewrite (Bundle Manager)](https://linear.app/mentralabs/issue/OS-1293)

Rewrite `Composer.ts` as the canonical local miniapp installer.

- `initialize()` — install bundled assets from `mobile/assets/miniapps/`, then scan `lmas/`, populate appletStatusStore
- `installBundledMiniapps()` — read ZIPs from assets folder, install/overwrite by packageName (no duplicates, version comparison)
- `installFromUrl(url)` — download ZIP, unzip, validate `miniapp.json`, install to `lmas/<packageName>/`
- `uninstall(packageName)` — remove from disk + appletStatusStore
- Parse permissions from `miniapp.json` (currently hardcoded to `[]`)
- Legacy `app.json` fallback at read time
- Remove dead code (duplicate `fanOutPcm`, empty `initialize()`)
- Wire `Composer.initialize()` from `MantleManager.init()`

**Acceptance:** Can install a ZIP from URL. Bundled miniapps appear on home screen after app launch. Reinstall overwrites, no duplicates. Uninstall removes from disk and home screen.

### [OS-1294: LocalMiniappRuntime](https://linear.app/mentralabs/issue/OS-1294)

The phone-side singleton that dispatches bridge messages and manages miniapp state. Depends on [OS-1292](https://linear.app/mentralabs/issue/OS-1292) and [OS-1293](https://linear.app/mentralabs/issue/OS-1293).

- Dispatch bridge messages by `MiniappRequestType`
- Per-app state: subscriptions, manifest, sendMessage fn, lastPongAt
- Request handlers: CONNECT, SUBSCRIBE, DISPLAY, PLAY*AUDIO, STOP_AUDIO, SPEAK, RGB_LED, LOCATION_POLL, STORAGE*\*, CAMERA_FOV
- TTS URL construction (phone has cloudUrl, miniapp doesn't)
- Permission enforcement at subscribe time (check manifest)
- Ref-counted `streamSubscribers` map for cloud subscription aggregation
- Ping loop (5s cadence, 3-miss timeout = treat miniapp as dead)
- Visibility state management per miniapp
- Event forwarding from CoreModule with name translation (`head_up` → `HEAD_POSITION`, `VAD` casing, etc.)
- Forward location, phone battery, notifications, calendar from MantleManager

**Acceptance:** A miniapp can connect, display text on glasses, subscribe to events, use storage, and play audio. Ping timeout tears down dead miniapps.

### [OS-1295: MiniappHost Component](https://linear.app/mentralabs/issue/OS-1295)

WebView lifecycle manager. Depends on [OS-1294](https://linear.app/mentralabs/issue/OS-1294). Can be built in parallel with it.

- Top-level component mounted in `AllProviders`
- One WebView per running miniapp, survives route navigation (never unmounted on back-nav)
- Foreground = full screen. Background = offscreen (`opacity: 0`, NOT `display: none`)
- `mount(packageName, bundleDir|devUrl)` / `unmount(packageName)` / `setForeground` / `setBackground`
- Bundle loading via `file://` URI with proper Android flags (`allowFileAccess`, `allowFileAccessFromFileURLs`)
- Dev URL loading via `http://` for QR sideloading
- Inject `window.MentraOS = {packageName, platform}` before content loads
- `onContentProcessDidTerminate` / `onError` → teardown + unregister
- Debug alert on iOS WebView eviction (`__DEV__` only)
- Route `onMessage` to `LocalMiniappRuntime.handleRawMessage()`

**Acceptance:** Open a miniapp, navigate away, navigate back — WebView is still alive with state intact. Background miniapps continue receiving events.

### [OS-1296: MicStateCoordinator + SocketComms Refactor](https://linear.app/mentralabs/issue/OS-1296)

Unblocks transcription/translation for local miniapps. Depends on [OS-1294](https://linear.app/mentralabs/issue/OS-1294).

- `MicStateCoordinator` class: unions cloud-driven and local-driven mic requirements
- `setCloudRequirements()` called by SocketComms (replaces direct `CoreModule.update`)
- `setLocalRequirements()` called by LocalMiniappRuntime
- `applyUnion()` calls `CoreModule.update("core", ...)` with the OR of both
- Refactor `SocketComms.handle_microphone_state_change()` to go through coordinator
- Unit tests: state machine transitions, union logic

**Acceptance:** Local miniapp subscribes to transcription → mic turns on. Cloud also wants mic → stays on. Both unsubscribe → mic turns off. No regression on existing cloud mic behavior.

### [OS-1297: Cloud **phone** Session](https://linear.app/mentralabs/issue/OS-1297)

All cloud-side changes for proxying STT/translation subscriptions to local miniapps.

- `PHONE_SUBSCRIPTION_UPDATE` message type in `message-types.ts`
- `PhoneSubscriptionUpdate` interface in `glasses-to-cloud.ts` + add to discriminated union
- `AppLikeSession` interface (shared by AppSession and PhoneSession)
- `AppSession` adds `implements AppLikeSession` (no runtime change)
- `PhoneSession` class implements `AppLikeSession` (does NOT extend AppSession)
- `AppManager`: retype `apps` map, `sendMessageToApp("__phone__")` → route to `userSession.websocket`, `getOrCreateAppSession("__phone__")` → cached PhoneSession, filter from user-facing state
- `SubscriptionManager`: skip `App.findOne()` DB lookup for `__phone__`
- Handler in `glasses-message-handler.ts` for `PHONE_SUBSCRIPTION_UPDATE`
- `SocketComms` on phone: `updatePhoneSubscriptions()` method, `data_stream` case → forward to LocalMiniappRuntime
- Unit tests: `__phone__` routing, idempotent session creation, subscription update without DB

**Acceptance:** Phone sends `PHONE_SUBSCRIPTION_UPDATE` → cloud creates PhoneSession → transcription data flows back to phone over existing WS → LocalMiniappRuntime fans out to subscribed miniapps. Existing cloud apps unaffected.

### [OS-1298: Developer Tooling](https://linear.app/mentralabs/issue/OS-1298)

CLI tools + phone UI for dev workflow. Depends on [OS-1292](https://linear.app/mentralabs/issue/OS-1292) and [OS-1293](https://linear.app/mentralabs/issue/OS-1293).

**CLI:**

- `create-mentra-miniapp` scaffolder: generates Bun Fullstack + React + `@mentra/miniapp` project with `server.ts`, `miniapp.json` template, starter `App.tsx`
- `@mentra/miniapp-cli`: `mentra-miniapp dev` (spawn Bun Fullstack, detect LAN IP, print QR) and `mentra-miniapp pack` (validate manifest, build ZIP from `dist/`)

**Phone UI:**

- Miniapp Developer screen (`developer.tsx`, behind Mentra Dev Mode gate) with:
  - QR scanner page — scan → parse URL → fetch manifest → check permissions → load WebView
  - Install from URL page — text input for ZIP URL → `Composer.installFromUrl()` → shows on home screen
  - Recent dev miniapps list

**Acceptance:** `bunx create-mentra-miniapp test-app && cd test-app && bun dev` prints QR. Scan from phone → miniapp loads on glasses with hot reload. `bun run build && bun run pack` produces a ZIP. Install from URL screen installs it.

### [OS-1299: Port Live Captions to Local SDK](https://linear.app/mentralabs/issue/OS-1299)

First miniapp ported. Integration test for the full stack. Depends on [OS-1292](https://linear.app/mentralabs/issue/OS-1292), [OS-1293](https://linear.app/mentralabs/issue/OS-1293), [OS-1294](https://linear.app/mentralabs/issue/OS-1294), [OS-1295](https://linear.app/mentralabs/issue/OS-1295), [OS-1296](https://linear.app/mentralabs/issue/OS-1296), [OS-1297](https://linear.app/mentralabs/issue/OS-1297).

- Rewrite Live Captions using `@mentra/miniapp` (display + transcription subscription)
- Ship as bundled ZIP in `mobile/assets/miniapps/`
- Validates end-to-end: display, transcription via cloud proxy, mic enablement, reconnection

**Acceptance:** Live Captions works on G1 and G2 via local miniapp. Transcription flows. No cloud app server involved.

### [OS-1300: Port Translation to Local SDK](https://linear.app/mentralabs/issue/OS-1300)

Second miniapp ported. Same subscription proxy path as captions but with TTS. Depends on [OS-1292](https://linear.app/mentralabs/issue/OS-1292), [OS-1294](https://linear.app/mentralabs/issue/OS-1294), [OS-1297](https://linear.app/mentralabs/issue/OS-1297).

- Rewrite Translation using `@mentra/miniapp`
- Translation subscription via cloud proxy (same `__phone__` path as transcription)
- TTS via `session.audio.speak()` → phone constructs cloud TTS URL → plays audio
- Ship as bundled ZIP in `mobile/assets/miniapps/`

**Acceptance:** Translation works on G1 and G2 via local miniapp. Translated text displays on glasses, TTS plays through speakers.

---

## V2 — Camera Glasses (Internal)

Local JS miniapps gain camera and streaming support. Port camera-dependent miniapps. Still internal.

### [OS-1301: Photo Capture (Cloud-Hosted Upload)](https://linear.app/mentralabs/issue/OS-1301)

Photos can't go phone-to-glasses directly (different networks). Cloud-hosted upload is the only reliable path. Depends on [OS-1294](https://linear.app/mentralabs/issue/OS-1294) and [OS-1297](https://linear.app/mentralabs/issue/OS-1297).

- Cloud REST endpoint `POST /api/client/miniapp-photo/request` — phone requests, cloud mints signed upload URL + token, sends PHOTO_REQUEST to glasses
- Cloud REST endpoint `POST /api/client/miniapp-photo/upload/:requestId` — glasses upload JPEG, store in R2 (`miniapp_photos/` prefix, 24h TTL)
- `PhonePhotoManager` on cloud (parallel to existing PhotoManager, owned by UserSession)
- `phone_photo_ready` WS message cloud → phone with `{requestId, photoUrl}`
- `LocalMiniappRuntime` photo request handler + permission check
- `CameraModule.takePhoto()` sends real request, returns Promise with photo URL
- Error paths: permission denied, glasses disconnected, capture timeout, upload failure

**Acceptance:** Local miniapp calls `session.camera.takePhoto()` → glasses take photo → uploads to cloud → miniapp gets URL. Works over WiFi direct and BLE fallback.

### [OS-1302: Unmanaged Streaming for Local Miniapps](https://linear.app/mentralabs/issue/OS-1302)

Depends on [OS-1294](https://linear.app/mentralabs/issue/OS-1294) and [OS-1297](https://linear.app/mentralabs/issue/OS-1297).

- Phone sends `stream_request` / `stream_stop` with `packageName: "__phone__"` to cloud
- `UnmanagedStreamingExtension`: add `__phone__` bypass for ownership checks
- Status flows back via existing `sendMessageToApp` path
- `StreamModule.startUnmanaged(rtmpUrl, options)` on SDK side
- `LocalMiniappRuntime` stream request/status mapping
- `SocketComms` case for `phone_stream_status`

**Acceptance:** Local miniapp starts an RTMP stream → glasses stream to provided URL → status events flow back to miniapp.

### [OS-1303: Managed Streaming for Local Miniapps](https://linear.app/mentralabs/issue/OS-1303)

Depends on [OS-1294](https://linear.app/mentralabs/issue/OS-1294) and [OS-1297](https://linear.app/mentralabs/issue/OS-1297).

- Same pattern as unmanaged, routed to `ManagedStreamingExtension`
- Refactor `sendStatusToApp` to go through `sendMessageToApp` instead of direct socket write
- `__phone__` bypass in `startManagedStream` / `stopManagedStream`
- Cloudflare API keys stay on cloud, phone never sees them
- `StreamModule.startManaged(options)` returns playback URLs (HLS/DASH/WebRTC)

**Acceptance:** Local miniapp starts a managed stream → cloud provisions via Cloudflare → miniapp gets playback URLs. Existing cloud app streaming unaffected.

### [OS-1304: Port Livestreamer to Local SDK](https://linear.app/mentralabs/issue/OS-1304)

Port Livestreamer miniapp from cloud SDK to `@mentra/miniapp`. Ship as bundled ZIP. Depends on [OS-1302](https://linear.app/mentralabs/issue/OS-1302) and [OS-1303](https://linear.app/mentralabs/issue/OS-1303).

### [OS-1305: Port Call to Local SDK](https://linear.app/mentralabs/issue/OS-1305)

Port Call miniapp from cloud SDK to `@mentra/miniapp`. Ship as bundled ZIP. Depends on [OS-1303](https://linear.app/mentralabs/issue/OS-1303) (Managed Streaming).

### [OS-1306: Port Remaining Miniapps to Local SDK](https://linear.app/mentralabs/issue/OS-1306)

Port all remaining miniapps (Teleprompter, Flash, etc.) from cloud SDK to `@mentra/miniapp`. Ship as bundled ZIPs. Depends on [OS-1301](https://linear.app/mentralabs/issue/OS-1301), [OS-1302](https://linear.app/mentralabs/issue/OS-1302), [OS-1303](https://linear.app/mentralabs/issue/OS-1303).

---

## V3 — Public Developer Access

Local JS SDK is still internal through V1 and V2. This phase opens it up.

### [OS-1307: Developer Console — Local Miniapp Support](https://linear.app/mentralabs/issue/OS-1307)

- Local miniapp submission flow (ZIP upload instead of server URL)
- `miniapp.json` manifest editor / validator in console
- Both cloud and local miniapp types coexist in console
- Cloud miniapps marked as `[Legacy]` with deprecation banner
- "Please migrate to new SDK" messaging on legacy app pages

**Acceptance:** Developer can upload a miniapp ZIP through the console. Cloud apps show legacy badge. Both types visible side by side.

### [OS-1308: Migration Guide (Cloud SDK → Local SDK)](https://linear.app/mentralabs/issue/OS-1308)

- API mapping: `@mentra/sdk` → `@mentra/miniapp` (what maps to what, what's different)
- Architecture change (server app → static bundle)
- New dev workflow (`bun dev` → QR → hot reload)
- Publish on developer docs site

**Acceptance:** A developer with an existing cloud app can follow the guide and produce a working local miniapp.

### [OS-1309: Store — Local Miniapp Install Flow](https://linear.app/mentralabs/issue/OS-1309)

Depends on [OS-1293](https://linear.app/mentralabs/issue/OS-1293) and [OS-1307](https://linear.app/mentralabs/issue/OS-1307).

- Store displays local miniapps alongside cloud apps
- Install flow: user taps install → store serves ZIP URL → phone downloads via `Composer.installFromUrl()` → appears on home screen
- Uninstall from store or app settings

**Acceptance:** User browses store, taps install on a local miniapp, it downloads and appears on home screen.

### [OS-1310: Ungating + npm Publish](https://linear.app/mentralabs/issue/OS-1310)

Depends on [OS-1307](https://linear.app/mentralabs/issue/OS-1307), [OS-1308](https://linear.app/mentralabs/issue/OS-1308), [OS-1309](https://linear.app/mentralabs/issue/OS-1309).

- Move Miniapp Developer screen from behind Mentra Dev Mode to top-level settings
- Publish `@mentra/miniapp`, `@mentra/miniapp-cli`, `create-mentra-miniapp` to npm
- Announce

**Acceptance:** `bunx create-mentra-miniapp` works from npm. Miniapp Developer screen visible without Mentra Dev Mode.

---

## V4 — Cloud SDK Deprecation

After a migration period (~1 month after V3).

### [OS-1311: Deprecate Cloud SDK](https://linear.app/mentralabs/issue/OS-1311)

Depends on [OS-1310](https://linear.app/mentralabs/issue/OS-1310).

- `@mentra/sdk` marked deprecated on npm
- Developer console removes ability to create new cloud apps
- Existing cloud apps continue running (no kill switch)
- Cloud app server infrastructure stays up for remaining apps

**Acceptance:** npm shows deprecation warning on `@mentra/sdk` install. Console blocks new cloud app creation. Existing cloud apps still work.

### [OS-1312: Archive Cloud SDK](https://linear.app/mentralabs/issue/OS-1312)

Depends on [OS-1311](https://linear.app/mentralabs/issue/OS-1311).

- `@mentra/sdk` and `@mentra/react` archived on npm and GitHub
- Remove cloud app infrastructure when no longer needed

**Acceptance:** No cloud apps running. Packages archived. Infrastructure decommissioned.

---

## Key Architectural Decisions

- **Fork, don't refactor.** `@mentra/miniapp` is a new package. `@mentra/sdk` is not modified. Zero risk to existing cloud apps.
- **Phone is the hub.** Local miniapps talk to the phone, phone talks to glasses and cloud. Miniapps never talk to cloud directly.
- **Cloud proxy for STT/translation only.** TTS is a REST URL the phone constructs. Everything else (display, events, buttons, LED, storage, location) is phone-local.
- **Bun Fullstack for dev tooling.** Built-in HMR + console log forwarding. No custom log infrastructure.
- **WebViews stay mounted.** Background miniapps park offscreen with `opacity: 0`, not `display: none` (which evicts JS on some Android versions).
- **Photos must go through cloud.** Glasses and phone are often on different networks. Cloud-hosted upload is the only reliable transport.
- **Internal until V3.** Not publicly accessible until store flow is implemented.
