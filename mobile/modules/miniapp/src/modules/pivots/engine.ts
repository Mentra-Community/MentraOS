/**
 * @fileoverview Pivot engine — internal to NavigationModule.
 *
 * Owns the per-trip pivot list and the cursor that walks it as GPS
 * ticks come in. Public consumers of the SDK never touch this class
 * directly — they go through `navigation.onPivot()` / `getPivots()` /
 * `getActivePivot()` / `getUpcomingPivot()`.
 *
 * Lifecycle:
 *   - `reset()` on `navigation.start()`. Clears pivot list, cursor,
 *     all subscribers stay attached.
 *   - `setRoute(route)` on the first `onRoute` after start, and on
 *     every subsequent reroute. Rebuilds the pivot list from
 *     scratch.
 *   - `onLocationUpdate(coords)` on every GPS fix. Computes which
 *     events to fire and emits them to subscribers.
 *   - `reset()` on `stop()` / `arrived`.
 *
 * The engine doesn't subscribe to GPS itself — `NavigationModule`
 * owns that, calling `onLocationUpdate(coords)` from its own GPS
 * subscription. Keeps this class pure-state with no side effects.
 */

import type {LatLng, ManeuverKind, NavRoute, NavStep, Pivot, PivotEvent, PivotOptions, TravelMode} from "../navigation"
import {
  bearingDeg,
  cumulativeDistances,
  extractPivots,
  haversineMeters,
  signedAngleDiff,
  type RawPivot,
} from "./geometry"
import {extractPivotsFromComputedSteps} from "./instructions"

/**
 * Mode-aware defaults for `PivotOptions`. Tuned for typical
 * speeds — walking gets a tight radius (you have time to react),
 * driving gets a wider one (you need earlier warning).
 */
const RADIUS_DEFAULTS_M: Record<TravelMode, number> = {
  walking: 7,
  cycling: 15,
  driving: 40,
  two_wheeler: 25,
}

const APPROACH_DEFAULTS_M: Record<TravelMode, number> = {
  walking: 100,
  cycling: 300,
  driving: 800,
  two_wheeler: 500,
}

/**
 * SDK-internal maneuver categories that don't constitute a real
 * "turn" the UI should announce. Filtered out at pivot construction.
 */
const NON_TURN_MANEUVERS = new Set(["STRAIGHT", "NAME_CHANGE", "DEPART", "ARRIVE"])

/**
 * Maximum routeIndex delta when matching a geometry-derived pivot
 * against the SDK's step list. Beyond this, we treat the SDK as
 * having no matching step and leave fromRoad/toRoad null rather than
 * guessing.
 */
const STEP_MATCH_MAX_INDEX_DELTA = 8

/**
 * Realized PivotOptions with all fields resolved (no undefined).
 */
type ResolvedOptions = {
  radiusMeters: number
  approachThresholdMeters: number
}

type PivotState = {
  approachingFired: boolean
  entered: boolean
  exited: boolean
}

type Subscriber = (event: PivotEvent) => void

/**
 * Threshold (meters) for perpendicular distance to the route polyline.
 * Beyond this, the user is treated as "not on the route" — we fall back
 * to straight-line distance to the pivot point so pivots on a parallel
 * street don't fire by accident. Within this, we use along-path
 * projection (the user is on/near the planned path, just maybe on the
 * wrong sidewalk).
 */
const ON_ROUTE_PERP_TOLERANCE_M = 50

export class PivotEngine {
  private opts: ResolvedOptions
  private pivots: Pivot[] = []
  private states: PivotState[] = []
  /** Index of the next pivot we expect the user to encounter. */
  private cursor = 0
  /** Pivot currently between `entered` and `exited`, or null. */
  private activePivotIndex: number | null = null
  /**
   * Latest route polyline + its cumulative-distance array. Retained
   * after `setRoute()` so `onLocationUpdate` can project the user onto
   * the path and compare along-path distance to each pivot's
   * `distanceAlongRouteMeters`. This is what makes a pedestrian on the
   * wrong sidewalk still trigger the upcoming turn — straight-line
   * distance to the pivot point would miss it.
   */
  private points: LatLng[] = []
  private cumulative: number[] = []
  /**
   * Async road-name resolver injected by NavigationModule. Backs the
   * engine's last-resort fallback: when a pivot's `fromRoad` or
   * `toRoad` is null after Routes-API instruction parsing, the
   * engine samples a coordinate ~SAMPLE_OFFSET_M behind/ahead along
   * the polyline and asks the host to reverse-geocode it. Patched
   * onto the pivot in place when the response lands. Null when no
   * resolver is wired — the engine simply leaves the field null.
   */
  private roadNameResolver: ((coord: LatLng) => Promise<string | null>) | null = null
  /**
   * Generation counter bumped on every route rebuild. Geocode
   * responses from a stale route are discarded by comparing the
   * generation captured at request time against the current value.
   * Without this, a slow geocode reply from a previous route can
   * stamp a fresh route's pivot with the wrong road name.
   */
  private routeGeneration = 0

