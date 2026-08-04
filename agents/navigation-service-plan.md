# NavigationService — Plan

## Goal

A native Android background daemon (inside the existing `crust` Expo
module) that drives the Google Navigation SDK and streams turn-by-turn
updates all the way to a mini app UI.

End-to-end POC: user types lat/lng into the **Navigation mini app**, mini
app calls `session.navigation.start(...)`, the SDK forwards over the
bridge to the mobile app, the mobile app calls into native Kotlin
(`crust`), Kotlin drives Google Nav SDK, events flow back the same path
and render live in the mini app.

Android only. iOS deferred.

## Topology

```
Navigation mini app             Mini app SDK              Mobile app (Android)         crust (native Kotlin)
──────────────────              ─────────────             ─────────────────────        ──────────────────────
[input lat/lng]
session.navigation                                        NavigationService
  .start({lat, lng})  ──→  bridge request  ──→     start({lat, lng})    ──→     CrustModule.startNavigation
                                                                                          │
                                                                                          ↓
                                                                                   Google Nav SDK
                                                                                          │
[render live UI]                                                                          │
  .onUpdate(handler)  ←──  bridge events  ←──   forward maneuver/lifecycle  ←──   emit event
  .stop()             ──→  bridge request  ──→  stop()                      ──→   CrustModule.stopNavigation
```

## Scope (POC)

In:
- Native Android navigation code lives in `mobile/modules/crust/` (Kotlin).
  Uses raw Google Navigation SDK for Android — not the RN wrapper.
- `crust` exposes `startNavigation(lat, lng)` / `stopNavigation()` to JS,
  plus events: `onNavManeuver`, `onNavRerouting`, `onNavArrived`, `onNavError`.
- A thin `NavigationService` on the mobile JS side wraps `crust` calls and
  exposes `start({lat, lng}) / stop() / addListener(handler)`.
- Bridge wiring in `LocalMiniappRuntime` so requests flow from mini apps
  to `NavigationService` and events flow back.
- New mini app SDK module: `session.navigation` (`start` / `stop` /
  `onUpdate`).
- Update the existing **Navigation mini app** at `sdk/Navigation/` to:
  - Provide an input UI for lat/lng.
  - Call `session.navigation.start({lat, lng})`.
  - Render the live update stream on screen.
  - Provide a stop button.
- Take a destination as `{lat, lng}`. No address parsing.
- Survives app backgrounding.

Out:
- iOS support. Entire stack is Android-only.
- Phone-side UI for nav (mini app owns it).
- Glasses rendering.
- Address parsing / geocoding / autocomplete.
- Multi-stop trips, alternate routes, route preview.
- Edge case handling (concurrent starts, mini app death mid-trip, GPS
  loss, etc.) — listed but deferred past POC.

## Public surfaces (shape only)

### Native (Kotlin in `crust`)

```
CrustModule.startNavigation(lat: Double, lng: Double): Promise<{ok: boolean, error?: string}>
CrustModule.stopNavigation(): Promise<{ok: boolean}>

Events emitted to JS:
  onNavManeuver  → { instruction, roadName, maneuverType, distanceMeters }
  onNavRerouting → {}
  onNavArrived   → {}
  onNavError     → { message }
```

### Mobile-side service (JS)

```
navigationService.start({ lat, lng })
navigationService.stop()
navigationService.addListener(handler)   // returns unsubscribe
navigationService.getState()             // "idle" | "navigating" | "rerouting" | "arrived"
```

### Mini app SDK

```
session.navigation.start({ lat: number, lng: number })
session.navigation.stop()
session.navigation.onUpdate(handler)     // returns unsubscribe
```

`handler` receives one of:
- `{ kind: "maneuver", instruction, roadName, maneuverType, distanceMeters }`
- `{ kind: "rerouting" }`
- `{ kind: "arrived" }`
- `{ kind: "error", message }`

### Mini app UI (`sdk/Navigation/`)

