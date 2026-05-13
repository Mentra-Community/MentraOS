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
  extractCrossings,
  extractPivots,
  haversineMeters,
  signedAngleDiff,
  type RawPivot,
} from "./geometry"

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
const NON_TURN_MANEUVERS = new Set([
  "STRAIGHT",
  "NAME_CHANGE",
  "DEPART",
  "ARRIVE",
])

/**
 * Maximum routeIndex delta when matching a geometry-derived pivot
 * against the SDK's step list. Beyond this, we treat the SDK as
 * having no matching step and leave fromRoad/toRoad null rather than
 * guessing.
 */
const STEP_MATCH_MAX_INDEX_DELTA = 8

/**
 * A crossing pivot within this along-route distance of an existing
 * turn pivot is dropped — the turn maneuver already implies the user
 * will cross the road as part of the turn, so a duplicate
 * "Cross the road" prompt right next to "Turn right" is noise.
 */
const CROSS_MERGE_M = 15

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

    // Inject CROSS_STREET pivots for each detected crosswalk leg. The
    // crossing's pivot lives at the START curb so the "approaching"
    // event fires as the user nears the crosswalk on their current
    // sidewalk. Drop any crossing whose along-route distance lands
    // within CROSS_MERGE_M of an existing turn pivot — the turn-card
    // already implies the user will cross at that intersection, and a
    // duplicate "Cross the road" prompt right next to a "Turn right"
    // is noise.
    const crossings = extractCrossings(points)
    for (const c of crossings) {
      const along = distanceAtIndex(cumulative, c.startIndex)
      const nearTurn = pivots.some((p) => Math.abs(p.distanceAlongRouteMeters - along) < CROSS_MERGE_M)
      if (nearTurn) continue
      pivots.push({
        index: -1, // assigned after the sort below
        lat: c.lat,
        lng: c.lng,
        // Crossings have no rotation direction; pick "right" so consumers
        // expecting one of the two values don't see undefined.
        direction: "right",
        fromRoad: null,
        toRoad: null,
        maneuver: "CROSS_STREET",
        distanceAlongRouteMeters: along,
        radiusMeters: this.opts.radiusMeters,
      })
    }
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
    approachThresholdMeters:
      opts?.approachThresholdMeters ?? APPROACH_DEFAULTS_M[mode] ?? APPROACH_DEFAULTS_M.walking,
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
  const SHORT_TRANSIT_METERS = 25
  let j = bestJ
  while (
    j < stepIndex.length - 1 &&
    stepIndex[j].distanceMeters > 0 &&
    stepIndex[j].distanceMeters < SHORT_TRANSIT_METERS
  ) {
    j++
  }

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