  private subscribers = new Set<Subscriber>()

  constructor(mode: TravelMode, opts: PivotOptions | undefined) {
    this.opts = resolveOptions(mode, opts)
  }

  /** Replace the trip-level options. Used if `start()` is called
   *  with new options without a full reset. */
  updateOptions(mode: TravelMode, opts: PivotOptions | undefined): void {
    this.opts = resolveOptions(mode, opts)
    // Re-stamp radiusMeters on every pivot.
    for (const p of this.pivots) {
      p.radiusMeters = this.opts.radiusMeters
    }
  }

  /**
   * Install the host-backed reverse-geocode resolver. NavigationModule
   * calls this once after constructing the engine, wiring through to
   * the host's Geocoding REST adapter. When unset, the engine simply
   * leaves null road names in place — geocoding is a best-effort
   * enhancement, not a requirement.
   */
  setRoadNameResolver(resolver: ((coord: LatLng) => Promise<string | null>) | null): void {
    this.roadNameResolver = resolver
  }

  /**
   * Clear all pivot state. Pivots = []. Cursor reset. Active pivot
   * cleared. Subscribers stay attached so the next `setRoute` can
   * fire events.
   */
  reset(): void {
    if (this.activePivotIndex !== null) {
      // Surface an exited event for the active pivot so consumers
      // don't see it stuck in "in-progress" state after a stop().
      const active = this.pivots[this.activePivotIndex]
      if (active) this.emit({kind: "exited", pivot: active})
    }
    this.pivots = []
    this.states = []
    this.cursor = 0
    this.activePivotIndex = null
    this.points = []
    this.cumulative = []
  }

