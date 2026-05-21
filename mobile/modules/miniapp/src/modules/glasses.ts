/**
 * @fileoverview GlassesModule — device-state events for the glasses themselves.
 *
 * Reports on the glasses hardware: battery level + charging state, connection
 * status (connected/disconnected, model name). The phone has its own battery
 * + connection events on `session.phone`.
 */

import {MiniappStreamType} from "../protocol"
import {MiniappSession} from "../session"
import type {BatteryData, ConnectionData, UnsubscribeFn} from "./events"

export class GlassesModule {
  constructor(private readonly session: MiniappSession) {}

  onBattery(handler: (data: BatteryData) => void): UnsubscribeFn {
    return this.session._subscribe(MiniappStreamType.GLASSES_BATTERY, handler as (data: unknown) => void)
  }

  onConnection(handler: (data: ConnectionData) => void): UnsubscribeFn {
    return this.session._subscribe(MiniappStreamType.GLASSES_CONNECTION, handler as (data: unknown) => void)
  }
}
