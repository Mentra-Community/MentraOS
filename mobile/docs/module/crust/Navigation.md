# Crust: Navigation

How the crust native module delivers turn-by-turn navigation to JS.

## Overview

Turn-by-turn guidance backed by Google Navigation SDK. Runs on iOS and Android with parity. JS calls the module via Expo `AsyncFunction`s; the native side streams results back as events.

## Flow

1. JS calls `requestNavigationPermission()` — shows the Google T&C dialog. Must be accepted before `startNavigation` works.
2. JS calls `startNavigation(lat, lng, options)` with optional `stops`, `mode`, `simulate`, `speedMultiplier`.
3. Native `NavigationManager` registers the Google API key, creates an off-screen `GMSMapView`, grabs its navigator, sets waypoints, and activates guidance. Voice is muted.
4. As the route is computed and the user moves, the manager emits events to JS:
   - `onNavRoute` — polyline points + step metadata (road / maneuver / distance).
   - `onNavManeuver` — current step, distance to next turn, ETA.
   - `onNavLocation` — road-snapped GPS ticks.
   - `onNavRerouting` — fired when the route changes.
   - `onNavOffRoute` — once per off-route episode (>30m from polyline).
   - `onNavArrived` — final waypoint reached.
5. JS calls `stopNavigation()` — tears down the navigator, clears callbacks, resets cached state.

Simulation mode replays a route at `speedMultiplier`× speed; a 1Hz polling timer reads `mapView.myLocation` as a fallback when the road-snapped provider stays quiet.

## Files

### iOS

- [CrustModule.swift](../../../modules/crust/ios/CrustModule.swift) — Expo module entry point; declares `AsyncFunction`s and event names, bridges to the manager below.
- [NavigationManager.swift](../../../modules/crust/ios/navigation/NavigationManager.swift) — owns the `GMSNavigator` lifecycle, route/step/off-route detection, simulation polling.
- [NavPayloads.swift](../../../modules/crust/ios/navigation/NavPayloads.swift) — `maneuverString()` enum mapping and `pathToPoints()` polyline encoder.

### Android

- [CrustModule.kt](../../../modules/crust/android/src/main/java/com/mentra/crust/CrustModule.kt) — Expo module entry point; mirror of the iOS module.
- [NavigationManager.kt](../../../modules/crust/android/src/main/java/com/mentra/crust/navigation/NavigationManager.kt) — Google Nav SDK lifecycle, parity with `NavigationManager.swift`.
- [NavInfoReceiverService.kt](../../../modules/crust/android/src/main/java/com/mentra/crust/navigation/NavInfoReceiverService.kt) — receives `NavInfo` ticks from the SDK; source of step metadata.
