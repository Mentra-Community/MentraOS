# Island — the MentraOS OEM Integration Engine

> **Status:** design / build plan. **Base branch:** `dev`. The cloud-client move (#5)
> sequences last, once `cloud-v2` has merged into `dev` (days out).

---

## Why

We are turning `@mentra/engine` into the **MentraOS OEM Integration Engine**: a single
library a glasses OEM drops into their app to get *all* of MentraOS — glasses connection,
the miniapp runtime, backend services, OTA, pairing, settings, sensors — while writing
their own UI. The Mentra app becomes the first consumer of that same engine: a thin UI
layer over island, with no privileged backdoor.

Today the logic is inverted — business logic lives in React screens and the app reaches
past island straight into the native modules. This plan moves the logic into island and
makes island the single boundary the UI talks to.

**Scope — this is Phase 1.** Phase 1 moves MentraOS into island so the runtime owns
Mentra's *own* glasses (the SGCs already in `@mentra/bluetooth-sdk`: G1/G2/Live/Nex/Mach1/
Simulated) and the app becomes a UI layer. **Phase 2** (separate, later) makes the glasses
layer *injectable* — an OEM registers its own SGC(s) at runtime instead of PRing them into
`@mentra/bluetooth-sdk` — turning island into a true third-party engine. Phase 1 is the
prerequisite; Phase 2's adapter dynamics are TBD and out of scope here.

## What

**Island is the entire MentraOS runtime. The host is UI + auth.**

- **Island owns** glasses (BLE), the miniapp runtime, **backend comms** (the
  `@mentra/cloud-client`), OTA, pairing, settings + sync, sensors / navigation / media /
  notifications (via `crust`), STT/TTS, display, permissions logic, incident filing.
- **The host provides** its UI and **one required thing: an auth token.** Everything else
  the host needs, it *reads from* or *calls on* island.

> **Governing principle — if the Mentra app's UI uses it, island exposes it.** The Mentra
> app is OEM #1 and the reference consumer; the engine surface is the *union* of
> everything the Mentra app needs. A third-party OEM consumes whatever subset it wants.

The complete host→island injection:

```ts
island.configure({
  auth: { getSubjectToken: () => Promise<{ token: string; type: SubjectTokenType }> }, // REQUIRED
  config?: { coreUrl?, runtimeUrl?, oemId? },
  analytics?: (event: string, props: object) => void,                                  // optional
})
await island.start()
```

That is the whole seam. There is **no** glasses adapter, cloud adapter, nav adapter,
permissions adapter, or display/mic/photo/stream adapter to implement — island bundles
`crust` + `@mentra/bluetooth-sdk` and owns them. The OEM owns login (its identity system)
and feeds island a token; island does the rest.

**The auth seam.** `getSubjectToken` is the dev-today shape: the host hands island a subject
token (on dev, the Supabase session token) that island presents to the cloud-client. It is the
local form of Cloud-V2's **`OemJwtMinter`** model — RFC 8693 token-exchange, where the OEM
backend signs a short-lived JWT (`aud:"mentra"`, fresh `jti`) that island exchanges at
`/api/oem/oauth/token` for a Mentra access JWT + an opaque refresh token. When Cloud-V2's
OEM-auth lands in `dev`, this config field evolves from `getSubjectToken` to `OemJwtMinter` —
a config swap, not a re-architecture, because island already owns the exchange / refresh /
storage on both sides of that change. **Cloud-V2 owns the auth protocol (catalogued in OS-1590);
this plan aligns to it, it does not redesign it.**

## How

Every screen's logic moves the same way — one shape, learned once:

| Layer | Lives in | Owns |
|---|---|---|
| **Coordinator** | `island/src/services/*` | the state machine + timers + sequencing (pure logic) |
| **Device port** | `island/src/services/*`, calls the natives island imports | the BLE/native edges (`sendOtaStart`, `connect`, `heading`…); a thin interface with a mock for tests |
| **Facade** | island store + a getter/`onChanged`/action surface | the framework-agnostic API the UI reads |