  /**
   * Rebuild the pivot list from a Routes-API computed step list. This
   * is the high-accuracy path used during live trips: `instruction`
   * strings on each step name the road being entered unambiguously
   * ("Turn left onto Octavia Blvd"), and the explicit `endLat/endLng`
   * gives us the exact corner location without polyline-walking math.
   *
   * NavigationModule calls this once per route lifecycle — at trip
   * start (after firing NAVIGATION_COMPUTE_ROUTE), and again on every
   * reroute. The cursor + state machinery (approaching / entered /
   * exited) is identical to `setRoute` — only the pivot construction
   * differs.
   *
   * If the computed-step list is empty or no pivots survive the
   * filters in `extractPivotsFromComputedSteps`, this falls back to
   * `setRoute(route)` so the geometry-derived pivots are still
   * available. That keeps the engine working on platforms that don't
   * yet have Routes API plumbing.
   */
  setRouteFromComputedSteps(
    route: NavRoute,
    computedSteps:
      | Array<{
          lat: number
          lng: number
          endLat: number
          endLng: number
          distanceMeters: number
          maneuver?: ManeuverKind
          instruction?: string
          /** Host-resolved road name (Phase 1). Optional for backward
           *  compat with callers that only supply `instruction`. */
          road?: string | null
        }>
      | undefined,
  ): void {
    const points = route.points ?? []

    // Close out an in-flight pivot before rebuilding so subscribers
    // see a clean state transition.
    if (this.activePivotIndex !== null) {
      const active = this.pivots[this.activePivotIndex]
      if (active) this.emit({kind: "exited", pivot: active})
    }

    if (points.length < 3 || !computedSteps || computedSteps.length < 2) {
      // Fall back to the geometry-derived path. setRoute also handles
      // the points<3 early-exit cleanup.
      this.setRoute(route, null)
      return
    }

    const cumulative = cumulativeDistances(points)
    const instructionPivots = extractPivotsFromComputedSteps(computedSteps, points)
    console.log(
      `[PivotEngine] setRouteFromComputedSteps: steps=${computedSteps.length} instructionPivots=${instructionPivots.length}` +
        (instructionPivots.length > 0
          ? "\n" +
            instructionPivots
              .map(
                (p, i) =>
                  `  pivot[${i}] ${p.fromRoad ?? "—"} → ${p.toRoad ?? "—"} dir=${p.direction} @ (${p.lat.toFixed(5)}, ${p.lng.toFixed(5)})`,
              )
              .join("\n")
          : ""),
    )
    if (instructionPivots.length === 0) {
      // No survived turns from the instruction path — defer to geometry.
      // eslint-disable-next-line no-console
      console.log(
        `[PivotEngine] falling back to setRoute (geometry) — input steps:\n` +
          computedSteps
            .map(
              (s, i) =>
                `  step[${i}] road=${s.road ?? "—"} maneuver=${s.maneuver ?? "—"} @ (${s.lat.toFixed(5)}, ${s.lng.toFixed(5)}) → (${s.endLat.toFixed(5)}, ${s.endLng.toFixed(5)})`,
            )
            .join("\n"),
      )
      this.setRoute(route, null)
      return
    }

    const pivots: Pivot[] = instructionPivots.map((p, i) => ({
      index: i,
      lat: p.lat,
      lng: p.lng,
      direction: p.direction === "left" ? "left" : "right",
      fromRoad: p.fromRoad,
      toRoad: p.toRoad,
      maneuver: p.maneuver,
      distanceAlongRouteMeters: alongRouteAtCoord(points, cumulative, {lat: p.lat, lng: p.lng}),
      radiusMeters: this.opts.radiusMeters,
    }))

    // Crosswalk pivots intentionally NOT injected. Earlier the engine
    // surfaced CROSS_STREET pivots from extractCrossings(points) so a
    // "Cross the street" prompt would fire alongside turns — but in
    // practice every block on a city walk has 1-4 crosswalks and the
    // banner ended up flickering "Onto Gough St in 100m / 80m / 60m"
    // across each one, even though Gough was still hundreds of meters
    // away. The user perceives this as the destination jumping back
    // each time they pass a crosswalk. Removing the injection means
    // the only pivots in the list are real road→road turns from the
    // Routes API, which gives a monotonic countdown to each turn —
    // matching how Google Maps behaves. extractCrossings + CROSS_MERGE_M
    // are kept in the codebase in case crossings get reintroduced as a
    // separate (non-banner) signal later.

    pivots.sort((a, b) => a.distanceAlongRouteMeters - b.distanceAlongRouteMeters)
    for (let i = 0; i < pivots.length; i++) pivots[i].index = i

    this.pivots = pivots
    this.states = pivots.map(() => ({approachingFired: false, entered: false, exited: false}))
    this.cursor = 0
    this.activePivotIndex = null
    this.points = points
    this.cumulative = cumulative
    this.routeGeneration++

    // Kick off async reverse-geocode lookups for any pivot whose
    // instruction-parse didn't yield a clean road name. Also fills
    // toRoad for CROSS_STREET pivots so the label can read
    // "Cross to X".
    void this._resolveMissingRoadNames(this.routeGeneration)
  }

