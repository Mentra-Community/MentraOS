/**
 * glasses.wifi facade — the first typed island facade over the bluetooth-sdk
 * passthrough, and the reference pattern the rest of the (A) host API copies.
 *
 * A facade wraps the raw `@mentra/bluetooth-sdk` surface into a small, typed,
 * device-agnostic API (the `doX()` action shape here; `getX()`/`onX()` read-models
 * come with domains that own their state). The host UI calls `island.glasses.wifi.*`
 * instead of importing bluetooth-sdk directly — that's the native-import boundary
 * the toolkit is built around.
 *
 * Scope note: this is actions only (`scan`/`connect`/`forget`). The wifi *status*
 * read-model (`status()`/`onStatus()`) is deliberately deferred — it's derived from
 * multiple sources in the glasses connection state (the `wifi_status_change` event
 * *and* legacy connection-info fields), so it lands with the glasses-store migration,
 * not here. `connect()` propagates bluetooth-sdk's coded errors unchanged so callers
 * keep their existing error mapping.
 */
import BluetoothSdk from "@mentra/bluetooth-sdk"
import type {WifiSearchResult} from "@mentra/bluetooth-sdk"

export type {WifiSearchResult}

export const glassesWifi = {
  /** Scan for nearby wifi networks. Request/response — resolves with the results. */
  scan(): Promise<WifiSearchResult[]> {
    return BluetoothSdk.requestWifiScan()
  },

  /**
   * Send wifi credentials to the glasses. Resolves on success; rejects with the
   * bluetooth-sdk coded error (`bluetooth_powered_off`, `request_timeout`, …) on
   * failure, propagated unchanged for the caller to map.
   */
  async connect(ssid: string, password: string): Promise<void> {
    await BluetoothSdk.sendWifiCredentials(ssid, password)
  },

  /** Forget a saved network on the glasses. */
  async forget(ssid: string): Promise<void> {
    await BluetoothSdk.forgetWifiNetwork(ssid)
  },
}
