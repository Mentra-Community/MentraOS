/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"
import {DeviceTypes} from "@mentra/engine"

import {getBluetoothSettingKeysForDevice, MENTRA_LIVE_SETTING_KEYS} from "../../modules/engine/src/stores/bluetoothSettingKeys"

const FULL_BLE_KEYS = [
  "brightness",
  "menu_apps",
  "sensing_enabled",
  "button_video_settings",
]

describe("settings BLE key filtering", () => {
  test("Mentra Live uses the reduced MENTRA_LIVE_SETTING_KEYS set", () => {
    const keys = getBluetoothSettingKeysForDevice(DeviceTypes.LIVE, FULL_BLE_KEYS)
    expect(keys).toEqual(MENTRA_LIVE_SETTING_KEYS)
    expect(keys).not.toContain("brightness")
    expect(keys).not.toContain("menu_apps")
    expect(keys).toContain("button_video_settings")
  })

  test("display glasses use the full BLUETOOTH key list", () => {
    const keys = getBluetoothSettingKeysForDevice(DeviceTypes.G1, FULL_BLE_KEYS)
    expect(keys).toEqual(FULL_BLE_KEYS)
  })
})
