/**
 * Shared domain types referenced by both the background JSContext and
 * the UI WebView. Both bundlers inline this file at build time, so
 * there's no runtime resolution across the boundary.
 */

import type {NavManeuver, Pivot} from "@mentra/miniapp"

export type Coords = {lat: number; lng: number; accuracy?: number; ts: number}
export type LatLng = {lat: number; lng: number}
export type NavStatus = "idle" | "navigating" | "rerouting" | "arrived"
export type LogEntry = {id: number; ts: number; line: string}

export type PlaceSuggestion = {placeId: string; mainText: string; secondaryText?: string}
export type PlaceDetails = {
  placeId: string
  name: string
  address: string
  lat: number
  lng: number
  /** User-defined label when saved as a favorite or custom place */
  savedName?: string
  /**
   * True while a reverse-geocode is in flight for a dropped pin. The
   * `name` / `address` fields are placeholders (raw lat/lng) until this
   * flips back to false. UI consumers render a skeleton while this is
   * true so the user doesn't see the bare coordinates flash on screen
   * before the real address lands.
   */
  isGeocoding?: boolean
}
export type SavedPlace = PlaceDetails & {
  type?: "home" | "work"
}

/**
 * Trip state mirrored from background to UI. Kept dual `status` +
 * `running` for parity with the existing NavigationPage state machine —
 * `running` is true while `status` ∈ {"navigating","rerouting"}, false
 * otherwise. Collapsing into a single field is a separate refactor.
 */
/**
 * One step in the active trip's route, mirrored from the SDK's
 * `NavStep` minus internal fields the UI doesn't need (`routeIndex`).
 * Carries the resolved road name (host-side hybrid resolver) so the
 * UI can build live turn dots from road→road transitions, matching
 * the preview path. `maneuver` is the SDK's `ManeuverKind` string —
 * widened to `string` here to avoid pulling the union into the
 * shared types boundary (the channel layer doesn't gain anything
 * from the narrower type).
 */
export type NavRouteStep = {
  lat: number
  lng: number
  road: string | null
  maneuver: string
  distanceMeters: number
}

export type TripState = {
  status: NavStatus
  running: boolean
  maneuver: NavManeuver | null
  activeDestination: LatLng | null
  activeDestinationName: string | null
  routePoints: LatLng[] | null
  /**
   * Step list for the active route, populated alongside `routePoints`
   * from the SDK's onRoute event. Null until the first route lands.
   * Used by NavigationPage to build live turn dots that mirror the
   * preview from→to/direction labels — preview reads steps directly
   * from `computeRoute`, live reads them from here.
   */
  routeSteps: NavRouteStep[] | null
  offRouteAt: number | null
}

export type DevSettings = {
  simulate: boolean
  speedMultiplier: number
  wrongSidewalk: boolean
  skipCrossings: boolean
}

export type NavSnapshot = {
  coords: Coords | null
  heading: number | null
  trip: TripState
  activePivot: Pivot | null
  upcomingPivot: Pivot | null
  log: LogEntry[]
  devSettings: DevSettings
}
