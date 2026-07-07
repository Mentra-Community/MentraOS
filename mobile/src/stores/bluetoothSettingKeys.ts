/**
 * @fileoverview Re-export shim — the device-model-filtered Bluetooth setting
 * key list lives in @mentra/island next to the settings store that consumes it
 * (getBluetoothSettings). Kept so `@/stores/bluetoothSettingKeys` importers
 * (settings.test.ts) resolve unchanged.
 *
 * Imports the island FILE (not the @mentra/island/internal barrel) so the
 * bun-run settings.test.ts doesn't drag react-native through the barrel —
 * the file's own imports (island types) are pure TS.
 */
export {MENTRA_LIVE_SETTING_KEYS, getBluetoothSettingKeysForDevice} from "../../modules/island/src/stores/bluetoothSettingKeys"
