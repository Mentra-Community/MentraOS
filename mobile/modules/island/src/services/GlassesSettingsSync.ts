/**
 * Glasses settings sync — island-owned. Keeps the connected glasses in sync with
 * the phone's device settings (`BLUETOOTH_SETTING_KEYS`) over the bluetooth-sdk, so
 * `toolkit.glasses.settings.set()` (and any other settings-store write) reaches the
 * device for ANY host — not just the first-party Mentra app, where this used to live
 * in MantleManager.
 *
 * Two triggers:
 *   1. on change — push the keys that changed.
 *   2. on (re)connect — push the FULL set, so a freshly-connected device gets the
 *      phone's current settings (not just future changes).
 *
 * Started by `toolkit.start()`. Idempotent.
 */
import {shallow} from "zustand/shallow"

import BluetoothSdk from "@mentra/bluetooth-sdk/internal"
import {useSettingsStore} from "../stores/settings"
import {useGlassesStore} from "../stores/glasses"
import {isGlassesConnected} from "./GlassesReadiness"

let unsubChange: (() => void) | null = null
let unsubConnect: (() => void) | null = null

/**
 * Push the FULL current device-settings set to native over the bluetooth-sdk.
 * Used both by the on-connect transition below and as a pre-connect seed by
 * `toolkit.glasses.connectDefault()`, so native has the phone's settings primed
 * before the connect handshake replays them to the glasses.
 */
export async function pushAllBluetoothSettings(): Promise<void> {
  // Returns the native write promise so callers can await the seed before the
  // connect handshake replays settings to the glasses (otherwise the handshake
  // can race ahead and replay stale native settings).
  await BluetoothSdk.updateBluetoothSettings(useSettingsStore.getState().getBluetoothSettings())
}

export function startGlassesSettingsSync(): void {
  if (unsubChange || unsubConnect) return

  // 1. Push only the keys that changed (matching the prior MantleManager sync).
  unsubChange = useSettingsStore.subscribe(
    (state) => state.getBluetoothSettings(),
    (settings: Record<string, unknown>, previous: Record<string, unknown>) => {
      const changed: Record<string, unknown> = {}
      for (const key in settings) {
        if (settings[key] !== previous[key]) changed[key] = settings[key]
      }
      if (Object.keys(changed).length > 0) {
        // Settings can change while the glasses are disconnected — a native
        // rejection must not surface as an unhandled promise rejection.
        void Promise.resolve(BluetoothSdk.updateBluetoothSettings(changed)).catch((error) => {
          console.warn("GlassesSettingsSync: updateBluetoothSettings failed:", error)
        })
      }
    },
    {equalityFn: shallow},
  )

  // 2. Push the full set whenever the glasses transition to connected.
  let wasConnected = isGlassesConnected(useGlassesStore.getState().connection)
  unsubConnect = useGlassesStore.subscribe(() => {
    const connected = isGlassesConnected(useGlassesStore.getState().connection)
    if (connected && !wasConnected) {
      // Background sync: log-and-continue if the device drops right after connect.
      void pushAllBluetoothSettings().catch((error) => {
        console.warn("GlassesSettingsSync: on-connect settings push failed:", error)
      })
    }
    wasConnected = connected
  })
}

export function stopGlassesSettingsSync(): void {
  unsubChange?.()
  unsubConnect?.()
  unsubChange = null
  unsubConnect = null
}
