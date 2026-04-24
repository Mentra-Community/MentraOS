/**
 * @fileoverview NavigationManager — turn-by-turn navigation for miniapps.
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
import {EventManager, UnsubscribeFn} from "./events"

export type NavManeuver = {
  kind: "maneuver"
  instruction: string
  roadName: string
  maneuverType: string
  /** Distance in meters to the next maneuver. -1 if unknown. */
  distanceMeters: number
  /** Road the user will be on after the upcoming maneuver. "" if unknown. */
  towardRoad: string
  /** Categorical type of the maneuver after the next one. "" if unknown. */
  nextManeuverType: string
  /** UI label for the next maneuver, e.g. "Then". "" if no next maneuver. */
  nextManeuverLabel: string
}

export type NavRerouting = {kind: "rerouting"}
export type NavArrived = {kind: "arrived"}
export type NavError = {kind: "error"; message: string}

export type NavUpdate = NavManeuver | NavRerouting | NavArrived | NavError

export class NavigationManager {
  constructor(
    private readonly session: MiniappSession,
    private readonly events: EventManager,
  ) {}

  /**
   * Start a turn-by-turn navigation session to the given coordinates.
   * Returns the phone-side ack — `{ok: true}` means the daemon accepted
   * the request, not that a route was successfully built.
   *
   * Listen via `onUpdate(...)` for the actual nav events.
   */
  async start(coords: {lat: number; lng: number}): Promise<{ok: boolean; error?: string}> {
    const result = await this.session.sendRequest<{ok: boolean; error?: string}>({
      type: MiniappRequestType.NAVIGATION_START,
      lat: coords.lat,
      lng: coords.lng,
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
    return this.events.subscribe(MiniappStreamType.NAVIGATION_UPDATE, (data) => {
      handler(data as NavUpdate)
    })
  }
}
