/**
 * @fileoverview GlassesModule — device-state events for the glasses themselves.
 *
 * Reports on the glasses hardware: battery level + charging state, connection
 * status (connected/disconnected, model name). The phone has its own battery
 * + connection events on `session.phone`.
 */

import {MiniappRequestType, MiniappStreamType} from "../protocol"
import {MiniappSession} from "../session"
import type {BatteryData, ConnectionData, UnsubscribeFn, WifiData} from "./events"

export class GlassesModule {
  constructor(private readonly session: MiniappSession) {}

  onBattery(handler: (data: BatteryData) => void): UnsubscribeFn {
    return this.session._subscribe(MiniappStreamType.GLASSES_BATTERY, handler as (data: unknown) => void)
  }

  onConnection(handler: (data: ConnectionData) => void): UnsubscribeFn {
    return this.session._subscribe(MiniappStreamType.GLASSES_CONNECTION, handler as (data: unknown) => void)
  }

  /**
   * Subscribe to glasses Wi-Fi state. Fires the current state on subscribe and
   * on every change. `connected` is false on glasses without Wi-Fi. Streaming
   * requires Wi-Fi — pair this with {@link requestWifiSetup} to prompt the user.
   */
  onWifi(handler: (data: WifiData) => void): UnsubscribeFn {
    return this.session._subscribe(MiniappStreamType.GLASSES_WIFI, handler as (data: unknown) => void)
  }

  /**
   * Ask the host to open the glasses Wi-Fi setup flow on the phone. Mirrors the
   * cloud SDK's `session.requestWifiSetup(reason)`. `reason` is a user-facing
   * line shown in the setup prompt (e.g. "Streaming needs your glasses on Wi-Fi").
   */
  async requestWifiSetup(reason?: string): Promise<void> {
    await this.session.sendRequest<void>({
      type: MiniappRequestType.REQUEST_WIFI_SETUP,
      reason,
    })
  }

  /**
   * Enable or disable Wi-Fi ADB (wireless debugging) on Mentra Live.
   * Persisted on the glasses; boot applies the saved preference (default off).
   *
   * SYSTEM-only — rejects with `NOT_PERMITTED` unless this miniapp is a system
   * app. Third-party miniapps must not expose wireless debugging controls.
   */
  async setWifiAdbState(enabled: boolean): Promise<void> {
    await this.session.sendRequest<void>({
      type: MiniappRequestType.SET_WIFI_ADB_STATE,
      enabled,
    })
  }
}
