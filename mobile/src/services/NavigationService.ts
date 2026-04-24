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
  instruction: string
  roadName: string
  maneuverType: string
  distanceMeters: number
  towardRoad: string
  nextManeuverType: string
  nextManeuverLabel: string
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

export type NavState = "idle" | "navigating" | "rerouting" | "arrived"

class NavigationService {
  private static instance: NavigationService | null = null
  private listeners = new Set<NavListener>()
  private locationListeners = new Set<NavLocationListener>()
  private subs: Array<{remove: () => void}> = []
  private state: NavState = "idle"

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
      if (this.listeners.size === 0 && this.locationListeners.size === 0) {
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
      if (this.listeners.size === 0 && this.locationListeners.size === 0) {
        this.detachNativeSubs()
      }
    }
  }

  public async start(coords: {lat: number; lng: number}): Promise<{ok: boolean; error?: string}> {
    console.log(`${LOG_TAG}: start ${coords.lat},${coords.lng}`)
    if (this.subs.length === 0) {
      // Listeners may attach after start(); make sure native subs exist
      // so we don't drop early events.
      this.attachNativeSubs()
    }
    const result = await CrustModule.startNavigation(coords.lat, coords.lng)
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
