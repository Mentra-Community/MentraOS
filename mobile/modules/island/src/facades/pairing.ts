/**
 * pairing facade — `toolkit.pairing`: scan for nearby glasses + pair. Scan state
 * (searching + results) comes from the island core store; scan/connect go over the
 * bluetooth-sdk; pair-failure / not-ready are the bluetooth-sdk events.
 *
 * (Connect-the-already-paired-default is `toolkit.glasses.connectDefault()`; this
 * facade is the first-time discovery + pair flow.)
 */
import BluetoothSdk from "@mentra/bluetooth-sdk"
import type {PairFailureEvent, GlassesNotReadyEvent} from "@mentra/bluetooth-sdk"
import {useCoreStore} from "../stores/core"

export const pairing = {
  /** Start scanning for nearby glasses. Results land on `searchResults()`/`onFound()`. */
  scan: (...args: Parameters<typeof BluetoothSdk.startScan>) => BluetoothSdk.startScan(...args),
  /** Whether a scan is currently in progress. */
  scanning: (): boolean => useCoreStore.getState().searching,
  /** The current scan results (snapshot). */
  searchResults: () => useCoreStore.getState().searchResults,
  /** Subscribe to scan-result changes; fires only when they change. Returns an unsubscribe. */
  onFound: (cb: (results: ReturnType<typeof useCoreStore.getState>["searchResults"]) => void): (() => void) => {
    let last = JSON.stringify(useCoreStore.getState().searchResults)
    return useCoreStore.subscribe(() => {
      const results = useCoreStore.getState().searchResults
      const key = JSON.stringify(results)
      if (key === last) return
      last = key
      cb(results)
    })
  },

  /** Pair with (connect to) a discovered device. */
  pair: (...args: Parameters<typeof BluetoothSdk.connect>) => BluetoothSdk.connect(...args),
  /** Set a device as the default for subsequent `glasses.connectDefault()`. */
  setDefault: (...args: Parameters<typeof BluetoothSdk.setDefaultDevice>) => BluetoothSdk.setDefaultDevice(...args),

  /** Subscribe to pairing failures; returns an unsubscribe. */
  onPairFailure: (cb: (event: PairFailureEvent) => void): (() => void) => {
    const sub = BluetoothSdk.addListener("pair_failure", cb)
    return () => sub.remove()
  },
  /** Subscribe to glasses-not-ready events during pairing; returns an unsubscribe. */
  onGlassesNotReady: (cb: (event: GlassesNotReadyEvent) => void): (() => void) => {
    const sub = BluetoothSdk.addListener("glasses_not_ready", cb)
    return () => sub.remove()
  },
}
