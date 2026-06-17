/**
 * Glasses settings sync — island-owned. Pushes `BLUETOOTH_SETTING_KEYS` changes to
 * the connected glasses over the bluetooth-sdk, so `toolkit.glasses.settings.set()`
 * (and any other settings-store write) actually reaches the device for ANY host —
 * not just the first-party Mentra app, where this used to live in MantleManager.
 *
 * Started by `toolkit.start()`. Idempotent.
 */
import {shallow} from "zustand/shallow"

import BluetoothSdk from "../../../bluetooth-sdk/build/_internal"
import {useSettingsStore} from "../stores/settings"

let unsubscribe: (() => void) | null = null

export function startGlassesSettingsSync(): void {
  if (unsubscribe) return
  unsubscribe = useSettingsStore.subscribe(
    (state) => state.getBluetoothSettings(),
    (settings: Record<string, unknown>, previous: Record<string, unknown>) => {
      // Push only the keys that changed (matching the prior MantleManager sync).
      const changed: Record<string, unknown> = {}
      for (const key in settings) {
        if (settings[key] !== previous[key]) changed[key] = settings[key]
      }
      if (Object.keys(changed).length > 0) {
        BluetoothSdk.updateBluetoothSettings(changed)
      }
    },
    {equalityFn: shallow},
  )
}

export function stopGlassesSettingsSync(): void {
  unsubscribe?.()
  unsubscribe = null
}