  /**
   * Rebuild the pivot list from a fresh route. Called on every
   * `onRoute` event. Any prior pivot list is discarded; cursor
   * resets to 0.
   */
  setRoute(route: NavRoute, _userPosition: LatLng | null): void {
    const points = route.points ?? []
    const steps = route.steps ?? []

    // If an active pivot was in flight, close it out cleanly before
    // wiping the list.
    if (this.activePivotIndex !== null) {
      const active = this.pivots[this.activePivotIndex]
      if (active) this.emit({kind: "exited", pivot: active})
    }

    if (points.length < 3) {
      this.pivots = []
      this.states = []
      this.cursor = 0
      this.activePivotIndex = null
      this.points = []
      this.cumulative = []
      return
    }

    const cumulative = cumulativeDistances(points)
    const raw = extractPivots(points)
    const stepIndex = buildStepIndex(steps)

    const pivots: Pivot[] = []
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i]
      const matched = matchStep(r, stepIndex)
      // Filter out non-turn maneuvers per the SDK's categorical types.
      // If the matched step's maneuver says STRAIGHT / NAME_CHANGE /
      // DEPART / ARRIVE, this isn't a turn the UI should announce —
      // even if our geometry detected a bend.
      if (matched && NON_TURN_MANEUVERS.has(matched.maneuver)) {
        continue
      }
      pivots.push({
        index: pivots.length,
        lat: r.lat,
        lng: r.lng,
        direction: r.direction,
        fromRoad: matched?.fromRoad ?? null,
        toRoad: matched?.toRoad ?? null,
        maneuver: matched?.maneuver ?? (r.direction === "left" ? "TURN_LEFT" : "TURN_RIGHT"),
        distanceAlongRouteMeters: distanceAtIndex(cumulative, r.rawRouteIndex),
        radiusMeters: this.opts.radiusMeters,
      })
    }

    // Crosswalk pivots intentionally NOT injected — see the matching
    // comment in setRouteFromComputedSteps. Crossings created banner
    // flicker on city walks where every block has multiple crosswalks
    // labeled "Onto <next turn road>", making the destination appear
    // to jump back each time the user crossed a side street.

    // Sort by along-route distance so the cursor walks them in
    // geographic order, then re-assign indices.
    pivots.sort((a, b) => a.distanceAlongRouteMeters - b.distanceAlongRouteMeters)
    for (let i = 0; i < pivots.length; i++) pivots[i].index = i

    this.pivots = pivots
    this.states = pivots.map(() => ({approachingFired: false, entered: false, exited: false}))
    this.cursor = 0
    this.activePivotIndex = null
    this.points = points
    this.cumulative = cumulative
    this.routeGeneration++

    // Geometry-fallback path: matchStep often leaves road names null
    // for unmatched pivots. Try the reverse-geocode resolver as a
    // last resort, same as setRouteFromComputedSteps.
    void this._resolveMissingRoadNames(this.routeGeneration)
  }

  /**
   * For every pivot in the current list that has a missing road
   * label, fill it in. Two-stage strategy:
   *
   *   1. **Inherit from neighbors.** Adjacent pivots on the route
   *      share roads by definition: between pivot N and pivot N+1
   *      there are no turns, so pivot N's toRoad == pivot N+1's
   *      fromRoad. If one side is known, copy it. This is free
   *      (no network) and avoids the geocode-mismatch class of bug
   *      where two different sample points return two different
   *      strings for what is conceptually the same road.
   *
   *   2. **Reverse-geocode the remainder.** For any field still
   *      null after inheritance, sample a coordinate ~18m behind
   *      (fromRoad) or ahead (toRoad) along the polyline and ask
   *      the host to reverse-geocode it. Best-effort — failures
   *      leave the field null.
   *
   * The `generation` guard rejects geocode replies arriving after
   * a fresh route rebuild superseded them.
   */
  private async _resolveMissingRoadNames(generation: number): Promise<void> {
    const pivots = this.pivots
    if (pivots.length === 0) return

    // Stage 1: neighbor inheritance. Walk forward then backward so
    // both directions of propagation happen in one pass. Same-road
    // dedupe is also implicit here — if N.toRoad == N+1.fromRoad
    // they already agree; if only one is known the other inherits.
    for (let i = 0; i < pivots.length - 1; i++) {
      const here = pivots[i]
      const next = pivots[i + 1]
      if (!here.toRoad && next.fromRoad) here.toRoad = next.fromRoad
      if (!next.fromRoad && here.toRoad) next.fromRoad = here.toRoad
    }
    for (let i = pivots.length - 1; i > 0; i--) {
      const here = pivots[i]
      const prev = pivots[i - 1]
      if (!prev.toRoad && here.fromRoad) prev.toRoad = here.fromRoad
      if (!here.fromRoad && prev.toRoad) here.fromRoad = prev.toRoad
    }

    // Stage 2: geocode whatever's still null. The rule is strict:
    // every pivot MUST end up with both fromRoad and toRoad. If a
    // single geocode attempt fails (returns null), expand the sample
    // distance and retry along the polyline until we either hit a
    // road name or run out of route in that direction.
    //
    // The expansion sequence is tuned to typical urban geometry:
    // 18m clears a sidewalk + crosswalk; 30m is mid-block; 50m is
    // well past the next building entrance; 80m approaches the
    // following intersection. Beyond ~80m we'd risk crossing into
    // the next street segment, which would return the wrong road.
    const resolver = this.roadNameResolver
    if (!resolver) return
    if (this.points.length < 2) return
    const SAMPLE_OFFSETS_M = [18, 30, 50, 80]
    const points = this.points
    const cumulative = this.cumulative

    /**
     * Try each offset in sequence until one returns a road name.
     * Direction is +1 for toRoad (sample ahead of pivot) or -1 for
     * fromRoad (sample behind pivot). Returns null only when every
     * offset failed.
     */
    const geocodeWithExpansion = async (pivotAlong: number, direction: 1 | -1): Promise<string | null> => {
      for (const offset of SAMPLE_OFFSETS_M) {
        const sample = sampleAlongRoute(points, cumulative, pivotAlong + direction * offset)
        if (!sample) continue
        try {
          const road = await resolver(sample)
          if (generation !== this.routeGeneration) return null
          if (road) return road
        } catch {
          /* try the next offset */
        }
      }
      return null
    }

    const tasks: Array<Promise<void>> = []
    for (const pivot of pivots) {
      if (pivot.fromRoad && pivot.toRoad) continue
      const along = pivot.distanceAlongRouteMeters
      if (!pivot.fromRoad) {
        tasks.push(
          geocodeWithExpansion(along, -1).then((road) => {
            if (generation !== this.routeGeneration) return
            if (road && !pivot.fromRoad) pivot.fromRoad = road
          }),
        )
      }
      if (!pivot.toRoad) {
        tasks.push(
          geocodeWithExpansion(along, 1).then((road) => {
            if (generation !== this.routeGeneration) return
            if (road && !pivot.toRoad) pivot.toRoad = road
          }),
        )
      }
    }
    await Promise.all(tasks)
    if (generation !== this.routeGeneration) return

    // After geocoding lands, run one more pass of neighbor
    // inheritance so a freshly-geocoded road can propagate to an
    // adjacent pivot that's still null. Cheap and resolves the case
    // where geocode succeeded on N.toRoad but failed on N+1.fromRoad
    // (or vice versa).
    for (let i = 0; i < pivots.length - 1; i++) {
      const here = pivots[i]
      const next = pivots[i + 1]
      if (!here.toRoad && next.fromRoad) here.toRoad = next.fromRoad
      if (!next.fromRoad && here.toRoad) next.fromRoad = here.toRoad
    }
  }

  /**
   * Drive the cursor with a new GPS fix. Fires `approaching` /
   * `entered` / `exited` as thresholds are crossed.
   *
   * Two distance metrics are used:
   *
   *   1. **Along-path distance** — the user's projected position on the
   *      route polyline gives `userAlong`; each pivot's
   *      `distanceAlongRouteMeters` is its `pivotAlong`. The signed
   *      delta `pivotAlong - userAlong` says how far the user still has
   *      to walk to reach the pivot's perpendicular line (positive =
   *      ahead, negative = past). This is the primary metric for
   *      pedestrians, because it doesn't care which sidewalk they're on
   *      — only that they've crossed the pivot's latitude/longitude
   *      band.
   *
   *   2. **Straight-line distance** — fallback when the user is more
   *      than ON_ROUTE_PERP_TOLERANCE_M from the polyline (they've
   *      really wandered off, not just onto the wrong sidewalk). Keeps
   *      the legacy behavior for that case.
   */
  onLocationUpdate(coords: LatLng): void {
    if (this.pivots.length === 0) return

    // Project the user onto the polyline. perpMeters tells us how far
    // they are from the route; userAlong tells us how far along the
    // route their projected position sits. Both are needed to choose
    // between the along-path and straight-line trigger metrics.
    const projection = projectOntoPolyline(this.points, this.cumulative, coords)
    const useAlongPath = projection !== null && projection.perpMeters <= ON_ROUTE_PERP_TOLERANCE_M
    const userAlong = projection?.alongMeters ?? 0

    // Walk forward from cursor — only consider the upcoming pivot
    // and any not-yet-finalized pivots ahead of it. We never
    // re-evaluate a pivot whose `exited` event has already fired.
    for (let i = this.cursor; i < this.pivots.length; i++) {
      const pivot = this.pivots[i]
      const state = this.states[i]
      if (state.exited) continue

      // `distanceToPivot` is the metric that decides approaching/entered/exited.
      // When the user is on the route polyline, it's how far they still
      // have to walk along the path; when they've wandered off, it
      // falls back to straight-line so we don't fire pivots they can't
      // reasonably reach.
      // `aheadDelta` is the signed along-path distance: positive means
      // pivot is ahead of the user, negative means they've already
      // crossed it. Only meaningful when useAlongPath is true.
      const aheadDelta = pivot.distanceAlongRouteMeters - userAlong
      const distanceToPivot = useAlongPath
        ? Math.abs(aheadDelta)
        : haversineMeters(coords, {lat: pivot.lat, lng: pivot.lng})

      // Approaching — first time inside the approach threshold. Only
      // counts if the pivot is still ahead of the user; we never
      // announce "approaching" for a pivot they've already crossed.
      const approaching =
        !state.approachingFired &&
        distanceToPivot <= this.opts.approachThresholdMeters &&
        (!useAlongPath || aheadDelta >= -this.opts.radiusMeters)
      if (approaching) {
        state.approachingFired = true
        this.emit({kind: "approaching", pivot, distanceMeters: distanceToPivot})
      }

      // Entered — user is within radiusMeters of the pivot. On-route
      // this fires the moment they cross the pivot's perpendicular
      // band, regardless of which sidewalk they're on.
      if (!state.entered && distanceToPivot <= pivot.radiusMeters) {
        state.entered = true
        this.activePivotIndex = i
        this.emit({kind: "entered", pivot})
      }

      // Exited — was entered and is now past the radius. With
      // along-path projection we additionally exit as soon as the user
      // is past the pivot by more than radiusMeters in the forward
      // direction — even if they never tripped `entered` (e.g. they
      // walked straight through the pivot band on a wide intersection
      // without ever being within radiusMeters of the point itself).
      const movedPastOnPath = useAlongPath && aheadDelta < -pivot.radiusMeters
      if (
        ((state.entered && distanceToPivot > pivot.radiusMeters) || (!state.entered && movedPastOnPath)) &&
        !state.exited
      ) {
        // If we're exiting without ever entering (skipped the band),
        // still emit `entered` first so subscribers can pair entered/exited.
        if (!state.entered) {
          state.entered = true
          this.activePivotIndex = i
          this.emit({kind: "entered", pivot})
        }
        state.exited = true
        if (this.activePivotIndex === i) this.activePivotIndex = null
        this.emit({kind: "exited", pivot})
        // Advance the cursor past this pivot — we don't re-evaluate it.
        if (this.cursor <= i) this.cursor = i + 1
      }

      // Stop scanning when we hit a pivot that hasn't fired
      // `approaching` yet AND is far enough to be in the future.
      // Specifically: if it's >2× approach threshold, don't bother
      // checking pivots beyond it this tick. Avoids O(N) work per
      // GPS fix on long routes.
      if (!state.approachingFired && distanceToPivot > this.opts.approachThresholdMeters * 2) {
        break
      }
    }
  }

  // Public accessors used by NavigationModule.

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn)
    return () => {
      this.subscribers.delete(fn)
    }
  }

  getPivots(): Pivot[] {
    return this.pivots.slice()
  }

  getActivePivot(): Pivot | null {
    if (this.activePivotIndex === null) return null
    return this.pivots[this.activePivotIndex] ?? null
  }

  getUpcomingPivot(): Pivot | null {
    // First pivot whose `exited` hasn't fired. Equivalent to
    // `pivots[cursor]` most of the time; using state directly is
    // safer if the cursor ever lags behind.
    for (let i = this.cursor; i < this.pivots.length; i++) {
      if (!this.states[i].exited) return this.pivots[i]
    }
    return null
  }

  private emit(event: PivotEvent): void {
    for (const fn of this.subscribers) {
      try {
        fn(event)
      } catch (err) {
        console.error("[PivotEngine] subscriber threw:", err)
      }
    }
  }
}

