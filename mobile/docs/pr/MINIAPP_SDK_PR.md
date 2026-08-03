# Miniapp SDK Branch — Engineering Handover

This is the design + handover doc for the work landing on `mentra-miniapp-sdk-aryan`. It walks the system end-to-end: the native bridge (crust), the JS-side host services (HeadingService, LocationManager, NavigationService), the runtime that brokers requests from miniapps to the host (LocalMiniappRuntime in `@mentra/engine`), the developer-facing SDK (`@mentra/miniapp`), the WebView host that mounts miniapps inside the manager (MiniappHost), and the new dev-loop screens (scanner, dev-URL, dev-offline, local mount).

It is written so a fresh engineer can pick up any layer without having to reverse-engineer the others. Numbers in the diff: **49 mobile files changed, +7701 / −555**.

---

## TL;DR

Three things shipped on this branch:

1. **A turn-by-turn navigation pipeline** — Google Navigation SDK on iOS + Android, exposed through the `crust` Expo module, fanned out by a JS singleton (`NavigationService`), wired into the miniapp runtime (`LocalMiniappRuntime`), and surfaced to miniapp authors as `session.navigation.*` in `@mentra/miniapp`. Includes a SDK-side **pivot engine** that synthesizes `CROSS_STREET` maneuvers from polyline geometry so glasses HUDs can prompt at crosswalks.
2. **A heading + location pipeline** — magnetic compass (`crust.startHeading()` → `HeadingService` → `heading_update` stream) and GPS (`expo-location` → `LocationManager` → `location_update` stream / `LOCATION_POLL` request).
3. **A dev loop for local miniapps** — QR scanner, manual dev-URL entry, recent-list, an "offline" splash when the dev server is down, and a route (`/applet/local`) that mounts a dev miniapp into the existing `MiniappHost` WebView pool.

Everything else on the branch is plumbing in service of those three: app config keys for the Google Nav API, an Android Gradle plugin update for core-library desugaring (Nav SDK requires Java 8+ APIs), a manifest-permission request flow, lint cleanup, and a new `mobile/docs/` tree.

---

## High-level architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Miniapp (WebView)                                                           │
│   import {MiniappSession} from "@mentra/miniapp"                            │
│   session.navigation.start({stops})                                         │
│   session.navigation.onUpdate(handler)                                      │
│   session.heading.onUpdate(handler)                                         │
│   session.location.onUpdate(handler)                                        │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │ envelope (JSON over postMessage / local socket)
                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ LocalMiniappRuntime (in @mentra/engine)                                     │
│   - Owns the session-per-app map                                            │
│   - Receives MiniappRequest envelopes, dispatches by type                   │
│   - Owns ref-counted host-side subscriptions (heading, location, nav)       │
│   - Translates host events back to MiniappStream EVENT envelopes            │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │ getRuntimeHooks().{navigation, heading, ...}
                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Mobile-app host (mobile/src/services/)                                      │
│   NavigationService — singleton, wraps crust Nav events                     │
│   HeadingService    — singleton, wraps crust onHeading                      │
│   LocationManager   — singleton, wraps expo-location                        │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │ CrustModule.<asyncFn>() / addListener(<eventName>)
                               ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ crust (Expo native module)  ── iOS Swift + Android Kotlin parity            │
