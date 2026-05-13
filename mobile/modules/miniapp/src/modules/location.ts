/**
 * @fileoverview LocationModule — phone location events.
 *
 * V1 exposes a continuous location-update subscription. The imperative
 * `session.location.getOnce()` poll has wire-protocol support today via
 * MiniappRequestType.LOCATION_POLL but is exercised through the phone's
 * legacy path; promoting it here is future work.
 *
 * LOCATION permission must be declared in miniapp.json for the subscription
 * to succeed; the phone runtime rejects with PERMISSION_NOT_DECLARED
 * otherwise.
 */

import {MiniappStreamType} from "../protocol"
import {MiniappSession} from "../session"
import type {LocationData, UnsubscribeFn} from "./events"

export class LocationModule {
  constructor(private readonly session: MiniappSession) {}

  /** True iff `LOCATION` is declared in the miniapp's manifest. */
  get hasPermission(): boolean {
    return this.session._hasManifestPermission("LOCATION")
  }

  /** Subscribe to continuous location updates. */
  onUpdate(handler: (data: LocationData) => void): UnsubscribeFn {
    return this.session._subscribe(MiniappStreamType.LOCATION_UPDATE, handler as (data: unknown) => void)
  }
}
