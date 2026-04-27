/**
 * NavigationService
 *
 * Thin singleton wrapper around the native Google Navigation SDK exposed
 * by the `crust` Expo module.
 *
 * Mini apps will eventually subscribe through the mini app SDK, which
 * routes via LocalMiniappRuntime and ultimately calls into here. For now,
 * this is also called directly by the developer-settings test button.
 *
 * Android only. iOS calls return ok=false at the native layer.
 */

import CrustModule from "crust"

const LOG_TAG = "NAV_SERVICE"

export type NavManeuver = {
  kind: "maneuver"
  /**
   * Categorical type of the upcoming maneuver. One of: STRAIGHT,
   * SLIGHT_LEFT, SLIGHT_RIGHT, TURN_LEFT, TURN_RIGHT, SHARP_LEFT,
   * SHARP_RIGHT, U_TURN, ARRIVE.
   */
  maneuverType: string
  distanceMeters: number
  /** Road the user is currently on. Null if the SDK didn't supply one. */
  fromRoad?: string | null
  /** Road the user will be on after the maneuver. Null if the SDK didn't supply one. */
  toRoad?: string | null
}

export type NavRerouting = {kind: "rerouting"}
export type NavArrived = {kind: "arrived"}
export type NavError = {kind: "error"; message: string}

export type NavUpdate = NavManeuver | NavRerouting | NavArrived | NavError

export type NavListener = (update: NavUpdate) => void

export type NavLocation = {
  lat: number
  lng: number
  accuracy: number | null
  timestamp: number
}
export type NavLocationListener = (loc: NavLocation) => void

export type NavRoute = {points: Array<{lat: number; lng: number}>}
export type NavRouteListener = (route: NavRoute) => void

export type NavState = "idle" | "navigating" | "rerouting" | "arrived"

class NavigationService {
  private static instance: NavigationService | null = null
  private listeners = new Set<NavListener>()
  private locationListeners = new Set<NavLocationListener>()
  private routeListeners = new Set<NavRouteListener>()
  private subs: Array<{remove: () => void}> = []
  private state: NavState = "idle"
  /** Last emitted route — replayed to late subscribers so they get the
   *  current geometry immediately. */
  private lastRoute: NavRoute | null = null

  private constructor() {}

  public static getInstance(): NavigationService {
    if (!NavigationService.instance) {
      NavigationService.instance = new NavigationService()
    }
    return NavigationService.instance
  }

  public getState(): NavState {
    return this.state
  }

  public addListener(listener: NavListener): () => void {
    this.listeners.add(listener)
    if (this.subs.length === 0) {
      this.attachNativeSubs()
    }
    return () => {
      this.listeners.delete(listener)
      if (this.noListeners()) {
        this.detachNativeSubs()
      }
    }
  }

  /**
   * Subscribe to the Google Nav SDK's road-snapped location stream. Only
   * fires while a nav session is active. Returns an unsubscribe fn.
   */
  public addLocationListener(listener: NavLocationListener): () => void {
    this.locationListeners.add(listener)
    if (this.subs.length === 0) {
      this.attachNativeSubs()
    }
    return () => {
      this.locationListeners.delete(listener)
      if (this.noListeners()) {
        this.detachNativeSubs()
      }
    }
  }

  /**
   * Subscribe to the active route's polyline. Fires once per route build
   * (initial + after every reroute). Late subscribers get the current
   * route replayed on subscribe so the UI can render immediately.
   */
  public addRouteListener(listener: NavRouteListener): () => void {
    this.routeListeners.add(listener)
    if (this.subs.length === 0) {
      this.attachNativeSubs()
    }
    if (this.lastRoute) {
      try {
        listener(this.lastRoute)
      } catch (err) {
        console.error(`${LOG_TAG}: route listener threw on replay`, err)
      }
    }
    return () => {
      this.routeListeners.delete(listener)
      if (this.noListeners()) {
        this.detachNativeSubs()
      }
    }
  }

  private noListeners(): boolean {
    return (
      this.listeners.size === 0 &&
      this.locationListeners.size === 0 &&
      this.routeListeners.size === 0
    )
  }

  public async start(
    coords: {lat: number; lng: number},
    options?: {simulate?: boolean; speedMultiplier?: number},
  ): Promise<{ok: boolean; error?: string}> {
    console.log(
      `${LOG_TAG}: start ${coords.lat},${coords.lng} sim=${options?.simulate ?? false} speed=${options?.speedMultiplier ?? 5}`,
    )
    if (this.subs.length === 0) {
      // Listeners may attach after start(); make sure native subs exist
      // so we don't drop early events.
      this.attachNativeSubs()
    }
    const result = await CrustModule.startNavigation(coords.lat, coords.lng, {
      simulate: options?.simulate ?? false,
      speedMultiplier: options?.speedMultiplier ?? 5,
    })
    if (!result.ok) {
      console.warn(`${LOG_TAG}: start failed — ${result.error}`)
      this.state = "idle"
    } else {
      this.state = "navigating"
    }
    return result
  }

  public async stop(): Promise<{ok: boolean; error?: string}> {
    console.log(`${LOG_TAG}: stop`)
    const result = await CrustModule.stopNavigation()
    this.state = "idle"
    this.lastRoute = null
    return result
  }

  private attachNativeSubs(): void {
    console.log(`${LOG_TAG}: attachNativeSubs() — listeners=${this.listeners.size}`)
    this.subs.push(
      CrustModule.addListener("onNavManeuver", (data) => {
        console.log(`${LOG_TAG}: ← onNavManeuver`, JSON.stringify(data))
        this.state = "navigating"
        this.fanout({kind: "maneuver", ...data})
      }),
      CrustModule.addListener("onNavRerouting", () => {
        console.log(`${LOG_TAG}: ← onNavRerouting`)
        this.state = "rerouting"
        this.fanout({kind: "rerouting"})
      }),
      CrustModule.addListener("onNavArrived", () => {
        console.log(`${LOG_TAG}: ← onNavArrived`)
        this.state = "arrived"
        this.fanout({kind: "arrived"})
      }),
      CrustModule.addListener("onNavError", (data) => {
        console.log(`${LOG_TAG}: ← onNavError`, data?.message)
        this.fanout({kind: "error", message: data.message})
      }),
      CrustModule.addListener("onNavLocation", (data) => {
        const loc: NavLocation = {
          lat: data.lat,
          lng: data.lng,
          accuracy: data.accuracy ?? null,
          timestamp: data.timestamp,
        }
        this.locationListeners.forEach((l) => {
          try {
            l(loc)
          } catch (err) {
            console.error(`${LOG_TAG}: location listener threw`, err)
          }
        })
      }),
      CrustModule.addListener("onNavRoute", (data) => {
        const route: NavRoute = {points: data.points ?? []}
        this.lastRoute = route
        console.log(`${LOG_TAG}: ← onNavRoute (${route.points.length} points)`)
        this.routeListeners.forEach((l) => {
          try {
            l(route)
          } catch (err) {
            console.error(`${LOG_TAG}: route listener threw`, err)
          }
        })
      }),
    )
  }

  private detachNativeSubs(): void {
    this.subs.forEach((s) => s.remove())
    this.subs = []
  }

  private fanout(update: NavUpdate): void {
    this.listeners.forEach((l) => {
      try {
        l(update)
      } catch (err) {
        console.error(`${LOG_TAG}: listener threw`, err)
      }
    })
  }
}

const navigationService = NavigationService.getInstance()
export default navigationService
