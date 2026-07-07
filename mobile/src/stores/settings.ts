/**
 * @fileoverview Re-export shim — the settings store now lives in @mentra/island
 * (moved together with RestComms, its mutually-coupled pair). Kept so existing
 * `@/stores/settings` imports resolve unchanged.
 */
export {
  SETTINGS,
  OFFLINE_APPLETS,
  useSettingsStore,
  useSetting,
  MENTRA_LIVE_SETTING_KEYS,
  getBluetoothSettingKeysForDevice,
} from "@mentra/island/internal"
