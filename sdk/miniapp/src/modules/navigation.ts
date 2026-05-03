/**
 * @fileoverview NavigationModule — turn-by-turn navigation for miniapps.
 *
 * The mini app calls `session.navigation.start({stops: [...]})` to kick off
 * a trip. Updates stream in via `session.navigation.onUpdate(handler)`.
 *
 * The phone-side daemon (NavigationService → crust → Google Nav SDK) owns
 * the trip lifecycle. The SDK module is a thin pass-through over the
 * bridge.
 *
 * Android only on the phone side. iOS calls return ok=false at the native
 * layer.
 */

import {MiniappErrorCode, MiniappRequestType, MiniappStreamType} from "../protocol"
import {MiniappSession} from "../session"
import type {UnsubscribeFn} from "./events"

export type LatLng = {lat: number; lng: number}

/** How the user is travelling. Drives routing + maneuver vocabulary. */
export type TravelMode = "walking" | "driving" | "cycling" | "two_wheeler"

/** Optional routing preferences. All flags default to false. */
export type RouteAvoidances = {
  highways?: boolean
  tolls?: boolean
  ferries?: boolean
}

export type NavManeuver = {
  kind: "maneuver"
  /**
   * Categorical type of the upcoming maneuver. One of: STRAIGHT,
   * SLIGHT_LEFT, SLIGHT_RIGHT, TURN_LEFT, TURN_RIGHT, SHARP_LEFT,
   * SHARP_RIGHT, U_TURN, ARRIVE.
   */
  maneuverType: string
  /** Distance in meters from the user's current position to that maneuver. -1 if unknown. */
  distanceMeters: number
  /**
   * Road the user is currently on, per the Nav SDK's StepInfo. Null if
   * the platform/region doesn't supply a name (e.g. unnamed paths,
   * sidewalks, plazas) or the maneuver was emitted before the first
   * NavInfo arrived.
   */
  fromRoad?: string | null
  /** Road the user will be on after the maneuver. Null in the same cases as `fromRoad`. */
  toRoad?: string | null

  /** Total remaining distance to the final destination, in meters. -1 if unknown. */
  distanceToDestinationMeters?: number
  /** Engine's estimate of remaining travel time, in seconds. -1 if unknown. */
  timeToDestinationSeconds?: number

  /** Current speed in m/s. Null if unavailable. */
  currentSpeedMps?: number | null
  /** Speed limit on the current road segment in m/s. Null if unknown / not regulated. */
  speedLimitMps?: number | null
  /** Bearing along the route at the user's current position, 0–360. Null if unknown. */
  routeHeadingDeg?: number | null
}

/**
 * Fired once when the engine determines the user has strayed from the
 * route, BEFORE the rerouting event that follows.
 */
export type NavOffRoute = {
  kind: "off_route"
  /** Approximate perpendicular distance in meters from the route. */
  offRouteDistanceMeters: number
}

export type NavRerouting = {kind: "rerouting"}
export type NavArrived = {kind: "arrived"}
export type NavError = {kind: "error"; message: string}

export type NavUpdate = NavManeuver | NavOffRoute | NavRerouting | NavArrived | NavError

export type NavRoute = {
  points: LatLng[]
  /** Total length of this route in meters. Optional for backwards compat. */
  totalDistanceMeters?: number
  /** Engine's estimate of total travel time at trip start, in seconds. */
  totalDurationSeconds?: number
}

export type StartNavigationOptions = {
  /** Single-destination shorthand. Internally rewritten to `stops: [{lat, lng}]`. */
  lat?: number
  lng?: number

  /**
   * Ordered list of stops. The first entry is the first waypoint, the last
   * entry is the final destination. Must have ≥1 entry.
   */
  stops?: LatLng[]

  /** Defaults to `"driving"` for backwards-compat with v1 starts. */
  mode?: TravelMode

  avoid?: RouteAvoidances

  /** For dev/testing only — fake walking along the route at speedMultiplier×. */
  simulate?: boolean
  speedMultiplier?: number
}

/**
 * Snapshot of the active trip. Returned by `getState()` and identical in
 * shape to the data inside the matching events, so a miniapp opening
 * mid-trip can render the same UI as one listening from the start.
 */
export type NavState = {
  active: boolean
  mode?: TravelMode
  stops?: LatLng[]
  /** Index of the stop currently being navigated to (0 = first). */
  currentStopIndex?: number
  /** Last route delivered (full polyline + totals). */
  route?: NavRoute
  /** Last maneuver event observed. */
  maneuver?: NavManeuver
  /** Mirror of NavManeuver progress fields, freshened on every NavInfo tick. */
  distanceToDestinationMeters?: number
  timeToDestinationSeconds?: number
  currentSpeedMps?: number | null
  speedLimitMps?: number | null
}

/** Standalone route compute — does NOT start a trip. */
export type ComputeRouteOptions = {
  origin: LatLng
  /** ≥1 entry; last is the final destination. */
  stops: LatLng[]
  /** Defaults to "driving". */
  mode?: TravelMode
  avoid?: RouteAvoidances
  /** Return up to N alternate routes (engine-permitting). Default 1. */
  alternatives?: number
}

export type ComputedRoute = {
  points: LatLng[]
  totalDistanceMeters: number
  totalDurationSeconds: number
  /** Polyline-aligned road labels, when supplied by the engine. */
  summary?: string
}