│   NavigationManager — Google Navigation SDK lifecycle                       │
│   HeadingManager    — CLLocationManager / SensorManager                     │
│   (plus the existing settings, notifications, media, AV-routing surface)    │
└─────────────────────────────────────────────────────────────────────────────┘
```

The same chain is used by *built-in app code* too — the developer-settings screen (`/miniapps/settings/developer`) calls `navigationService.start(...)` directly without going through the SDK / runtime. That's deliberate: anything inside the manager is allowed to talk to a host service directly; only sandboxed miniapps must go via the runtime.

---

## Layer 1 — `crust` native module

`mobile/modules/crust/` is the catch-all Expo native module on the mobile side. The pre-existing surface (notifications, settings, installed-apps, media, AV-routing) is unchanged. What's new on this branch:

- **Navigation** — Google Navigation SDK on both platforms.
- **Heading** — magnetic compass on both platforms.

Existing module docs already explain crust's role and layout — see [docs/module/crust/README.md](module/crust/README.md). The two new feature pages are [docs/module/crust/Navigation.md](module/crust/Navigation.md) and [docs/module/crust/Heading.md](module/crust/Heading.md).

### Navigation (`crust.startNavigation` / events)

- **Entry points:** [CrustModule.swift](../modules/crust/ios/CrustModule.swift) and [CrustModule.kt](../modules/crust/android/src/main/java/com/mentra/crust/CrustModule.kt) — thin dispatchers.
- **Real work:** [NavigationManager.swift](../modules/crust/ios/navigation/NavigationManager.swift) and [NavigationManager.kt](../modules/crust/android/src/main/java/com/mentra/crust/navigation/NavigationManager.kt) — own the `GMSNavigator` / Android `Navigator` lifecycle, polyline + step extraction, off-route detection, and simulator polling.
- **Android-specific:** [NavInfoReceiverService.kt](../modules/crust/android/src/main/java/com/mentra/crust/navigation/NavInfoReceiverService.kt) — bound by `Navigator.registerServiceForNavUpdates()` so we can read road names off the SDK's `StepInfo` ticks.
- **Payload helpers:** [NavPayloads.swift](../modules/crust/ios/navigation/NavPayloads.swift) — `maneuverString()` enum mapping and `pathToPoints()` polyline encoder for iOS.

The full event vocabulary lives in [Crust.types.ts](../modules/crust/src/Crust.types.ts):
`onNavRoute`, `onNavManeuver`, `onNavLocation`, `onNavRerouting`, `onNavOffRoute`, `onNavArrived`, `onNavError`, `onHeading`.

Permissions: `requestNavigationPermission()` is **idempotent** — it shows the Google Nav T&C dialog if not yet accepted, otherwise resolves `{accepted: true}` immediately. It is safe (and intended) to call eagerly on mount. Once the user accepts, the acceptance is persisted inside the MentraOS app and survives across launches; it goes away only if the user deletes the app. Behavior across app updates has not been tested yet, so treat that as unverified.

Dev-only navigation toggles surface as `crust.simulateDeviation()`, `crust.setWrongSidewalkOffset()`, `crust.setSkipCrossings()`. They're Android-only today; iOS is a no-op stub. They exist to reproduce specific pivot scenarios (e.g. wrong-sidewalk-then-missed-the-turn) inside the simulator.

### Heading (`crust.startHeading` / `onHeading`)

- **Native:** [HeadingManager.swift](../modules/crust/ios/heading/HeadingManager.swift) (CLLocationManager + 1° threshold) and [HeadingManager.kt](../modules/crust/android/src/main/java/com/mentra/crust/heading/HeadingManager.kt) (SensorManager).
- **Contract:** emits `onHeading: { degrees }` only when the angle changes ≥1° since the last emission. Keeps the bridge quiet at rest.

### Native build configuration (Android only)

Two changes were required for the Google Nav SDK to link cleanly:

1. **Core library desugaring** — Nav SDK uses Java 8+ APIs. Enabled in `mobile/modules/crust/android/build.gradle` and (for the host app) injected by [plugins/android.ts](../plugins/android.ts) into the generated `app/build.gradle` (`compileOptions { coreLibraryDesugaringEnabled true }` plus `coreLibraryDesugaring 'com.android.tools:desugar_jdk_libs:2.1.4'`).
2. **API key wiring** — the same plugin injects `<meta-data android:name="com.google.android.geo.API_KEY" android:value="${EXPO_PUBLIC_GOOGLE_NAV_API_KEY}"/>` into the merged manifest at build time.

iOS reads its key from the `Info.plist` field `GOOGLE_NAV_API_KEY`, populated in [app.config.ts](../app.config.ts) from the same env var.

The Android plugin file also restored `withSettingsGradleModifications` so the LC3 codec subproject (`modules/bluetooth-sdk/android/lc3Lib`) is registered with Gradle. That had been commented out — it's needed because the bluetooth-sdk's `build.gradle` references `implementation project(':lc3Lib')` and Expo prebuild doesn't infer it.

### Environment variables

- **`EXPO_PUBLIC_GOOGLE_NAV_API_KEY`** — required at build time. Added to [.env.example](../.env.example). Without it, the build still completes but `startNavigation` will fail at runtime with an SDK initialization error.
- **`NSMotionUsageDescription`** — added to the iOS Info.plist via app.config. iOS hard-crashes on any motion-sensor access without this string declared. The host's HeadingService reads CoreMotion when a miniapp subscribes to `heading_update`, so the string is required even though no manager code calls CoreMotion directly.

---

## Layer 2 — Host-side services (`mobile/src/services/`)

These are the JS-side singletons that own the lifetime of crust-backed sensor / nav subscriptions. They follow a consistent shape:

- Singleton (`getInstance()`).
- Reference-counted: native side starts on first listener, stops when the last one unsubscribes.
- Late subscribers get the most recent value replayed synchronously where applicable.
- Errors in listener callbacks are caught and logged so one bad consumer can't kill the fan-out.

### `HeadingService` — [src/services/HeadingService.ts](../src/services/HeadingService.ts)

Wraps `crust.startHeading` / `crust.stopHeading` / `onHeading`. Public API:

```ts
addListener(listener: (degrees: number) => void): () => void
```

That's the whole surface. The internal logic owns the `nativeStarted` flag and the most-recent-value cache so that "I just subscribed, give me the current heading" doesn't need to wait for the next sensor tick.

### `LocationManager` — [src/services/LocationManager.ts](../src/services/LocationManager.ts)

Thin wrapper over `expo-location`. Public API:

```ts
requestPermission(): Promise<boolean>
getCurrentPosition(accuracy?): Promise<Coords | null>   // fresh fix
getLastKnownPosition(): Promise<Coords | null>          // OS cache
addListener(listener, opts?): () => void                // continuous
cleanup(): void
```

Permissions are requested lazily on first use; callers can call `requestPermission()` up-front during onboarding. Watcher start/stop is reference-counted on subscriber count. Background tracking is intentionally NOT here — that path goes through `MantleManager` which uses `expo-task-manager` for the long-running case.

### `NavigationService` — [src/services/NavigationService.ts](../src/services/NavigationService.ts)

The most complex of the three. Wraps the full Google Nav SDK exposed by crust. Public surface:

- **Trip lifecycle:** `start({lat, lng}, options)`, `stop()`, `requestPermission()`.
- **Subscriptions:** `addListener` (NavUpdate), `addLocationListener` (road-snapped GPS), `addRouteListener` (polyline + steps).
- **State:** `getState(): "idle" | "navigating" | "rerouting" | "arrived"`, `getSnapshot(): NavTripSnapshot | null` — for mid-trip mounts.
- **Dev helpers:** `simulateDeviation`, `setWrongSidewalkOffset`, `setSkipCrossings`.
- **Route precompute:** `computeRoute(payload)` — calls Google Routes API directly (REST), independent of the active Navigator. Used when a miniapp wants to preview a route without actually starting a trip.

Two design notes worth knowing:

1. **Subscriber accounting is a union** — native subs attach when *any* listener category becomes non-empty, detach only when all three (`listeners`, `locationListeners`, `routeListeners`) are empty. See `noListeners()` at [NavigationService.ts:177](../src/services/NavigationService.ts#L177).
2. **Late route subscribers get a replay.** `lastRoute` is cached; new `addRouteListener(...)` consumers are called synchronously with the cached route on subscription. See [NavigationService.ts:157-175](../src/services/NavigationService.ts#L157-L175). Maneuvers and locations are NOT replayed (they're stream-shaped, not state-shaped).

### `MantleManager` updates — [src/services/MantleManager.ts](../src/services/MantleManager.ts)

`MantleManager` is the host adapter that the island runtime calls into. The change here is wiring HeadingService and NavigationService into the runtime hooks the `LocalMiniappRuntime` reads on every miniapp request:

```ts
configureRuntime({
  navigation: {
    getState:        () => navigationService.getState(),
    getSnapshot:     () => navigationService.getSnapshot(),
    addListener:     (l) => navigationService.addListener(l),
    addLocationListener: (l) => navigationService.addLocationListener(l),
    addRouteListener:    (l) => navigationService.addRouteListener(l),
    start:           (coords, options) => navigationService.start(coords, options),
    stop:            () => navigationService.stop(),
    simulateDeviation:    (m) => navigationService.simulateDeviation(m),
    setWrongSidewalkOffset: (e) => navigationService.setWrongSidewalkOffset(e),
    setSkipCrossings:     (e) => navigationService.setSkipCrossings(e),
    requestPermission:    () => navigationService.requestPermission(),
    computeRoute:         (p) => navigationService.computeRoute(p),
  },
  heading: { addListener: (l) => headingService.addListener(l) },
  // ... other adapters (audio, socket, etc.)
})
```

This indirection is what keeps `@mentra/engine` portable: the runtime never imports concrete services, it only consumes the hook shape. OEM hosts implement the same shape with their own backing.

---

## Layer 3 — `LocalMiniappRuntime` (in `@mentra/engine`)

`mobile/modules/engine/src/services/LocalMiniappRuntime.ts` is the broker between miniapp WebViews and host services. One singleton handles every running miniapp.

Responsibilities:
- Track a session per registered package: send function, manifest, subscriptions, foreground/background state.
- Receive `MiniappRequest` envelopes (CONNECT / SUBSCRIBE / DISPLAY / NAVIGATION_START / LOCATION_POLL / etc.) and dispatch by `type`.
- Maintain a global ref count per stream type (`MiniappStreamType.HEADING_UPDATE`, etc.). Recompute host subscriptions on every change so `headingService.addListener` is called exactly when at least one miniapp wants the stream.
- Translate host events into `MiniappResponseType.EVENT` envelopes targeted at the right session(s).

### Navigation flow inside the runtime

When a miniapp sends `NAVIGATION_START`, [`handleNavigationStart`](../modules/engine/src/services/LocalMiniappRuntime.ts#L1121) does roughly this:

1. Validate stops; coerce `{lat, lng}` from v1 wire shape.
2. Resolve `getRuntimeHooks().navigation` — bail if the host hasn't wired the adapter.
3. If this app doesn't already have a forwarder, attach three:
   - **NavListener** → forward as `NAVIGATION_UPDATE` events.
   - **LocationListener** → forward as `LOCATION_UPDATE` events (so a miniapp that subscribed to plain GPS gets road-snapped fixes during a trip "for free").
   - **RouteListener** → forward as a route-on-update event.
4. If the trip is already running and the app is in `activeNavApps`, re-attach listeners and replay the snapshot — this is the **mid-trip mount path**, used when a miniapp is closed and reopened during an active trip.
5. Otherwise call `navigation.start(coords, options)` and resolve the request with the host's `{ok, error?}` ack.

`stop()` is fire-and-forget on the wire (`sendOneShot`). Listener cleanup happens inside the runtime; the miniapp's UI doesn't have to await an ack.

### Heading flow

Heading is purely a sensor stream — there's no `start` request, just SUBSCRIBE/UNSUBSCRIBE. [`recomputeHeadingSubscription`](../modules/engine/src/services/LocalMiniappRuntime.ts#L1104-L1118) is called whenever the global stream-subscriber map changes; it lazily attaches/detaches from `headingService` based on whether any session is subscribed to `HEADING_UPDATE`.

The same pattern is used for any other sensor-style stream the runtime gates centrally.

### Dev-mode caveat

`installDevReloadListenerIfDevMode()` (in `@mentra/miniapp/index.ts`) auto-installs a dev-reload handler on module import. Production builds gate it on `window.MentraOS.miniappDeveloperMode`, so consumers don't get reload behavior in real apps.

---

## Layer 4 — `@mentra/miniapp` SDK

`mobile/modules/miniapp/` is the SDK consumed by miniapp authors. It runs **inside** a miniapp's WebView, not in the manager. **Not published yet** — everything is local right now; the package lives in-tree and is consumed via the local checkout. Publishing to npm is future work.

Public entry: [src/index.ts](../modules/miniapp/src/index.ts). The headline export is `MiniappSession`, plus per-domain modules (`session.display`, `session.heading`, `session.location`, `session.navigation`, etc.) and helper types.

### Wire protocol

[src/protocol.ts](../modules/miniapp/src/protocol.ts) defines the enum vocabulary:

- `MiniappRequestType` — CONNECT, SUBSCRIBE, DISPLAY, PLAY_AUDIO, NAVIGATION_START, NAVIGATION_STOP, NAVIGATION_GET_STATE, NAVIGATION_COMPUTE_ROUTE, NAVIGATION_REQUEST_PERMISSION, NAVIGATION_DEVIATE / SET_WRONG_SIDEWALK / SET_SKIP_CROSSINGS, LOCATION_POLL, etc.
- `MiniappResponseType` — CONNECT_ACK, RESULT, EVENT, ERROR.
- `MiniappStreamType` — HEADING_UPDATE, LOCATION_UPDATE, NAVIGATION_UPDATE, BUTTON_PRESS, AUDIO_CHUNK, ...
- `MiniappErrorCode` — PERMISSION_NOT_DECLARED, INTERNAL, UNSUPPORTED, ...

This file has **no runtime dependency on `@mentra/sdk`**. Cloud↔app and phone↔miniapp are deliberately separate protocols, so they can evolve independently.

### Session lifecycle

```ts
const session = new MiniappSession()
await session.connect()              // sends CONNECT envelope, awaits CONNECT_ACK
session.display.showTextWall(...)
session.navigation.start({stops})
session.navigation.onUpdate(handler)
// ...
session.disconnect()
```

Internally `MiniappSession` owns:
- The transport (postMessage / local socket / mock).
- The request/response correlation map (every request gets a `requestId`, response handlers wait on it).
- A readiness queue for requests sent before `CONNECT_ACK`.
- The PONG auto-reply for host-driven heartbeats.
- Visibility state (`background`, `foreground`).
- One instance per domain module, lazily wired on construction.

### `NavigationModule` — the user-facing nav API

[src/modules/navigation.ts](../modules/miniapp/src/modules/navigation.ts) is the largest single file in the SDK. Public methods:

- `start(opts: StartNavigationOptions)` — kicks off a trip; returns the host ack.
- `stop()` — fire-and-forget; the host treats no-trip as a no-op.
- `requestPermission()` — proxies to `crust.requestNavigationPermission()` via the runtime.
- `computeRoute(opts)` — asks for a route preview without starting a trip.
- `getState()` / `getSnapshot()` — for mid-trip UI rehydration.
- `onUpdate(handler)` — `NavManeuver | NavRerouting | NavArrived | NavOffRoute | NavError`.
- `onRoute(handler)` — polyline + steps.
- `onPivot(handler)` / `getPivots()` / `getActivePivot()` / `getUpcomingPivot()` — see pivot engine below.
- `dev.deviate(...)`, `dev.setWrongSidewalkOffset(...)`, `dev.setSkipCrossings(...)` — dev-only namespace; the getter throws in `process.env.NODE_ENV === "production"` so a release build fails loudly if someone left a dev call in.

Two contracts worth memorizing:

1. **Every async method resolves with `{ok, error?}` — none throw.** Wrap one `if (!result.ok)` around any call instead of mixing `try/catch` and result inspection.
2. **All maneuver-typed fields use the `ManeuverKind` literal union.** Typos (`"CROSS_STRET"`) become compile errors instead of silent runtime bugs. The vocabulary mostly matches the Nav SDK / Routes API except for the SDK-synthesized `"CROSS_STREET"` (see pivots below).

### Pivot engine

`session.navigation.getPivots()` returns a list of "pivot points" along the active route — turns + crosswalks — so glasses HUDs can render "next: turn left in 80m, cross the street first" prompts that are richer than raw maneuver events.

Implementation:
- [src/modules/pivots/geometry.ts](../modules/miniapp/src/modules/pivots/geometry.ts) — pure-geometry helpers lifted from the Navigation miniapp's old client code: Ramer-Douglas-Peucker simplification, haversine distance, bearing math, `extractPivots` (turn detection by heading-delta thresholding), `extractCrossings` (crosswalk detection by enrichment from the SDK's step list).
- [src/modules/pivots/engine.ts](../modules/miniapp/src/modules/pivots/engine.ts) — owns the per-trip pivot list and a cursor that walks it as GPS ticks come in. Fires `onPivot` events for activate / deactivate / pass / approach. Reset on `start()` and rebuilt on every `onRoute` (so reroutes regenerate the list).

The engine is **fully self-contained inside the SDK**. A consumer never has to ship its own polyline-simplification code — `navigation.onPivot()` is the only thing they need to call.

### Other miniapp module updates

- [src/modules/heading.ts](../modules/miniapp/src/modules/heading.ts) — new file. `session.heading.onUpdate(handler)` / `hasPermission`.
- [src/modules/location.ts](../modules/miniapp/src/modules/location.ts) — added `getOnce()` (one-shot poll over `LOCATION_POLL`), tightened the no-permission contract, kept `onUpdate(handler)`.
- [src/modules/events.ts](../modules/miniapp/src/modules/events.ts) — registered the new `HeadingData` and `LocationData` shapes; small refactor to the auto-wire of stream subscribe/unsubscribe.
- [src/transport/mock.ts](../modules/miniapp/src/transport/mock.ts) — slightly expanded so navigation requests don't hang the SDK in browser-tab mode (synthetic CONNECT_ACK + RESULT envelopes).

---

## How the layers cooperate — three traced scenarios

### 1. Miniapp subscribes to compass heading

```
session.heading.onUpdate(handler)
  └─ HeadingModule._subscribe(MiniappStreamType.HEADING_UPDATE, handler)
       └─ session._subscribe(...)
            └─ EventManager increments the ref count for HEADING_UPDATE
                 └─ Sends SUBSCRIBE envelope to phone (only on 0→1 transition)

