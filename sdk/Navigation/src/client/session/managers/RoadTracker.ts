/**
 * RoadTracker — fallback road-name source.
 *
 * The Google Nav SDK is authoritative for road names whenever it has
 * one (NavManeuver.fromRoad, derived host-side from StepInfo). But it
 * regularly returns null/blank — at trip start before the first step
 * rolls, on smaller streets where the SDK has no name, and briefly
 * after turns. This tracker reverse-geocodes the user's GPS so the UI
 * always has a road name to show, used ONLY as a fallback when the
 * SDK's value is missing.
 *
 * Deliberately simple — no bearing filtering, no stickiness, no
 * post-turn bypass, no seen-roads bookkeeping. Earlier versions had
 * all of that because we used the geocoder as the primary source and
 * had to fight intersection ambiguity. As a fallback we don't: the
 * SDK handles the precise transitions, we just paper over its null
 * gaps.
 *
 * Pipeline:
 *   1. onLocationUpdate(coords) — capture latest GPS.
 *   2. Debounce: only fire if user moved >MOVE_THRESHOLD_M from the
 *      last lookup AND DEBOUNCE_MS has elapsed.
 *   3. Reverse-geocode and take the first `route` result. If none,
 *      fall back to neighborhood. If neither, leave snapshot as-is.
 */

import {haversineMeters, type LatLng} from "@/backend/lib/geometry/geometry"
import type {GoogleMapsManager} from "@/backend/session/managers/GoogleMapsManager"

const DEBOUNCE_MS = 3000
const MOVE_THRESHOLD_M = 15
const FETCH_TIMEOUT_MS = 1500

export type RoadSnapshot = {
  /** Geocoded road name. Null when never resolved. */
  road: string | null
}

const IDLE_SNAPSHOT: RoadSnapshot = {road: null}

export class RoadTracker {
  private snapshot: RoadSnapshot = IDLE_SNAPSHOT
  private subscribers = new Set<() => void>()

  private lastFetchPosition: LatLng | null = null
  private lastFetchAt = 0
  private pendingPosition: LatLng | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly maps: GoogleMapsManager) {}

  getSnapshot = (): RoadSnapshot => this.snapshot

  subscribe = (fn: () => void): (() => void) => {
    this.subscribers.add(fn)
    return () => {
      this.subscribers.delete(fn)
    }
  }

  onLocationUpdate(position: LatLng): void {
    this.pendingPosition = position
    this.scheduleFetch()
  }

  clear(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    this.lastFetchPosition = null
    this.lastFetchAt = 0
    this.pendingPosition = null
    this.commit(IDLE_SNAPSHOT)
  }

  private scheduleFetch(): void {
    if (!this.pendingPosition) return

    if (this.lastFetchPosition) {
      const moved = haversineMeters(this.lastFetchPosition, this.pendingPosition)
      if (moved < MOVE_THRESHOLD_M) return
    }

    if (this.debounceTimer) return

    const elapsed = Date.now() - this.lastFetchAt
    const wait = Math.max(0, DEBOUNCE_MS - elapsed)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.runFetch()
    }, wait)
  }

  private async runFetch(): Promise<void> {
    const position = this.pendingPosition
    if (!position) return
    const apiKey = this.maps.apiKey
    if (!apiKey) return

    this.lastFetchAt = Date.now()

    try {
      const url =
        `https://maps.googleapis.com/maps/api/geocode/json` +
        `?latlng=${position.lat},${position.lng}` +
        `&key=${encodeURIComponent(apiKey)}`
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
      let res: Response
      try {
        res = await fetch(url, {signal: ctrl.signal})
      } finally {
        clearTimeout(timer)
      }
      if (!res.ok) throw new Error(`geocode HTTP ${res.status}`)
      const json: any = await res.json()
      const road = pickRoad(json?.results ?? [])

      this.lastFetchPosition = position
      if (road && road !== this.snapshot.road) {
        this.commit({road})
      }
    } catch {
      // Network error / timeout / rate limit — hold the previous value.
    }
  }

  private commit(next: RoadSnapshot): void {
    if (this.snapshot.road === next.road) return
    this.snapshot = next
    for (const fn of this.subscribers) {
      try {
        fn()
      } catch (err) {
        console.error("[RoadTracker] subscriber threw:", err)
      }
    }
  }
}

function pickRoad(results: any[]): string | null {
  for (const r of results) {
    const route = (r.address_components ?? []).find((c: any) =>
      c.types?.includes("route"),
    )
    if (route?.long_name) return route.long_name
  }
  for (const r of results) {
    const nb = (r.address_components ?? []).find((c: any) =>
      c.types?.includes("neighborhood"),
    )
    if (nb?.long_name) return nb.long_name
  }
  return null
}
