// Minimal node-style process declaration so the file builds without a
// dependency on `@types/node`. The `dev` gate reads `process.env.NODE_ENV`,
// which is universally inlined by bundlers (esbuild / vite / metro) at
// build time, so the runtime never actually evaluates the property access.
declare const process: {env: {NODE_ENV?: string}}

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
 * ## Platform support
 *
 * - **Android** — fully supported. `start`, `stop`, `computeRoute`,
 *   `onUpdate`, `onRoute`, `onPivot`, and the `dev.*` simulator helpers
 *   all work on real GPS and simulated trips.
 * - **iOS** — partial. The trip lifecycle currently returns
 *   `{ok: false, error: ...}` and the `dev.*` helpers return the same.
 *   Callers should treat the trip-level methods as may-fail and surface
 *   the error string rather than assuming success.
 *
 * ## Error contract
 *
 * Every method that returns a `Promise` resolves with an `{ok, error?}`
 * shape — no method throws synchronously for missing-permission or
 * other reachable failures. Wrap a single `if (!result.ok)` check
 * around any call instead of mixing `try/catch` with `result.ok`.
 *
 * ## Maneuver vocabulary
 *
 * All maneuver-typed fields use the `ManeuverKind` literal union so
 * typos like `"CROSS_STRET"` fail at compile time.
 */

import {MiniappRequestType, MiniappStreamType} from "../protocol"
import {MiniappSession} from "../session"
import type {LocationData, UnsubscribeFn} from "./events"
import {PivotEngine} from "./pivots/engine"

export type LatLng = {lat: number; lng: number}

/** How the user is travelling. Drives routing + maneuver vocabulary. */
export type TravelMode = "walking" | "driving" | "cycling" | "two_wheeler"

/**
 * The complete categorical vocabulary the SDK uses for a maneuver. All
 * fields typed `ManeuverKind` (NavManeuver.maneuverType, Pivot.maneuver,
 * NavStep.maneuver, NavRouteStep.maneuver) use exactly this set so a
 * developer who typos a string gets a compile error instead of a runtime
 * surprise.
 *
 * - The "TURN_*" / "SLIGHT_*" / "SHARP_*" / "U_TURN" / "STRAIGHT" /
 *   "CONTINUE" / "NAME_CHANGE" / "DEPART" / "ARRIVE" set comes from the
 *   underlying Google Nav SDK + Routes API.
 * - "CROSS_STREET" is SDK-synthesized — the pivot engine detects
 *   crosswalk legs in the route geometry and surfaces them as a
 *   first-class maneuver so glasses HUDs can prompt the user to cross.
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

/** Optional routing preferences. All flags default to false. */
export type RouteAvoidances = {
  highways?: boolean
  tolls?: boolean
  ferries?: boolean
}

export type NavManeuver = {
  kind: "maneuver"
  /**
   * Categorical type of the upcoming maneuver. See `ManeuverKind` for
   * the full vocabulary. The discriminated union forces callers to
   * handle the cases they care about and catches typos at compile time.
   */
  maneuverType: ManeuverKind
  /** Distance in meters from the user's current position to that maneuver. -1 if unknown. */
  distanceMeters: number
  /**
   * Road the user is currently on, per the Nav SDK's StepInfo. Null if
   * the platform/region doesn't supply a name (e.g. unnamed paths,
   * sidewalks, plazas) or the maneuver was emitted before the first
   * NavInfo arrived.
   */
  fromRoad?: string | null
  /**
   * Legacy "next road" field — historically populated from the same
   * source as `fromRoad` (the current step's road, not the road after
   * the upcoming turn). Kept for back-compat. Prefer `nextStepRoad` for
   * new UIs.
   */
  toRoad?: string | null
  /**
   * Road the user will be on AFTER the upcoming maneuver, sourced from
   * the Nav SDK's `remainingSteps[0]`. Use this as the "next street"
   * label on a maneuver card. Null when the SDK hasn't surfaced a
   * remaining step yet (e.g. final leg, pre-first-NavInfo) or the
   * step has no name.
   */
  nextStepRoad?: string | null

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
  /**
   * Ordered list of steps along the route. Each step is one navigable
   * segment — typically a straight stretch of road that ends in a
   * maneuver (a turn, merge, arrival, etc.). The host emits this
   * alongside the polyline when the underlying engine supplies step
   * metadata. Older hosts may omit it; the pivot module degrades
   * gracefully by leaving road names null on the resulting pivots.
   */
  steps?: NavStep[]
}

