/**
 * PivotTracker
 *
 * The simplest possible turn-instruction logic:
 *   - Pre-compute a list of turn pivots from the route polyline (geometry).
 *   - On every GPS fix, check if the user is inside ANY pivot's radius.
 *     - If yes  → snapshot.direction = that pivot's direction (left/right).
 *     - If no   → snapshot.direction = null  (the UI shows "Continue").
 *
 * No advancement, no hold timers, no polyline-index fallback. The instruction
 * is on iff the user is inside a circle, off otherwise.
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
}

const IDLE_SNAPSHOT: PivotSnapshot = {direction: null, arrived: false}

export class PivotTracker {
  private polyline: LatLng[] = []
  private pivots: PivotPoint[] = []
  private snapshot: PivotSnapshot = IDLE_SNAPSHOT
  private subscribers = new Set<() => void>()

  /** Replace the active route. Recomputes pivots from the polyline. */
  setRoute(polyline: LatLng[], _currentPosition: LatLng | null): void {
    this.polyline = polyline
    this.pivots = extractPivots(polyline)
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
      this.commit({direction: null, arrived: true})
      return
    }

    // Find the closest pivot. If we're inside its circle → show its direction.
    let closestPivot: PivotPoint | null = null
    let closestDist = Infinity
    for (const p of this.pivots) {
      const d = haversineMeters(position, {lat: p.lat, lng: p.lng})
      if (d < closestDist) {
        closestDist = d
        closestPivot = p
      }
    }

    if (closestPivot && closestDist <= PIVOT_RADIUS_M) {
      this.commit({direction: closestPivot.direction, arrived: false})
    } else {
      this.commit({direction: null, arrived: false})
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
    if (this.snapshot.direction === next.direction && this.snapshot.arrived === next.arrived) return
    this.snapshot = next
    console.log(`[PivotTracker] direction=${next.direction ?? "-"} arrived=${next.arrived}`)
    for (const fn of this.subscribers) {
      try {
        fn()
      } catch (err) {
        console.error("[PivotTracker] subscriber threw:", err)
      }
    }
  }
}
