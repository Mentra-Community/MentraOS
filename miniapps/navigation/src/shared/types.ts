/**
 * Shared domain types referenced by both the background JSContext and
 * the UI WebView. Both bundlers inline this file at build time, so
 * there's no runtime resolution across the boundary.
 */

import type {NavManeuver, Pivot} from "@mentra/miniapp"

export type Coords = {lat: number; lng: number; accuracy?: number; ts: number}
export type LatLng = {lat: number; lng: number}
export type NavStatus = "idle" | "navigating" | "rerouting" | "arrived"

/**
 * Distance unit preference. "metric" → m / km, "imperial" → ft / mi.
 * A real user preference (not a dev toggle): persisted in background
 * storage and mirrored to the UI via the snapshot so every distance
 * string — on the map, in drawers, and on the glasses HUD — renders in
 * the chosen system. Defaults to "metric".
 */
export type UnitSystem = "metric" | "imperial"
export type VoiceGuidanceMode = "off" | "essential" | "full"
export type GlassesCapabilitySnapshot = {
  modelName: string | null
  hasDisplay: boolean
  /** True when the glasses can render positioned scene elements. */
  canPosition: boolean
  hasSpeaker: boolean
  hasButton: boolean
}
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
  /**
   * Google's verbatim turn-by-turn text for this step (e.g. "Head west
   * on Hayes St toward Gough St"). Populated from the preview-time
   * Routes API response and refetched on reroute. Null when no cached
   * preview is available — consumers fall back to the constructed
   * "Turn left onto Octavia St" rendering.
   */
  instruction: string | null
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
  /**
   * Side of the final route segment the destination pin sits on, from
   * the walker's perspective. Captured at the moment we fire arrival
   * (either from the early ≤7m-remaining trigger or the SDK's own
   * arrived event) and held alongside `status === "arrived"` so the
   * HUD can render "You have arrived at X, on your left|right".
   * Null while not arrived, or when the route was too short to derive
   * a side.
   */
  arrivalSide: "left" | "right" | null
}

export type DevSettings = {
  simulate: boolean
  speedMultiplier: number
  wrongSidewalk: boolean
  skipCrossings: boolean
  /**
   * Debug toggle. When on, the maneuver card and glasses HUD swap their
   * constructed "Turn right onto Octavia St" phrasing for Google's raw
   * navigationInstruction string (e.g. "Head west on Hayes St toward
   * Gough St"). The distance suffix ("in 198 m") is preserved.
   */
  useRawInstructions: boolean
  /**
   * Dev toggle for the swipe-up large map (WIP). When OFF (default), swipe
   * gestures do nothing — the large map feature is disabled. When ON, swiping
   * toggles the full-screen route map on/off as usual.
   */
  largeMapEnabled: boolean
}

export type NavSnapshot = {
  coords: Coords | null
  heading: number | null
  trip: TripState
  activePivot: Pivot | null
  upcomingPivot: Pivot | null
  log: LogEntry[]
  devSettings: DevSettings
  /** User's distance-unit preference. Defaults to "metric". */
  unitSystem: UnitSystem
  voiceGuidanceMode: VoiceGuidanceMode
  capabilities: GlassesCapabilitySnapshot
}