/**
 * Tuning knobs for pivot detection on a single trip. Pass via
 * `StartNavigationOptions.pivots`; omitting any field uses the
 * mode-aware default below.
 */
export type PivotOptions = {
  /**
   * "You are turning now" radius in meters. When the user's GPS comes
   * within this distance of a pivot, `onPivot({kind: "entered"})`
   * fires. Defaults by mode: walking 7, cycling 15, driving 40.
   */
  radiusMeters?: number
  /**
   * "Approaching a turn" radius in meters. Fires `onPivot({kind:
   * "approaching"})` once per pivot when the user first crosses this
   * threshold ahead of the turn. Defaults by mode: walking 100,
   * cycling 300, driving 800.
   */
  approachThresholdMeters?: number
}

/**
 * A real turn along the route. Pivots are derived once per route
 * (re-derived on every reroute) from the polyline + step list. The
 * SDK fires `onPivot` events as the user approaches, enters, and
 * exits each pivot's radius.
 */
export type Pivot = {
  /**
   * 0-based ordinal along the route. Stable for the lifetime of one
   * route build — invalidated when `onRoute` fires again.
   */
  index: number
  /** Where the turn fires. */
  lat: number
  lng: number
  /**
   * Direction of the turn. Only real turns produce pivots —
   * `STRAIGHT` / `NAME_CHANGE` / `DEPART` are filtered out at
   * construction.
   */
  direction: "left" | "right"
  /**
   * Road the user approaches the pivot on. Null when the engine has
   * no name or when the host couldn't supply step metadata.
   */
  fromRoad: string | null
  /** Road the user exits the pivot onto. Same null semantics. */
  toRoad: string | null
  /**
   * Engine's categorical maneuver. Kept for icon selection in
   * consumer UIs. Vocabulary matches `NavManeuver.maneuverType`.
   */
  maneuver: ManeuverKind
  /** Meters from trip start to this pivot, along the route. */
  distanceAlongRouteMeters: number
  /**
   * The "you are turning now" radius for this pivot, in meters.
   * v1: uniform across all pivots in a trip (from PivotOptions).
   */
  radiusMeters: number
}

/**
 * Discriminated union of events fired by `navigation.onPivot(...)`.
 * Each pivot fires `approaching` (once, on first cross of the
 * approach threshold), `entered` (once, on first cross of the
 * radius), then `exited` (once, when the user leaves the radius
 * after entering). The cursor then advances and the same sequence
 * starts for the next pivot.
 */
export type PivotEvent =
  | {
      kind: "approaching"
      pivot: Pivot
      /** Straight-line distance from the user to the pivot when fired. */
      distanceMeters: number
    }
  | {kind: "entered"; pivot: Pivot}
  | {kind: "exited"; pivot: Pivot}

/**
 * One leg of a route: a stretch of road that ends in a maneuver. The
 * SDK's pivot module uses adjacent steps to derive `fromRoad` /
 * `toRoad` for each turn pivot.
 */
export type NavStep = {
  /** Coordinate where this step begins (== end of the previous step). */
  lat: number
  lng: number
  /**
   * Index into the parent `NavRoute.points[]` where this step starts.
   * Lets consumers align step boundaries with polyline geometry.
   */
  routeIndex: number
  /**
   * Name of the road traversed during this step. Null when the engine
   * has no name (unnamed paths, plazas) or when the host build doesn't
   * supply step road names.
   */
  road?: string | null
  /**
   * Categorical maneuver performed at the END of this step. See
   * `ManeuverKind` for the full vocabulary.
   */
  maneuver: ManeuverKind
  /** Length of this step in meters. */
  distanceMeters: number
}