Two text inputs (lat, lng) + Start button + Stop button + a live event
log panel that renders every `onUpdate` payload.

## Where things live

- **Native Android:** `mobile/modules/crust/android/.../NavigationManager.kt`
  (new file) and additions to `CrustModule.kt`.
- **JS side of crust:** type additions in `mobile/modules/crust/src/CrustModule.ts`
  and `mobile/modules/crust/src/Crust.types.ts`.
- **Mobile JS service:** `mobile/src/services/NavigationService.ts`
  (singleton).
- **Bridge wiring:** `mobile/src/services/LocalMiniappRuntime.ts` — new
  request handlers + event forwarding.
- **SDK module:** `sdk/miniapp/src/modules/navigation.ts` (new file).
- **Wire protocol:** new entries in `sdk/miniapp/src/protocol.ts`
  (`NAVIGATION_START`, `NAVIGATION_STOP`, stream `navigation_update`).
- **Mini app:** `sdk/Navigation/src/App.tsx` — input form + live log.

## Dependencies introduced

- Google Navigation SDK for Android (`com.google.android.libraries.navigation:navigation`)
  added to `crust` Gradle config.
- Android Core Library Desugaring enabled in `expo-build-properties`.
- Google Cloud project with Navigation SDK billing enabled.
- Android API key, supplied via env: `EXPO_PUBLIC_GOOGLE_NAV_API_KEY`.
  Read in `app.config.ts` and injected into `AndroidManifest.xml` as a
  `<meta-data>` tag.

## Pre-flight (already verified)

- RN 0.83 → meets requirement.
- New Architecture on → meets requirement.
- Android `minSdkVersion` 28 → meets requirement.
- No conflicting Google Maps consumers in the app.

## Pre-flight (still needed)

- Add Core Library Desugaring to `expo-build-properties` for Android.
- Provision GCP project + API key (user will add to env later).
- Verify the Navigation SDK Gradle artifact resolves with the current
  Android Gradle Plugin version in this app.

## Constraints / known facts

- Google Nav SDK is **Beta**. Breaking changes between versions.
- Billed per trip (one `startGuidance()` = one trip).
- Mandatory T&C dialog the first time `startGuidance()` runs. For the
  POC, it shows the first time the user hits "Start" in the mini app.
- The SDK reads GPS itself — `LocationManager` does not feed it.
- Headless mode (no map view) is supported via `Navigator` listeners.
- The SDK does not expose `bearing_before` / `bearing_after` per maneuver.

## Phases

1. **Native install.** Add the Gradle dep + desugaring to `crust`. Read
   the API key from env into `AndroidManifest.xml`. Verify build.
2. **Native daemon.** Implement Kotlin `NavigationManager` + extend
   `CrustModule.kt` with `startNavigation` / `stopNavigation` + events.
   Headless. Hardcoded test destination first.
3. **JS service.** Build `NavigationService.ts` as a thin singleton over
   `crust`. Forwards events to listeners.
4. **Dev-screen test button.** "Start/Stop Test Nav" buttons in
   Developer Settings → Misc. Logs every event to console. Confirms the
   native ↔ JS path works before adding the bridge.
5. **Bridge + SDK module.** Wire `LocalMiniappRuntime` to route nav
   requests and events. Add `session.navigation` to the mini app SDK.
6. **Mini app UI.** Update `sdk/Navigation/src/App.tsx` with the
   lat/lng inputs, start/stop buttons, and live event log. End-to-end
   acceptance test.

## Open questions (deferred until after POC)

1. Driving mode only or also walking?
2. T&C dialog placement — first start vs onboarding.
3. Concurrent `start()` calls — reject, replace, or queue?
4. Error normalization — propagate verbatim or normalize?
5. Daemon lifecycle when the requesting mini app exits.

## Risks

- Beta SDK churn between versions.
- Per-trip billing at scale.
- Native install may force gradle / desugaring changes that affect the
  rest of the app's build.
- Picking Google Nav SDK forecloses the Mapbox-based disambiguation in
  the nav product spec.
