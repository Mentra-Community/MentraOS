/**
 * @fileoverview GlassesModule — device-state events for the glasses themselves.
 *
 * Reports on the glasses hardware: battery level + charging state, connection
 * status (connected/disconnected, model name). The phone has its own battery
 * + connection events on `session.phone`.
 */

import {MiniappRequestType, MiniappStreamType} from "../protocol"
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

  /**
   * Enable or disable Wi-Fi ADB (wireless debugging) on Mentra Live.
   * Persisted on the glasses; boot applies the saved preference (default off).
   */
  async setWifiAdbState(enabled: boolean): Promise<void> {
    await this.session.sendRequest<void>({
      type: MiniappRequestType.SET_WIFI_ADB_STATE,
      enabled,
    })
  }
}
