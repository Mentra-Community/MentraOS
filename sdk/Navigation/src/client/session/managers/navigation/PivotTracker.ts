/**
 * PivotTracker
 *
 * Geometry-driven turn detection. Owns the pivot list (extracted once per
 * route from the polyline) and emits a snapshot on every GPS fix:
 *
 *   - direction: "left" | "right" | null  (null = walking straight = "Continue")
 *   - arrived:   true once within DESTINATION_RADIUS_M of the final point
 *   - distanceToNextPivotMeters: distance to the next upcoming pivot, used
 *     for the "In 150 m" countdown above the maneuver text
 *
 * Direction firing rule: if the user is within PIVOT_RADIUS_M of any pivot,
 * use that pivot's direction. No advancement, no hold timer, no polyline-
 * index fallback — the instruction is on iff the user is inside a circle.
 */

import {haversineMeters, type LatLng} from "@/backend/lib/geometry/geometry"
import {extractPivots, type PivotPoint} from "@/backend/lib/geometry/pivots"

const PIVOT_RADIUS_M = 7
const DESTINATION_RADIUS_M = 8

export type PivotSnapshot = {
  /** "left" or "right" if the user is inside any pivot's radius. Null otherwise. */
  direction: "left" | "right" | null
  /** True if user is within DESTINATION_RADIUS_M of the final polyline point. */
  arrived: boolean
  /**
   * Straight-line distance (meters) from user's current position to the next
   * upcoming pivot. Null when no more pivots ahead (final approach) or when
   * we don't have a position yet.
   */
  distanceToNextPivotMeters: number | null
  /** Straight-line distance to the final destination, always populated when active. */
  distanceToDestinationMeters: number | null
  /**
   * Direction of the upcoming pivot ("left"/"right") so the countdown line
   * can read e.g. "In 200 m, turn left". Null when no pivot is ahead.
   */
  nextPivotDirection: "left" | "right" | null
  /**
   * Index of the upcoming pivot in the pivot list. Used by the UI to detect
   * pivot transitions and animate them (so the distance jumping from 162m
   * to 287m looks like a state change, not a glitch). -1 when no pivot ahead.
   */
  nextPivotIndex: number
}

const IDLE_SNAPSHOT: PivotSnapshot = {
  direction: null,
  arrived: false,
  distanceToNextPivotMeters: null,
  distanceToDestinationMeters: null,
  nextPivotDirection: null,
  nextPivotIndex: -1,
}

export class PivotTracker {
  private polyline: LatLng[] = []
  private pivots: PivotPoint[] = []
  private snapshot: PivotSnapshot = IDLE_SNAPSHOT
  private subscribers = new Set<() => void>()
  /**
   * Index of the next pivot to track. We only advance this when the user
   * has physically entered (and then exited) the pivot's PIVOT_RADIUS_M
   * circle. This is sticky on purpose — we never skip ahead based on
   * along-route progress, because that produces erratic distance jumps
   * before the user has reached the turn.
   */
  private cursor = 0
  /** True when the user is currently inside `pivots[cursor]`'s radius. */
  private insidePivot = false

  /** Replace the active route. Recomputes pivots from the polyline. */
  setRoute(polyline: LatLng[], _currentPosition: LatLng | null): void {
    this.polyline = polyline
    this.pivots = extractPivots(polyline)
    this.cursor = 0
    this.insidePivot = false
    console.log(
      "[PivotTracker] setRoute: polyline=",
      polyline.length,
      "pivots=",
      this.pivots.map((p) => `${p.direction}(${p.headingDelta.toFixed(0)}°)`).join(" → "),
    )
    this.commit(IDLE_SNAPSHOT)
  }

  /** Clear all state — called when navigation stops. */
  clear(): void {
    this.polyline = []
    this.pivots = []
    this.cursor = 0
    this.insidePivot = false
    this.commit(IDLE_SNAPSHOT)
  }

  /** Process a GPS fix. */
  onLocationUpdate(position: LatLng, _accuracyMeters: number | undefined): void {
    if (this.polyline.length === 0) {
      this.commit(IDLE_SNAPSHOT)
      return
    }

    // Check destination first.
    const destination = this.polyline[this.polyline.length - 1]
    const distToDest = haversineMeters(position, destination)
    if (distToDest <= DESTINATION_RADIUS_M) {
      this.commit({
        direction: null,
        arrived: true,
        distanceToNextPivotMeters: null,
        distanceToDestinationMeters: distToDest,
        nextPivotDirection: null,
        nextPivotIndex: -1,
      })
      return
    }

    // Sticky-cursor advancement. The "next pivot" is whatever pivot index
    // we're currently focused on. We only advance after the user has
    // entered AND exited the pivot's radius — never based on along-route
    // progress, since that creates spurious jumps when the user happens to
    // be near a polyline point that sits past the pivot.
    if (this.cursor < this.pivots.length) {
      const cur = this.pivots[this.cursor]
      const dCur = haversineMeters(position, {lat: cur.lat, lng: cur.lng})
      if (dCur <= PIVOT_RADIUS_M) {
        this.insidePivot = true
      } else if (this.insidePivot) {
        // Just exited — advance to the next pivot.
        this.cursor++
        this.insidePivot = false
      }
    }

    const nextPivot =
      this.cursor < this.pivots.length ? this.pivots[this.cursor] : null
    const distanceToNextPivotMeters = nextPivot
      ? haversineMeters(position, {lat: nextPivot.lat, lng: nextPivot.lng})
      : null

    const baseSnapshot = {
      arrived: false,
      distanceToNextPivotMeters,
      distanceToDestinationMeters: distToDest,
      nextPivotDirection: nextPivot?.direction ?? null,
      nextPivotIndex: nextPivot ? this.cursor : -1,
    }

    if (this.insidePivot && nextPivot) {
      this.commit({...baseSnapshot, direction: nextPivot.direction})
    } else {
      this.commit({...baseSnapshot, direction: null})
    }
  }

  getSnapshot = (): PivotSnapshot => this.snapshot

  /** Read-only snapshot of the current pivot list. Used by debug overlays. */
  getPivots = (): readonly PivotPoint[] => this.pivots

  subscribe = (fn: () => void): (() => void) => {
    this.subscribers.add(fn)
    return () => {
      this.subscribers.delete(fn)
    }
  }

  private commit(next: PivotSnapshot): void {
    const a = this.snapshot
    if (
      a.direction === next.direction &&
      a.arrived === next.arrived &&
      a.distanceToNextPivotMeters === next.distanceToNextPivotMeters &&
      a.distanceToDestinationMeters === next.distanceToDestinationMeters &&
      a.nextPivotDirection === next.nextPivotDirection &&
      a.nextPivotIndex === next.nextPivotIndex
    ) {
      return
    }
    this.snapshot = next
    for (const fn of this.subscribers) {
      try {
        fn()
      } catch (err) {
        console.error("[PivotTracker] subscriber threw:", err)
      }
    }
  }
}