Conventions: timers use island's `BgTimer`; state lives in an internal zustand store but is
**never exposed as zustand** — the facade is `getX()` / `onX(cb)→unsubscribe` / `doX()`, so
a React host wraps any domain in `useSyncExternalStore` in one line and a native host bridges
the `onX` events. Coordinators are unit-testable against a mock device port — net-new
coverage for logic that today can only run on a live device.

**Delivery:** one branch on `dev`, built in the order below, debugged after — not a stack of
PRs. Every domain except the cloud-client move (#5) is cloud-agnostic and builds on `dev` now,
shipping incrementally. The cloud-client move needs `@mentra/cloud-client`, which lands in `dev`
when `cloud-v2` merges (days out); it sequences **last**, on `dev`, after that merge — no
separate cloud-v2-branch work. Absorb `cloud-v2` with one early `git merge dev` while the branch
is young, so the only reconcile (`MantleManager`, `components/home`, the media coordinators,
island's `config.ts`) stays small. v1 comms route through island in the sweep — legitimate,
since v1 serves traffic for ~a month yet and shares the single `getSubjectToken` seam with v2
(same Supabase session; v1's extra token exchange is self-contained and deletes with v1).

---

## At a glance — what moves into island

| # | Domain → island | Complexity | Removes (native imports) | Notes |
|---|---|---|---|---|
| 1 | `GlassesReadiness` primitive | **S** | — | foundation; "wait for booted + timeout"; Pairing/Connection need it |
| 2 | **Connection** coordinator | **M** | `home.tsx`, `DeviceStatus`, `Reconnect` btsdk | unifies reconnect logic split across 3 files |
| 3 | **Pairing** coordinator | **M** | `app/pairing/*` btsdk | builds on #1 + #2 |
| 4 | **AppList** service (pure) | **M** | — (pure) | low-risk warm-up; `AppsGrid` is 655 lines of pure computation |
| 5 | **Cloud-client + auth** into island | **L** | host `cloudClient.ts` ownership | the keystone — turns the host into "UI + auth" |
| 6 | **Settings** (keyed) + device ports | **L** | settings-screen btsdk | large surface; device + user settings unified |
| 7 | Feature domains: **gallery, incidents, phoneNotifications, speech, wifi, logs** | **M** each | respective btsdk/crust | self-contained facades; `incidents` (bug-report) also backs pairing/OTA auto-filing; camera ones capability-gated |
| 8 | **Native re-export sweep** + the `glasses.btsdk` passthrough | **M** | the orphan imports (incl. `app/ota/*`) | re-export btsdk/crust through island; ESLint ratchet locks the boundary |
| — | **Onboarding** | — | — | **stays host UI**; island adds raw input events + `isFirstPairing` |
| — | **OTA** | — | `app/ota/*` btsdk → `glasses.btsdk` | Mentra-Live firmware orchestration; lives in the Mentra app, driving the glasses through `island.glasses.btsdk` |

Build order: 1 → 2 → 3; 4/6/7/8 slot in independently. The cloud-client move (#5) sequences
**last** — it needs `@mentra/cloud-client`, which arrives in `dev` when cloud-v2 merges (days
out). v1 and v2 are separate transports, so until then island consumes v1 via `socketComms`
unchanged.

## At a glance — the API surface

| Domain | Purpose |
|---|---|
| `island.session` | backend + identity session; account delete / data-export |
| `island.glasses` | connect/disconnect/reconnect; live status; `info()`; `capabilities()`; controller |
| `island.glasses.wifi` / `.hotspot` | scan/connect/forget; hotspot toggle (camera glasses; capability-gated) |
| `island.glasses.settings` | device settings — **keyed** `get/set/onChanged(key)` + `descriptor()` |
| `island.glasses.btsdk` | typed btsdk **passthrough** — escape hatch for what no facade models (OTA, raw/new commands) |
| `island.pairing` | scan / pair / state machine |
| `island.permissions` | request / check + **miniapp-perms → phone-perms mapping** |
| `island.miniapps` | lifecycle / install / store / dev + the **`<MiniappView>` component** |
| `island.settings` | user prefs — keyed `get/set/onChanged(key)` |
| `island.speech` | on-device STT/TTS model management |
| `island.display.mirror` | live preview of the glasses screen |
| `island.notifications` | runtime → host alerts (crashloop, firmware/client too old) — host renders |
| `island.incidents` | bug-report filing — bundles logs + state + glasses logs, submits; manual + automatic |
| `island.gallery` | photos/videos synced from the glasses |
| `island.phoneNotifications` | phone → glasses notification forwarding |
| `island.logs` | host debug console feed |
| `island.dev` | backend/cloud-URL switching, health checks |

---

## The complete API surface (detail)

Shape rule everywhere: `getX()` (snapshot) · `onX(cb) → unsubscribe` · `doX()` (action).

### `island.session` — backend + identity session (lands with the cloud-client move, #5)
`status()` (connected|connecting|reconnecting|offline) · `onStatusChanged(cb)` · `user()`
(id/email/name/avatar/provider) · `onUserChanged(cb)` · `isAuthenticated()` · `signOut()` ·
`account.delete()` · `account.requestDataExport()`. *(Account ops hit the Mentra backend and
stay in island — an OEM offering "delete account" must also delete the user's Mentra account
registered through them.)*

### `island.glasses` — connection + live status + info
- connection: `status()` {state, fullyBooted} · `onStatusChanged(cb)` · `connect()` ·
  `disconnect()` · `reconnect()` · `forget()` · `connectSimulated()`
- controller/ring: `controller.status()` · `controller.connect()/disconnect()/forget()`
- live snapshot (on `onStatusChanged`): battery, charging, caseBattery, caseCharging, caseOpen,
  caseRemoved, signalStrength, micEnabled, vadEnabled, btClassicConnected
- info: `info()` {model, style, color, firmwareVersion, mtk/besFirmware, serialNumber, btMac,
  buildNumber} · `capabilities()` {hasCamera, hasButton, hasIMU, hasMic, hasDisplay}
- raw input events (used by onboarding + miniapps): `onButtonPress(cb)` · `onTouchGesture(cb)`

### `island.glasses.wifi` / `.hotspot` (camera glasses; capability-gated)
- wifi: `scan(): Promise<WifiResult[]>` (+ optional `onScanResult(cb)`) · `connect(ssid, pw)` ·
  `forget(ssid)` · `current()` {state, ssid, localIp} · `onChanged(cb)` · `savedNetworks()`
- hotspot: `setEnabled(bool)` · `status()` {state, ssid, password, localIp} · `onChanged(cb)` · `onError(cb)`

### `island.glasses.settings` — DEVICE settings (keyed, pushed to glasses)
`get(key)` · `set(key, val): Promise<void>` (resolves on glasses-ack) · `onChanged(key, cb)`, over
a **typed key→value schema** (`set(K.brightness, 50)` is type-checked). Keys: brightness,
autoBrightness, dashboard{Height,Depth,Contextual,UseNative}, headUpAngle,
camera{PhotoSize,VideoResolution,Fps,MaxRecordingTime,Fov,Roi,Led}, mic{Preferred,Lc3FrameSize},
sensing{Enabled,Vad}, powerSaving, galleryMode, button{DefaultAction,DefaultApp,MenuApps}.
- `descriptor(key)` / `available()` → which keys apply to the **connected** device + their
  type/range/enum (dashboard depth maxes at 3 vs 4 by model). Model-gating lives in island; the
  UI renders controls from the descriptor.
- true actions stay explicit: `requestVersionInfo()`, `factoryReset()`.

### `island.pairing`
`scan(model)` · `onDeviceFound(cb)` · `pair(device)` · `state()`
(idle→scanning→connecting→booting→booted|failed|timeout) · `onStateChanged(cb)`.

### `island.glasses.btsdk` — typed passthrough (the escape hatch)
The re-exported `@mentra/bluetooth-sdk` command + event surface, namespaced under glasses:
`<cmd>(...)` (e.g. `sendOtaStart(url)`, `sendOtaQueryStatus()`, `requestVersionInfo()`) ·
`on(event, cb)` (e.g. `ota_status`, `version_info`). It exists so the host can drive
device-specific things island does **not** model — chiefly **OTA**, the Mentra-Live firmware
flow (APK→MTK→BES), which lives in the Mentra app (its only consumer). Because the call routes
through island, the app's OTA code imports only `@mentra/engine`.

> **Facades vs passthrough.** Model *shared* capabilities (connection, settings, wifi, pairing)
> as typed facades; reach for `glasses.btsdk` only for the *long tail* no facade covers. If a
> facade owns a capability, go through the facade — calling btsdk raw for a facade-managed
> setting bypasses island's state/sync/events and leaves the facade's snapshot stale.

### `island.permissions`
`request(features[]): Promise<Map<feature,bool>>` · `check(features[])` · `onChanged(cb)` ·
`requirementsForMiniapp(pkg): Permission[]` (maps a miniapp's declared perms → phone perms) ·
`openSettings()`. Island owns the iOS/Android branching, the OS dialogs (via the native modules
it bundles), and the miniapp→phone mapping.

### `island.miniapps` — lifecycle + store + dev + the WebView component
- lifecycle: `list()` · `onChanged(cb)` · `running()` · `start(pkg, opts?)` · `stop(pkg)` ·
  `setForeground(pkg)` · `clearForeground()` · `stopAll()` · `install(src)` · `uninstall(pkg)` ·
  `refresh()` · `setHidden(pkg, bool)` · `order()/saveOrder()` · `saveLastOpen(pkg)`
- store: `storeUrl()` (host mounts a WebView at it) · `onStoreMessage(cb)`
- dev sideload: `decideDevLaunch(pkg, url)` · `registerDevApp(record)` · `DEV_APP_PACKAGE_NAME`
- **`<MiniappView packageName onExit />`** — the mountable component (see "Miniapp UI" below).

### `island.settings` — USER prefs (keyed; store + cloud sync, island-owned)
Same keyed + typed-schema shape as device settings: `get(key)` · `set(key, val)` ·
`onChanged(key, cb)` — theme, devMode, superMode, blur/squircles, notifications, metric/12h-time/
timezone, offlineMode, reconnectOnForeground, onboarding flags, … One mechanism, two key
namespaces; device keys (above) additionally push to the glasses.

### `island.speech` — on-device STT/TTS model management
`stt|tts.currentLanguage()` · `.languages(): LanguageInfo[]` · `.download(code, onProgress)` ·
`.activate(code)` · `.cancelDownload()` · `.onStatusChanged(cb)`.

### `island.display.mirror` — phone-side preview of the glasses screen
`onMirror(cb: (e: DisplayEvent) => void)` (live processed layout/bitmap/text) · `current()` ·
`setView("main"|"dashboard")` · `sendButtonPress(btn, type)` (simulated glasses).

### `island.notifications` — runtime → host alerts (INBOUND: island → host)
`onNotification(cb)` — island detects a condition (crashloop, firmware / client-version-too-old,
persistent reconnect failure) and emits a signal; the host renders it (toast / dialog / banner)
however it likes. Island owns detection + the signal; the host owns the UI. This is *not* where bug
reports go — that's `island.incidents`, the opposite direction.

### `island.incidents` — bug-report filing (OUTBOUND: user/runtime → backend)
The `services/bugReport/*` system moved into island — it's assembled entirely from island-owned
state, so only island can build it. Two entry points:
- `file({description, expected, actual, severity, contactEmail?, screenshots?}) → {incidentId}` —
  the **user-initiated** path (an OEM's "report a bug" screen calls this).
- `fileAutomatic({categorization, dedupeKey, …})` — the **system-triggered** path (deduped),
  used by failure detectors (miniapp won't start, gallery playback fails, the 35 s boot watchdog).

Either way island bundles the diagnostics — `phoneState` (every island store, sensitive keys
stripped) + recent phone logs + the **glasses' own logs** (via `btsdk.sendIncidentId(id, url)`,
which makes the glasses upload to the backend keyed by the id) + screenshots — POSTs to the
incident endpoint, and returns an id the host can show ("reported — ref #…").

**The OEM writes its own "report a bug" screen** (host UI, like onboarding); island does the
collection + submission. A crashloop is the case where both domains fire on one event:
`incidents.fileAutomatic()` (outbound, so we can debug) **and** a `notifications` alert (inbound,
so the user sees it). **Open question — destination:** incidents land in the cloud incident backend
tagged with `oemId`; whether an OEM's reports are visible to that OEM and/or routed to their own
support is a backend / OEM-portal concern, and `/api/incidents` isn't specced in cloud-v2 yet.

### `island.gallery` — media synced from the glasses (camera glasses)
`list()` · `onChanged(cb)` (photos/videos + thumbnails) · `syncState()` {idle|syncing|error,
progress} · `onSyncState(cb)` · `startSync()` · `cancelSync()` · `delete(id)` · settings
`autoSync`/`wifiOnly`. Island owns the hotspot-based transfer + media-processing queue + validation.

### `island.phoneNotifications` — phone → glasses forwarding
`enabled()/setEnabled()` · `installedApps(): {pkg,name,icon}[]` · `blocklist()/setBlocklist()` ·
`hasListenerPermission()` · `requestListenerPermission()`.

### `island.logs` — host debug console
`snapshot(pkg?)` · `onLog(cb)` {level, tag, message, ts, source} · `setLevel(...)`.

### `island.dev` — developer/debug
`backendUrl()/setBackendUrl()/testBackendUrl()` · `cloudUrls()/setCloudUrls()/testCloud()` ·
`savedUrls()/add/remove` · `reconnectSocket()` · `minimumClientVersion()` · misc toggles.

*(Calendar: island reads the phone calendar via an `island.permissions` ask and forwards events
to the glasses — internal sync + a `calendarSync` setting key; no dedicated facade.)*

---

## Settings shape: keyed + typed schema

Keyed `get/set/onChanged(key)` over a typed key→value map, **not ~40 named methods.** In
TypeScript the usual "keyed loses type-safety" tradeoff doesn't apply — a mapped type gives
per-key checking (`set(K.brightness, 50)` ✓, `set(K.brightness, "x")` ✗) with a 3-method
surface. `descriptor()` returns the applicable keys + ranges for the connected device, so
model-gating lives in island and the UI renders controls generically. Strictly better than
named methods: tiny surface, type-safe, future-proof as devices add settings.

## Miniapp UI — island ships the component

Brownfield reality: an OEM's native app **embeds React Native, and island is that embedded
runtime.** The miniapp background JSContext (Crust, an Expo native module) and the miniapp UI
WebView (`react-native-webview`) both live inside it. So there is no "native WKWebView talking
to JS over a hand-rolled bridge" — the miniapp surface is an **RN component placed into the
native view hierarchy** (standard RN-in-native embedding).

The bridge it wraps is sophisticated and platform-coupled — RPC with timeout/abort, send-before-
ready buffering, per-channel pending queues, the ready handshake, respawn, and a real iOS-vs-
Android injection-timing dance (the Android shim must be a WebViewCompat document-start script
because `injectedJavaScriptBeforeContentLoaded` is unreliable there). **No host should
reimplement any of it.**

Therefore the contract is a single mountable component:

```tsx
import { MiniappView } from "@mentra/engine"
<MiniappView packageName={pkg} onExit={...} />   // island owns spawn, shim, routing, handshake, respawn, the capsule menu
```

The host's only jobs: place the component (where + when, i.e. navigation) and unmount it on
close. The low-level primitives (`bindWebView` / `routeFromWebView` / `routeFromBackground` /
`spawnAndRegister`) remain **island-internal**; they are not part of the OEM contract.

## Onboarding — stays host UI

Onboarding is UI-layer orchestration (a dual `expo-video` player pool, fades, step sequencing)
wrapped around two runtime facts. Island provides exactly those facts; it does **not** get an
onboarding coordinator:

- the raw input events — `island.glasses.onButtonPress(cb)` / `onTouchGesture(cb)`,
- whether this is a first-time pair — `island.glasses.isFirstPairing(deviceId): boolean`.

The host owns the entire onboarding flow/UI.

---

## Extraction detail (per domain)

### Foundation — `GlassesReadiness`
Promote `mobile/src/utils/glasses.ts`'s `waitForState(key, predicate, timeoutMs)` + the boot-
timeout watchdog into island. Pairing (the 35s boot watchdog → incident) and Connection (boot
detection) build on it; the app's OTA flow also uses it via the passthrough. Cheapest first
step; no new seam.

### OTA — in the Mentra app, on `glasses.btsdk`
OTA is Mentra-Live firmware orchestration (APK→MTK→BES sequencing; the watchdog cascade — global
20 min, retry 5 s ×3, stuck-at-0 % 70 s, per-step 120 s, MTK 300 s, post-APK 6 s, query-reply 6 s,
10 s ping; reconnect+version gating; `mtkUpdatedThisSession` filter; index resync; stall
signature). Mentra Live is its only consumer, so it lives in the Mentra app. Its `app/ota/*` code
reaches the glasses through `island.glasses.btsdk` (`sendOtaStart`, `requestVersionInfo`,
`on("ota_status")`, …) — importing only island — and surfaces failures through
`island.notifications`.

### Connection — `ConnectionCoordinator`
Unifies reconnect logic split across `home.tsx`, `DeviceStatus.tsx`, and `effects/Reconnect.tsx`:
the setting-gated `attemptReconnect`, the connect/disconnect decision, searching-state debounce,
and boot detection (delegating to `GlassesReadiness`). Device edges (connect/disconnect/
btsettings/boot-event) are an island-internal port over btsdk. `DeviceStatus.tsx` keeps only
image-asset selection + rendering.

### Pairing — `PairingCoordinator`
The pairing/boot state machine, the 35s boot watchdog → incident, `pair_failure`/disconnect/
unpair routing decisions (island exposes the decision; the host navigates), and the success-
routing classifier. Permission *dialogs* stay host-rendered but the permission *logic* is
`island.permissions`.

### AppList — `AppListService` (pure)
`AppsGrid.tsx` (655 lines) is mostly pure computation: grid composition (filter/empty-slot-fill/
dummy-insert/order-vs-priority sort), `placeAppOnHome`/`reorderApps` + order persistence, and the
`determineRoute(app)` classifier duplicated across three components. Pure → lowest-risk warm-up
that proves the pattern. Gestures/animation/sheets stay UI.

### Cloud-client + auth — the keystone (last; needs cloud-v2 in dev)
Runs once `cloud-v2` has merged into `dev`, so `@mentra/cloud-client` exists. Relocate its
singleton from `mobile/src/services/cloudClient.ts` **into** island; island constructs it with
island-owned transports (the UDP socket is already in island) and the host-injected auth seam,
exposes `island.session`, and drives transcription/managed-photo/stream. The auth seam is the
one from the contract — `getSubjectToken` on dev, evolving to Cloud-V2's `OemJwtMinter` (RFC 8693)
when OEM-auth lands; island owns the token-exchange + opaque-refresh + storage either way, so the
host only ever provides the mint. Wire protocol: OS-1590. Until the move runs, v1 stays host-owned
and its comms route their btsdk imports through island in the sweep; island consumes v1 via the
`socketComms` path until v1 is retired (~a month).

---

## The native dependency boundary

End-state: the app imports `@mentra/engine` only; island imports `crust` + `@mentra/bluetooth-sdk`
and exposes their surface. Today the app reaches past island in **80 files** (67 btsdk + 13
crust). Most die for free — when a coordinator lands, its screens stop importing btsdk because the
device port owns the calls. The sweep (#8) mops up the orphans: re-export btsdk through
`island/index.ts`; wrap `crust`'s capabilities (heading, nav, media, notifications) as island
services. An ESLint `no-restricted-imports` rule banning `crust`/`@mentra/bluetooth-sdk` outside
`mobile/modules/engine/**` ratchets the boundary shut per migrated surface.

Two special cases: `stores/glasses.ts` + `stores/core.ts` move **into** island (they *are* the
device-state store the coordinators read); the `photo`/`video`/`streaming` coordinators collapse
their btsdk imports inward (they predate island owning btsdk). `MantleManager.ts` (imports both
natives) stays host as the bootstrap that injects island, and cleans up last.

## Background execution + Android packaging

MentraOS runs continuously in the background (BLE link, always-on miniapp JSContexts, audio).
The embedded RN runtime lives as long as its host **process** does:

- **iOS** — the `bluetooth-central` background mode keeps the process alive while connected. The
  OEM adds it to their `Info.plist`; no island code.
- **Android** — a backgrounded process is reaped unless a **foreground service** holds it.
  island's FGS is `com.mentra.bluetoothsdk.services.ForegroundService` (type auto-detected at
  runtime: `connectedDevice`, `+microphone`/`+dataSync` while streaming), started/stopped from
  `DeviceManager` on connect/disconnect.

The engine's Android packaging has **two layers that merge differently**: a library module's
AndroidManifest **auto-merges** into the consuming app; **Gradle build config does not.**
`mobile/plugins/android.ts` is the *Mentra app's* Expo config plugin (runs only in Mentra's
prebuild; an OEM never runs it), so anything an island module needs that currently lives there
is invisible to OEMs and must be relocated.

### Layer 1 — manifest (auto-merges; target = zero OEM action)
Move each runtime requirement into the owning module manifest (`bluetooth-sdk` for BLE/FGS,
`crust` for notifications/nav):

| Entry | Today | → Target |
|---|---|---|
| FGS `<service>` + `connectedDevice\|dataSync\|microphone` + core FGS perms | bluetooth-sdk manifest | keep |
| `POST_NOTIFICATIONS` (FGS notification, A13+; without it the FGS is invalid on A14+) | plugin only | **→ bluetooth-sdk manifest** |
| `READ_PHONE_STATE` (pairing) | plugin only | **→ bluetooth-sdk manifest** |
| BLE perms (`BLUETOOTH*`, location) | both (dup) | bluetooth-sdk; drop plugin dup |
| `QUERY_ALL_PACKAGES` (phone-notif app picker) | plugin only | **→ crust manifest** |
| Google Nav `com.google.android.geo.API_KEY` meta-data | plugin (env value) | **→ crust manifest** with a `${navApiKey}` manifest-placeholder; consumer supplies the value |
| `RECEIVE_BOOT_COMPLETED` | plugin only | **drop** — no boot receiver exists |
| `NEARBY_DEVICES` | plugin only | **drop/fix** — not a real permission |
| FileProvider `<provider>` + `res/xml/file_paths.xml` (gallery/STT/recordings) | plugin writes | **→ bluetooth-sdk module resources** |
| `networkSecurityConfig` (cleartext to glasses) | plugin writes | **→ module resources** |
| media/`AD_ID` **removals** (`tools:node="remove"`) | plugin | **stays app-policy** (Mentra's Play stance; OEM does its own) |

Make the FGS notification **brandable**: `Foreground.kt` hardcodes `setContentTitle("Mentra
Connected")` + a system icon. Read title/icon from `R.string`/`R.drawable` resources so an OEM
overrides by shadowing the resource — no code fork.

### Layer 2 — Gradle (does **not** merge)
Two different things hide here; separate them.

**(a) Config the consuming app genuinely must set → ship as `@mentra/engine/plugin`** (an Expo
config plugin in the island package; native OEMs follow the same snippets):
- enable `coreLibraryDesugaring` (`+ desugar_jdk_libs`) — AGP requires the *app* to enable it
  because crust's Nav SDK uses Java 8+ APIs; crust enables it module-side, the app must too.
- native-lib packaging: `pickFirst` `libonnxruntime*.so` / `libc++_shared.so` (btsdk + `:silero`
  share one onnxruntime), exclude `protobuf-javalite` (collides with btsdk's `protobuf-java`),
  cmake `c++20`/`c++_shared`. Confirm each at implementation — btsdk already declares some of
  this module-side, so the app-side copies may be reducible.

**(b) Module-internal leaks to engineer away (not OEM obligations):** `:lc3Lib` is **btsdk-only**
(the app never references it; btsdk does `implementation project(':lc3Lib')`), yet today the
app's `settings.gradle` must register `:lc3Lib`. Fix at the source — btsdk depends on a published
`lc3` artifact (lc3Lib already has a Maven publish task) instead of `project(':lc3Lib')`, so no
consumer `settings.gradle` entry exists.

Mentra's app-only glue (signing, versionName, Sentry, deep-link scheme, heap/node-path) stays in
`mobile/plugins/android.ts` and is not part of the engine.

### OEM residual obligations (irreducible — policy / branding / keys)
1. Apply `@mentra/engine/plugin` (Expo) or the documented Gradle steps (native).
2. Supply a Google Nav API key value (or use Mentra's).
3. Play Console: justify the FGS types (`connectedDevice`, `microphone`) and `QUERY_ALL_PACKAGES`.
4. iOS: add the `bluetooth-central` background mode to `Info.plist`.
5. Optional: override the FGS notification string/icon resources for branding.

## Risks · non-goals · testing

- **Passthrough discipline.** Facade-owned capabilities go through the facade; `glasses.btsdk`
  is only for the long tail no facade models (OTA, unmodeled commands). A raw call for a
  facade-managed capability leaves island's snapshot stale.
- **The keystone needs cloud-v2 in dev.** It relocates `@mentra/cloud-client`, which lands when
  cloud-v2 merges (~days), so it sequences last. Absorb cloud-v2 via an early `git merge dev` so
  the one-time reconcile (`MantleManager`, `components/home`, the media coordinators, island's
  `config.ts`) stays small.
- **Stays host:** login/OAuth UI + the auth provider (feeds `getSubjectToken`); gesture/animation,
  WebView *placement* (island owns the component), `expo-video` players, screen routing (island
  exposes state, host maps to screens); OEM branding.
- **Testing:** every coordinator ships a jest suite driving it through a mock device port
  (fabricated BLE events, fake `BgTimer`) — net-new coverage for logic that today only runs live.

## Appendix A — direct-native-import offenders

Regenerate: `grep -rl "@mentra/bluetooth-sdk" mobile/src | grep -v __tests__` (67) ·
`grep -rlE "from ['\"]crust['\"]" mobile/src` (13). Bucketed by the PR that removes the import
(✅ a coordinator owns the calls so the import vanishes; 🔁 re-point to `@mentra/engine` in the
sweep):

- **OTA** 🔁 (stays in the app; re-point to `island.glasses.btsdk`) `app/ota/{check-for-updates,progress,progress-legacy,deriveOtaDisplayState}.tsx`,
  `components/glasses/OtaProgressSection.tsx`, `effects/OtaUpdateChecker.tsx`,
  `services/asg/glassesClockSync.ts`, `utils/otaErrorMapping.ts`, `utils/otaLegacyMapping.ts`
- **Connection** ✅ `components/home/DeviceStatus.tsx`, `effects/Reconnect.tsx`,
  `hooks/useSearchingState.ts`, `components/glasses/ConnectDeviceButton.tsx`,
  `components/home/PairGlassesCard.tsx`
- **Pairing** ✅ `app/pairing/{prep,prep-controller,scan,scan-controller,loading,success,btclassic,unpair-even,failure,select-glasses-model}.tsx`,
  `components/onboarding/waitForGlassesEvent.ts`
- **Sweep** 🔁 `app/miniapps/settings/{camera,controller,glasses,speech,stress-test,super,notifications,privacy}.tsx`,
  `app/wifi/{connecting,scan}.tsx`, `components/dev/CoreStatusBar.tsx`,
  `components/glasses/NexDeveloperSettings.tsx`, `effects/{ButtonActions,WhisperTest,ScreenshotFeedbackPrompt}.tsx`,
  `services/{AudioPlaybackService,RestComms,SocketComms,SocketComms.normalizers,HeadingService,NavigationService,mentraJsBootstrap}.ts`,
  `services/asg/{gallerySyncService,mediaProcessingQueue}.ts`, `services/bugReport/*` (→ `island.incidents`, domain #7),
  `services/miniapps/MiniappCatalog.ts`, `services/{photo,video,streaming}/Phone*Coordinator.ts`,
  `stores/{glasses,core}.ts` (→ move into island), `utils/{LogoutUtils,PermissionsUtils,SettingsNavigationUtils,NotificationServiceUtils}.tsx`,
  `utils/permissions/MediaLibraryPermissions.ts`
- **Wiring layer:** `services/MantleManager.ts` (both natives) — stays host, cleans up last.
