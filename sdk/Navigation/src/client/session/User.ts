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

  /** Sensor subscription handles, released in `dispose()`. */
  private sensorUnsubs: Array<() => void> = []
  /** True after `dispose()`; prevents double-teardown. */
  private disposed = false

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

    // Last-chance teardown. Fires on phone-initiated WILL_DISCONNECT and
    // also when this.session.disconnect() runs locally — the SDK emits
    // beforeDisconnect before closing the transport, so any final
    // sendOneShot calls inside dispose() (display.clear, navigation.stop)
    // still reach the host.
    this.session.onBeforeDisconnect((reason) => {
      console.log("[User] beforeDisconnect:", reason, "— running dispose")
      this.dispose()
    })

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
    this.sensorUnsubs.push(
      this.location.onUpdate((d) => {
        this.coords = {
          lat: d.lat,
          lng: d.lng,
          accuracy: d.accuracy,
          ts: d.timestamp ?? Date.now(),
        }
        this.notify()
      }),
    )

    // Throttle compass updates to ~10Hz. The IMU pushes far more
    // frequently than the UI can use, and every notify re-renders every
    // useUser consumer (NavigationPage, NavMap, dev panel...). At 10Hz
    // the cone redraw stays smooth without saturating the main thread
    // during pinch/rotate gestures.
    const HEADING_MIN_INTERVAL_MS = 100
    let lastHeadingNotifyAt = 0
    let pendingHeading: number | null = null
    let pendingTimer: ReturnType<typeof setTimeout> | null = null
    const flushHeading = () => {
      pendingTimer = null
      if (pendingHeading == null) return
      this.heading = pendingHeading
      pendingHeading = null
      lastHeadingNotifyAt = Date.now()
      this.notify()
    }
    this.sensorUnsubs.push(
      this.compass.onUpdate((d) => {
        const now = Date.now()
        const elapsed = now - lastHeadingNotifyAt
        if (elapsed >= HEADING_MIN_INTERVAL_MS) {
          this.heading = d.degrees
          lastHeadingNotifyAt = now
          this.notify()
        } else {
          // Queue the freshest sample to fire when the throttle window
          // closes, so we don't drop the final heading on a fast burst.
          pendingHeading = d.degrees
          if (!pendingTimer) {
            pendingTimer = setTimeout(flushHeading, HEADING_MIN_INTERVAL_MS - elapsed)
          }
        }
      }),
    )
    // Cancel any pending throttle timer on dispose so we don't fire
    // notify() against a torn-down store.
    this.sensorUnsubs.push(() => {
      if (pendingTimer) clearTimeout(pendingTimer)
      pendingTimer = null
      pendingHeading = null
    })

    // Maps loads once on construction; poll its imperative API and
    // notify when it flips.
    if (this.maps.ready || this.maps.error) {
      this.mapsReady = this.maps.ready
      this.mapsError = this.maps.error
    } else {
      this.maps.whenReady().finally(() => {
        if (this.disposed) return
        this.mapsReady = this.maps.ready
        this.mapsError = this.maps.error
        this.notify()
      })
    }
  }

  /**
   * Tear down all session state. Safe to call multiple times. Called
   * when the WebView closes (pagehide / beforeunload) or the user
   * disconnects, so the SDK side doesn't leak subscriptions and the
   * glasses display doesn't stay stuck on whatever we last drew.
   *
   * Order matters: stop navigation BEFORE disconnecting the session,
   * otherwise the stop request never reaches the host.
   */

  
  dispose(): void {
    console.log("[User] dispose called, disposed=", this.disposed)
    if (this.disposed) {
      console.log("[User] dispose early return — already disposed")
      return
    }
    this.disposed = true

    // Stop any active trip. Fire-and-forget — the request is on its way
    // even if we tear down the session before the ack lands.
    try {
      console.log("[User] calling navigation.stop()")
      this.navigation.stop()
    } catch (err) {
      console.warn("[User] navigation.stop threw synchronously:", err)
    }

    // Wipe the glasses display so we don't leave a stale frame.
    try {
      console.log("[User] clearing display during dispose")
      this.display.clear()
    } catch (err) {
      console.warn("[User] display.clear during dispose failed:", err)
    }

    // Release sensor subscriptions.
    for (const unsub of this.sensorUnsubs) {
      try {
        unsub()
      } catch (err) {
        console.warn("[User] sensor unsubscribe threw:", err)
      }
    }
    this.sensorUnsubs = []

    // Drop React subscribers — no further notifies.
    this.subscribers.clear()

    // Tear down the SDK session last.
    try {
      this.session.disconnect()
    } catch (err) {
      console.warn("[User] session.disconnect threw:", err)
    }

    // Reset reactive state and the singleton so a future getInstance()
    // (e.g. after fast-refresh) starts clean.
    this.coords = null
    this.heading = null
    this.mapsReady = false
    this.mapsError = null
    User.instance = null
  }
}


