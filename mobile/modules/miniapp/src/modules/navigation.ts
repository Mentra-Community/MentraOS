/**
 * NavigationModule — turn-by-turn navigation for miniapps. A thin pass-through over the bridge;
 * the phone-side daemon owns the trip lifecycle.
 *
 * Works on iOS and Android (both back it with the Mapbox Navigation SDK). Every Promise
 * resolves with an `{ok, error?}` shape; nothing throws, so check `result.ok`.
 */

import {MiniappRequestType, MiniappStreamType} from "../protocol"
import {MiniappSession} from "../session"
import type {LocationData, UnsubscribeFn} from "./events"
import {PivotEngine} from "./pivots/engine"

export type LatLng = {lat: number; lng: number}

export type TravelMode = "walking" | "driving" | "cycling" | "two_wheeler"

/**
 * Categorical maneuver vocabulary. Most values come from the Google Nav SDK + Routes API;
 * "CROSS_STREET" is SDK-synthesized when the pivot engine detects a crosswalk leg.
 */
export type ManeuverKind =
  | "STRAIGHT"
  | "CONTINUE"
  | "SLIGHT_LEFT"
  | "SLIGHT_RIGHT"
  | "TURN_LEFT"
  | "TURN_RIGHT"
  | "SHARP_LEFT"
  | "SHARP_RIGHT"
  | "U_TURN"
  | "NAME_CHANGE"
  | "DEPART"
  | "ARRIVE"
  | "CROSS_STREET"

/** Routing preferences. All flags default to false. */
export type RouteAvoidances = {
  highways?: boolean
  tolls?: boolean
  ferries?: boolean
}

export type NavManeuver = {
  kind: "maneuver"
  maneuverType: ManeuverKind
  /** Meters to the maneuver. -1 if unknown. */
  distanceMeters: number
  /** Road the user is currently on. Null when unnamed or pre-first-update. */
  fromRoad?: string | null
  /** Legacy "next road" field. Prefer `nextStepRoad` for new UIs. */
  toRoad?: string | null
  /** Road the user will be on AFTER the maneuver. Use as the "next street" label. */
  nextStepRoad?: string | null

  /** Total meters to the destination. -1 if unknown. */
  distanceToDestinationMeters?: number
  /** Remaining travel time in seconds. -1 if unknown. */
  timeToDestinationSeconds?: number

  /** Current speed in m/s. Null if unavailable. */
  currentSpeedMps?: number | null
  /** Speed limit in m/s. Null if unknown / not regulated. */
  speedLimitMps?: number | null
  /** Route bearing at the user's position, 0–360. Null if unknown. */
  routeHeadingDeg?: number | null
  /** Host engine's verbatim instruction (e.g. "Turn left onto Waller St"). Render as-is. */
  instruction?: string | null
}

export type NavOffRoute = {
  kind: "off_route"
  /** Approximate perpendicular distance from the route, in meters. */
  offRouteDistanceMeters: number
}

export type NavRerouting = {kind: "rerouting"}
export type NavArrived = {kind: "arrived"}
export type NavError = {kind: "error"; message: string}

export type NavUpdate = NavManeuver | NavOffRoute | NavRerouting | NavArrived | NavError

export type NavRoute = {
  points: LatLng[]
  totalDistanceMeters?: number
  totalDurationSeconds?: number
  /** Ordered navigable segments. Omitted by older hosts that don't supply step metadata. */
  steps?: NavStep[]
}

/** Pivot-detection tuning. Omitted fields use mode-aware defaults. */
export type PivotOptions = {
  /** "Turning now" radius. Defaults: walking 7, cycling 15, driving 40. */
  radiusMeters?: number
  /** "Approaching" radius. Defaults: walking 100, cycling 300, driving 800. */
  approachThresholdMeters?: number
}

/** A real turn along the route, derived once per route build (re-derived on reroute). */
export type Pivot = {
  /** 0-based ordinal; invalidated when `onRoute` fires again. */
  index: number
  lat: number
  lng: number
  direction: "left" | "right"
  /** Road approaching the pivot. Null when the engine has no name. */
  fromRoad: string | null
  /** Road exiting the pivot. Same null semantics. */
  toRoad: string | null
  maneuver: ManeuverKind
  /** Meters from trip start to this pivot, along the route. */
  distanceAlongRouteMeters: number
  /** "Turning now" radius for this pivot, in meters. */
  radiusMeters: number
}

