/**
 * @fileoverview NavigationModule — turn-by-turn navigation for miniapps.
 *
 * The mini app calls `session.navigation.start({lat, lng})` to kick off a
 * trip. Updates stream in via `session.navigation.onUpdate(handler)`.
 *
 * The phone-side daemon (NavigationService → crust → Google Nav SDK) owns
 * the trip lifecycle. The SDK module is a thin pass-through over the
 * bridge.
 *
 * Android only on the phone side. iOS calls return ok=false at the native
 * layer.
 */

import {MiniappRequestType, MiniappStreamType} from "../protocol"
import {MiniappSession} from "../session"
import type {UnsubscribeFn} from "./events"

export type NavManeuver = {
  kind: "maneuver"
  /**
   * Categorical type of the upcoming maneuver. One of: STRAIGHT,
   * SLIGHT_LEFT, SLIGHT_RIGHT, TURN_LEFT, TURN_RIGHT, SHARP_LEFT,
   * SHARP_RIGHT, U_TURN, ARRIVE.
   */
  maneuverType: string
  /** Distance in meters from the user's current position to that maneuver. -1 if unknown. */
  distanceMeters: number
  /**
   * Road the user is currently on, per the Nav SDK's StepInfo. Null if
   * the platform/region doesn't supply a name (e.g. unnamed paths,
   * sidewalks, plazas) or the maneuver was emitted before the first
   * NavInfo arrived.
   */
  fromRoad?: string | null
  /** Road the user will be on after the maneuver. Null in the same cases as `fromRoad`. */
  toRoad?: string | null
}

export type NavRerouting = {kind: "rerouting"}
export type NavArrived = {kind: "arrived"}
export type NavError = {kind: "error"; message: string}

export type NavUpdate = NavManeuver | NavRerouting | NavArrived | NavError

export type NavRoute = {
  points: Array<{lat: number; lng: number}>
}

export type StartNavigationOptions = {
  lat: number
  lng: number
  /** For dev/testing only — fake walking along the route at speedMultiplier×. */
  simulate?: boolean
  speedMultiplier?: number
}

export class NavigationModule {
  constructor(private readonly session: MiniappSession) {}

  /** True iff `LOCATION` is declared in the miniapp's manifest. */
  get hasPermission(): boolean {
    return this.session._hasManifestPermission("LOCATION")
  }

  /**
   * Start a turn-by-turn navigation session to the given coordinates.
   * Returns the phone-side ack — `{ok: true}` means the daemon accepted
   * the request, not that a route was successfully built.
   *
   * Listen via `onUpdate(...)` for the actual nav events.
   */
  async start(coords: StartNavigationOptions): Promise<{ok: boolean; error?: string}> {
    const result = await this.session.sendRequest<{ok: boolean; error?: string}>({
      type: MiniappRequestType.NAVIGATION_START,
      lat: coords.lat,
      lng: coords.lng,
      simulate: coords.simulate ?? false,
      speedMultiplier: coords.speedMultiplier ?? 5,
    })
    return result ?? {ok: false, error: "no response"}
  }

  /** Stop the active navigation session (if any). */
  async stop(): Promise<{ok: boolean; error?: string}> {
    const result = await this.session.sendRequest<{ok: boolean; error?: string}>({
      type: MiniappRequestType.NAVIGATION_STOP,
    })
    return result ?? {ok: false, error: "no response"}
  }

  /**
   * Subscribe to live navigation updates. Returns an unsubscribe function.
   * Maneuvers, rerouting events, arrival, and errors all arrive through
   * this single stream — discriminate by `update.kind`.
   */
  onUpdate(handler: (update: NavUpdate) => void): UnsubscribeFn {
    return this.session._subscribe(MiniappStreamType.NAVIGATION_UPDATE, handler as (data: unknown) => void)
  }

  /**
   * Subscribe to the active route polyline. Fires once per route build —
   * the full path is delivered each time, not a diff. Use this to draw
   * the route on a map.
   */
  onRoute(handler: (route: NavRoute) => void): UnsubscribeFn {
    return this.session._subscribe(MiniappStreamType.NAVIGATION_ROUTE, handler as (data: unknown) => void)
  }
}