export type ComputeRouteResult = {
  ok: boolean
  error?: string
  /** Primary route first, alternates after. */
  routes?: ComputedRoute[]
}

export class NavigationModule {
  constructor(private readonly session: MiniappSession) {}

  /** True iff `LOCATION` is declared in the miniapp's manifest. */
  get hasPermission(): boolean {
    return this.session._hasManifestPermission("LOCATION")
  }

  /**
   * Start a turn-by-turn navigation session. Pass either `{lat, lng}` for a
   * single destination, or `{stops: [...]}` for a multi-stop trip (last
   * entry is the final destination). Resolves with the phone-side ack —
   * `{ok: true}` means the daemon accepted the request, not that a route
   * was successfully built. Listen via `onUpdate(...)` for the actual nav
   * events.
   *
   * Throws `{code: PERMISSION_NOT_DECLARED}` synchronously if the miniapp
   * manifest is missing the LOCATION permission. The host would reject the
   * same way, but failing fast saves a round trip.
   */
  start(opts: StartNavigationOptions): Promise<{ok: boolean; error?: string}> {
    if (!this.hasPermission) {
      throw {
        code: MiniappErrorCode.PERMISSION_NOT_DECLARED,
        message: "LOCATION permission not declared in miniapp.json (required for navigation.start).",
      }
    }
    const stops = normalizeStops(opts)
    return this.session.sendRequest<{ok: boolean; error?: string}>({
      type: MiniappRequestType.NAVIGATION_START,
      // Keep lat/lng on the wire for hosts that haven't been upgraded to
      // read `stops` yet. New hosts prefer `stops` when present.
      lat: stops[0]?.lat,
      lng: stops[0]?.lng,
      stops,
      mode: opts.mode ?? "driving",
      avoid: opts.avoid,
      simulate: opts.simulate ?? false,
      speedMultiplier: opts.speedMultiplier ?? 5,
    })
  }

  /** Stop the active navigation session (if any). Fire-and-forget. */
  stop(): void {
    this.session.sendOneShot({type: MiniappRequestType.NAVIGATION_STOP})
  }

  /**
   * Dev-only: nudge the simulator perpendicular to the route by ~`offsetMeters`
   * so the Nav SDK detects an off-route condition and reroutes. Useful for
   * testing the reroute pipeline without physically walking off-path.
   * Default 20m. Android (simulated trips) only — iOS / real GPS is a no-op.
   * Fire-and-forget.
   */
  deviate(offsetMeters: number = 20): void {
    this.session.sendOneShot({
      type: MiniappRequestType.NAVIGATION_DEVIATE,
      offsetMeters,
    })
  }

  /**
   * Subscribe to live navigation updates. Returns an unsubscribe function.
   * Maneuvers, off-route, rerouting, arrival, and errors all arrive
   * through this single stream — discriminate by `update.kind`.
   */
  onUpdate(handler: (update: NavUpdate) => void): UnsubscribeFn {
    return this.session._subscribe(MiniappStreamType.NAVIGATION_UPDATE, handler as (data: unknown) => void)
  }

  /**
   * Subscribe to the active route polyline. Fires once per route build —
   * the full path is delivered each time, not a diff. Use this to draw
   * the route on a map.
   */
  onRoute(handler: (route: NavRoute) => void): UnsubscribeFn {
    return this.session._subscribe(MiniappStreamType.NAVIGATION_ROUTE, handler as (data: unknown) => void)
  }

  /**
   * Snapshot of the active trip. Resolves to `null` when no trip is
   * running. Use this on mount to hydrate state for a miniapp opening
   * mid-trip; the streaming events take over from the next tick.
   */
  async getState(): Promise<NavState | null> {
    const result = await this.session.sendRequest<{ok: boolean; state?: NavState | null}>({
      type: MiniappRequestType.NAVIGATION_GET_STATE,
    })
    return result.ok ? (result.state ?? null) : null
  }

  /**
   * Compute a route without starting a trip. Resolves with the primary
   * route plus any alternates the engine produced (up to `alternatives`).
   *
   * Throws `{code: PERMISSION_NOT_DECLARED}` synchronously if LOCATION is
   * missing from the manifest.
   */
  computeRoute(opts: ComputeRouteOptions): Promise<ComputeRouteResult> {
    if (!this.hasPermission) {
      throw {
        code: MiniappErrorCode.PERMISSION_NOT_DECLARED,
        message: "LOCATION permission not declared in miniapp.json (required for navigation.computeRoute).",
      }
    }
    return this.session.sendRequest<ComputeRouteResult>({
      type: MiniappRequestType.NAVIGATION_COMPUTE_ROUTE,
      origin: opts.origin,
      stops: opts.stops,
      mode: opts.mode ?? "driving",
      avoid: opts.avoid,
      alternatives: opts.alternatives ?? 1,
    })
  }
}

/**
 * Normalize the v1 `{lat, lng}` shape into the v2 `stops` array. New
 * callers should pass `stops` directly; the shorthand stays supported so
 * existing miniapps keep working without changes.
 */
function normalizeStops(opts: StartNavigationOptions): LatLng[] {
  if (opts.stops && opts.stops.length > 0) {
    return opts.stops
  }
  if (typeof opts.lat === "number" && typeof opts.lng === "number") {
    return [{lat: opts.lat, lng: opts.lng}]
  }
  return []
}
