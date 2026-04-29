/**
 * User
 *
 * Single trip user for the miniapp. Owns the MiniappSession and the
 * managers, plus a tiny reactive store fed by the sensor managers
 * (location, compass, maps).
 *
 *   const user = useUser()
 *
 *   user.coords        // latest GPS — auto re-renders on update
 *   user.heading       // latest compass degrees — auto re-renders
 *   user.mapsReady     // Google Maps JS API loaded? — auto re-renders
 *
 *   user.navigation.start(...)    // imperative — no re-render
 *   user.display.showText(...)
 *
 * Internally: a `version` counter increments on every state change and a
 * Set of subscribers fires. `useUser` (in src/hooks/useUser.ts) plugs
 * that into React via `useSyncExternalStore`, so components see fresh
 * values without anyone calling `useState`.
 */

import {MiniappSession} from "@mentra/miniapp"

import {CompassManager} from "@/backend/session/managers/CompassManager"
import {DisplayManager} from "@/backend/session/managers/DisplayManager"
import {GoogleMapsManager} from "@/backend/session/managers/GoogleMapsManager"
import {LocationManager} from "@/backend/session/managers/LocationManager"
import type {Coords} from "@/backend/session/managers/LocationManager"
import {NavigationManager} from "@/backend/session/managers/navigation/NavigationManager"

export class User {
  private static instance: User | null = null

  readonly session: MiniappSession
  readonly location: LocationManager
  readonly compass: CompassManager
  readonly maps: GoogleMapsManager
  readonly display: DisplayManager
  readonly navigation: NavigationManager

  // ---- reactive snapshot --------------------------------------------------

  /** Latest road-snapped GPS fix. Null until first sample. */
  coords: Coords | null = null
  /** Latest compass heading, degrees (0=N, 90=E). Null until first sample. */
  heading: number | null = null
  /** Google Maps JS API has finished loading. */
  mapsReady = false
  /** Non-null if the Maps JS API failed to load (e.g. missing key). */
  mapsError: string | null = null

  /**
   * Bump on every state change. `useUser` reads this via
   * `useSyncExternalStore.getSnapshot()` so React detects updates.
   */
  private version = 0
  private subscribers: Set<() => void> = new Set()

  private constructor() {
    this.session = new MiniappSession()
    this.session.connect().catch((err) => {
      console.error("[User] session.connect failed:", err)
    })

    this.location = new LocationManager(this.session)
    this.compass = new CompassManager(this.session)
    this.maps = new GoogleMapsManager()
    this.display = new DisplayManager(this.session)
    this.navigation = new NavigationManager(this.session)

    this.wireSensorsToState()
    this.seedInitialFix()
  }

  /**
   * Ask the SDK for a single location fix so the UI has coords to render
   * before the continuous `onUpdate` stream warms up. The streaming
   * subscription automatically supersedes this seed once it fires.
   */
  private seedInitialFix(): void {
    this.location
      .getOnce()
      .then((data) => {
        if (this.coords) return // streaming update got there first
        this.coords = {
          lat: data.lat,
          lng: data.lng,
          accuracy: data.accuracy,
          ts: data.timestamp ?? Date.now(),
        }
        this.notify()
      })
      .catch((err) => {
        console.warn("[User] location.getOnce failed:", err)
      })
  }

  static getInstance(): User {
    if (!User.instance) {
      User.instance = new User()
    }
    return User.instance
  }

  /** Bump version + notify subscribers. */
  private notify(): void {
    this.version += 1
    for (const fn of this.subscribers) {
      try {
        fn()
      } catch (err) {
        console.error("[User] subscriber threw:", err)
      }
    }
  }

  /** React glue — `useSyncExternalStore` calls this. */
  subscribe = (fn: () => void): (() => void) => {
    this.subscribers.add(fn)
    return () => {
      this.subscribers.delete(fn)
    }
  }

  /** React glue — read a stable snapshot key. */
  getSnapshot = (): number => {
    return this.version
  }

  /**
   * Pump every sensor manager into our snapshot. The managers stay thin
   * SDK wrappers — they don't know about reactivity. We subscribe here
   * once and translate updates into version bumps.
   */
  private wireSensorsToState(): void {
    this.location.onUpdate((d) => {
      this.coords = {
        lat: d.lat,
        lng: d.lng,
        accuracy: d.accuracy,
        ts: d.timestamp ?? Date.now(),
      }
      this.notify()
    })

    this.compass.onUpdate((d) => {
      this.heading = d.degrees
      this.notify()
    })

    // Maps loads once on construction; poll its imperative API and
    // notify when it flips.
    if (this.maps.ready || this.maps.error) {
      this.mapsReady = this.maps.ready
      this.mapsError = this.maps.error
    } else {
      this.maps.whenReady().finally(() => {
        this.mapsReady = this.maps.ready
        this.mapsError = this.maps.error
        this.notify()
      })
    }
  }
}