/** Each pivot fires `approaching` → `entered` → `exited` (once each), then the cursor advances. */
export type PivotEvent =
  | {kind: "approaching"; pivot: Pivot; distanceMeters: number}
  | {kind: "entered"; pivot: Pivot}
  | {kind: "exited"; pivot: Pivot}

/** One route leg: a stretch of road ending in a maneuver. */
export type NavStep = {
  /** Coordinate where this step begins (== end of the previous step). */
  lat: number
  lng: number
  /** Index into `NavRoute.points[]` where this step starts. */
  routeIndex: number
  /** Road traversed during this step. Null when unnamed. */
  road?: string | null
  /** Maneuver performed at the END of this step. */
  maneuver: ManeuverKind
  distanceMeters: number
}

/** One type-ahead place suggestion from `placeAutocomplete`. */
export type NavPlaceSuggestion = {
  /** Opaque id to feed into `placeDetails`. */
  placeId: string
  /** Primary line, e.g. "Blue Bottle Coffee". */
  mainText: string
  /** Secondary line, e.g. "66 Mint St, San Francisco". Empty when none. */
  secondaryText: string
}

/** A place resolved from a suggestion via `placeDetails` — has coordinates to route to. */
export type NavPlaceDetails = {
  placeId: string
  name: string
  address: string
  lat: number
  lng: number
}

export type NavigationDev = {
  deviate(offsetMeters?: number): void
  setWrongSidewalkOffset(enabled: boolean): void
  setSkipCrossings(enabled: boolean): void
}

export type StartNavigationOptions = {
  /** Single-destination shorthand. Rewritten to `stops: [{lat, lng}]`. */
  lat?: number
  lng?: number
  /** Ordered stops; last is the final destination. Must have ≥1 entry. */
  stops?: LatLng[]
  /** Defaults to "driving". */
  mode?: TravelMode
  avoid?: RouteAvoidances
  /** Dev/testing only — fake walking the route at speedMultiplier×. */
  simulate?: boolean
  speedMultiplier?: number
  /** Override the default pivot-detection knobs for this trip. */
  pivots?: PivotOptions
  /** Reroute once the user is this many meters past a missed pivot. Omit / 0 to use host defaults. */
  missedTurnRerouteMeters?: number
}

/** Snapshot of the active trip, shaped like the streaming events so mid-trip opens render the same. */
export type NavState = {
  active: boolean
  mode?: TravelMode
  stops?: LatLng[]
  /** Index of the stop currently being navigated to (0 = first). */
  currentStopIndex?: number
  route?: NavRoute
  maneuver?: NavManeuver
  distanceToDestinationMeters?: number
  timeToDestinationSeconds?: number
  currentSpeedMps?: number | null
  speedLimitMps?: number | null
}

export type NavPermissionResult = {
  /** True if the request reached the host. False e.g. when LOCATION isn't declared in the manifest. */
  ok: boolean
  /** True if the user accepted the Nav SDK T&Cs (always true on platforms without a T&C gate). */
  accepted: boolean
  error?: string
}

/** Standalone route compute — does NOT start a trip. */
export type ComputeRouteOptions = {
  origin: LatLng
  /** ≥1 entry; last is the final destination. */
  stops: LatLng[]
  /** Defaults to "driving". */
  mode?: TravelMode
  avoid?: RouteAvoidances
  /** Up to N alternate routes (engine-permitting). Default 1. */
  alternatives?: number
}

/** One step of a previewed route, available BEFORE `start()`. Maneuver ENDS the segment. */
export type ComputedRouteStep = {
  lat: number
  lng: number
  endLat: number
  endLng: number
  distanceMeters: number
  maneuver?: ManeuverKind
  /** Full instruction from the Routes API (e.g. "Turn left onto Fell St"). */
  instruction?: string
  /** Resolved road name. Prefer this over parsing `instruction`. Null when none found. */
  road?: string | null
}

export type ComputedRoute = {
  points: LatLng[]
  totalDistanceMeters: number
  totalDurationSeconds: number
  summary?: string
  steps?: ComputedRouteStep[]
}

