/**
 * settings facade — `engine.settings`: the typed keyed user-settings surface over
 * the engine-owned settings store. This is the (A) OEM contract; the raw store at
 * `engine.stores.settings` is the Mentra-app escape hatch.
 *
 * Keys + their schema live in `SETTINGS` (theme, devMode, metric/twelveHourTime,
 * notifications, onboarding flags, …); `descriptor(key)`/`keys()` expose them.
 */
import {useSettingsStore, SETTINGS} from "../stores/settings"

// Copy: object/array-valued settings must not hand callers a mutable reference
// into the store (mutations would silently corrupt store state, bypassing set()).
function copySettingValue<T>(value: T): T {
  if (Array.isArray(value)) return [...value] as T
  if (value && typeof value === "object") return {...(value as object)} as T
  return value
}

export const settings = {
  /** Read a setting by key (the current value, or its default; object/array values
   * are shallow copies). */
  get: <T = unknown>(key: string): T | undefined =>
    copySettingValue(useSettingsStore.getState().getSetting(key) as T | undefined),
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
  /**
   * Reset every setting to its default on THIS device only (no server sync) —
   * the logout path. Server-side settings are untouched.
   */
  resetAllLocal: (): void => useSettingsStore.getState().resetAllSettingsLocally(),
  /**
   * Hydrate the settings store from device storage — the host-boot step (fire
   * once at app start, before UI reads settings). Single-flighted internally.
   */
  loadAll: () => useSettingsStore.getState().loadAllSettings(),
  /**
   * Every EXPLICITLY-SET setting (shallow copy; keys never written are absent —
   * use get() for default-resolved reads). The data-export surface.
   */
  getAll: (): Record<string, unknown> => ({...useSettingsStore.getState().settings}),
  /**
   * Bulk device-local write without server sync — seeding the store from a
   * backend settings payload.
   */
  setManyLocal: (values: Record<string, unknown>) => useSettingsStore.getState().setManyLocally(values),
}