/** -------------------------------------------------------------- */
/* Helpers                                                          */

function resolveOptions(mode: TravelMode, opts: PivotOptions | undefined): ResolvedOptions {
  return {
    radiusMeters: opts?.radiusMeters ?? RADIUS_DEFAULTS_M[mode] ?? RADIUS_DEFAULTS_M.walking,
    approachThresholdMeters: opts?.approachThresholdMeters ?? APPROACH_DEFAULTS_M[mode] ?? APPROACH_DEFAULTS_M.walking,
  }
}

/**
 * Project `user` onto the polyline. Returns:
 *   - `perpMeters`: shortest distance from the user to the polyline (any segment).
 *   - `alongMeters`: cumulative distance from the polyline's start to
 *     the projection point, measured along the polyline.
 *
 * Used by `onLocationUpdate` to decide whether the user is "on the
 * route" (eligible for along-path pivot triggering) and how far they
 * have walked along it. Returns null when the polyline has fewer than
 * two points and projection is undefined.
 *
 * Uses a flat-earth approximation (lat/lng → meters via per-degree
 * scale at the local latitude). City-scale routes don't see meaningful
 * error from this; the alternative is per-segment spherical math which
 * doesn't pay for itself here.
 */
function projectOntoPolyline(
  points: LatLng[],
  cumulative: number[],
  user: LatLng,
): {perpMeters: number; alongMeters: number} | null {
  if (points.length < 2 || cumulative.length !== points.length) return null
  const mPerDegLat = 111_320
  const mPerDegLng = 111_320 * Math.cos((user.lat * Math.PI) / 180)
  const ux = user.lng * mPerDegLng
  const uy = user.lat * mPerDegLat

  let bestPerp = Number.POSITIVE_INFINITY
  let bestAlong = 0
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    const ax = a.lng * mPerDegLng
    const ay = a.lat * mPerDegLat
    const bx = b.lng * mPerDegLng
    const by = b.lat * mPerDegLat
    const dx = bx - ax
    const dy = by - ay
    const segLen2 = dx * dx + dy * dy
    // Parameter t along segment [0..1] of the closest point to user.
    // Degenerate zero-length segments (duplicate vertices) get t=0.
    const t = segLen2 > 0 ? Math.max(0, Math.min(1, ((ux - ax) * dx + (uy - ay) * dy) / segLen2)) : 0
    const px = ax + t * dx
    const py = ay + t * dy
    const perp = Math.hypot(ux - px, uy - py)
    if (perp < bestPerp) {
      bestPerp = perp
      const segLen = Math.sqrt(segLen2)
      bestAlong = cumulative[i] + t * segLen
    }
  }
  if (!Number.isFinite(bestPerp)) return null
  return {perpMeters: bestPerp, alongMeters: bestAlong}
}

