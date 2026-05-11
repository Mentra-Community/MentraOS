/**
 * NavigationManager
 *
 * Thin wrapper over `session.navigation.*`. Mirrors the SDK module shape:
 * imperative methods (start/stop/deviate) and subscribe-style listeners
 * (onUpdate/onRoute). Callers manage their own state.
 */

import type {
  ComputeRouteOptions,
  ComputeRouteResult,
  MiniappSession,
  NavRoute,
  NavState,
  NavUpdate,
  Pivot,
  PivotEvent,
  StartNavigationOptions,
} from "@mentra/miniapp"

import {ManeuverFormatter} from "@/backend/session/managers/navigation/ManeuverFormatter"

export type NavUpdateListener = (update: NavUpdate) => void
export type NavRouteListener = (route: NavRoute) => void
export type PivotListener = (event: PivotEvent) => void
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

  /**
   * Trigger the Google Nav SDK Terms & Conditions dialog. Idempotent and
   * intended to be called eagerly on mount so `start()` is friction-free.
   */
  requestPermission(): Promise<{ok: boolean; accepted: boolean; error?: string}> {
    return this.session.navigation.requestPermission()
  }

  /** Begin a turn-by-turn trip. */
  start(opts: StartNavigationOptions): Promise<{ok: boolean; error?: string}> {
    return this.session.navigation.start(opts)
  }

  /** Stop the active trip (if any). Fire-and-forget. */
  stop(): void {
    this.session.navigation.stop()
  }

  /**
   * Dev-only: nudge the simulator off-route to verify rerouting. Defaults
   * to ~20m perpendicular to the current heading. Android sim only.
   * Fire-and-forget.
   */
  deviate(offsetMeters: number = 20): void {
    this.session.navigation.deviate(offsetMeters)
  }

  /** Subscribe to maneuver / rerouting / arrived / error events. */
  onUpdate(handler: NavUpdateListener): Unsubscribe {
    return this.session.navigation.onUpdate(handler)
  }

  /** Subscribe to the route polyline (full path each time it's rebuilt). */
  onRoute(handler: NavRouteListener): Unsubscribe {
    return this.session.navigation.onRoute(handler)
  }

  /**
   * Snapshot of the active trip; null when no trip is running. Use on
   * mount to hydrate state for a miniapp opening mid-trip.
   */
  getState(): Promise<NavState | null> {
    return this.session.navigation.getState()
  }

  /** Compute one or more routes without starting a trip. */
  computeRoute(opts: ComputeRouteOptions): Promise<ComputeRouteResult> {
    return this.session.navigation.computeRoute(opts)
  }

  /** Subscribe to pivot events (approaching / entered / exited). */
  onPivot(handler: PivotListener): Unsubscribe {
    return this.session.navigation.onPivot(handler)
  }

  /** Full pivot list for the active route. */
  getPivots(): Pivot[] {
    return this.session.navigation.getPivots()
  }

  /** Pivot the user is currently inside the radius of, or null. */
  getActivePivot(): Pivot | null {
    return this.session.navigation.getActivePivot()
  }

  /** Next pivot ahead, or null when past the final pivot. */
  getUpcomingPivot(): Pivot | null {
    return this.session.navigation.getUpcomingPivot()
  }
}
