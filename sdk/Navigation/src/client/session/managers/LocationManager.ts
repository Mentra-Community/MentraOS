/**
 * LocationManager
 *
 * Thin wrapper over `session.location.onUpdate`. Mirrors the shape of the
 * SDK's `LocationModule` (sdk/miniapp/src/modules/location.ts) — the User
 * holds an instance, callers do `user.location.onUpdate(handler)` and
 * manage their own state.
 */

import type {LocationData, MiniappSession} from "@mentra/miniapp"

export type Coords = {lat: number; lng: number; accuracy?: number; ts: number}

export type LocationListener = (data: LocationData) => void
export type Unsubscribe = () => void

export class LocationManager {
  constructor(private readonly session: MiniappSession) {}

  /** Subscribe to continuous location updates. */
  onUpdate(handler: LocationListener): Unsubscribe {
    return this.session.location.onUpdate(handler)
  }

  /** Request a single location fix. Useful at app load to seed UI. */
  getOnce(): Promise<LocationData> {
    return this.session.location.getOnce()
  }
}
