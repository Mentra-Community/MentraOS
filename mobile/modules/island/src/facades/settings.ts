/**
 * settings facade — `toolkit.settings`: the typed keyed user-settings surface over
 * the island-owned settings store. This is the (A) OEM contract; the raw store at
 * `toolkit.stores.settings` is the Mentra-app escape hatch.
 *
 * Keys + their schema live in `SETTINGS` (theme, devMode, metric/twelveHourTime,
 * notifications, onboarding flags, …); `descriptor(key)`/`keys()` expose them.
 */
import {useSettingsStore, SETTINGS} from "../stores/settings"

export const settings = {
  /** Read a setting by key (the current value, or its default). */
  get: <T = unknown>(key: string): T | undefined => useSettingsStore.getState().getSetting(key) as T | undefined,
  /**
   * Write a setting. `syncToServer` (default true) also pushes the change to the
   * backend; pass false for device-local-only writes.
   */
  set: <T = unknown>(key: string, value: T, syncToServer = true) =>
    useSettingsStore.getState().setSetting(key, value, syncToServer),
  /** Subscribe to changes for one key; returns an unsubscribe. */
  onChanged: <T = unknown>(key: string, cb: (value: T | undefined) => void): (() => void) =>
    useSettingsStore.subscribe((s) => s.getSetting(key) as T | undefined, cb),
  /** The schema descriptor for a key (type, default, options…), or undefined. */
  descriptor: (key: string) => SETTINGS[key],
  /** All known setting keys. */
  keys: (): string[] => Object.keys(SETTINGS),
}