/**
 * Project a coordinate onto the route polyline and return the
 * along-route distance in meters. Used for instruction-derived
 * pivots whose anchor is a Routes-API `endLat/endLng` rather than a
 * polyline-vertex index — we still need their `distanceAlongRouteMeters`
 * for the cursor's along-path metric. Falls back to 0 when projection
 * is undefined (degenerate polyline).
 */
function alongRouteAtCoord(points: LatLng[], cumulative: number[], coord: LatLng): number {
  const projection = projectOntoPolyline(points, cumulative, coord)
  return projection?.alongMeters ?? 0
}

/**
 * Interpolate the LatLng at a given along-route distance. Walks the
 * polyline segment-by-segment via the cumulative-distance array,
 * linearly interpolating within whichever segment contains the
 * target. Used by the reverse-geocode fallback to sample a
 * coordinate slightly behind or ahead of a pivot — far enough to be
 * cleanly on one road rather than at the ambiguous corner itself.
 *
 * Returns null when the target is outside [0, total] or the polyline
 * has fewer than two points. Callers treat null as "no sample
 * available" and skip the geocode lookup for that side.
 */
function sampleAlongRoute(points: LatLng[], cumulative: number[], targetMeters: number): LatLng | null {
  if (points.length < 2 || cumulative.length !== points.length) return null
  const total = cumulative[cumulative.length - 1]
  if (!Number.isFinite(targetMeters)) return null
  if (targetMeters <= 0) return {lat: points[0].lat, lng: points[0].lng}
  if (targetMeters >= total) {
    const last = points[points.length - 1]
    return {lat: last.lat, lng: last.lng}
  }
  // Binary search the segment containing targetMeters. cumulative is
  // monotonically increasing so we can find the segment in O(log n).
  let lo = 0
  let hi = cumulative.length - 1
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1
    if (cumulative[mid] <= targetMeters) lo = mid
    else hi = mid
  }
  const segStart = cumulative[lo]
  const segEnd = cumulative[hi]
  const segLen = segEnd - segStart
  const t = segLen > 0 ? (targetMeters - segStart) / segLen : 0
  const a = points[lo]
  const b = points[hi]
  return {lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t}
}

