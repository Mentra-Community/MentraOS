/**
 * NavigationManager
 *
 * Thin wrapper over `session.navigation.*`. Mirrors the SDK module shape:
 * imperative methods (start/stop/deviate) and subscribe-style listeners
 * (onUpdate/onRoute). Callers manage their own state.
 */

import type {
  MiniappSession,
  NavRoute,
  NavUpdate,
  StartNavigationOptions,
} from "@mentra/miniapp"

import {ManeuverFormatter} from "@/backend/session/managers/navigation/ManeuverFormatter"

export type NavUpdateListener = (update: NavUpdate) => void
export type NavRouteListener = (route: NavRoute) => void
export type Unsubscribe = () => void

export class NavigationManager {
  /**
   * Presentation helpers for `NavManeuver` data — glyphs, arrows, human
   * verbs, headlines, glasses lines. Lives here so all maneuver-related
   * stuff is reachable via `user.navigation.format.*`.
   */
  readonly format = new ManeuverFormatter()

  constructor(private readonly session: MiniappSession) {}

  /** True iff `LOCATION` is declared in the miniapp's manifest. */
  get hasPermission(): boolean {
    return this.session.navigation.hasPermission
  }

  /** Begin a turn-by-turn trip. */
  start(opts: StartNavigationOptions): Promise<{ok: boolean; error?: string}> {
    return this.session.navigation.start(opts)
  }

  /** Stop the active trip (if any). */
  stop(): Promise<{ok: boolean; error?: string}> {
    return this.session.navigation.stop()
  }

  /**
   * Dev-only: nudge the simulator off-route to verify rerouting. Defaults
   * to ~20m perpendicular to the current heading. Android sim only.
   */
  deviate(offsetMeters: number = 20): Promise<{ok: boolean; error?: string}> {
    return this.session.navigation.deviate(offsetMeters)
  }

  /** Subscribe to maneuver / rerouting / arrived / error events. */
  onUpdate(handler: NavUpdateListener): Unsubscribe {
    return this.session.navigation.onUpdate(handler)
  }

  /** Subscribe to the route polyline (full path each time it's rebuilt). */
  onRoute(handler: NavRouteListener): Unsubscribe {
    return this.session.navigation.onRoute(handler)
  }
}
