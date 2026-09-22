/**
 * Glasses settings sync — engine-owned. Keeps the connected glasses in sync with
 * the phone's device settings (`BLUETOOTH_SETTING_KEYS`) over the bluetooth-sdk, so
 * `engine.glasses.settings.set()` (and any other settings-store write) reaches the
 * device for ANY host — not just the first-party Mentra app, where this used to live
 * in MantleManager.
 *
 * Two triggers:
 *   1. on change — push the keys that changed.
 *   2. on (re)connect — push the FULL set, so a freshly-connected device gets the
 *      phone's current settings (not just future changes).
 *
 * Started by `engine.start()`. Idempotent.
 */
import {shallow} from "zustand/shallow"

import BluetoothSdk from "@mentra/bluetooth-sdk/internal"
import {useSettingsStore, PAIRING_IDENTITY_KEYS} from "../stores/settings"
import {useGlassesStore} from "../stores/glasses"
import {createDebouncedPatchFlusher} from "../utils/debouncedPatch"
import {isGlassesConnected} from "./GlassesReadiness"
import micStateCoordinator from "./MicStateCoordinator"
import {phoneCameraFovCoordinator} from "./PhoneCameraFovCoordinator"

/**
 * Change-pushes are debounced (300ms) and merged so a burst of setSetting
 * calls becomes ONE BLE write (wire v2 keeps BLE JSON small and infrequent).
 * The full on-connect/seed pushes stay direct — callers await their ordering.
 */
const flushBluetoothSettingsPatch = createDebouncedPatchFlusher<Record<string, unknown>>((patch) => {
  // Settings can change while the glasses are disconnected — a native
  // rejection must not surface as an unhandled promise rejection.
  // Apply mic overrides at flush time, not enqueue time: raw PCM can stop
  // during the debounce window and a captured VAD=false would then be stale.
  const runtimePatch = micStateCoordinator.applyRuntimeOverrides(patch)
  void Promise.resolve(BluetoothSdk.updateBluetoothSettings(runtimePatch)).catch((error) => {
    console.warn("GlassesSettingsSync: updateBluetoothSettings failed:", error)
  })
}, 300)

/**
 * The changed-keys diff for the change-push, MINUS the pairing-identity keys.
 * Identity is native-authoritative (promoted on pairing success, cleared on
 * forget, echoed down via save_setting) and reaches native only through the
 * explicit full seeds. Pushing identity from the change subscription would
 * close a feedback loop: native echo → store setSetting → change-push →
 * native apply → echo…, which self-sustains the moment two different values
 * are in flight (e.g. a boot demotion crossing a native promotion) and flaps
 * the pairing UI.
 */
export function diffBluetoothSettingsForPush(
  settings: Record<string, unknown>,
  previous: Record<string, unknown>,
): Record<string, unknown> {
  const changed: Record<string, unknown> = {}
  for (const key in settings) {
    if (PAIRING_IDENTITY_KEYS.includes(key)) continue
    if (settings[key] !== previous[key]) changed[key] = settings[key]
  }
  return changed
}

/** A copy of the settings record without the pairing-identity keys. */
export function stripPairingIdentity(settings: Record<string, unknown>): Record<string, unknown> {
  const stripped: Record<string, unknown> = {}
  for (const key in settings) {
    if (PAIRING_IDENTITY_KEYS.includes(key)) continue
    stripped[key] = settings[key]
  }
  return stripped
}

let unsubChange: (() => void) | null = null
let unsubConnect: (() => void) | null = null

/**
 * Push the FULL current device-settings set — identity included — to native.
 * This is the explicit identity SEED, for the flows where native genuinely
 * needs the phone's persisted identity BEFORE it can act: the device-store
 * hydration at start, the pre-connect seed (connectDefault targets the seeded
 * identity), the post-demotion re-push, and the abandon re-seed.
 */
export async function pushAllBluetoothSettings(): Promise<void> {
  // Returns the native write promise so callers can await the seed before the
  // connect handshake replays settings to the glasses (otherwise the handshake
  // can race ahead and replay stale native settings).
  const settings = useSettingsStore.getState().getBluetoothSettings()
  await BluetoothSdk.updateBluetoothSettings(micStateCoordinator.applyRuntimeOverrides(settings))
}

/**
 * Push the device-settings set MINUS the pairing identity. The on-connect
 * replay uses this: while connected, NATIVE owns the identity (it promotes at
 * device-ready and echoes down), and the JS snapshot can be mid-relay stale —
 * on Mentra Live "connected" lands together with device-ready, and a full
 * replay raced the promotion echoes and overwrote the just-promoted identity
 * with pre-promotion empties (wiping the pairing it had just made).
 */
export async function pushDeviceSettingsOnConnect(): Promise<void> {
  const settings = stripPairingIdentity(useSettingsStore.getState().getBluetoothSettings())
  await BluetoothSdk.updateBluetoothSettings(micStateCoordinator.applyRuntimeOverrides(settings))
}

export function startGlassesSettingsSync(): void {
  if (unsubChange || unsubConnect) return

  // 1. Push only the keys that changed (matching the prior MantleManager sync).
  // Pairing identity is excluded — see diffBluetoothSettingsForPush.
  unsubChange = useSettingsStore.subscribe(
    (state) => state.getBluetoothSettings(),
    (settings: Record<string, unknown>, previous: Record<string, unknown>) => {
      const changed = diffBluetoothSettingsForPush(settings, previous)
      if (Object.keys(changed).length > 0) {
        flushBluetoothSettingsPatch(changed)
      }
    },
    {equalityFn: shallow},
  )

  // 2. Push the device settings whenever the glasses transition to connected —
  // identity EXCLUDED: native owns the identity it just promoted, and a full
  // replay here raced the promotion echoes (see pushDeviceSettingsOnConnect).
  let wasConnected = isGlassesConnected(useGlassesStore.getState().connection)
  unsubConnect = useGlassesStore.subscribe(() => {
    const connected = isGlassesConnected(useGlassesStore.getState().connection)
    if (connected && !wasConnected) {
      // Background sync: log-and-continue if the device drops right after connect.
      void pushDeviceSettingsOnConnect()
        .catch((error) => {
          console.warn("GlassesSettingsSync: on-connect settings push failed:", error)
        })
        .finally(() => {
          // That push replays the persistent camera_fov, which stomps whatever
          // override a miniapp currently owns. Re-assert after it either way:
          // a failed push may still have written some keys.
          void phoneCameraFovCoordinator.reapplyEffectiveOverride().catch((error) => {
            console.warn("GlassesSettingsSync: camera FOV re-apply failed:", error)
          })
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