export type ComputeRouteResult = {
  ok: boolean
  error?: string
  /** Primary route first, alternates after. */
  routes?: ComputedRoute[]
}

export class NavigationModule {
  private _pivots: PivotEngine = new PivotEngine("walking", undefined)
  /** Subscriptions owned while a trip is active. Released on stop(). */
  private _tripUnsubs: Array<() => void> = []
  /** Trip params captured at start() so reroutes can re-issue computeRoute. */
  private _tripStops: LatLng[] | null = null
  private _tripMode: TravelMode = "walking"
  private _tripAvoid: RouteAvoidances | undefined = undefined
  /** Bumps per request so a stale reply from before a newer reroute is ignored. */
  private _computeRouteSeq = 0
  /** Latest GPS position, used as the origin for reroute computeRoute calls. */
  private _lastUserPosition: LatLng | null = null

  constructor(private readonly session: MiniappSession) {
    // Reverse-geocode fallback for pivots whose instruction carried no road name.
    this._pivots.setRoadNameResolver(async (coord) => {
      try {
        const result = await this.reverseGeocodeRoad(coord)
        if (!result.ok) return null
        return result.road ?? null
      } catch {
        return null
      }
    })
  }

  /** True iff `LOCATION` is declared in the miniapp's manifest. */
  get hasPermission(): boolean {
    return this.session._hasManifestPermission("LOCATION")
  }

  /**
   * Trigger the Nav SDK Terms & Conditions dialog up front, before the user hits "start".
   * Idempotent. Resolves `{ok: false, accepted: false, error}` when LOCATION isn't declared.
   */
  requestPermission(): Promise<NavPermissionResult> {
    if (!this.hasPermission) {
      return Promise.resolve({
        ok: false,
        accepted: false,
        error: "LOCATION permission not declared in miniapp.json (required for navigation.requestPermission).",
      })
    }
    return this.session.sendRequest<NavPermissionResult>({
      type: MiniappRequestType.NAVIGATION_REQUEST_PERMISSION,
    })
  }

  /**
   * Start a navigation session. Pass `{lat, lng}` or `{stops: [...]}`. `{ok: true}` means the
   * daemon accepted the request, not that a route was built — listen via `onUpdate(...)`.
   */
  async start(opts: StartNavigationOptions): Promise<{ok: boolean; error?: string}> {
    if (!this.hasPermission) {
      return {
        ok: false,
        error: "LOCATION permission not declared in miniapp.json (required for navigation.start).",
      }
    }
    const stops = normalizeStops(opts)
    const mode = opts.mode ?? "driving"

    this._tripStops = stops.length > 0 ? stops : null
    this._tripMode = mode
    this._tripAvoid = opts.avoid

    // Subscribes the engine to route + location streams. Idempotent — detaches any prior trip first.
    this._attachPivotTrackingForTrip(mode, opts.pivots)

    // Every failure return below must release the subscriptions attached just above.
    const failStart = (error: string): {ok: false; error: string} => {
      this._detachPivotTracking()
      return {ok: false, error}
    }

    if (stops.length === 0) {
      return failStart("navigation.start: no stops")
    }
    // Origin: live position if known, else a one-shot host fetch. (stops[0] would be the
    // destination for a single-stop trip — a degenerate origin.)
    let origin: LatLng | null = this._lastUserPosition
    if (!origin) {
      try {
        const fix = await this.session.location.getOnce()
        origin = {lat: fix.lat, lng: fix.lng}
        this._lastUserPosition = origin
      } catch (err) {
        return failStart(`navigation.start: no GPS fix (${err instanceof Error ? err.message : String(err)})`)
      }
    }

    // Source-of-truth route is the host's Routes REST call. If it fails, abort (no native fallback).
    const restResult = await this.computeRoute({origin, stops, mode, avoid: opts.avoid})
    if (!restResult.ok || !restResult.routes || restResult.routes.length === 0) {
      return failStart(restResult.error ?? "computeRoute failed")
    }
    const restRoute = restResult.routes[0]

    const nativeResult = await this.session.sendRequest<{ok: boolean; error?: string}>({
      type: MiniappRequestType.NAVIGATION_START,
      // Keep lat/lng on the wire for hosts not yet upgraded to read `stops`.
      lat: stops[0]?.lat,
      lng: stops[0]?.lng,
      stops,
      mode,
      avoid: opts.avoid,
      simulate: opts.simulate ?? false,
      speedMultiplier: opts.speedMultiplier ?? 1,
      missedTurnRerouteMeters: opts.missedTurnRerouteMeters,
    })
    if (!nativeResult.ok) {
      this._detachPivotTracking()
      return nativeResult
    }

    // Dispatch the REST route through the native route channel so subscribers see step roads now.
    const syntheticRoute = buildNavRouteFromComputed(restRoute)
    this.session.events._forwardEvent(MiniappStreamType.NAVIGATION_ROUTE, syntheticRoute)
    return nativeResult
  }

