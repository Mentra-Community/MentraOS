/**
 * glasses.settings facade — `toolkit.glasses.settings`: the keyed DEVICE-settings
 * surface (brightness, head-up angle, dashboard, camera/button, sensing, …). These
 * are the settings the island store auto-syncs to the glasses over the bluetooth-sdk
 * (`BLUETOOTH_SETTING_KEYS`), so `set()` both persists and pushes to the device.
 *
 * Distinct from `toolkit.settings` (user/app prefs): this is scoped to the
 * hardware-facing keys, minus the internal sync keys (auth/token) that aren't
 * user-tunable device settings.
 */
import {useSettingsStore, SETTINGS, BLUETOOTH_SETTING_KEYS} from "../stores/settings"

// Internal sync keys carried on BLUETOOTH_SETTING_KEYS for the device handshake —
// NOT user-tunable device settings, so kept out of the OEM-facing surface.
const INTERNAL_KEYS = new Set<string>([SETTINGS.core_token.key, SETTINGS.auth_email.key])
const DEVICE_KEYS = BLUETOOTH_SETTING_KEYS.filter((k) => !INTERNAL_KEYS.has(k))

export const glassesSettings = {
  /** Read a device setting by key. */
  get: <T = unknown>(key: string): T | undefined => useSettingsStore.getState().getSetting(key) as T | undefined,
  /** Write a device setting — persists and auto-syncs to the connected glasses. */
  set: <T = unknown>(key: string, value: T) => useSettingsStore.getState().setSetting(key, value),
  /** Subscribe to changes for one device-setting key; returns an unsubscribe. */
  onChanged: <T = unknown>(key: string, cb: (value: T | undefined) => void): (() => void) =>
    useSettingsStore.subscribe((s) => s.getSetting(key) as T | undefined, cb),
  /** The schema descriptor for a key (type, default, options…), or undefined. */
  descriptor: (key: string) => SETTINGS[key],
  /** The device-setting keys synced to the glasses (excludes internal sync keys). */
  available: (): string[] => DEVICE_KEYS,
}