/** Cumulative-distance lookup. Clamps out-of-range indices. */
function distanceAtIndex(cumulative: number[], idx: number): number {
  if (cumulative.length === 0) return 0
  if (idx < 0) return 0
  if (idx >= cumulative.length) return cumulative[cumulative.length - 1]
  return cumulative[idx]
}

/**
 * Sort steps by `routeIndex` ascending so we can scan for the step
 * whose start lines up with a given pivot's polyline index.
 */
function buildStepIndex(steps: NavStep[]): NavStep[] {
  if (!steps.length) return []
  return steps.slice().sort((a, b) => a.routeIndex - b.routeIndex)
}

type MatchedStep = {
  fromRoad: string | null
  toRoad: string | null
  maneuver: ManeuverKind
}

/**
 * Bind a raw geometry pivot to its corresponding SDK step.
 *
 * SDK step convention: `step[i].road` is the road traversed during
 * step i, and `step[i].routeIndex` is the polyline vertex where step
 * i STARTS. The turn at the boundary between step i-1 and step i
 * lives at `step[i].routeIndex`.
 *
 * A geometric pivot at polyline index K is a step boundary. We find
 * the step `j >= 1` whose `routeIndex` is closest to K, and label the
 * pivot as the boundary at the end of step j-1:
 *
 *   fromRoad = step[j-1].road      (road we were on)
 *   toRoad   = step[j].road        (road we turn onto)
 *   maneuver = step[j-1].maneuver  (turn type at the end of step j-1)
 *
 * We start matching from `j=1` (skipping the trip-start step[0])
 * because step[0] doesn't represent a turn — its `routeIndex=0`
 * collides with later "depart" pseudo-steps that the SDK sometimes
 * emits before the first real turn.
 */