  /** Stop the active session (no-op if none). Fire-and-forget; also detaches pivot tracking. */
  stop(): void {
    this._detachPivotTracking()
    this.session.sendOneShot({type: MiniappRequestType.NAVIGATION_STOP})
  }

  /** Dev-only simulator helpers for testing trips. `deviate` works on both platforms;
   *  a few helpers are Android-only and return `{ok: false}` on iOS. */
  get dev(): NavigationDev {
    return {
      /** Nudge the simulator off-route to trigger a reroute. Default 20m. */
      deviate: (offsetMeters: number = 20): void => {
        this.session.sendOneShot({type: MiniappRequestType.NAVIGATION_DEVIATE, offsetMeters})
      },
      /** Lock simulated locations to the wrong sidewalk to test along-path pivot triggers. */
      setWrongSidewalkOffset: (enabled: boolean): void => {
        this.session.sendOneShot({type: MiniappRequestType.NAVIGATION_SET_WRONG_SIDEWALK, enabled})
      },
      /** Walk a polyline with crossing micro-steps removed, for missed-turn testing. */
      setSkipCrossings: (enabled: boolean): void => {
        this.session.sendOneShot({type: MiniappRequestType.NAVIGATION_SET_SKIP_CROSSINGS, enabled})
      },
    }
  }

  /** Subscribe to live trip events (maneuver / off_route / rerouting / arrived / error). */
  onUpdate(handler: (update: NavUpdate) => void): UnsubscribeFn {
    return this.session._subscribe(MiniappStreamType.NAVIGATION_UPDATE, handler as (data: unknown) => void)
  }

  /** Subscribe to the route polyline. Fires once per route build (initial + reroute), full path. */
  onRoute(handler: (route: NavRoute) => void): UnsubscribeFn {
    return this.session._subscribe(MiniappStreamType.NAVIGATION_ROUTE, handler as (data: unknown) => void)
  }

  /** Snapshot of the active trip, or `null` when none is running. Use on mount to hydrate state. */
  async getState(): Promise<NavState | null> {
    const result = await this.session.sendRequest<{ok: boolean; state?: NavState | null}>({
      type: MiniappRequestType.NAVIGATION_GET_STATE,
    })
    return result.ok ? (result.state ?? null) : null
  }

