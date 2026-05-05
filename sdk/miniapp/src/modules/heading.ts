/**
 * @fileoverview HeadingModule — phone compass heading events.
 *
 * Works on both Android and iOS. LOCATION permission must be declared in miniapp.json.
 */

import {MiniappStreamType} from "../protocol"
import {MiniappSession} from "../session"
import type {HeadingData, UnsubscribeFn} from "./events"

export class HeadingModule {
  constructor(private readonly session: MiniappSession) {}

  /** True iff `LOCATION` is declared in the miniapp's manifest. */
  get hasPermission(): boolean {
    return this.session._hasManifestPermission("LOCATION")
  }

  /** Subscribe to continuous compass heading updates. */
  onUpdate(handler: (data: HeadingData) => void): UnsubscribeFn {
    return this.session._subscribe(MiniappStreamType.HEADING_UPDATE, handler as (data: unknown) => void)
  }
}
