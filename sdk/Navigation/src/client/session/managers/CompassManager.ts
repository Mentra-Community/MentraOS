/**
 * CompassManager
 *
 * Thin wrapper over `session.heading.onUpdate`. Same shape as the SDK's
 * heading module — callers do `user.compass.onUpdate(handler)` and own
 * their state.
 */

import type {HeadingData, MiniappSession} from "@mentra/miniapp"

export type CompassListener = (data: HeadingData) => void
export type Unsubscribe = () => void

export class CompassManager {
  constructor(private readonly session: MiniappSession) {}

  /** Subscribe to continuous compass-heading updates. */
  onUpdate(handler: CompassListener): Unsubscribe {
    return this.session.heading.onUpdate(handler)
  }
}
