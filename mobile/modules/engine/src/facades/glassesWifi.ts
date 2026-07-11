/**
 * glasses.wifi facade — the first typed engine facade over the bluetooth-sdk
 * passthrough, and the reference pattern the rest of the (A) host API copies.
 *
 * A facade wraps the raw `@mentra/bluetooth-sdk` surface into a small, typed,
 * device-agnostic API (the `doX()` action shape here; `getX()`/`onX()` read-models
 * come with domains that own their state). The host UI calls `engine.glasses.wifi.*`
 * instead of importing bluetooth-sdk directly — that's the native-import boundary
 * the engine is built around.
 *
 * `connect()` propagates bluetooth-sdk's coded errors unchanged so callers keep
 * their existing error mapping. The `status()`/`onStatus()` read-model reads the
 * glasses-state store engine now owns (wifi status is derived there from the
 * device's connection info).
 */
import BluetoothSdk from "@mentra/bluetooth-sdk"
import type {WifiSearchResult, WifiStatus} from "@mentra/bluetooth-sdk"
import {useGlassesStore} from "../stores/glasses"

export type {WifiSearchResult, WifiStatus}

export const glassesWifi = {
  /** Scan for nearby wifi networks. Request/response — resolves with the results. */
  scan(): Promise<WifiSearchResult[]> {
    return BluetoothSdk.requestWifiScan()
  },

  /**
   * Subscribe to streamed scan results: the glasses report networks one by one
   * while a scan runs, so callers can render them as they arrive instead of
   * waiting for the final `scan()` result. Returns an unsubscribe.
   */
  onScanResult(cb: (networks: WifiSearchResult[]) => void): () => void {
    const sub = BluetoothSdk.addListener("wifi_scan_result", (event) => {
      cb(event.networks)
    })
    return () => sub.remove()
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

  /** The glasses' current wifi connection status (snapshot). */
  status(): WifiStatus {
    // Copy: the snapshot must not hand callers a mutable reference into the store.
    return {...useGlassesStore.getState().wifi}
  },

  /** Subscribe to wifi-status changes (current, previous); returns an unsubscribe. */
  onStatus(cb: (status: WifiStatus, previous: WifiStatus) => void): () => void {
    // Copy: like status(), never publish the store's live wifi objects to listeners.
    return useGlassesStore.subscribe(
      (s) => s.wifi,
      (wifi, previous) => cb({...wifi}, {...previous}),
    )
  },
}
