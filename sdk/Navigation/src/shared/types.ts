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
export type TripState = {
  status: NavStatus
  running: boolean
  maneuver: NavManeuver | null
  activeDestination: LatLng | null
  activeDestinationName: string | null
  routePoints: LatLng[] | null
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
