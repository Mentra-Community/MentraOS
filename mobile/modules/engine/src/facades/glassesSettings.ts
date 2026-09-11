/**
 * glasses.settings facade — `engine.glasses.settings`: the keyed DEVICE-settings
 * surface (brightness, head-up angle, dashboard, camera/button, sensing, …). These
 * are the settings the engine store auto-syncs to the glasses over the bluetooth-sdk
 * (`BLUETOOTH_SETTING_KEYS`), so `set()` both persists and pushes to the device.
 *
 * Distinct from `engine.settings` (user/app prefs): this is scoped to the
 * hardware-facing keys, minus the internal sync keys (auth/token) that aren't
 * user-tunable device settings.
 */
import {useSettingsStore, SETTINGS, BLUETOOTH_SETTING_KEYS} from "../stores/settings"

// Keys carried on BLUETOOTH_SETTING_KEYS for the device handshake that are NOT
// user-tunable settings — auth, device/controller IDENTITY (set by pairing), and
// internal RUNTIME flags. Kept out of the OEM-facing `available()` surface.
const INTERNAL_KEYS = new Set<string>([
  // auth
  SETTINGS.core_token.key,
  SETTINGS.auth_email.key,
  // glasses + controller identity (managed by pairing, not the user)
  SETTINGS.pending_wearable.key,
  SETTINGS.default_wearable.key,
  SETTINGS.device_name.key,
  SETTINGS.device_address.key,
  SETTINGS.project_name.key,
  SETTINGS.pending_controller.key,
  SETTINGS.default_controller.key,
  SETTINGS.controller_device_name.key,
  SETTINGS.controller_address.key,
  // internal runtime flags
  SETTINGS.local_stt_fallback_active.key,
])
const DEVICE_KEYS = BLUETOOTH_SETTING_KEYS.filter((k) => !INTERNAL_KEYS.has(k))

// Copy: object/array-valued settings must not hand callers a mutable reference
// into the store (mutations would bypass persistence + Bluetooth sync).
function copySettingValue<T>(value: T): T {
  if (Array.isArray(value)) return [...value] as T
  if (value && typeof value === "object") return {...(value as object)} as T
  return value
}

export const glassesSettings = {
  /** Read a device setting by key (object/array values are shallow copies). */
  get: <T = unknown>(key: string): T | undefined =>
    copySettingValue(useSettingsStore.getState().getSetting(key) as T | undefined),
  /** Write a device setting — persists and auto-syncs to the connected glasses. */
  set: <T = unknown>(key: string, value: T) => useSettingsStore.getState().setSetting(key, value),
  /** Subscribe to changes for one device-setting key; returns an unsubscribe. */
  onChanged: <T = unknown>(key: string, cb: (value: T | undefined) => void): (() => void) =>
    useSettingsStore.subscribe((s) => s.getSetting(key) as T | undefined, cb),
  /** The schema descriptor for a key (type, default, options…), or undefined. */
  descriptor: (key: string) => SETTINGS[key],
  /** The device-setting keys synced to the glasses (excludes internal sync keys). */
  // Copy: callers must not be able to mutate the module-level key list.
  available: (): string[] => [...DEVICE_KEYS],
}




