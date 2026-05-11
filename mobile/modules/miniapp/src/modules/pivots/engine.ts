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

import type {LatLng, NavRoute, NavStep, Pivot, PivotEvent, PivotOptions, TravelMode} from "../navigation"
import {bearingDeg, cumulativeDistances, extractPivots, haversineMeters, signedAngleDiff, type RawPivot} from "./geometry"

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

export class PivotEngine {
  private opts: ResolvedOptions
  private pivots: Pivot[] = []
  private states: PivotState[] = []
  /** Index of the next pivot we expect the user to encounter. */
  private cursor = 0
  /** Pivot currently between `entered` and `exited`, or null. */
  private activePivotIndex: number | null = null

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

    this.pivots = pivots
    this.states = pivots.map(() => ({approachingFired: false, entered: false, exited: false}))
    this.cursor = 0
    this.activePivotIndex = null
  }

  /**
   * Drive the cursor with a new GPS fix. Fires `approaching` /
   * `entered` / `exited` as thresholds are crossed.
   */
  onLocationUpdate(coords: LatLng): void {
    if (this.pivots.length === 0) return

    // Walk forward from cursor — only consider the upcoming pivot
    // and any not-yet-finalized pivots ahead of it. We never
    // re-evaluate a pivot whose `exited` event has already fired.
    for (let i = this.cursor; i < this.pivots.length; i++) {
      const pivot = this.pivots[i]
      const state = this.states[i]
      if (state.exited) continue

      const distance = haversineMeters(coords, {lat: pivot.lat, lng: pivot.lng})

      // Approaching — first time inside the approach threshold.
      if (!state.approachingFired && distance <= this.opts.approachThresholdMeters) {
        state.approachingFired = true
        this.emit({kind: "approaching", pivot, distanceMeters: distance})
      }

      // Entered — first time inside the pivot radius.
      if (!state.entered && distance <= pivot.radiusMeters) {
        state.entered = true
        this.activePivotIndex = i
        this.emit({kind: "entered", pivot})
      }

      // Exited — was entered, now outside the radius again.
      if (state.entered && !state.exited && distance > pivot.radiusMeters) {
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
      if (!state.approachingFired && distance > this.opts.approachThresholdMeters * 2) {
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
  maneuver: string
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
