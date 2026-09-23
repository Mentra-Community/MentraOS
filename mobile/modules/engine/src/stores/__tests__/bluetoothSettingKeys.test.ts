/// <reference types="bun-types" />

import {describe, expect, test} from "bun:test"

import {MENTRA_LIVE_SETTING_KEYS} from "../bluetoothSettingKeys"

describe("MENTRA_LIVE_SETTING_KEYS", () => {
  test("syncs button video settings through the canonical atomic object", () => {
    expect(MENTRA_LIVE_SETTING_KEYS).toContain("button_video_settings")
    expect(MENTRA_LIVE_SETTING_KEYS).not.toContain("button_video_width")
    expect(MENTRA_LIVE_SETTING_KEYS).not.toContain("button_video_height")
    expect(MENTRA_LIVE_SETTING_KEYS).not.toContain("button_video_fps")
  })

  test("includes Mentra Live mic gate toggles", () => {
    expect(MENTRA_LIVE_SETTING_KEYS).toContain("voice_activity_detection_enabled")
    expect(MENTRA_LIVE_SETTING_KEYS).toContain("loudness_gate_enabled")
  })

  test("syncs auto power-off, which the glasses cannot learn any other way", () => {
    expect(MENTRA_LIVE_SETTING_KEYS).toContain("auto_power_off_enabled")
  })

  test("syncs only the effective mic tuning, never the persisted one", () => {
    expect(MENTRA_LIVE_SETTING_KEYS).toContain("mic_tuning")
    expect(MENTRA_LIVE_SETTING_KEYS).not.toContain("mic_tuning_desired")
  })
})