LocalMiniappRuntime.handleSubscribe(...)
  └─ Updates this.streamSubscribers map
       └─ recomputeHeadingSubscription()
            └─ headingService.addListener(callback)
                 └─ HeadingService.startNative()
                      └─ CrustModule.startHeading()
                           └─ Native HeadingManager spins up CLLocationManager / SensorManager

every sensor tick:
  HeadingManager → onHeading event → CrustModule listener
    → HeadingService callback → LocalMiniappRuntime.forwardEvent
       → MiniappResponseType.EVENT envelope
            → injected back into the WebView
                 → EventManager._forwardEvent
                      → user handler({degrees: 274.2})
```

### 2. Miniapp starts a navigation trip

```
session.navigation.start({stops: [...]}) 
  └─ NavigationModule.start (declares pivot tracking, packages payload)
       └─ session.sendRequest({type: NAVIGATION_START, ...})
            └─ envelope across the bridge

LocalMiniappRuntime.handleNavigationStart(...)
  └─ Validate stops
  └─ Resolve getRuntimeHooks().navigation
  └─ Attach per-app forwarders (Nav, Location, Route)
  └─ navigation.start(coords, options)   // → NavigationService.start
       └─ CrustModule.startNavigation
            └─ Native NavigationManager registers Nav SDK,
               creates GMSMapView/Navigator, sets waypoints, activates guidance

events flow back per scenario 1, but as NAVIGATION_UPDATE / LOCATION_UPDATE / route events
```

### 3. Developer scans a QR for their local miniapp

```
expo-camera scans  →  scanner.tsx onBarcodeScanned
  └─ decideDevLaunchRoute(devUrl, ...)
       │
       ├─ if reachable: router.push("/applet/local", {devUrl, packageName, ...})
       │     └─ LocalMiniAppPage mounts
       │          └─ miniappHost.mountDev(packageName, devUrl, {manifest, ...})
       │               └─ MiniappHost component injects a new <WebView>
       │                    └─ WebView loads devUrl, miniapp runs MiniappSession.connect()
       │
       └─ if unreachable: router.push("/applet/dev-offline", {packageName, ...})
             └─ DevMiniappOfflineScreen shows splash + "Try again" / "Re-scan"
```
