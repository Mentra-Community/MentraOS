/**
 * DeviceStoreHydration — the cold-start contract for the native DeviceStore.
 *
 * The Bluetooth SDK's DeviceStore is in-memory on BOTH platforms: every key
 * (including the pairing identity `default_wearable` / `device_name` /
 * `device_address`) initializes to "" at process start and only becomes real
 * once JS pushes the persisted settings over `updateBluetoothSettings`. Until
 * that seed lands, `BluetoothSdk.getDefaultDevice()` returns null for
 * genuinely-paired users — the false "absent" that made the first
 * hasDefaultDevice guard misfire at cold start (see the revert of the
 * hasDefaultDevice pairing-route guards).
 *
 * This service makes that seed an explicit, awaited initialization step:
 *   1. load the persisted settings store (idempotent),
 *   2. push the full Bluetooth settings set (identity included) to native.
 * `toolkit.start()` awaits it, so every post-start `getDefaultDevice()` read is
 * a trustworthy two-state answer. `hasDefaultDevice()` also awaits it
 * internally (belt-and-suspenders for reads that race start()).
 *
 * Failure surfaces as a REJECTION — never a false "absent". Callers guarding
 * destructive or routing decisions must fail open (treat as "has a device"),
 * matching the foreground-reconnect pattern.
 */
import BluetoothSdk from "@mentra/bluetooth-sdk/internal"
import {useSettingsStore, SETTINGS} from "../stores/settings"
import {useGlassesStore} from "../stores/glasses"
import {pushAllBluetoothSettings} from "./GlassesSettingsSync"
import {DeviceTypes} from "../types"

let hydrationPromise: Promise<void> | null = null

/**
 * Seed the native DeviceStore from the persisted settings. Single-flight: the
 * first caller runs it, everyone else awaits the same promise. On failure the
 * current awaiters see the rejection (and fail open — the pre-guard behavior,
 * where the connect calls' own error handling was the last line of defense),
 * and the memo clears so a LATER read can retry and heal.
 */
export function hydrateDeviceStore(): Promise<void> {
  if (!hydrationPromise) {
    const startedAt = Date.now()
    hydrationPromise = (async () => {
      const loadResult = await useSettingsStore.getState().loadAllSettings()
      if (loadResult.is_error()) {
        throw new Error(`DeviceStoreHydration: settings load failed: ${loadResult.error}`)
      }
      await pushAllBluetoothSettings()
      const settings = useSettingsStore.getState()
      const model = settings.getSetting(SETTINGS.default_wearable.key)
      const hasName = !!settings.getSetting(SETTINGS.device_name.key)
      // Cold-start timing evidence: this line must appear BEFORE any
      // RECONNECT/guard log for the hydration contract to hold on device.
      console.log(
        `DeviceStoreHydration: native seed complete in ${Date.now() - startedAt}ms ` +
          `(default_wearable=${model || "<none>"}, device_name present=${hasName})`,
      )
    })().catch((error) => {
      hydrationPromise = null
      throw error
    })
  }
  return hydrationPromise
}

/**
 * Whether the SDK holds an actual default DEVICE to reconnect to — the
 * hydration-aware two-state read. Distinct from the `default_wearable`
 * setting (a model string that pending/orphaned states can hold without any
 * paired device): `connectDefault()` throws without a device.
 * Rejects if hydration failed; callers fail open.
 */
export async function hasDefaultDevice(): Promise<boolean> {
  await hydrateDeviceStore()
  return !!(await BluetoothSdk.getDefaultDevice())
}

/**
 * Boot repair for the orphaned-identity population: a persisted
 * `default_wearable` whose native default device does not exist after a
 * completed hydration. Two-phase writes stop NEW orphans from forming
 * (identity is only promoted at pairing success); this demotes the ones
 * already in the field — selection-time writes abandoned before pairing
 * succeeded, and identity resurrected from the server before it stopped
 * syncing — down to `pending_wearable`, which the host renders as a
 * finish-pairing card instead of a connect button that would throw
 * "Set a default glasses device before calling connectDefault".
 *
 * Runs after hydration on every start; converges because a demoted default
 * can't re-trip the condition. Skips while the link layer is busy or
 * connected (an in-flight pairing owns the identity right now).
 */
export async function demoteOrphanedDefaultWearable(): Promise<void> {
  const settings = useSettingsStore.getState()
  const model = settings.getSetting(SETTINGS.default_wearable.key) as string | undefined
  if (!model) return
  // The simulated device is its own identity (name mirrors the model); it
  // reconstructs a native default from settings alone and never orphans.
  if (model.includes(DeviceTypes.SIMULATED)) return

  // "disconnected" is the only idle state — anything else (scanning /
  // connecting / bonding / connected) means a pairing or link owns the
  // identity right now.
  if (useGlassesStore.getState().connection.state !== "disconnected") return

  if (await BluetoothSdk.getDefaultDevice()) return

  console.log(`DeviceStoreHydration: demoting orphaned default_wearable "${model}" to pending_wearable`)
  await settings.setSetting(SETTINGS.pending_wearable.key, model)
  await settings.setSetting(SETTINGS.default_wearable.key, "")
  await settings.setSetting(SETTINGS.device_name.key, "")
  await settings.setSetting(SETTINGS.device_address.key, "")
  // The hydration seed already landed the pre-demotion values in the native
  // store; re-push so native mirrors the demoted identity too.
  await pushAllBluetoothSettings()
}