function matchStep(raw: RawPivot, stepIndex: NavStep[]): MatchedStep | null {
  if (stepIndex.length < 2) return null

  // Scan with `<=` so that when multiple steps share the same
  // routeIndex (the SDK sometimes emits duplicate trip-start
  // pseudo-steps at routeIndex=0), we land on the LAST one in the
  // group — the meaningful step boundary, not the depart filler.
  let bestJ = -1
  let bestDelta = Number.POSITIVE_INFINITY
  for (let i = 1; i < stepIndex.length; i++) {
    const delta = Math.abs(stepIndex[i].routeIndex - raw.rawRouteIndex)
    if (delta <= bestDelta) {
      bestDelta = delta
      bestJ = i
    }
  }
  if (bestJ < 1) return null
  if (bestDelta > STEP_MATCH_MAX_INDEX_DELTA) return null

  // Collapse "crossing" sub-steps. When a single geometric pivot spans
  // an intersection where the SDK emits multiple tiny steps (e.g.
  // Guerrero → Market(9m) → Gough), the user perceives one turn onto
  // the destination road. Advance past short transitional steps so
  // `toRoad` is the meaningful destination, not the crossing in
  // between.
  //
  // Stop one short of the FINAL step. The last step in the SDK's list
  // is the arrival leg — its `road` is typically a destination-anchor
  // string (the placename, an empty string, or literally "Destination"
  // on some hosts), not a real street name. Collapsing into it
  // produces labels like "15th St → Destination" instead of the
  // intended "Dolores St → 15th St". Keeping `j` strictly less than
  // the final index preserves the real street the user is turning
  // onto.
  const SHORT_TRANSIT_METERS = 25
  const finalIndex = stepIndex.length - 1
  let j = bestJ
  while (j < finalIndex - 1 && stepIndex[j].distanceMeters > 0 && stepIndex[j].distanceMeters < SHORT_TRANSIT_METERS) {
    j++
  }
  if (j >= finalIndex) j = finalIndex - 1

  const fromStep = stepIndex[bestJ - 1]
  const toStep = stepIndex[j]
  return {
    fromRoad: fromStep.road ?? null,
    toRoad: toStep.road ?? null,
    maneuver: fromStep.maneuver,
  }
}

// Re-export for unit tests / Navigation miniapp post-migration.
export {bearingDeg, haversineMeters, signedAngleDiff}