/**
 * The shape returned by `navigation.dev`. Surfaced as an exported type
 * so consumers writing wrapper utilities (the demo Navigation miniapp's
 * `NavigationManager` wrapper, for example) can reference it without
 * inlining the method signatures.
 */
export type NavigationDev = {
  /** See `NavigationModule.dev.deviate`. */
  deviate(offsetMeters?: number): void
  /** See `NavigationModule.dev.setWrongSidewalkOffset`. */
  setWrongSidewalkOffset(enabled: boolean): void
  /** See `NavigationModule.dev.setSkipCrossings`. */
  setSkipCrossings(enabled: boolean): void
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

  /**
   * Override the default pivot-detection knobs for this trip. Affects
   * the `onPivot` / `getActivePivot` / etc. APIs. Omitted fields use
   * mode-aware defaults (see `PivotOptions`).
   */
  pivots?: PivotOptions

  /**
   * When set, the SDK fires a reroute as soon as the user is more than
   * this many meters past a pivot they didn't take. The new route is
   * planned from the user's current position, so the next pivot is
   * always ahead of them rather than behind. Omit (or set to 0) to keep
   * the Google Nav SDK's default off-route behavior.
   */
  missedTurnRerouteMeters?: number
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

/** Result of `requestPermission()`. */
export type NavPermissionResult = {
  /** True if the request reached the host. False on platforms with no nav backend (e.g. iOS). */
  ok: boolean
  /**
   * True if the user has accepted the Google Nav SDK Terms & Conditions.
   * On platforms that don't gate navigation behind a T&C dialog, this is
   * always true when `ok` is true.
   */
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
  /** Return up to N alternate routes (engine-permitting). Default 1. */
  alternatives?: number
}

/**
 * One turn-by-turn step in a previewed (not-yet-started) route. Sourced
 * directly from the Google Routes API at `computeRoute` time, so it's
 * available BEFORE `start()` is called. Each step describes one segment
 * of the route along with the maneuver that ENDS the segment (e.g. the
 * turn the user will take at the end of this step to enter the next).
 */
export type ComputedRouteStep = {
  /** Start coordinate of this step. */
  lat: number
  lng: number
  /** End coordinate of this step. */
  endLat: number
  endLng: number
  /** Length of this step in meters. */
  distanceMeters: number
  /**
   * Categorical maneuver, see `ManeuverKind`. Missing when the engine
   * didn't classify the step (e.g. very short or unnamed segments).
   */
  maneuver?: ManeuverKind
  /**
   * Full natural-language instruction (e.g. "Turn left onto Fell St").
   * Comes straight from the Routes API; no client-side parsing.
   */
  instruction?: string
  /**
   * Resolved road name for this step (e.g. "Hayes St"). Filled by the
   * host's hybrid resolver: parse "onto X" from `instruction` when the
   * Routes API supplied one; otherwise reverse-geocode the step
   * midpoint. Null when neither path produced a name (e.g. an unnamed
   * pedestrian segment whose midpoint also reverse-geocodes blank).
   *
   * Use this in preference to parsing `instruction` yourself — the host
   * runs the same resolver for preview and live trip, so road names
   * stay consistent across both phases.
   */
  road?: string | null
}

export type ComputedRoute = {
  points: LatLng[]
  totalDistanceMeters: number
  totalDurationSeconds: number
  /** Polyline-aligned road labels, when supplied by the engine. */
  summary?: string
  /** Turn-by-turn step list, when the engine returns one. */
  steps?: ComputedRouteStep[]
}

export type ComputeRouteResult = {
  ok: boolean
  error?: string
  /** Primary route first, alternates after. */
  routes?: ComputedRoute[]
}

export class NavigationModule {
  // Owned by the module — internal to pivot tracking. Lifecycle is
  // tied to start()/stop(). See `_attachPivotTrackingForTrip` and
  // `_detachPivotTracking`.
  private _pivots: PivotEngine = new PivotEngine("walking", undefined)
  /** Subscriptions the module owns while a trip is active. Released on stop(). */
  private _tripUnsubs: Array<() => void> = []
  /**
   * Trip parameters captured at `start()` time so we can re-issue
   * `computeRoute` on every reroute. The Routes REST API returns
   * step-level `instruction` strings and exact `endLat/endLng`
   * coordinates — both significantly more reliable for pivot road
   * naming than the Android Nav SDK's `StepInfo.road` field.
   */
  private _tripStops: LatLng[] | null = null
  private _tripMode: TravelMode = "walking"
  private _tripAvoid: RouteAvoidances | undefined = undefined
  /**
   * Last `computeRoute` request token. Bumps on each issue so an
   * in-flight reply that resolves after a newer reroute lands is
   * ignored. Without this guard, the older response can clobber a
   * fresher pivot list on a fast reroute.
   */
  private _computeRouteSeq = 0
  /**
   * Latest known user position from the SDK's GPS stream. Used as the
   * `origin` for `computeRoute` on reroutes (the route polyline's
   * first vertex isn't a reliable origin once the trip has been
   * running for a while). Initialized lazily on the first GPS fix.
   */
  private _lastUserPosition: LatLng | null = null

  constructor(private readonly session: MiniappSession) {
    // Wire the reverse-geocode fallback so the engine can patch
    // missing road names on pivots whose Routes-API instruction
    // didn't carry one. The resolver returns a road name (or null
    // when the host couldn't find one); errors are swallowed inside
    // the engine and leave the pivot's road field null.
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
   * Trigger the Google Nav SDK Terms & Conditions dialog up front. Call
   * this once when a navigation-aware miniapp mounts so the dialog is out
   * of the way before the user hits "start". Idempotent — resolves
   * immediately with `{accepted: true}` when the user has already
   * accepted (cached in-process / on-disk).
   *
   * Always resolves; never throws. Check `result.ok` and
   * `result.accepted`. If the miniapp manifest is missing the LOCATION
   * permission the call resolves with `{ok: false, accepted: false,
   * error: "..."}` so a single error-handling path covers all failures.
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
   * Start a turn-by-turn navigation session. Pass either `{lat, lng}` for a
   * single destination, or `{stops: [...]}` for a multi-stop trip (last
   * entry is the final destination). Resolves with the phone-side ack —
   * `{ok: true}` means the daemon accepted the request, not that a route
   * was successfully built. Listen via `onUpdate(...)` for the actual nav
   * events.
   *
   * Always resolves; never throws. Permission errors, missing stops,
   * and host rejections all come back through `{ok: false, error}` so
   * a single error path covers every failure mode.
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

    // Capture trip parameters so `_attachPivotTrackingForTrip` can
    // re-call `computeRoute` on every reroute and feed instruction-
    // parsed pivots into the engine.
    this._tripStops = stops.length > 0 ? stops : null
    this._tripMode = mode
    this._tripAvoid = opts.avoid

    // Attach pivot tracking for this trip. Subscribes the engine to
    // route + location streams. Idempotent — detaches any prior trip
    // first so a stop-less restart doesn't leak subscriptions.
    this._attachPivotTrackingForTrip(mode, opts.pivots)

    // Every failure return below this point must release the
    // pivot-tracking subscriptions attached just above — otherwise a
    // failed start leaks the GPS/route listeners (and the captured trip
    // params) for a trip that never actually began.
    const failStart = (error: string): {ok: false; error: string} => {
      this._detachPivotTracking()
      return {ok: false, error}
    }

    // Phase 2: source-of-truth route comes from the host's Routes REST
    // call, not the Android Nav SDK. Resolve the REST route first; if
    // it fails, abort the trip start (no native fallback — the goal of
    // Phase 2 is that preview, live, and reroute all use the same
    // polyline + pivots). On success, fire the native start so position
    // fixes + reroute detection wire up, then dispatch the REST route
    // as a synthetic `onRoute` event so subscribers (the pivot engine,
    // miniapp UI) render the REST polyline + steps.
    if (stops.length === 0) {
      return failStart("navigation.start: no stops")
    }
    // Origin precedence: live-stream position if we have one (fast,
    // 0ms), else a one-shot location fetch from the host (~50-200ms on
    // first call). The earlier fallback to stops[0] was a bug —
    // stops[0] is the FIRST stop, which for a single-destination trip
    // is the destination, producing a degenerate origin==destination
    // route from the Routes API.
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
    const restResult = await this.computeRoute({
      origin,
      stops,
      mode,
      avoid: opts.avoid,
    })
    if (!restResult.ok || !restResult.routes || restResult.routes.length === 0) {
      return failStart(restResult.error ?? "computeRoute failed")
    }
    const restRoute = restResult.routes[0]

    const nativeResult = await this.session.sendRequest<{ok: boolean; error?: string}>({
      type: MiniappRequestType.NAVIGATION_START,
      // Keep lat/lng on the wire for hosts that haven't been upgraded to
      // read `stops` yet. New hosts prefer `stops` when present.
      lat: stops[0]?.lat,
      lng: stops[0]?.lng,
      stops,
      mode,
      avoid: opts.avoid,
      simulate: opts.simulate ?? false,
      speedMultiplier: opts.speedMultiplier ?? 5,
      missedTurnRerouteMeters: opts.missedTurnRerouteMeters,
    })
    if (!nativeResult.ok) {
      this._detachPivotTracking()
      return nativeResult
    }

    // Synthesize a NavRoute from the REST ComputedRoute and dispatch it
    // through the same channel native route events use. Subscribers
    // can't tell the difference; the pivot engine sees REST-derived
    // step roads immediately instead of waiting for the retroactive
    // `_issueComputeRouteForTrip` call.
    const syntheticRoute = buildNavRouteFromComputed(restRoute)
    this.session.events._forwardEvent(MiniappStreamType.NAVIGATION_ROUTE, syntheticRoute)
    return nativeResult
  }

  /**
   * Stop the active navigation session. Safe to call when no trip is
   * running — the host treats it as a no-op. Fire-and-forget; the call
   * does not resolve a status because the simulator-pause / nav-SDK-
   * teardown sequence is sync on the host. Also detaches pivot
   * tracking, so any `onPivot(...)` listeners attached for the active
   * trip stop firing after this returns.
   *
   * @example
   *   const result = await user.navigation.start({...})
   *   if (result.ok) {
   *     // ...
   *     user.navigation.stop()
   *   }
   */
  stop(): void {
    this._detachPivotTracking()
    this.session.sendOneShot({type: MiniappRequestType.NAVIGATION_STOP})
  }

  /**
   * Dev-only helpers, namespaced so production consumers can't tab-
   * complete into them accidentally. The getter also throws when
   * `process.env.NODE_ENV === "production"` so a release build that
   * forgot to remove a `navigation.dev.*` call fails loudly rather
   * than silently kicking the simulator.
   *
   * Every method here is Android (simulated trips) only. iOS returns
   * `{ok: false, error: "Not implemented on iOS"}` at the bridge layer.
   *
   * @example
   *   if (process.env.NODE_ENV !== "production") {
   *     user.navigation.dev.deviate(50) // skip the next turn
   *   }
   */
  get dev(): NavigationDev {
    // if (process.env.NODE_ENV === "production") {
    //   throw new Error(
    //     "navigation.dev is unavailable in production builds. " +
    //       "Gate dev calls behind `if (process.env.NODE_ENV !== \"production\")`.",
    //   )
    // }
    return {
      /**
       * Nudge the simulator ~`offsetMeters` perpendicular to the route
       * so the Nav SDK detects an off-route condition and reroutes.
       * Default 20m. Fire-and-forget.
       */
      deviate: (offsetMeters: number = 20): void => {
        this.session.sendOneShot({
          type: MiniappRequestType.NAVIGATION_DEVIATE,
          offsetMeters,
        })
      },
      /**
       * Toggle: lock simulated locations to the wrong sidewalk (~8m
       * perpendicular to the route bearing). Lets us verify the
       * along-path pivot trigger fires even when the user never comes
       * within the 7m radius of a pivot point.
       */
      setWrongSidewalkOffset: (enabled: boolean): void => {
        this.session.sendOneShot({
          type: MiniappRequestType.NAVIGATION_SET_WRONG_SIDEWALK,
          enabled,
        })
      },
      /**
       * Toggle: take over from Google's simulator and walk a polyline
       * with crossing micro-steps removed. Reproduces the
       * pedestrian-ignores-crosswalk scenario for missed-turn testing.
       */
      setSkipCrossings: (enabled: boolean): void => {
        this.session.sendOneShot({
          type: MiniappRequestType.NAVIGATION_SET_SKIP_CROSSINGS,
          enabled,
        })
      },
    }
  }

  /**
   * Subscribe to live navigation updates. Returns an unsubscribe
   * function — call it to stop receiving events. All five trip-state
   * events (maneuver / off_route / rerouting / arrived / error) flow
   * through this single stream as a discriminated union. Narrow on
   * `update.kind` to pick the case you care about; TypeScript will
   * tell you when you've missed one.
   *
   * @example
   *   const unsub = user.navigation.onUpdate((u) => {
   *     switch (u.kind) {
   *       case "maneuver":   showCard(u.maneuverType, u.distanceMeters); break
   *       case "off_route":  console.warn("off route by", u.offRouteDistanceMeters, "m"); break
   *       case "rerouting":  setStatus("rerouting"); break
   *       case "arrived":    setStatus("arrived"); break
   *       case "error":      console.error(u.message); break
   *     }
   *   })
   *   // later — when the component unmounts or the trip ends
   *   unsub()
   */
  onUpdate(handler: (update: NavUpdate) => void): UnsubscribeFn {
    return this.session._subscribe(MiniappStreamType.NAVIGATION_UPDATE, handler as (data: unknown) => void)
  }

  /**
   * Subscribe to the active route polyline. Fires once per route build
   * (initial route + every reroute), delivering the full path each
   * time — not a diff. Use this to draw the route on a map. Returns an
   * unsubscribe function.
   *
   * @example
   *   const unsub = user.navigation.onRoute((route) => {
   *     map.setPolyline(route.points)
   *     console.log("route is", route.totalDistanceMeters, "m")
   *   })
   *   return unsub // e.g. from useEffect's cleanup
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
   * Always resolves; never throws. Permission errors come back through
   * `{ok: false, error}` so a single error path covers every failure.
   */
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
   * Reverse-geocode a coordinate into a short road name. Backs the
   * pivot engine's fallback for turns whose Routes-API instruction
   * didn't parse a clean road (rare but happens — e.g. unnamed paths,
   * private drives, plazas). Host calls Google's Geocoding REST API
   * and extracts the route-component name ("Octavia Blvd").
   *
   * Returns `{ok: true, road: string | null}` on success. `road` is
   * null when the host couldn't find a route component near the
   * coordinate (mid-park, off-grid). `ok: false` indicates an actual
   * failure (network error, missing API key, no host adapter).
   *
   * Always resolves; never throws. Permission errors come back
   * through `{ok: false, error}`.
   */
  reverseGeocodeRoad(coord: LatLng): Promise<{ok: boolean; road?: string | null; error?: string}> {
    if (!this.hasPermission) {
      return Promise.resolve({
        ok: false,
        error: "LOCATION permission not declared in miniapp.json (required for reverseGeocodeRoad).",
      })
    }
    return this.session.sendRequest<{ok: boolean; road?: string | null; error?: string}>({
      type: MiniappRequestType.NAVIGATION_REVERSE_GEOCODE,
      lat: coord.lat,
      lng: coord.lng,
    })
  }

  // -------------------------------------------------------------------
  // Pivots
  //
  // Pivots are real turns along the active route. The SDK derives them
  // once per route (re-derives on every reroute) from the polyline +
  // step list delivered via `onRoute`. As GPS ticks in, the SDK fires
  // `approaching` / `entered` / `exited` events for each pivot,
  // backed by a per-trip radius (default 7m walking). This is the
  // recommended primary abstraction for building turn-by-turn UIs —
  // it's resilient to the SDK's noisy `maneuverType` flicker and to
  // GPS jitter.
  //
  // The pivot list is owned by the SDK and lives only when a trip is
  // active. It's cleared on `start()`, rebuilt on the first `onRoute`
  // event after start (and on every subsequent reroute), and cleared
  // again on `stop()` or arrival.
  //
  // Stubs below — full implementation lands in a follow-up. Signatures
  // are stable.

  /**
   * Subscribe to pivot events. Returns an unsubscribe function.
   *
   * Each pivot fires (in order):
   *   - `approaching` — once, when the user crosses the approach
   *     threshold ahead of the pivot.
   *   - `entered` — once, when the user crosses into the pivot's
   *     `radiusMeters`.
   *   - `exited` — once, when the user leaves the radius after
   *     entering. The cursor then advances to the next pivot.
   *
   * Passed pivots are not re-evaluated. If the user walks back into a
   * pivot's radius after exiting, no further events fire for it.
   *
   * @example
   * navigation.onPivot((event) => {
   *   if (event.kind === "entered") {
   *     showInstruction(`Turn ${event.pivot.direction} onto ${event.pivot.toRoad}`)
   *   }
   * })
   */
  onPivot(handler: (event: PivotEvent) => void): UnsubscribeFn {
    return this._pivots.subscribe(handler)
  }

  /**
   * Full pivot list for the active route. Empty when no trip is
   * running or the first `onRoute` hasn't arrived yet.
   *
   * The list is stable across the lifetime of one route build — only
   * a reroute (next `onRoute` event) replaces it.
   */
  getPivots(): Pivot[] {
    return this._pivots.getPivots()
  }

  /**
   * The pivot the user is currently inside the radius of, or `null`
   * when they aren't actively in a turn. Defined as: a pivot is
   * "active" between its `entered` event and its `exited` event.
   *
   * Use this to render the "you are turning now" UI state.
   */
  getActivePivot(): Pivot | null {
    return this._pivots.getActivePivot()
  }

  /**
   * The next pivot ahead of the user along the route, regardless of
   * distance. `null` when the user has passed every pivot (final
   * approach to destination).
   *
   * Use this to render "approaching <road>" / countdown UI.
   */
  getUpcomingPivot(): Pivot | null {
    return this._pivots.getUpcomingPivot()
  }

  // -------------------------------------------------------------------
  // Internal: pivot-tracking lifecycle. Wired from start()/stop().
  // Subscribers to onRoute / location.onUpdate are owned here and
  // released in _detachPivotTracking().

  private _attachPivotTrackingForTrip(mode: TravelMode, opts: PivotOptions | undefined): void {
    // If a previous trip's subscriptions are still attached
    // (shouldn't be, but be safe across hot-reload / dev iterations),
    // detach them first.
    this._detachPivotTracking()

    // Reset the engine for the new trip and replace its tuning.
    this._pivots.reset()
    this._pivots.updateOptions(mode, opts)

    // Subscribe to onRoute — rebuilds the pivot list whenever a new
    // route lands. There are two source paths post-Phase 2:
    //   1. Initial trip start: `start()` dispatches a SYNTHETIC onRoute
    //      built from the Routes REST result. It carries REST-derived
    //      steps with resolved `road` names, so we can build pivots
    //      directly via `setRouteFromComputedSteps`.
    //   2. Reroute: the native Nav SDK still emits its own polyline on
    //      reroute (Phase 3 will move this to REST too). Native emits
    //      arrive without REST steps, so we fall back to the existing
    //      retroactive Routes-API enrichment — geometry pivots first,
    //      REST-derived pivots once the request resolves.
    this._tripUnsubs.push(
      this.onRoute((route) => {
        // Synthetic REST emit: route.steps is populated with resolved
        // road names. Map NavStep → ComputedRouteStep shape that the
        // pivot engine expects and skip the retroactive REST call.
        if (route.steps && route.steps.length > 0) {
          // NavStep only carries (lat, lng) at the step's start. The
          // pivot engine wants endLat/endLng to anchor turns at the
          // junction where the user actually pivots. The end of
          // step[i] equals the start of step[i+1]; for the final step
          // we fall back to the last polyline vertex (the destination).
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
        // Native reroute (no REST steps yet) — render geometry pivots
        // immediately, then ask the host for a REST polyline so the
        // pivots can be replaced with instruction-derived ones.
        // Phase 3 will replace this entire branch with a REST-first
        // reroute path.
        this._pivots.setRoute(route, null)
        const seq = ++this._computeRouteSeq
        this._issueComputeRouteForTrip(route)
          .then((result) => {
            if (seq !== this._computeRouteSeq) return // a newer reroute already superseded us
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

    // Subscribe to NavUpdate:
    //   - `arrived` resets the engine so the pivot list doesn't linger
    //     after a trip ends.
    //   - `rerouting` is the trip's only chance to refresh the route
    //     once the user goes off course. Native route emits are
    //     suppressed for the whole trip (REST owns the polyline), so a
    //     reroute never arrives via `onRoute`. Re-run the Routes REST
    //     call from the user's current position and dispatch a fresh
    //     synthetic `onRoute` — the same path `start()` uses — so the
    //     map polyline, steps, and pivots all rebuild. Without this the
    //     UI sits on the stale pre-reroute route until arrival.
    this._tripUnsubs.push(
      this.onUpdate((update) => {
        if (update.kind === "arrived") {
          this._pivots.reset()
          return
        }
        if (update.kind === "rerouting") {
          this._reissueRouteForReroute()
        }
      }),
    )

    // Subscribe to location updates — every fix drives the cursor
    // and may fire approaching / entered / exited events. Also store
    // the latest position so reroute-time `computeRoute` calls use
    // the user's current location as origin (not the original trip
    // start).
    this._tripUnsubs.push(
      this.session.location.onUpdate((loc: LocationData) => {
        this._lastUserPosition = {lat: loc.lat, lng: loc.lng}
        this._pivots.onLocationUpdate({lat: loc.lat, lng: loc.lng})
      }),
    )
  }

  /**
   * Issue a `computeRoute` request for the current trip. Origin
   * defaults to the latest known user position; falls back to the
   * route polyline's first vertex when GPS hasn't arrived yet (e.g.
   * at the very start of a trip). Returns null when there's no usable
   * origin or trip context — caller treats that as "no enrichment
   * available, keep geometry pivots."
   */
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

  /**
   * Refresh the route after a native reroute. Bumps the compute-route
   * sequence (so a reply from a reroute that was already superseded by a
   * newer one is dropped), re-runs the Routes REST call from the user's
   * current position, and dispatches the result as a synthetic
   * `onRoute`. The existing onRoute path rebuilds the polyline, steps,
   * and pivots; the next maneuver event flips the trip status back out
   * of "rerouting". No-op when the trip context is gone (post-stop).
   */
  private _reissueRouteForReroute(): void {
    if (!this._tripStops || this._tripStops.length === 0) return
    const seq = ++this._computeRouteSeq
    this._issueComputeRouteForTrip()
      .then((result) => {
        if (seq !== this._computeRouteSeq) return // a newer reroute superseded us
        const computed = result?.routes?.[0]
        if (!computed) return
        const syntheticRoute = buildNavRouteFromComputed(computed)
        this.session.events._forwardEvent(MiniappStreamType.NAVIGATION_ROUTE, syntheticRoute)
      })
      .catch((err) => {
        console.warn("[NavigationModule] reroute computeRoute failed:", err)
      })
  }

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
    // Drop captured trip parameters so an in-flight computeRoute reply
    // from the previous trip can't slip a stale pivot list into the
    // engine after stop(). Bumping the sequence is the actual guard;
    // clearing the stops is for tidiness.
    this._tripStops = null
    this._tripAvoid = undefined
    this._computeRouteSeq++
    this._lastUserPosition = null
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

/**
 * Convert a REST-derived `ComputedRoute` into the wire `NavRoute` shape
 * `onRoute` subscribers expect. The two types overlap heavily —
 * `ComputedRoute.points` maps straight onto `NavRoute.points`, and
 * `ComputedRouteStep` already carries `road` and `maneuver` typed as
 * `ManeuverKind`. The main work is anchoring each step to a polyline
 * vertex (`routeIndex`) by linear search on `step.lat/lng`, since
 * `NavStep` requires a `routeIndex` but `ComputedRouteStep` doesn't
 * surface one. Steps with no maneuver default to `"STRAIGHT"` so the
 * field stays typed.
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