  /** Compute a route without starting a trip. Primary route first, alternates after. */
  computeRoute(opts: ComputeRouteOptions): Promise<ComputeRouteResult> {
    if (!this.hasPermission) {
      return Promise.resolve({
        ok: false,
        error: "LOCATION permission not declared in miniapp.json (required for navigation.computeRoute).",
      })
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

  /**
   * Reverse-geocode a coordinate into a short road name (`road`) and a full
   * formatted street address (`address`, e.g. "369 Hayes Street, San Francisco,
   * California 94102"). `road` backs the pivot engine's fallback; `address`
   * backs UI labels for dropped pins / POI taps. Each is null when none of that
   * kind is found near the coordinate; `ok: false` is an actual failure.
   *
   * Resolved entirely in the v2 cloud maps service (provider-abstracted, Mapbox
   * today) via the host bridge — the miniapp never holds a maps token or calls a
   * provider directly.
   */
  reverseGeocodeRoad(
    coord: LatLng,
  ): Promise<{ok: boolean; road?: string | null; address?: string | null; error?: string}> {
    if (!this.hasPermission) {
      return Promise.resolve({
        ok: false,
        error: "LOCATION permission not declared in miniapp.json (required for reverseGeocodeRoad).",
      })
    }
    return this.session.sendRequest<{
      ok: boolean
      road?: string | null
      address?: string | null
      error?: string
    }>({
      type: MiniappRequestType.NAVIGATION_REVERSE_GEOCODE,
      lat: coord.lat,
      lng: coord.lng,
    })
  }

  /**
   * Type-ahead place search. Returns lightweight suggestions for `query`,
   * optionally biased toward `near`. Resolved in the v2 cloud maps service
   * (Mapbox Search Box today) via the host bridge — no maps token in the
   * miniapp. `sessionToken` should be a stable per-search-box-opening string,
   * reused on the following `placeDetails` call, then rotated after a pick, so
   * the keystrokes + the final retrieve bill as one search session.
   *
   * Does NOT require LOCATION permission — it's a text search; `near` is only a
   * ranking bias. Resolves `{ok, suggestions}`; `ok: false` is an actual failure.
   */
  placeAutocomplete(opts: {
    query: string
    near?: LatLng
    sessionToken: string
  }): Promise<{ok: boolean; suggestions?: NavPlaceSuggestion[]; error?: string}> {
    return this.session.sendRequest<{
      ok: boolean
      suggestions?: NavPlaceSuggestion[]
      error?: string
    }>({
      type: MiniappRequestType.NAVIGATION_PLACE_AUTOCOMPLETE,
      query: opts.query,
      near: opts.near ?? null,
      sessionToken: opts.sessionToken,
    })
  }

  /**
   * Resolve a suggestion's `placeId` (from `placeAutocomplete`) to a full place
   * with coordinates. Pass the SAME `sessionToken` used for the autocomplete so
   * the provider closes the billing session. Resolved in the v2 cloud maps
   * service via the host bridge. Resolves `{ok, place}`; `ok: false` is a
   * failure (including an unresolvable id).
   */
  placeDetails(opts: {
    placeId: string
    sessionToken: string
  }): Promise<{ok: boolean; place?: NavPlaceDetails; error?: string}> {
    return this.session.sendRequest<{ok: boolean; place?: NavPlaceDetails; error?: string}>({
      type: MiniappRequestType.NAVIGATION_PLACE_DETAILS,
      placeId: opts.placeId,
      sessionToken: opts.sessionToken,
    })
  }

  // Pivots — real turns along the route, fired as approaching / entered / exited as GPS ticks in.

  /** Subscribe to pivot events. Each pivot fires once per kind; passed pivots aren't re-evaluated. */
  onPivot(handler: (event: PivotEvent) => void): UnsubscribeFn {
    return this._pivots.subscribe(handler)
  }

  /** Full pivot list for the active route. Empty before the first `onRoute`. */
  getPivots(): Pivot[] {
    return this._pivots.getPivots()
  }

  /** The pivot the user is currently inside (between `entered` and `exited`), or `null`. */
  getActivePivot(): Pivot | null {
    return this._pivots.getActivePivot()
  }

  /** The next pivot ahead, or `null` once every pivot has been passed. */
  getUpcomingPivot(): Pivot | null {
    return this._pivots.getUpcomingPivot()
  }

  private _attachPivotTrackingForTrip(mode: TravelMode, opts: PivotOptions | undefined): void {
    this._detachPivotTracking()
    this._pivots.reset()
    this._pivots.updateOptions(mode, opts)

    // Rebuild pivots on every route. Initial start emits a synthetic onRoute with REST steps (build
    // directly); a native reroute emits no steps (render geometry pivots, then enrich via REST).
    this._tripUnsubs.push(
      this.onRoute((route) => {
        if (route.steps && route.steps.length > 0) {
          // NavStep carries only the step start; the engine needs endLat/endLng to anchor the turn.
          // end of step[i] == start of step[i+1]; the final step uses the last polyline vertex.
          const tail = route.points[route.points.length - 1]
          const computedSteps = route.steps.map((s, i) => {
            const next = route.steps?.[i + 1]
            const endLat = next ? next.lat : (tail?.lat ?? s.lat)
            const endLng = next ? next.lng : (tail?.lng ?? s.lng)
            return {
              lat: s.lat,
              lng: s.lng,
              endLat,
              endLng,
              distanceMeters: s.distanceMeters,
              maneuver: s.maneuver,
              road: s.road ?? undefined,
            }
          })
          this._pivots.setRouteFromComputedSteps(route, computedSteps)
          return
        }
        this._pivots.setRoute(route, null)
        const seq = ++this._computeRouteSeq
        this._issueComputeRouteForTrip(route)
          .then((result) => {
            if (seq !== this._computeRouteSeq) return // superseded by a newer reroute
            const computedSteps = result?.routes?.[0]?.steps
            if (computedSteps && computedSteps.length > 0) {
              this._pivots.setRouteFromComputedSteps(route, computedSteps)
            }
          })
          .catch((err) => {
            console.warn("[NavigationModule] computeRoute for pivots failed:", err)
          })
      }),
    )

    // `arrived` resets the engine. `rerouting` is handled natively by the host, so no action here.
    this._tripUnsubs.push(
      this.onUpdate((update) => {
        if (update.kind === "arrived") {
          this._pivots.reset()
          return
        }
      }),
    )

    // Every fix drives the pivot cursor and records the latest position for reroute origin.
    this._tripUnsubs.push(
      this.session.location.onUpdate((loc: LocationData) => {
        this._lastUserPosition = {lat: loc.lat, lng: loc.lng}
        this._pivots.onLocationUpdate({lat: loc.lat, lng: loc.lng})
      }),
    )
  }

  /** computeRoute for the current trip, using the latest position (or route start) as origin. */
  private async _issueComputeRouteForTrip(route?: NavRoute): Promise<ComputeRouteResult | null> {
    if (!this._tripStops || this._tripStops.length === 0) return null
    const origin: LatLng | null =
      this._lastUserPosition ?? (route?.points && route.points[0] ? {lat: route.points[0].lat, lng: route.points[0].lng} : null)
    if (!origin) return null
    return this.computeRoute({
      origin,
      stops: this._tripStops,
      mode: this._tripMode,
      avoid: this._tripAvoid,
    })
  }

  // NOTE: client-side reroute was removed in the Mapbox migration — the host reroutes natively and
  // pushes the new route through `onRoute`. If a future host doesn't, re-add it in `onUpdate`.

  private _detachPivotTracking(): void {
    for (const unsub of this._tripUnsubs) {
      try {
        unsub()
      } catch (err) {
        console.warn("[NavigationModule] pivot-tracking unsubscribe threw:", err)
      }
    }
    this._tripUnsubs = []
    this._pivots.reset()
    // Bumping the sequence is the real guard against a stale in-flight reply; the rest is tidiness.
    this._tripStops = null
    this._tripAvoid = undefined
    this._computeRouteSeq++
    this._lastUserPosition = null
  }
}

/** Normalize the `{lat, lng}` shorthand into a `stops` array. */
function normalizeStops(opts: StartNavigationOptions): LatLng[] {
  if (opts.stops && opts.stops.length > 0) {
    return opts.stops
  }
  if (typeof opts.lat === "number" && typeof opts.lng === "number") {
    return [{lat: opts.lat, lng: opts.lng}]
  }
  return []
}

/**
 * Convert a REST `ComputedRoute` into the wire `NavRoute` shape. Anchors each step to a polyline
 * vertex (`routeIndex`) by nearest-point search. Steps with no maneuver default to "STRAIGHT".
 */
function buildNavRouteFromComputed(computed: ComputedRoute): NavRoute {
  const points = computed.points ?? []
  const steps: NavStep[] = (computed.steps ?? []).map((s) => {
    let routeIndex = 0
    let best = Infinity
    for (let i = 0; i < points.length; i++) {
      const dLat = points[i].lat - s.lat
      const dLng = points[i].lng - s.lng
      const d = dLat * dLat + dLng * dLng
      if (d < best) {
        best = d
        routeIndex = i
      }
    }
    return {
      lat: s.lat,
      lng: s.lng,
      routeIndex,
      road: s.road ?? null,
      maneuver: s.maneuver ?? "STRAIGHT",
      distanceMeters: s.distanceMeters,
    }
  })
  return {
    points,
    totalDistanceMeters: computed.totalDistanceMeters,
    totalDurationSeconds: computed.totalDurationSeconds,
    steps: steps.length > 0 ? steps : undefined,
  }
}
